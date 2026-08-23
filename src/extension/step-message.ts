import { createHash } from "node:crypto";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, TruncatedText } from "@earendil-works/pi-tui";
import { sanitizeText } from "../workflows/text.js";
import type {
  AgentStepContract,
  AgentStepPresentation,
  AgentStepSubmission,
} from "../workflows/types.js";
import { visibleAssistantText, type PromptDeliveryKind } from "./executor.js";

export const WORKFLOW_AGENT_STEP_MESSAGE_TYPE = "pi-workflows-agent-step";
export const WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA = "pi-workflows.agent-step-message.v1";

export type WorkflowAgentStepMessageDetails = {
  schema: typeof WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA;
  kind: PromptDeliveryKind;
  contract: AgentStepContract;
  presentation?: AgentStepPresentation;
  turnIntentId?: string;
};

type WorkflowAgentStepMessage = {
  content: unknown;
  details?: unknown;
};

type WorkflowAgentStepView = {
  title: string;
  status?: string;
  expandedText?: string;
};

export function registerWorkflowAgentStepMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<WorkflowAgentStepMessageDetails>(
    WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const view = buildWorkflowAgentStepView(message, expanded, theme);
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new TruncatedText(view.title));
      if (view.status !== undefined) {
        box.addChild(new TruncatedText(view.status));
      }
      if (view.expandedText !== undefined) {
        box.addChild(new Text(`\n${view.expandedText}`));
      }
      return box;
    },
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
  const kind = details?.kind ?? "step";
  const workflowName = cleanSingleLine(contract?.workflowName ?? "Workflow");
  const nodeId = cleanSingleLine(contract?.nodeId ?? "step");
  const runTitle = cleanOptionalSingleLine(details?.presentation?.runTitle);
  const statusDetail = cleanOptionalSingleLine(details?.presentation?.statusDetail);
  const label = runTitle ?? workflowName;
  const suffix = kind === "step" ? "" : ` · ${kind}`;
  const glyph = kind === "step" ? "▶" : "↻";
  const title = paint(theme, "accent", `${glyph} ${label} › ${nodeId}${suffix}`);

  if (!expanded) {
    return {
      title,
      ...(statusDetail !== undefined ? { status: paint(theme, "dim", statusDetail) } : {}),
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
    `Delivery: ${kind}`,
    `Completion: ${assistant ? "assistant response" : "workflow submission"}`,
    `Expected output: ${cleanSingleLine(expectedOutput)}`,
  ];
  const prompt = contentText(message.content);
  return {
    title,
    ...(statusDetail !== undefined ? { status: paint(theme, "dim", statusDetail) } : {}),
    expandedText: `${metadata.map((line) => paint(theme, "dim", line)).join("\n")}\n\n${prompt}`,
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
  if (candidate.kind !== "step" && candidate.kind !== "reminder" && candidate.kind !== "resume") {
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

function contentText(content: unknown): string {
  if (typeof content === "string") return cleanMultiline(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part === null || typeof part !== "object" || !("text" in part)) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? cleanMultiline(text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function cleanOptionalSingleLine(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? cleanSingleLine(value) : undefined;
}

function cleanSingleLine(value: string): string {
  return sanitizeText(value);
}

function cleanMultiline(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => sanitizeText(line))
    .join("\n");
}

function paint(
  theme: Pick<Theme, "fg"> | undefined,
  color: "accent" | "dim",
  text: string,
): string {
  return theme?.fg(color, text) ?? text;
}
