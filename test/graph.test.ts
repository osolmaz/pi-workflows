import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/render/ansi.js";
import { renderGraphLines } from "../src/render/graph-render.js";
import { expandEdges, layoutGraph } from "../src/render/graph.js";
import type { LoadedRunBundle } from "../src/workflows/store.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowStepRecord,
} from "../src/workflows/types.js";

const LOOP_SNAPSHOT: WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1",
  name: "autoimplement",
  startAt: "plan",
  nodes: {
    plan: { nodeType: "compute" },
    implement: { nodeType: "agent" },
    verify: { nodeType: "action" },
    review: { nodeType: "agent" },
    fix: { nodeType: "agent" },
    done: { nodeType: "compute" },
  },
  edges: [
    { from: "plan", to: "implement" },
    { from: "implement", to: "verify" },
    { from: "verify", to: "review" },
    { from: "review", switch: { on: "$.route", cases: { clean: "done", issues_found: "fix" } } },
    { from: "fix", to: "verify" },
  ],
};

const BRANCH_SNAPSHOT: WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1",
  name: "branchy",
  startAt: "a",
  nodes: {
    a: { nodeType: "agent" },
    b: { nodeType: "agent" },
    c: { nodeType: "agent" },
    d: { nodeType: "agent" },
  },
  edges: [
    { from: "a", switch: { on: "$.route", cases: { left: "b", right: "d" } } },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ],
};

function makeStep(
  nodeId: string,
  index: number,
  outcome: "ok" | "failed" = "ok",
): WorkflowStepRecord {
  const startedAt = new Date(1_752_900_000_000 + index * 10_000);
  return {
    attemptId: `a${index}`,
    nodeId,
    nodeType: "agent",
    outcome,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(startedAt.getTime() + 8_000).toISOString(),
    promptText: null,
    output: { step: index },
  };
}

function makeBundle(
  snapshot: WorkflowDefinitionSnapshot,
  steps: WorkflowStepRecord[],
  overrides: Partial<WorkflowRunState> = {},
): LoadedRunBundle {
  const state: WorkflowRunState = {
    runId: "run-graph",
    workflowName: snapshot.name,
    startedAt: steps[0]?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps,
    ...overrides,
  };
  return {
    runDir: "/tmp/run-graph",
    manifest: {
      schema: "pi-workflows.run-bundle.v1",
      runId: state.runId,
      workflowName: state.workflowName,
      startedAt: state.startedAt,
      status: state.status,
      traceSchema: "pi-workflows.trace-event.v1",
      paths: { workflow: "workflow.json", state: "state.json", trace: "trace.ndjson" },
    },
    state,
    snapshot,
  };
}

describe("expandEdges", () => {
  it("expands switch edges into labelled edges per case", () => {
    const edges = expandEdges(LOOP_SNAPSHOT);
    const fromReview = edges.filter((edge) => edge.from === "review");
    expect(fromReview).toHaveLength(2);
    expect(fromReview.map((edge) => edge.label)).toEqual(["clean", "issues_found"]);
    expect(fromReview.map((edge) => edge.to)).toEqual(["done", "fix"]);
  });
});

describe("layoutGraph", () => {
  it("classifies loop edges as back edges", () => {
    const layout = layoutGraph(LOOP_SNAPSHOT);
    const backEdges = layout.edges.filter((edge) => edge.isBackEdge);
    expect(backEdges).toHaveLength(1);
    expect(backEdges[0]).toMatchObject({ from: "fix", to: "verify" });
  });

  it("assigns increasing ranks along the main path", () => {
    const layout = layoutGraph(LOOP_SNAPSHOT);
    const rank = (nodeId: string) => layout.rankOfNode.get(nodeId) ?? -1;
    expect(rank("plan")).toBe(0);
    expect(rank("implement")).toBe(1);
    expect(rank("verify")).toBe(2);
    expect(rank("review")).toBe(3);
    expect(rank("fix")).toBe(4);
    expect(rank("done")).toBe(4);
  });

  it("inserts virtual cells for edges spanning multiple ranks", () => {
    const layout = layoutGraph(BRANCH_SNAPSHOT);
    // a -> d spans from rank 0 to rank 3 (d is pushed below c), so the a->d
    // edge must pass through virtual cells in ranks 1 and 2.
    const virtualCells = layout.ranks.flat().filter((cell) => cell.kind === "virtual");
    expect(virtualCells.length).toBe(2);
    // Every segment connects adjacent ranks by construction.
    for (const segment of layout.segments) {
      expect(segment.rank).toBeGreaterThanOrEqual(0);
      expect(segment.rank).toBeLessThan(layout.ranks.length - 1);
    }
  });

  it("keeps switch labels only on the first segment of an edge", () => {
    const layout = layoutGraph(BRANCH_SNAPSHOT);
    const labelled = layout.segments.filter((segment) => segment.label !== undefined);
    expect(labelled.map((segment) => segment.label).toSorted()).toEqual(["left", "right"]);
  });
});

describe("renderGraphLines", () => {
  const loopSteps = ["plan", "implement", "verify", "review", "fix", "verify", "review"].map(
    (nodeId, index) => makeStep(nodeId, index),
  );

  it("renders nodes, taken branches, and loop gutters", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, loopSteps, {
      status: "running",
      currentNode: "review",
      currentNodeStartedAt: new Date().toISOString(),
    });
    const text = renderGraphLines(bundle, loopSteps.length - 1)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("✓ plan [compute]");
    expect(text).toContain("◐ review [agent] running");
    expect(text).toContain("×2"); // verify ran twice
    expect(text).toContain("issues_found");
    expect(text).toContain("clean");
    expect(text).toContain("◀"); // back-edge arrow into verify
    expect(text).toContain("· done [compute]"); // untouched branch stays queued
  });

  it("derives statuses as of the scrubbed step", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, loopSteps, { status: "completed" });
    // Scrub to step index 1 (implement): verify/review/fix must be queued.
    const text = renderGraphLines(bundle, 1).map(stripAnsi).join("\n");
    expect(text).toContain("✓ plan [compute]");
    expect(text).toContain("◐ implement [agent]");
    expect(text).toContain("· verify [action]");
    expect(text).toContain("· review [agent]");
  });

  it("marks failed steps", () => {
    const steps = [makeStep("plan", 0), makeStep("implement", 1, "failed")];
    const bundle = makeBundle(LOOP_SNAPSHOT, steps, { status: "failed", error: "boom" });
    const text = renderGraphLines(bundle, steps.length - 1)
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("✗ implement [agent]");
  });

  it("returns no lines without a definition snapshot", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, loopSteps);
    const withoutSnapshot = { ...bundle, snapshot: null };
    expect(renderGraphLines(withoutSnapshot, 0)).toEqual([]);
  });

  it("draws connected vertical edges between chained ranks", () => {
    const steps = [makeStep("plan", 0)];
    const bundle = makeBundle(LOOP_SNAPSHOT, steps, {
      status: "running",
      currentNode: "implement",
    });
    const lines = renderGraphLines(bundle, 0).map(stripAnsi);
    const planLine = lines.findIndex((line) => line.includes("plan"));
    const implementLine = lines.findIndex((line) => line.includes("implement"));
    expect(planLine).toBeGreaterThanOrEqual(0);
    expect(implementLine).toBeGreaterThan(planLine);
    for (let index = planLine + 1; index < implementLine - 1; index += 1) {
      expect(lines[index]).toMatch(/│/);
    }
    expect(lines[implementLine - 1]).toMatch(/▼/);
  });
});
