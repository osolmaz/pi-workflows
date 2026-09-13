import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../state/json.js";
import { resolveNext, resolveNextForOutcome } from "./graph.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowStepRecord,
  WorkflowTraceEventDraft,
} from "./types.js";

/** Runner proposals carry one change, never a replacement run projection. */
export type WorkflowTransition = {
  event: WorkflowTraceEventDraft;
} & (
  | { kind: "startAttempt"; startedAt: string }
  | { kind: "finishAttempt"; step: WorkflowStepRecord }
  | { kind: "setTimeout"; timeoutMs: number | null }
  | { kind: "resume"; attemptId?: string }
  | { kind: "pause" }
  | { kind: "resumeInteraction" }
  | {
      kind: "waitForInput";
      requestId: string;
      requestKind: "checkpoint" | "decision";
      contract: JsonValue;
    }
  | {
      kind: "finish";
      status: "completed" | "failed" | "timed_out" | "cancelled";
      error?: string;
      finalOutput?: unknown;
    }
  | { kind: "record" }
);

/** Translate engine-local state into the narrow proposal for this event. */
export function executionTransition(
  state: WorkflowRunState,
  event: WorkflowTraceEventDraft,
): WorkflowTransition {
  switch (event.type) {
    case "node_started":
      if (state.currentNodeStartedAt === undefined)
        throw new Error("Attempt start time is missing");
      return { kind: "startAttempt", startedAt: state.currentNodeStartedAt, event };
    case "node_finished":
    case "node_failed": {
      const step = state.steps.at(-1);
      if (step === undefined || step.attemptId !== event.attemptId) {
        throw new Error("Finished attempt is missing from engine state");
      }
      return { kind: "finishAttempt", step, event };
    }
    case "node_timeout_set":
      return { kind: "setTimeout", timeoutMs: state.currentNodeTimeoutMs ?? null, event };
    case "run_resumed":
      return {
        kind: "resume",
        ...(state.currentAttemptId === undefined ? {} : { attemptId: state.currentAttemptId }),
        event,
      };
    case "run_paused":
      return { kind: "pause", event };
    case "interaction_validation_started":
    case "interaction_accepted":
      return { kind: "resumeInteraction", event };
    case "run_completed":
    case "run_failed":
    case "run_interrupted":
    case "run_timed_out":
    case "run_cancelled":
      if (state.status === "running" || state.status === "waiting")
        throw new Error("Terminal transition has unfinished execution");
      return {
        kind: "finish",
        status: state.status,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.finalOutput === undefined ? {} : { finalOutput: state.finalOutput }),
        event,
      };
    default:
      return { kind: "record", event };
  }
}

const recordEvents = new Set([
  "run_started",
  "include_entered",
  "include_exited",
  "settings_route_retried",
  "agent_session_required",
  "agent_prompt_sent",
  "interaction_resume_prepared",
]);

/** Apply a validated transition to a projection read by the durable owner. */
export function applyExecutionTransition(
  current: WorkflowRunState,
  definition: WorkflowDefinitionSnapshot,
  transition: WorkflowTransition,
  now: string,
): WorkflowRunState {
  if (
    current.status !== "running" &&
    !(current.status === "waiting" && transition.kind === "resumeInteraction")
  ) {
    throw new Error(`Run ${current.runId} cannot execute with status ${current.status}`);
  }
  const state = structuredClone(current);
  const event = transition.event;
  if (typeof event !== "object" || event === null || typeof event.type !== "string") {
    throw new Error("Execution transition event is invalid");
  }
  switch (transition.kind) {
    case "startAttempt": {
      requireEvent(event, "node_started");
      const nodeId = requireIdentity(event.nodeId, "node");
      const attemptId = requireIdentity(event.attemptId, "attempt");
      const node = definition.nodes[nodeId];
      if (node === undefined || node.nodeType !== event.payload.nodeType) {
        throw new Error("Attempt node does not match the workflow definition");
      }
      if (state.steps.some((step) => step.attemptId === attemptId)) {
        throw new Error("A completed attempt cannot start again");
      }
      if (state.currentAttemptId !== undefined) {
        throw new Error("Another attempt is already active");
      }
      if (nextNode(definition, state) !== nodeId) {
        throw new Error("Attempt does not follow the accepted graph route");
      }
      if (!Number.isFinite(Date.parse(transition.startedAt)))
        throw new Error("Invalid attempt time");
      state.currentNode = nodeId;
      state.currentAttemptId = attemptId;
      state.currentNodeStartedAt = transition.startedAt;
      setSettings(state, event.payload);
      if (node.statusDetail !== undefined) state.statusDetail = node.statusDetail;
      break;
    }
    case "finishAttempt": {
      const step = transition.step;
      requireEvent(event, step.outcome === "ok" ? "node_finished" : "node_failed");
      requireAttempt(state, event);
      if (
        step.attemptId !== event.attemptId ||
        step.nodeId !== event.nodeId ||
        step.nodeType !== definition.nodes[step.nodeId]?.nodeType ||
        step.startedAt !== state.currentNodeStartedAt ||
        step.outcome !== event.payload.outcome ||
        !isDeepStrictEqual(step.output, event.payload.output ?? null)
      ) {
        throw new Error("Attempt result does not match the active request");
      }
      if (state.steps.some((prior) => prior.attemptId === step.attemptId)) {
        throw new Error("Attempt result was already committed");
      }
      state.steps.push(structuredClone(step));
      state.results[step.nodeId] = {
        ...step,
        durationMs: Date.parse(step.finishedAt) - Date.parse(step.startedAt),
      };
      if (step.outcome === "ok") state.outputs[step.nodeId] = step.output;
      clearAttempt(state);
      break;
    }
    case "setTimeout":
      requireEvent(event, "node_timeout_set");
      requireAttempt(state, event);
      if (
        transition.timeoutMs !== null &&
        (!Number.isFinite(transition.timeoutMs) || transition.timeoutMs <= 0)
      ) {
        throw new Error("Invalid attempt timeout");
      }
      if (state.currentNodeElapsedMs !== undefined)
        throw new Error("Attempt timeout was already configured");
      state.currentNodeTimeoutMs = transition.timeoutMs;
      state.currentNodeElapsedMs = 0;
      break;
    case "resume":
      requireEvent(event, "run_resumed");
      if (transition.attemptId !== undefined && transition.attemptId !== state.currentAttemptId) {
        throw new Error("Resume does not name the active attempt");
      }
      if (transition.attemptId === undefined) clearAttempt(state);
      delete state.paused;
      break;
    case "waitForInput":
      requireEvent(event, "checkpoint_requested");
      requireAttempt(state, event);
      if (definition.nodes[state.currentNode ?? ""]?.nodeType !== "checkpoint") {
        throw new Error("Only a checkpoint can request checkpoint input");
      }
      state.status = "waiting";
      state.waitingOn = requireIdentity(event.nodeId, "node");
      state.statusDetail =
        transition.requestKind === "decision"
          ? "waiting for a human decision"
          : "waiting for checkpoint input";
      delete state.finishedAt;
      break;
    case "resumeInteraction":
      if (
        event.type !== "interaction_validation_started" &&
        event.type !== "interaction_accepted"
      ) {
        throw new Error("Invalid interaction resume event");
      }
      if (state.waitingOn !== event.nodeId || state.currentAttemptId !== event.attemptId) {
        throw new Error("Interaction does not match the waiting attempt");
      }
      state.status = "running";
      state.currentNode = requireIdentity(event.nodeId, "node");
      delete state.waitingOn;
      delete state.finishedAt;
      delete state.statusDetail;
      break;
    case "pause":
      requireEvent(event, "run_paused");
      state.paused = true;
      break;
    case "finish":
      if (
        !["completed", "failed", "timed_out", "cancelled"].includes(transition.status) ||
        (event.type !== `run_${transition.status}` &&
          !(event.type === "run_interrupted" && transition.status === "failed"))
      ) {
        throw new Error("Run outcome does not match the transition");
      }
      if (transition.status === "completed" && state.currentAttemptId !== undefined) {
        throw new Error("A run with an unfinished attempt cannot complete");
      }
      if (transition.status === "completed") {
        const last = state.steps.at(-1);
        if (
          last?.outcome !== "ok" ||
          nextNode(definition, state) !== null ||
          !isDeepStrictEqual(transition.finalOutput, last.output)
        ) {
          throw new Error("Completion does not match the accepted graph result");
        }
      }
      state.status = transition.status;
      state.finishedAt = now;
      if (transition.error !== undefined) state.error = transition.error;
      if (transition.finalOutput !== undefined) state.finalOutput = transition.finalOutput;
      clearAttempt(state);
      break;
    case "record":
      if (!recordEvents.has(event.type)) throw new Error(`Unknown execution event: ${event.type}`);
      if (event.type === "agent_prompt_sent" || event.type === "agent_session_required") {
        requireAttempt(state, event);
      }
      if (event.type === "agent_session_required")
        state.statusDetail = "waiting for origin Pi session";
      if (event.type === "settings_route_retried") {
        const payload = event.payload;
        if (typeof payload.scopeId !== "string" || typeof payload.changeNumber !== "number") {
          throw new Error("Settings retry binding is invalid");
        }
        state.currentSettingsScopeId = payload.scopeId;
        state.currentSettingsChangeNumber = payload.changeNumber;
        if (typeof payload.settingsHash !== "string")
          throw new Error("Settings retry hash is missing");
        state.currentSettingsHash = payload.settingsHash;
      }
      break;
    default:
      throw new Error("Unknown execution transition");
  }
  return state;
}

function nextNode(definition: WorkflowDefinitionSnapshot, state: WorkflowRunState): string | null {
  const last = state.steps.at(-1);
  if (last === undefined) return definition.startAt;
  const result = state.results[last.nodeId];
  if (result === undefined) throw new Error("Accepted graph result is missing");
  return result.outcome === "ok"
    ? resolveNext(definition.edges, last.nodeId, result.output, result)
    : resolveNextForOutcome(definition.edges, last.nodeId, result);
}

function requireEvent(event: WorkflowTraceEventDraft, type: string): void {
  if (event.type !== type) throw new Error(`Transition requires ${type}`);
}

function requireIdentity(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${name} identity`);
  return value;
}

function requireAttempt(state: WorkflowRunState, event: WorkflowTraceEventDraft): void {
  if (
    state.currentNode !== requireIdentity(event.nodeId, "node") ||
    state.currentAttemptId !== requireIdentity(event.attemptId, "attempt")
  ) {
    throw new Error("Execution transition does not match the active attempt");
  }
}

function clearAttempt(state: WorkflowRunState): void {
  delete state.currentNode;
  delete state.currentAttemptId;
  delete state.currentNodeStartedAt;
  delete state.currentNodeTimeoutMs;
  delete state.currentNodeElapsedMs;
  delete state.currentSettingsScopeId;
  delete state.currentSettingsChangeNumber;
  delete state.currentSettingsHash;
  delete state.statusDetail;
}

function setSettings(state: WorkflowRunState, payload: WorkflowTraceEventDraft["payload"]): void {
  delete state.currentSettingsScopeId;
  delete state.currentSettingsChangeNumber;
  delete state.currentSettingsHash;
  if (typeof payload.settingsScopeId === "string") {
    if (
      typeof payload.settingsChangeNumber !== "number" ||
      typeof payload.settingsHash !== "string"
    ) {
      throw new Error("Attempt settings binding is invalid");
    }
    state.currentSettingsScopeId = payload.settingsScopeId;
    state.currentSettingsChangeNumber = payload.settingsChangeNumber;
    state.currentSettingsHash = payload.settingsHash;
  }
}
