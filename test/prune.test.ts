import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { resourceIdFor } from "../src/state/mutation.js";
import { pruneState } from "../src/state/prune.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

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
      .prepare("UPDATE runs SET parent_run_id = ? WHERE run_id = ?")
      .run(result.runId, child.runId);
    setup.state.connection
      .prepare(
        "UPDATE workflow_follow_up_queues SET presentation_state = 'not-needed' WHERE run_id IN (?, ?)",
      )
      .run(result.runId, child.runId);
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    const runResource = setup.state.connection
      .prepare(
        "SELECT resource_id AS resourceId, revision FROM runs JOIN resources USING (resource_id) WHERE run_id = ?",
      )
      .get(result.runId) as { resourceId: string; revision: number };
    const now = Date.now();
    const notificationId = "notification-prune";
    const notificationResourceId = resourceIdFor("notification", notificationId);
    const effectId = "effect-prune";
    const effectResourceId = resourceIdFor("effect", effectId);
    const contentHash = setup.state.putText("done", now);
    const settingsResourceId = resourceIdFor("settings", "settings-prune");
    const followUpId = "follow-up-prune";
    const followUpResourceId = resourceIdFor("follow_up", followUpId);
    const followUpQueue = setup.state.connection
      .prepare("SELECT resource_id AS resourceId FROM workflow_follow_up_queues WHERE run_id = ?")
      .get(result.runId) as { resourceId: string };
    const settingsHash = setup.state.putJson({ mode: "test" }, now);
    setup.state.transaction(() => {
      setup.state.connection
        .prepare(
          "INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at) VALUES (?, 'effect', ?, 1, ?, ?), (?, 'notification', ?, 1, ?, ?)",
        )
        .run(
          effectResourceId,
          effectId,
          now,
          now,
          notificationResourceId,
          notificationId,
          now,
          now,
        );
      setup.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0), (?, 0)")
        .run(effectResourceId, notificationResourceId);
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
          "INSERT INTO workflow_follow_ups(follow_up_id, resource_id, queue_resource_id, run_id, request_id, order_number, target_session_id, actor_type, source_type, prompt_hash, status, reason_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'request-prune', 1, 'session-a', 'system', 'test', ?, 'removed', ?, ?, ?)",
        )
        .run(
          followUpId,
          followUpResourceId,
          followUpQueue.resourceId,
          result.runId,
          contentHash,
          contentHash,
          now,
          now,
        );
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
          "INSERT INTO notifications(notification_id, effect_id, run_id, attempt_id, notification_index, target_session_id, notification_type, content_hash, created_at) VALUES (?, ?, ?, ?, 0, 'session-a', 'final', ?, ?)",
        )
        .run(notificationId, effectId, result.runId, attemptId, contentHash, now);
      setup.state.connection
        .prepare(
          "INSERT INTO events(event_id, resource_id, resource_revision, event_type, actor_type, recorded_at) VALUES ('notification-prune-event', ?, 1, 'notification.queued', 'system', ?)",
        )
        .run(notificationResourceId, now);
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
          "SELECT count(*) AS count FROM resources WHERE resource_type IN ('effect', 'notification', 'settings', 'follow_up', 'follow_up_queue')",
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

  it("blocks a run with pending follow-up presentation", async () => {
    const databasePath = await makeStateDatabasePath("state-prune-follow-up");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    store.state.connection
      .prepare(
        "UPDATE workflow_follow_up_queues SET presentation_state = 'pending' WHERE run_id = ?",
      )
      .run(result.runId);
    store.close();

    const preview = await pruneState(databasePath, {
      before: new Date(Date.now() + 120_000).toISOString(),
      apply: false,
    });
    expect(preview).toMatchObject({ candidateTrees: 1, blockedTrees: 1, selectedRuns: 0 });
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
