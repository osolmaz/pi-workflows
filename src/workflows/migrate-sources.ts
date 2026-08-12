import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BuiltinWorkflowCatalog } from "./catalog.js";
import { WorkflowRunStore, listRunBundles } from "./store.js";
import type { WorkflowRunState, WorkflowSource } from "./types.js";

export type LegacySourceMigrationQueue = {
  repairCanonicalWorkflowSourceRun(options: {
    runId: string;
    workflowSourceRef: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
  }): "unchanged" | "claimed" | false;
  claimLegacyWorkflowSourceRun(options: {
    runId: string;
    oldWorkflowPath: string;
    workflowSourceRef: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
  }): boolean;
  parkWorkflowRun(options: { runId: string; claimToken: string }): boolean;
  getWorkflowRun(runId: string): { status: "claimed" | "parked" | "done" } | undefined;
};

const MIGRATION_LEASE_MS = 30_000;

export type LegacySourceMigrationResult = {
  migratedRunIds: string[];
  blocked: { runId: string; reason: string }[];
};

/** One bounded migration for nonterminal runs created before canonical sources. */
export async function migrateLegacyWorkflowSources(options: {
  catalog: BuiltinWorkflowCatalog;
  store?: WorkflowRunStore;
  queue?: LegacySourceMigrationQueue;
}): Promise<LegacySourceMigrationResult> {
  const store = options.store ?? new WorkflowRunStore();
  const result: LegacySourceMigrationResult = { migratedRunIds: [], blocked: [] };
  for (const bundle of await listRunBundles(store.outputRoot)) {
    const state = bundle.state;
    if (state.status !== "running" && state.status !== "waiting") continue;
    if (state.workflowSource !== undefined) {
      if (options.queue === undefined) continue;
      const claimToken = randomUUID();
      const repaired = options.queue.repairCanonicalWorkflowSourceRun({
        runId: state.runId,
        workflowSourceRef: sourceRef(state.workflowSource),
        runnerId: `source-migration-${process.pid}`,
        claimToken,
        leaseMs: MIGRATION_LEASE_MS,
      });
      if (repaired === false) {
        result.blocked.push({
          runId: state.runId,
          reason: "canonical bundle has an active, terminal, or unavailable queue row",
        });
      } else if (
        repaired === "claimed" &&
        !options.queue.parkWorkflowRun({ runId: state.runId, claimToken })
      ) {
        result.blocked.push({
          runId: state.runId,
          reason: "canonical queue repair could not release its claim",
        });
      }
      continue;
    }
    if (state.workflowPath === undefined || state.workflowHash === undefined) {
      result.blocked.push({ runId: state.runId, reason: "legacy workflow identity is incomplete" });
      continue;
    }
    const legacyPath = {
      workflowName: state.workflowName,
      workflowPath: state.workflowPath,
    };
    const pathEntry = options.catalog.legacyPathEntry(legacyPath);
    let workflowSource: WorkflowSource;
    let workflowSourceRef: string;
    if (pathEntry === undefined) {
      workflowSource = {
        kind: "file",
        path: path.resolve(state.workflowPath),
        hash: state.workflowHash,
      };
      workflowSourceRef = workflowSource.path;
    } else {
      const legacy = options.catalog.matchLegacy({
        ...legacyPath,
        workflowHash: state.workflowHash,
      });
      if (legacy === undefined) {
        const reason = `legacy built-in ${pathEntry.id} has an unknown source revision`;
        result.blocked.push({ runId: state.runId, reason });
        continue;
      }
      workflowSource = {
        kind: "builtin",
        id: legacy.entry.id,
        revision: legacy.revision,
      };
      workflowSourceRef = legacy.entry.ref;
    }
    const claimToken = randomUUID();
    const queueIsDone = options.queue?.getWorkflowRun(state.runId)?.status === "done";
    if (
      options.queue !== undefined &&
      !queueIsDone &&
      !options.queue.claimLegacyWorkflowSourceRun({
        runId: state.runId,
        oldWorkflowPath: state.workflowPath,
        workflowSourceRef,
        runnerId: `source-migration-${process.pid}`,
        claimToken,
        leaseMs: MIGRATION_LEASE_MS,
      })
    ) {
      result.blocked.push({
        runId: state.runId,
        reason: "matching queue row is active or unavailable",
      });
      continue;
    }
    const migrated: WorkflowRunState = {
      ...state,
      workflowSource,
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
      !queueIsDone &&
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

function sourceRef(source: WorkflowSource): string {
  return source.kind === "builtin" ? `builtin:${source.id}` : source.path;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.source-migration.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
