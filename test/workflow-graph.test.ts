import { describe, expect, it } from "vitest";
import { compute } from "../src/workflows/definition.js";
import {
  resolveNext,
  resolveNextForOutcome,
  validateWorkflowDefinition,
} from "../src/workflows/graph.js";
import type { WorkflowDefinition, WorkflowEdge } from "../src/workflows/types.js";

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "graph-fixture",
    startAt: "start",
    nodes: { start: compute({ run: () => null }) },
    edges: [],
    ...overrides,
  };
}

describe("workflow graph defensive paths", () => {
  it("rejects missing, unreachable, unknown, and duplicate graph nodes", () => {
    expect(() => validateWorkflowDefinition(workflow({ startAt: "missing" }))).toThrow(
      "Workflow start node is missing",
    );
    expect(() =>
      validateWorkflowDefinition(
        workflow({
          nodes: {
            start: compute({ run: () => null }),
            unreachable: compute({ run: () => null }),
          },
        }),
      ),
    ).toThrow("Workflow has unreachable nodes: unreachable");
    expect(() =>
      validateWorkflowDefinition(workflow({ edges: [{ from: "missing", to: "start" }] })),
    ).toThrow("Workflow edge references unknown from-node");
    expect(() =>
      validateWorkflowDefinition(
        workflow({
          nodes: {
            start: compute({ run: () => null }),
            next: compute({ run: () => null }),
          },
          edges: [
            { from: "start", to: "next" },
            { from: "start", to: "next" },
          ],
        }),
      ),
    ).toThrow("Workflow node must not declare multiple outgoing edges");
  });

  it("rejects invalid switch values, paths, and missing cases", () => {
    const edge = (on: string, cases: Record<string, string>): WorkflowEdge[] => [
      { from: "start", switch: { on, cases } },
    ];
    expect(() => resolveNext(edge("$.route", { ok: "done" }), "start", "not-an-object")).toThrow(
      "Workflow switch value must be scalar",
    );
    expect(() =>
      resolveNext(edge("$.route", { ok: "done" }), "start", { route: "missing" }),
    ).toThrow("No workflow switch case");
    expect(resolveNext(edge("$output.route", { ok: "done" }), "start", { route: "ok" })).toBe(
      "done",
    );
    expect(() => resolveNext(edge("route", { ok: "done" }), "start", { route: "ok" })).toThrow(
      "Unsupported JSON path",
    );
    expect(() =>
      resolveNext(edge("$.nested.route", { ok: "done" }), "start", { nested: 1 }),
    ).toThrow("Workflow switch value must be scalar");
    expect(
      resolveNextForOutcome(edge("$.route", { ok: "done" }), "start", {
        outcome: "ok",
        output: null,
      } as never),
    ).toBeNull();
  });
});
