import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HumanDecisionStore,
  createHumanDecisionRequest,
  defineHumanChoices,
  choice,
  textInput,
} from "../src/workflows/human-decision.js";
import type {
  HumanDecisionDeliveryRecord,
  HumanDecisionSettlementRecord,
  HumanDecisionSubmission,
} from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function makeRequest() {
  return createHumanDecisionRequest({
    runId: "run-a",
    workflowName: "workflow-a",
    nodeId: "approve",
    attemptId: "attempt-a",
    contract: {
      audience: "operator",
      choices: defineHumanChoices({
        continue: choice({ label: "Continue" }),
        replan: choice({
          label: "Replan",
          input: textInput({ name: "instructions", prompt: "What should change?" }),
        }),
      }),
    },
    prompt: { title: "Approve", body: { plan: "a" } },
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

function submission(
  request: ReturnType<typeof makeRequest>,
  choiceId: "continue" | "replan",
  key: string,
): HumanDecisionSubmission {
  return {
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    choice: choiceId,
    ...(choiceId === "replan" ? { input: { instructions: "keep exact text  " } } : {}),
    source: { channel: "pi", actorId: "person-a", eventId: key },
    idempotencyKey: key,
  };
}

describe("HumanDecisionStore", () => {
  it("creates immutable requests and adopts identical retries", async () => {
    const runs = await makeTempDir("human-decision-store");
    const store = new HumanDecisionStore(runs);
    const request = makeRequest();
    expect(await store.createRequest(request)).toBe("created");
    expect(await store.createRequest(request)).toBe("adopted");
    expect(await store.readRequest(request.decisionId)).toEqual(request);
    const directory = store.decisionDir(request.decisionId);
    const stat = await fs.stat(path.join(directory, "request.json"));
    expect(stat.mode & 0o077).toBe(0);
    expect((await fs.readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("accepts one concurrent answer and rejects the conflicting answer", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-race"));
    const request = makeRequest();
    await store.createRequest(request);
    const results = await Promise.all([
      store.accept(request, submission(request, "continue", "event-a")),
      store.accept(request, submission(request, "replan", "event-b")),
    ]);
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    const accepted = await store.readAccepted(request.decisionId);
    expect(accepted?.response.choice).toBe(
      results.find((result) => result.status === "accepted")?.decision.response.choice,
    );
  });

  it("accepts a verified namespaced external channel ID", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-external-channel"));
    const request = makeRequest();
    const external = submission(request, "continue", "telegram-event");
    external.source = { channel: "telegram:approval", actorId: "100", eventId: "event" };
    expect((await store.accept(request, external)).status).toBe("accepted");
  });

  it("adopts identical idempotent retries and rejects key reuse", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-idempotency"));
    const request = makeRequest();
    await store.createRequest(request);
    const first = submission(request, "continue", "same-event");
    expect((await store.accept(request, first)).status).toBe("accepted");
    expect((await store.accept(request, first)).status).toBe("adopted");
    await expect(
      store.accept(request, {
        ...submission(request, "replan", "same-event"),
        source: first.source,
      }),
    ).rejects.toThrow(/idempotency key/);
  });

  it("rejects stale and expired submissions", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-stale"));
    const request = makeRequest();
    await expect(
      store.accept(request, { ...submission(request, "continue", "stale"), requestDigest: "bad" }),
    ).rejects.toThrow(/stale/);
    await expect(
      store.accept(
        { ...request, expiresAt: "2020-01-01T00:00:00.000Z" },
        submission({ ...request, expiresAt: "2020-01-01T00:00:00.000Z" }, "continue", "expired"),
      ),
    ).rejects.toThrow(/expired/);
  });

  it("cancels or expires a pending request and rejects later answers", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-cancel"));
    const request = makeRequest();
    await store.createRequest(request);
    expect(await store.cancel(request, "cancelled")).toBe("created");
    expect(await store.cancel(request, "cancelled")).toBe("adopted");
    await expect(store.accept(request, submission(request, "continue", "late"))).rejects.toThrow(
      /cancelled/,
    );
    await expect(store.cancel(request, "expired")).rejects.toThrow(/conflicts/);
  });

  it("recovers accepted state from the immutable resolution fence", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-resolution-recovery"));
    const request = makeRequest();
    const accepted = await store.accept(request, submission(request, "continue", "recover"));
    await fs.unlink(path.join(store.decisionDir(request.decisionId), "accepted.json"));
    expect(await store.readAccepted(request.decisionId)).toEqual(accepted.decision);
  });

  it("resolves concurrent answer and cancellation with one atomic winner", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-resolution-race"));
    const request = makeRequest();
    await store.createRequest(request);
    const outcomes = await Promise.allSettled([
      store.accept(request, submission(request, "continue", "race-answer")),
      store.cancel(request, "cancelled"),
    ]);
    const accepted = await store.readAccepted(request.decisionId);
    const cancelled = await store.readCancellation(request.decisionId);
    expect(Number(accepted !== null) + Number(cancelled !== null)).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("handles empty indexes and validates delivery and settlement paths", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-record-paths"));
    expect(await store.listRequests()).toEqual([]);
    const request = makeRequest();
    const delivery: HumanDecisionDeliveryRecord = {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId: "attempt-a",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      channel: "pi",
      state: "confirmed",
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    await expect(store.recordDelivery(request, "bad/channel", delivery)).rejects.toThrow(/channel/);
    await expect(
      store.recordDelivery(request, "pi", { ...delivery, attemptId: "bad/attempt" }),
    ).rejects.toThrow(/attempt/);
    expect(await store.listDeliveries(request.decisionId, "pi")).toEqual([]);
    const settlement: HumanDecisionSettlementRecord = {
      schema: "pi-workflows.human-decision-settlement.v1",
      attemptId: "bad/attempt",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      channel: "pi",
      state: "confirmed",
      createdAt: "2026-08-19T00:00:00.000Z",
      finishedAt: "2026-08-19T00:00:01.000Z",
    };
    await expect(store.recordSettlement(request.decisionId, "pi", settlement)).rejects.toThrow(
      /attempt/,
    );
  });

  it("rebuilds cancellation detail and refuses to cancel an accepted decision", async () => {
    const cancelledStore = new HumanDecisionStore(
      await makeTempDir("human-decision-cancel-recovery"),
    );
    const request = makeRequest();
    await cancelledStore.cancel(request, "cancelled");
    await fs.unlink(path.join(cancelledStore.decisionDir(request.decisionId), "cancelled.json"));
    expect(await cancelledStore.readCancellation(request.decisionId)).toMatchObject({
      reason: "cancelled",
    });

    const acceptedStore = new HumanDecisionStore(
      await makeTempDir("human-decision-cancel-accepted"),
    );
    await acceptedStore.accept(request, submission(request, "continue", "accepted"));
    await expect(acceptedStore.cancel(request, "cancelled")).rejects.toThrow(/cannot be cancelled/);
  });

  it("records one immutable continuation identity", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-continuation"));
    const request = makeRequest();
    const continuation = {
      schema: "pi-workflows.human-decision-continuation.v1" as const,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      parentRunId: request.runId,
      runId: "continuation-a",
      createdAt: "2026-08-19T00:01:00.000Z",
    };
    expect(await store.recordContinuation(request.decisionId, continuation)).toBe("created");
    expect(await store.recordContinuation(request.decisionId, continuation)).toBe("adopted");
    await expect(
      store.recordContinuation(request.decisionId, { ...continuation, runId: "other" }),
    ).rejects.toThrow(/conflicts/);
  });
});
