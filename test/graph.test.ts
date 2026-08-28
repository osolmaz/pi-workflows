import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/render/ansi.js";
import { graphCardSize, renderGraphLines } from "../src/render/graph-render.js";
import { expandEdges, layoutGraph } from "../src/render/graph.js";
import type { LoadedWorkflowRun } from "../src/workflows/store.js";
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

const HUMAN_SNAPSHOT: WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1",
  name: "human-gates",
  startAt: "first",
  nodes: {
    first: {
      nodeType: "checkpoint",
      humanDecision: {
        audience: "operator",
        choices: { continue: { label: "Continue" }, stop: { label: "Stop" } },
      },
    },
    second: {
      nodeType: "checkpoint",
      humanDecision: {
        audience: "reviewer",
        choices: { continue: { label: "Continue" }, replan: { label: "Replan" } },
      },
    },
  },
  edges: [{ from: "first", to: "second" }],
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
    prompt: null,
    output: { step: index },
  };
}

function makeBundle(
  snapshot: WorkflowDefinitionSnapshot,
  steps: WorkflowStepRecord[],
  overrides: Partial<WorkflowRunState> = {},
): LoadedWorkflowRun {
  const state: WorkflowRunState = {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 1,
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
    runId: state.runId,
    state,
    snapshot,
    sessionBinding: null,
    sessionEntries: [],
    sessionEvents: [],
    sessionCapture: null,
    sessionIntegrity: { status: "unavailable", diagnostics: [] },
    sessionSegments: [],
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
  it("shows a second waiting human gate instead of an inherited receipt", () => {
    const steps = [makeStep("first", 0), makeStep("second", 1)];
    const bundle = makeBundle(HUMAN_SNAPSHOT, steps, {
      status: "waiting",
      waitingOn: "second",
      finalOutput: {
        schema: "pi-workflows.human-decision-request.v1",
        audience: "reviewer",
      },
      humanDecision: {
        schema: "pi-workflows.human-decision-receipt.v1",
        provenance: "human",
        decisionId: "decision-first",
        requestDigest: `sha256:${"a".repeat(64)}`,
        subjectDigest: `sha256:${"c".repeat(64)}`,
        presentationDigest: `sha256:${"d".repeat(64)}`,
        revision: 1,
        nodeId: "first",
        response: { choice: "continue" },
        acceptedAt: "2026-08-19T00:00:00.000Z",
        answerDigest: `sha256:${"b".repeat(64)}`,
      },
    });
    const text = renderGraphLines(bundle, steps.length - 1, new Date(), {
      nodeStyle: "box",
    })
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("human decision · reviewer");
    expect(text).toContain("human: Continue");
  });
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
    expect(text).toContain("◐ review [agent]");
    expect(text).toContain("2 attempts"); // verify ran twice
    expect(text).toContain("issues_found");
    expect(text).toContain("clean");
    // Six edges, six entry arrows: the loop edge enters verify from above
    // through the right-hand gutter, so verify receives two arrows.
    expect(text.match(/▼/g)).toHaveLength(6);
    expect(text).toContain("· done [compute]"); // untouched branch stays queued
  });

  it("derives statuses as of the scrubbed step", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, loopSteps, { status: "completed" });
    // Scrub to step index 1 (implement): verify/review/fix must be queued.
    const text = renderGraphLines(bundle, 1).map(stripAnsi).join("\n");
    expect(text).toContain("✓ plan [compute]");
    expect(text).toContain("◆ implement [agent]");
    expect(text).toContain("· verify [action]");
    expect(text).toContain("· review [agent]");
  });

  it("renders structured cards with centered headers and external endpoints", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, [], { status: "running" });
    const lines = renderGraphLines(bundle, -1, new Date(), { nodeStyle: "box" }).map(stripAnsi);
    const planRow = lines.findIndex((line) => line.includes("plan"));
    expect(planRow).toBeGreaterThan(0);
    expect(lines[planRow - 1]).toMatch(/┌─+┐/);
    expect(lines[planRow]).toMatch(/▶ │\s+plan\s+│/);
    expect(lines[planRow + 1]).toMatch(/├─+┤/);
    expect(lines[planRow + 2]).toContain("ƒ compute");
    expect(lines[planRow + 2]).toContain("· queued");
    expect(lines[planRow + 3]).toContain("↻ 0");
    expect(lines[planRow + 3]).toContain("◷ —");
    expect(lines.find((line) => /│\s+done\s+│ ■/.test(line))).toBeDefined();
    expect(lines.join("\n")).not.toContain("▶ start");
    expect(lines.join("\n")).not.toContain("■ end");
  });

  it("keeps each card's bounds stable across replay positions", () => {
    const bundle = makeBundle(LOOP_SNAPSHOT, loopSteps, { status: "completed" });
    const sizes = [
      graphCardSize(bundle, "review"),
      graphCardSize({ ...bundle, state: { ...bundle.state, currentNode: "review" } }, "review"),
      graphCardSize({ ...bundle, state: { ...bundle.state, status: "failed" } }, "review"),
    ];
    expect(sizes[1]).toEqual(sizes[0]);
    expect(sizes[2]).toEqual(sizes[0]);
  });

  it("bounds one long high-fan-out card without enlarging unrelated cards", () => {
    const cases = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [`branch_${index}`, `target_${index}`]),
    );
    const targets = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `target_${index}`,
        { nodeType: "compute" as const },
      ]),
    );
    const snapshot: WorkflowDefinitionSnapshot = {
      schema: "pi-workflows.definition-snapshot.v1",
      name: "bounded-cards",
      startAt: "ordinary",
      nodes: {
        ordinary: { nodeType: "compute" },
        "this.is.a.very.long.hierarchical.node.label.that.must.be.bounded": {
          nodeType: "compute",
        },
        decision: { nodeType: "compute" },
        ...targets,
      },
      edges: [
        {
          from: "ordinary",
          to: "this.is.a.very.long.hierarchical.node.label.that.must.be.bounded",
        },
        {
          from: "this.is.a.very.long.hierarchical.node.label.that.must.be.bounded",
          to: "decision",
        },
        { from: "decision", switch: { on: "$.route", cases } },
      ],
    };
    const bundle = makeBundle(snapshot, [], { status: "running" });
    expect(graphCardSize(bundle, "ordinary")).toEqual({ width: 24, height: 7 });
    expect(
      graphCardSize(bundle, "this.is.a.very.long.hierarchical.node.label.that.must.be.bounded"),
    ).toEqual({ width: 32, height: 7 });
    expect(graphCardSize(bundle, "decision")).toEqual({ width: 24, height: 10 });
    const text = renderGraphLines(bundle, -1, new Date(), { nodeStyle: "box" })
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("+12 branches");
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
