import { agent, compute, defineWorkflow, shell } from "../workflows/index.js";
import type { WorkflowNodeContext } from "../workflows/types.js";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_MAX_CHECKS = 1_000;
const MAX_CHECKS = 1_000;
const MAX_OBSERVATION_CHARS = 8_000;
const MAX_REPORT_CHARS = 4_000;
const MAX_REASON_CHARS = 2_000;
const SLEEP_TIMEOUT_MARGIN_MS = 60_000;
const NODE_TIMEOUT_MARGIN_MS = 2 * 60_000;

type MonitorInput = {
  task: string;
  everyMinutes: number;
  reportWhen?: string;
  stopWhen?: string;
  maxChecks?: number;
};

type MonitorConfig = {
  task: string;
  everyMinutes: number;
  reportWhen: string;
  stopWhen: string;
  maxChecks: number;
};

type MonitorRoute = "continue_quiet" | "continue_report" | "stop_quiet" | "stop_report";

type MonitorCheck = {
  route: MonitorRoute;
  observation: string;
  report?: string;
  reason: string;
};

const MONITOR_ROUTES = new Set<MonitorRoute>([
  "continue_quiet",
  "continue_report",
  "stop_quiet",
  "stop_report",
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (trimmed.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters`);
  }
  return trimmed;
}

function prepareInput(input: unknown): MonitorConfig {
  const value = requireRecord(input, "monitor input") as Partial<MonitorInput>;
  const task = requireBoundedString(value.task, "task", 8_000);
  if (
    typeof value.everyMinutes !== "number" ||
    !Number.isInteger(value.everyMinutes) ||
    value.everyMinutes < MIN_INTERVAL_MINUTES ||
    value.everyMinutes > MAX_INTERVAL_MINUTES
  ) {
    throw new Error(
      `everyMinutes must be an integer from ${MIN_INTERVAL_MINUTES} through ${MAX_INTERVAL_MINUTES}`,
    );
  }
  const maxChecks = value.maxChecks ?? DEFAULT_MAX_CHECKS;
  if (!Number.isInteger(maxChecks) || maxChecks <= 0 || maxChecks > MAX_CHECKS) {
    throw new Error(`maxChecks must be an integer from 1 through ${MAX_CHECKS}`);
  }
  return {
    task,
    everyMinutes: value.everyMinutes,
    reportWhen:
      value.reportWhen === undefined
        ? "The observed state changes materially or needs the user's attention."
        : requireBoundedString(value.reportWhen, "reportWhen", 4_000),
    stopWhen:
      value.stopWhen === undefined
        ? "The user cancels the monitor or it reaches its maximum check count."
        : requireBoundedString(value.stopWhen, "stopWhen", 4_000),
    maxChecks,
  };
}

function configFrom(outputs: Record<string, unknown>): MonitorConfig {
  return outputs.prepare as MonitorConfig;
}

function completedChecks(context: WorkflowNodeContext): number {
  return context.state.steps.filter((step) => step.nodeId === "check" && step.outcome === "ok")
    .length;
}

function validateCheck(output: unknown): MonitorCheck {
  const value = requireRecord(output, "monitor check output");
  if (typeof value.route !== "string" || !MONITOR_ROUTES.has(value.route as MonitorRoute)) {
    throw new Error(`route must be one of ${[...MONITOR_ROUTES].join(", ")}`);
  }
  const route = value.route as MonitorRoute;
  const observation = requireBoundedString(value.observation, "observation", MAX_OBSERVATION_CHARS);
  const reason = requireBoundedString(value.reason, "reason", MAX_REASON_CHARS);
  const reports = route === "continue_report" || route === "stop_report";
  const report =
    value.report === undefined
      ? undefined
      : requireBoundedString(value.report, "report", MAX_REPORT_CHARS);
  if (reports && report === undefined) {
    throw new Error(`route ${route} requires a report`);
  }
  return {
    route,
    observation,
    ...(report !== undefined ? { report } : {}),
    reason,
  };
}

function validateReportAck(output: unknown): { reported: true } {
  const value = requireRecord(output, "report acknowledgement");
  if (value.reported !== true) {
    throw new Error("report acknowledgement must set reported to true");
  }
  return { reported: true };
}

function reportPrompt(outputs: Record<string, unknown>): string {
  const check = outputs.check as MonitorCheck;
  return [
    "Write one concise normal assistant message to the user with this monitoring update:",
    check.report ?? check.observation,
    "Do not add unrelated detail.",
    "After writing the update, submit the acknowledgement required by the workflow step contract.",
  ].join("\n\n");
}

export default defineWorkflow({
  name: "monitor",
  title: ({ input }) => {
    try {
      const task = prepareInput(input).task;
      return `monitor: ${task.slice(0, 80)}`;
    } catch {
      return "monitor";
    }
  },
  presentationPrompt: ({ finalOutput }) => {
    const result = requireRecord(finalOutput, "monitor result");
    if (result.reported === true) {
      return undefined;
    }
    return `Tell the user concisely why this monitor stopped: ${String(result.reason ?? "monitor ended")}`;
  },
  startAt: "prepare",
  maxSteps: 5_010,
  nodes: {
    prepare: compute({
      run: ({ input }) => prepareInput(input),
    }),
    guard: compute({
      run: (context) => {
        const config = configFrom(context.outputs);
        const checks = completedChecks(context);
        return checks >= config.maxChecks
          ? { route: "stop", checks, reason: `Reached the ${config.maxChecks}-check limit.` }
          : { route: "check", checks };
      },
    }),
    continue_guard: compute({
      run: (context) => {
        const config = configFrom(context.outputs);
        const checks = completedChecks(context);
        return checks >= config.maxChecks
          ? { route: "stop", checks, reason: `Reached the ${config.maxChecks}-check limit.` }
          : { route: "sleep", checks };
      },
    }),
    check: agent({
      statusDetail: "checking monitored target",
      prompt: (context) => {
        const config = configFrom(context.outputs);
        const previous = context.outputs.check as MonitorCheck | undefined;
        const checkNumber = completedChecks(context) + 1;
        return [
          `Perform monitoring check ${checkNumber} of at most ${config.maxChecks}.`,
          `Task: ${config.task}`,
          `Report when: ${config.reportWhen}`,
          `Stop when: ${config.stopWhen}`,
          previous === undefined
            ? "There is no previous observation. Report the initial state only when the report condition calls for it."
            : `Previous accepted observation: ${previous.observation}`,
          "Use available tools to inspect the current state. Observe only unless the task explicitly authorizes a mutation.",
          "Choose continue_quiet, continue_report, stop_quiet, or stop_report. A report route requires concise report text.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "route": "continue_quiet" | "continue_report" | "stop_quiet" | "stop_report", "observation": "current factual state", "report": "required for report routes", "reason": "short reason" }',
      validate: (output) => validateCheck(output),
    }),
    report_continue: agent({
      statusDetail: "reporting monitor update",
      prompt: ({ outputs }) => reportPrompt(outputs),
      expectedOutput: '{ "reported": true }',
      validate: (output) => validateReportAck(output),
    }),
    report_stop: agent({
      statusDetail: "reporting final monitor update",
      prompt: ({ outputs }) => reportPrompt(outputs),
      expectedOutput: '{ "reported": true }',
      validate: (output) => validateReportAck(output),
    }),
    sleep: shell({
      statusDetail: "waiting for next monitor check",
      timeoutMs: MAX_INTERVAL_MINUTES * 60_000 + NODE_TIMEOUT_MARGIN_MS,
      exec: ({ outputs }) => {
        const config = configFrom(outputs);
        const sleepMs = config.everyMinutes * 60_000;
        return {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, Number(process.argv[1]))", String(sleepMs)],
          timeoutMs: sleepMs + SLEEP_TIMEOUT_MARGIN_MS,
          maxOutputChars: 1_024,
        };
      },
      parse: (_result, { outputs }) => ({ waitedMinutes: configFrom(outputs).everyMinutes }),
    }),
    finish: compute({
      run: ({ outputs }) => {
        const check = outputs.check as MonitorCheck | undefined;
        const guard = outputs.guard as { reason?: string } | undefined;
        const continueGuard = outputs.continue_guard as { reason?: string } | undefined;
        return {
          reason: continueGuard?.reason ?? guard?.reason ?? check?.reason ?? "Monitor finished.",
          observation: check?.observation ?? null,
          reported:
            outputs.report_stop !== undefined ||
            (check !== undefined && check.route === "stop_report"),
        };
      },
    }),
  },
  edges: [
    { from: "prepare", to: "guard" },
    { from: "guard", switch: { on: "$.route", cases: { check: "check", stop: "finish" } } },
    {
      from: "check",
      switch: {
        on: "$.route",
        cases: {
          continue_quiet: "continue_guard",
          continue_report: "report_continue",
          stop_quiet: "finish",
          stop_report: "report_stop",
        },
      },
    },
    { from: "report_continue", to: "continue_guard" },
    { from: "report_stop", to: "finish" },
    {
      from: "continue_guard",
      switch: { on: "$.route", cases: { sleep: "sleep", stop: "finish" } },
    },
    { from: "sleep", to: "guard" },
  ],
});
