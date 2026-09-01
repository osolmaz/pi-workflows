import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { StateDatabase } from "./database.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const LIVE_QUEUE_STATUSES = ["queued", "starting", "running", "parked"];
const UNSETTLED_EFFECT_STATUSES = ["pending", "applying", "ambiguous"];

type RunAgeRow = {
  runId: string;
  parentRunId: string | null;
  launchOptionsHash: Buffer;
  status: string;
  finishedAt: number | null;
};

export type StatePruneOptions = {
  before: string;
  apply: boolean;
  backupPath?: string;
};

export type StatePruneReport = {
  cutoff: string;
  candidateTrees: number;
  blockedTrees: number;
  selectedRuns: number;
  deletedRows: number;
  deletedBlobs: number;
  deletedBlobBytes: number;
  databaseBytesBefore: number;
  databaseBytesAfter: number;
  applied: boolean;
};

export function validateStatePruneOptions(options: StatePruneOptions): void {
  parseCutoff(options.before);
  if (options.apply && options.backupPath === undefined) {
    throw new Error("state prune --apply requires --backup <absolute-path>");
  }
  if (options.backupPath !== undefined && !path.isAbsolute(options.backupPath)) {
    throw new Error("state prune backup path must be absolute");
  }
}

export async function pruneState(
  state: StateDatabase,
  databasePath: string,
  options: StatePruneOptions,
): Promise<StatePruneReport> {
  validateStatePruneOptions(options);
  const cutoff = parseCutoff(options.before);
  const lockPath = `${databasePath}.maintenance.lock`;
  const lock = options.apply ? acquireMaintenanceLock(lockPath) : undefined;
  try {
    const selection = selectRunTrees(state, cutoff);
    const sizeBefore = databaseBytes(databasePath);
    const base = {
      cutoff: new Date(cutoff).toISOString(),
      candidateTrees: selection.candidateTrees,
      blockedTrees: selection.blockedTrees,
      selectedRuns: selection.runIds.length,
      databaseBytesBefore: sizeBefore,
    };
    if (!options.apply) {
      return {
        ...base,
        deletedRows: 0,
        deletedBlobs: 0,
        deletedBlobBytes: 0,
        databaseBytesAfter: sizeBefore,
        applied: false,
      };
    }

    const backupPath = path.resolve(options.backupPath as string);
    if (fs.existsSync(backupPath)) {
      throw new Error(`Backup destination already exists: ${backupPath}`);
    }
    await state.backup(backupPath);

    let deletedRows = 0;
    let deletedBlobs = 0;
    let deletedBlobBytes = 0;
    state.connection.exec("BEGIN EXCLUSIVE");
    try {
      const checked = selectRunTrees(state, cutoff);
      if (
        checked.runIds.join("\0") !== selection.runIds.join("\0") ||
        checked.signature !== selection.signature
      ) {
        throw new Error("Prune selection changed after backup; run the command again");
      }
      const beforeChanges = totalChanges(state.connection);
      if (checked.runIds.length !== 0) {
        deleteRunAggregates(state.connection, checked.runIds);
      }
      state.connection
        .prepare(
          `DELETE FROM workflow_definitions
         WHERE NOT EXISTS (
           SELECT 1 FROM runs WHERE runs.definition_digest = workflow_definitions.definition_digest
         )`,
        )
        .run();
      state.connection
        .prepare(
          `DELETE FROM projects
         WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.project_id = projects.project_id)
           AND NOT EXISTS (
             SELECT 1 FROM controller_resources
             WHERE controller_resources.project_id = projects.project_id
           )`,
        )
        .run();
      const blobStats = unreferencedBlobStats(state.connection);
      deleteUnreferencedBlobs(state.connection);
      deletedRows = totalChanges(state.connection) - beforeChanges;
      deletedBlobs = blobStats.count;
      deletedBlobBytes = blobStats.bytes;
      state.connection.exec("COMMIT");
    } catch (error) {
      if (state.connection.inTransaction) state.connection.exec("ROLLBACK");
      throw error;
    }
    state.connection.pragma("wal_checkpoint(TRUNCATE)");
    state.connection.exec("VACUUM");
    state.connection.pragma("wal_checkpoint(TRUNCATE)");
    state.integrityCheck();
    return {
      ...base,
      deletedRows,
      deletedBlobs,
      deletedBlobBytes,
      databaseBytesAfter: databaseBytes(databasePath),
      applied: true,
    };
  } finally {
    if (lock !== undefined) releaseMaintenanceLock(lockPath, lock);
  }
}

function selectRunTrees(
  state: StateDatabase,
  cutoff: number,
): { candidateTrees: number; blockedTrees: number; runIds: string[]; signature: string } {
  const { connection: database } = state;
  const rows = database
    .prepare(
      `SELECT run_id AS runId, parent_run_id AS parentRunId,
              launch_options_hash AS launchOptionsHash, status, finished_at AS finishedAt
       FROM runs ORDER BY created_at, run_id`,
    )
    .all()
    .filter(isRunAgeRow);
  const eligible = new Set(
    rows
      .filter(
        (row) =>
          TERMINAL_RUN_STATUSES.has(row.status) &&
          row.finishedAt !== null &&
          row.finishedAt < cutoff,
      )
      .map((row) => row.runId),
  );
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const row of rows) {
    const runParents = new Set<string>();
    if (row.parentRunId !== null) runParents.add(row.parentRunId);
    const restartParentRunId = restartParentFromLaunchOptions(
      state.readJson(row.launchOptionsHash),
    );
    if (restartParentRunId !== null) runParents.add(restartParentRunId);
    parents.set(row.runId, [...runParents]);
    for (const parentRunId of runParents) {
      const values = children.get(parentRunId) ?? [];
      values.push(row.runId);
      children.set(parentRunId, values);
    }
  }
  const roots = rows.filter(
    (row) =>
      eligible.has(row.runId) &&
      (parents.get(row.runId) ?? []).every((parentRunId) => !eligible.has(parentRunId)),
  );
  const selected = new Set<string>();
  let blockedTrees = 0;
  for (const root of roots) {
    const tree = descendants(root.runId, children);
    if (tree.some((runId) => !eligible.has(runId)) || treeHasBlocker(database, tree)) {
      blockedTrees += 1;
      continue;
    }
    for (const runId of tree) selected.add(runId);
  }
  const runIds = [...selected].sort();
  return {
    candidateTrees: roots.length,
    blockedTrees,
    runIds,
    signature: selectionSignature(database, runIds),
  };
}

function treeHasBlocker(database: Database.Database, runIds: string[]): boolean {
  const values = placeholders(runIds);
  if (
    hasRow(
      database,
      `SELECT 1 FROM run_queue WHERE run_id IN (${values}) AND status IN (${placeholders(LIVE_QUEUE_STATUSES)})`,
      [...runIds, ...LIVE_QUEUE_STATUSES],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_follow_ups
       WHERE run_id IN (${values}) AND status IN ('queued', 'pending_presentation', 'ready')`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_follow_up_queues
       WHERE run_id IN (${values}) AND presentation_state = 'pending'`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM controller_workflows
       WHERE run_id IN (${values}) OR reserved_run_id IN (${values})`,
      [...runIds, ...runIds],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM run_steps s JOIN node_attempts a ON a.attempt_id = s.attempt_id
       WHERE a.run_id IN (${values}) AND s.run_id NOT IN (${values})`,
      [...runIds, ...runIds],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM continuations
       WHERE (parent_run_id IN (${values}) AND continuation_run_id NOT IN (${values}))
          OR (continuation_run_id IN (${values}) AND parent_run_id NOT IN (${values}))`,
      [...runIds, ...runIds, ...runIds, ...runIds],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_settings
       WHERE (origin_run_id IN (${values}) AND active_run_id NOT IN (${values}))
          OR (active_run_id IN (${values}) AND origin_run_id NOT IN (${values}))`,
      [...runIds, ...runIds, ...runIds, ...runIds],
    )
  ) {
    return true;
  }
  const resources = relatedResourceIds(database, runIds);
  const resourceValues = placeholders(resources);
  if (
    hasRow(
      database,
      `SELECT 1 FROM leases
       WHERE resource_id IN (${resourceValues}) AND owner_id IS NOT NULL AND expires_at > ?`,
      [...resources, Date.now()],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM effects
       WHERE source_resource_id IN (${resourceValues})
         AND status IN (${placeholders(UNSETTLED_EFFECT_STATUSES)})`,
      [...resources, ...UNSETTLED_EFFECT_STATUSES],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM channel_messages m JOIN human_decisions d ON d.decision_id = m.decision_id
       WHERE d.run_id IN (${values})`,
      runIds,
    )
  ) {
    return true;
  }
  return false;
}

function deleteRunAggregates(database: Database.Database, runIds: string[]): void {
  const values = placeholders(runIds);
  const resources = relatedResourceIds(database, runIds);
  const effectRows = database
    .prepare(
      `SELECT effect_id AS effectId, resource_id AS resourceId
       FROM effects WHERE source_resource_id IN (${placeholders(resources)})`,
    )
    .all(...resources)
    .filter(isEffectResourceRow);
  const effectIds = effectRows.map((row) => row.effectId);
  if (effectIds.length !== 0) {
    const effectValues = placeholders(effectIds);
    database
      .prepare(`DELETE FROM notifications WHERE effect_id IN (${effectValues})`)
      .run(...effectIds);
    database
      .prepare(`DELETE FROM turn_intents WHERE effect_id IN (${effectValues})`)
      .run(...effectIds);
    database.prepare(`DELETE FROM effects WHERE effect_id IN (${effectValues})`).run(...effectIds);
  }
  database.prepare(`DELETE FROM turn_intents WHERE run_id IN (${values})`).run(...runIds);
  database
    .prepare(
      `DELETE FROM continuations
       WHERE parent_run_id IN (${values}) OR continuation_run_id IN (${values})`,
    )
    .run(...runIds, ...runIds);
  const allResources = [...new Set([...resources, ...effectRows.map((row) => row.resourceId)])];
  if (allResources.length !== 0) {
    database
      .prepare(`DELETE FROM events WHERE resource_id IN (${placeholders(allResources)})`)
      .run(...allResources);
  }
  database.prepare(`DELETE FROM runs WHERE run_id IN (${values})`).run(...runIds);
  if (allResources.length !== 0) {
    database
      .prepare(`DELETE FROM resources WHERE resource_id IN (${placeholders(allResources)})`)
      .run(...allResources);
  }
}

function relatedResourceIds(database: Database.Database, runIds: string[]): string[] {
  if (runIds.length === 0) return [];
  const values = placeholders(runIds);
  const rows = database
    .prepare(
      `SELECT resource_id AS resourceId FROM runs WHERE run_id IN (${values})
       UNION SELECT resource_id FROM session_segments WHERE run_id IN (${values})
       UNION SELECT resource_id FROM human_decisions WHERE run_id IN (${values})
       UNION SELECT resource_id FROM turn_intents WHERE run_id IN (${values})
       UNION SELECT resource_id FROM workflow_settings
         WHERE origin_run_id IN (${values}) OR active_run_id IN (${values})
       UNION SELECT resource_id FROM workflow_follow_up_queues WHERE run_id IN (${values})
       UNION SELECT resource_id FROM workflow_follow_ups WHERE run_id IN (${values})`,
    )
    .all(...runIds, ...runIds, ...runIds, ...runIds, ...runIds, ...runIds, ...runIds, ...runIds)
    .filter(isResourceRow);
  const resources = rows.map((row) => row.resourceId);
  if (resources.length === 0) return [];
  const effectResources = database
    .prepare(
      `SELECT resource_id AS resourceId FROM effects
       WHERE source_resource_id IN (${placeholders(resources)})`,
    )
    .all(...resources)
    .filter(isResourceRow)
    .map((row) => row.resourceId);
  const notificationResources = database
    .prepare(
      `SELECT resource.resource_id AS resourceId
       FROM notifications notification
       JOIN effects effect ON effect.effect_id = notification.effect_id
       JOIN resources resource
         ON resource.resource_type = 'notification'
        AND resource.aggregate_key = notification.notification_id
       WHERE effect.source_resource_id IN (${placeholders(resources)})`,
    )
    .all(...resources)
    .filter(isResourceRow)
    .map((row) => row.resourceId);
  return [...new Set([...resources, ...effectResources, ...notificationResources])];
}

function selectionSignature(database: Database.Database, runIds: string[]): string {
  if (runIds.length === 0) return "";
  const resources = relatedResourceIds(database, runIds);
  const resourceRows = database
    .prepare(
      `SELECT resource_id AS resourceId, revision, updated_at AS updatedAt
       FROM resources WHERE resource_id IN (${placeholders(resources)})
       ORDER BY resource_id`,
    )
    .all(...resources);
  const queueRows = database
    .prepare(
      `SELECT run_id AS runId, status, updated_at AS updatedAt
       FROM run_queue WHERE run_id IN (${placeholders(runIds)}) ORDER BY run_id`,
    )
    .all(...runIds);
  return JSON.stringify([resourceRows, queueRows]);
}

function unreferencedBlobStats(database: Database.Database): { count: number; bytes: number } {
  const predicate = blobReferencePredicate(database);
  const row = database
    .prepare(
      `SELECT count(*) AS count, COALESCE(sum(byte_length), 0) AS bytes FROM blobs WHERE ${predicate}`,
    )
    .get();
  return isBlobStatsRow(row) ? row : { count: 0, bytes: 0 };
}

function deleteUnreferencedBlobs(database: Database.Database): void {
  database.prepare(`DELETE FROM blobs WHERE ${blobReferencePredicate(database)}`).run();
}

function blobReferencePredicate(database: Database.Database): string {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .filter(isTableRow);
  const references: string[] = [];
  for (const table of tables) {
    const foreignKeys = database.pragma(`foreign_key_list(${quoteIdentifier(table.name)})`);
    if (!Array.isArray(foreignKeys)) continue;
    for (const value of foreignKeys) {
      if (!isForeignKeyRow(value) || value.table !== "blobs" || value.to !== "blob_hash") continue;
      references.push(
        `SELECT ${quoteIdentifier(value.from)} FROM ${quoteIdentifier(table.name)} ` +
          `WHERE ${quoteIdentifier(value.from)} IS NOT NULL`,
      );
    }
  }
  return references.length === 0 ? "1 = 1" : `blob_hash NOT IN (${references.join(" UNION ")})`;
}

function descendants(root: string, children: Map<string, string[]>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length !== 0) {
    const runId = pending.pop() as string;
    if (seen.has(runId)) continue;
    seen.add(runId);
    result.push(runId);
    pending.push(...(children.get(runId) ?? []));
  }
  return result;
}

function restartParentFromLaunchOptions(value: unknown): string | null {
  if (!isRecord(value)) throw new Error("Stored workflow launch options are invalid");
  const lineage = value.restartLineage;
  if (lineage === undefined) return null;
  if (!isRecord(lineage) || typeof lineage.parentRunId !== "string") {
    throw new Error("Stored workflow restart lineage is invalid");
  }
  return lineage.parentRunId;
}

function parseCutoff(value: string): number {
  const cutoff = Date.parse(value);
  if (!Number.isFinite(cutoff)) throw new Error("state prune --before requires a valid timestamp");
  return cutoff;
}

function databaseBytes(databasePath: string): number {
  return [databasePath, `${databasePath}-wal`]
    .filter((filePath) => fs.existsSync(filePath))
    .reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
}

function acquireMaintenanceLock(lockPath: string): number {
  try {
    return fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`State maintenance is already active: ${lockPath}`);
    }
    throw error;
  }
}

function releaseMaintenanceLock(lockPath: string, descriptor: number): void {
  fs.closeSync(descriptor);
  fs.unlinkSync(lockPath);
}

function hasRow(database: Database.Database, sql: string, values: unknown[]): boolean {
  return database.prepare(sql).get(...values) !== undefined;
}

function totalChanges(database: Database.Database): number {
  const row = database.prepare("SELECT total_changes() AS count").get();
  return isCountRow(row) ? row.count : 0;
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) return "NULL";
  return values.map(() => "?").join(", ");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunAgeRow(value: unknown): value is RunAgeRow {
  return isRecord(value);
}

function isResourceRow(value: unknown): value is { resourceId: string } {
  return isRecord(value) && typeof value.resourceId === "string";
}

function isEffectResourceRow(value: unknown): value is { effectId: string; resourceId: string } {
  return (
    isRecord(value) && typeof value.effectId === "string" && typeof value.resourceId === "string"
  );
}

function isBlobStatsRow(value: unknown): value is { count: number; bytes: number } {
  return isRecord(value) && typeof value.count === "number" && typeof value.bytes === "number";
}

function isCountRow(value: unknown): value is { count: number } {
  return isRecord(value) && typeof value.count === "number";
}

function isTableRow(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

function isForeignKeyRow(value: unknown): value is { table: string; from: string; to: string } {
  return (
    isRecord(value) &&
    typeof value.table === "string" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
  );
}
