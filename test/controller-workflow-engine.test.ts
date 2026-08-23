import { describe, expect, it, vi } from "vitest";
import { WorkflowEngineScheduler } from "../src/controllers/workflow-engine-scheduler.js";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowDefinition } from "../src/workflows/types.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

const completedWorkflow = defineWorkflow({
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

function scheduler(store: WorkflowRunStore, workflows: Map<string, WorkflowDefinition>) {
  return new WorkflowEngineScheduler({
    store,
    resolveWorkflow: async (name) => ({ workflow: workflows.get(name) as WorkflowDefinition }),
    createEngine: () => new WorkflowEngine({ executor: new ScriptedExecutor(), store }),
  });
}

describe("WorkflowEngineScheduler SQLite", () => {
  it("starts one child run and adopts its terminal state", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-run"));
    const subject = scheduler(store, new Map([["child", completedWorkflow]]));
    const complete = vi.fn();
    const request = {
      requestId: "request-1",
      attempt: 1,
      workflow: "child",
      input: {},
      runId: "child-run",
    };

    expect(await subject.ensure(request, new AbortController().signal, complete)).toEqual({
      state: "running",
      runId: "child-run",
    });
    await subject.waitForIdle();
    expect(complete).toHaveBeenCalledWith({ state: "succeeded", runId: "child-run" });
    expect(await subject.ensure(request, new AbortController().signal, complete)).toEqual({
      state: "succeeded",
      runId: "child-run",
    });
    store.close();
  });

  it("reports waiting and failed child outcomes", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-outcomes"));
    const subject = scheduler(
      store,
      new Map<string, WorkflowDefinition>([
        ["waiting", waitingWorkflow],
        ["failed", failingWorkflow],
      ]),
    );
    const outcomes: unknown[] = [];
    await subject.ensure(
      { requestId: "waiting", attempt: 1, workflow: "waiting", input: {}, runId: "waiting-run" },
      new AbortController().signal,
      (value) => outcomes.push(value),
    );
    await subject.ensure(
      { requestId: "failed", attempt: 1, workflow: "failed", input: {}, runId: "failed-run" },
      new AbortController().signal,
      (value) => outcomes.push(value),
    );
    await subject.waitForIdle();
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { state: "waiting", runId: "waiting-run" },
        { state: "failed", runId: "failed-run", error: "child failed" },
      ]),
    );
    store.close();
  });

  it("returns pending when scheduling was aborted", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-abort"));
    const subject = scheduler(store, new Map([["child", completedWorkflow]]));
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(
      subject.ensure(
        { requestId: "request", attempt: 1, workflow: "child", input: {}, runId: "run" },
        abort.signal,
        () => {},
      ),
    ).rejects.toThrow("stop");
    store.close();
  });

  it("rejects unsafe and duplicate run ids", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-identities"));
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), store });
    await expect(engine.run(completedWorkflow, {}, { runId: "../escape" })).rejects.toThrow(
      /Invalid/,
    );
    await engine.run(completedWorkflow, {}, { runId: "fixed-run" });
    await expect(engine.run(completedWorkflow, {}, { runId: "fixed-run" })).rejects.toThrow();
    store.close();
  });
});
