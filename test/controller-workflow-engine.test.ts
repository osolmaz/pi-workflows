import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEngineScheduler } from "../src/controllers/workflow-engine-scheduler.js";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { RUN_STATE_SCHEMA, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowDefinition, WorkflowRunState } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

const workflow = defineWorkflow({
  name: "child",
  startAt: "work",
  nodes: { work: compute({ run: () => ({ ok: true }) }) },
  edges: [],
});

const waitingWorkflow = defineWorkflow({
  name: "waiting-child",
  startAt: "approval",
  nodes: { approval: checkpoint({ summary: "approve" }) },
  edges: [],
});

const failingWorkflow = defineWorkflow({
  name: "failing-child",
  startAt: "fail",
  nodes: {
    fail: compute({
      run: () => {
        throw new Error("child failed");
      },
    }),
  },
  edges: [],
});

describe("WorkflowEngineScheduler", () => {
  it("starts one immutable workflow attempt and reports completion", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async () => ({ workflow, workflowPath: "/tmp/child.workflow.ts" }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });
    const complete = vi.fn();
    const request = {
      requestId: "request-1",
      attempt: 1,
      workflow: "child",
      input: {},
    };
    const first = await scheduler.ensure(request, new AbortController().signal, complete);
    const second = await scheduler.ensure(
      {
        ...request,
        ...(first.runId !== undefined ? { runId: first.runId } : {}),
      },
      new AbortController().signal,
      complete,
    );
    expect(second).toEqual(first);
    await scheduler.waitForIdle();
    expect(complete).toHaveBeenCalledWith({ state: "succeeded", runId: first.runId });
    const terminal = await scheduler.ensure(
      {
        ...request,
        ...(first.runId !== undefined ? { runId: first.runId } : {}),
      },
      new AbortController().signal,
      complete,
    );
    expect(terminal).toEqual({ state: "succeeded", runId: first.runId });
  });

  it("reports waiting and failed child runs", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflows = new Map<string, WorkflowDefinition>([
      ["waiting-child", waitingWorkflow],
      ["failing-child", failingWorkflow],
    ]);
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async (name) => ({ workflow: workflows.get(name) as WorkflowDefinition }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });
    const completed: unknown[] = [];
    await scheduler.ensure(
      {
        requestId: "waiting",
        attempt: 1,
        workflow: "waiting-child",
        input: {},
        runId: "waiting-run",
      },
      new AbortController().signal,
      (result) => completed.push(result),
    );
    await scheduler.ensure(
      { requestId: "failed", attempt: 1, workflow: "failing-child", input: {} },
      new AbortController().signal,
      (result) => completed.push(result),
    );
    await scheduler.waitForIdle();
    expect(completed).toEqual(
      expect.arrayContaining([
        { state: "waiting", runId: "waiting-run" },
        expect.objectContaining({ state: "failed", error: "child failed" }),
      ]),
    );
  });

  it("recovers completion when a host callback throws", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async () => ({ workflow }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });
    await scheduler.ensure(
      { requestId: "callback", attempt: 1, workflow: "child", input: {} },
      new AbortController().signal,
      () => {
        throw new Error("store closed");
      },
    );
    await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
  });

  it("rejects scheduling after cancellation", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async () => ({ workflow }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      scheduler.ensure(
        { requestId: "cancelled", attempt: 1, workflow: "child", input: {} },
        abort.signal,
        () => {},
      ),
    ).rejects.toThrow("cancelled");
  });

  it("marks an abandoned run bundle as interrupted", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const state = runningState("abandoned-run");
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: { workflowName: workflow.name, input: {} },
    });
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async () => ({ workflow }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });

    const result = await scheduler.ensure(
      {
        requestId: "request-1",
        attempt: 1,
        workflow: "child",
        input: {},
        runId: "abandoned-run",
      },
      new AbortController().signal,
      () => {},
    );

    expect(result).toMatchObject({ state: "interrupted", runId: "abandoned-run" });
    expect((await import("../src/workflows/store.js")).readRunBundle).toBeDefined();
    const bundle = await (await import("../src/workflows/store.js")).readRunBundle(runDir);
    expect(bundle?.state).toMatchObject({
      status: "interrupted",
      error: "Workflow host stopped before the run finished",
    });
    expect(await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8")).toContain(
      '"type":"run_interrupted"',
    );
  });

  it("rejects unsafe and duplicate run ids", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), store });
    await expect(engine.run(workflow, {}, { runId: "../escape" })).rejects.toThrow(/Invalid/);
    await engine.run(workflow, {}, { runId: "fixed-run" });
    await expect(engine.run(workflow, {}, { runId: "fixed-run" })).rejects.toThrow();
    expect(path.basename(store.runDirFor("fixed-run"))).toBe("fixed-run");
  });
});

function runningState(runId: string): WorkflowRunState {
  const now = "2026-08-04T00:00:00.000Z";
  return {
    schema: RUN_STATE_SCHEMA,
    traceSeq: 0,
    runId,
    workflowName: workflow.name,
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  };
}
