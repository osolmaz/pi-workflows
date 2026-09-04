import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { WorkflowMessageStore, workflowMessageIdFor } from "../src/state/workflow-messages.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import {
  notificationWorkflowMessageContent,
  terminalWorkflowMessageContent,
} from "../src/workflows/workflow-message-content.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function databaseFixture() {
  const projectPath = await makeTempDir("sqlite-lifecycle-project");
  const databasePath = path.join(await makeTempDir("sqlite-lifecycle-state"), "state.sqlite");
  const store = new SqliteResourceManagerStore(databasePath, { projectPath });
  return { store, projectPath, databasePath };
}

function reserve(store: SqliteResourceManagerStore, runId: string, sessionId: string) {
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
  it("returns explicit missing and stale resource manager outcomes", async () => {
    const { store } = await databaseFixture();
    expect(store.getResource({ resourceManager: "missing", key: "none" })).toBeUndefined();
    expect(store.getResourceByUid("missing")).toBeUndefined();
    expect(
      store.claimNext({ resourceManagers: [], ownerId: "worker", leaseMs: 10_000 }),
    ).toBeUndefined();
    expect(
      store.renewWorkflowRunClaim({
        runId: "missing",
        claimToken: "missing",
        leaseMs: 10_000,
      }),
    ).toBe(false);
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    expect(
      store.claimNext({ resourceManagers: ["other"], ownerId: "worker", leaseMs: 10_000 }),
    ).toBeUndefined();
    const claim = store.claimNext({
      resourceManagers: ["jobs"],
      ownerId: "worker",
      leaseMs: 10_000,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(
      store.claimNext({ resourceManagers: ["jobs"], ownerId: "other", leaseMs: 10_000 }),
    ).toBeUndefined();
    expect(store.renewClaim({ ...claim, token: "wrong" }, 10_000)).toBe(false);
    expect(store.settleClaim({ ...claim, token: "wrong" })).toBe(false);
    expect(
      store.requeueClaim({ ...claim, token: "wrong" }, { availableAt: new Date().toISOString() }),
    ).toBe(false);
    expect(
      store.recordEvent({ resourceManager: "jobs", key: "one", type: "observed" }).payload,
    ).toEqual({});
    expect(store.settleClaim(claim)).toBe(true);
    store.close();
  });

  it("validates finalizers and missing effect or workflow records", async () => {
    const { store } = await databaseFixture();
    const resource = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    expect(() =>
      store.updateFinalizers({
        ref: { resourceManager: "jobs", key: "one" },
        expectedResourceVersion: resource.metadata.resourceVersion,
        finalizers: ["same", "same"],
      }),
    ).toThrow(/unique/);
    expect(() =>
      store.updateFinalizers({
        ref: { resourceManager: "jobs", key: "one" },
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
          resourceManager: "jobs",
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
    const shared = new SqliteResourceManagerStore(databasePath, {
      state: store.state,
      projectPath,
    });
    shared.close();
    expect(store.listResources()).toEqual([]);
    store.close();
  });

  it("persists workflow messages and model turns without send claims", async () => {
    const { store, databasePath } = await databaseFixture();
    reserve(store, "message-run", "session-a");
    const token = "run-token";
    store.claimWorkflowRun({
      runId: "message-run",
      runnerId: "session-a",
      claimToken: token,
      leaseMs: 60_000,
    });
    const runStore = new WorkflowRunStore(databasePath, {
      state: store.state,
      authorityProvider: () => store.workflowRunAuthority("message-run", token),
    });
    const run = await new WorkflowEngine({
      store: runStore,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "ok" } }),
    }).run(echoWorkflow, {}, { runId: "message-run" });
    const messages = new WorkflowMessageStore(store.state);
    const notificationId = "notification-1";
    const notificationMessageId = workflowMessageIdFor("notification", notificationId, "1");
    const notificationContent = notificationWorkflowMessageContent({
      workflowMessageId: notificationMessageId,
      notificationId,
      runId: run.runId,
      kind: "final",
      content: "done",
    });
    const first = messages.create({
      workflowMessageId: notificationMessageId,
      runId: run.runId,
      targetSessionId: "session-a",
      kind: "notification",
      sourceId: notificationId,
      idempotencyKey: "1",
      content: notificationContent,
    });
    expect(
      messages.create({
        workflowMessageId: notificationMessageId,
        runId: run.runId,
        targetSessionId: "session-a",
        kind: "notification",
        sourceId: notificationId,
        idempotencyKey: "1",
        content: notificationContent,
      }),
    ).toEqual(first);
    expect(() =>
      messages.adoptBranch(
        "session-b",
        [{ workflowMessageId: notificationMessageId, piSessionEntryId: "entry-wrong" }],
        new Set([notificationMessageId]),
      ),
    ).toThrow(/wrong origin session/);
    expect(
      messages.adoptBranch(
        "session-a",
        [{ workflowMessageId: notificationMessageId, piSessionEntryId: "entry-1" }],
        new Set([notificationMessageId]),
      )[0],
    ).toMatchObject({ status: "sent", piSessionEntryId: "entry-1" });

    const terminalMessageId = workflowMessageIdFor("terminal", run.runId, "terminal");
    messages.create({
      workflowMessageId: terminalMessageId,
      runId: run.runId,
      targetSessionId: "session-a",
      kind: "terminal",
      sourceId: run.runId,
      idempotencyKey: "terminal",
      content: terminalWorkflowMessageContent({
        workflowMessageId: terminalMessageId,
        runId: run.runId,
        content: "Present the result.",
        details: { status: "completed" },
      }),
    });
    messages.adoptBranch(
      "session-a",
      [{ workflowMessageId: terminalMessageId, piSessionEntryId: "entry-2" }],
      new Set([terminalMessageId]),
    );
    const turn = messages.startTurn({
      workflowMessageId: terminalMessageId,
      workflowTurnId: "turn-1",
      runId: run.runId,
      targetSessionId: "session-a",
    });
    expect(
      messages.startTurn({
        workflowMessageId: terminalMessageId,
        workflowTurnId: "turn-1",
        runId: run.runId,
        targetSessionId: "session-a",
      }),
    ).toEqual(turn);
    expect(
      messages.endTurn({
        workflowMessageId: terminalMessageId,
        workflowTurnId: "turn-1",
        runId: run.runId,
        targetSessionId: "session-a",
        stopReason: "completed",
        responseSessionEntryId: "assistant-1",
      }),
    ).toMatchObject({ state: "ended", stopReason: "completed" });
    expect(() =>
      messages.endTurn({
        workflowMessageId: terminalMessageId,
        workflowTurnId: "turn-1",
        runId: run.runId,
        targetSessionId: "session-a",
        stopReason: "error",
      }),
    ).toThrow(/conflicts/);
    runStore.close();
    store.close();
  });

  it("maps rejected and ambiguous resource manager effects", async () => {
    const { store } = await databaseFixture();
    const resource = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    const claim = store.claimNext({
      resourceManagers: ["jobs"],
      ownerId: "worker",
      leaseMs: 60_000,
    });
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
