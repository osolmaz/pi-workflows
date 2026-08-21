import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, TruncatedText } from "@earendil-works/pi-tui";
import { sanitizeText } from "../workflows/text.js";
import type { AgentStepContract, AgentStepPresentation } from "../workflows/types.js";
import type { PromptDeliveryKind } from "./executor.js";

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

  const metadata = [
    `Workflow: ${workflowName}`,
    ...(runTitle !== undefined ? [`Run title: ${runTitle}`] : []),
    `Run id: ${cleanSingleLine(contract?.runId ?? "unknown")}`,
    `Node id: ${nodeId}`,
    `Attempt id: ${cleanSingleLine(contract?.attemptId ?? "unknown")}`,
    `Delivery: ${kind}`,
    `Expected output: ${cleanSingleLine(contract?.expectedOutput ?? "a JSON object with your result")}`,
  ];
  const prompt = contentText(message.content);
  return {
    title,
    ...(statusDetail !== undefined ? { status: paint(theme, "dim", statusDetail) } : {}),
    expandedText: `${metadata.map((line) => paint(theme, "dim", line)).join("\n")}\n\n${prompt}`,
  };
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
    typeof contract.attemptId !== "string"
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
