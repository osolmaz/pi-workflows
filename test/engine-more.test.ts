import { describe, expect, it } from "vitest";
import { ansi } from "../src/viewer/ansi.js";
import { stripAnsi } from "../src/viewer/ansi.js";
import { renderRunListLines, statusLabel } from "../src/viewer/render.js";
import { action, checkpoint, compute, defineWorkflow, shell } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function makeEngine() {
  const outputRoot = await makeTempDir("pi-workflows-engine-more");
  return new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
}

describe("WorkflowEngine additional paths", () => {
  it("exposes its output root", async () => {
    const outputRoot = await makeTempDir("pi-workflows-root");
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
    expect(engine.outputRoot).toBe(outputRoot);
  });

  it("runs function action nodes and records receipts", async () => {
    const workflow = defineWorkflow({
      name: "fn-action",
      startAt: "act",
      nodes: { act: action({ run: ({ input }) => ({ echoed: input }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, { x: 1 });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ echoed: { x: 1 } });
    expect(state.steps[0]?.action).toEqual({ actionType: "function" });
  });

  it("runs shell actions without a parse function", async () => {
    const workflow = defineWorkflow({
      name: "raw-shell",
      startAt: "run_cmd",
      nodes: { run_cmd: shell({ exec: () => ({ command: "printf", args: ["%s", "raw"] }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ stdout: "raw", exitCode: 0 });
  });

  it("supports checkpoint nodes with a custom run function", async () => {
    const workflow = defineWorkflow({
      name: "custom-checkpoint",
      startAt: "hold",
      nodes: { hold: checkpoint({ run: () => ({ report: "ready for review" }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("waiting");
    expect(state.finalOutput).toEqual({ report: "ready for review" });
  });

  it("uses string titles verbatim and tolerates undefined title functions", async () => {
    const literal = defineWorkflow({
      name: "titled-literal",
      title: "fixed title",
      startAt: "noop",
      nodes: { noop: compute({ run: () => null }) },
      edges: [],
    });
    const { state: literalState } = await (await makeEngine()).run(literal, {});
    expect(literalState.runTitle).toBe("fixed title");

    const dynamic = defineWorkflow({
      name: "titled-undefined",
      title: () => undefined,
      startAt: "noop",
      nodes: { noop: compute({ run: () => null }) },
      edges: [],
    });
    const { state: dynamicState } = await (await makeEngine()).run(dynamic, {});
    expect(dynamicState.runTitle).toBeUndefined();
  });

  it("wraps non-Error throws in a failure message", async () => {
    const workflow = defineWorkflow({
      name: "string-throw",
      startAt: "boom",
      nodes: {
        boom: compute({
          run: () => {
            throw "string failure";
          },
        }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.error).toBe("string failure");
  });
});

describe("render status colors", () => {
  it("colors every run status", () => {
    for (const status of [
      "running",
      "waiting",
      "completed",
      "failed",
      "timed_out",
      "cancelled",
    ] as const) {
      expect(stripAnsi(statusLabel(status))).toBe(status);
    }
  });

  it("styles text with each ansi helper", () => {
    for (const style of [
      ansi.bold,
      ansi.dim,
      ansi.red,
      ansi.green,
      ansi.yellow,
      ansi.blue,
      ansi.magenta,
      ansi.cyan,
    ]) {
      expect(stripAnsi(style("x"))).toBe("x");
    }
  });

  it("scrolls long run lists around the selection", () => {
    const bundles = Array.from({ length: 30 }, (_ignored, index) => ({
      runDir: `/tmp/run-${index}`,
      manifest: {
        schema: "pi-workflows.run-bundle.v1" as const,
        runId: `run-${index}`,
        workflowName: "demo",
        startedAt: "2026-07-19T00:00:00.000Z",
        status: "completed" as const,
        traceSchema: "pi-workflows.trace-event.v1" as const,
        paths: { workflow: "workflow.json", state: "state.json", trace: "trace.ndjson" },
      },
      state: {
        runId: `run-${index}`,
        workflowName: "demo",
        runTitle: `title ${index}`,
        startedAt: "2026-07-19T00:00:00.000Z",
        finishedAt: "2026-07-19T00:00:10.000Z",
        updatedAt: "2026-07-19T00:00:10.000Z",
        status: "completed" as const,
        input: {},
        outputs: {},
        results: {},
        steps: [],
      },
      snapshot: null,
    }));
    const lines = renderRunListLines(bundles, 25, { width: 120, height: 10 }, new Date());
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("run-25");
    expect(text).not.toContain("run-0 ");
  });
});
