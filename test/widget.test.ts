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
  it("renders a header and node markers", () => {
    const state = makeState({
      currentNode: "second",
      statusDetail: "verifying",
      results: { first: makeResult("first", "ok") },
      runTitle: "demo run",
    });
    const lines = buildWidgetLines(state, snapshot);
    expect(lines[0]).toContain("workflow demo — demo run [running]");
    expect(lines[1]).toContain("✓ first");
    expect(lines[1]).toContain("◐ second (verifying)");
    expect(lines[1]).toContain("· third");
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
    expect(joined).toContain("(phase one)");
    expect(joined).toContain("error: boom line2");
  });
});
