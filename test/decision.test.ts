import { describe, expect, it } from "vitest";
import { decision, decisionEdge } from "../src/workflows/decision.js";
import type { WorkflowNodeContext, WorkflowRunState } from "../src/workflows/types.js";

function makeContext(): WorkflowNodeContext {
  const state = {
    runId: "r",
    workflowName: "w",
    startedAt: "",
    updatedAt: "",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  } as WorkflowRunState;
  return { input: {}, outputs: {}, results: {}, state, signal: new AbortController().signal };
}

describe("decision", () => {
  const node = decision({ choices: ["y", "n"] as const, question: "Same? y/n" });

  it("builds an agent node with an expected output contract", () => {
    expect(node.nodeType).toBe("agent");
    expect(node.expectedOutput).toContain('"route"');
    expect(node.expectedOutput).toContain('"y" | "n"');
  });

  it("renders the question and choices in the prompt", async () => {
    const prompt = await node.prompt(makeContext());
    expect(prompt).toContain("Same? y/n");
    expect(prompt).toContain('"y" | "n"');
  });

  it("supports question functions", async () => {
    const dynamic = decision({ choices: ["a"] as const, question: () => "Dynamic?" });
    expect(await dynamic.prompt(makeContext())).toContain("Dynamic?");
  });

  it("accepts a valid choice", async () => {
    const output = await node.validate?.({ route: "y", reason: "match" }, makeContext());
    expect(output).toEqual({ route: "y", reason: "match" });
  });

  it("accepts JSON submitted as a string", async () => {
    const output = await node.validate?.(`{"route":"n","reason":"differs"}`, makeContext());
    expect(output).toEqual({ route: "n", reason: "differs" });
  });

  it("rejects invalid choices", async () => {
    await expect(async () => node.validate?.({ route: "maybe" }, makeContext())).rejects.toThrow(
      /invalid route/,
    );
  });

  it("rejects non-object outputs", async () => {
    await expect(async () => node.validate?.([1, 2], makeContext())).rejects.toThrow(/JSON object/);
    await expect(async () => node.validate?.(null, makeContext())).rejects.toThrow(/JSON object/);
  });

  it("supports custom fields", async () => {
    const custom = decision({ choices: ["bug"] as const, question: "q", field: "kind" });
    expect(await custom.validate?.({ kind: "bug" }, makeContext())).toEqual({ kind: "bug" });
  });

  it("rejects invalid field names", () => {
    expect(() => decision({ choices: ["a"] as const, question: "q", field: "bad-field" })).toThrow(
      /simple JSON key/,
    );
  });

  it("rejects empty and duplicate choices", () => {
    expect(() => decision({ choices: [] as unknown as readonly ["x"], question: "q" })).toThrow(
      /at least one/,
    );
    expect(() => decision({ choices: ["a", "a"] as const, question: "q" })).toThrow(/unique/);
  });
});

describe("decisionEdge", () => {
  it("builds a switch edge over the decision field", () => {
    const edge = decisionEdge({
      from: "d",
      choices: ["y", "n"] as const,
      cases: { y: "a", n: "b" },
    });
    expect(edge).toEqual({ from: "d", switch: { on: "$.route", cases: { y: "a", n: "b" } } });
  });

  it("uses custom fields in the path", () => {
    const edge = decisionEdge({
      from: "d",
      choices: ["bug"] as const,
      field: "kind",
      cases: { bug: "fix" },
    });
    expect(edge).toEqual({ from: "d", switch: { on: "$.kind", cases: { bug: "fix" } } });
  });

  it("rejects missing cases", () => {
    expect(() =>
      decisionEdge({
        from: "d",
        choices: ["y", "n"] as const,
        cases: { y: "a" } as Record<"y" | "n", string>,
      }),
    ).toThrow(/missing case/);
  });
});
