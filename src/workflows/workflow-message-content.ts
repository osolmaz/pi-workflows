import type { JsonValue } from "../state/json.js";
import {
  WORKFLOW_MESSAGE_CONTENT_SCHEMA,
  type WorkflowMessageContent,
  type WorkflowStepReason,
} from "../state/workflow-messages.js";
import type { AgentStepContract } from "./types.js";

export const WORKFLOW_STEP_MESSAGE_TYPE = "pi-workflows-step";
export const WORKFLOW_DECISION_MESSAGE_TYPE = "pi-workflows-interaction";
export const WORKFLOW_NOTIFICATION_MESSAGE_TYPE = "pi-workflows-notification";
export const WORKFLOW_TERMINAL_MESSAGE_TYPE = "pi-workflows-presentation";
export const WORKFLOW_FOLLOW_UP_MESSAGE_TYPE = "pi-workflows-follow-up";

export function stepWorkflowMessageContent(options: {
  workflowMessageId: string;
  requestId: string;
  contract: JsonValue;
  reason: WorkflowStepReason;
}): WorkflowMessageContent {
  const outer = requireRecord(options.contract, "Stored workflow step contract");
  const agent = requireAgentContract(outer.contract);
  const details: Record<string, JsonValue> = {
    schema: "pi-workflows.agent-step-message.v1",
    kind: "step",
    contract: agent as unknown as JsonValue,
    requestId: options.requestId,
    workflowMessageId: options.workflowMessageId,
    reason: options.reason,
  };
  if (isRecord(outer.presentation)) details.presentation = outer.presentation as JsonValue;
  return {
    schema: WORKFLOW_MESSAGE_CONTENT_SCHEMA,
    customType: WORKFLOW_STEP_MESSAGE_TYPE,
    content: typeof outer.prompt === "string" ? outer.prompt : "Continue the workflow step.",
    display: true,
    details,
    triggerTurn: true,
  };
}

export function decisionWorkflowMessageContent(options: {
  workflowMessageId: string;
  requestId: string;
  runId: string;
  contract: JsonValue;
}): WorkflowMessageContent {
  const contract = requireRecord(options.contract, "Stored workflow decision contract");
  return {
    schema: WORKFLOW_MESSAGE_CONTENT_SCHEMA,
    customType: WORKFLOW_DECISION_MESSAGE_TYPE,
    content: decisionPrompt(contract),
    display: true,
    details: {
      workflowMessageId: options.workflowMessageId,
      requestId: options.requestId,
      runId: options.runId,
      kind: "decision",
    },
    triggerTurn: false,
  };
}

export function notificationWorkflowMessageContent(options: {
  workflowMessageId: string;
  notificationId: string;
  runId: string;
  kind: "progress" | "final";
  content: string;
}): WorkflowMessageContent {
  return {
    schema: WORKFLOW_MESSAGE_CONTENT_SCHEMA,
    customType: WORKFLOW_NOTIFICATION_MESSAGE_TYPE,
    content: options.content,
    display: true,
    details: {
      workflowMessageId: options.workflowMessageId,
      notificationId: options.notificationId,
      runId: options.runId,
      kind: options.kind,
    },
    triggerTurn: false,
  };
}

export function terminalWorkflowMessageContent(options: {
  workflowMessageId: string;
  runId: string;
  content: string;
  details: JsonValue;
}): WorkflowMessageContent {
  return {
    schema: WORKFLOW_MESSAGE_CONTENT_SCHEMA,
    customType: WORKFLOW_TERMINAL_MESSAGE_TYPE,
    content: options.content,
    display: false,
    details: {
      workflowMessageId: options.workflowMessageId,
      runId: options.runId,
      kind: "terminal",
      terminal: options.details,
    },
    triggerTurn: true,
  };
}

export function followUpWorkflowMessageContent(options: {
  workflowMessageId: string;
  followUpId: string;
  runId: string;
  prompt: string;
}): WorkflowMessageContent {
  return {
    schema: WORKFLOW_MESSAGE_CONTENT_SCHEMA,
    customType: WORKFLOW_FOLLOW_UP_MESSAGE_TYPE,
    content: options.prompt,
    display: true,
    details: {
      workflowMessageId: options.workflowMessageId,
      followUpId: options.followUpId,
      runId: options.runId,
      kind: "followUp",
    },
    triggerTurn: true,
  };
}

function requireAgentContract(value: unknown): AgentStepContract {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.workflowName !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.attemptId !== "string" ||
    (value.completion !== "submit" && value.completion !== "assistant")
  ) {
    throw new Error("Stored workflow agent contract is invalid");
  }
  return value as unknown as AgentStepContract;
}

function decisionPrompt(contract: Record<string, unknown>): string {
  const title = typeof contract.title === "string" ? contract.title : "Workflow decision";
  const presentation = isRecord(contract.presentation) ? contract.presentation : {};
  const blocks = Array.isArray(presentation.blocks)
    ? presentation.blocks.flatMap((block) => decisionBlockText(block))
    : [];
  const choices = isRecord(contract.choices)
    ? Object.entries(contract.choices).map(([key, value]) => {
        const choice = isRecord(value) ? value : {};
        const label = typeof choice.label === "string" ? choice.label : key;
        const input = isRecord(choice.input) ? choice.input : undefined;
        const prompt = input === undefined ? "" : `; input: ${String(input.prompt ?? "text")}`;
        return `- ${key}: ${label}${prompt}`;
      })
    : [];
  return [
    title,
    typeof presentation.summary === "string" ? presentation.summary : "",
    ...blocks,
    choices.length === 0 ? "" : `Choices:\n${choices.join("\n")}`,
    "A human must answer this protected decision with `/workflow answer`.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function decisionBlockText(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (value.kind === "paragraph" && typeof value.text === "string") return [value.text];
  if (value.kind === "section" && typeof value.title === "string") return [value.title];
  if (value.kind === "preformatted" && typeof value.text === "string") return [value.text];
  if (value.kind === "bullets" && Array.isArray(value.items)) {
    return [value.items.map((item) => `- ${String(item)}`).join("\n")];
  }
  if (value.kind === "fields" && Array.isArray(value.items)) {
    return [
      value.items
        .flatMap((item) =>
          isRecord(item) && typeof item.label === "string" && typeof item.value === "string"
            ? [`${item.label}: ${item.value}`]
            : [],
        )
        .join("\n"),
    ];
  }
  return [];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
