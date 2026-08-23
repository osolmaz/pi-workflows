import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

const workflow = compileWorkflowDefinition(rawWorkflow);
const snapshot = createDefinitionSnapshot(workflow);
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

async function setup() {
  const projectPath = await makeTempDir("run-fence-project");
  const databasePath = path.join(await makeTempDir("run-fence-state"), "state.sqlite");
  const queue = new SqliteControllerStore(databasePath, { projectPath });
  return { queue, databasePath };
}

describe("run ownership fencing", () => {
  it("allows the current claim to write", async () => {
    const { queue, databasePath } = await setup();
    const runId = "owned-run";
    const token = "token-1";
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-1",
      claimToken: token,
      leaseMs: 60_000,
      originSessionId: "session-1",
    });
    const store = new WorkflowRunStore(databasePath, {
      authorityProvider: () => queue.workflowRunAuthority(runId, token),
    });
    const result = await new WorkflowEngine({
      store,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "ok" } }),
    }).run(
      workflow,
      {},
      { runId, workflowSource: { kind: "builtin", id: "echo", revision: "test" } },
    );
    expect(result.state.status).toBe("completed");
    store.close();
    queue.close();
  });

  it("rejects stale session capture writes after claim handoff", async () => {
    const { queue, databasePath } = await setup();
    const runId = "capture-handoff";
    const now = Date.now();
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-1",
      claimToken: "old",
      leaseMs: 1_000,
      originSessionId: "session-1",
      now: new Date(now).toISOString(),
    });
    const stale = new WorkflowRunStore(databasePath, {
      state: queue.state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "old"),
    });
    await stale.initializeRun(workflow, {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 0,
      runId,
      workflowName: workflow.name,
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
    });
    await stale.writeSessionBinding(runId, {
      schema: "pi-workflows.session-binding.v1",
      runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date(now).toISOString(),
    });
    queue.claimWorkflowRun({
      runId,
      runnerId: "host-2",
      claimToken: "new",
      leaseMs: 60_000,
      now: new Date(now + 2_000).toISOString(),
    });
    await expect(stale.appendSessionEntry(runId, { id: "late", type: "message" })).rejects.toThrow(
      /revision conflict|ownership changed/,
    );
    await expect(
      stale.appendSessionEventBatch(runId, [
        {
          seq: 1,
          at: new Date().toISOString(),
          nodeId: "reply",
          attemptId: "attempt",
          turnId: "turn",
          type: "turn_started",
          payload: {},
        },
      ]),
    ).rejects.toThrow(/revision conflict|ownership changed/);
    stale.close();
    queue.close();
  });

  it("rejects the old writer after claim handoff", async () => {
    const { queue, databasePath } = await setup();
    const runId = "handoff-run";
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-1",
      claimToken: "old",
      leaseMs: 1,
      originSessionId: "session-1",
      now: "2026-08-23T00:00:00.000Z",
    });
    queue.claimWorkflowRun({
      runId,
      runnerId: "host-2",
      claimToken: "new",
      leaseMs: 60_000,
      now: "2026-08-23T00:00:01.000Z",
    });
    const stale = new WorkflowRunStore(databasePath, {
      authorityProvider: () => queue.workflowRunAuthority(runId, "old"),
    });
    await expect(
      new WorkflowEngine({
        store: stale,
        executor: new ScriptedExecutor().respond("reply", { output: { reply: "no" } }),
      }).run(workflow, {}, { runId }),
    ).rejects.toThrow(/revision conflict|ownership changed/);
    stale.close();
    queue.close();
  });
});
