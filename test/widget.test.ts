import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  buildWidgetLines,
  buildWidgetView,
  displayNodeIds,
  nodeGlyph,
  type WidgetTheme,
} from "../src/extension/widget.js";
import { nodeTypeGlyph } from "../src/render/node-type.js";
import {
  action,
  agent,
  checkpoint,
  compute,
  defineWorkflow,
  notify,
  shell,
} from "../src/workflows/definition.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import { stripAnsi } from "../src/workflows/text.js";
import type {
  WorkflowNodeResult,
  WorkflowRunState,
  WorkflowStepRecord,
} from "../src/workflows/types.js";

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
const TEST_THEME: WidgetTheme = {
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  fg: (color, text) => {
    const codes = { accent: 36, success: 32, error: 31, warning: 33, dim: 2 } as const;
    const code = codes[color as keyof typeof codes] ?? 37;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
};

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

function makeResult(
  nodeId: string,
  outcome: WorkflowNodeResult["outcome"],
  overrides: Partial<WorkflowNodeResult> = {},
): WorkflowNodeResult {
  return {
    attemptId: `result-${nodeId}`,
    nodeId,
    nodeType: "compute",
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    ...overrides,
  };
}

function makeStep(
  nodeId: string,
  index: number,
  nodeType: WorkflowStepRecord["nodeType"] = "compute",
): WorkflowStepRecord {
  return {
    attemptId: `${nodeId}-${index}`,
    nodeId,
    nodeType,
    outcome: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    prompt: null,
    output: null,
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

describe("nodeTypeGlyph", () => {
  it("uses readable one-column symbols for every real node and action subtype", () => {
    const symbols = {
      agent: nodeTypeGlyph("agent"),
      compute: nodeTypeGlyph("compute"),
      notify: nodeTypeGlyph("notify"),
      shell: nodeTypeGlyph("action", "shell"),
      function: nodeTypeGlyph("action", "function"),
      checkpoint: nodeTypeGlyph("checkpoint"),
    };
    expect(symbols).toEqual({
      agent: "●",
      compute: "ƒ",
      notify: "!",
      shell: "$",
      function: "*",
      checkpoint: "◆",
    });
    expect(Object.values(symbols).every((symbol) => visibleWidth(symbol) === 1)).toBe(true);
  });
});

describe("buildWidgetLines", () => {
  it("shows optional progress, ETA, elapsed update age, and next-check time", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const state = makeState({
      currentNode: "second",
      updates: [
        {
          updateId: "u1",
          seq: 2,
          at: "2026-01-01T00:09:00.000Z",
          runId: "r1",
          nodeId: "work",
          attemptId: "a1",
          type: "progress",
          key: "overall",
          data: {
            schema: "pi-workflows.progress.v1",
            label: "Import",
            status: "running",
            completed: 40,
            total: 100,
            unit: "rows",
            sourceEstimatedFinishAt: "2026-01-01T00:30:00.000Z",
          },
        },
        {
          updateId: "u2",
          seq: 3,
          at: "2026-01-01T00:09:00.000Z",
          runId: "r1",
          nodeId: "schedule",
          attemptId: "a2",
          type: "monitor.schedule",
          key: "next-check",
          data: {
            schema: "pi-workflows.monitor-schedule.v1",
            lastCheckAt: "2026-01-01T00:09:00.000Z",
            nextCheckAt: "2026-01-01T00:39:00.000Z",
            everyMinutes: 30,
          },
        },
      ],
    });

    const lines = buildWidgetLines(state, snapshot, now).join("\n");
    expect(lines).toContain("Import  40/100 rows  source ETA 20m");
    expect(lines).toContain("Last update 1m ago  next check 29m");
    expect(lines.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("uses the compact one-line node list at wide widths", () => {
    const state = makeState({
      currentNode: "second",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      statusDetail: "verifying",
      results: { first: makeResult("first", "ok", { durationMs: 1_250 }) },
      steps: [makeStep("first", 1)],
      runTitle: "demo run",
    });
    const lines = buildWidgetLines(state, snapshot, new Date("2026-01-01T00:00:02.000Z"));
    const joined = stripAnsi(lines.join("\n"));
    expect(lines[0]).toContain("workflow demo — demo run [running]");
    expect(joined).toContain("✓ ƒ first · 1.3s");
    expect(joined).toContain("◐ ƒ second · verifying · 2.0s");
    expect(joined).toContain("· ƒ third");
    expect(joined).not.toMatch(/[┏┌┃]/u);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("uses the Pi theme to emphasize status without removing glyphs", () => {
    const state = makeState({
      currentNode: "second",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      results: {
        first: makeResult("first", "ok"),
        third: makeResult("third", "failed", { error: "exit 1" }),
      },
      steps: [makeStep("first", 1), makeStep("third", 1)],
    });
    const lines = buildWidgetView(
      state,
      snapshot,
      new Date("2026-01-01T00:00:02.000Z"),
      null,
      false,
      120,
      TEST_THEME,
    ).lines;
    const active = lines.find((line) => stripAnsi(line).includes("second")) ?? "";
    const completed = lines.find((line) => stripAnsi(line).includes("first")) ?? "";
    const failed = lines.find((line) => stripAnsi(line).includes("third")) ?? "";

    expect(active).toContain("\u001b[36m◐ ƒ ");
    expect(active).toContain("\u001b[1msecond\u001b[22m");
    const heldLines = buildWidgetView(
      state,
      snapshot,
      undefined,
      null,
      true,
      120,
      TEST_THEME,
    ).lines;
    const held = heldLines.find((line) => stripAnsi(line).includes("second")) ?? "";
    expect(held).toContain("\u001b[33m◐ ƒ ");
    expect(held).toContain("\u001b[1msecond\u001b[22m");
    expect(completed).toContain("\u001b[32m✓\u001b[0m");
    expect(completed).toContain("\u001b[2mƒ\u001b[0m");
    expect(failed).toContain("\u001b[31m✗\u001b[0m");
    expect(failed).toContain("\u001b[31mexit 1\u001b[0m");
    expect(stripAnsi(lines.join("\n"))).toContain("◐ ƒ second");

    const pendingLines = buildWidgetView(
      makeState({ currentNode: "first" }),
      snapshot,
      undefined,
      null,
      false,
      120,
      TEST_THEME,
    ).lines;
    const pending = pendingLines.find((line) => stripAnsi(line).includes("second")) ?? "";
    expect(pending).toContain("\u001b[2m· ƒ second\u001b[0m");

    const waitingLines = buildWidgetView(
      makeState({
        status: "waiting",
        waitingOn: "third",
        results: { third: makeResult("third", "ok") },
      }),
      snapshot,
      undefined,
      null,
      false,
      120,
      TEST_THEME,
    ).lines;
    const waiting = waitingLines.find((line) => stripAnsi(line).includes("third")) ?? "";
    expect(waiting).toContain("\u001b[33m⏸ ƒ ");
    expect(waiting).toContain("\u001b[1mthird\u001b[22m");
  });

  it("shows the real node types without the unsupported glyphs", () => {
    const typed = createDefinitionSnapshot(
      defineWorkflow({
        name: "typed",
        startAt: "ask",
        nodes: {
          ask: agent({ prompt: () => "check" }),
          shape: compute({ run: () => ({}) }),
          tell: notify({ message: () => "done" }),
          run_shell: shell({ exec: () => ({ command: "true" }) }),
          run_function: action({ run: () => ({}) }),
          approve: checkpoint({ summary: "human approval" }),
        },
        edges: [
          { from: "ask", to: "shape" },
          { from: "shape", to: "tell" },
          { from: "tell", to: "run_shell" },
          { from: "run_shell", to: "run_function" },
          { from: "run_function", to: "approve" },
        ],
      }),
    );
    const joined = stripAnsi(
      buildWidgetView(
        makeState({ workflowName: "typed" }),
        typed,
        undefined,
        null,
        false,
        120,
      ).lines.join("\n"),
    );
    expect(joined).toContain("· ● ask");
    expect(joined).toContain("· ƒ shape");
    expect(joined).toContain("· ! tell");
    expect(joined).toContain("· $ run_shell");
    expect(joined).toContain("· * run_function");
    expect(joined).toContain("· ◆ approve");
    expect(joined).not.toContain("✉");
    expect(joined).not.toContain("⚙");
  });

  it("shows repeat counts, active elapsed time, latest durations, and errors", () => {
    const state = makeState({
      currentNode: "second",
      currentNodeStartedAt: "2026-01-01T00:00:00.000Z",
      statusDetail: "waiting for next check",
      results: {
        first: makeResult("first", "ok", { durationMs: 22_000 }),
        third: makeResult("third", "failed", { error: "exit 1\nbad", durationMs: 2_000 }),
      },
      steps: [
        makeStep("first", 1),
        makeStep("first", 2),
        makeStep("second", 1),
        makeStep("second", 2),
        makeStep("second", 3),
        makeStep("third", 1),
      ],
    });
    const joined = stripAnsi(
      buildWidgetView(
        state,
        snapshot,
        new Date("2026-01-01T00:12:00.000Z"),
        null,
        false,
        120,
      ).lines.join("\n"),
    );
    expect(joined).toContain("✓ ƒ first · ↻2 · 22s");
    expect(joined).toContain("◐ ƒ second · ↻4 · waiting for next check · 12m00s");
    expect(joined).toContain("✗ ƒ third · exit 1 bad");
    expect(joined).not.toContain("third · exit 1 bad · 2.0s");
  });

  it("bounds node errors before rendering an unbounded RPC-width line", () => {
    const error = `exit 1: ${"x".repeat(1_000_000)}`;
    const lines = buildWidgetView(
      makeState({ results: { third: makeResult("third", "failed", { error }) } }),
      snapshot,
    ).lines;
    const failedLine = stripAnsi(lines.find((line) => line.includes("third")) ?? "");
    expect(failedLine).toContain("exit 1:");
    expect(failedLine).toMatch(/…$/u);
    expect(failedLine.length).toBeLessThan(160);
  });

  it.each([120, 80, 43, 40, 20, 8, 2, 1])(
    "fits every line within a %i-column terminal",
    (width) => {
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
        null,
        false,
        width,
        TEST_THEME,
      );

      expect(view.lines.length).toBeLessThanOrEqual(10);
      expect(view.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width <= 2) expect(view.lines.some((line) => line.includes("◐"))).toBe(true);
    },
  );

  it("windows a long list around the active node and supports clamped scrolling", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_value, index) => [`n${index}`, compute({ run: () => index })]),
    );
    const edges = Array.from({ length: 19 }, (_value, index) => ({
      from: `n${index}`,
      to: `n${index + 1}`,
    }));
    const tall = createDefinitionSnapshot(
      defineWorkflow({ name: "tall", startAt: "n0", nodes, edges }),
    );
    const state = makeState({ workflowName: "tall", currentNode: "n10" });

    const followed = buildWidgetView(state, tall);
    expect(followed.maxScroll).toBeGreaterThan(0);
    expect(followed.scroll).toBeGreaterThan(0);
    expect(stripAnsi(followed.lines.join("\n"))).toContain("◐ ƒ n10");

    const top = buildWidgetView(state, tall, undefined, 0);
    expect(top.scroll).toBe(0);
    expect(stripAnsi(top.lines.join("\n"))).toContain("· ƒ n0");
    expect(stripAnsi(top.lines.join("\n"))).toMatch(/↓ \d+ more · shift\+↑\/↓ scroll/);

    const bottom = buildWidgetView(state, tall, undefined, 9_999);
    expect(bottom.scroll).toBeLessThanOrEqual(bottom.maxScroll);
    expect(stripAnsi(bottom.lines.join("\n"))).toContain("· ƒ n19");
    expect(stripAnsi(bottom.lines.join("\n"))).not.toMatch(/↓ \d+ more/);
    expect(bottom.lines.length).toBeLessThanOrEqual(10);
  });

  it("reports no scroll range when the node list fits", () => {
    const view = buildWidgetView(makeState(), snapshot);
    expect(view.maxScroll).toBe(0);
    expect(view.scroll).toBe(0);
  });

  it("shows waiting checkpoints and sanitizes external text", () => {
    const waiting = buildWidgetLines(
      makeState({
        runTitle: "evil\u001b[2J\ntitle",
        status: "waiting",
        waitingOn: "third",
        results: { third: makeResult("third", "ok") },
      }),
      snapshot,
    );
    const waitingText = waiting.join("|");
    expect(waitingText).not.toContain("\u001b[2J");
    expect(waitingText).not.toContain("\n");
    expect(waiting[0]).toContain("evil title");
    expect(stripAnsi(waitingText)).toContain("⏸ ƒ third · waiting");
    expect(stripAnsi(waiting.at(-1) ?? "")).toContain("waiting on checkpoint: third");

    const failed = buildWidgetLines(
      makeState({ status: "failed", error: `boom\n${"x".repeat(200)}` }),
      snapshot,
    );
    expect(failed.join("|")).not.toContain("\n");
    expect(stripAnsi(failed.at(-1) ?? "")).toMatch(/error: boom x+…$/);
  });
});
