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
      expectedOutput: `{ "x": 1 }`,
    },
    prompt: "Do the step",
    accept: async (output) => ({ ok: true, value: output }),
    ...overrides,
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

    expect(sent).toEqual([{ prompt: "Do the step", streaming: false }]);
    expect(executor.pendingStepId).toBe("step1");

    const result = await executor.submit("step1", { x: 1 });
    expect(result.accepted).toBe(true);
    await expect(stepPromise).resolves.toEqual({ output: { x: 1 } });
    expect(executor.pendingStepId).toBeNull();
  });

  it("marks deliveries as streaming when the agent is mid-run", async () => {
    const { executor, sent } = makeExecutor();
    executor.setStreaming(true);
    void executor.runAgentStep(makeRequest(), new AbortController().signal);
    expect(sent[0]?.streaming).toBe(true);
    await executor.submit("step1", {});
  });

  it("rejects submissions when no step is pending", async () => {
    const { executor } = makeExecutor();
    const result = await executor.submit("step1", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/No workflow step/);
  });

  it("rejects submissions for the wrong step id", async () => {
    const { executor } = makeExecutor();
    const stepPromise = executor.runAgentStep(makeRequest(), new AbortController().signal);

    const result = await executor.submit("other", {});
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/pending step is "step1"/);

    await executor.submit("step1", {});
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

    const rejected = await executor.submit("step1", { ok: false });
    expect(rejected.accepted).toBe(false);
    expect(rejected.message).toMatch(/bad shape/);
    expect(executor.pendingStepId).toBe("step1");

    const accepted = await executor.submit("step1", { ok: true });
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
    await executor.submit("step1", {});
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

    expect(executor.handleAgentSettled()).toBe(false);
    await expect(stepPromise).rejects.toThrow(/without submitting step "step1"/);
    expect(executor.pendingStepId).toBeNull();
  });

  it("does nothing on settle without a pending step", () => {
    const { executor, sent } = makeExecutor();
    expect(executor.handleAgentSettled()).toBe(false);
    expect(sent).toEqual([]);
  });
});
