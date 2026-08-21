import {
  action,
  agent,
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
  notify,
  shell,
} from "../workflows/definition.js";
import {
  estimateProgress,
  formatProgressReport,
  type ProgressSample,
  type ProgressTrackState,
} from "../workflows/progress.js";
import type {
  WorkflowDefinition,
  WorkflowNodeContext,
  WorkflowProgressData,
} from "../workflows/types.js";
import { validateProgressData } from "../workflows/updates.js";
import autoimplementWorkflow, { type AutoimplementInput } from "./autoimplement.workflow.js";
import { parsePlanApprovalPolicy, type PlanApprovalPolicy } from "./plan-approval.workflow.js";
import planChangeWorkflow, { type NormalizedPlanChangeInput } from "./plan-change.workflow.js";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_CHECK_TIMEOUT_MINUTES = 5;
const MAX_CHECK_TIMEOUT_MINUTES = 24 * 60;
const DEFAULT_MIN_CHECK_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_CHECKS = 1_000;
const MAX_CHECKS = 1_000;
const MAX_TRACKS = 256;
const MAX_OBSERVATION_CHARS = 8_000;
const MAX_REPORT_CHARS = 4_000;
const MAX_REASON_CHARS = 2_000;
const SLEEP_TIMEOUT_MARGIN_MS = 60_000;
const NODE_TIMEOUT_MARGIN_MS = 2 * 60_000;

export type MonitorRepairPolicy = {
  authorized: true;
  scope?: string;
  constraints?: string[];
  repository?: string;
  baseBranch?: string;
  merge?: boolean;
  approval?: PlanApprovalPolicy;
};

export type MonitorInput = {
  task: string;
  everyMinutes?: number;
  stopWhen?: string;
  maxChecks?: number;
  checkTimeoutMinutes?: number;
  repair?: MonitorRepairPolicy;
};

type MonitorConfig = {
  task: string;
  everyMinutes: number;
  stopWhen: string;
  maxChecks: number;
  checkTimeoutMinutes: number;
  repair?: MonitorRepairPolicy;
};
type MonitorRoute = "continue" | "repair" | "stop";
type MonitorTrack = { key: string; data: WorkflowProgressData };
type MonitorRepairRequest = {
  problem: string;
  evidence: unknown;
  issueFingerprint: string;
};
type MonitorCheck = {
  route: MonitorRoute;
  observation: string;
  report: string;
  progress?: { tracks: MonitorTrack[] };
  repair?: MonitorRepairRequest;
  reason: string;
};
type MonitorEstimate = { tracks: ProgressTrackState[] };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
  return trimmed;
}

async function waitForUpdateSlot(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("monitor progress publication was cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 55);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function prepareMonitorInput(input: unknown): MonitorConfig {
  const value = requireRecord(input, "monitor input") as Partial<MonitorInput>;
  const allowed = new Set([
    "task",
    "everyMinutes",
    "stopWhen",
    "maxChecks",
    "checkTimeoutMinutes",
    "repair",
  ]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`monitor input field ${field} is not supported`);
  }
  const task = requireBoundedString(value.task, "task", 8_000);
  const everyMinutes = value.everyMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (
    !Number.isInteger(everyMinutes) ||
    everyMinutes < MIN_INTERVAL_MINUTES ||
    everyMinutes > MAX_INTERVAL_MINUTES
  ) {
    throw new Error(
      `everyMinutes must be an integer from ${MIN_INTERVAL_MINUTES} through ${MAX_INTERVAL_MINUTES}`,
    );
  }
  const maxChecks = value.maxChecks ?? DEFAULT_MAX_CHECKS;
  if (!Number.isInteger(maxChecks) || maxChecks <= 0 || maxChecks > MAX_CHECKS) {
    throw new Error(`maxChecks must be an integer from 1 through ${MAX_CHECKS}`);
  }
  const checkTimeoutMinutes =
    value.checkTimeoutMinutes ?? Math.max(DEFAULT_MIN_CHECK_TIMEOUT_MINUTES, everyMinutes);
  if (
    !Number.isInteger(checkTimeoutMinutes) ||
    checkTimeoutMinutes < MIN_CHECK_TIMEOUT_MINUTES ||
    checkTimeoutMinutes > MAX_CHECK_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `checkTimeoutMinutes must be an integer from ${MIN_CHECK_TIMEOUT_MINUTES} through ${MAX_CHECK_TIMEOUT_MINUTES}`,
    );
  }
  let repair: MonitorRepairPolicy | undefined;
  if (value.repair !== undefined) {
    const raw = requireRecord(value.repair, "repair policy");
    if (raw.authorized !== true) throw new Error("repair policy must set authorized to true");
    if (
      raw.constraints !== undefined &&
      (!Array.isArray(raw.constraints) || raw.constraints.some((item) => typeof item !== "string"))
    ) {
      throw new Error("repair constraints must be an array of strings");
    }
    if (raw.merge !== undefined && typeof raw.merge !== "boolean") {
      throw new Error("repair merge must be a boolean");
    }
    const approval = parsePlanApprovalPolicy(raw.approval);
    repair = {
      authorized: true,
      ...(raw.scope !== undefined
        ? { scope: requireBoundedString(raw.scope, "repair scope", 4_000) }
        : {}),
      ...(raw.constraints !== undefined ? { constraints: [...raw.constraints] as string[] } : {}),
      ...(raw.repository !== undefined
        ? { repository: requireBoundedString(raw.repository, "repair repository", 4_000) }
        : {}),
      ...(raw.baseBranch !== undefined
        ? { baseBranch: requireBoundedString(raw.baseBranch, "repair base branch", 256) }
        : {}),
      ...(raw.merge !== undefined ? { merge: raw.merge !== false } : {}),
      approval,
    };
  }
  return {
    task,
    everyMinutes,
    stopWhen:
      value.stopWhen === undefined
        ? "Stop only when the user explicitly asks to stop."
        : requireBoundedString(value.stopWhen, "stopWhen", 4_000),
    maxChecks,
    checkTimeoutMinutes,
    ...(repair !== undefined ? { repair } : {}),
  };
}

function configFrom(outputs: Record<string, unknown>): MonitorConfig {
  return outputs.prepare as MonitorConfig;
}

function completedChecks(context: WorkflowNodeContext): number {
  return context.state.steps.filter((step) => step.nodeId === "check" && step.outcome === "ok")
    .length;
}

export function validateMonitorCheck(output: unknown, repairAuthorized = false): MonitorCheck {
  const value = requireRecord(output, "monitor check output");
  const allowed = new Set(["route", "observation", "report", "progress", "repair", "reason"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`monitor check field ${key} is not supported`);
  if (value.route !== "continue" && value.route !== "repair" && value.route !== "stop") {
    throw new Error("route must be continue, repair, or stop");
  }
  if (value.route === "repair" && !repairAuthorized) {
    throw new Error("route repair requires explicit monitor repair authorization");
  }
  const check: MonitorCheck = {
    route: value.route,
    observation: requireBoundedString(value.observation, "observation", MAX_OBSERVATION_CHARS),
    report: requireBoundedString(value.report, "report", MAX_REPORT_CHARS),
    reason: requireBoundedString(value.reason, "reason", MAX_REASON_CHARS),
  };
  if (value.progress !== undefined) check.progress = validateMonitorProgress(value.progress);
  if (value.repair !== undefined) {
    const repair = requireRecord(value.repair, "monitor repair request");
    check.repair = {
      problem: requireBoundedString(repair.problem, "repair problem", 8_000),
      evidence: repair.evidence ?? null,
      issueFingerprint: requireBoundedString(
        repair.issueFingerprint,
        "repair issue fingerprint",
        256,
      ),
    };
  }
  if (value.route === "repair" && check.repair === undefined) {
    throw new Error("route repair requires repair details");
  }
  return check;
}

function validateMonitorProgress(input: unknown): { tracks: MonitorTrack[] } {
  const value = requireRecord(input, "progress");
  if (Object.keys(value).some((key) => key !== "tracks"))
    throw new Error("progress only supports tracks");
  if (!Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > MAX_TRACKS) {
    throw new Error(`progress.tracks must contain 1 through ${MAX_TRACKS} entries`);
  }
  const keys = new Set<string>();
  const tracks = value.tracks.map((raw, index) => {
    const track = requireRecord(raw, `progress.tracks[${index}]`);
    if (Object.keys(track).some((key) => key !== "key" && key !== "data")) {
      throw new Error(`progress.tracks[${index}] has an unsupported field`);
    }
    const key = requireBoundedString(track.key, `progress.tracks[${index}].key`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key))
      throw new Error(`progress.tracks[${index}].key is invalid`);
    if (keys.has(key)) throw new Error(`progress track key ${key} is duplicated`);
    keys.add(key);
    return {
      key,
      data: validateProgressData(requireRecord(track.data, `progress.tracks[${index}].data`)),
    };
  });
  return { tracks };
}

function estimateTracks(outputs: Record<string, unknown>): MonitorEstimate {
  const check = outputs.check as MonitorCheck;
  if (check.progress === undefined) return { tracks: [] };
  const previous = outputs.estimate as MonitorEstimate | undefined;
  const previousByKey = new Map((previous?.tracks ?? []).map((track) => [track.key, track]));
  const at = new Date().toISOString();
  return {
    tracks: check.progress.tracks.map((track) => {
      const samples: ProgressSample[] = [
        ...(previousByKey.get(track.key)?.samples ?? []),
        { at, data: track.data },
      ].slice(-9);
      return { key: track.key, samples, estimate: estimateProgress(track.key, samples) };
    }),
  };
}

function repeatedRepairWithoutProgress(context: WorkflowNodeContext): boolean {
  const current = context.outputs.check as MonitorCheck;
  const fingerprint = current.repair?.issueFingerprint;
  if (fingerprint === undefined) return false;
  const steps = context.state.steps;
  const currentCheckIndex = steps.findLastIndex((step) => step.nodeId === "check");
  for (let index = currentCheckIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.nodeId !== "check") continue;
    const prior = step.output as MonitorCheck;
    if (prior.repair?.issueFingerprint !== fingerprint) continue;
    return steps
      .slice(index + 1, currentCheckIndex)
      .some((candidate) => candidate.nodeId === "implementation");
  }
  return false;
}

function currentRepairPlan(outputs: Record<string, unknown>): {
  plan: unknown;
  planDigest: string;
  documents: string[];
} {
  const result = includedResult(planChangeWorkflow, outputs.planChange);
  if (result.exit !== "ready") throw new Error("monitor plan change did not return a ready plan");
  return {
    plan: result.output.plan,
    planDigest: result.output.planDigest,
    documents: result.output.documents,
  };
}

function repairBlockedReason(outputs: Record<string, unknown>): string {
  const guard = outputs.repairGuard as { reason?: string; route?: string } | undefined;
  if (guard?.route === "blocked" && guard.reason !== undefined) return guard.reason;
  const planChange = outputs.planChange as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  const implementation = outputs.implementation as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  return (
    implementation?.output?.reason ??
    planChange?.output?.reason ??
    "The repair did not produce new verified progress."
  );
}

function reportMessage(context: WorkflowNodeContext): string {
  const check = context.outputs.check as MonitorCheck;
  const estimate = context.outputs.estimate as MonitorEstimate;
  const config = configFrom(context.outputs);
  const suffix: string[] = [];
  if (estimate.tracks.length > 0) {
    suffix.push(
      formatProgressReport(
        estimate.tracks.map((track) => track.estimate),
        check.route === "continue" ? config.everyMinutes : undefined,
        new Date(),
        2_000,
      ),
    );
  }
  if (check.route === "continue" && completedChecks(context) >= config.maxChecks) {
    suffix.push(`Reached the ${config.maxChecks}-check safety limit.`);
  }
  const suffixText = suffix.filter(Boolean).join("\n");
  if (suffixText.length === 0) return check.report;
  const reportBudget = Math.max(1, MAX_REPORT_CHARS - suffixText.length - 1);
  const report =
    check.report.length <= reportBudget
      ? check.report
      : `${check.report.slice(0, Math.max(0, reportBudget - 1))}…`;
  return `${report}\n${suffixText}`;
}

const monitorWorkflow: WorkflowDefinition = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.monitor.v1",
  name: "monitor",
  input: prepareMonitorInput,
  title: ({ input }) => {
    try {
      return `monitor: ${prepareMonitorInput(input).task.slice(0, 80)}`;
    } catch {
      return "monitor";
    }
  },
  startAt: "prepare",
  maxSteps: 200_000,
  includes: {
    planChange: includeWorkflow(planChangeWorkflow, {
      input: ({ outputs }): NormalizedPlanChangeInput => {
        const config = configFrom(outputs);
        const repair = (outputs.check as MonitorCheck).repair;
        if (repair === undefined) throw new Error("monitor repair details are missing");
        const prior = outputs.planChange as
          | { exit?: string; output?: { plan?: unknown } }
          | undefined;
        return {
          task: repair.problem,
          ...(config.repair?.scope !== undefined ? { scope: config.repair.scope } : {}),
          ...(config.repair?.constraints !== undefined
            ? { constraints: config.repair.constraints }
            : {}),
          ...(config.repair?.repository !== undefined
            ? { repository: config.repair.repository }
            : {}),
          ...(prior?.exit === "ready" && prior.output?.plan !== undefined
            ? { previousPlan: prior.output.plan }
            : {}),
          newEvidence: repair.evidence,
          approval: parsePlanApprovalPolicy(config.repair?.approval),
        };
      },
    }),
    implementation: includeWorkflow({
      workflow: "autoimplement",
      contract: autoimplementWorkflow,
      input: ({ outputs }) => {
        const config = configFrom(outputs);
        const repair = (outputs.check as MonitorCheck).repair;
        const documented = currentRepairPlan(outputs);
        if (repair === undefined) throw new Error("monitor repair details are missing");
        const request: AutoimplementInput = {
          task: repair.problem,
          plan: documented.plan,
          documentation: {
            status: "current",
            planDigest: documented.planDigest,
            documents: documented.documents,
          },
          ...(config.repair?.scope !== undefined ? { scope: config.repair.scope } : {}),
          ...(config.repair?.constraints !== undefined
            ? { constraints: config.repair.constraints }
            : {}),
          ...(config.repair?.repository !== undefined
            ? { repository: config.repair.repository }
            : {}),
          ...(config.repair?.baseBranch !== undefined
            ? { baseBranch: config.repair.baseBranch }
            : {}),
          approval: parsePlanApprovalPolicy(config.repair?.approval),
          merge: config.repair?.merge === true,
        };
        return request;
      },
    }),
  },
  nodes: {
    prepare: compute({ run: ({ input }) => prepareMonitorInput(input) }),
    check: agent({
      statusDetail: "checking monitored target",
      timeoutMs: ({ outputs }) => configFrom(outputs).checkTimeoutMinutes * 60_000,
      prompt: (context) => {
        const config = configFrom(context.outputs);
        const previous = context.outputs.check as MonitorCheck | undefined;
        const priorEstimate = context.outputs.estimate as MonitorEstimate | undefined;
        return [
          `Perform monitoring check ${completedChecks(context) + 1} of at most ${config.maxChecks}.`,
          `Task: ${config.task}`,
          `Stop when: ${config.stopWhen}`,
          previous === undefined
            ? "There is no previous observation."
            : `Previous accepted observation: ${previous.observation}`,
          priorEstimate?.tracks.length
            ? `Previous progress: ${formatProgressReport(priorEstimate.tracks.map((track) => track.estimate))}`
            : "There is no previous measured progress.",
          config.repair === undefined
            ? "Observe only. This monitor has no mutation authorization."
            : "Repair is explicitly authorized within the supplied repair policy. Choose repair only for a concrete issue that can be changed within that scope. Include a stable issue fingerprint based on the issue and observed target state. Do not change protected model, benchmark, credential, hardware, spending, or scope decisions.",
          "Use available tools to inspect the current source of truth.",
          "You are the regular Pi model running this check and the observation adapter. When useful measurable facts appear during the check, publish them with workflow action update. Include the latest tracks in the final submission. Do not require the monitored target to implement a Pi-specific progress API, file, store, schema, or command.",
          "Every accepted check must include a concise user-facing report. Add progress tracks only when the target provides measurable facts. Submit observed counts and target-provided finish times; do not invent rates or an ETA.",
          config.repair === undefined
            ? "Choose route continue or stop."
            : "Choose route continue, repair, or stop.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "route": "continue" | "repair" | "stop", "observation": "current factual state", "report": "concise status update", "progress": { "tracks": [{ "key": "stable-key", "data": { "schema": "pi-workflows.progress.v1", "status": "running", "completed": 1, "total": 2, "unit": "items" } }] } (optional), "repair": { "problem": "fixable issue", "evidence": "observed evidence", "issueFingerprint": "stable issue and target-state fingerprint" } (required for repair), "reason": "short reason" }',
      validate: (output, context) =>
        validateMonitorCheck(output, configFrom(context.outputs).repair !== undefined),
    }),
    estimate: compute({ run: ({ outputs }) => estimateTracks(outputs) }),
    publish_progress: action({
      statusDetail: "publishing monitor progress",
      run: async ({ outputs, publishUpdate, signal }) => {
        const check = outputs.check as MonitorCheck;
        if (check.progress === undefined) return { published: 0 };
        for (const track of check.progress.tracks) {
          await waitForUpdateSlot(signal);
          await publishUpdate({ type: "progress", key: track.key, data: track.data });
        }
        return { published: check.progress.tracks.length };
      },
    }),
    report: notify({
      statusDetail: "queueing monitor update",
      message: (context) => reportMessage(context),
      kind: "progress",
    }),
    decide: compute({
      run: (context) => {
        const check = context.outputs.check as MonitorCheck;
        const config = configFrom(context.outputs);
        const checks = completedChecks(context);
        if (check.route === "stop") return { route: "stop", reason: check.reason, checks };
        if (checks >= config.maxChecks) {
          return {
            route: "stop",
            reason: `Reached the ${config.maxChecks}-check safety limit.`,
            checks,
          };
        }
        if (check.route === "repair") return { route: "repair", reason: check.reason, checks };
        return { route: "continue", reason: check.reason, checks };
      },
    }),
    repairGuard: compute({
      run: (context) =>
        repeatedRepairWithoutProgress(context)
          ? {
              route: "blocked",
              reason:
                "The same issue returned after a completed repair with no changed target evidence.",
            }
          : { route: "repair", reason: "The issue is new or has changed evidence." },
    }),
    repairBlocked: compute({
      run: (context) => ({
        reason: repairBlockedReason(context.outputs),
        observation: (context.outputs.check as MonitorCheck).observation,
        checks: completedChecks(context),
        reported: true,
      }),
    }),
    repairReport: notify({
      statusDetail: "reporting blocked monitor repair",
      kind: "final",
      message: ({ outputs }) => {
        const result = outputs.repairBlocked as { reason: string };
        return `Automatic repair stopped: ${result.reason}`;
      },
    }),
    schedule: action({
      statusDetail: "scheduling next monitor check",
      run: async ({ outputs, publishUpdate }) => {
        const config = configFrom(outputs);
        const lastCheckAt = new Date().toISOString();
        const nextCheckAt = new Date(
          Date.parse(lastCheckAt) + config.everyMinutes * 60_000,
        ).toISOString();
        await publishUpdate({
          type: "monitor.schedule",
          key: "next-check",
          data: {
            schema: "pi-workflows.monitor-schedule.v1",
            lastCheckAt,
            nextCheckAt,
            everyMinutes: config.everyMinutes,
          },
        });
        return { lastCheckAt, nextCheckAt, everyMinutes: config.everyMinutes };
      },
    }),
    sleep: shell({
      statusDetail: "waiting for next monitor check",
      timeoutMs: MAX_INTERVAL_MINUTES * 60_000 + NODE_TIMEOUT_MARGIN_MS,
      exec: ({ outputs }) => {
        const sleepMs = configFrom(outputs).everyMinutes * 60_000;
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
        const check = outputs.check as MonitorCheck;
        const decision = outputs.decide as { reason?: string; checks?: number } | undefined;
        const repair = outputs.repairBlocked as { reason?: string } | undefined;
        return {
          reason: repair?.reason ?? decision?.reason ?? check.reason,
          observation: check.observation,
          checks: decision?.checks ?? 1,
          reported: true,
          ...(outputs.implementation !== undefined
            ? { repair: outputs.implementation }
            : repair !== undefined
              ? { repair }
              : {}),
        };
      },
    }),
  },
  edges: [
    { from: "prepare", to: "check" },
    { from: "check", to: "estimate" },
    { from: "estimate", to: "publish_progress" },
    { from: "publish_progress", to: "report" },
    { from: "report", to: "decide" },
    {
      from: "decide",
      switch: {
        on: "$.route",
        cases: { stop: "finish", continue: "schedule", repair: "repairGuard" },
      },
    },
    {
      from: "repairGuard",
      switch: { on: "$.route", cases: { repair: "planChange", blocked: "repairBlocked" } },
    },
    { from: "planChange.ready", to: "implementation" },
    { from: "planChange.blocked", to: "repairBlocked" },
    { from: "implementation.completed", to: "check" },
    { from: "implementation.blocked", to: "repairBlocked" },
    { from: "repairBlocked", to: "repairReport" },
    { from: "repairReport", to: "finish" },
    { from: "schedule", to: "sleep" },
    { from: "sleep", to: "check" },
  ],
});

export default monitorWorkflow;
