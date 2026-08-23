import { describe, expect, it } from "vitest";
import { ConversationStepExecutor, type PromptDelivery } from "../src/extension/executor.js";
import type { AgentStepRequest } from "../src/workflows/types.js";

function makeRequest(overrides: Partial<AgentStepRequest> = {}): AgentStepRequest {
  return {
    contract: {
      runId: "r1",
      workflowName: "w",
      nodeId: "step1",
      attemptId: "a1",
      completion: "submit",
      expectedOutput: `{ "x": 1 }`,
    },
    prompt: "Do the step",
    presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
    accept: async (output) => ({ ok: true, value: output }),
    ...overrides,
  };
}

function makeAssistantRequest(maxOutputChars?: number): AgentStepRequest {
  return makeRequest({
    contract: {
      runId: "r1",
      workflowName: "w",
      nodeId: "step1",
      attemptId: "a1",
      completion: "assistant",
      ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
    },
    prompt: "Reply normally",
  });
}

function assistantMessage(textParts: string[], stopReason = "stop") {
  return {
    role: "assistant",
    content: textParts.map((text) => ({ type: "text", text })),
    stopReason,
  };
}

function makeExecutor(options: { maxNudges?: number } = {}) {
  const sent: PromptDelivery[] = [];
  const executor = new ConversationStepExecutor({
    sendPrompt: (delivery) => sent.push(delivery),
    ...options,
  });
  return { executor, sent };
}

describe("ConversationStepExecutor", () => {
  it("delivers the prompt and resolves on an accepted submission", async () => {
    const { executor, sent } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    expect(sent).toEqual([
      {
        prompt: "Do the step",
        contract: {
          runId: "r1",
          workflowName: "w",
          nodeId: "step1",
          attemptId: "a1",
          completion: "submit",
          expectedOutput: `{ "x": 1 }`,
        },
        presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
        kind: "step",
        streaming: false,
      },
    ]);
    expect(executor.pendingStepId).toBe("step1");

    const result = await executor.submit("step1", "a1", { x: 1 });
    expect(result.accepted).toBe(true);
    await expect(stepPromise).resolves.toEqual({ output: { x: 1 } });
    expect(executor.pendingStepId).toBeNull();
  });

  it("attaches the recorded conversation range to accepted submissions", async () => {
    const sent: PromptDelivery[] = [];
    const recorded: string[] = [];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => {
        sent.push(delivery);
        // The prompt entry and the assistant reply land after the mark.
        recorded.push("p1", "a1");
      },
      conversation: {
        mark: () => recorded.length,
        rangeSince: (mark) =>
          recorded.length > mark
            ? {
                firstEntryId: recorded[mark] as string,
                lastEntryId: recorded.at(-1) as string,
              }
            : undefined,
      },
    });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    await executor.submit("step1", "a1", { x: 1 });
    await expect(stepPromise).resolves.toEqual({
      output: { x: 1 },
      conversation: { firstEntryId: "p1", lastEntryId: "a1" },
    });
  });

  it("marks deliveries as streaming when the agent is mid-run", async () => {
    const { executor, sent } = makeExecutor();
    executor.setStreaming(true);
    void executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(sent[0]?.streaming).toBe(true);
    await executor.submit("step1", "a1", {});
  });

  it("rejects submissions when no step is pending", async () => {
    const { executor } = makeExecutor();
    const result = await executor.submit("step1", "a1", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/No workflow step/);
  });

  it("rejects submissions for the wrong step id", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    const result = await executor.submit("other", "a1", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/pending step is "step1"/);

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("rejects submissions with a stale attempt id", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    const stale = await executor.submit("step1", "a0", {});
    expect(stale.accepted).toBe(false);
    expect(stale.message).toMatch(/Stale attempt id "a0".*pending attempt is "a1"/);
    expect(executor.pendingStepId).toBe("step1");

    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("surfaces validation errors and keeps the step pending", async () => {
    const { executor } = makeExecutor();
    const request = makeRequest({
      accept: async (output) =>
        (output as { ok?: boolean }).ok === true
          ? { ok: true, value: output }
          : { ok: false, error: "bad shape" },
    });
    const stepPromise = executor.runAgentStep(request, new AbortController().signal);

    const rejected = await executor.submit("step1", "a1", { ok: false });
    expect(rejected.accepted).toBe(false);
    expect(rejected.message).toMatch(/bad shape/);
    expect(executor.pendingStepId).toBe("step1");

    const accepted = await executor.submit("step1", "a1", { ok: true });
    expect(accepted.accepted).toBe(true);
    await stepPromise;
  });

  it("rejects the step when the signal aborts", async () => {
    const { executor } = makeExecutor();
    const abort = new AbortController();
    const stepPromise = executor.runAgentStep(makeRequest(), abort.signal);
    abort.abort(new Error("timed out"));
    await expect(stepPromise).rejects.toThrow(/timed out/);
    expect(executor.pendingStepId).toBeNull();
  });

  it("reports an engine abort exactly once", async () => {
    const aborted: { attemptId: string; reason: unknown }[] = [];
    const abort = new AbortController();
    const executor = new ConversationStepExecutor({
      sendPrompt: () => undefined,
      onAbort: (contract, reason) => aborted.push({ attemptId: contract.attemptId, reason }),
    });
    const stepPromise = executor.runAgentStep(makeRequest(), abort.signal);

    abort.abort(new Error("timed out"));
    abort.abort(new Error("again"));

    await expect(stepPromise).rejects.toThrow(/timed out/);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.attemptId).toBe("a1");
    expect(aborted[0]?.reason).toEqual(new Error("timed out"));
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { executor, sent } = makeExecutor();
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    await expect(executor.runAgentStep(makeRequest(), abort.signal)).rejects.toThrow(/gone/);
    expect(sent).toEqual([]);
  });

  it("refuses concurrent steps", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    await expect(
      executor.runAgentStep(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(/already awaiting/);
    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("nudges on settle up to the budget, then fails the step", async () => {
    const { executor, sent } = makeExecutor({ maxNudges: 2 });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    expect(executor.handleAgentSettled()).toBe(true);
    expect(executor.handleAgentSettled()).toBe(true);
    expect(sent).toHaveLength(3);
    expect(sent[1]?.prompt).toMatch(/Reminder: workflow step "step1"/);
    expect(sent[1]?.prompt).toContain(`{ "x": 1 }`);
    expect(sent[1]).toMatchObject({
      kind: "reminder",
      contract: { nodeId: "step1", attemptId: "a1" },
      presentation: { runTitle: "Run one", statusDetail: "Doing the step" },
    });

    expect(executor.handleAgentSettled()).toBe(false);
    await expect(stepPromise).rejects.toThrow(/without submitting step "step1"/);
    expect(executor.pendingStepId).toBeNull();
  });

  it("re-establishes attempt ownership for nudge and resume deliveries", async () => {
    const owners: string[] = [];
    const deliveries: PromptDelivery[] = [];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => deliveries.push(delivery),
      conversation: {
        beginAttempt: (contract) => owners.push(contract.attemptId),
        mark: () => 0,
        rangeSince: () => undefined,
      },
    });
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(executor.handleAgentSettled()).toBe(true);
    executor.hold();
    expect(executor.handleAgentSettled()).toBe(false);
    executor.release();
    expect(owners).toEqual(["a1", "a1", "a1"]);
    expect(deliveries.map((delivery) => delivery.kind)).toEqual(["step", "reminder", "resume"]);
    expect(deliveries.every((delivery) => delivery.contract.attemptId === "a1")).toBe(true);
    await executor.submit("step1", "a1", {});
    await stepPromise;
  });

  it("uses one settled visible assistant response as exact string output", async () => {
    const sent: PromptDelivery[] = [];
    const recorded = ["before"];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => {
        sent.push(delivery);
        recorded.push("prompt", "assistant");
      },
      conversation: {
        mark: () => recorded.length,
        rangeSince: (mark) => ({
          firstEntryId: recorded[mark] as string,
          lastEntryId: recorded.at(-1) as string,
        }),
      },
    });
    const stepPromise = executor.runAgentStep(makeAssistantRequest(), new AbortController().signal);
    executor.handleMessageEnd(assistantMessage(["first", "second"]));
    expect(executor.handleAgentSettled()).toBe(false);

    await expect(stepPromise).resolves.toMatchObject({
      output: "first\nsecond",
      conversation: { firstEntryId: "prompt", lastEntryId: "assistant" },
      assistantMessage: {
        entryId: "assistant",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(sent).toHaveLength(1);
    expect(executor.pendingStepId).toBeNull();
  });

  it("adds no character limit unless the contract supplies one", async () => {
    const { executor } = makeExecutor();
    const text = "x".repeat(60_000);
    const stepPromise = executor.runAgentStep(makeAssistantRequest(), new AbortController().signal);
    executor.handleMessageEnd(assistantMessage([text]));
    executor.handleAgentSettled();
    await expect(stepPromise).resolves.toMatchObject({ output: text });
  });

  it("fails one over-limit visible response without retrying it", async () => {
    const { executor, sent } = makeExecutor();
    const stepPromise = executor.runAgentStep(
      makeAssistantRequest(3),
      new AbortController().signal,
    );
    const rejected = expect(stepPromise).rejects.toThrow(/above the configured limit of 3/);
    executor.handleMessageEnd(assistantMessage(["four"]));
    expect(executor.handleAgentSettled()).toBe(false);
    await rejected;
    expect(sent).toHaveLength(1);
  });

  it("rejects workflow submissions during assistant completion", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeAssistantRequest(), new AbortController().signal);
    await expect(executor.submit("step1", "a1", { ignored: true })).resolves.toEqual({
      accepted: false,
      message:
        "This step completes with a normal assistant response. Do not submit workflow output.",
    });
    executor.handleMessageEnd(assistantMessage(["visible"]));
    executor.handleAgentSettled();
    await expect(stepPromise).resolves.toMatchObject({ output: "visible" });
  });

  it("fails non-final assistant outcomes even when they contain text", async () => {
    for (const message of [
      assistantMessage([]),
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the file first." },
          { type: "toolCall", name: "read" },
        ],
        stopReason: "toolUse",
      },
      assistantMessage(["partial"], "pending"),
      assistantMessage(["partial"], "deferred"),
      assistantMessage(["partial"], "aborted"),
      { ...assistantMessage(["partial"], "error"), errorMessage: "provider failed" },
    ]) {
      const { executor } = makeExecutor();
      const stepPromise = executor.runAgentStep(
        makeAssistantRequest(),
        new AbortController().signal,
      );
      const rejected = expect(stepPromise).rejects.toThrow();
      executor.handleMessageEnd(message);
      executor.handleAgentSettled();
      await rejected;
    }
  });

  it("adopts a recovered visible response without sending another prompt", async () => {
    const sent: PromptDelivery[] = [];
    const executor = new ConversationStepExecutor({
      sendPrompt: (delivery) => sent.push(delivery),
      conversation: {
        recoverAssistant: () => ({
          output: "already visible",
          assistantMessage: { sha256: "a".repeat(64), recovered: true },
        }),
        mark: () => 0,
        rangeSince: () => undefined,
      },
    });
    await expect(
      executor.runAgentStep(makeAssistantRequest(), new AbortController().signal),
    ).resolves.toMatchObject({
      output: "already visible",
      assistantMessage: { recovered: true },
    });
    expect(sent).toEqual([]);
  });

  it("does nothing on settle without a pending step", () => {
    const { executor, sent } = makeExecutor();
    expect(executor.handleAgentSettled()).toBe(false);
    expect(sent).toEqual([]);
  });
});
