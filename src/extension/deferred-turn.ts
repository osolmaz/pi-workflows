import { createHash } from "node:crypto";
import type {
  WorkflowTurnIntentCause,
  WorkflowTurnIntentFacts,
  WorkflowTurnIntentRecord,
  WorkflowTurnIntentResolution,
} from "../controllers/sqlite.js";

export const DEFERRED_TURN_MESSAGE_TYPE = "pi-workflows-deferred-turn";
export const DEFERRED_TURN_MESSAGE_SCHEMA = "pi-workflows.deferred-turn-message.v1";
const FACTS_SCHEMA = "pi-workflows.deferred-turn-facts.v1";
const MAX_REASON_CHARS = 8_192;

export type DeferredTurnSource = {
  runId: string;
  workflowName: string;
  targetSessionId: string;
  cause: WorkflowTurnIntentCause;
  sourceEventId: string;
  observedState: string;
  nodeId?: string | null;
  attemptId?: string | null;
  reason?: string | null;
  handoff?: boolean;
};

export type DeferredTurnDescriptor = {
  intentId: string;
  sourceEventId: string;
  runId: string;
  workflowRef: string;
  targetSessionId: string;
  cause: WorkflowTurnIntentCause;
  nodeId: string | null;
  attemptId: string | null;
  fallbackFacts: WorkflowTurnIntentFacts;
};

export type DeferredTurnMessageDetails = {
  schema: typeof DEFERRED_TURN_MESSAGE_SCHEMA;
  turnIntentId: string;
  runId: string;
  cause: WorkflowTurnIntentCause;
};

export function deferredTurnSourceEventId(options: {
  runId: string;
  cause: WorkflowTurnIntentCause;
  nodeId?: string | null;
  attemptId?: string | null;
  source?: string;
}): string {
  const parts = [
    options.runId,
    options.source ?? "run",
    options.nodeId ?? "$run",
    options.attemptId ?? "$none",
    options.cause,
  ];
  return `turn-source:${digest(parts)}`;
}

export function createDeferredTurnDescriptor(source: DeferredTurnSource): DeferredTurnDescriptor {
  const nodeId = source.nodeId ?? null;
  const attemptId = source.attemptId ?? null;
  const fallbackFacts = createDeferredTurnFacts(source);
  return {
    intentId: `deferred-turn:${digest([
      source.targetSessionId,
      source.runId,
      source.sourceEventId,
      nodeId ?? "$run",
      attemptId ?? "$none",
      source.cause,
    ])}`,
    sourceEventId: source.sourceEventId,
    runId: source.runId,
    workflowRef: source.workflowName,
    targetSessionId: source.targetSessionId,
    cause: source.cause,
    nodeId,
    attemptId,
    fallbackFacts,
  };
}

export function createDeferredTurnFacts(source: DeferredTurnSource): WorkflowTurnIntentFacts {
  return {
    schema: FACTS_SCHEMA,
    workflowName: source.workflowName,
    runId: source.runId,
    observedState: source.observedState,
    cause: source.cause,
    nodeId: source.nodeId ?? null,
    attemptId: source.attemptId ?? null,
    reason: boundedReason(source.reason),
    handoff: source.handoff ?? false,
  };
}

export function deferredTurnMessageId(
  intentId: string,
  resolution: WorkflowTurnIntentResolution,
): string {
  return `turn-message:${digest([intentId, resolution])}`;
}

export function deferredTurnMessageDetails(
  intent: WorkflowTurnIntentRecord,
): DeferredTurnMessageDetails {
  return {
    schema: DEFERRED_TURN_MESSAGE_SCHEMA,
    turnIntentId: intent.intentId,
    runId: intent.runId,
    cause: intent.cause,
  };
}

export function buildDeferredTurnContent(intent: WorkflowTurnIntentRecord): string {
  const facts = intent.fallbackFacts;
  const source = [
    facts.nodeId === null ? null : `node ${facts.nodeId}`,
    facts.attemptId === null ? null : `attempt ${facts.attemptId}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const reason =
    facts.reason === null
      ? ""
      : ` Reason: ${facts.reason}${/[.!?]$/.test(facts.reason) ? "" : "."}`;
  const sourceText = source.length === 0 ? "" : ` Source: ${source}.`;
  if (facts.cause === "launchFailed") {
    return [
      `Workflow ${facts.workflowName} failed to start (run ${facts.runId}).`,
      `${sourceText}${reason}`.trim(),
      "Inspect the durable workflow state before you explain the outcome or start a corrected workflow.",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }
  if (facts.handoff) {
    return [
      `Workflow ${facts.workflowName} was handed to another runner (run ${facts.runId}).`,
      `Observed state: ${facts.observedState}.${sourceText}${reason}`,
      "Inspect the durable workflow state before you explain the outcome or take any authorized corrective action.",
    ].join(" ");
  }
  return [
    `Workflow ${facts.workflowName} ended with state ${facts.observedState} (run ${facts.runId}).`,
    `${sourceText}${reason}`.trim(),
    "Inspect the durable workflow state before you explain the outcome or take any authorized corrective action.",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function boundedReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_REASON_CHARS ? trimmed : trimmed.slice(0, MAX_REASON_CHARS);
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
