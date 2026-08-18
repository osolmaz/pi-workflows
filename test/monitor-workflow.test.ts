import { describe, expect, it } from "vitest";
import monitor, {
  prepareMonitorInput,
  validateMonitorCheck,
} from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { AgentStepExecutor, WorkflowNotificationRequest } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

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
    task: "Check pull request 123",
    stopWhen: "The pull request is merged or closed",
    maxChecks: 5,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    route: "stop",
    observation: "Pull request 123 is merged.",
    report: "PR 123 is merged.",
    reason: "The stop condition is true.",
    ...overrides,
  };
}

describe("built-in monitor workflow", () => {
  it("defaults to 30 minutes and explicit-user-stop when no finish rule is supplied", () => {
    expect(prepareMonitorInput({ task: "Observe the target" })).toMatchObject({
      everyMinutes: 30,
      stopWhen: "Stop only when the user explicitly asks to stop.",
      maxChecks: 1_000,
      checkTimeoutMinutes: 60,
    });
    expect(() => prepareMonitorInput({ task: "Observe", reportWhen: "state changes" })).toThrow(
      "reportWhen is not supported",
    );
  });

  it("reports every accepted stop check before completion", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([check()]),
      store: new WorkflowRunStore(await makeTempDir("monitor-stop")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(notifications.map((item) => item.content)).toEqual(["PR 123 is merged."]);
    expect(result.state.steps.map((step) => step.nodeId)).toEqual([
      "prepare",
      "check",
      "estimate",
      "publish_progress",
      "report",
      "decide",
      "finish",
    ]);
    expect(result.state.finalOutput).toMatchObject({ reported: true, checks: 1 });
  });

  it("reports a continue check and then stops at the disclosed safety limit", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        check({
          route: "continue",
          observation: "PR 123 remains open.",
          report: "PR 123 remains open.",
          reason: "It is not merged.",
        }),
      ]),
      store: new WorkflowRunStore(await makeTempDir("monitor-limit")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input({ maxChecks: 1 }));

    expect(result.state.status).toBe("completed");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("Reached the 1-check safety limit.");
    expect(result.state.finalOutput).toMatchObject({
      reason: "Reached the 1-check safety limit.",
      reported: true,
    });
    expect(result.state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
  });

  it("publishes progress and adds a model-free estimate to the report", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        check({
          report: "Checks are still running.",
          progress: {
            tracks: [
              {
                key: "checks",
                data: {
                  schema: "pi-workflows.progress.v1",
                  label: "Checks",
                  status: "running",
                  completed: 8,
                  total: 10,
                  unit: "checks",
                },
              },
            ],
          },
        }),
      ]),
      store: new WorkflowRunStore(await makeTempDir("monitor-progress")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.updates).toHaveLength(1);
    expect(result.state.updates?.[0]).toMatchObject({ type: "progress", key: "checks" });
    expect(notifications[0]?.content).toContain("Progress: Checks  8/10 checks");
    expect(notifications[0]?.content).toContain("ETA unavailable (needs another progress sample)");
  });

  it("paces large progress batches below the engine update limit", async () => {
    const tracks = Array.from({ length: 101 }, (_, index) => ({
      key: `track-${index}`,
      data: progress(1, 2),
    }));
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([check({ progress: { tracks } })]),
      store: new WorkflowRunStore(await makeTempDir("monitor-progress-batch")),
      notificationSink: {
        notify() {
          return { notificationId: "n1", targetSessionId: "s1" };
        },
      },
    });

    const result = await engine.run(monitor, input());

    expect(result.state.status).toBe("completed");
    expect(result.state.updates).toHaveLength(101);
  }, 10_000);

  it("includes the prior observation and progress summary in the next prompt", async () => {
    const prompts: string[] = [];
    const executor = scriptedExecutor([], prompts);
    const checkNode = monitor.nodes.check;
    if (checkNode?.nodeType !== "agent") throw new Error("check must be an agent node");
    const state = {
      steps: [{ nodeId: "check", outcome: "ok" }],
    } as never;
    const prompt = await checkNode.prompt({
      input: input(),
      outputs: {
        prepare: prepareMonitorInput(input()),
        check: check({ observation: "The target is at 4 of 10." }),
        estimate: { tracks: [] },
      },
      results: {},
      state,
      signal: new AbortController().signal,
    });
    expect(prompt).toContain("Perform monitoring check 2 of at most 5");
    expect(prompt).toContain("Previous accepted observation: The target is at 4 of 10.");
    expect(prompt).toContain("You are the regular Pi model running this check");
    expect(prompt).toContain("publish them with workflow action update");
    expect(prompt).toContain("Do not require the monitored target to implement a Pi-specific");
    expect(executor).toBeDefined();
  });

  it("requires explicit authorization and details for repair routes", () => {
    const repair = check({
      route: "repair",
      observation: "A fixable defect is present.",
      report: "A fixable defect is present.",
      repair: {
        problem: "Fix the defect",
        evidence: { failingTest: "test-a" },
        issueFingerprint: "issue-a-state-1",
      },
    });
    expect(() => validateMonitorCheck(repair)).toThrow("authorization");
    expect(validateMonitorCheck(repair, true)).toMatchObject({
      route: "repair",
      repair: { issueFingerprint: "issue-a-state-1" },
    });
    expect(() => validateMonitorCheck({ ...repair, repair: undefined }, true)).toThrow(
      "requires repair details",
    );
  });

  it("rejects quiet routes, missing reports, duplicate tracks, and unknown fields", () => {
    expect(() => validateMonitorCheck(check({ route: "stop_quiet" }))).toThrow("route");
    const { report: _report, ...withoutReport } = check();
    expect(() => validateMonitorCheck(withoutReport)).toThrow("report");
    expect(() => validateMonitorCheck(check({ extra: true }))).toThrow("not supported");
    expect(() =>
      validateMonitorCheck(
        check({
          progress: {
            tracks: [
              { key: "same", data: progress(1, 2) },
              { key: "same", data: progress(1, 2) },
            ],
          },
        }),
      ),
    ).toThrow("duplicated");
  });

  it("mounts outer design and implementation while keeping observation-only defaults", () => {
    expect(prepareMonitorInput(input()).repair).toBeUndefined();
    expect(
      prepareMonitorInput(input({ repair: { authorized: true, scope: "current repo" } })),
    ).toMatchObject({
      repair: { authorized: true, scope: "current repo" },
    });
    expect(Object.keys(monitor.includes ?? {})).toEqual(["initialDesign", "implementation"]);
  });

  it("has no presentation prompt, report acknowledgement, or quiet routing", () => {
    expect(monitor.presentationPrompt).toBeUndefined();
    expect(monitor.nodes.report?.nodeType).toBe("notify");
    expect(monitor.nodes.report_continue).toBeUndefined();
    expect(monitor.nodes.report_stop).toBeUndefined();
    expect(JSON.stringify(monitor.edges)).not.toContain("quiet");
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
