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
import { decisionPrompt, makeTempDir } from "./helpers.js";

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
    prompt: decisionPrompt({ plan: "a" }),
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
  it("rejects superseded human-decision state with reset guidance", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-old-state"));
    const decisionId = "decision-old";
    await fs.mkdir(store.decisionDir(decisionId), { recursive: true });
    await fs.writeFile(
      path.join(store.decisionDir(decisionId), "request.json"),
      `${JSON.stringify({ schema: "pi-workflows.human-decision-request.v2", decisionId })}\n`,
    );
    await expect(store.readRequest(decisionId)).rejects.toThrow(
      /incompatible alpha contract.*reset/,
    );
  });

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

  it("records v2 subject and presentation evidence on the accepted answer", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-v2-accepted"));
    const request = createHumanDecisionRequest({
      runId: "run-v2",
      workflowName: "workflow-v2",
      nodeId: "approve",
      attemptId: "attempt-v2",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: {
        title: "Approve",
        subject: { action: "implement" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Implement the approved change.",
          blocks: [],
        },
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    await store.createRequest(request);
    const accepted = await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "person", eventId: "event-v1" },
      idempotencyKey: "event-v1",
    });
    expect(accepted.decision).toMatchObject({
      schema: "pi-workflows.human-decision-accepted.v1",
      provenance: "human",
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: 1,
    });
    const resolution = JSON.parse(
      await fs.readFile(
        path.join(store.decisionDir(request.decisionId), "resolution.json"),
        "utf8",
      ),
    ) as { schema: string };
    expect(resolution.schema).toBe("pi-workflows.human-decision-resolution.v1");
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
    const accepted = await store.readResolved(request.decisionId);
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
    const expired = createHumanDecisionRequest({
      runId: "run-expired",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-expired",
      contract: { audience: request.audience, choices: request.choices },
      prompt: decisionPrompt({ plan: "a" }, "2020-01-01T00:00:00.000Z"),
      createdAt: "2019-12-31T00:00:00.000Z",
    });
    await expect(store.accept(expired, submission(expired, "continue", "expired"))).rejects.toThrow(
      /expired/,
    );
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
    expect(await store.readResolved(request.decisionId)).toEqual(accepted.decision);
  });

  it("resolves concurrent answer and cancellation with one atomic winner", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-resolution-race"));
    const request = makeRequest();
    await store.createRequest(request);
    const outcomes = await Promise.allSettled([
      store.accept(request, submission(request, "continue", "race-answer")),
      store.cancel(request, "cancelled"),
    ]);
    const accepted = await store.readResolved(request.decisionId);
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
      presentationDigest: request.presentationDigest,
      channel: "pi",
      phase: "complete",
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
    expect(await store.listSettlements(request.decisionId, "pi")).toEqual([]);
    const validSettlement = { ...settlement, attemptId: "attempt-a" };
    await store.recordSettlement(request.decisionId, "pi", validSettlement);
    expect(await store.listSettlements(request.decisionId, "pi")).toEqual([validSettlement]);
    await expect(store.listSettlements(request.decisionId, "bad/channel")).rejects.toThrow(
      /channel/,
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

  it("resolves one durable timeout response without a human actor", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-timeout"));
    const request = createHumanDecisionRequest({
      runId: "run-timeout",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-timeout",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: decisionPrompt({ plan: "a" }),
      timeout: { afterMs: 600_000, response: { choice: "continue" } },
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    await store.createRequest(request);
    await expect(
      store.resolveTimeout(request, new Date("2099-01-01T00:09:59.999Z")),
    ).rejects.toThrow(/not eligible/);
    const result = await store.resolveTimeout(request, new Date("2099-01-01T00:10:00.000Z"));
    expect(result.decision).toEqual(
      expect.objectContaining({
        provenance: "timeout",
        response: { choice: "continue" },
        acceptedAt: "2099-01-01T00:10:00.000Z",
      }),
    );
    expect(result.decision).not.toHaveProperty("source");
    expect(await store.readResolved(request.decisionId)).toEqual(result.decision);
  });

  it("lets one valid human or timeout resolution win", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-timeout-race"));
    const request = createHumanDecisionRequest({
      runId: "run-race",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-race",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: decisionPrompt(),
      timeout: { afterMs: 600_000, response: { choice: "continue" } },
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    await store.createRequest(request);
    const [human, timeout] = await Promise.all([
      store.accept(request, {
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        choice: "continue",
        source: { channel: "pi", actorId: "person", eventId: "race-human" },
        idempotencyKey: "race-human",
      }),
      store.resolveTimeout(request, new Date("2099-01-01T00:10:00.000Z")),
    ]);
    expect([human.status, timeout.status].filter((status) => status === "accepted")).toHaveLength(
      1,
    );
    expect(await store.readResolved(request.decisionId)).toEqual(
      human.status === "accepted" ? human.decision : timeout.decision,
    );
  });

  it("settles cancellation and a timeout default through one immutable winner", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-timeout-cancel"));
    const request = createHumanDecisionRequest({
      runId: "run-cancel-race",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-cancel-race",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: decisionPrompt(),
      timeout: { afterMs: 600_000, response: { choice: "continue" } },
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    await store.createRequest(request);
    await Promise.allSettled([
      store.cancel(request, "cancelled"),
      store.resolveTimeout(request, new Date("2099-01-01T00:10:00.000Z")),
    ]);
    const cancellation = await store.readCancellation(request.decisionId);
    const resolved = await store.readResolved(request.decisionId);
    expect([cancellation, resolved].filter((value) => value !== null)).toHaveLength(1);
    if (cancellation !== null) {
      expect(cancellation.reason).toBe("cancelled");
      await expect(
        store.resolveTimeout(request, new Date("2099-01-01T00:10:00.000Z")),
      ).rejects.toThrow(/cancelled/);
    } else {
      expect(resolved).toMatchObject({ provenance: "timeout" });
      await expect(store.cancel(request, "cancelled")).rejects.toThrow(/cannot be cancelled/);
    }
  });

  it("records one immutable continuation identity", async () => {
    const store = new HumanDecisionStore(await makeTempDir("human-decision-continuation"));
    const request = makeRequest();
    const continuation = {
      schema: "pi-workflows.human-decision-continuation.v1" as const,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      provenance: "human" as const,
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
