import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_TERMINAL_MESSAGE_TYPE } from "../workflows/workflow-message-content.js";
import {
  cleanSingleLine,
  customMessageContentText,
  renderMessageCard,
  type MessageCardView,
} from "./message-card.js";

export function terminalMessageView(
  message: { content: unknown; details?: unknown },
  expanded: boolean,
): MessageCardView {
  const details = record(message.details);
  const terminal = record(details.terminal);
  const name = typeof terminal.workflowName === "string" ? terminal.workflowName : "Workflow";
  const status = typeof terminal.status === "string" ? terminal.status : "finished";
  const reason = typeof terminal.reason === "string" ? terminal.reason : terminal.error;
  return {
    title: cleanSingleLine(`${name} · ${status}`),
    ...(typeof reason === "string" && reason.length > 0 ? { status: cleanSingleLine(reason) } : {}),
    ...(expanded ? { expandedText: customMessageContentText(message.content) } : {}),
  };
}

export function registerTerminalMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(WORKFLOW_TERMINAL_MESSAGE_TYPE, (message, { expanded }, theme) =>
    renderMessageCard(terminalMessageView(message, expanded), theme),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
