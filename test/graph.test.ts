import { describe, expect, it } from "vitest";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import {
  resolveNext,
  resolveNextForOutcome,
  validateWorkflowDefinition,
} from "../src/workflows/graph.js";
import type { WorkflowEdge, WorkflowNodeResult } from "../src/workflows/types.js";

function makeResult(overrides: Partial<WorkflowNodeResult> = {}): WorkflowNodeResult {
  return {
    attemptId: "a1",
    nodeId: "n1",
    nodeType: "agent",
    outcome: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    ...overrides,
  };
}

const workflowBase = {
  name: "t",
  startAt: "a",
  nodes: {
    a: compute({ run: () => 1 }),
    b: compute({ run: () => 2 }),
  },
};

describe("validateWorkflowDefinition", () => {
  it("accepts a valid graph", () => {
    const workflow = defineWorkflow({ ...workflowBase, edges: [{ from: "a", to: "b" }] });
    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
  });

  it("rejects a missing start node", () => {
    const workflow = defineWorkflow({ ...workflowBase, edges: [] });
    expect(() => validateWorkflowDefinition({ ...workflow, startAt: "zzz" })).toThrow(/start node/);
  });

  it("rejects unknown edge targets", () => {
    const workflow = defineWorkflow({ ...workflowBase, edges: [{ from: "a", to: "zzz" }] });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/unknown to-node/);
  });

  it("rejects unknown edge sources", () => {
    const workflow = defineWorkflow({ ...workflowBase, edges: [{ from: "zzz", to: "a" }] });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/unknown from-node/);
  });

  it("rejects multiple outgoing edges from one node", () => {
    const workflow = defineWorkflow({
      ...workflowBase,
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/multiple outgoing edges/);
  });

  it("rejects switch cases pointing at unknown nodes", () => {
    const workflow = defineWorkflow({
      ...workflowBase,
      edges: [{ from: "a", switch: { on: "$.route", cases: { x: "zzz" } } }],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/unknown to-node/);
  });

  it("rejects agent nodes without a prompt", () => {
    expect(() => agent({} as never)).toThrow(/prompt/);
  });
});

describe("resolveNext", () => {
  const switchEdge: WorkflowEdge = {
    from: "a",
    switch: { on: "$.route", cases: { yes: "b", no: "c" } },
  };

  it("returns null when there is no outgoing edge", () => {
    expect(resolveNext([], "a", {})).toBeNull();
  });

  it("follows plain edges", () => {
    expect(resolveNext([{ from: "a", to: "b" }], "a", {})).toBe("b");
  });

  it("routes switch edges on output paths", () => {
    expect(resolveNext([switchEdge], "a", { route: "yes" })).toBe("b");
    expect(resolveNext([switchEdge], "a", { route: "no" })).toBe("c");
  });

  it("supports $output. prefixed paths", () => {
    const edge: WorkflowEdge = {
      from: "a",
      switch: { on: "$output.deep.route", cases: { "1": "b" } },
    };
    expect(resolveNext([edge], "a", { deep: { route: 1 } })).toBe("b");
  });

  it("supports $result. prefixed paths", () => {
    const edge: WorkflowEdge = { from: "a", switch: { on: "$result.outcome", cases: { ok: "b" } } };
    expect(resolveNext([edge], "a", {}, makeResult())).toBe("b");
  });

  it("throws on non-scalar switch values", () => {
    expect(() => resolveNext([switchEdge], "a", { route: { nested: true } })).toThrow(/scalar/);
  });

  it("throws when no case matches", () => {
    expect(() => resolveNext([switchEdge], "a", { route: "maybe" })).toThrow(
      /No workflow switch case/,
    );
  });

  it("rejects unsupported JSON paths", () => {
    const edge: WorkflowEdge = { from: "a", switch: { on: "route", cases: { yes: "b" } } };
    expect(() => resolveNext([edge], "a", { route: "yes" })).toThrow(/Unsupported JSON path/);
  });
});

describe("resolveNextForOutcome", () => {
  it("routes failures through $result. switch edges", () => {
    const edge: WorkflowEdge = {
      from: "a",
      switch: { on: "$result.outcome", cases: { failed: "b", ok: "c" } },
    };
    expect(resolveNextForOutcome([edge], "a", makeResult({ outcome: "failed" }))).toBe("b");
  });

  it("returns null for plain edges and output switches", () => {
    expect(resolveNextForOutcome([{ from: "a", to: "b" }], "a", makeResult())).toBeNull();
    const outputEdge: WorkflowEdge = { from: "a", switch: { on: "$.route", cases: { x: "b" } } };
    expect(resolveNextForOutcome([outputEdge], "a", makeResult())).toBeNull();
  });
});
