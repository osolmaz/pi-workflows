import { describe, expect, it } from "vitest";
import {
  agent,
  checkpoint,
  compute,
  defineWorkflow,
  includeWorkflow,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { allowSettingsPath, settingsRoute, workflowSettings } from "../src/workflows/settings.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { AgentStepRequest, AgentStepSubmission } from "../src/workflows/types.js";
import { ScriptedExecutor, makeStateDatabasePath, waitUntil } from "./helpers.js";

type Settings = { mode: "a" | "b"; notes: string[] };

function parseSettings(value: unknown): Settings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be an object");
  }
  const input = value as { mode?: unknown; notes?: unknown };
  if ((input.mode !== "a" && input.mode !== "b") || !Array.isArray(input.notes)) {
    throw new Error("invalid settings");
  }
  if (!input.notes.every((item) => typeof item === "string")) {
    throw new Error("invalid notes");
  }
  return { mode: input.mode, notes: [...input.notes] };
}

const settings = workflowSettings<Settings>({
  initial: { mode: "a", notes: [] },
  parse: parseSettings,
  paths: [
    allowSettingsPath("/mode", { read: ["session", "human"], replace: ["human"] }),
    allowSettingsPath("/notes", {
      read: ["session", "human"],
      add: ["session", "human"],
      remove: ["session", "human"],
      replace: ["session", "human"],
    }),
  ],
});

const liveWorkflow = defineWorkflow({
  name: "live-settings-test",
  settings,
  startAt: "hold",
  nodes: {
    hold: agent({ prompt: ({ settings }) => `old=${JSON.stringify(settings)}` }),
    read: compute({
      run: ({ settings, settingsChangeNumber }) => ({ settings, settingsChangeNumber }),
    }),
  },
  edges: [{ from: "hold", to: "read" }],
});

class HeldExecutor extends ScriptedExecutor {
  started = false;
  release: (() => void) | undefined;

  constructor() {
    super();
    this.respond("hold", async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
      this.started = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      const accepted = await request.accept({ ok: true });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
  }
}

describe("durable workflow settings", () => {
  it("keeps one fixed settings value per node and gives the next node the accepted change", async () => {
    const databasePath = await makeStateDatabasePath("live-settings");
    const executor = new HeldExecutor();
    const engine = new WorkflowEngine({ databasePath, executor });
    const running = engine.run(liveWorkflow, {});
    await waitUntil(() => executor.started);

    const store = new WorkflowRunStore(databasePath);
    const runId = store.listRuns()[0]?.runId;
    expect(runId).toBeDefined();
    const scope = store.listSettingsScopes(runId as string)[0];
    expect(scope?.changeNumber).toBe(0);
    const changed = await store.changeSettings(settings, {
      runId: runId as string,
      scopeId: scope?.scopeId as string,
      requestId: "change-1",
      actor: { type: "human", id: "user-1" },
      source: "interactive-command",
      expectedChangeNumber: 0,
      patch: [{ op: "replace", path: "/mode", value: "b" }],
    });
    expect(changed.adopted).toBe(false);
    expect(changed.scope.changeNumber).toBe(1);
    expect(
      await store.changeSettings(settings, {
        runId: runId as string,
        scopeId: scope?.scopeId as string,
        requestId: "change-1",
        actor: { type: "human", id: "user-1" },
        source: "interactive-command",
        expectedChangeNumber: 0,
        patch: [{ op: "replace", path: "/mode", value: "b" }],
      }),
    ).toMatchObject({ adopted: true });
    await expect(
      store.changeSettings(settings, {
        runId: runId as string,
        scopeId: scope?.scopeId as string,
        requestId: "change-1",
        actor: { type: "human", id: "user-1" },
        source: "interactive-command",
        patch: [{ op: "replace", path: "/mode", value: "a" }],
      }),
    ).rejects.toThrow(/reused with different content/);

    executor.release?.();
    const result = await running;
    expect(result.state.finalOutput).toEqual({
      settings: { mode: "b", notes: [] },
      settingsChangeNumber: 1,
    });
    expect(result.state.steps.map((step) => step.settingsChangeNumber)).toEqual([0, 1]);
    store.close();
  });

  it("orders two concurrent writers without losing either accepted patch", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-concurrent");
    const executor = new HeldExecutor();
    const running = new WorkflowEngine({ databasePath, executor }).run(liveWorkflow, {});
    await waitUntil(() => executor.started);
    const firstStore = new WorkflowRunStore(databasePath);
    const secondStore = new WorkflowRunStore(databasePath);
    const runId = firstStore.listRuns()[0]?.runId as string;
    const scopeId = firstStore.listSettingsScopes(runId)[0]?.scopeId as string;
    const results = await Promise.all([
      firstStore.changeSettings(settings, {
        runId,
        scopeId,
        requestId: "writer-1",
        actor: { type: "human", id: "one" },
        source: "interactive-command",
        patch: [{ op: "add", path: "/notes/-", value: "one" }],
      }),
      secondStore.changeSettings(settings, {
        runId,
        scopeId,
        requestId: "writer-2",
        actor: { type: "human", id: "two" },
        source: "interactive-command",
        patch: [{ op: "add", path: "/notes/-", value: "two" }],
      }),
    ]);
    expect(results.map((result) => result.change.changeNumber).toSorted()).toEqual([1, 2]);
    expect(firstStore.getSettingsScope(scopeId)).toMatchObject({
      changeNumber: 2,
      settings: { mode: "a", notes: expect.arrayContaining(["one", "two"]) },
    });
    executor.release?.();
    await running;
    firstStore.close();
    secondStore.close();
  });

  it("fails resume when the saved settings projection does not match its changes", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-rebuild");
    const executor = new HeldExecutor();
    const engine = new WorkflowEngine({ databasePath, executor });
    const running = engine.run(liveWorkflow, {});
    await waitUntil(() => executor.started);
    const store = new WorkflowRunStore(databasePath);
    const runId = store.listRuns()[0]?.runId as string;
    const scope = store.listSettingsScopes(runId)[0] as NonNullable<
      ReturnType<typeof store.getSettingsScope>
    >;
    engine.park();
    await running;
    const badHash = store.state.putJson({ mode: "b", notes: ["not saved"] });
    store.state.connection
      .prepare("UPDATE workflow_settings SET current_hash = ? WHERE scope_id = ?")
      .run(badHash, scope.scopeId);
    await expect(
      new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() }).resumeRun(
        liveWorkflow,
        runId,
      ),
    ).rejects.toThrow(/projection does not match saved changes/);
    store.close();
  });

  it("reruns only a pure settings route when a change wins before route settlement", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-route");
    const externalStore = new WorkflowRunStore(databasePath);
    let calls = 0;
    const workflow = defineWorkflow({
      name: "settings-route-test",
      settings,
      startAt: "route",
      nodes: {
        route: settingsRoute({
          run: async ({ state, settings: current, settingsScopeId }) => {
            calls += 1;
            if (calls === 1) {
              await externalStore.changeSettings(settings, {
                runId: state.runId,
                scopeId: settingsScopeId as string,
                requestId: "route-change",
                actor: { type: "human" },
                source: "interactive-command",
                patch: [{ op: "replace", path: "/mode", value: "b" }],
              });
            }
            return { route: (current as Settings).mode };
          },
        }),
        a: compute({ run: () => ({ selected: "a" }) }),
        b: compute({ run: () => ({ selected: "b" }) }),
      },
      edges: [{ from: "route", switch: { on: "$.route", cases: { a: "a", b: "b" } } }],
    });
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
    }).run(workflow, {});
    expect(result.state.finalOutput).toEqual({ selected: "b" });
    expect(calls).toBe(2);
    expect(result.state.steps.filter((step) => step.nodeId === "route")).toHaveLength(1);
    expect(externalStore.readRun(result.runId, { includeTrace: true })?.traceEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "settings_route_retried" })]),
    );
    externalStore.close();
  });

  it("stops a settings route that keeps changing without recording an uncommitted result", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-route-limit");
    const externalStore = new WorkflowRunStore(databasePath);
    let request = 0;
    const workflow = defineWorkflow({
      name: "settings-route-limit-test",
      settings,
      startAt: "route",
      nodes: {
        route: settingsRoute({
          run: async ({ state, settings: current, settingsScopeId }) => {
            request += 1;
            await externalStore.changeSettings(settings, {
              runId: state.runId,
              scopeId: settingsScopeId as string,
              requestId: `route-change-${request}`,
              actor: { type: "human" },
              source: "interactive-command",
              patch: [
                {
                  op: "replace",
                  path: "/mode",
                  value: (current as Settings).mode === "a" ? "b" : "a",
                },
              ],
            });
            return { route: (current as Settings).mode };
          },
        }),
        a: compute({ run: () => ({ selected: "a" }) }),
        b: compute({ run: () => ({ selected: "b" }) }),
      },
      edges: [{ from: "route", switch: { on: "$.route", cases: { a: "a", b: "b" } } }],
    });
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
    }).run(workflow, {});
    expect(result.state.status).toBe("failed");
    expect(result.state.error).toMatch(/changed more than 16 times/);
    expect(result.state.steps.filter((step) => step.nodeId === "route")).toEqual([]);
    externalStore.close();
  });

  it("stores ordered follow-ups and makes them ready only after a successful terminal state", async () => {
    const databasePath = await makeStateDatabasePath("workflow-follow-ups");
    const executor = new HeldExecutor();
    const running = new WorkflowEngine({ databasePath, executor }).run(liveWorkflow, {});
    await waitUntil(() => executor.started);
    const store = new WorkflowRunStore(databasePath);
    const runId = store.listRuns()[0]?.runId as string;

    const first = store.queueFollowUp({
      runId,
      requestId: "follow-1",
      targetSessionId: "session-1",
      actor: { type: "session", id: "session-1" },
      source: "workflow-tool",
      prompt: "First task",
    });
    const second = store.queueFollowUp({
      runId,
      requestId: "follow-2",
      targetSessionId: "session-1",
      actor: { type: "session", id: "session-1" },
      source: "workflow-tool",
      prompt: "Second task",
    });
    expect([first.followUp.order, second.followUp.order]).toEqual([1, 2]);
    expect(
      store.queueFollowUp({
        runId,
        requestId: "follow-1",
        targetSessionId: "session-1",
        actor: { type: "session", id: "session-1" },
        source: "workflow-tool",
        prompt: "First task",
      }).adopted,
    ).toBe(true);
    expect(() =>
      store.queueFollowUp({
        runId,
        requestId: "follow-1",
        targetSessionId: "session-1",
        actor: { type: "session", id: "session-1" },
        source: "workflow-tool",
        prompt: "Different task",
      }),
    ).toThrow(/reused with different content/);
    expect(store.readFollowUpQueue(runId)?.followUps.map((item) => item.state)).toEqual([
      "queued",
      "queued",
    ]);

    executor.release?.();
    await running;
    expect(store.readFollowUpQueue(runId)).toMatchObject({
      presentationState: "not-needed",
      followUps: [{ state: "ready" }, { state: "ready" }],
    });
    expect(() =>
      store.queueFollowUp({
        runId,
        requestId: "late-follow-up",
        targetSessionId: "session-1",
        actor: { type: "session", id: "session-1" },
        source: "workflow-tool",
        prompt: "Too late",
      }),
    ).toThrow(/does not accept changes/);

    const claimed = store.claimNextFollowUp("session-1", "delivery-1");
    expect(claimed?.followUp.followUpId).toBe(first.followUp.followUpId);
    const sent = store.markFollowUpSent(
      claimed?.followUp.followUpId as string,
      claimed?.claim as NonNullable<typeof claimed>["claim"],
      "entry-1",
    );
    expect(sent).toMatchObject({ state: "sent", sessionEntryId: "entry-1" });
    store.close();
  });

  it("creates isolated settings for each included-workflow invocation", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-includes");
    const childSettings = workflowSettings<{ value: string }, { seed: string }>({
      initial: (input) => ({ value: input.seed }),
      parse: (value) => value as { value: string },
      paths: [allowSettingsPath("/value", { replace: ["human"] })],
    });
    const child = defineWorkflow({
      name: "settings-child",
      input: (value) => value as { seed: string },
      settings: childSettings,
      startAt: "done",
      nodes: { done: compute({ run: ({ settings }) => settings }) },
      exits: { completed: { from: "done" } },
      edges: [],
    });
    const parent = defineWorkflow({
      name: "settings-parent",
      startAt: "start",
      includes: {
        first: includeWorkflow(child, {
          input: () => ({ seed: "one" }),
          settings: () => ({ value: "mapped-one" }),
        }),
        second: includeWorkflow(child, { input: () => ({ seed: "two" }) }),
      },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({
          run: ({ outputs }) => ({ first: outputs.first, second: outputs.second }),
        }),
      },
      edges: [
        { from: "start", to: "first" },
        { from: "first.completed", to: "second" },
        { from: "second.completed", to: "finish" },
      ],
    });
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
    }).run(parent, {});
    const store = new WorkflowRunStore(databasePath);
    expect(result.state.finalOutput).toEqual({
      first: { exit: "completed", output: { value: "mapped-one" } },
      second: { exit: "completed", output: { value: "two" } },
    });
    expect(store.listSettingsScopes(result.runId)).toMatchObject([
      { mountPath: "first", invocation: 1, settings: { value: "mapped-one" } },
      { mountPath: "second", invocation: 1, settings: { value: "two" } },
    ]);
    store.close();
  });

  it("enforces follow-up removal authority and cancellation", async () => {
    const databasePath = await makeStateDatabasePath("workflow-follow-up-cancel");
    const executor = new HeldExecutor();
    const engine = new WorkflowEngine({ databasePath, executor });
    const running = engine.run(liveWorkflow, {});
    await waitUntil(() => executor.started);
    const store = new WorkflowRunStore(databasePath);
    const runId = store.listRuns()[0]?.runId as string;
    const queued = store.queueFollowUp({
      runId,
      requestId: "cancel-follow-up",
      targetSessionId: "session-1",
      actor: { type: "session", id: "session-1" },
      source: "workflow-tool",
      prompt: "Do not send me",
    });
    expect(() =>
      store.removeFollowUp({
        runId,
        followUpId: queued.followUp.followUpId,
        actor: { type: "session", id: "session-2" },
        source: "workflow-tool",
      }),
    ).toThrow(/only by its source/);
    engine.cancel();
    const result = await running;
    expect(result.state.status).toBe("cancelled");
    expect(store.readFollowUpQueue(runId)?.followUps[0]).toMatchObject({
      state: "cancelled",
    });
    store.close();
  });

  it("validates follow-up inputs and lets a verified human remove an unsent item", async () => {
    const databasePath = await makeStateDatabasePath("workflow-follow-up-remove");
    const executor = new HeldExecutor();
    const engine = new WorkflowEngine({ databasePath, executor });
    const running = engine.run(liveWorkflow, {});
    await waitUntil(() => executor.started);
    const store = new WorkflowRunStore(databasePath);
    const runId = store.listRuns()[0]?.runId as string;
    expect(() =>
      store.queueFollowUp({
        runId,
        requestId: "empty-follow-up",
        targetSessionId: "session-1",
        actor: { type: "human" },
        source: "interactive-command",
        prompt: " ",
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      store.queueFollowUp({
        runId,
        requestId: "large-follow-up",
        targetSessionId: "session-1",
        actor: { type: "human" },
        source: "interactive-command",
        prompt: "x".repeat(65_537),
      }),
    ).toThrow(/cannot exceed/);
    const queued = store.queueFollowUp({
      runId,
      requestId: "remove-follow-up",
      targetSessionId: "session-1",
      actor: { type: "controller", id: "controller-1" },
      source: "controller-request",
      prompt: "Remove me",
    });
    const removed = store.removeFollowUp({
      runId,
      followUpId: queued.followUp.followUpId,
      actor: { type: "human", id: "user-1" },
      source: "interactive-command",
    });
    expect(removed.state).toBe("removed");
    expect(
      store.removeFollowUp({
        runId,
        followUpId: queued.followUp.followUpId,
        actor: { type: "human", id: "user-1" },
        source: "interactive-command",
      }).state,
    ).toBe("removed");
    engine.cancel();
    await running;
    expect(store.claimNextFollowUp("session-1", "nobody")).toBeUndefined();
    store.close();
  });

  it("waits for durable presentation settlement", async () => {
    const databasePath = await makeStateDatabasePath("workflow-presentation");
    const workflow = defineWorkflow({
      name: "presentation-settings-test",
      settings,
      presentationPrompt: "Present it.",
      startAt: "done",
      nodes: { done: compute({ run: () => ({ ok: true }) }) },
      edges: [],
    });
    const store = new WorkflowRunStore(databasePath);
    const engine = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
    const result = await engine.run(workflow, {});
    expect(store.readFollowUpQueue(result.runId)?.presentationState).toBe("pending");
    expect(() =>
      store.settleFollowUpPresentation({ runId: result.runId, state: "settled" }),
    ).toThrow(/requires both/);
    const settled = store.settleFollowUpPresentation({
      runId: result.runId,
      state: "settled",
      presentationEntryId: "presentation-user",
      assistantEntryId: "presentation-assistant",
    });
    expect(settled.presentationState).toBe("settled");
    expect(
      store.settleFollowUpPresentation({
        runId: result.runId,
        state: "settled",
        presentationEntryId: "presentation-user",
        assistantEntryId: "presentation-assistant",
      }).presentationState,
    ).toBe("settled");
    store.close();
  });

  it("records a final presentation as unavailable with a reason", async () => {
    const databasePath = await makeStateDatabasePath("workflow-presentation-unavailable");
    const workflow = defineWorkflow({
      name: "presentation-unavailable-test",
      presentationPrompt: "Present it.",
      startAt: "done",
      nodes: { done: compute({ run: () => ({ ok: true }) }) },
      edges: [],
    });
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    expect(() =>
      store.settleFollowUpPresentation({ runId: result.runId, state: "unavailable" }),
    ).toThrow(/requires a reason/);
    expect(
      store.settleFollowUpPresentation({
        runId: result.runId,
        state: "unavailable",
        reason: "Pi closed before the final response settled",
      }),
    ).toMatchObject({
      presentationState: "unavailable",
      presentationReason: "Pi closed before the final response settled",
    });
    store.close();
  });

  it("carries settings and queued follow-ups through a checkpoint continuation", async () => {
    const databasePath = await makeStateDatabasePath("workflow-settings-continuation");
    const workflow = defineWorkflow({
      name: "settings-checkpoint-test",
      settings,
      startAt: "wait",
      nodes: {
        wait: checkpoint({ summary: "wait" }),
        done: compute({
          run: ({ settings, settingsChangeNumber }) => ({ settings, settingsChangeNumber }),
        }),
      },
      edges: [{ from: "wait", to: "done" }],
    });
    const engine = new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() });
    const parent = await engine.run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    const scope = store.listSettingsScopes(parent.runId)[0] as NonNullable<
      ReturnType<typeof store.getSettingsScope>
    >;
    await store.changeSettings(settings, {
      runId: parent.runId,
      scopeId: scope.scopeId,
      requestId: "waiting-change",
      actor: { type: "human" },
      source: "interactive-command",
      patch: [{ op: "replace", path: "/mode", value: "b" }],
    });
    store.queueFollowUp({
      runId: parent.runId,
      requestId: "waiting-follow-up",
      targetSessionId: "session-1",
      actor: { type: "human" },
      source: "interactive-command",
      prompt: "Continue later",
    });

    const child = await engine.continueRun(workflow, parent.runId, { answer: true });
    expect(child.state.finalOutput).toEqual({
      settings: { mode: "b", notes: [] },
      settingsChangeNumber: 1,
    });
    expect(store.listSettingsScopes(child.runId)[0]).toMatchObject({
      scopeId: scope.scopeId,
      activeRunId: child.runId,
      changeNumber: 1,
    });
    expect(store.readFollowUpQueue(child.runId)?.followUps).toMatchObject([
      { prompt: "Continue later", order: 1, state: "ready" },
    ]);
    expect(store.readFollowUpQueue(parent.runId)?.followUps).toEqual([]);
    store.close();
  });
});
