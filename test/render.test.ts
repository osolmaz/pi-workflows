import { describe, expect, it } from "vitest";
import { fitWidth, stripAnsi, visibleLength } from "../src/viewer/ansi.js";
import {
  formatDuration,
  renderRunDetailLines,
  renderRunListLines,
  runElapsedMs,
} from "../src/viewer/render.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import type { LoadedRunBundle } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";

const NOW = new Date("2026-07-19T00:01:00.000Z");

const workflow = defineWorkflow({
  name: "demo",
  startAt: "one",
  nodes: {
    one: compute({ run: () => 1 }),
    two: compute({ run: () => 2 }),
  },
  edges: [{ from: "one", to: "two" }],
});

function makeBundle(overrides: Partial<WorkflowRunState> = {}): LoadedRunBundle {
  const state: WorkflowRunState = {
    runId: "run-1",
    workflowName: "demo",
    startedAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:30.000Z",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
  return {
    runDir: "/tmp/run-1",
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
    snapshot: createDefinitionSnapshot(workflow),
  };
}

describe("formatDuration", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(2_500)).toBe("2.5s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(95_000)).toBe("1m35s");
  });
});

describe("runElapsedMs", () => {
  it("uses finishedAt when present, otherwise now", () => {
    const finished = makeBundle({ finishedAt: "2026-07-19T00:00:10.000Z" }).state;
    expect(runElapsedMs(finished, NOW)).toBe(10_000);
    expect(runElapsedMs(makeBundle().state, NOW)).toBe(60_000);
  });
});

describe("renderRunListLines", () => {
  const size = { width: 100, height: 20 };

  it("renders an empty message when there are no runs", () => {
    const lines = renderRunListLines([], 0, size, NOW).map(stripAnsi);
    expect(lines.at(-1)).toContain("No workflow runs found");
  });

  it("renders one line per run with a selection marker", () => {
    const bundles = [makeBundle(), makeBundle({ runId: "run-2", status: "completed" })];
    const lines = renderRunListLines(bundles, 1, size, NOW).map(stripAnsi);
    const runLines = lines.filter((line) => line.includes("run-"));
    expect(runLines).toHaveLength(2);
    expect(runLines[0]).toMatch(/^ {2}running/);
    expect(runLines[1]).toMatch(/^› completed/);
  });
});

describe("renderRunDetailLines", () => {
  const size = { width: 100, height: 50 };

  it("renders header, nodes, steps, and final output", () => {
    const bundle = makeBundle({
      status: "completed",
      finishedAt: "2026-07-19T00:00:45.000Z",
      finalOutput: { done: true },
      results: {
        one: {
          attemptId: "a",
          nodeId: "one",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          durationMs: 1000,
        },
      },
      steps: [
        {
          attemptId: "a",
          nodeId: "one",
          nodeType: "compute",
          outcome: "ok",
          startedAt: "2026-07-19T00:00:00.000Z",
          finishedAt: "2026-07-19T00:00:01.000Z",
          promptText: null,
          output: { value: 1 },
        },
      ],
    });
    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("workflow demo");
    expect(text).toContain("completed · run run-1 · elapsed 45s");
    expect(text).toContain("✓ one [compute] 1.0s");
    expect(text).toContain("· two [compute]");
    expect(text).toContain(`{"value":1}`);
    expect(text).toContain(`output {"done":true}`);
  });

  it("renders running node elapsed time and errors", () => {
    const bundle = makeBundle({
      currentNode: "two",
      currentNodeStartedAt: "2026-07-19T00:00:50.000Z",
      error: "exploded",
    });
    const text = renderRunDetailLines(bundle, size, NOW).map(stripAnsi).join("\n");
    expect(text).toContain("◐ two [compute] running 10s");
    expect(text).toContain("error: exploded");
  });

  it("clips to the viewport height", () => {
    const lines = renderRunDetailLines(makeBundle(), { width: 100, height: 4 }, NOW);
    expect(lines).toHaveLength(4);
  });
});

describe("ansi helpers", () => {
  it("strips ANSI and measures visible length", () => {
    const styled = "\u001b[32mgreen\u001b[0m";
    expect(stripAnsi(styled)).toBe("green");
    expect(visibleLength(styled)).toBe(5);
  });

  it("fits lines to a width", () => {
    expect(fitWidth("short", 10)).toBe("short");
    expect(stripAnsi(fitWidth("a".repeat(20), 10))).toBe(`${"a".repeat(9)}…`);
  });
});
