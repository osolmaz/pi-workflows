import { describe, expect, it } from "vitest";
import {
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
  textInput,
  validateHumanDecisionResponse,
  validateHumanDecisionSubmission,
} from "../src/workflows/human-decision.js";
import type { HumanDecisionPrompt, HumanDecisionRequest } from "../src/workflows/types.js";

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  replan: choice({
    label: "Replan",
    input: textInput({ name: "instructions", prompt: "What should change?" }),
  }),
});

function request(): HumanDecisionRequest {
  return {
    schema: "pi-workflows.human-decision-request.v1",
    decisionId: "decision-a",
    requestDigest: `sha256:${"a".repeat(64)}`,
    runId: "run-a",
    workflowName: "workflow-a",
    nodeId: "approve",
    attemptId: "attempt-a",
    audience: "operator",
    title: "Approve",
    body: { plan: "a" },
    choices,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("human decision authoring", () => {
  it("requires an explicit presentation for a new structured subject", () => {
    // @ts-expect-error structured subjects cannot use an implicit channel renderer
    const invalid: HumanDecisionPrompt = { title: "Approve", subject: { plan: "a" } };
    expect(invalid).toHaveProperty("subject");
  });

  it("stays a checkpoint and builds exhaustive choice routing", () => {
    const gate = humanDecision({
      audience: "operator",
      choices,
      request: () => ({ title: "Approve", body: {} }),
    });
    expect(gate.nodeType).toBe("checkpoint");
    expect(gate.humanDecision?.choices).toBe(choices);
    expect(
      humanDecisionEdge({
        from: "approve",
        choices,
        cases: { continue: "implement", replan: "revise" },
      }),
    ).toEqual({
      from: "approve",
      switch: { on: "$.choice", cases: { continue: "implement", replan: "revise" } },
    });
  });

  it("accepts a typed timeout response and binds it into the request", () => {
    const gate = humanDecision({
      audience: "operator",
      choices,
      request: () => ({ title: "Approve", body: {} }),
      onTimeout: { afterMs: 600_000, response: { choice: "continue" } },
    });
    expect(gate.humanDecision?.onTimeout).toEqual({
      afterMs: 600_000,
      response: { choice: "continue" },
    });
    expect(() =>
      humanDecision({
        audience: "operator",
        choices,
        request: () => ({ title: "Approve", body: {} }),
        onTimeout: { afterMs: 0, response: { choice: "continue" } },
      }),
    ).toThrow(/finite positive/);

    const timed = createHumanDecisionRequest({
      runId: "run-a",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-timeout",
      contract: { audience: "operator", choices },
      prompt: { title: "Approve", body: {} },
      timeout: { afterMs: 600_000, response: { choice: "continue" } },
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(timed).toMatchObject({
      createdAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2026-08-21T00:10:00.000Z",
      defaultResponse: { choice: "continue" },
    });
    expect(() =>
      createHumanDecisionRequest({
        runId: "run-a",
        workflowName: "workflow-a",
        nodeId: "approve",
        attemptId: "attempt-conflict",
        contract: { audience: "operator", choices },
        prompt: { title: "Approve", body: {}, expiresAt: "2026-08-21T00:20:00.000Z" },
        timeout: { afterMs: 600_000, response: { choice: "continue" } },
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toThrow(/cannot combine/);
  });

  it("rejects missing and extra runtime routes", () => {
    expect(() =>
      humanDecisionEdge({
        from: "approve",
        choices,
        // @ts-expect-error replan is required
        cases: { continue: "implement" },
      }),
    ).toThrow(/missing case.*replan/);
    expect(() =>
      humanDecisionEdge({
        from: "approve",
        choices,
        cases: {
          continue: "implement",
          replan: "revise",
          // @ts-expect-error other is not a choice
          other: "stop",
        },
      }),
    ).toThrow(/unknown case.*other/);
  });

  it("preserves exact text and validates choice input", () => {
    const exact = "  use the smaller API\nkeep this line  ";
    expect(
      validateHumanDecisionResponse(request(), {
        choice: "replan",
        input: { instructions: exact },
      }),
    ).toEqual({ choice: "replan", input: { instructions: exact } });
    expect(() =>
      validateHumanDecisionResponse(request(), {
        choice: "continue",
        input: { instructions: "not allowed" },
      }),
    ).toThrow(/does not accept input/);
    expect(() => validateHumanDecisionResponse(request(), { choice: "unknown" })).toThrow(
      /not available/,
    );
  });

  it("allows a dynamic named audience without exposing transport details", async () => {
    const gate = humanDecision({
      audience: async ({ input }) => (input as { audience: string }).audience,
      choices,
      request: () => ({ title: "Approve", body: {} }),
    });
    expect(typeof gate.humanDecision?.audience).toBe("function");
  });

  it("rejects invalid text and choice contracts", () => {
    expect(() => textInput({ name: "instructions", prompt: "Prompt", minLength: -1 })).toThrow(
      /minLength/,
    );
    expect(() => textInput({ name: "instructions", prompt: "Prompt", maxLength: 0 })).toThrow(
      /maxLength/,
    );
    expect(() =>
      textInput({ name: "instructions", prompt: "Prompt", minLength: 3, maxLength: 2 }),
    ).toThrow(/maxLength/);
    expect(() => defineHumanChoices({})).toThrow(/must not be empty/);
    expect(() => choice({ label: "" })).toThrow(/label/);
    expect(() =>
      choice({
        label: "Bad",
        input: { kind: "number", name: "value", prompt: "Prompt", minLength: 1, maxLength: 2 },
      } as never),
    ).toThrow(/kind/);
    expect(() =>
      choice({
        label: "Bad",
        input: { kind: "text", name: "bad/name", prompt: "Prompt", minLength: 1, maxLength: 2 },
      }),
    ).toThrow(/name/);
  });

  it("rejects invalid request metadata and expiry", () => {
    expect(() =>
      humanDecision({ audience: "bad/name", choices, request: () => ({ title: "A", body: {} }) }),
    ).toThrow(/audience/);
    expect(() => humanDecision({ audience: "operator", choices, request: null as never })).toThrow(
      /request/,
    );
    expect(() =>
      createHumanDecisionRequest({
        runId: "run-a",
        workflowName: "workflow-a",
        nodeId: "approve",
        attemptId: "attempt-a",
        contract: { audience: "operator", choices },
        prompt: { title: "Approve", body: 1n },
      }),
    ).toThrow(/JSON-serializable/);
    expect(() =>
      createHumanDecisionRequest({
        runId: "run-a",
        workflowName: "workflow-a",
        nodeId: "approve",
        attemptId: "attempt-a",
        contract: { audience: "operator", choices },
        prompt: { title: "Approve", body: {}, expiresAt: "invalid" },
      }),
    ).toThrow(/expiry/);
    expect(() =>
      createHumanDecisionRequest({
        runId: "run-a",
        workflowName: "workflow-a",
        nodeId: "approve",
        attemptId: "attempt-a",
        contract: { audience: "operator", choices },
        prompt: { title: "Approve", body: {}, expiresAt: "2026-01-01T00:00:00.000Z" },
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toThrow(/after creation/);
  });

  it("rejects malformed text answers and unverified source fields", () => {
    expect(() => validateHumanDecisionResponse(request(), { choice: "replan" })).toThrow(/input/);
    expect(() =>
      validateHumanDecisionResponse(request(), {
        choice: "replan",
        input: { other: "text" },
      }),
    ).toThrow(/only instructions/);
    expect(() =>
      validateHumanDecisionResponse(request(), {
        choice: "replan",
        input: { instructions: 3 },
      }),
    ).toThrow(/must be text/);
    expect(() =>
      validateHumanDecisionResponse(
        {
          ...request(),
          choices: {
            replan: {
              label: "Replan",
              input: {
                kind: "text",
                name: "instructions",
                prompt: "Prompt",
                minLength: 2,
                maxLength: 3,
              },
            },
          },
        },
        { choice: "replan", input: { instructions: "x" } },
      ),
    ).toThrow(/length/);
    const base = {
      decisionId: request().decisionId,
      requestDigest: request().requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
    };
    expect(() =>
      validateHumanDecisionSubmission(request(), {
        ...base,
        source: { ...base.source, channel: "bad/channel" },
      }),
    ).toThrow(/channel/);
    expect(() =>
      validateHumanDecisionSubmission(request(), {
        ...base,
        source: { ...base.source, actorId: "" },
      }),
    ).toThrow(/actor/);
    expect(() =>
      validateHumanDecisionSubmission(request(), { ...base, idempotencyKey: "" }),
    ).toThrow(/idempotency/);
  });

  it("rejects duplicate labels because Pi selections return labels", () => {
    expect(() =>
      defineHumanChoices({
        yes: choice({ label: "Same" }),
        no: choice({ label: "Same" }),
      }),
    ).toThrow(/label.*duplicated/);
  });
});
