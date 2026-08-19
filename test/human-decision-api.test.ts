import { describe, expect, it } from "vitest";
import {
  choice,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
  textInput,
  validateHumanDecisionResponse,
} from "../src/workflows/human-decision.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";

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

  it("rejects duplicate labels because Pi selections return labels", () => {
    expect(() =>
      defineHumanChoices({
        yes: choice({ label: "Same" }),
        no: choice({ label: "Same" }),
      }),
    ).toThrow(/label.*duplicated/);
  });
});
