import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, TruncatedText } from "@earendil-works/pi-tui";
import { sanitizeText } from "../workflows/text.js";

export type MessageCardView = {
  title: string;
  status?: string;
  expandedText?: string;
};

export type MessageCardColor = "accent" | "dim" | "error" | "success" | "warning";

export function renderMessageCard(view: MessageCardView, theme: Theme): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new TruncatedText(view.title));
  if (view.status !== undefined) {
    box.addChild(new TruncatedText(view.status));
  }
  if (view.expandedText !== undefined) {
    box.addChild(new Text(`\n${view.expandedText}`));
  }
  return box;
}

export function customMessageContentText(content: unknown): string {
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

export function cleanOptionalSingleLine(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? cleanSingleLine(value) : undefined;
}

export function cleanSingleLine(value: string): string {
  return sanitizeText(value);
}

export function paintMessageCard(
  theme: Pick<Theme, "fg"> | undefined,
  color: MessageCardColor,
  text: string,
): string {
  return theme?.fg(color, text) ?? text;
}

function cleanMultiline(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => sanitizeText(line))
    .join("\n");
}
