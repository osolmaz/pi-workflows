import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { StateDatabase } from "./database.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const LIVE_QUEUE_STATUSES = ["queued", "starting", "running", "parked"];
const ACTIVE_RUNNER_STATUSES = ["starting", "ready", "running"];
const ACTIVE_ATTEMPT_STATUSES = ["pending", "running", "waiting", "interrupted"];
const UNSETTLED_EFFECT_STATUSES = ["pending", "applying", "ambiguous"];

export const AUTOMATIC_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const AUTOMATIC_STATE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AUTOMATIC_STATE_VACUUM_MIN_BYTES = 64 * 1024 * 1024;
export const AUTOMATIC_STATE_VACUUM_MIN_FREE_RATIO = 0.2;

type RunAgeRow = {
  runId: string;
  parentRunId: string | null;
  rootRunId: string;
  launchOptionsHash: Buffer;
  status: string;
  finishedAt: number | null;
};

type SelectedRunTree = {
  rootRunId: string;
  runIds: string[];
  signature: string;
};

type RunTreeSelection = {
  candidateTrees: number;
  blockedTrees: number;
  trees: SelectedRunTree[];
  runIds: string[];
  signature: string;
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

export type AutomaticStatePruneOptions = {
  now?: number;
  activeBlobHashes?: () => readonly Buffer[];
  shouldContinue?: () => boolean;
  yieldControl?: () => Promise<void>;
  vacuumMinBytes?: number;
  vacuumMinFreeRatio?: number;
  vacuum?: (database: Database.Database) => void;
};

export type AutomaticStatePruneReport = StatePruneReport & {
  completed: boolean;
  compacted: boolean;
  pageCount: number;
  freePageCount: number;
  pageSize: number;
  reclaimableBytes: number;
  freePageRatio: number;
  compactionError?: string;
};

type DatabasePageMetrics = Pick<
  AutomaticStatePruneReport,
  "pageCount" | "freePageCount" | "pageSize" | "reclaimableBytes" | "freePageRatio"
>;

type DeletedState = {
  deletedRows: number;
  deletedBlobs: number;
  deletedBlobBytes: number;
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
  activeBlobHashes: () => readonly Buffer[] = () => [],
): Promise<StatePruneReport> {
  validateStatePruneOptions(options);
  const cutoff = parseCutoff(options.before);
  const lockPath = `${databasePath}.maintenance.lock`;
  const lock = options.apply ? acquireMaintenanceLock(lockPath) : undefined;
  try {
    const selection = selectRunTrees(state, cutoff);
    const sizeBefore = databaseBytes(databasePath);
    const base = reportBase(cutoff, selection, sizeBefore);
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

    let deleted: DeletedState;
    state.connection.exec("BEGIN EXCLUSIVE");
    try {
      const checked = selectRunTrees(state, cutoff);
      if (!sameSelection(checked, selection)) {
        throw new Error("Prune selection changed after backup; run the command again");
      }
      deleted = deleteSelectedState(state.connection, checked.runIds, activeBlobHashes());
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
      ...deleted,
      databaseBytesAfter: databaseBytes(databasePath),
      applied: true,
    };
  } finally {
    if (lock !== undefined) releaseMaintenanceLock(lockPath, lock);
  }
}

export async function pruneStateAutomatically(
  state: StateDatabase,
  databasePath: string,
  options: AutomaticStatePruneOptions = {},
): Promise<AutomaticStatePruneReport> {
  const now = options.now ?? Date.now();
  const cutoff = now - AUTOMATIC_STATE_RETENTION_MS;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const activeBlobHashes = options.activeBlobHashes ?? (() => []);
  const sizeBefore = databaseBytes(databasePath);
  const lockPath = `${databasePath}.maintenance.lock`;
  const lock = acquireMaintenanceLock(lockPath);
  let initial = emptySelection();
  let deletedRows = 0;
  let deletedBlobs = 0;
  let deletedBlobBytes = 0;
  let completed = true;
  let compacted = false;
  let compactionError: string | undefined;
  let metrics: DatabasePageMetrics = {
    pageCount: 0,
    freePageCount: 0,
    pageSize: 0,
    reclaimableBytes: 0,
    freePageRatio: 0,
  };

  try {
    metrics = databasePageMetrics(state.connection);
    initial = selectRunTrees(state, cutoff, now);
    for (const selectedTree of initial.trees) {
      if (!shouldContinue()) {
        completed = false;
        break;
      }
      state.connection.exec("BEGIN IMMEDIATE");
      try {
        const checked = selectRunTrees(state, cutoff, now).trees.find(
          (tree) => tree.rootRunId === selectedTree.rootRunId,
        );
        if (checked === undefined || !sameTree(checked, selectedTree)) {
          completed = false;
          state.connection.exec("ROLLBACK");
          break;
        }
        const beforeChanges = totalChanges(state.connection);
        deleteRunAggregates(state.connection, checked.runIds);
        deleteUnusedDefinitionsAndProjects(state.connection);
        deletedRows += totalChanges(state.connection) - beforeChanges;
        state.connection.exec("COMMIT");
      } catch (error) {
        if (state.connection.inTransaction) state.connection.exec("ROLLBACK");
        throw error;
      }
      await yieldControl();
    }

    if (completed && shouldContinue()) {
      state.connection.exec("BEGIN IMMEDIATE");
      try {
        const beforeChanges = totalChanges(state.connection);
        deleteUnusedDefinitionsAndProjects(state.connection);
        const retainedBlobHashes = activeBlobHashes();
        const blobStats = unreferencedBlobStats(state.connection, retainedBlobHashes);
        deleteUnreferencedBlobs(state.connection, retainedBlobHashes);
        deletedRows += totalChanges(state.connection) - beforeChanges;
        deletedBlobs = blobStats.count;
        deletedBlobBytes = blobStats.bytes;
        state.connection.exec("COMMIT");
      } catch (error) {
        if (state.connection.inTransaction) state.connection.exec("ROLLBACK");
        throw error;
      }
    } else {
      completed = false;
    }

    if (completed && shouldContinue()) {
      try {
        state.connection.pragma("wal_checkpoint(TRUNCATE)");
        metrics = databasePageMetrics(state.connection);
        if (
          shouldContinue() &&
          shouldVacuumStateAutomatically(
            metrics,
            options.vacuumMinBytes ?? AUTOMATIC_STATE_VACUUM_MIN_BYTES,
            options.vacuumMinFreeRatio ?? AUTOMATIC_STATE_VACUUM_MIN_FREE_RATIO,
          )
        ) {
          (options.vacuum ?? vacuumDatabase)(state.connection);
          compacted = true;
          state.connection.pragma("wal_checkpoint(TRUNCATE)");
          metrics = databasePageMetrics(state.connection);
        }
      } catch (error) {
        compactionError = errorMessage(error);
        metrics = databasePageMetrics(state.connection);
      }
    }

    return {
      ...reportBase(cutoff, initial, sizeBefore),
      deletedRows,
      deletedBlobs,
      deletedBlobBytes,
      databaseBytesAfter: databaseBytes(databasePath),
      applied: true,
      completed,
      compacted,
      ...metrics,
      ...(compactionError === undefined ? {} : { compactionError }),
    };
  } finally {
    releaseMaintenanceLock(lockPath, lock);
  }
}

export function shouldVacuumStateAutomatically(
  metrics: DatabasePageMetrics,
  minimumBytes: number = AUTOMATIC_STATE_VACUUM_MIN_BYTES,
  minimumFreeRatio: number = AUTOMATIC_STATE_VACUUM_MIN_FREE_RATIO,
): boolean {
  return metrics.reclaimableBytes >= minimumBytes && metrics.freePageRatio >= minimumFreeRatio;
}

function reportBase(cutoff: number, selection: RunTreeSelection, databaseBytesBefore: number) {
  return {
    cutoff: new Date(cutoff).toISOString(),
    candidateTrees: selection.candidateTrees,
    blockedTrees: selection.blockedTrees,
    selectedRuns: selection.runIds.length,
    databaseBytesBefore,
  };
}

function selectRunTrees(
  state: StateDatabase,
  cutoff: number,
  observedAt: number = Date.now(),
): RunTreeSelection {
  const { connection: database } = state;
  const rows = database
    .prepare(
      `SELECT run_id AS runId, parent_run_id AS parentRunId, root_run_id AS rootRunId,
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
  const rowIds = new Set(rows.map((row) => row.runId));
  const links = new Map(rows.map((row) => [row.runId, new Set<string>()]));
  for (const row of rows) {
    linkRuns(links, rowIds, row.runId, row.parentRunId);
    linkRuns(links, rowIds, row.runId, row.rootRunId);
    linkRuns(
      links,
      rowIds,
      row.runId,
      restartParentFromLaunchOptions(state.readJson(row.launchOptionsHash)),
    );
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const row of rows) {
    if (visited.has(row.runId)) continue;
    const component = descendants(row.runId, links);
    for (const runId of component) visited.add(runId);
    components.push(component.sort());
  }

  const trees: SelectedRunTree[] = [];
  let candidateTrees = 0;
  let blockedTrees = 0;
  for (const runIds of components) {
    if (!runIds.some((runId) => eligible.has(runId))) continue;
    candidateTrees += 1;
    if (
      runIds.some((runId) => !eligible.has(runId)) ||
      treeHasBlocker(database, runIds, observedAt)
    ) {
      blockedTrees += 1;
      continue;
    }
    const rootRunId = chooseRootRunId(rows, runIds);
    trees.push({
      rootRunId,
      runIds,
      signature: selectionSignature(database, runIds),
    });
  }
  trees.sort((left, right) => left.rootRunId.localeCompare(right.rootRunId));
  const runIds = trees.flatMap((tree) => tree.runIds).sort();
  return {
    candidateTrees,
    blockedTrees,
    trees,
    runIds,
    signature: JSON.stringify(trees),
  };
}

function treeHasBlocker(
  database: Database.Database,
  runIds: string[],
  observedAt: number,
): boolean {
  const values = placeholders(runIds);
  if (
    hasRow(
      database,
      `SELECT 1 FROM run_queue WHERE run_id IN (${values}) AND status IN (${placeholders(LIVE_QUEUE_STATUSES)})`,
      [...runIds, ...LIVE_QUEUE_STATUSES],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM run_workers
       WHERE run_id IN (${values}) AND status IN (${placeholders(ACTIVE_RUNNER_STATUSES)})`,
      [...runIds, ...ACTIVE_RUNNER_STATUSES],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM node_attempts
       WHERE run_id IN (${values}) AND status IN (${placeholders(ACTIVE_ATTEMPT_STATUSES)})`,
      [...runIds, ...ACTIVE_ATTEMPT_STATUSES],
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM session_segments WHERE run_id IN (${values}) AND status = 'recording'`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM interactive_requests WHERE run_id IN (${values}) AND status = 'pending'`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM human_decisions d
       LEFT JOIN human_decision_resolutions r ON r.decision_id = d.decision_id
       WHERE d.run_id IN (${values}) AND r.decision_id IS NULL`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_messages WHERE run_id IN (${values}) AND status = 'pending'`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_turns WHERE run_id IN (${values}) AND state = 'started'`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM run_bindings b
       WHERE b.run_id IN (${values}) AND b.execution_mode = 'interactive'
         AND NOT EXISTS (
           SELECT 1 FROM workflow_messages m
           WHERE m.run_id = b.run_id AND m.kind = 'terminal' AND m.status = 'sent'
         )`,
      runIds,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM workflow_follow_ups
       WHERE run_id IN (${values}) AND status = 'queued'`,
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
       WHERE (a.run_id IN (${values}) AND s.run_id NOT IN (${values}))
          OR (s.run_id IN (${values}) AND a.run_id NOT IN (${values}))`,
      [...runIds, ...runIds, ...runIds, ...runIds],
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
  return (
    hasRow(
      database,
      `SELECT 1 FROM leases
       WHERE resource_id IN (${resourceValues}) AND owner_id IS NOT NULL AND expires_at > ?`,
      [...resources, observedAt],
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
  );
}

function deleteSelectedState(
  database: Database.Database,
  runIds: string[],
  retainedBlobHashes: readonly Buffer[],
): DeletedState {
  const beforeChanges = totalChanges(database);
  if (runIds.length !== 0) deleteRunAggregates(database, runIds);
  deleteUnusedDefinitionsAndProjects(database);
  const blobStats = unreferencedBlobStats(database, retainedBlobHashes);
  deleteUnreferencedBlobs(database, retainedBlobHashes);
  return {
    deletedRows: totalChanges(database) - beforeChanges,
    deletedBlobs: blobStats.count,
    deletedBlobBytes: blobStats.bytes,
  };
}

function deleteUnusedDefinitionsAndProjects(database: Database.Database): void {
  database
    .prepare(
      `DELETE FROM workflow_definitions
       WHERE NOT EXISTS (
         SELECT 1 FROM runs WHERE runs.definition_digest = workflow_definitions.definition_digest
       )`,
    )
    .run();
  database
    .prepare(
      `DELETE FROM projects
       WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.project_id = projects.project_id)
         AND NOT EXISTS (
           SELECT 1 FROM controller_resources
           WHERE controller_resources.project_id = projects.project_id
         )`,
    )
    .run();
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
    database.prepare(`DELETE FROM effects WHERE effect_id IN (${effectValues})`).run(...effectIds);
  }
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
       UNION SELECT resource_id FROM workflow_settings
         WHERE origin_run_id IN (${values}) OR active_run_id IN (${values})
       UNION SELECT resource_id FROM workflow_follow_ups WHERE run_id IN (${values})`,
    )
    .all(...runIds, ...runIds, ...runIds, ...runIds, ...runIds, ...runIds)
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
  return [...new Set([...resources, ...effectResources])];
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

function unreferencedBlobStats(
  database: Database.Database,
  retainedBlobHashes: readonly Buffer[],
): { count: number; bytes: number } {
  const predicate = blobReferencePredicate(database, retainedBlobHashes.length);
  const row = database
    .prepare(
      `SELECT count(*) AS count, COALESCE(sum(byte_length), 0) AS bytes FROM blobs WHERE ${predicate}`,
    )
    .get(...retainedBlobHashes);
  return isBlobStatsRow(row) ? row : { count: 0, bytes: 0 };
}

function deleteUnreferencedBlobs(
  database: Database.Database,
  retainedBlobHashes: readonly Buffer[],
): void {
  database
    .prepare(
      `DELETE FROM blobs WHERE ${blobReferencePredicate(database, retainedBlobHashes.length)}`,
    )
    .run(...retainedBlobHashes);
}

function blobReferencePredicate(database: Database.Database, retainedBlobCount: number): string {
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
  const unreferenced =
    references.length === 0 ? "1 = 1" : `blob_hash NOT IN (${references.join(" UNION ")})`;
  if (retainedBlobCount === 0) return unreferenced;
  const retainedPlaceholders = placeholders(
    Array.from({ length: retainedBlobCount }, () => undefined),
  );
  return `${unreferenced} AND blob_hash NOT IN (${retainedPlaceholders})`;
}

function vacuumDatabase(database: Database.Database): void {
  database.exec("VACUUM");
}

function databasePageMetrics(database: Database.Database): DatabasePageMetrics {
  const pageCount = pragmaNumber(database, "page_count");
  const freePageCount = pragmaNumber(database, "freelist_count");
  const pageSize = pragmaNumber(database, "page_size");
  return {
    pageCount,
    freePageCount,
    pageSize,
    reclaimableBytes: freePageCount * pageSize,
    freePageRatio: pageCount === 0 ? 0 : freePageCount / pageCount,
  };
}

function pragmaNumber(database: Database.Database, name: string): number {
  const value = database.pragma(name, { simple: true });
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite ${name} returned an invalid value`);
  }
  return value;
}

function sameSelection(left: RunTreeSelection, right: RunTreeSelection): boolean {
  return left.runIds.join("\0") === right.runIds.join("\0") && left.signature === right.signature;
}

function sameTree(left: SelectedRunTree, right: SelectedRunTree): boolean {
  return left.runIds.join("\0") === right.runIds.join("\0") && left.signature === right.signature;
}

function chooseRootRunId(rows: RunAgeRow[], runIds: string[]): string {
  const runIdSet = new Set(runIds);
  const candidates = rows
    .filter((row) => runIdSet.has(row.runId) && row.rootRunId === row.runId)
    .map((row) => row.runId)
    .sort();
  return candidates[0] ?? runIds[0] ?? "";
}

function linkRuns(
  links: Map<string, Set<string>>,
  rowIds: Set<string>,
  left: string,
  right: string | null,
): void {
  if (right === null || right === left || !rowIds.has(right)) return;
  links.get(left)?.add(right);
  links.get(right)?.add(left);
}

function descendants(root: string, links: Map<string, Set<string>>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length !== 0) {
    const runId = pending.pop() as string;
    if (seen.has(runId)) continue;
    seen.add(runId);
    result.push(runId);
    pending.push(...(links.get(runId) ?? []));
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

function emptySelection(): RunTreeSelection {
  return { candidateTrees: 0, blockedTrees: 0, trees: [], runIds: [], signature: "" };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunAgeRow(value: unknown): value is RunAgeRow {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    (value.parentRunId === null || typeof value.parentRunId === "string") &&
    typeof value.rootRunId === "string" &&
    Buffer.isBuffer(value.launchOptionsHash) &&
    typeof value.status === "string" &&
    (value.finishedAt === null || typeof value.finishedAt === "number")
  );
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
