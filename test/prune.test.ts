import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { StateDatabase } from "../src/state/database.js";
import { resourceIdFor } from "../src/state/mutation.js";
import {
  AUTOMATIC_STATE_RETENTION_MS,
  pruneState as pruneStateWithDatabase,
  pruneStateAutomatically,
  shouldVacuumStateAutomatically,
  type StatePruneOptions,
  type StatePruneReport,
  validateStatePruneOptions,
} from "../src/state/prune.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

async function pruneState(
  databasePath: string,
  options: StatePruneOptions,
): Promise<StatePruneReport> {
  validateStatePruneOptions(options);
  const state = new StateDatabase({
    filePath: databasePath,
    mode: options.apply ? "read-write" : "read-only",
  });
  try {
    return await pruneStateWithDatabase(state, databasePath, options);
  } finally {
    state.close();
  }
}

describe("state prune", () => {
  it("previews and deletes old terminal runs only after a verified backup", async () => {
    const databasePath = await makeStateDatabasePath("state-prune");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", {
        output: { reply: "x".repeat(1024 * 1024) },
      }),
    }).run(workflow, {});
    const child = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "child" } }),
    }).run(workflow, {});
    const setup = new WorkflowRunStore(databasePath);
    setup.state.connection
      .prepare(
        "UPDATE runs SET parent_run_id = ?, root_run_id = ?, lineage_kind = 'continuation' WHERE run_id = ?",
      )
      .run(result.runId, result.runId, child.runId);
    const runResource = setup.state.connection
      .prepare(
        "SELECT resource_id AS resourceId, revision FROM runs JOIN resources USING (resource_id) WHERE run_id = ?",
      )
      .get(result.runId) as { resourceId: string; revision: number };
    const now = Date.now();
    const notificationId = "notification-prune";
    const effectId = "effect-prune";
    const effectResourceId = resourceIdFor("effect", effectId);
    const contentHash = setup.state.putText("done", now);
    const settingsResourceId = resourceIdFor("settings", "settings-prune");
    const followUpId = "follow-up-prune";
    const followUpResourceId = resourceIdFor("follow_up", followUpId);
    const settingsHash = setup.state.putJson({ mode: "test" }, now);
    setup.state.transaction(() => {
      setup.state.connection
        .prepare(
          "INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at) VALUES (?, 'effect', ?, 1, ?, ?)",
        )
        .run(effectResourceId, effectId, now, now);
      setup.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(effectResourceId);
      setup.state.connection
        .prepare(
          "INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at) VALUES (?, 'settings', 'settings-prune', 1, ?, ?), (?, 'follow_up', ?, 1, ?, ?)",
        )
        .run(settingsResourceId, now, now, followUpResourceId, followUpId, now, now);
      setup.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0), (?, 0)")
        .run(settingsResourceId, followUpResourceId);
      setup.state.connection
        .prepare(
          "INSERT INTO workflow_settings(scope_id, resource_id, origin_run_id, active_run_id, mount_path, invocation, initial_hash, current_hash, created_at, updated_at) VALUES ('settings-prune', ?, ?, ?, '', 1, ?, ?, ?, ?)",
        )
        .run(settingsResourceId, result.runId, result.runId, settingsHash, settingsHash, now, now);
      setup.state.connection
        .prepare(
          "INSERT INTO workflow_follow_ups(follow_up_id, resource_id, run_id, request_id, order_number, target_session_id, actor_type, source_type, prompt_hash, status, reason_hash, created_at, updated_at) VALUES (?, ?, ?, 'request-prune', 1, 'session-a', 'system', 'test', ?, 'removed', ?, ?, ?)",
        )
        .run(followUpId, followUpResourceId, result.runId, contentHash, contentHash, now, now);
      setup.state.connection
        .prepare(
          "INSERT INTO effects(effect_id, resource_id, source_resource_id, source_revision, effect_type, idempotency_key, payload_hash, owner_scope, status, attempt_count, created_at, updated_at, settled_at) VALUES (?, ?, ?, ?, 'notification.deliver', ?, ?, 'run', 'applied', 0, ?, ?, ?)",
        )
        .run(
          effectId,
          effectResourceId,
          runResource.resourceId,
          runResource.revision,
          notificationId,
          contentHash,
          now,
          now,
          now,
        );
      setup.state.connection
        .prepare(
          "INSERT INTO events(event_id, resource_id, resource_revision, event_type, actor_type, recorded_at) VALUES ('settings-prune-event', ?, 1, 'settings.created', 'system', ?), ('follow-up-prune-event', ?, 1, 'follow-up.created', 'system', ?)",
        )
        .run(settingsResourceId, now, followUpResourceId, now);
    });
    setup.close();
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    const preview = await pruneState(databasePath, { before: cutoff, apply: false });
    expect(preview).toMatchObject({ applied: false, selectedRuns: 2, deletedRows: 0 });

    const backupPath = path.join(path.dirname(databasePath), "before-prune.sqlite");
    const applied = await pruneState(databasePath, {
      before: cutoff,
      apply: true,
      backupPath,
    });
    expect(applied.applied).toBe(true);
    expect(applied.selectedRuns).toBe(2);
    expect(applied.deletedBlobs).toBeGreaterThan(0);
    expect(applied.deletedBlobBytes).toBeGreaterThan(1024 * 1024);
    expect(applied.databaseBytesAfter).toBeLessThan(applied.databaseBytesBefore - 900_000);
    expect(fs.existsSync(backupPath)).toBe(true);

    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    expect(store.readRun(result.runId)).toBeNull();
    expect(
      store.state.connection
        .prepare(
          "SELECT count(*) AS count FROM resources WHERE resource_type IN ('effect', 'settings', 'follow_up')",
        )
        .get(),
    ).toEqual({ count: 0 });
    store.close();
  });

  it("blocks a run tree with an active lease", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-active");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    const resource = store.state.connection
      .prepare("SELECT resource_id AS resourceId FROM runs WHERE run_id = ?")
      .get(result.runId) as { resourceId: string };
    store.state.connection
      .prepare(
        `UPDATE leases SET owner_type = 'host', owner_id = 'host-1', token_hash = ?,
           acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE resource_id = ?`,
      )
      .run(Buffer.alloc(32, 1), Date.now(), Date.now(), Date.now() + 60_000, resource.resourceId);
    store.close();

    const preview = await pruneState(databasePath, {
      before: new Date(Date.now() + 120_000).toISOString(),
      apply: false,
    });
    expect(preview).toMatchObject({ candidateTrees: 1, blockedTrees: 1, selectedRuns: 0 });
  });

  it("blocks a restart ancestor while its successor is live", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-restart-lineage");
    const parent = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "parent" } }),
    }).run(workflow, {});
    const successor = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "successor" } }),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    const launchOptionsHash = store.state.putJson({
      restartLineage: {
        schema: "pi-workflows.restart-lineage.v1",
        rootRunId: parent.runId,
        parentRunId: parent.runId,
        restartNumber: 1,
        parentTerminalFingerprint: `sha256:${"a".repeat(64)}`,
      },
    });
    store.state.connection
      .prepare(
        `UPDATE runs
         SET launch_options_hash = ?, status = 'queued', finished_at = NULL,
             final_output_hash = NULL, error_hash = NULL
         WHERE run_id = ?`,
      )
      .run(launchOptionsHash, successor.runId);
    store.close();

    const preview = await pruneState(databasePath, {
      before: new Date(Date.now() + 120_000).toISOString(),
      apply: false,
    });
    expect(preview).toMatchObject({ candidateTrees: 1, blockedTrees: 1, selectedRuns: 0 });
  });

  it("blocks a run with pending follow-up presentation", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-follow-up");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    const now = Date.now();
    const followUpId = "pending-follow-up";
    const resourceId = resourceIdFor("follow_up", followUpId);
    const promptHash = store.state.putText("Continue later", now);
    store.state.transaction(() => {
      store.state.connection
        .prepare(
          `INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at)
           VALUES (?, 'follow_up', ?, 1, ?, ?)`,
        )
        .run(resourceId, followUpId, now, now);
      store.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(resourceId);
      store.state.connection
        .prepare(
          `INSERT INTO workflow_follow_ups(
             follow_up_id, resource_id, run_id, request_id, order_number, target_session_id,
             actor_type, source_type, prompt_hash, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending-request', 1, 'session-a', 'system', 'test', ?, 'queued', ?, ?)`,
        )
        .run(followUpId, resourceId, result.runId, promptHash, now, now);
    });
    store.close();

    const preview = await pruneState(databasePath, {
      before: new Date(Date.now() + 120_000).toISOString(),
      apply: false,
    });
    expect(preview).toMatchObject({ candidateTrees: 1, blockedTrees: 1, selectedRuns: 0 });
  });

  it("retains unreferenced blobs used by active runner transfers", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-active-runner-content");
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    try {
      const retained = state.putBlob(Buffer.from("active runner content"), "application/json");
      const unprotected = state.putBlob(Buffer.from("unused content"), "application/json");
      const report = await pruneStateWithDatabase(
        state,
        databasePath,
        {
          before: new Date().toISOString(),
          apply: true,
          backupPath: path.join(path.dirname(databasePath), "backup.sqlite"),
        },
        () => [retained],
      );

      expect(report).toMatchObject({ deletedBlobs: 1, applied: true });
      expect(state.readBlob(retained)?.content.toString("utf8")).toBe("active runner content");
      expect(state.readBlob(unprotected)).toBeUndefined();
    } finally {
      state.close();
    }
  });

  it("automatically deletes whole expired trees and unreferenced blobs without a backup", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-automatic");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {});
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    const now = Date.now();
    try {
      state.connection
        .prepare("UPDATE runs SET finished_at = ? WHERE run_id = ?")
        .run(now - AUTOMATIC_STATE_RETENTION_MS - 1, result.runId);
      const orphan = state.putBlob(Buffer.alloc(256 * 1024, 7), "application/json");
      const report = await pruneStateAutomatically(state, databasePath, { now });

      expect(report).toMatchObject({
        applied: true,
        completed: true,
        candidateTrees: 1,
        blockedTrees: 0,
        selectedRuns: 1,
      });
      expect(report.deletedBlobs).toBeGreaterThan(0);
      expect(
        state.connection.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(result.runId),
      ).toBe(undefined);
      expect(state.readBlob(orphan)).toBeUndefined();
      expect(fs.readdirSync(path.dirname(databasePath))).not.toContain("backup.sqlite");

      const repeated = await pruneStateAutomatically(state, databasePath, { now });
      expect(repeated).toMatchObject({
        completed: true,
        candidateTrees: 0,
        selectedRuns: 0,
        deletedRows: 0,
        deletedBlobs: 0,
      });
    } finally {
      state.close();
    }
  });

  it("rechecks each automatic tree and stops between complete tree transactions", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-automatic-recheck");
    const first = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "first" } }),
    }).run(workflow, {});
    const second = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "second" } }),
    }).run(workflow, {});
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    const now = Date.now();
    try {
      state.connection
        .prepare("UPDATE runs SET finished_at = ? WHERE run_id IN (?, ?)")
        .run(now - AUTOMATIC_STATE_RETENTION_MS - 1, first.runId, second.runId);
      let yielded = false;
      const report = await pruneStateAutomatically(state, databasePath, {
        now,
        yieldControl: async () => {
          if (yielded) return;
          yielded = true;
          state.connection
            .prepare("UPDATE runs SET finished_at = ? WHERE run_id IN (?, ?)")
            .run(now, first.runId, second.runId);
        },
      });

      expect(report.completed).toBe(false);
      expect(report.selectedRuns).toBe(2);
      expect(state.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
        count: 1,
      });
    } finally {
      state.close();
    }
  });

  it("protects every live or unsettled state owned by an expired run", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-protected");
    const results = [];
    for (let index = 0; index < 9; index += 1) {
      results.push(
        await new WorkflowEngine({
          databasePath,
          executor: new ScriptedExecutor().respond("reply", {
            output: { reply: `run-${index}` },
          }),
        }).run(workflow, {}),
      );
    }
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    const now = Date.now();
    try {
      state.connection
        .prepare("UPDATE runs SET finished_at = ?")
        .run(now - AUTOMATIC_STATE_RETENTION_MS - 1);
      const contentHash = state.putText("protected", now);
      const contractHash = state.putJson({ contract: "protected" }, now);
      const launchHash = state.putJson({ launch: "protected" }, now);
      const attemptIds = results.map((result) => {
        const row = state.connection
          .prepare("SELECT attempt_id AS attemptId FROM node_attempts WHERE run_id = ? LIMIT 1")
          .get(result.runId) as { attemptId: string };
        return row.attemptId;
      });

      state.connection
        .prepare(
          `INSERT INTO workflow_messages(
             workflow_message_id, run_id, target_session_id, kind, source_id, content_hash,
             order_number, status, created_at, updated_at
           ) VALUES ('pending-message', ?, 'protected-session', 'step', 'pending-source', ?, 1, 'pending', ?, ?)`,
        )
        .run(results[0]?.runId, contentHash, now, now);
      state.connection
        .prepare(
          `INSERT INTO workflow_messages(
             workflow_message_id, run_id, target_session_id, kind, source_id, content_hash,
             order_number, status, pi_session_entry_id, created_at, updated_at
           ) VALUES ('open-turn-message', ?, 'protected-session', 'step', 'turn-source', ?, 2, 'sent', 'pi-entry', ?, ?)`,
        )
        .run(results[1]?.runId, contentHash, now, now);
      state.connection
        .prepare(
          `INSERT INTO workflow_turns(
             workflow_turn_id, workflow_message_id, run_id, target_session_id, state, started_at
           ) VALUES ('open-turn', 'open-turn-message', ?, 'protected-session', 'started', ?)`,
        )
        .run(results[1]?.runId, now);
      state.connection
        .prepare(
          `INSERT INTO interactive_requests(
             request_id, run_id, attempt_id, target_session_id, kind, contract_hash,
             status, created_at, updated_at
           ) VALUES ('pending-interaction', ?, ?, 'protected-session', 'agent', ?, 'pending', ?, ?)`,
        )
        .run(results[2]?.runId, attemptIds[2], contractHash, now, now);
      state.connection
        .prepare("UPDATE node_attempts SET status = 'waiting' WHERE attempt_id = ?")
        .run(attemptIds[3]);
      state.connection
        .prepare(
          `INSERT INTO run_workers(
             worker_epoch, run_id, generation, host_epoch, launch_envelope_hash,
             status, started_at, ready_at
           ) VALUES ('active-worker', ?, 1, 1, ?, 'running', ?, ?)`,
        )
        .run(results[4]?.runId, launchHash, now, now);

      const segmentResourceId = resourceIdFor("session", "recording-segment");
      state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'session', 'recording-segment', 1, ?, ?)`,
        )
        .run(segmentResourceId, now, now);
      state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(segmentResourceId);
      state.connection
        .prepare(
          `INSERT INTO session_segments(
             segment_id, run_id, session_id, resource_id, status, created_at
           ) VALUES ('recording-segment', ?, 'protected-session', ?, 'recording', ?)`,
        )
        .run(results[5]?.runId, segmentResourceId, now);

      const effectId = "pending-effect";
      const effectResourceId = resourceIdFor("effect", effectId);
      const source = state.connection
        .prepare("SELECT resource_id AS resourceId FROM runs WHERE run_id = ?")
        .get(results[6]?.runId) as { resourceId: string };
      state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'effect', ?, 1, ?, ?)`,
        )
        .run(effectResourceId, effectId, now, now);
      state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(effectResourceId);
      state.connection
        .prepare(
          `INSERT INTO effects(
             effect_id, resource_id, source_resource_id, source_revision, effect_type,
             idempotency_key, payload_hash, owner_scope, status, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 'test', 'pending-effect', ?, 'run', 'pending', ?, ?)`,
        )
        .run(effectId, effectResourceId, source.resourceId, contentHash, now, now);

      const decisionId = "pending-decision";
      const decisionResourceId = resourceIdFor("decision", decisionId);
      state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'decision', ?, 1, ?, ?)`,
        )
        .run(decisionResourceId, decisionId, now, now);
      state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(decisionResourceId);
      state.connection
        .prepare(
          `INSERT INTO human_decisions(
             decision_id, resource_id, run_id, attempt_id, audience, title, subject_hash,
             presentation_hash, choices_hash, request_digest, presentation_revision,
             request_hash, created_at
           ) VALUES (?, ?, ?, ?, 'operator', 'Pending', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          decisionId,
          decisionResourceId,
          results[7]?.runId,
          attemptIds[7],
          contractHash,
          contractHash,
          contractHash,
          Buffer.alloc(32, 8),
          contractHash,
          now,
        );

      const controllerId = "retention-controller";
      const controllerResourceId = resourceIdFor("controller", controllerId);
      state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'controller', ?, 1, ?, ?)`,
        )
        .run(controllerResourceId, controllerId, now, now);
      state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(controllerResourceId);
      state.connection
        .prepare(
          `INSERT INTO controller_resources(
             controller_resource_id, resource_id, controller_name, resource_key, uid,
             generation, spec_hash, status_hash, created_at, updated_at
           ) VALUES (?, ?, 'retention', 'protected', 'retention-protected', 1, ?, ?, ?, ?)`,
        )
        .run(controllerId, controllerResourceId, contractHash, contractHash, now, now);
      state.connection
        .prepare(
          `INSERT INTO controller_workflows(
             request_id, controller_resource_id, request_key, workflow_name,
             input_fingerprint, run_id, status, created_at, updated_at
           ) VALUES (
             'retention-controller-request', ?, 'protected', 'retention', ?, ?, 'succeeded', ?, ?
           )`,
        )
        .run(controllerId, Buffer.alloc(32, 9), results[8]?.runId, now, now);

      const report = await pruneStateAutomatically(state, databasePath, { now });
      expect(report).toMatchObject({
        completed: true,
        candidateTrees: 9,
        blockedTrees: 9,
        selectedRuns: 0,
      });
      expect(state.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
        count: 9,
      });
    } finally {
      state.close();
    }
  });

  it("reuses free pages and compacts only above both automatic thresholds", async () => {
    expect(
      shouldVacuumStateAutomatically({
        pageCount: 100,
        freePageCount: 20,
        pageSize: 4096,
        reclaimableBytes: 64 * 1024 * 1024,
        freePageRatio: 0.2,
      }),
    ).toBe(true);
    expect(
      shouldVacuumStateAutomatically({
        pageCount: 100,
        freePageCount: 19,
        pageSize: 4096,
        reclaimableBytes: 64 * 1024 * 1024,
        freePageRatio: 0.19,
      }),
    ).toBe(false);

    const databasePath = await makeStateDatabasePath("state-prune-pages");
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    try {
      state.putBlob(Buffer.alloc(2 * 1024 * 1024, 11), "application/json");
      state.connection.pragma("wal_checkpoint(TRUNCATE)");
      const bytesBefore = fs.statSync(databasePath).size;
      const logical = await pruneStateAutomatically(state, databasePath);
      expect(logical.compacted).toBe(false);
      expect(logical.reclaimableBytes).toBeGreaterThan(1024 * 1024);
      const reusablePages = logical.pageCount;

      state.putBlob(Buffer.alloc(2 * 1024 * 1024, 12), "application/json");
      state.connection.pragma("wal_checkpoint(TRUNCATE)");
      const pageCountAfterReuse = state.connection.pragma("page_count", { simple: true });
      expect(pageCountAfterReuse).toBeLessThanOrEqual(reusablePages + 2);

      const compacted = await pruneStateAutomatically(state, databasePath, {
        vacuumMinBytes: 1,
        vacuumMinFreeRatio: 0,
      });
      expect(compacted.compacted).toBe(true);
      expect(fs.statSync(databasePath).size).toBeLessThan(bytesBefore);
    } finally {
      state.close();
    }
  });

  it("keeps logical cleanup when automatic compaction fails", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-compaction-failure");
    const state = new StateDatabase({ filePath: databasePath, mode: "read-write" });
    try {
      const orphan = state.putBlob(Buffer.alloc(2 * 1024 * 1024, 13), "application/json");
      state.connection.pragma("wal_checkpoint(TRUNCATE)");
      const report = await pruneStateAutomatically(state, databasePath, {
        vacuumMinBytes: 1,
        vacuumMinFreeRatio: 0,
        vacuum: () => {
          throw new Error("injected compaction failure");
        },
      });

      expect(report).toMatchObject({
        completed: true,
        compacted: false,
        compactionError: "injected compaction failure",
      });
      expect(report.reclaimableBytes).toBeGreaterThan(1024 * 1024);
      expect(state.readBlob(orphan)).toBeUndefined();
      state.integrityCheck();
    } finally {
      state.close();
    }
  });

  it("requires an absolute new backup path for apply mode", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-backup");
    await expect(
      pruneState(databasePath, {
        before: new Date().toISOString(),
        apply: true,
        backupPath: "relative.sqlite",
      }),
    ).rejects.toThrow(/absolute/);
  });

  it("rejects invalid cutoffs and apply mode without a backup", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-options");
    await expect(pruneState(databasePath, { before: "not-a-time", apply: false })).rejects.toThrow(
      /valid timestamp/,
    );
    await expect(
      pruneState(databasePath, { before: new Date().toISOString(), apply: true }),
    ).rejects.toThrow(/requires --backup/);
  });

  it("does not overwrite a backup or enter a second maintenance operation", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-lock");
    const directory = path.dirname(databasePath);
    const backupPath = path.join(directory, "existing.sqlite");
    fs.writeFileSync(backupPath, "keep");
    await expect(
      pruneState(databasePath, {
        before: new Date().toISOString(),
        apply: true,
        backupPath,
      }),
    ).rejects.toThrow(/already exists/);

    fs.writeFileSync(`${databasePath}.maintenance.lock`, "busy");
    await expect(
      pruneState(databasePath, {
        before: new Date().toISOString(),
        apply: true,
        backupPath: path.join(directory, "new.sqlite"),
      }),
    ).rejects.toThrow(/already active/);
  });

  it("releases the maintenance lock when the database cannot open", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-open-failure");
    fs.writeFileSync(databasePath, "not a SQLite database");
    const lockPath = `${databasePath}.maintenance.lock`;
    await expect(
      pruneState(databasePath, {
        before: new Date().toISOString(),
        apply: true,
        backupPath: path.join(path.dirname(databasePath), "backup.sqlite"),
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
