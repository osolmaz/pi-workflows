import { describe, expect, it } from "vitest";
import monitor, {
  prepareMonitorInput,
  validateMonitorActionResult,
  validateMonitorObservation,
} from "../src/builtins/monitor.workflow.js";
import { compute } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type {
  AgentStepExecutor,
  WorkflowDefinition,
  WorkflowNotificationRequest,
} from "../src/workflows/types.js";
import { makeStateDatabasePath } from "./helpers.js";

function scriptedExecutor(outputs: unknown[], prompts: string[] = []): AgentStepExecutor {
  const remaining = [...outputs];
  return {
    async runAgentStep(request) {
      prompts.push(request.prompt);
      const output = remaining.shift();
      if (output === undefined) throw new Error("No scripted monitor output remains");
      const accepted = await request.accept(output);
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    task: "Finish pull request 123 within the recorded repository authority",
    stopWhen: "The pull request is merged or safely blocked",
    maxChecks: 5,
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "Pull request 123 is merged.",
    report: "PR 123 is merged.",
    targetStateId: "pr-123:merged",
    authorizedActions: [],
    reason: "The goal is complete.",
    ...overrides,
  };
}

function actionRequest(
  kind: "advance" | "recover" | "repair" = "advance",
  overrides: Record<string, unknown> = {},
) {
  return {
    kind,
    incomplete: "One requested unit remains.",
    evidence: { completed: 4, total: 5 },
    nextAction: kind === "recover" ? "Resume the saved unit." : "Start the missing unit.",
    authority: {
      status: "authorized",
      basis: "The task explicitly authorizes finishing all five units.",
      allowedMutations: ["the saved unit and its launch process"],
      forbiddenMutations: ["provider changes"],
      costLimit: "No paid resources",
      providerRuntime: "Keep the current runtime",
      requiredChecks: ["confirm the worker is active"],
      stopConditions: ["stop on a protected contract change"],
      allowedRecoveryActions: ["resume saved work"],
      merge: false,
      repairApproval: { mode: "skip" },
    },
    cost: {
      paidAction: false,
      status: "not-applicable",
      evidence: "The action uses local resources.",
    },
    defect: {
      sharedCodeOrDataDefect: false,
      paidRunners: "not-applicable",
      evidence: "No shared defect is present.",
    },
    verification: "Confirm that the worker is active.",
    failureId: "unit-5-idle",
    targetStateId: "units:4-of-5:idle",
    ...overrides,
  };
}

function actObservation(
  kind: "advance" | "recover" | "repair" = "advance",
  overrides: Record<string, unknown> = {},
) {
  return observation({
    route: "act",
    goalState: "incomplete",
    workState: kind === "recover" ? "stopped" : "idle",
    observation: "Four of five units are complete and no worker is active.",
    report: "The target is idle with one unit missing.",
    targetStateId: "units:4-of-5:idle",
    reason: "One safe authorized action is available.",
    action: actionRequest(kind),
    ...overrides,
  });
}

function actionResult(
  status: "succeeded" | "failed" | "blocked" = "succeeded",
  overrides: Record<string, unknown> = {},
) {
  return {
    status,
    summary: status === "succeeded" ? "Started the missing unit." : "The start command failed.",
    evidence: { process: status === "succeeded" ? "active" : "not-found" },
    verification: "Checked the real runner process.",
    failureId: "unit-5-idle",
    targetStateId: "units:4-of-5:idle",
    ...overrides,
  };
}

function waitObservation(overrides: Record<string, unknown> = {}) {
  return observation({
    route: "wait",
    goalState: "incomplete",
    workState: "running",
    observation: "The missing unit worker is active.",
    report: "Useful work is moving.",
    targetStateId: "units:4-of-5:running",
    reason: "The worker is active.",
    ...overrides,
  });
}

function fastMonitor(): WorkflowDefinition {
  return {
    ...monitor,
    nodes: {
      ...monitor.nodes,
      sleep: compute({ run: () => ({ waitedMinutes: 0 }) }),
    },
  };
}

function notificationSink(notifications: WorkflowNotificationRequest[]) {
  return {
    notify(request: WorkflowNotificationRequest) {
      notifications.push(request);
      return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
    },
  };
}

describe("built-in monitor workflow", () => {
  it("keeps only the four public inputs and rejects unknown fields before run creation", async () => {
    expect(prepareMonitorInput({ task: "Observe the target" })).toEqual({
      task: "Observe the target",
      everyMinutes: 30,
      stopWhen: "Stop only when the user explicitly asks to stop.",
      maxChecks: 1_000,
    });
    for (const field of ["audience", "repair", "checkTimeoutMinutes", "reportWhen"]) {
      expect(() => prepareMonitorInput({ task: "Observe", [field]: true })).toThrow(
        `monitor input field ${field} is not supported`,
      );
    }

    const databasePath = await makeStateDatabasePath("monitor-invalid-input");
    const store = new WorkflowRunStore(databasePath);
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([]),
      store,
    });
    await expect(engine.run(monitor, { task: "Observe", audience: "operator" })).rejects.toThrow(
      "monitor input field audience is not supported",
    );
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
      count: 0,
    });
    store.close();
  });

  it("validates public input types, lengths, and numeric bounds", () => {
    const invalid: Array<[unknown, string]> = [
      [null, "monitor input must be an object"],
      [[], "monitor input must be an object"],
      [{ task: 1 }, "task must be a string"],
      [{ task: " " }, "task must not be empty"],
      [{ task: "x".repeat(8_001) }, "task must be at most 8000 characters"],
      [{ task: "Observe", everyMinutes: 0 }, "everyMinutes must be an integer"],
      [{ task: "Observe", everyMinutes: 1.5 }, "everyMinutes must be an integer"],
      [{ task: "Observe", everyMinutes: 1_441 }, "everyMinutes must be an integer"],
      [{ task: "Observe", maxChecks: 0 }, "maxChecks must be an integer"],
      [{ task: "Observe", maxChecks: 1.5 }, "maxChecks must be an integer"],
      [{ task: "Observe", maxChecks: 1_001 }, "maxChecks must be an integer"],
      [{ task: "Observe", stopWhen: " " }, "stopWhen must not be empty"],
      [
        { task: "Observe", stopWhen: "x".repeat(4_001) },
        "stopWhen must be at most 4000 characters",
      ],
    ];
    for (const [value, message] of invalid) {
      expect(() => prepareMonitorInput(value)).toThrow(message);
    }
    expect(
      prepareMonitorInput({
        task: " Observe ",
        stopWhen: " Complete ",
        everyMinutes: 1,
        maxChecks: 1,
      }),
    ).toEqual({
      task: "Observe",
      stopWhen: "Complete",
      everyMinutes: 1,
      maxChecks: 1,
    });
  });

  it("stops when the goal is already complete", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([observation()]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-complete")),
      notificationSink: notificationSink(notifications),
    }).run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(result.state.steps.map((step) => step.nodeId)).toEqual([
      "prepare",
      "observe",
      "guard",
      "estimate",
      "publish_progress",
      "report",
      "decide",
      "finish",
    ]);
    expect(notifications[0]?.content).toContain("Goal: complete");
    expect(notifications[0]?.content).toContain("Work: stopped");
  });

  it("waits only when target work is active and detects completion on the next observation", async () => {
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([waitObservation(), observation()]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-active")),
      notificationSink: notificationSink([]),
    }).run(fastMonitor(), input());

    const steps = result.state.steps.map((step) => step.nodeId);
    expect(steps).toContain("schedule");
    expect(steps).toContain("sleep");
    expect(steps.filter((step) => step === "observe")).toHaveLength(2);
    expect(steps.indexOf("schedule")).toBeLessThan(steps.indexOf("sleep"));
    expect(result.state.finalOutput).toMatchObject({ goalState: "complete", checks: 2 });
  });

  it("starts idle work and observes again immediately", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([actObservation("advance"), actionResult(), observation()]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-advance")),
      notificationSink: notificationSink(notifications),
    }).run(monitor, input());

    const steps = result.state.steps.map((step) => step.nodeId);
    const actIndex = steps.indexOf("act");
    expect(steps[actIndex + 1]).toBe("observe");
    expect(steps).not.toContain("schedule");
    expect(steps).not.toContain("sleep");
    expect(notifications[0]?.content).toContain("Monitor: active");
    expect(notifications[0]?.content).toContain("Work: idle");
    expect(notifications[0]?.content).toContain("Next action: Start the missing unit.");
    expect(notifications[0]?.content).not.toContain("Work: running");
    expect(notifications[1]?.content).toContain("Last action: Started the missing unit.");
  });

  it("resumes saved work without planning or documentation", async () => {
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([
        actObservation("recover", {
          action: actionRequest("recover", {
            incomplete: "A saved unit is stopped.",
            evidence: { checkpoint: "verified" },
          }),
        }),
        actionResult("succeeded", { summary: "Resumed the saved unit." }),
        observation(),
      ]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-recover")),
      notificationSink: notificationSink([]),
    }).run(monitor, input());

    const steps = result.state.steps.map((step) => step.nodeId);
    expect(steps).toContain("act");
    expect(steps.some((step) => step.startsWith("planChange/"))).toBe(false);
    expect(steps.some((step) => step.startsWith("implementation/"))).toBe(false);
  });

  it("observes a failed action and then performs one authorized recovery", async () => {
    const recovery = actObservation("recover", {
      observation: "The start command failed and the saved worker remains stopped.",
      report: "The first action failed; a bounded recovery is available.",
      targetStateId: "units:4-of-5:start-failed",
      action: actionRequest("recover", {
        nextAction: "Resume the verified saved worker.",
        failureId: "unit-5-start-failed",
        targetStateId: "units:4-of-5:start-failed",
      }),
    });
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([
        actObservation("advance"),
        actionResult("failed"),
        recovery,
        actionResult("succeeded", {
          summary: "Resumed the verified saved worker.",
          failureId: "unit-5-start-failed",
          targetStateId: "units:4-of-5:start-failed",
        }),
        observation(),
      ]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-recover-after-failure")),
      notificationSink: notificationSink([]),
    }).run(monitor, input());

    expect(result.state.steps.filter((step) => step.nodeId === "act")).toHaveLength(2);
    expect(result.state.steps.filter((step) => step.nodeId === "observe")).toHaveLength(3);
    expect(result.state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
  });

  it.each([
    ["authority is outside scope", "The required repository mutation is not authorized."],
    ["a paid action exceeds its limit", "The next paid launch would exceed the cost ceiling."],
  ])("stops without acting when %s", async (_case, reason) => {
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([
        observation({
          goalState: "blocked",
          workState: "idle",
          observation: reason,
          report: reason,
          targetStateId: `blocked:${_case}`,
          reason,
        }),
      ]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-authority-stop")),
      notificationSink: notificationSink([]),
    }).run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(result.state.steps.some((step) => step.nodeId === "act")).toBe(false);
    expect(result.state.finalOutput).toMatchObject({ goalState: "blocked", reason });
  });

  it("rejects actions outside authority and paid actions outside the limit", () => {
    expect(() =>
      validateMonitorObservation(
        actObservation("advance", {
          action: actionRequest("advance", {
            authority: {
              ...(actionRequest().authority as Record<string, unknown>),
              status: "outside",
            },
          }),
        }),
      ),
    ).toThrow("authority status authorized");

    expect(() =>
      validateMonitorObservation(
        actObservation("advance", {
          action: actionRequest("advance", {
            cost: {
              paidAction: true,
              status: "exceeded",
              evidence: "The next launch would exceed the recorded ceiling.",
            },
          }),
        }),
      ),
    ).toThrow("cannot launch paid work");
  });

  it("requires paid workers to stop before a shared repair", () => {
    expect(() =>
      validateMonitorObservation(
        actObservation("repair", {
          workState: "failed",
          action: actionRequest("repair", {
            defect: {
              sharedCodeOrDataDefect: true,
              paidRunners: "running",
              evidence: "Two affected workers are still active.",
            },
          }),
        }),
      ),
    ).toThrow("paid workers must stop");
  });

  it("validates direct action results against the observed target identity", () => {
    const request = actionRequest();
    expect(validateMonitorActionResult(actionResult(), request)).toMatchObject({
      status: "succeeded",
      failureId: request.failureId,
      targetStateId: request.targetStateId,
    });
    expect(() =>
      validateMonitorActionResult(actionResult("succeeded", { failureId: "changed" }), request),
    ).toThrow("preserve the requested failure");
  });

  it("publishes progress and keeps monitor state separate from target state", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const result = await new WorkflowEngine({
      executor: scriptedExecutor([
        observation({
          workState: "idle",
          progress: {
            tracks: [
              {
                key: "checks",
                data: {
                  schema: "pi-workflows.progress.v1",
                  label: "Checks",
                  status: "blocked",
                  completed: 8,
                  total: 10,
                  unit: "checks",
                },
              },
            ],
          },
        }),
      ]),
      store: new WorkflowRunStore(await makeStateDatabasePath("monitor-progress")),
      notificationSink: notificationSink(notifications),
    }).run(monitor, input());

    expect(result.state.updates?.[0]).toMatchObject({ type: "progress", key: "checks" });
    expect(notifications[0]?.content).toContain("Monitor: stopping");
    expect(notifications[0]?.content).toContain("Work: idle");
    expect(notifications[0]?.content).not.toContain("Work: running");
  });

  it("rejects malformed observation and progress contracts", () => {
    const { report: _report, ...withoutReport } = observation();
    const invalid: Array<[unknown, string]> = [
      [null, "monitor observation output must be an object"],
      [[], "monitor observation output must be an object"],
      [observation({ route: "continue" }), "route"],
      [observation({ goalState: "unknown" }), "goalState"],
      [observation({ workState: "busy" }), "workState"],
      [withoutReport, "report"],
      [observation({ extra: true }), "not supported"],
      [observation({ authorizedActions: "start" }), "array of strings"],
      [observation({ authorizedActions: [1] }), "array of strings"],
      [observation({ observation: " " }), "observation must not be empty"],
      [observation({ report: "x".repeat(4_001) }), "report must be at most 4000 characters"],
      [actObservation("advance", { action: undefined }), "requires action details"],
      [
        actObservation("advance", { targetStateId: "different-state" }),
        "must match the observed targetStateId",
      ],
      [
        observation({
          action: actionRequest("advance", { targetStateId: "pr-123:merged" }),
        }),
        "only valid for route act",
      ],
      [actObservation("advance", { goalState: "complete" }), "requires goalState incomplete"],
      [actObservation("advance", { workState: "running" }), "requires idle, failed, or stopped"],
      [waitObservation({ goalState: "blocked" }), "route wait requires goalState incomplete"],
      [waitObservation({ workState: "idle" }), "requires running work or an external wait"],
      [observation({ progress: null }), "progress must be an object"],
      [observation({ progress: { tracks: [] } }), "must contain 1 through 256 entries"],
      [observation({ progress: { tracks: "invalid" } }), "must contain 1 through 256 entries"],
      [
        observation({ progress: { tracks: Array.from({ length: 257 }, () => ({})) } }),
        "must contain 1 through 256 entries",
      ],
      [observation({ progress: { tracks: [null] } }), "progress.tracks[0] must be an object"],
      [
        observation({ progress: { tracks: [{ key: "bad key", data: progress(1, 2) }] } }),
        "key is invalid",
      ],
      [
        observation({
          progress: { tracks: [{ key: "valid", data: progress(1, 2), extra: true }] },
        }),
        "field extra is not supported",
      ],
      [
        observation({ progress: { tracks: [{ key: "valid", data: null }] } }),
        "progress.tracks[0].data must be an object",
      ],
      [
        observation({
          progress: {
            tracks: [
              { key: "same", data: progress(1, 2) },
              { key: "same", data: progress(1, 2) },
            ],
          },
        }),
        "duplicated",
      ],
    ];
    for (const [value, message] of invalid) {
      expect(() => validateMonitorObservation(value)).toThrow(message);
    }
  });

  it("rejects malformed authorized action contracts", () => {
    const valid = actionRequest();
    const invalid: Array<[unknown, string]> = [
      [actionRequest("advance", { kind: "retry" }), "kind must be advance, recover, or repair"],
      [actionRequest("advance", { incomplete: " " }), "incomplete work must not be empty"],
      [actionRequest("advance", { extra: true }), "field extra is not supported"],
      [
        actionRequest("advance", { authority: { ...valid.authority, status: "invalid" } }),
        "status must be authorized or outside",
      ],
      [
        actionRequest("advance", { authority: { ...valid.authority, merge: "yes" } }),
        "merge must be boolean",
      ],
      [
        actionRequest("advance", {
          authority: { ...valid.authority, allowedMutations: "target" },
        }),
        "allowedMutations must be an array of strings",
      ],
      [
        actionRequest("advance", { authority: { ...valid.authority, allowedMutations: [1] } }),
        "allowedMutations must be an array of strings",
      ],
      [
        actionRequest("advance", { authority: { ...valid.authority, allowedMutations: [" "] } }),
        "allowedMutations[0] must not be empty",
      ],
      [
        actionRequest("advance", { authority: { ...valid.authority, allowedMutations: [] } }),
        "requires at least one allowed mutation",
      ],
      [
        actionRequest("advance", { authority: { ...valid.authority, repairApproval: 1 } }),
        "repair approval must be an object",
      ],
      [
        actionRequest("advance", {
          cost: { paidAction: "yes", status: "within-limit", evidence: "approved" },
        }),
        "paidAction must be boolean",
      ],
      [
        actionRequest("advance", {
          cost: { paidAction: true, status: "invalid", evidence: "approved" },
        }),
        "cost status is invalid",
      ],
      [
        actionRequest("advance", {
          cost: { paidAction: true, status: "missing", evidence: "no admission" },
        }),
        "cannot launch paid work",
      ],
      [
        actionRequest("advance", {
          cost: { paidAction: true, status: "not-applicable", evidence: "invalid" },
        }),
        "paid route act requires cost status within-limit",
      ],
      [
        actionRequest("advance", {
          cost: { paidAction: false, status: "within-limit", evidence: "invalid" },
        }),
        "unpaid route act requires cost status not-applicable",
      ],
      [
        actionRequest("advance", {
          defect: {
            sharedCodeOrDataDefect: "yes",
            paidRunners: "stopped",
            evidence: "stopped",
          },
        }),
        "sharedCodeOrDataDefect must be boolean",
      ],
      [
        actionRequest("advance", {
          defect: {
            sharedCodeOrDataDefect: false,
            paidRunners: "unknown",
            evidence: "unknown",
          },
        }),
        "paidRunners is invalid",
      ],
    ];
    for (const [action, message] of invalid) {
      expect(() => validateMonitorObservation(actObservation("advance", { action }))).toThrow(
        message,
      );
    }

    const { evidence: _evidence, ...withoutEvidence } = valid;
    expect(
      validateMonitorObservation(actObservation("advance", { action: withoutEvidence })).action,
    ).toMatchObject({ evidence: null });
  });

  it("rejects malformed direct action results", () => {
    const request = actionRequest();
    const { evidence: _evidence, ...withoutEvidence } = actionResult();
    expect(validateMonitorActionResult(withoutEvidence, request)).toMatchObject({ evidence: null });

    const invalid: Array<[unknown, string]> = [
      [null, "monitor action result must be an object"],
      [actionResult("succeeded", { extra: true }), "field extra is not supported"],
      [actionResult("succeeded", { status: "unknown" }), "status must be succeeded"],
      [actionResult("succeeded", { summary: " " }), "summary must not be empty"],
      [actionResult("succeeded", { targetStateId: "changed" }), "preserve the requested failure"],
    ];
    for (const [result, message] of invalid) {
      expect(() => validateMonitorActionResult(result, request)).toThrow(message);
    }
  });

  it("tells the regular model to observe read-only state without a target-specific API", async () => {
    const prompts: string[] = [];
    const executor = scriptedExecutor([], prompts);
    const node = monitor.nodes.observe;
    if (node?.nodeType !== "agent") throw new Error("observe must be an agent node");
    const prompt = await node.prompt({
      input: input(),
      outputs: { prepare: prepareMonitorInput(input()) },
      results: {},
      state: { steps: [] } as never,
      signal: new AbortController().signal,
    });
    expect(prompt).toContain("Perform read-only observation 1");
    expect(prompt).toContain("Do not mutate any file, process, Job, service, remote resource");
    expect(prompt).toContain("regular Pi model and observation adapter");
    expect(prompt).toContain("Do not require the target to implement a Pi-specific API");
    expect(executor).toBeDefined();
  });

  it("uses no presentation prompt and schedules only the wait route", () => {
    expect(monitor.presentationPrompt).toBeUndefined();
    expect(monitor.nodes.report?.nodeType).toBe("notify");
    const edges = JSON.stringify(monitor.edges);
    expect(edges).toContain('"wait":"schedule"');
    expect(edges).not.toContain('"advance":"schedule"');
    expect(edges).not.toContain('"recover":"schedule"');
    expect(edges).not.toContain('"repair":"schedule"');
    expect(Object.keys(monitor.includes ?? {})).toEqual(["planChange", "implementation"]);
  });
});

function progress(completed: number, total: number) {
  return {
    schema: "pi-workflows.progress.v1",
    status: "running",
    completed,
    total,
    unit: "items",
  };
}
