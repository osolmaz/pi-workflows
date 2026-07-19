import { describe, expect, it } from "vitest";
import { buildWidgetLines, displayNodeIds, nodeGlyph } from "../src/extension/widget.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import type { WorkflowNodeResult, WorkflowRunState } from "../src/workflows/types.js";

const workflow = defineWorkflow({
  name: "demo",
  startAt: "first",
  nodes: {
    first: compute({ run: () => 1 }),
    second: compute({ run: () => 2 }),
    third: compute({ run: () => 3 }),
  },
  edges: [
    { from: "first", to: "second" },
    { from: "second", to: "third" },
  ],
});
const snapshot = createDefinitionSnapshot(workflow);

function makeResult(nodeId: string, outcome: WorkflowNodeResult["outcome"]): WorkflowNodeResult {
  return {
    attemptId: "a",
    nodeId,
    nodeType: "compute",
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
  };
}

function makeState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "r1",
    workflowName: "demo",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
}

describe("displayNodeIds", () => {
  it("returns nodes in definition order", () => {
    expect(displayNodeIds(snapshot)).toEqual(["first", "second", "third"]);
  });
});

describe("nodeGlyph", () => {
  it("marks the current node as running", () => {
    expect(nodeGlyph(makeState({ currentNode: "second" }), "second")).toBe("◐");
  });

  it("marks finished, failed, waiting, and pending nodes", () => {
    const state = makeState({
      results: { first: makeResult("first", "ok"), second: makeResult("second", "failed") },
      waitingOn: "third",
    });
    state.results.third = makeResult("third", "ok");
    expect(nodeGlyph(state, "first")).toBe("✓");
    expect(nodeGlyph(state, "second")).toBe("✗");
    expect(nodeGlyph(state, "third")).toBe("⏸");
    expect(nodeGlyph(makeState(), "first")).toBe("·");
  });
});

describe("buildWidgetLines", () => {
  it("renders a header and the workflow graph", () => {
    const state = makeState({
      currentNode: "second",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      statusDetail: "verifying",
      results: { first: makeResult("first", "ok") },
      steps: [
        {
          attemptId: "a",
          nodeId: "first",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          promptText: null,
          output: 1,
        },
      ],
      runTitle: "demo run",
    });
    const lines = buildWidgetLines(state, snapshot);
    const joined = lines.join("\n");
    expect(lines[0]).toContain("workflow demo — demo run [running]");
    expect(joined).toContain("✓ first [compute]");
    expect(joined).toMatch(/◐ second \[compute\] running .* · verifying/);
    expect(joined).toContain("· third [compute]");
    // The graph body draws edges, not just a node strip.
    expect(joined).toContain("▼");
  });

  it("falls back to the compact strip for very tall graphs", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_v, i) => [`n${i}`, compute({ run: () => i })]),
    );
    const edges = Array.from({ length: 19 }, (_v, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const tall = createDefinitionSnapshot(
      defineWorkflow({ name: "tall", startAt: "n0", nodes, edges }),
    );
    const lines = buildWidgetLines(makeState({ workflowName: "tall" }), tall);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("· n0");
    expect(lines[1]).toContain("· n19");
  });

  it("shows errors and waiting checkpoints", () => {
    const failed = buildWidgetLines(
      makeState({ status: "failed", error: "x".repeat(200) }),
      snapshot,
    );
    expect(failed.at(-1)).toMatch(/error: x+…$/);

    const waiting = buildWidgetLines(
      makeState({ status: "waiting", waitingOn: "third" }),
      snapshot,
    );
    expect(waiting.at(-1)).toContain("waiting on checkpoint: third");
  });

  it("sanitizes titles, status details, and errors", () => {
    const lines = buildWidgetLines(
      makeState({
        runTitle: "evil\u001b[2J\ntitle",
        currentNode: "second",
        currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
        statusDetail: "phase\tone\u0007",
        error: "boom\nline2",
        status: "failed",
      }),
      snapshot,
    );
    const joined = lines.join("|");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("\u0007");
    expect(joined).not.toContain("\n");
    expect(lines[0]).toContain("evil title");
    expect(joined).toContain("phase one");
    expect(joined).toContain("error: boom line2");
  });
});
