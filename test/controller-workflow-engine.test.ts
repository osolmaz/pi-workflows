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

  it.each([
    ["run_waiting", "waiting", { status: "waiting", waitingOn: "approval" }],
    ["run_failed", "failed", { status: "failed", error: "broken" }],
    ["run_timed_out", "timed_out", { status: "timed_out", error: "late" }],
    ["run_cancelled", "cancelled", { status: "cancelled" }],
    ["run_interrupted", "failed", { error: "host stopped" }],
  ] as const)("recovers a stale %s projection", async (type, expectedStatus, payload) => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const state = runningState(`stale-${expectedStatus}`);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: { workflowName: workflow.name, input: {} },
    });
    await fs.appendFile(
      path.join(runDir, "trace.ndjson"),
      `${JSON.stringify({
        seq: 2,
        at: "2026-08-04T00:00:01.000Z",
        scope: "run",
        type,
        runId: state.runId,
        payload,
      })}\n`,
      "utf8",
    );

    const recovered = await store.markRunInterrupted(state.runId);

    expect(recovered?.state.status).toBe(expectedStatus);
    expect(recovered?.state.traceSeq).toBe(2);
    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    expect(trace.trim().split("\n")).toHaveLength(2);
  });

  it("recovers a terminal trace event when its state projection is stale", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const state = runningState("completed-before-projection");
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: { workflowName: workflow.name, input: {} },
    });
    const completedAt = "2026-08-04T00:00:01.000Z";
    await fs.appendFile(
      path.join(runDir, "trace.ndjson"),
      `${JSON.stringify({
        seq: 2,
        at: completedAt,
        scope: "run",
        type: "run_completed",
        runId: state.runId,
        payload: { status: "completed", finalOutput: { ok: true } },
      })}\n`,
      "utf8",
    );
    const scheduler = new WorkflowEngineScheduler({
      store,
      resolveWorkflow: async () => ({ workflow }),
      createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
    });

    const result = await scheduler.ensure(
      {
        requestId: "request-completed",
        attempt: 1,
        workflow: "child",
        input: {},
        runId: state.runId,
      },
      new AbortController().signal,
      () => {},
    );

    expect(result).toMatchObject({ state: "succeeded", runId: state.runId });
    const bundle = await (await import("../src/workflows/store.js")).readRunBundle(runDir);
    expect(bundle?.state).toMatchObject({
      status: "completed",
      traceSeq: 2,
      finishedAt: completedAt,
      finalOutput: { ok: true },
    });
    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    expect(trace).not.toContain('"type":"run_interrupted"');
    expect(trace.trim().split("\n")).toHaveLength(2);
  });

  it("marks an abandoned bundle failed and recovers its interrupted attempt", async () => {
    const outputRoot = await makeTempDir("pi-controller-child-runs");
    const store = new WorkflowRunStore(outputRoot);
    const state = runningState("abandoned-run");
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: { workflowName: workflow.name, input: {} },
    });
    await fs.appendFile(
      path.join(runDir, "trace.ndjson"),
      `${JSON.stringify({
        seq: 2,
        at: "2026-08-04T00:00:00.500Z",
        scope: "run",
        type: "run_paused",
        runId: state.runId,
        payload: {},
      })}\n`,
      "utf8",
    );
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
      status: "failed",
      traceSeq: 3,
      error: "Workflow host stopped before the run finished",
    });
    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    expect(trace).toContain('"type":"run_interrupted"');
    expect(
      trace
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { seq: number }).seq),
    ).toEqual([1, 2, 3]);

    const recovered = await scheduler.ensure(
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
    expect(recovered).toMatchObject({ state: "interrupted", runId: "abandoned-run" });
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
