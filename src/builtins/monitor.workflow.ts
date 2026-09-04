import {
  action,
  agent,
  compute,
  defineWorkflow,
  idempotentEffect,
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
import {
  parsePlanApprovalPolicy,
  type ResolvedPlanApprovalPolicy,
} from "./plan-approval.workflow.js";
import planChangeWorkflow, { type NormalizedPlanChangeInput } from "./plan-change.workflow.js";

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_CHECK_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_CHECKS = 1_000;
const MAX_CHECKS = 1_000;
const MAX_TRACKS = 256;
const MAX_OBSERVATION_CHARS = 8_000;
const MAX_REPORT_CHARS = 4_000;
const MAX_REASON_CHARS = 2_000;
const MAX_ACTION_TEXT_CHARS = 8_000;
const MAX_ID_CHARS = 256;
const SLEEP_TIMEOUT_MARGIN_MS = 60_000;
const NODE_TIMEOUT_MARGIN_MS = 2 * 60_000;

export type MonitorInput = {
  task: string;
  everyMinutes?: number;
  stopWhen?: string;
  maxChecks?: number;
};

type MonitorConfig = {
  task: string;
  everyMinutes: number;
  stopWhen: string;
  maxChecks: number;
};
type MonitorRoute = "wait" | "act" | "stop";
type MonitorGoalState = "complete" | "incomplete" | "blocked";
type MonitorWorkState = "running" | "waiting" | "idle" | "failed" | "stopped" | "unknown";
type MonitorActionKind = "advance" | "recover" | "repair";
type MonitorTrack = { key: string; data: WorkflowProgressData };
type MonitorAuthority = {
  status: "authorized" | "outside";
  basis: string;
  allowedMutations: string[];
  forbiddenMutations: string[];
  costLimit: string;
  providerRuntime: string;
  requiredChecks: string[];
  stopConditions: string[];
  allowedRecoveryActions: string[];
  repository?: string;
  baseBranch?: string;
  merge: boolean;
  repairApproval: ResolvedPlanApprovalPolicy;
};
type MonitorCostSafety = {
  paidAction: boolean;
  status: "not-applicable" | "within-limit" | "missing" | "exceeded";
  evidence: string;
};
type MonitorDefectSafety = {
  sharedCodeOrDataDefect: boolean;
  paidRunners: "not-applicable" | "stopped" | "running";
  evidence: string;
};
type MonitorActionRequest = {
  kind: MonitorActionKind;
  incomplete: string;
  evidence: unknown;
  nextAction: string;
  authority: MonitorAuthority;
  cost: MonitorCostSafety;
  defect: MonitorDefectSafety;
  verification: string;
  failureId: string;
  targetStateId: string;
};
export type MonitorObservation = {
  route: MonitorRoute;
  goalState: MonitorGoalState;
  workState: MonitorWorkState;
  observation: string;
  report: string;
  targetStateId: string;
  authorizedActions: string[];
  progress?: { tracks: MonitorTrack[] };
  action?: MonitorActionRequest;
  reason: string;
};
type MonitorActionResult = {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  evidence: unknown;
  verification: string;
  failureId: string;
  targetStateId: string;
};
type MonitorEstimate = { tracks: ProgressTrackState[] };
type RecordedAction = {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  evidence: unknown;
  verification: string;
  failureId: string;
  targetStateId: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} field ${unexpected} is not supported`);
}

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
  return trimmed;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item, index) =>
    requireBoundedString(item, `${label}[${index}]`, MAX_ACTION_TEXT_CHARS),
  );
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
  const allowed = ["task", "everyMinutes", "stopWhen", "maxChecks"] as const;
  requireExactKeys(value, allowed, "monitor input");
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
  return {
    task,
    everyMinutes,
    stopWhen:
      value.stopWhen === undefined
        ? "Stop only when the user explicitly asks to stop."
        : requireBoundedString(value.stopWhen, "stopWhen", 4_000),
    maxChecks,
  };
}

function configFrom(outputs: Record<string, unknown>): MonitorConfig {
  return outputs.prepare as MonitorConfig;
}

function completedObservations(context: WorkflowNodeContext): number {
  return context.state.steps.filter((step) => step.nodeId === "observe" && step.outcome === "ok")
    .length;
}

function parseAuthority(input: unknown): MonitorAuthority {
  const value = requireRecord(input, "action authority");
  requireExactKeys(
    value,
    [
      "status",
      "basis",
      "allowedMutations",
      "forbiddenMutations",
      "costLimit",
      "providerRuntime",
      "requiredChecks",
      "stopConditions",
      "allowedRecoveryActions",
      "repository",
      "baseBranch",
      "merge",
      "repairApproval",
    ],
    "action authority",
  );
  if (value.status !== "authorized" && value.status !== "outside") {
    throw new Error("action authority status must be authorized or outside");
  }
  if (typeof value.merge !== "boolean") throw new Error("action authority merge must be boolean");
  const approval =
    value.repairApproval === undefined
      ? undefined
      : requireRecord(value.repairApproval, "repair approval");
  return {
    status: value.status,
    basis: requireBoundedString(value.basis, "action authority basis", MAX_ACTION_TEXT_CHARS),
    allowedMutations: requireStringArray(
      value.allowedMutations,
      "action authority allowedMutations",
    ),
    forbiddenMutations: requireStringArray(
      value.forbiddenMutations,
      "action authority forbiddenMutations",
    ),
    costLimit: requireBoundedString(
      value.costLimit,
      "action authority costLimit",
      MAX_ACTION_TEXT_CHARS,
    ),
    providerRuntime: requireBoundedString(
      value.providerRuntime,
      "action authority providerRuntime",
      MAX_ACTION_TEXT_CHARS,
    ),
    requiredChecks: requireStringArray(value.requiredChecks, "action authority requiredChecks"),
    stopConditions: requireStringArray(value.stopConditions, "action authority stopConditions"),
    allowedRecoveryActions: requireStringArray(
      value.allowedRecoveryActions,
      "action authority allowedRecoveryActions",
    ),
    ...(value.repository !== undefined
      ? {
          repository: requireBoundedString(value.repository, "action authority repository", 4_000),
        }
      : {}),
    ...(value.baseBranch !== undefined
      ? {
          baseBranch: requireBoundedString(value.baseBranch, "action authority baseBranch", 256),
        }
      : {}),
    merge: value.merge,
    repairApproval: parsePlanApprovalPolicy(approval),
  };
}

function parseCostSafety(input: unknown): MonitorCostSafety {
  const value = requireRecord(input, "action cost");
  requireExactKeys(value, ["paidAction", "status", "evidence"], "action cost");
  if (typeof value.paidAction !== "boolean")
    throw new Error("action cost paidAction must be boolean");
  if (
    value.status !== "not-applicable" &&
    value.status !== "within-limit" &&
    value.status !== "missing" &&
    value.status !== "exceeded"
  ) {
    throw new Error("action cost status is invalid");
  }
  return {
    paidAction: value.paidAction,
    status: value.status,
    evidence: requireBoundedString(value.evidence, "action cost evidence", MAX_ACTION_TEXT_CHARS),
  };
}

function parseDefectSafety(input: unknown): MonitorDefectSafety {
  const value = requireRecord(input, "action defect");
  requireExactKeys(value, ["sharedCodeOrDataDefect", "paidRunners", "evidence"], "action defect");
  if (typeof value.sharedCodeOrDataDefect !== "boolean") {
    throw new Error("action defect sharedCodeOrDataDefect must be boolean");
  }
  if (
    value.paidRunners !== "not-applicable" &&
    value.paidRunners !== "stopped" &&
    value.paidRunners !== "running"
  ) {
    throw new Error("action defect paidRunners is invalid");
  }
  return {
    sharedCodeOrDataDefect: value.sharedCodeOrDataDefect,
    paidRunners: value.paidRunners,
    evidence: requireBoundedString(value.evidence, "action defect evidence", MAX_ACTION_TEXT_CHARS),
  };
}

function parseActionRequest(input: unknown): MonitorActionRequest {
  const value = requireRecord(input, "monitor action request");
  requireExactKeys(
    value,
    [
      "kind",
      "incomplete",
      "evidence",
      "nextAction",
      "authority",
      "cost",
      "defect",
      "verification",
      "failureId",
      "targetStateId",
    ],
    "monitor action request",
  );
  if (value.kind !== "advance" && value.kind !== "recover" && value.kind !== "repair") {
    throw new Error("monitor action kind must be advance, recover, or repair");
  }
  const request: MonitorActionRequest = {
    kind: value.kind,
    incomplete: requireBoundedString(
      value.incomplete,
      "monitor action incomplete work",
      MAX_ACTION_TEXT_CHARS,
    ),
    evidence: value.evidence ?? null,
    nextAction: requireBoundedString(
      value.nextAction,
      "monitor action nextAction",
      MAX_ACTION_TEXT_CHARS,
    ),
    authority: parseAuthority(value.authority),
    cost: parseCostSafety(value.cost),
    defect: parseDefectSafety(value.defect),
    verification: requireBoundedString(
      value.verification,
      "monitor action verification",
      MAX_ACTION_TEXT_CHARS,
    ),
    failureId: requireBoundedString(value.failureId, "monitor action failureId", MAX_ID_CHARS),
    targetStateId: requireBoundedString(
      value.targetStateId,
      "monitor action targetStateId",
      MAX_ID_CHARS,
    ),
  };
  if (request.authority.status !== "authorized") {
    throw new Error("route act requires action authority status authorized");
  }
  if (request.authority.allowedMutations.length === 0) {
    throw new Error("route act requires at least one allowed mutation");
  }
  if (
    request.cost.paidAction &&
    (request.cost.status === "missing" || request.cost.status === "exceeded")
  ) {
    throw new Error("route act cannot launch paid work without verified remaining authority");
  }
  if (request.cost.paidAction && request.cost.status !== "within-limit") {
    throw new Error("paid route act requires cost status within-limit");
  }
  if (!request.cost.paidAction && request.cost.status !== "not-applicable") {
    throw new Error("unpaid route act requires cost status not-applicable");
  }
  if (
    request.kind === "repair" &&
    request.defect.sharedCodeOrDataDefect &&
    request.defect.paidRunners === "running"
  ) {
    throw new Error("paid workers must stop before a shared code or data repair");
  }
  return request;
}

export function validateMonitorObservation(output: unknown): MonitorObservation {
  const value = requireRecord(output, "monitor observation output");
  requireExactKeys(
    value,
    [
      "route",
      "goalState",
      "workState",
      "observation",
      "report",
      "targetStateId",
      "authorizedActions",
      "progress",
      "action",
      "reason",
    ],
    "monitor observation",
  );
  if (value.route !== "wait" && value.route !== "act" && value.route !== "stop") {
    throw new Error("route must be wait, act, or stop");
  }
  if (
    value.goalState !== "complete" &&
    value.goalState !== "incomplete" &&
    value.goalState !== "blocked"
  ) {
    throw new Error("goalState must be complete, incomplete, or blocked");
  }
  if (
    value.workState !== "running" &&
    value.workState !== "waiting" &&
    value.workState !== "idle" &&
    value.workState !== "failed" &&
    value.workState !== "stopped" &&
    value.workState !== "unknown"
  ) {
    throw new Error("workState is invalid");
  }
  const observation: MonitorObservation = {
    route: value.route,
    goalState: value.goalState,
    workState: value.workState,
    observation: requireBoundedString(value.observation, "observation", MAX_OBSERVATION_CHARS),
    report: requireBoundedString(value.report, "report", MAX_REPORT_CHARS),
    targetStateId: requireBoundedString(value.targetStateId, "targetStateId", MAX_ID_CHARS),
    authorizedActions: requireStringArray(value.authorizedActions, "authorizedActions"),
    reason: requireBoundedString(value.reason, "reason", MAX_REASON_CHARS),
  };
  if (value.progress !== undefined) observation.progress = validateMonitorProgress(value.progress);
  if (value.action !== undefined) observation.action = parseActionRequest(value.action);
  if (observation.route === "act" && observation.action === undefined) {
    throw new Error("route act requires action details");
  }
  if (
    observation.action !== undefined &&
    observation.action.targetStateId !== observation.targetStateId
  ) {
    throw new Error("monitor action targetStateId must match the observed targetStateId");
  }
  if (observation.route !== "act" && observation.action !== undefined) {
    throw new Error("action details are only valid for route act");
  }
  if (observation.route === "act" && observation.goalState !== "incomplete") {
    throw new Error("route act requires goalState incomplete");
  }
  if (
    observation.route === "act" &&
    observation.workState !== "idle" &&
    observation.workState !== "failed" &&
    observation.workState !== "stopped"
  ) {
    throw new Error("route act requires idle, failed, or stopped work");
  }
  if (observation.route === "wait" && observation.goalState !== "incomplete") {
    throw new Error("route wait requires goalState incomplete");
  }
  if (
    observation.route === "wait" &&
    observation.workState !== "running" &&
    observation.workState !== "waiting"
  ) {
    throw new Error("route wait requires running work or an external wait");
  }
  if (observation.goalState === "complete" && observation.route !== "stop") {
    throw new Error("goalState complete requires route stop");
  }
  if (observation.goalState === "blocked" && observation.route !== "stop") {
    throw new Error("goalState blocked requires route stop");
  }
  return observation;
}

function validateMonitorProgress(input: unknown): { tracks: MonitorTrack[] } {
  const value = requireRecord(input, "progress");
  requireExactKeys(value, ["tracks"], "progress");
  if (!Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > MAX_TRACKS) {
    throw new Error(`progress.tracks must contain 1 through ${MAX_TRACKS} entries`);
  }
  const keys = new Set<string>();
  const tracks = value.tracks.map((raw, index) => {
    const track = requireRecord(raw, `progress.tracks[${index}]`);
    requireExactKeys(track, ["key", "data"], `progress.tracks[${index}]`);
    const key = requireBoundedString(track.key, `progress.tracks[${index}].key`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key)) {
      throw new Error(`progress.tracks[${index}].key is invalid`);
    }
    if (keys.has(key)) throw new Error(`progress track key ${key} is duplicated`);
    keys.add(key);
    return {
      key,
      data: validateProgressData(requireRecord(track.data, `progress.tracks[${index}].data`)),
    };
  });
  return { tracks };
}

function currentObservation(outputs: Record<string, unknown>): MonitorObservation {
  return (outputs.guard ?? outputs.observe) as MonitorObservation;
}

function estimateTracks(outputs: Record<string, unknown>): MonitorEstimate {
  const observation = currentObservation(outputs);
  if (observation.progress === undefined) return { tracks: [] };
  const previous = outputs.estimate as MonitorEstimate | undefined;
  const previousByKey = new Map((previous?.tracks ?? []).map((track) => [track.key, track]));
  const at = new Date().toISOString();
  return {
    tracks: observation.progress.tracks.map((track) => {
      const samples: ProgressSample[] = [
        ...(previousByKey.get(track.key)?.samples ?? []),
        { at, data: track.data },
      ].slice(-9);
      return { key: track.key, samples, estimate: estimateProgress(track.key, samples) };
    }),
  };
}

function actionFrom(outputs: Record<string, unknown>): MonitorActionRequest {
  const request = currentObservation(outputs).action;
  if (request === undefined) throw new Error("monitor action details are missing");
  return request;
}

function repeatedCompletedRepair(context: WorkflowNodeContext): boolean {
  const action = (context.outputs.observe as MonitorObservation).action;
  if (action?.kind !== "repair") return false;
  const currentIndex = context.state.steps.findLastIndex((step) => step.nodeId === "observe");
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step?.nodeId !== "observe") continue;
    const prior = step.output as MonitorObservation;
    if (
      prior.action?.kind !== "repair" ||
      prior.action.failureId !== action.failureId ||
      prior.action.targetStateId !== action.targetStateId
    ) {
      continue;
    }
    return context.state.steps
      .slice(index + 1, currentIndex)
      .some((candidate) => candidate.nodeId === "repairComplete" && candidate.outcome === "ok");
  }
  return false;
}

function guardObservation(context: WorkflowNodeContext): MonitorObservation {
  const observation = context.outputs.observe as MonitorObservation;
  if (!repeatedCompletedRepair(context)) return observation;
  const action = observation.action;
  if (action === undefined) return observation;
  return {
    route: "stop",
    goalState: "blocked",
    workState: observation.workState,
    observation: observation.observation,
    report: "The same failure and target state returned after one completed repair.",
    targetStateId: observation.targetStateId,
    authorizedActions: observation.authorizedActions,
    ...(observation.progress !== undefined ? { progress: observation.progress } : {}),
    reason: `Repair stopped because ${action.failureId} returned in target state ${action.targetStateId}.`,
  };
}

export function validateMonitorActionResult(
  output: unknown,
  expected: Pick<MonitorActionRequest, "failureId" | "targetStateId">,
): MonitorActionResult {
  const value = requireRecord(output, "monitor action result");
  requireExactKeys(
    value,
    ["status", "summary", "evidence", "verification", "failureId", "targetStateId"],
    "monitor action result",
  );
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "blocked") {
    throw new Error("monitor action result status must be succeeded, failed, or blocked");
  }
  const result: MonitorActionResult = {
    status: value.status,
    summary: requireBoundedString(value.summary, "monitor action result summary", MAX_REPORT_CHARS),
    evidence: value.evidence ?? null,
    verification: requireBoundedString(
      value.verification,
      "monitor action result verification",
      MAX_ACTION_TEXT_CHARS,
    ),
    failureId: requireBoundedString(
      value.failureId,
      "monitor action result failureId",
      MAX_ID_CHARS,
    ),
    targetStateId: requireBoundedString(
      value.targetStateId,
      "monitor action result targetStateId",
      MAX_ID_CHARS,
    ),
  };
  if (result.failureId !== expected.failureId || result.targetStateId !== expected.targetStateId) {
    throw new Error(
      "monitor action result must preserve the requested failure and target-state IDs",
    );
  }
  return result;
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

function authorityScope(actionRequest: MonitorActionRequest): string {
  const authority = actionRequest.authority;
  return [
    `Authorization basis: ${authority.basis}`,
    `Allowed mutations: ${authority.allowedMutations.join("; ")}`,
    `Forbidden mutations: ${authority.forbiddenMutations.join("; ") || "none recorded"}`,
    `Cost limit: ${authority.costLimit}`,
    `Provider/runtime contract: ${authority.providerRuntime}`,
    `Allowed recovery actions: ${authority.allowedRecoveryActions.join("; ") || "none recorded"}`,
  ].join("\n");
}

function authorityConstraints(actionRequest: MonitorActionRequest): string[] {
  const authority = actionRequest.authority;
  return [
    ...authority.forbiddenMutations.map((item) => `Forbidden: ${item}`),
    `Cost limit: ${authority.costLimit}`,
    `Provider/runtime contract: ${authority.providerRuntime}`,
    ...authority.requiredChecks.map((item) => `Required check: ${item}`),
    ...authority.stopConditions.map((item) => `Stop condition: ${item}`),
    `Repair verification: ${actionRequest.verification}`,
  ];
}

function repairBlockedReason(outputs: Record<string, unknown>): string {
  const planChange = outputs.planChange as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  const implementation = outputs.implementation as
    | { exit?: string; output?: { reason?: string } }
    | undefined;
  return (
    implementation?.output?.reason ??
    planChange?.output?.reason ??
    "The repair did not produce a verified result."
  );
}

function recordedActionFromStep(
  step: WorkflowNodeContext["state"]["steps"][number],
): RecordedAction | undefined {
  if (step.outcome !== "ok") return undefined;
  if (step.nodeId === "act") {
    const result = step.output as MonitorActionResult;
    return {
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      verification: result.verification,
      failureId: result.failureId,
      targetStateId: result.targetStateId,
    };
  }
  if (step.nodeId === "repairComplete") return step.output as RecordedAction;
  return undefined;
}

function latestRecordedAction(context: WorkflowNodeContext): RecordedAction | undefined {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step === undefined) continue;
    const recorded = recordedActionFromStep(step);
    if (recorded !== undefined) return recorded;
  }
  return undefined;
}

function reportMessage(context: WorkflowNodeContext): string {
  const observation = currentObservation(context.outputs);
  const estimate = context.outputs.estimate as MonitorEstimate;
  const config = configFrom(context.outputs);
  const progress =
    estimate.tracks.length === 0
      ? "Progress: unavailable"
      : formatProgressReport(
          estimate.tracks.map((track) => track.estimate),
          undefined,
          new Date(),
          2_000,
        );
  const lines = [
    `Monitor: ${observation.route === "stop" ? "stopping" : "active"}`,
    `Goal: ${observation.goalState}`,
    `Work: ${observation.workState}`,
    progress,
  ];
  const lastAction = latestRecordedAction(context);
  if (lastAction !== undefined) lines.push(`Last action: ${lastAction.summary}`);
  if (observation.action !== undefined && completedObservations(context) < config.maxChecks) {
    lines.push(`Next action: ${observation.action.nextAction}`);
  }
  if (observation.route === "wait" && completedObservations(context) < config.maxChecks) {
    lines.push(`Next check: ${config.everyMinutes} minutes`);
  }
  if (completedObservations(context) >= config.maxChecks && observation.route !== "stop") {
    lines.push(`Safety limit: reached ${config.maxChecks} observations`);
  }
  lines.push(`Status: ${observation.report}`);
  const message = lines.join("\n");
  return message.length <= MAX_REPORT_CHARS
    ? message
    : `${message.slice(0, MAX_REPORT_CHARS - 1)}…`;
}

function previousActionPrompt(context: WorkflowNodeContext): string {
  const actionRecord = latestRecordedAction(context);
  return actionRecord === undefined
    ? "There is no previous completed action."
    : `Previous action result: ${JSON.stringify(actionRecord)}`;
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
        const request = actionFrom(outputs);
        if (request.kind !== "repair") throw new Error("monitor repair action is missing");
        return {
          task: request.nextAction,
          scope: authorityScope(request),
          constraints: authorityConstraints(request),
          ...(request.authority.repository !== undefined
            ? { repository: request.authority.repository }
            : {}),
          newEvidence: {
            incomplete: request.incomplete,
            evidence: request.evidence,
            failureId: request.failureId,
            targetStateId: request.targetStateId,
            defect: request.defect,
          },
          approval: request.authority.repairApproval,
        };
      },
    }),
    implementation: includeWorkflow({
      workflow: "autoimplement",
      contract: autoimplementWorkflow,
      input: ({ outputs }) => {
        const request = actionFrom(outputs);
        const documented = currentRepairPlan(outputs);
        if (request.kind !== "repair") throw new Error("monitor repair action is missing");
        if (request.authority.repository === undefined) {
          throw new Error(
            "monitor repair requires an absolute repository for workspace preparation",
          );
        }
        const implementationInput: AutoimplementInput = {
          task: request.nextAction,
          plan: documented.plan,
          documentation: {
            status: "current",
            planDigest: documented.planDigest,
            documents: documented.documents,
          },
          scope: authorityScope(request),
          constraints: authorityConstraints(request),
          repository: request.authority.repository,
          ...(request.authority.baseBranch !== undefined
            ? { baseBranch: request.authority.baseBranch }
            : {}),
          approval: request.authority.repairApproval,
          merge: request.authority.merge,
        };
        return implementationInput;
      },
    }),
  },
  nodes: {
    prepare: compute({ run: ({ input }) => prepareMonitorInput(input) }),
    observe: agent({
      statusDetail: "observing monitored goal",
      timeoutMs: DEFAULT_CHECK_TIMEOUT_MINUTES * 60_000,
      prompt: (context) => {
        const config = configFrom(context.outputs);
        const previous = context.outputs.observe as MonitorObservation | undefined;
        const priorEstimate = context.outputs.estimate as MonitorEstimate | undefined;
        return [
          `Perform read-only observation ${completedObservations(context) + 1} of at most ${config.maxChecks}.`,
          `Goal and authority: ${config.task}`,
          `Stop when: ${config.stopWhen}`,
          "Use normal read-only tools to inspect authoritative target state, durable outputs, failures, checkpoints, active work, and applicable authority. Do not mutate any file, process, Job, service, remote resource, or configuration during this step.",
          "Preserve the exact goal, allowed files and systems, forbidden changes, cost ceiling, provider/runtime contract, required checks, stop conditions, and allowed recovery actions from the task, conversation, and repository instructions. Do not invent permission.",
          "List the safe actions the user has already authorized, even when no action is needed now. Choose wait only when useful target work is moving or an external event must finish. Choose act only when the goal is incomplete, work is idle, failed, or stopped, and one safe action is fully authorized. Choose stop when the goal is complete or safe continuation is blocked.",
          "For act, describe one exact action. Use advance for normal next work, recover for an operational restart or resume, and repair only for a code or configuration defect. A normal start, resume, or restart must not become repair. If a paid action lacks verified remaining authority or exceeds its limit, choose stop. Before repair of a shared code or data defect, affected paid workers must already be stopped.",
          "You are the regular Pi model and observation adapter. Publish measured facts with workflow update when useful. Do not require the target to implement a Pi-specific API, file, store, schema, command, service, transport, or dependency. Do not invent counts, rates, or ETA values.",
          previous === undefined
            ? "There is no previous accepted observation."
            : `Previous accepted observation: ${JSON.stringify(previous)}`,
          previousActionPrompt(context),
          priorEstimate?.tracks.length
            ? `Previous progress: ${formatProgressReport(priorEstimate.tracks.map((track) => track.estimate))}`
            : "There is no previous measured progress.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "route": "wait" | "act" | "stop", "goalState": "complete" | "incomplete" | "blocked", "workState": "running" | "waiting" | "idle" | "failed" | "stopped" | "unknown", "observation": "factual state", "report": "concise factual summary", "targetStateId": "stable observed target-state ID", "authorizedActions": ["safe action already authorized by the user"], "progress": { "tracks": [{ "key": "stable-key", "data": { "schema": "pi-workflows.progress.v1", "status": "running", "completed": 1, "total": 2, "unit": "items" } }] } (optional), "action": { "kind": "advance" | "recover" | "repair", "incomplete": "what remains", "evidence": {}, "nextAction": "one exact action", "authority": { "status": "authorized", "basis": "existing authority", "allowedMutations": ["allowed file, system, or resource"], "forbiddenMutations": [], "costLimit": "recorded limit or not applicable", "providerRuntime": "recorded contract or not applicable", "requiredChecks": [], "stopConditions": [], "allowedRecoveryActions": [], "repository": "optional absolute path", "baseBranch": "optional branch", "merge": false, "repairApproval": { "mode": "auto" | "required" | "skip" } }, "cost": { "paidAction": false, "status": "not-applicable" | "within-limit", "evidence": "cost evidence" }, "defect": { "sharedCodeOrDataDefect": false, "paidRunners": "not-applicable" | "stopped" | "running", "evidence": "worker evidence" }, "verification": "how to prove success", "failureId": "stable failure ID", "targetStateId": "stable target-state ID" } (required only for act), "reason": "short reason" }',
      validate: validateMonitorObservation,
    }),
    guard: compute({ run: guardObservation }),
    estimate: compute({ run: ({ outputs }) => estimateTracks(outputs) }),
    publish_progress: action({
      effect: idempotentEffect("pi-workflows.monitor.publish-progress"),
      statusDetail: "publishing monitor progress",
      run: async ({ outputs, publishUpdate, signal }) => {
        const observation = currentObservation(outputs);
        if (observation.progress === undefined) return { published: 0 };
        for (const track of observation.progress.tracks) {
          await waitForUpdateSlot(signal);
          await publishUpdate({ type: "progress", key: track.key, data: track.data });
        }
        return { published: observation.progress.tracks.length };
      },
    }),
    report: notify({
      statusDetail: "queueing monitor update",
      message: reportMessage,
      kind: "progress",
    }),
    decide: compute({
      run: (context) => {
        const observation = currentObservation(context.outputs);
        const config = configFrom(context.outputs);
        const checks = completedObservations(context);
        if (observation.route === "stop")
          return { route: "stop", reason: observation.reason, checks };
        if (checks >= config.maxChecks) {
          return {
            route: "stop",
            reason: `Reached the ${config.maxChecks}-observation safety limit.`,
            checks,
          };
        }
        if (observation.route === "wait")
          return { route: "wait", reason: observation.reason, checks };
        const request = actionFrom(context.outputs);
        return { route: request.kind, reason: observation.reason, checks };
      },
    }),
    act: agent({
      statusDetail: "performing authorized monitor action",
      timeoutMs: DEFAULT_CHECK_TIMEOUT_MINUTES * 60_000,
      prompt: ({ outputs }) => {
        const request = actionFrom(outputs);
        if (request.kind === "repair") throw new Error("repair must use the composed repair path");
        return [
          `Perform this one ${request.kind} action with normal tools: ${request.nextAction}`,
          `Incomplete work: ${request.incomplete}`,
          `Evidence: ${JSON.stringify(request.evidence)}`,
          `Authorization: ${JSON.stringify(request.authority)}`,
          `Cost safety: ${JSON.stringify(request.cost)}`,
          `Defect safety: ${JSON.stringify(request.defect)}`,
          `Verification: ${request.verification}`,
          "Perform only the stated action and only on the allowed files, systems, and resources. Do not plan, document, redesign, broaden scope, change a protected contract, or perform another action. Verify the direct result before submitting. Preserve the supplied failure and target-state IDs exactly.",
        ].join("\n\n");
      },
      expectedOutput:
        '{ "status": "succeeded" | "failed" | "blocked", "summary": "action performed and real result", "evidence": {}, "verification": "verification performed", "failureId": "unchanged failure ID", "targetStateId": "unchanged target-state ID" }',
      validate: (output, context) =>
        validateMonitorActionResult(output, actionFrom(context.outputs)),
    }),
    repairComplete: compute({
      run: ({ outputs }): RecordedAction => {
        const request = actionFrom(outputs);
        if (request.kind !== "repair") throw new Error("monitor repair action is missing");
        return {
          status: "succeeded",
          summary: request.nextAction,
          evidence: outputs.implementation,
          verification: request.verification,
          failureId: request.failureId,
          targetStateId: request.targetStateId,
        };
      },
    }),
    repairBlocked: compute({
      run: (context) => ({
        reason: repairBlockedReason(context.outputs),
        observation: currentObservation(context.outputs).observation,
        checks: completedObservations(context),
        reported: true,
      }),
    }),
    repairReport: notify({
      statusDetail: "reporting blocked monitor repair",
      kind: "final",
      message: ({ outputs }) => {
        const result = outputs.repairBlocked as { reason: string };
        return `Monitor repair stopped: ${result.reason}`;
      },
    }),
    schedule: action({
      effect: idempotentEffect("pi-workflows.monitor.schedule"),
      statusDetail: "scheduling next monitor observation",
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
      effect: idempotentEffect("pi-workflows.monitor.sleep"),
      statusDetail: "waiting for next monitor observation",
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
        const observation = currentObservation(outputs);
        const decision = outputs.decide as { reason?: string; checks?: number } | undefined;
        const repair = outputs.repairBlocked as { reason?: string } | undefined;
        return {
          reason: repair?.reason ?? decision?.reason ?? observation.reason,
          observation: observation.observation,
          goalState: repair === undefined ? observation.goalState : "blocked",
          workState: observation.workState,
          checks: decision?.checks ?? 1,
          reported: true,
        };
      },
    }),
  },
  edges: [
    { from: "prepare", to: "observe" },
    { from: "observe", to: "guard" },
    { from: "guard", to: "estimate" },
    { from: "estimate", to: "publish_progress" },
    { from: "publish_progress", to: "report" },
    { from: "report", to: "decide" },
    {
      from: "decide",
      switch: {
        on: "$.route",
        cases: {
          stop: "finish",
          wait: "schedule",
          advance: "act",
          recover: "act",
          repair: "planChange",
        },
      },
    },
    { from: "act", to: "observe" },
    { from: "planChange.ready", to: "implementation" },
    { from: "planChange.blocked", to: "repairBlocked" },
    { from: "implementation.completed", to: "repairComplete" },
    { from: "implementation.blocked", to: "repairBlocked" },
    { from: "repairComplete", to: "observe" },
    { from: "repairBlocked", to: "repairReport" },
    { from: "repairReport", to: "finish" },
    { from: "schedule", to: "sleep" },
    { from: "sleep", to: "observe" },
  ],
});

export default monitorWorkflow;
