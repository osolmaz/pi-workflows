import { describe, expect, it } from "vitest";
import monitor from "../src/builtins/monitor.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type {
  AgentStepExecutor,
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
    const outputs = [
      {
        route: "stop_report",
        observation: "The Linux check failed.",
        report: "PR 123 now has a failed Linux check.",
        reason: "A requested report condition is true and the pull request closed.",
      },
      { reported: true },
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
    });

    const result = await engine.run(monitor, monitorInput());

    expect(result.state.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("PR 123 now has a failed Linux check.");
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
    [{ task: 1, everyMinutes: 30 }, "task must be a string"],
    [{ task: " ", everyMinutes: 30 }, "task must not be empty"],
    [{ task: "x".repeat(8_001), everyMinutes: 30 }, "task must be at most 8000"],
    [{ task: "check", everyMinutes: 1.5 }, "everyMinutes must be an integer"],
    [{ task: "check", everyMinutes: 30, maxChecks: 0 }, "maxChecks must be an integer"],
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
    const invalidAck = new WorkflowEngine({
      executor: scriptedExecutor([
        {
          route: "stop_report",
          observation: "state",
          report: "State changed.",
          reason: "report",
        },
        { reported: false },
      ]),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-bad-ack")),
    });

    const [badCheck, noReport, badAck] = await Promise.all([
      invalidCheck.run(monitor, monitorInput()),
      missingReport.run(monitor, monitorInput()),
      invalidAck.run(monitor, monitorInput()),
    ]);

    expect(badCheck.state.error).toContain("route must be one of");
    expect(noReport.state.error).toContain("requires a report");
    expect(badAck.state.error).toContain("reported to true");
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
