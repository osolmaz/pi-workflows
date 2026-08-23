import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import {
  DeferredTurnCoordinator,
  type BranchIntentResolution,
} from "../src/extension/deferred-turn-coordinator.js";
import {
  buildDeferredTurnContent,
  createDeferredTurnDescriptor,
  deferredTurnMessageId,
  deferredTurnSourceEventId,
} from "../src/extension/deferred-turn.js";
import { makeTempDir } from "./helpers.js";

const stores: SqliteControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function makeStore(): Promise<SqliteControllerStore> {
  const dir = await makeTempDir("pi-deferred-turn");
  const store = new SqliteControllerStore(path.join(dir, "state.sqlite"), {
    projectPath: dir,
  });
  const definitionSnapshot = {
    schema: "pi-workflows.definition-snapshot.v1",
    name: "autoimplement",
    startAt: "implement",
    nodes: { implement: { nodeType: "agent" } },
    edges: [],
  };
  for (const [runId, sessionId] of [
    ["run-1", "session-a"],
    ["run-2", "session-b"],
  ] as const) {
    store.reserveWorkflowRun({
      runId,
      workflowName: "autoimplement",
      workflowSourceRef: "builtin:autoimplement",
      workflowSource: { kind: "builtin", id: "autoimplement", revision: "test" },
      definitionDigest: "a".repeat(64),
      definitionSnapshot,
      input: {},
      runnerId: sessionId,
      originSessionId: sessionId,
    });
  }
  stores.push(store);
  return store;
}

function descriptor(observedState = "interrupted") {
  const cause = "agentCancelled" as const;
  return createDeferredTurnDescriptor({
    runId: "run-1",
    workflowName: "autoimplement",
    targetSessionId: "session-a",
    cause,
    sourceEventId: deferredTurnSourceEventId({
      runId: "run-1",
      cause,
      nodeId: "implement",
      attemptId: "attempt-1",
      source: "agent-step-abort",
    }),
    observedState,
    nodeId: "implement",
    attemptId: "attempt-1",
    reason: "cancelled",
  });
}

function ensure(store: SqliteControllerStore, eligible = false) {
  const value = descriptor(eligible ? "cancelled" : "interrupted");
  return store.ensureWorkflowTurnIntent({ ...value, eligible });
}

describe("deferred turn policy", () => {
  it("creates stable identities and factual bounded messages", async () => {
    const store = await makeStore();
    const first = descriptor();
    const second = descriptor();
    expect(second).toEqual(first);
    const intent = store.ensureWorkflowTurnIntent({ ...first, eligible: true });
    expect(buildDeferredTurnContent(intent)).toContain(
      "Workflow autoimplement ended with state interrupted (run run-1).",
    );
    expect(buildDeferredTurnContent(intent)).toContain("Inspect the durable workflow state");
    expect(buildDeferredTurnContent(intent)).not.toMatch(/resumed|recovered successfully/i);
  });

  it("defers a natural successor until settlement and resolves it once", async () => {
    const store = await makeStore();
    const intent = ensure(store);
    const branch = new Map<string, BranchIntentResolution>();
    const coordinator = new DeferredTurnCoordinator({
      store: () => store,
      branchResolution: (intentId) => branch.get(intentId) ?? null,
      leaseMs: 1_000,
    });
    const sent: (string | undefined)[] = [];
    expect(
      coordinator.sendNatural(
        {
          runId: "run-1",
          targetSessionId: "session-a",
          resolution: "workflowPrompt",
          send: (intentId) => {
            sent.push(intentId);
            if (intentId !== undefined) {
              branch.set(intentId, {
                resolution: "workflowPrompt",
                messageId: deferredTurnMessageId(intentId, "workflowPrompt"),
              });
            }
          },
        },
        false,
      ),
    ).toBe("deferred");
    expect(sent).toEqual([]);
    expect(coordinator.flushNatural(true)).toBe(1);
    expect(sent).toEqual([intent.intentId]);
    expect(store.getWorkflowTurnIntent(intent.intentId)).toMatchObject({
      resolution: "workflowPrompt",
    });
    expect(coordinator.flushNatural(true)).toBe(0);
  });

  it("releases a fallback claim when message delivery fails", async () => {
    const store = await makeStore();
    ensure(store, true);
    const coordinator = new DeferredTurnCoordinator({
      store: () => store,
      branchResolution: () => null,
      leaseMs: 1_000,
    });
    expect(() =>
      coordinator.deliverFallbacks(
        {
          targetSessionId: "session-a",
          send: () => {
            throw new Error("send failed");
          },
        },
        true,
      ),
    ).toThrow("send failed");
    const sent: string[] = [];
    expect(
      coordinator.deliverFallbacks(
        {
          targetSessionId: "session-a",
          send: (intent) => sent.push(intent.intentId),
        },
        true,
      ),
    ).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("delivers one eligible fallback and repairs branch delivery without resending", async () => {
    const store = await makeStore();
    const first = ensure(store, true);
    const branch = new Map<string, BranchIntentResolution>();
    const coordinator = new DeferredTurnCoordinator({
      store: () => store,
      branchResolution: (intentId) => branch.get(intentId) ?? null,
      leaseMs: 1_000,
    });
    const sent: string[] = [];
    expect(
      coordinator.deliverFallbacks(
        {
          targetSessionId: "session-a",
          send: (intent) => {
            sent.push(intent.intentId);
            branch.set(intent.intentId, {
              resolution: "fallback",
              messageId: deferredTurnMessageId(intent.intentId, "fallback"),
            });
          },
        },
        true,
      ),
    ).toBe(1);
    expect(sent).toEqual([first.intentId]);
    expect(
      coordinator.deliverFallbacks(
        { targetSessionId: "session-a", send: () => sent.push("duplicate") },
        true,
      ),
    ).toBe(0);

    const secondDescriptor = createDeferredTurnDescriptor({
      runId: "run-2",
      workflowName: "monitor",
      targetSessionId: "session-a",
      cause: "failed",
      sourceEventId: "event-2",
      observedState: "failed",
      nodeId: "$terminal",
      reason: "boom",
    });
    const second = store.ensureWorkflowTurnIntent({ ...secondDescriptor, eligible: true });
    branch.set(second.intentId, {
      resolution: "fallback",
      messageId: deferredTurnMessageId(second.intentId, "fallback"),
    });
    expect(
      coordinator.deliverFallbacks(
        { targetSessionId: "session-a", send: () => sent.push("duplicate") },
        true,
      ),
    ).toBe(0);
    expect(store.getWorkflowTurnIntent(second.intentId)?.resolution).toBe("fallback");
    expect(sent).toEqual([first.intentId]);
  });
});
