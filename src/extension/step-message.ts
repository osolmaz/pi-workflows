import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_STEP_MESSAGE_TYPE } from "../workflows/workflow-message-content.js";
import type {
  AgentStepContract,
  AgentStepPresentation,
  AgentStepSubmission,
} from "../workflows/types.js";
import {
  cleanOptionalSingleLine,
  cleanSingleLine,
  customMessageContentText,
  paintMessageCard,
  renderMessageCard,
  type MessageCardView,
} from "./message-card.js";

export const WORKFLOW_AGENT_STEP_MESSAGE_TYPE = WORKFLOW_STEP_MESSAGE_TYPE;
export const WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA = "pi-workflows.agent-step-message.v1";

type PromptDeliveryReason = "initial" | "reminder" | "resumed";

export type WorkflowAgentStepMessageDetails = {
  schema: typeof WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA;
  kind: "step";
  reason: PromptDeliveryReason;
  contract: AgentStepContract;
  presentation?: AgentStepPresentation;
  requestId: string;
  workflowMessageId: string;
};

type WorkflowAgentStepMessage = {
  content: unknown;
  details?: unknown;
};

type WorkflowAgentStepView = MessageCardView;

export function registerWorkflowAgentStepMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<WorkflowAgentStepMessageDetails>(
    WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
    (message, { expanded }, theme) =>
      renderMessageCard(buildWorkflowAgentStepView(message, expanded, theme), theme),
  );
}

/** Build renderer text without depending on Pi's session or TUI state. */
export function buildWorkflowAgentStepView(
  message: WorkflowAgentStepMessage,
  expanded: boolean,
  theme?: Pick<Theme, "fg">,
): WorkflowAgentStepView {
  const details = parseDetails(message.details);
  const contract = details?.contract;
  const reason = details?.reason ?? "initial";
  const workflowName = cleanSingleLine(contract?.workflowName ?? "Workflow");
  const nodeId = cleanSingleLine(contract?.nodeId ?? "step");
  const runTitle = cleanOptionalSingleLine(details?.presentation?.runTitle);
  const statusDetail = cleanOptionalSingleLine(details?.presentation?.statusDetail);
  const label = runTitle ?? workflowName;
  const suffix = reason === "initial" ? "" : ` · ${reason}`;
  const glyph = reason === "initial" ? "▶" : "↻";
  const title = paintMessageCard(theme, "accent", `${glyph} ${label} › ${nodeId}${suffix}`);

  if (!expanded) {
    return {
      title,
      ...(statusDetail !== undefined
        ? { status: paintMessageCard(theme, "dim", statusDetail) }
        : {}),
    };
  }

  const assistant = contract?.completion === "assistant";
  const expectedOutput = assistant
    ? `normal assistant response${contract?.maxOutputChars === undefined ? "" : ` (maximum ${contract.maxOutputChars} characters)`}`
    : (contract?.expectedOutput ?? "a JSON object with your result");
  const metadata = [
    `Workflow: ${workflowName}`,
    ...(runTitle !== undefined ? [`Run title: ${runTitle}`] : []),
    `Run id: ${cleanSingleLine(contract?.runId ?? "unknown")}`,
    `Node id: ${nodeId}`,
    `Attempt id: ${cleanSingleLine(contract?.attemptId ?? "unknown")}`,
    `Reason: ${reason}`,
    `Completion: ${assistant ? "assistant response" : "workflow submission"}`,
    `Expected output: ${cleanSingleLine(expectedOutput)}`,
  ];
  const prompt = customMessageContentText(message.content);
  return {
    title,
    ...(statusDetail !== undefined ? { status: paintMessageCard(theme, "dim", statusDetail) } : {}),
    expandedText: `${metadata.map((line) => paintMessageCard(theme, "dim", line)).join("\n")}\n\n${prompt}`,
  };
}

/**
 * Adopt an already visible response for the same assistant-output attempt.
 * This is used only when an interrupted run resumes in its origin session.
 */
export function recoverAssistantStep(
  entries: readonly unknown[],
  contract: AgentStepContract,
): AgentStepSubmission | undefined {
  if (contract.completion !== "assistant") return undefined;
  for (let promptIndex = entries.length - 1; promptIndex >= 0; promptIndex -= 1) {
    const prompt = sessionEntry(entries[promptIndex]);
    if (
      prompt?.type !== "custom_message" ||
      prompt.customType !== WORKFLOW_AGENT_STEP_MESSAGE_TYPE
    ) {
      continue;
    }
    const details = parseDetails(prompt.details);
    if (details === undefined || !sameAttempt(details.contract, contract)) continue;

    let response: Record<string, unknown> | undefined;
    for (let responseIndex = promptIndex + 1; responseIndex < entries.length; responseIndex += 1) {
      const candidate = sessionEntry(entries[responseIndex]);
      if (candidate === undefined) continue;
      if (
        candidate.type === "custom_message" &&
        candidate.customType === WORKFLOW_AGENT_STEP_MESSAGE_TYPE
      ) {
        break;
      }
      if (candidate.type !== "message") continue;
      const message = sessionEntry(candidate.message);
      if (message?.role === "user") break;
      if (isAssistantWithVisibleText(message)) response = candidate;
    }
    if (response === undefined) return undefined;
    const output = visibleAssistantText(response.message, contract.maxOutputChars);
    const entryId = typeof response.id === "string" ? response.id : undefined;
    const promptId = typeof prompt.id === "string" ? prompt.id : undefined;
    return {
      output,
      assistantMessage: {
        sha256: createHash("sha256").update(output).digest("hex"),
        ...(entryId !== undefined ? { entryId } : {}),
        ...(contract.maxOutputChars !== undefined ? { maxChars: contract.maxOutputChars } : {}),
        recovered: true,
      },
      ...(promptId !== undefined && entryId !== undefined
        ? { conversation: { firstEntryId: promptId, lastEntryId: entryId } }
        : {}),
    };
  }
  return undefined;
}

function sameAttempt(left: AgentStepContract, right: AgentStepContract): boolean {
  return (
    left.runId === right.runId &&
    left.workflowName === right.workflowName &&
    left.nodeId === right.nodeId &&
    left.attemptId === right.attemptId &&
    left.completion === "assistant" &&
    left.maxOutputChars === right.maxOutputChars
  );
}

function sessionEntry(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assistantMessageLike(
  message: unknown,
): Pick<AssistantMessage, "role" | "content" | "stopReason" | "errorMessage"> | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const candidate = message as Partial<AssistantMessage>;
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
  if (typeof candidate.stopReason !== "string") return undefined;
  return candidate as Pick<AssistantMessage, "role" | "content" | "stopReason" | "errorMessage">;
}

/** Extract the exact visible text blocks from one finalized assistant message. */
export function visibleAssistantText(message: unknown, maxChars?: number): string {
  const assistant = assistantMessageLike(message);
  if (assistant === undefined) {
    throw new Error("Assistant step settled without a final assistant message");
  }
  if (assistant.stopReason !== "stop" && assistant.stopReason !== "length") {
    throw new Error(
      assistant.errorMessage?.trim() ||
        `Assistant step stopped with ${JSON.stringify(assistant.stopReason)} before a final response`,
    );
  }
  const text = assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (text.trim().length === 0) {
    throw new Error("Assistant step returned no visible text");
  }
  if (maxChars !== undefined && text.length > maxChars) {
    throw new Error(
      `Assistant response has ${text.length} characters, above the configured limit of ${maxChars}`,
    );
  }
  return text;
}

function isAssistantWithVisibleText(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; content?: unknown; stopReason?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return false;
  if (candidate.stopReason !== "stop" && candidate.stopReason !== "length") return false;
  return candidate.content.some(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.trim().length > 0,
  );
}

function parseDetails(value: unknown): WorkflowAgentStepMessageDetails | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<WorkflowAgentStepMessageDetails>;
  if (candidate.schema !== WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA) return undefined;
  if (
    candidate.kind !== "step" ||
    (candidate.reason !== "initial" &&
      candidate.reason !== "reminder" &&
      candidate.reason !== "resumed") ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.workflowMessageId !== "string"
  ) {
    return undefined;
  }
  const contract = candidate.contract;
  if (
    contract === null ||
    typeof contract !== "object" ||
    typeof contract.runId !== "string" ||
    typeof contract.workflowName !== "string" ||
    typeof contract.nodeId !== "string" ||
    typeof contract.attemptId !== "string" ||
    (contract.completion !== "submit" && contract.completion !== "assistant") ||
    (contract.maxOutputChars !== undefined &&
      (typeof contract.maxOutputChars !== "number" ||
        !Number.isInteger(contract.maxOutputChars) ||
        contract.maxOutputChars <= 0))
  ) {
    return undefined;
  }
  return candidate as WorkflowAgentStepMessageDetails;
}
