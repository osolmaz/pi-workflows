import { describe, expect, it, vi } from "vitest";
import { WorkflowEngineScheduler } from "../src/controllers/workflow-engine-scheduler.js";
import {
  checkpoint,
  compute,
  defineWorkflow,
  includeWorkflow,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { allowSettingsPath, workflowSettings } from "../src/workflows/settings.js";
import { SESSION_BINDING_SCHEMA, WorkflowRunStore } from "../src/workflows/store.js";
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

const controlledWorkflow = defineWorkflow({
  name: "controlled-child",
  settings: workflowSettings({
    initial: { mode: "old" },
    parse: (value) => value as { mode: string },
    paths: [allowSettingsPath("/mode", { replace: ["controller"] })],
  }),
  startAt: "wait",
  nodes: { wait: checkpoint({ summary: "wait" }) },
  edges: [],
});

function composedControlledWorkflow(permission: "controller" | "human") {
  const child = defineWorkflow({
    name: "composed-controlled-child",
    settings: workflowSettings({
      initial: { mode: "old" },
      parse: (value) => value as { mode: string },
      paths: [allowSettingsPath("/mode", { replace: [permission] })],
    }),
    startAt: "wait",
    nodes: { wait: checkpoint({ summary: "wait" }) },
    exits: { ready: { from: "wait" } },
    edges: [],
  });
  return defineWorkflow({
    name: "composed-controlled",
    includes: { child: includeWorkflow(child) },
    startAt: "start",
    nodes: {
      start: compute({ run: () => ({}) }),
      finish: compute({ run: ({ outputs }) => outputs.child }),
    },
    edges: [
      { from: "start", to: "child" },
      { from: "child.ready", to: "finish" },
    ],
  });
}

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

  it("changes settings and manages follow-ups for a controller child", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-control"));
    const subject = scheduler(
      store,
      new Map([
        ["controlled", controlledWorkflow],
        ["controlled-child", controlledWorkflow],
      ]),
    );
    await subject.ensure(
      {
        requestId: "controlled-request",
        attempt: 1,
        workflow: "controlled",
        input: {},
        runId: "controlled-run",
      },
      new AbortController().signal,
      () => undefined,
    );
    await subject.waitForIdle();
    const changed = await subject.changeSettings(
      {
        requestKey: "settings",
        actorRequestKey: "controller:resource-1:settings",
        controllerResourceUid: "resource-1",
        runId: "controlled-run",
        patch: [{ op: "replace", path: "/mode", value: "new" }],
      },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({ changeNumber: 1, adopted: false });
    await expect(
      subject.changeSettings(
        {
          requestKey: "missing",
          actorRequestKey: "controller:resource-1:missing",
          controllerResourceUid: "resource-1",
          runId: "missing-run",
          patch: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/run not found/);
    await expect(
      subject.changeSettings(
        {
          requestKey: "unknown-scope",
          actorRequestKey: "controller:resource-1:unknown-scope",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          scopeId: "missing-scope",
          patch: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/scope not found/);
    await expect(
      subject.queueFollowUp(
        {
          requestKey: "no-session",
          actorRequestKey: "controller:resource-1:no-session",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          prompt: "later",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/origin Pi session/);
    expect(
      await subject.changeSettings(
        {
          requestKey: "settings-2",
          actorRequestKey: "controller:resource-1:settings-2",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          scopeId: changed.scopeId,
          expectedChangeNumber: 1,
          patch: [{ op: "replace", path: "/mode", value: "newer" }],
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ changeNumber: 2 });
    const wrongDefinition = scheduler(
      store,
      new Map([
        ["controlled-child", waitingWorkflow],
        ["waiting-child", waitingWorkflow],
      ]),
    );
    await expect(
      wrongDefinition.changeSettings(
        {
          requestKey: "no-definition",
          actorRequestKey: "controller:resource-1:no-definition",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          scopeId: changed.scopeId,
          patch: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/does not declare editable settings/);
    await store.writeSessionBinding("controlled-run", {
      schema: SESSION_BINDING_SCHEMA,
      runId: "controlled-run",
      piSessionId: "session-1",
      cwd: "/tmp/project",
      boundAt: new Date().toISOString(),
    });
    const queued = await subject.queueFollowUp(
      {
        requestKey: "follow",
        actorRequestKey: "controller:resource-1:follow",
        controllerResourceUid: "resource-1",
        runId: "controlled-run",
        prompt: "Continue later",
      },
      new AbortController().signal,
    );
    expect(queued).toMatchObject({ order: 1, state: "queued" });
    expect(
      await subject.queueFollowUp(
        {
          requestKey: "follow",
          actorRequestKey: "controller:resource-1:follow",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          prompt: "Continue later",
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ adopted: true, order: 1 });
    await expect(
      subject.removeFollowUp(
        {
          requestKey: "remove",
          actorRequestKey: "controller:resource-1:remove",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          followUpId: queued.followUpId,
        },
        AbortSignal.abort(new Error("stop")),
      ),
    ).rejects.toThrow(/stop/);
    expect(
      await subject.removeFollowUp(
        {
          requestKey: "remove",
          actorRequestKey: "controller:resource-1:remove",
          controllerResourceUid: "resource-1",
          runId: "controlled-run",
          followUpId: queued.followUpId,
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ state: "removed", adopted: false });
    store.close();
  });

  it("rejects a settings change when an included definition changed", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("child-composed-source"));
    const original = composedControlledWorkflow("controller");
    const workflows = new Map<string, WorkflowDefinition>([
      ["composed", original],
      ["composed-controlled", original],
    ]);
    const subject = scheduler(store, workflows);
    await subject.ensure(
      {
        requestId: "composed-request",
        attempt: 1,
        workflow: "composed",
        input: {},
        runId: "composed-run",
      },
      new AbortController().signal,
      () => undefined,
    );
    await subject.waitForIdle();
    const scope = store.listSettingsScopes("composed-run")[0];
    if (scope === undefined) throw new Error("Composed settings scope was not created");
    workflows.set("composed-controlled", composedControlledWorkflow("human"));

    await expect(
      subject.changeSettings(
        {
          requestKey: "changed-child",
          actorRequestKey: "controller:resource-1:changed-child",
          controllerResourceUid: "resource-1",
          runId: "composed-run",
          scopeId: scope.scopeId,
          patch: [{ op: "replace", path: "/mode", value: "new" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/source changed/);
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
