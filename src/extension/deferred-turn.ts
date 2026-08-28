import { createHash } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowTurnIntentCause,
  WorkflowTurnIntentFacts,
  WorkflowTurnIntentRecord,
  WorkflowTurnIntentResolution,
} from "../controllers/sqlite.js";
import {
  cleanSingleLine,
  customMessageContentText,
  paintMessageCard,
  renderMessageCard,
  type MessageCardColor,
  type MessageCardView,
} from "./message-card.js";
import type { TerminalDecision, TerminalReason } from "./terminal-decision.js";

export const DEFERRED_TURN_MESSAGE_TYPE = "pi-workflows-deferred-turn";
export const DEFERRED_TURN_MESSAGE_SCHEMA = "pi-workflows.deferred-turn-message.v1";
const FACTS_SCHEMA = "pi-workflows.deferred-turn-facts.v1";
const MAX_REASON_CHARS = 8_192;
const MAX_PRESENTATION_FIELD_CHARS = 512;

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

export type DeferredTurnMessagePresentation = {
  workflowName: string;
  state: string;
  reasonKind?: TerminalReason["kind"];
  restart?: {
    count: number;
    limit: number;
  };
};

export type DeferredTurnMessageDetails = {
  schema: typeof DEFERRED_TURN_MESSAGE_SCHEMA;
  turnIntentId: string;
  runId: string;
  cause: WorkflowTurnIntentCause;
  presentation?: DeferredTurnMessagePresentation;
};

type DeferredTurnMessage = {
  content: unknown;
  details?: unknown;
};

export type DeferredTurnMessageView = MessageCardView;

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
  decision?: TerminalDecision | null,
): DeferredTurnMessageDetails {
  return {
    schema: DEFERRED_TURN_MESSAGE_SCHEMA,
    turnIntentId: intent.intentId,
    runId: intent.runId,
    cause: intent.cause,
    presentation: {
      workflowName: boundedPresentationField(
        decision?.workflowName ?? intent.fallbackFacts.workflowName,
      ),
      state: boundedPresentationField(decision?.state ?? intent.fallbackFacts.observedState),
      ...(decision === null || decision === undefined
        ? {}
        : {
            reasonKind: decision.reason.kind,
            restart: { count: decision.restartNumber, limit: decision.restartLimit },
          }),
    },
  };
}

export function registerDeferredTurnMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<DeferredTurnMessageDetails>(
    DEFERRED_TURN_MESSAGE_TYPE,
    (message, { expanded }, theme) =>
      renderMessageCard(buildDeferredTurnMessageView(message, expanded, theme), theme),
  );
}

export function buildDeferredTurnMessageView(
  message: DeferredTurnMessage,
  expanded: boolean,
  theme?: Pick<Theme, "fg">,
): DeferredTurnMessageView {
  const details = parseMessageDetails(message.details);
  const presentation = details?.presentation;
  const workflowName = safeSingleLine(presentation?.workflowName, "Workflow");
  const outcome =
    presentation?.reasonKind ?? presentation?.state ?? details?.cause ?? "deferred turn";
  const appearance = outcomeAppearance(outcome);
  const title = paintMessageCard(
    theme,
    appearance.color,
    `${appearance.glyph} ${workflowName} · ${outcomeLabel(outcome)}`,
  );
  const statusParts = [
    ...(details === undefined ? [] : [`run ${safeSingleLine(details.runId, "unknown")}`]),
    ...(presentation?.restart === undefined
      ? []
      : [`restart ${presentation.restart.count}/${presentation.restart.limit}`]),
  ];
  const status = statusParts.length === 0 ? undefined : statusParts.join(" · ");
  if (!expanded) {
    return {
      title,
      ...(status === undefined ? {} : { status: paintMessageCard(theme, "dim", status) }),
    };
  }

  const metadata = [
    `Workflow: ${workflowName}`,
    `Run id: ${details === undefined ? "unknown" : safeSingleLine(details.runId, "unknown")}`,
    `Cause: ${details === undefined ? "unknown" : outcomeLabel(details.cause)}`,
    `State: ${presentation === undefined ? "unknown" : outcomeLabel(presentation.state)}`,
    ...(presentation?.reasonKind === undefined
      ? []
      : [`Reason kind: ${outcomeLabel(presentation.reasonKind)}`]),
    ...(presentation?.restart === undefined
      ? []
      : [`Restart: ${presentation.restart.count}/${presentation.restart.limit}`]),
  ];
  return {
    title,
    ...(status === undefined ? {} : { status: paintMessageCard(theme, "dim", status) }),
    expandedText: `${metadata.map((line) => paintMessageCard(theme, "dim", line)).join("\n")}\n\n${customMessageContentText(message.content)}`,
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

function parseMessageDetails(value: unknown): DeferredTurnMessageDetails | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DeferredTurnMessageDetails>;
  if (
    candidate.schema !== DEFERRED_TURN_MESSAGE_SCHEMA ||
    typeof candidate.turnIntentId !== "string" ||
    typeof candidate.runId !== "string" ||
    !isTurnIntentCause(candidate.cause)
  ) {
    return undefined;
  }
  const presentation = parsePresentation(candidate.presentation);
  return {
    schema: DEFERRED_TURN_MESSAGE_SCHEMA,
    turnIntentId: candidate.turnIntentId,
    runId: candidate.runId,
    cause: candidate.cause,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function parsePresentation(value: unknown): DeferredTurnMessagePresentation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DeferredTurnMessagePresentation>;
  if (typeof candidate.workflowName !== "string" || typeof candidate.state !== "string") {
    return undefined;
  }
  if (candidate.reasonKind !== undefined && !isTerminalReasonKind(candidate.reasonKind)) {
    return undefined;
  }
  const restart = parseRestart(candidate.restart);
  if (candidate.restart !== undefined && restart === undefined) return undefined;
  return {
    workflowName: candidate.workflowName,
    state: candidate.state,
    ...(candidate.reasonKind === undefined ? {} : { reasonKind: candidate.reasonKind }),
    ...(restart === undefined ? {} : { restart }),
  };
}

function parseRestart(value: unknown): { count: number; limit: number } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { count?: unknown; limit?: unknown };
  if (
    typeof candidate.count !== "number" ||
    !Number.isInteger(candidate.count) ||
    candidate.count < 0 ||
    typeof candidate.limit !== "number" ||
    !Number.isInteger(candidate.limit) ||
    candidate.limit < 0
  ) {
    return undefined;
  }
  return { count: candidate.count, limit: candidate.limit };
}

function isTurnIntentCause(value: unknown): value is WorkflowTurnIntentCause {
  return (
    typeof value === "string" &&
    [
      "agentCancelled",
      "timedOut",
      "failed",
      "launchFailed",
      "controllerInterrupted",
      "claimLost",
      "terminal",
      "cancelled",
    ].includes(value)
  );
}

function isTerminalReasonKind(value: unknown): value is TerminalReason["kind"] {
  return (
    typeof value === "string" &&
    ["completed", "failed", "timedOut", "maxSteps", "cancelled", "launchFailed"].includes(value)
  );
}

function safeSingleLine(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const clean = cleanSingleLine(value).trim();
  return clean.length === 0 ? fallback : clean;
}

function outcomeLabel(value: string): string {
  const clean = safeSingleLine(value, "unknown");
  const known: Readonly<Record<string, string>> = {
    agentCancelled: "agent cancelled",
    launchFailed: "launch failed",
    controllerInterrupted: "controller interrupted",
    claimLost: "claim lost",
    timedOut: "timed out",
    timed_out: "timed out",
    maxSteps: "max steps",
  };
  return known[clean] ?? clean.replaceAll("_", " ");
}

function outcomeAppearance(value: string): { glyph: string; color: MessageCardColor } {
  switch (value) {
    case "completed":
      return { glyph: "✓", color: "success" };
    case "failed":
    case "launchFailed":
    case "maxSteps":
      return { glyph: "×", color: "error" };
    case "cancelled":
    case "agentCancelled":
    case "timedOut":
    case "timed_out":
      return { glyph: "!", color: "warning" };
    default:
      return { glyph: "◆", color: "accent" };
  }
}

function boundedPresentationField(value: string): string {
  const clean = cleanSingleLine(value);
  return clean.length <= MAX_PRESENTATION_FIELD_CHARS
    ? clean
    : `${clean.slice(0, MAX_PRESENTATION_FIELD_CHARS - 1)}…`;
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
