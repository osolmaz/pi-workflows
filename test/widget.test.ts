import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  buildWidgetLines,
  buildWidgetView,
  displayNodeIds,
  nodeGlyph,
} from "../src/extension/widget.js";
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
const wideSnapshot = createDefinitionSnapshot(
  defineWorkflow({
    name: "wide-demo",
    startAt: "collect-the-current-observation-from-the-external-system",
    nodes: {
      "collect-the-current-observation-from-the-external-system": compute({ run: () => 1 }),
      "compare-the-observation-with-the-requested-stop-condition": compute({ run: () => 2 }),
      "report-the-result-to-the-origin-session": compute({ run: () => 3 }),
    },
    edges: [
      {
        from: "collect-the-current-observation-from-the-external-system",
        to: "compare-the-observation-with-the-requested-stop-condition",
      },
      {
        from: "compare-the-observation-with-the-requested-stop-condition",
        to: "report-the-result-to-the-origin-session",
      },
    ],
  }),
);

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
    schema: "pi-workflows.run-state.v1",
    traceSeq: 1,
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
  it("renders a header and the boxed graph windowed on the active node", () => {
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
          startedAt: "2026-01-01T00:00:01.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          prompt: null,
          output: 1,
        },
      ],
      runTitle: "demo run",
    });
    const lines = buildWidgetLines(state, snapshot, new Date("2026-01-01T00:00:02.000Z"));
    const joined = lines.join("\n");
    expect(lines[0]).toContain("workflow demo — demo run [running]");
    // The active node is boxed (heavy border) and centered in the window.
    expect(joined).toContain("ƒ compute");
    expect(joined).toContain("◐ running");
    expect(joined).toContain("second");
    expect(joined).toContain("↻ 1");
    expect(joined).toContain("◷ 2.0s");
    expect(joined).toContain("verifying");
    expect(joined).toContain("┃");
    expect(joined).toContain("┏");
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it.each([80, 43, 40, 20, 8, 1])("fits every line within a %i-column terminal", (width) => {
    const state = makeState({
      workflowName: "wide-demo",
      currentNode: "compare-the-observation-with-the-requested-stop-condition",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      statusDetail: "waiting for a long external operation to complete",
      runTitle: "a long workflow title that cannot fit in a narrow terminal",
    });
    const view = buildWidgetView(
      state,
      wideSnapshot,
      new Date("2026-01-01T00:00:02.000Z"),
      { graph: null, compact: null },
      false,
      width,
    );

    expect(view.lines.length).toBeLessThanOrEqual(10);
    expect(view.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (width === 43) expect(view.layout).toBe("compact");
  });

  it.each([2, 1])("keeps the active glyph visible at width %i", (width) => {
    const view = buildWidgetView(
      makeState({
        workflowName: "wide-demo",
        currentNode: "compare-the-observation-with-the-requested-stop-condition",
      }),
      wideSnapshot,
      undefined,
      { graph: null, compact: null },
      false,
      width,
    );
    expect(view.layout).toBe("compact");
    expect(view.lines.some((line) => line.includes("◐"))).toBe(true);
    expect(view.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("keeps the boxed graph when its displayed lines fit", () => {
    const view = buildWidgetView(
      makeState({ currentNode: "second" }),
      snapshot,
      undefined,
      { graph: null, compact: null },
      false,
      120,
    );
    expect(view.layout).toBe("graph");
    expect(view.lines.join("\n")).toContain("┏");
  });

  it("uses a compact list at narrow widths and keeps the active node visible", () => {
    const view = buildWidgetView(
      makeState({
        workflowName: "wide-demo",
        currentNode: "compare-the-observation-with-the-requested-stop-condition",
        statusDetail: "checking the latest result",
      }),
      wideSnapshot,
      new Date("2026-01-01T00:00:02.000Z"),
      { graph: null, compact: null },
      false,
      43,
    );
    expect(view.layout).toBe("compact");
    expect(view.lines.join("\n")).toContain("◐ compare-the-observation");
    expect(view.lines.every((line) => visibleWidth(line) <= 43)).toBe(true);
  });

  it("does not apply a graph scroll offset to the compact layout", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_value, index) => [
        `very-long-monitor-node-name-that-cannot-fit-${String(index)}`,
        compute({ run: () => index }),
      ]),
    );
    const edges = Array.from({ length: 19 }, (_value, index) => ({
      from: `very-long-monitor-node-name-that-cannot-fit-${String(index)}`,
      to: `very-long-monitor-node-name-that-cannot-fit-${String(index + 1)}`,
    }));
    const tallWide = createDefinitionSnapshot(
      defineWorkflow({
        name: "tall-wide",
        startAt: "very-long-monitor-node-name-that-cannot-fit-0",
        nodes,
        edges,
      }),
    );
    const state = makeState({
      workflowName: "tall-wide",
      currentNode: "very-long-monitor-node-name-that-cannot-fit-10",
    });
    const view = buildWidgetView(
      state,
      tallWide,
      undefined,
      { graph: 70, compact: null },
      false,
      43,
    );
    expect(view.layout).toBe("compact");
    expect(view.lines.join("\n")).toContain("very-long-monitor-node-name");
  });

  it("windows tall graphs around the active node within pi's line budget", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_v, i) => [`n${i}`, compute({ run: () => i })]),
    );
    const edges = Array.from({ length: 19 }, (_v, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const tall = createDefinitionSnapshot(
      defineWorkflow({ name: "tall", startAt: "n0", nodes, edges }),
    );
    const lines = buildWidgetLines(
      makeState({
        workflowName: "tall",
        currentNode: "n10",
        currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      }),
      tall,
    );
    // pi truncates widgets beyond 10 lines; we must stay within that.
    expect(lines.length).toBeLessThanOrEqual(10);
    const joined = lines.join("\n");
    // The window centers on the active node and marks hidden rows.
    expect(joined).toContain("ƒ compute");
    expect(joined).toContain("◐ running");
    expect(joined).toContain("n10");
    expect(joined).toMatch(/↑ \d+/);
    expect(joined).toMatch(/↓ \d+/);
    expect(joined).not.toContain("n0 ");
    expect(joined).not.toContain("n19");
  });

  it("shows the whole graph when it fits the budget", () => {
    const single = createDefinitionSnapshot(
      defineWorkflow({
        name: "single",
        startAt: "a",
        nodes: { a: compute({ run: () => 1 }) },
        edges: [],
      }),
    );
    const lines = buildWidgetLines(makeState({ workflowName: "single" }), single);
    expect(lines.join("\n")).not.toMatch(/more/);
    expect(lines.join("\n")).toContain("┌");
    expect(lines.length).toBeLessThanOrEqual(10);
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

  it("supports manual scrolling with clamped bounds", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_v, i) => [`n${i}`, compute({ run: () => i })]),
    );
    const edges = Array.from({ length: 19 }, (_v, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const tall = createDefinitionSnapshot(
      defineWorkflow({ name: "tall", startAt: "n0", nodes, edges }),
    );
    const state = makeState({
      workflowName: "tall",
      currentNode: "n10",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const now = new Date("2026-01-01T00:00:02.000Z");

    const followed = buildWidgetView(state, tall, now);
    expect(followed.maxScroll).toBeGreaterThan(0);
    expect(followed.scroll).toBeGreaterThan(0);
    expect(followed.lines.join("\n")).toContain("ƒ compute");
    expect(followed.lines.join("\n")).toContain("◐ running");
    expect(followed.lines.join("\n")).toContain("n10");

    const top = buildWidgetView(state, tall, now, { graph: 0, compact: null });
    expect(top.scroll).toBe(0);
    expect(top.lines.join("\n")).toContain("n0");
    expect(top.lines.join("\n")).not.toMatch(/↑ \d+ more/);
    expect(top.lines.join("\n")).toMatch(/↓ \d+ more · shift\+↑\/↓ scroll/);

    const bottom = buildWidgetView(state, tall, now, { graph: 9_999, compact: null });
    expect(bottom.scroll).toBeLessThanOrEqual(bottom.maxScroll);
    expect(bottom.lines.join("\n")).toContain("n19");
    expect(bottom.lines.join("\n")).not.toMatch(/↓ \d+ more/);
    expect(bottom.lines.length).toBeLessThanOrEqual(10);
  });

  it("reports no scroll range when the graph fits", () => {
    const single = createDefinitionSnapshot(
      defineWorkflow({
        name: "single",
        startAt: "a",
        nodes: { a: compute({ run: () => 1 }) },
        edges: [],
      }),
    );
    const view = buildWidgetView(makeState({ workflowName: "single" }), single);
    expect(view.maxScroll).toBe(0);
    expect(view.scroll).toBe(0);
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
