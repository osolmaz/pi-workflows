export type PublicAssistantMessageEvent =
  | { type: "start"; partial: unknown }
  | { type: "text_start"; contentIndex: number; partial: unknown }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: unknown }
  | { type: "text_end"; contentIndex: number; content: string; partial: unknown }
  | { type: "thinking_start"; contentIndex: number; partial: unknown }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: unknown }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: unknown }
  | { type: "toolcall_start"; contentIndex: number; partial: unknown }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: unknown }
  | { type: "toolcall_end"; contentIndex: number; toolCall: unknown; partial: unknown }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: unknown }
  | { type: "error"; reason: "aborted" | "error"; error: unknown };

export type TurnStartEventLike = { turnIndex: number };
export type TurnEndEventLike = { turnIndex: number; message: unknown };
export type MessageStartEventLike = { message: unknown };
export type MessageUpdateEventLike = {
  message: unknown;
  assistantMessageEvent: PublicAssistantMessageEvent;
};
export type MessageEndEventLike = { message: unknown };
export type ToolExecutionStartEventLike = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};
export type ToolExecutionUpdateEventLike = { toolCallId: string };
export type ToolExecutionEndEventLike = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

export type NormalizedAssistantEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCallId?: string; toolName?: string }
  | { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred" }
  | { type: "error"; reason: "aborted" | "error" };

/** Remove cumulative snapshots while preserving every semantic stream event. */
export function normalizeAssistantEvent(
  event: PublicAssistantMessageEvent,
): NormalizedAssistantEvent {
  switch (event.type) {
    case "start":
      return { type: event.type };
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
    case "thinking_end":
      return { type: event.type, contentIndex: event.contentIndex };
    case "toolcall_end": {
      const toolCall =
        typeof event.toolCall === "object" && event.toolCall !== null
          ? (event.toolCall as { id?: unknown; name?: unknown })
          : {};
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        ...(typeof toolCall.id === "string" ? { toolCallId: toolCall.id } : {}),
        ...(typeof toolCall.name === "string" ? { toolName: toolCall.name } : {}),
      };
    }
    case "done":
      return { type: event.type, reason: event.reason };
    case "error":
      return { type: event.type, reason: event.reason };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function messageRole(message: unknown): string {
  if (typeof message !== "object" || message === null || !("role" in message)) {
    return "unknown";
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" && role.length > 0 ? role : "unknown";
}

export function toolCallIdFromAssistantEvent(event: NormalizedAssistantEvent): string | null {
  return event.type === "toolcall_end" && event.toolCallId !== undefined ? event.toolCallId : null;
}

export function toolStartedPayload(event: ToolExecutionStartEventLike): Record<string, unknown> {
  return { toolName: event.toolName };
}

export function toolFinishedPayload(event: ToolExecutionEndEventLike): Record<string, unknown> {
  return { toolName: event.toolName, isError: event.isError };
}

export function turnFinishedPayload(
  event: TurnEndEventLike,
  messageId: string | undefined,
  toolCallIds: string[],
): Record<string, unknown> {
  return {
    turnIndex: event.turnIndex,
    ...(messageId === undefined ? {} : { messageId }),
    toolCallIds,
  };
}
