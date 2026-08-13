import { describe, expect, it } from "vitest";
import monitor from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type {
  AgentNodeDefinition,
  AgentStepExecutor,
  ComputeNodeDefinition,
  NotifyNodeDefinition,
  ShellActionNodeDefinition,
  WorkflowNodeContext,
} from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function scriptedExecutor(outputs: unknown[]): AgentStepExecutor {
  const remaining = [...outputs];
  return {
    async runAgentStep(request) {
      const output = remaining.shift();
      if (output === undefined) {
        throw new Error("No scripted monitor output remains");
      }
      const accepted = await request.accept(output);
      if (!accepted.ok) {
        throw new Error(accepted.error);
      }
      return { output: accepted.value };
    },
  };
}

function monitorInput(overrides: Record<string, unknown> = {}) {
  return {
    task: "Check pull request 123",
    everyMinutes: 30,
    reportWhen: "Checks fail",
    stopWhen: "The pull request is merged or closed",
    maxChecks: 5,
    ...overrides,
  };
}

describe("built-in monitor workflow", () => {
  it("finishes quietly when the first check meets the stop condition", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_quiet",
          observation: "Pull request 123 is merged.",
          reason: "The configured stop condition is true.",
        },
      ]),
      store: new WorkflowRunStore(outputRoot),
    });

    const result = await engine.run(monitor, monitorInput());

    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      reason: "The configured stop condition is true.",
      observation: "Pull request 123 is merged.",
      reported: false,
    });
  });

  it("runs a report step before finishing when the check asks to report", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-report");
    const prompts: string[] = [];
    const notifications: { content: string; notificationIndex: number }[] = [];
    const outputs = [
      {
        route: "stop_report",
        observation: "The Linux check failed.",
        report: "PR 123 now has a failed Linux check.",
        reason: "A requested report condition is true and the pull request closed.",
      },
    ];
    const executor: AgentStepExecutor = {
      async runAgentStep(request) {
        prompts.push(request.prompt);
        const output = outputs.shift();
        const accepted = await request.accept(output);
        if (!accepted.ok) {
          throw new Error(accepted.error);
        }
        return { output: accepted.value };
      },
    };
    const engine = new WorkflowEngine({
      executor,
      store: new WorkflowRunStore(outputRoot),
      notificationSink: {
        notify: (request) => {
          notifications.push({
            content: request.content,
            notificationIndex: request.notificationIndex,
          });
          return { notificationId: "notification-1", targetSessionId: "session-1" };
        },
      },
    });

    const result = await engine.run(monitor, monitorInput());

    expect(result.state.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(notifications).toEqual([
      { content: "PR 123 now has a failed Linux check.", notificationIndex: 1 },
    ]);
    expect(result.state.finalOutput).toMatchObject({ reported: true });
  });

  it("stops at the check limit before starting another sleep", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-limit");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "continue_quiet",
          observation: "Pull request 123 is still open.",
          reason: "The stop condition is not true.",
        },
      ]),
      store: new WorkflowRunStore(outputRoot),
    });

    const result = await engine.run(monitor, monitorInput({ maxChecks: 1 }));

    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      reason: "Reached the 1-check limit.",
      observation: "Pull request 123 is still open.",
    });
    expect(result.state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
  });

  it.each([
    [null, "monitor input must be an object"],
    [[], "monitor input must be an object"],
    [{ task: 1, everyMinutes: 30 }, "task must be a string"],
    [{ task: " ", everyMinutes: 30 }, "task must not be empty"],
    [{ task: "x".repeat(8_001), everyMinutes: 30 }, "task must be at most 8000"],
    [{ task: "check", everyMinutes: "30" }, "everyMinutes must be an integer"],
    [{ task: "check", everyMinutes: 1.5 }, "everyMinutes must be an integer"],
    [{ task: "check", everyMinutes: 0 }, "everyMinutes must be an integer"],
    [{ task: "check", everyMinutes: 1_441 }, "everyMinutes must be an integer"],
    [{ task: "check", everyMinutes: 30, maxChecks: 1.5 }, "maxChecks must be an integer"],
    [{ task: "check", everyMinutes: 30, maxChecks: 0 }, "maxChecks must be an integer"],
    [{ task: "check", everyMinutes: 30, maxChecks: 1_001 }, "maxChecks must be an integer"],
    [{ task: "check", everyMinutes: 30, reportWhen: false }, "reportWhen must be a string"],
    [{ task: "check", everyMinutes: 30, stopWhen: " " }, "stopWhen must not be empty"],
  ])("rejects invalid monitor input %#", async (input, expectedError) => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-input");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([]),
      store: new WorkflowRunStore(outputRoot),
    });

    const result = await engine.run(monitor, input);

    expect(result.state.status).toBe("failed");
    expect(result.state.error).toContain(expectedError);
    expect(result.state.steps).toHaveLength(1);
  });

  it("applies default report, stop, and check limits", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-defaults");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_quiet",
          observation: "Initial state",
          reason: "Done",
        },
      ]),
      store: new WorkflowRunStore(outputRoot),
    });

    const result = await engine.run(monitor, { task: "Check a target", everyMinutes: 30 });

    expect(result.state.status).toBe("completed");
    expect(result.state.outputs.prepare).toMatchObject({
      maxChecks: 1_000,
      reportWhen: expect.stringContaining("changes materially"),
      stopWhen: expect.stringContaining("maximum check count"),
    });
  });

  it("rejects invalid check and report outputs", async () => {
    const invalidCheck = new WorkflowEngine({
      executor: scriptedExecutor([{ route: "unknown", observation: "state", reason: "bad route" }]),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-bad-check")),
    });
    const missingReport = new WorkflowEngine({
      executor: scriptedExecutor([
        { route: "stop_report", observation: "state", reason: "missing report" },
      ]),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-no-report")),
    });
    const noSink = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_report",
          observation: "state",
          report: "State changed.",
          reason: "report",
        },
      ]),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-no-sink")),
    });

    const [badCheck, noReport, missingSink] = await Promise.all([
      invalidCheck.run(monitor, monitorInput()),
      missingReport.run(monitor, monitorInput()),
      noSink.run(monitor, monitorInput()),
    ]);

    expect(badCheck.state.error).toContain("route must be one of");
    expect(noReport.state.error).toContain("requires a report");
    expect(missingSink.state.error).toContain("requires a notification sink");
  });

  it("formats monitor prompts, guards, and fallback output", async () => {
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_quiet",
          observation: "Initial state",
          reason: "Test complete",
        },
      ]),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-callbacks")),
    });
    const result = await engine.run(monitor, monitorInput());
    const context: WorkflowNodeContext = {
      input: result.state.input,
      outputs: result.state.outputs,
      results: result.state.results,
      state: result.state,
      signal: new AbortController().signal,
    };

    if (typeof monitor.title !== "function" || typeof monitor.presentationPrompt !== "function") {
      throw new Error("Monitor title and presentation prompt must be functions");
    }
    expect(await monitor.title({ input: monitorInput(), workflowName: "monitor" })).toContain(
      "monitor: Check pull request 123",
    );
    expect(await monitor.title({ input: null, workflowName: "monitor" })).toBe("monitor");
    expect(
      await monitor.presentationPrompt({
        state: result.state,
        finalOutput: { reported: true },
        signal: context.signal,
      }),
    ).toBeUndefined();
    expect(
      await monitor.presentationPrompt({
        state: result.state,
        finalOutput: {},
        signal: context.signal,
      }),
    ).toContain("monitor ended");

    const check = monitor.nodes.check as AgentNodeDefinition;
    expect(await check.prompt(context)).toContain("Previous accepted observation: Initial state");
    const report = monitor.nodes.report_stop as NotifyNodeDefinition;
    expect(
      await report.message({
        ...context,
        outputs: { check: { observation: "Fallback observation" } },
      }),
    ).toContain("Fallback observation");

    const guard = monitor.nodes.guard as ComputeNodeDefinition;
    expect(
      await guard.run({
        ...context,
        outputs: {
          ...context.outputs,
          prepare: { ...monitorInput(), maxChecks: 1 },
        },
      }),
    ).toMatchObject({ route: "stop", checks: 1, reason: "Reached the 1-check limit." });
    const continueGuard = monitor.nodes.continue_guard as ComputeNodeDefinition;
    expect(await continueGuard.run(context)).toMatchObject({ route: "sleep", checks: 1 });
    const finish = monitor.nodes.finish as ComputeNodeDefinition;
    expect(await finish.run({ ...context, outputs: {} })).toEqual({
      reason: "Monitor finished.",
      observation: null,
      reported: false,
    });
  });

  it("derives agent timeouts from the prepared monitor configuration", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-timeout");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_quiet",
          observation: "Initial state",
          reason: "Test complete",
        },
      ]),
      store: new WorkflowRunStore(outputRoot),
    });
    const result = await engine.run(monitor, monitorInput({ checkTimeoutMinutes: 90 }));
    const context: WorkflowNodeContext = {
      input: result.state.input,
      outputs: result.state.outputs,
      results: result.state.results,
      state: result.state,
      signal: new AbortController().signal,
    };

    const node = monitor.nodes.check as AgentNodeDefinition;
    expect(node.timeoutMs).toBeTypeOf("function");
    expect(await (node.timeoutMs as (context: WorkflowNodeContext) => number)(context)).toBe(
      90 * 60_000,
    );
    expect(result.state.outputs.prepare).toMatchObject({ checkTimeoutMinutes: 90 });
  });

  it("defaults the agent timeout to at least 60 minutes", async () => {
    const prepare = monitor.nodes.prepare as ComputeNodeDefinition;
    const state = {
      steps: [],
    } as never;
    const context = {
      input: monitorInput({ everyMinutes: 30 }),
      outputs: {},
      results: {},
      state,
      signal: new AbortController().signal,
    } satisfies WorkflowNodeContext;

    expect(await prepare.run(context)).toMatchObject({ checkTimeoutMinutes: 60 });
    expect(() =>
      prepare.run({ ...context, input: monitorInput({ checkTimeoutMinutes: 4 }) }),
    ).toThrow(/checkTimeoutMinutes/);
  });

  it("configures a 30-minute shell sleep above both timeout limits", async () => {
    const outputRoot = await makeTempDir("pi-workflows-monitor-sleep");
    const engine = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_quiet",
          observation: "Initial state",
          reason: "Test complete",
        },
      ]),
      store: new WorkflowRunStore(outputRoot),
    });
    const result = await engine.run(monitor, monitorInput());
    const sleep = monitor.nodes.sleep as ShellActionNodeDefinition;
    const context: WorkflowNodeContext = {
      input: result.state.input,
      outputs: result.state.outputs,
      results: result.state.results,
      state: result.state,
      signal: new AbortController().signal,
    };

    const execution = await sleep.exec(context);

    expect(execution).toMatchObject({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, Number(process.argv[1]))", "1800000"],
    });
    expect(execution.timeoutMs).toBeGreaterThan(30 * 60_000);
    expect(sleep.timeoutMs).toBeGreaterThan(30 * 60_000);
  });
});
