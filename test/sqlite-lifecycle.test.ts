import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function databaseFixture() {
  const projectPath = await makeTempDir("sqlite-lifecycle-project");
  const databasePath = path.join(await makeTempDir("sqlite-lifecycle-state"), "state.sqlite");
  const store = new SqliteControllerStore(databasePath, { projectPath });
  return { store, projectPath, databasePath };
}

function reserve(store: SqliteControllerStore, runId: string, sessionId: string) {
  const workflow = compileWorkflowDefinition(echoWorkflow);
  const snapshot = createDefinitionSnapshot(workflow);
  const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return store.reserveWorkflowRun({
    runId,
    workflowName: "echo",
    workflowSourceRef: "builtin:echo",
    workflowSource: { kind: "builtin", id: "echo", revision: "test" },
    definitionDigest,
    definitionSnapshot: snapshot,
    input: {},
    runnerId: sessionId,
    originSessionId: sessionId,
  });
}

describe("SQLite delivery lifecycle", () => {
  it("returns explicit missing and stale controller outcomes", async () => {
    const { store } = await databaseFixture();
    expect(store.getResource({ controller: "missing", key: "none" })).toBeUndefined();
    expect(store.getResourceByUid("missing")).toBeUndefined();
    expect(
      store.claimNext({ controllers: [], ownerId: "worker", leaseMs: 10_000 }),
    ).toBeUndefined();
    expect(
      store.renewWorkflowRunClaim({
        runId: "missing",
        claimToken: "missing",
        leaseMs: 10_000,
      }),
    ).toBe(false);
    store.putResource({ controller: "jobs", key: "one", spec: {}, initialStatus: {} });
    expect(
      store.claimNext({ controllers: ["other"], ownerId: "worker", leaseMs: 10_000 }),
    ).toBeUndefined();
    const claim = store.claimNext({
      controllers: ["jobs"],
      ownerId: "worker",
      leaseMs: 10_000,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(
      store.claimNext({ controllers: ["jobs"], ownerId: "other", leaseMs: 10_000 }),
    ).toBeUndefined();
    expect(store.renewClaim({ ...claim, token: "wrong" }, 10_000)).toBe(false);
    expect(store.settleClaim({ ...claim, token: "wrong" })).toBe(false);
    expect(
      store.requeueClaim({ ...claim, token: "wrong" }, { availableAt: new Date().toISOString() }),
    ).toBe(false);
    expect(store.recordEvent({ controller: "jobs", key: "one", type: "observed" }).payload).toEqual(
      {},
    );
    expect(store.settleClaim(claim)).toBe(true);
    store.close();
  });

  it("validates finalizers and missing effect or workflow records", async () => {
    const { store } = await databaseFixture();
    const resource = store.putResource({
      controller: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    expect(() =>
      store.updateFinalizers({
        ref: { controller: "jobs", key: "one" },
        expectedResourceVersion: resource.metadata.resourceVersion,
        finalizers: ["same", "same"],
      }),
    ).toThrow(/unique/);
    expect(() =>
      store.updateFinalizers({
        ref: { controller: "jobs", key: "one" },
        expectedResourceVersion: 99,
        finalizers: [],
      }),
    ).toThrow(/changed during reconciliation/);
    expect(store.getEffect(resource.metadata.uid, "missing")).toBeUndefined();
    expect(store.getWorkflow(resource.metadata.uid, "missing")).toBeUndefined();
    expect(store.getWorkflowByRequestId("missing")).toBeUndefined();
    expect(() =>
      store.updateWorkflow(
        "missing",
        { state: "failed" },
        {
          controller: "jobs",
          key: "one",
          ownerId: "worker",
          token: "none",
          generation: 1,
          queueVersion: 1,
          resourceVersion: 1,
          consecutiveErrors: 0,
          expiresAt: new Date().toISOString(),
        },
      ),
    ).toThrow(/not found/);
    store.close();
  });

  it("shares one connection without transferring close ownership", async () => {
    const { store, databasePath, projectPath } = await databaseFixture();
    const shared = new SqliteControllerStore(databasePath, {
      state: store.state,
      projectPath,
    });
    shared.close();
    expect(store.listResources()).toEqual([]);
    store.close();
  });

  it("claims and settles notifications exactly once", async () => {
    const { store, databasePath } = await databaseFixture();
    reserve(store, "notification-run", "session-a");
    const token = "run-token";
    store.claimWorkflowRun({
      runId: "notification-run",
      runnerId: "session-a",
      claimToken: token,
      leaseMs: 60_000,
    });
    const runStore = new WorkflowRunStore(databasePath, {
      state: store.state,
      authorityProvider: () => store.workflowRunAuthority("notification-run", token),
    });
    const run = await new WorkflowEngine({
      store: runStore,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "ok" } }),
    }).run(echoWorkflow, {}, { runId: "notification-run" });
    const attemptId = run.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    const first = store.enqueueWorkflowNotification({
      runId: run.runId,
      nodeId: "reply",
      attemptId,
      notificationIndex: 1,
      targetSessionId: "session-a",
      kind: "final",
      content: "done",
    });
    const adopted = store.enqueueWorkflowNotification({
      runId: run.runId,
      nodeId: "reply",
      attemptId,
      notificationIndex: 1,
      targetSessionId: "session-a",
      kind: "final",
      content: "done",
    });
    expect(adopted.notificationId).toBe(first.notificationId);
    expect(
      store.claimPendingWorkflowNotifications({
        targetSessionId: "session-b",
        claimToken: "wrong",
        leaseMs: 10_000,
      }),
    ).toEqual([]);
    const now = Date.now();
    const claimed = store.claimPendingWorkflowNotifications({
      targetSessionId: "session-a",
      claimToken: "delivery-token",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    expect(claimed).toHaveLength(1);
    const reclaimed = store.claimPendingWorkflowNotifications({
      targetSessionId: "session-a",
      claimToken: "replacement-token",
      leaseMs: 10_000,
      now: new Date(now + 2_000).toISOString(),
    });
    expect(reclaimed).toHaveLength(1);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: first.notificationId,
        targetSessionId: "session-b",
        claimToken: "replacement-token",
        now: new Date(now + 2_000).toISOString(),
      }),
    ).toBe(false);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: first.notificationId,
        targetSessionId: "session-a",
        claimToken: "delivery-token",
        now: new Date(now + 2_000).toISOString(),
      }),
    ).toBe(false);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: first.notificationId,
        targetSessionId: "session-a",
        claimToken: "replacement-token",
        now: new Date(now + 2_000).toISOString(),
      }),
    ).toBe(true);
    expect(
      store.claimPendingWorkflowNotifications({
        targetSessionId: "session-a",
        claimToken: "later",
        leaseMs: 10_000,
      }),
    ).toEqual([]);
    store.close();
  });

  it("claims, releases, makes eligible, and resolves deferred turns", async () => {
    const { store } = await databaseFixture();
    reserve(store, "run-1", "session-a");
    const facts = {
      schema: "pi-workflows.deferred-turn-facts.v1" as const,
      workflowName: "echo",
      runId: "run-1",
      observedState: "failed",
      cause: "failed" as const,
      nodeId: null,
      attemptId: null,
      reason: "boom",
      handoff: false,
    };
    const intent = store.ensureWorkflowTurnIntent({
      intentId: "intent-1",
      sourceEventId: "source-1",
      runId: "run-1",
      workflowRef: "echo",
      targetSessionId: "session-a",
      cause: "failed",
      fallbackFacts: facts,
      eligible: false,
    });
    expect(
      store.ensureWorkflowTurnIntent({
        intentId: "intent-other",
        sourceEventId: "source-1",
        runId: "run-1",
        workflowRef: "echo",
        targetSessionId: "session-a",
        cause: "failed",
        fallbackFacts: facts,
        eligible: false,
      }).intentId,
    ).toBe(intent.intentId);
    expect(
      store.claimWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: "session-b",
        claimToken: "token",
        leaseMs: 10_000,
      }),
    ).toBeUndefined();
    expect(
      store.claimWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: "session-a",
        claimToken: "token",
        leaseMs: 10_000,
      }),
    ).toBeDefined();
    expect(
      store.releaseWorkflowTurnIntentClaim({
        intentId: intent.intentId,
        targetSessionId: "session-b",
        claimToken: "token",
      }),
    ).toBe(false);
    expect(
      store.releaseWorkflowTurnIntentClaim({
        intentId: intent.intentId,
        targetSessionId: "session-a",
        claimToken: "token",
      }),
    ).toBe(true);
    expect(
      store.makeWorkflowTurnIntentEligible({ intentId: intent.intentId, fallbackFacts: facts }),
    ).toBe(true);
    const [eligible] = store.claimEligibleWorkflowTurnIntents({
      targetSessionId: "session-a",
      claimToken: "fallback",
      leaseMs: 10_000,
    });
    expect(eligible?.intentId).toBe(intent.intentId);
    expect(
      store.resolveWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: "session-b",
        claimToken: "fallback",
        resolution: "fallback",
      }),
    ).toBe(false);
    expect(
      store.resolveWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: "session-a",
        claimToken: "fallback",
        resolution: "fallback",
        messageId: "message-1",
      }),
    ).toBe(true);
    expect(store.listWorkflowTurnIntents({ runId: "run-1", unresolvedOnly: true })).toEqual([]);
    store.close();
  });

  it("maps rejected and ambiguous controller effects", async () => {
    const { store } = await databaseFixture();
    const resource = store.putResource({
      controller: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    const claim = store.claimNext({ controllers: ["jobs"], ownerId: "worker", leaseMs: 60_000 });
    if (claim === undefined) throw new Error("claim missing");
    for (const [key, state] of [
      ["rejected", "rejected"],
      ["uncertain", "indeterminate"],
    ] as const) {
      store.reserveEffect({
        key,
        resourceUid: resource.metadata.uid,
        claim,
        generation: 1,
        kind: "test",
        requestFingerprint: key.padEnd(64, "a"),
      });
      expect(
        store.updateEffect({
          resourceUid: resource.metadata.uid,
          key,
          claim,
          state,
          error: "failure",
        }).state,
      ).toBe(state);
    }
    expect(
      store
        .listEffects(resource.metadata.uid)
        .map((effect) => effect.state)
        .sort(),
    ).toEqual(["indeterminate", "rejected"]);
    store.close();
  });

  it("filters claims by session and rejects wrong tokens", async () => {
    const { store } = await databaseFixture();
    reserve(store, "run-a", "session-a");
    reserve(store, "run-b", "session-b");
    expect(
      store.claimNextWorkflowRun({
        runnerId: "session-a",
        sessionId: "session-a",
        claimToken: "token-a",
        leaseMs: 10_000,
        excludeRunIds: ["run-b"],
      })?.runId,
    ).toBe("run-a");
    expect(store.verifyWorkflowRunClaim({ runId: "run-a", claimToken: "wrong" })).toBe(false);
    expect(store.parkWorkflowRun({ runId: "run-a", claimToken: "wrong" })).toBe(false);
    expect(store.deleteWorkflowRun({ runId: "run-a", claimToken: "wrong" })).toBe(false);
    expect(store.setWorkflowRunOriginSession("run-b", "session-c")).toBe(true);
    store.close();
  });
});
