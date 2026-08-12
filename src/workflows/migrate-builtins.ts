import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BuiltinWorkflowCatalog } from "./catalog.js";
import { WorkflowRunStore, listRunBundles } from "./store.js";
import type { WorkflowRunState } from "./types.js";

export type BuiltinMigrationQueue = {
  claimLegacyBuiltinWorkflowRun(options: {
    runId: string;
    oldWorkflowPath: string;
    workflowSourceRef: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
  }): boolean;
  parkWorkflowRun(options: { runId: string; claimToken: string }): boolean;
};

const MIGRATION_LEASE_MS = 30_000;

export type BuiltinMigrationResult = {
  migratedRunIds: string[];
  blocked: { runId: string; reason: string }[];
};

/** One bounded migration for nonterminal runs created before stable built-in refs. */
export async function migrateLegacyBuiltinRuns(options: {
  catalog: BuiltinWorkflowCatalog;
  store?: WorkflowRunStore;
  queue?: BuiltinMigrationQueue;
}): Promise<BuiltinMigrationResult> {
  const store = options.store ?? new WorkflowRunStore();
  const result: BuiltinMigrationResult = { migratedRunIds: [], blocked: [] };
  for (const bundle of await listRunBundles(store.outputRoot)) {
    const state = bundle.state;
    if (state.status !== "running" && state.status !== "waiting") continue;
    if (state.workflowSource !== undefined) continue;
    if (state.workflowPath === undefined || state.workflowHash === undefined) {
      result.blocked.push({ runId: state.runId, reason: "legacy workflow identity is incomplete" });
      continue;
    }
    const legacyPath = {
      workflowName: state.workflowName,
      workflowPath: state.workflowPath,
    };
    const pathEntry = options.catalog.legacyPathEntry(legacyPath);
    if (pathEntry === undefined) continue;
    const builtin = options.catalog.matchLegacy({
      ...legacyPath,
      workflowHash: state.workflowHash,
    });
    if (builtin === undefined) {
      result.blocked.push({
        runId: state.runId,
        reason: `legacy built-in ${pathEntry.id} has an unknown source revision`,
      });
      continue;
    }
    const claimToken = randomUUID();
    if (
      options.queue !== undefined &&
      !options.queue.claimLegacyBuiltinWorkflowRun({
        runId: state.runId,
        oldWorkflowPath: state.workflowPath,
        workflowSourceRef: builtin.ref,
        runnerId: `builtin-migration-${process.pid}`,
        claimToken,
        leaseMs: MIGRATION_LEASE_MS,
      })
    ) {
      result.blocked.push({
        runId: state.runId,
        reason: "matching queue row is active, terminal, or unavailable",
      });
      continue;
    }
    const migrated: WorkflowRunState = {
      ...state,
      workflowSource: { kind: "builtin", id: builtin.id, revision: builtin.revision },
    };
    delete migrated.workflowPath;
    delete migrated.workflowHash;
    const migratedManifest = {
      ...bundle.manifest,
      workflowSource: migrated.workflowSource,
    };
    delete (migratedManifest as typeof migratedManifest & { workflowPath?: string }).workflowPath;
    // State is the migration commit point. Queue and manifest updates are
    // idempotent, so a crash before this write can safely retry.
    await writeJsonAtomic(path.join(bundle.runDir, "manifest.json"), migratedManifest);
    await writeJsonAtomic(path.join(bundle.runDir, "state.json"), migrated);
    if (
      options.queue !== undefined &&
      !options.queue.parkWorkflowRun({ runId: state.runId, claimToken })
    ) {
      result.blocked.push({
        runId: state.runId,
        reason: "migration completed but its queue claim could not be released",
      });
    }
    result.migratedRunIds.push(state.runId);
  }
  return result;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.builtin-migration.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
