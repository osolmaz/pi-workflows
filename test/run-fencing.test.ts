import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ClaimLostError, type ClaimLostReason } from "../src/workflows/errors.js";
import {
  createDefinitionSnapshot,
  WorkflowRunStore,
  type RunWriteAuthority,
} from "../src/workflows/store.js";
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
      now: new Date(now + 60_000).toISOString(),
    });
    await expect(
      stale.appendSessionEntry(runId, { id: "late", type: "message" }),
    ).rejects.toBeInstanceOf(ClaimLostError);
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
    ).rejects.toBeInstanceOf(ClaimLostError);
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
    ).rejects.toBeInstanceOf(ClaimLostError);
    stale.close();
    queue.close();
  });

  it.each<{
    reason: ClaimLostReason;
    authority: (current: RunWriteAuthority | undefined) => RunWriteAuthority | undefined;
    expired?: boolean;
  }>([
    { reason: "missingAuthority", authority: () => undefined },
    {
      reason: "ownerChanged",
      authority: (current) =>
        current === undefined ? undefined : { ...current, ownerId: "session-other" },
    },
    {
      reason: "tokenChanged",
      authority: (current) =>
        current === undefined ? undefined : { ...current, token: "wrong-token" },
    },
    {
      reason: "generationChanged",
      authority: (current) =>
        current === undefined ? undefined : { ...current, generation: current.generation + 1 },
    },
    { reason: "expired", authority: (current) => current, expired: true },
  ])("reports typed $reason claim loss", async ({ reason, authority, expired }) => {
    const { queue, databasePath } = await setup();
    const runId = `typed-${reason}`;
    const token = "typed-token";
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-typed",
      claimToken: token,
      leaseMs: expired === true ? 1 : 60_000,
      originSessionId: "session-typed",
      ...(expired === true ? { now: new Date(Date.now() - 60_000).toISOString() } : {}),
    });
    const current = queue.workflowRunAuthority(runId, token);
    const store = new WorkflowRunStore(databasePath, {
      authorityProvider: () => authority(current),
    });

    let thrown: unknown;
    try {
      await new WorkflowEngine({
        store,
        executor: new ScriptedExecutor().respond("reply", { output: { reply: "no" } }),
      }).run(workflow, {}, { runId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaimLostError);
    expect((thrown as ClaimLostError).reason).toBe(reason);
    store.close();
    queue.close();
  });

  it("renews the exact live claim in the protected write transaction", async () => {
    const { queue, databasePath } = await setup();
    const runId = "atomic-renewal";
    const token = "renew-token";
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-renew",
      claimToken: token,
      leaseMs: 5_000,
      originSessionId: "session-renew",
    });
    const before = Date.parse(queue.getWorkflowRun(runId)?.claimExpiresAt ?? "");
    const current = queue.workflowRunAuthority(runId, token);
    const store = new WorkflowRunStore(databasePath, {
      authorityProvider: () =>
        current === undefined ? undefined : { ...current, leaseMs: 120_000 },
    });
    await new WorkflowEngine({
      store,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "ok" } }),
    }).run(workflow, {}, { runId });
    const after = Date.parse(queue.getWorkflowRun(runId)?.claimExpiresAt ?? "");
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(Date.now() + 100_000);
    store.close();
    queue.close();
  });

  it("rolls back claim renewal when the protected mutation fails", async () => {
    const { queue, databasePath } = await setup();
    const runId = "renewal-rollback";
    const token = "rollback-token";
    queue.enqueueWorkflowRun({
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-rollback",
      claimToken: token,
      leaseMs: 60_000,
      originSessionId: "session-rollback",
    });
    const before = queue.getWorkflowRun(runId)?.claimExpiresAt;
    const current = queue.workflowRunAuthority(runId, token);
    const store = new WorkflowRunStore(databasePath, {
      authorityProvider: () =>
        current === undefined ? undefined : { ...current, leaseMs: 120_000 },
    });
    const conflictingWorkflow = { ...workflow, name: "conflicting-echo" };
    await expect(
      new WorkflowEngine({ store, executor: new ScriptedExecutor() }).run(
        conflictingWorkflow,
        {},
        { runId },
      ),
    ).rejects.toThrow(/definition conflicts/);
    expect(queue.getWorkflowRun(runId)?.claimExpiresAt).toBe(before);
    store.close();
    queue.close();
  });
});
