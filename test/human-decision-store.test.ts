import { describe, expect, it, vi } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import workflow from "../examples/workflows/human-decision.workflow.js";
import { StateDatabase } from "../src/state/database.js";
import { StateMutationStore, resourceIdFor } from "../src/state/mutation.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore, createHumanDecisionRequest } from "../src/workflows/human-decision.js";
import { ScriptedExecutor, makeStateDatabasePath, makeTempDir } from "./helpers.js";

async function waitingDecision(databasePath: string) {
  const result = await new WorkflowEngine({
    databasePath,
    executor: new ScriptedExecutor(),
  }).run(workflow, { task: "approve" });
  const store = new HumanDecisionStore(databasePath);
  const request = (await store.listRequests())[0];
  if (request === undefined) throw new Error("decision request missing");
  return { result, request, store };
}

async function defaultedRequest(
  store: HumanDecisionStore,
  request: Awaited<ReturnType<typeof waitingDecision>>["request"],
) {
  const value = createHumanDecisionRequest({
    runId: request.runId,
    workflowName: request.workflowName,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    contract: { audience: request.audience, choices: request.choices },
    prompt: {
      title: request.title,
      subject: request.subject,
      presentation: request.presentation,
      revision: request.revision,
    },
    timeout: { afterMs: 1, response: { choice: "continue" } },
    createdAt: "2026-08-22T00:00:00.000Z",
  });
  await store.createRequest(value);
  return value;
}

describe("HumanDecisionStore SQLite", () => {
  it("uses the canonical default database", async () => {
    const home = await makeTempDir("decision-default-home");
    vi.stubEnv("HOME", home);
    try {
      const store = new HumanDecisionStore();
      expect(await store.listRequests()).toEqual([]);
      store.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("adopts an identical request and rejects a changed immutable request", async () => {
    const databasePath = await makeStateDatabasePath("decision-request-adopt");
    const { request, store } = await waitingDecision(databasePath);
    expect(await store.createRequest(request)).toBe("adopted");
    await expect(
      store.createRequest({ ...request, createdAt: "2000-01-01T00:00:00.000Z" }),
    ).rejects.toThrow(/request conflicts/);
    expect(await store.readRequest("missing")).toBeNull();
    store.close();
  });

  it("rejects a request whose run is not durable", async () => {
    const store = new HumanDecisionStore(await makeStateDatabasePath("decision-missing-run"));
    const request = createHumanDecisionRequest({
      runId: "missing-run",
      workflowName: "missing",
      nodeId: "approve",
      attemptId: "attempt",
      contract: {
        audience: "operator",
        choices: { continue: { label: "Continue" } },
      },
      prompt: {
        title: "Approve",
        subject: {},
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Approve.",
          blocks: [],
        },
      },
    });
    await expect(store.createRequest(request)).rejects.toThrow(/run is missing/);
    store.close();
  });

  it("accepts one verified human answer and adopts its retry", async () => {
    const databasePath = await makeStateDatabasePath("decision-human");
    const { request, store } = await waitingDecision(databasePath);
    const submission = {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "operator", eventId: "click-1" },
      idempotencyKey: "click-1",
    } as const;

    expect((await store.accept(request, submission)).status).toBe("accepted");
    expect((await store.accept(request, submission)).status).toBe("adopted");
    expect((await store.readResolved(request.decisionId))?.response).toEqual({
      choice: "continue",
    });
    expect(
      store.state.connection
        .prepare("SELECT count(*) AS count FROM human_decision_resolutions")
        .get(),
    ).toEqual({ count: 1 });
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM effects").get()).toEqual({
      count: 2,
    });
    store.close();
  });

  it("rechecks the deadline after the acceptance transaction acquires its write lock", async () => {
    const databasePath = await makeStateDatabasePath("decision-deadline-race");
    const { request, store } = await waitingDecision(databasePath);
    const before = new Date("2030-01-01T00:00:00.000Z");
    const expiring = createHumanDecisionRequest({
      runId: request.runId,
      workflowName: request.workflowName,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      contract: { audience: request.audience, choices: request.choices },
      prompt: {
        title: request.title,
        subject: request.subject,
        presentation: request.presentation,
        revision: request.revision,
      },
      timeout: { afterMs: 1_000, response: { choice: "continue" } },
      createdAt: before.toISOString(),
    });
    await store.createRequest(expiring);
    vi.useFakeTimers();
    vi.setSystemTime(before);
    const transaction = store.state.transaction.bind(store.state);
    vi.spyOn(store.state, "transaction").mockImplementation((operation) =>
      transaction(() => {
        vi.setSystemTime(new Date(before.getTime() + 2_000));
        return operation();
      }),
    );
    try {
      await expect(
        store.accept(expiring, {
          decisionId: expiring.decisionId,
          requestDigest: expiring.requestDigest,
          choice: "continue",
          source: { channel: "pi", actorId: "operator", eventId: "deadline-race" },
          idempotencyKey: "deadline-race",
        }),
      ).rejects.toThrow(/expired before the answer was accepted/);
      expect(await store.readResolved(expiring.decisionId)).toBeNull();
      expect(await store.readCancellation(expiring.decisionId)).toBeNull();
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it("rejects reuse of one answer idempotency key with different evidence", async () => {
    const databasePath = await makeStateDatabasePath("decision-idempotency");
    const { request, store } = await waitingDecision(databasePath);
    const base = {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "one", eventId: "one" },
      idempotencyKey: "same",
    } as const;
    await store.accept(request, base);
    await expect(
      store.accept(request, {
        ...base,
        source: { channel: "pi", actorId: "one", eventId: "different" },
      }),
    ).rejects.toThrow(/idempotency key conflicts/);
    store.close();
  });

  it("returns the durable winner for a conflicting late answer", async () => {
    const databasePath = await makeStateDatabasePath("decision-conflict");
    const { request, store } = await waitingDecision(databasePath);
    await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "one", eventId: "one" },
      idempotencyKey: "one",
    });
    const conflict = await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "stop",
      source: { channel: "pi", actorId: "two", eventId: "two" },
      idempotencyKey: "two",
    });
    expect(conflict).toMatchObject({
      status: "conflict",
      decision: { response: { choice: "continue" } },
    });
    store.close();
  });

  it("keeps cancellation immutable and idempotent", async () => {
    const databasePath = await makeStateDatabasePath("decision-cancel");
    const { request, store } = await waitingDecision(databasePath);

    expect(await store.cancel(request, "cancelled")).toBe("created");
    expect(await store.cancel(request, "cancelled")).toBe("adopted");
    await expect(store.cancel(request, "expired")).rejects.toThrow(/already cancelled/);
    await expect(
      store.accept(request, {
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        choice: "continue",
        source: { channel: "pi", actorId: "operator", eventId: "late" },
        idempotencyKey: "late",
      }),
    ).rejects.toThrow(/cancelled/);
    store.close();
  });

  it("rejects ineligible or missing timeout policy", async () => {
    const databasePath = await makeStateDatabasePath("decision-timeout-invalid");
    const { request, store } = await waitingDecision(databasePath);
    await expect(store.resolveTimeout(request)).rejects.toThrow(/no timeout default/);
    const defaulted = await defaultedRequest(store, request);
    await expect(
      store.resolveTimeout(defaulted, new Date("2026-08-22T00:00:00.000Z")),
    ).rejects.toThrow(/not eligible/);
    store.close();
  });

  it("requires the current run owner for timeout policy", async () => {
    const databasePath = await makeStateDatabasePath("decision-timeout-owner");
    const { request, store } = await waitingDecision(databasePath);
    const defaulted = await defaultedRequest(store, request);
    await expect(
      store.resolveTimeout(defaulted, new Date("2026-08-23T00:00:00.000Z")),
    ).rejects.toThrow(/current run owner/);
    store.close();
  });

  it("resolves a defaulted timeout as acceptance and never expiry cancellation", async () => {
    const databasePath = await makeStateDatabasePath("decision-timeout");
    const { result, request, store } = await waitingDecision(databasePath);
    const defaulted = await defaultedRequest(store, request);
    const state = new StateDatabase({ filePath: databasePath });
    const mutations = new StateMutationStore(state);
    const resourceId = resourceIdFor("run", result.runId);
    const revision = state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(resourceId) as { revision: number };
    const claim = mutations.claim({
      resourceId,
      ownerType: "session",
      ownerId: "session-owner",
      expectedRevision: revision.revision,
      leaseMs: 60_000,
      now: Date.parse("2026-08-23T00:00:00.000Z"),
    });
    if (claim === undefined) throw new Error("run claim missing");
    const ownerStore = new HumanDecisionStore(databasePath, {
      authorityProvider: () => ({
        actor: { type: "session", id: claim.ownerId },
        ownerType: claim.ownerType,
        ownerId: claim.ownerId,
        token: claim.token,
        generation: claim.generation,
      }),
    });
    const accepted = await ownerStore.resolveTimeout(
      defaulted,
      new Date("2026-08-23T00:00:01.000Z"),
    );
    expect(accepted.decision.provenance).toBe("timeout");
    await expect(ownerStore.cancel(defaulted, "expired")).rejects.toThrow(/timeout policy/);
    ownerStore.close();
    store.close();
    state.close();
  });

  it("records and adopts one continuation after acceptance", async () => {
    const databasePath = await makeStateDatabasePath("decision-continuation");
    const { request, store } = await waitingDecision(databasePath);
    const accepted = await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "operator", eventId: "continue" },
      idempotencyKey: "continue",
    });
    const child = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(echoWorkflow, {}, { runId: "continuation-run" });
    const record = {
      schema: "pi-workflows.human-decision-continuation.v1" as const,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      provenance: accepted.decision.provenance,
      parentRunId: request.runId,
      runId: child.runId,
      createdAt: accepted.decision.acceptedAt,
    };
    expect(await store.recordContinuation(request.decisionId, record)).toBe("created");
    expect(await store.recordContinuation(request.decisionId, record)).toBe("adopted");
    expect(await store.readContinuation(request.decisionId)).toEqual(record);
    expect(await store.readContinuation("missing")).toBeNull();
    await expect(
      store.recordContinuation(request.decisionId, {
        ...record,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/continuation conflicts/);
    store.close();
  });

  it("marks deterministic decision effects as applied", async () => {
    const databasePath = await makeStateDatabasePath("decision-effects");
    const { request, store } = await waitingDecision(databasePath);
    await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "operator", eventId: "effect" },
      idempotencyKey: "effect",
    });
    store.markEffectApplied(request.decisionId, "decision.continue");
    store.markEffectApplied(request.decisionId, "decision.settle_presentations");
    expect(
      store.state.connection
        .prepare(
          `SELECT count(*) AS count FROM effects e
           JOIN human_decisions d ON d.resource_id = e.source_resource_id
           WHERE d.decision_id = ? AND e.status = 'applied'`,
        )
        .get(request.decisionId),
    ).toEqual({ count: 2 });
    store.close();
  });

  it("stores delivery and settlement state in the canonical database", async () => {
    const databasePath = await makeStateDatabasePath("decision-channel");
    const { request, store } = await waitingDecision(databasePath);
    const createdAt = "2026-08-23T00:00:00.000Z";
    await store.recordDelivery(request, "telegram-main", {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId: "delivery-1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      presentationDigest: request.presentationDigest,
      channel: "telegram-main",
      phase: "complete",
      state: "confirmed",
      createdAt,
      finishedAt: createdAt,
    });
    await store.recordSettlement(request.decisionId, "telegram-main", {
      schema: "pi-workflows.human-decision-settlement.v1",
      attemptId: "settlement-1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      channel: "telegram-main",
      state: "confirmed",
      createdAt,
      finishedAt: createdAt,
    });
    expect(await store.listDeliveries(request.decisionId, "telegram-main")).toHaveLength(1);
    expect(
      await store.recordDelivery(request, "telegram-main", {
        schema: "pi-workflows.human-decision-delivery.v1",
        attemptId: "delivery-1",
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        presentationDigest: request.presentationDigest,
        channel: "telegram-main",
        phase: "complete",
        state: "confirmed",
        createdAt,
        finishedAt: createdAt,
      }),
    ).toBe("adopted");
    expect(await store.listSettlements(request.decisionId, "telegram-main")).toHaveLength(1);
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM channel_messages").get(),
    ).toEqual({ count: 2 });
    store.close();
  });
});
