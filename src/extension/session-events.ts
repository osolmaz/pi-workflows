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
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: unknown }
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
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: unknown }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
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
      return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "toolcall_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        toolCall: event.toolCall,
      };
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
  if (event.type !== "toolcall_end" || typeof event.toolCall !== "object" || !event.toolCall) {
    return null;
  }
  const id = (event.toolCall as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function toolStartedPayload(event: ToolExecutionStartEventLike): Record<string, unknown> {
  return { toolName: event.toolName, args: event.args };
}

export function toolFinishedPayload(event: ToolExecutionEndEventLike): Record<string, unknown> {
  return { toolName: event.toolName, isError: event.isError, result: event.result };
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
