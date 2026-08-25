import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
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
});
