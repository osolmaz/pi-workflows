import type { WorkflowSessionEntryRecord, WorkflowSessionEventRecord } from "../workflows/types.js";

export type TemporalContentBlock = {
  contentIndex: number;
  kind: "text" | "thinking" | "toolCall";
  text: string;
  value?: unknown;
};

export type TemporalMessage = {
  messageId: string;
  role: string;
  status: "streaming" | "finished" | "error" | "settled" | "unsettled";
  entryId?: string;
  blocks: TemporalContentBlock[];
};

export type TemporalTool = {
  toolCallId: string;
  messageId: string;
  toolName: string;
  status: "running" | "finished" | "failed";
  updates: number;
  args?: unknown;
  result?: unknown;
};

export type TemporalSessionState = {
  throughSeq: number;
  messages: TemporalMessage[];
  tools: TemporalTool[];
  settledEntryIds: string[];
  diagnostics: string[];
};

type MutableMessage = Omit<TemporalMessage, "blocks"> & {
  blocks: Map<number, TemporalContentBlock>;
};

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function payloadIndex(payload: Record<string, unknown>): number | undefined {
  const value = payload.contentIndex;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function ensureBlock(
  message: MutableMessage,
  contentIndex: number,
  kind: TemporalContentBlock["kind"],
): TemporalContentBlock {
  const existing = message.blocks.get(contentIndex);
  if (existing) {
    return existing;
  }
  const block: TemporalContentBlock = { contentIndex, kind, text: "" };
  message.blocks.set(contentIndex, block);
  return block;
}

function entryIds(entries: WorkflowSessionEntryRecord[]): Set<string> {
  return new Set(
    entries.flatMap((record) => {
      const id = record.entry.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/** Fold the durable semantic journal through one sequence position. */
export function reduceSessionEvents(
  entries: WorkflowSessionEntryRecord[],
  events: WorkflowSessionEventRecord[],
  throughSeq: number = Number.MAX_SAFE_INTEGER,
): TemporalSessionState {
  const messages = new Map<string, MutableMessage>();
  const messageOrder: string[] = [];
  const tools = new Map<string, TemporalTool>();
  const toolOrder: string[] = [];
  const settledEntryIds: string[] = [];
  const knownEntries = entryIds(entries);
  const diagnostics: string[] = [];
  let expectedSeq = 1;
  let lastSeq = 0;

  for (const event of events) {
    if (event.seq > throughSeq) {
      break;
    }
    if (event.seq !== expectedSeq) {
      diagnostics.push(`session event sequence gap at ${expectedSeq}`);
      expectedSeq = event.seq;
    }
    expectedSeq += 1;
    lastSeq = event.seq;

    switch (event.type) {
      case "message_started": {
        if (!event.messageId) {
          diagnostics.push(`message_started ${event.seq} has no messageId`);
          break;
        }
        if (!messages.has(event.messageId)) {
          messages.set(event.messageId, {
            messageId: event.messageId,
            role: payloadString(event.payload, "role") ?? "unknown",
            status: "streaming",
            blocks: new Map(),
          });
          messageOrder.push(event.messageId);
        }
        break;
      }
      case "assistant_event": {
        if (!event.messageId) {
          diagnostics.push(`assistant_event ${event.seq} has no messageId`);
          break;
        }
        const message = messages.get(event.messageId);
        if (!message) {
          diagnostics.push(`assistant_event ${event.seq} precedes message_started`);
          break;
        }
        const assistantType = payloadString(event.payload, "type");
        const contentIndex = payloadIndex(event.payload);
        if (
          contentIndex !== undefined &&
          (assistantType === "text_start" ||
            assistantType === "thinking_start" ||
            assistantType === "toolcall_start")
        ) {
          ensureBlock(
            message,
            contentIndex,
            assistantType === "text_start"
              ? "text"
              : assistantType === "thinking_start"
                ? "thinking"
                : "toolCall",
          );
        } else if (
          contentIndex !== undefined &&
          (assistantType === "text_delta" ||
            assistantType === "thinking_delta" ||
            assistantType === "toolcall_delta")
        ) {
          const block = ensureBlock(
            message,
            contentIndex,
            assistantType === "text_delta"
              ? "text"
              : assistantType === "thinking_delta"
                ? "thinking"
                : "toolCall",
          );
          block.text += payloadString(event.payload, "delta") ?? "";
        } else if (
          contentIndex !== undefined &&
          (assistantType === "text_end" || assistantType === "thinking_end")
        ) {
          const block = ensureBlock(
            message,
            contentIndex,
            assistantType === "text_end" ? "text" : "thinking",
          );
          const content = payloadString(event.payload, "content") ?? "";
          if (block.text !== content) {
            diagnostics.push(`${assistantType} mismatch for ${event.messageId}:${contentIndex}`);
            block.text = content;
          }
        } else if (contentIndex !== undefined && assistantType === "toolcall_end") {
          const block = ensureBlock(message, contentIndex, "toolCall");
          block.value = event.payload.toolCall;
        } else if (assistantType === "done") {
          message.status = "finished";
        } else if (assistantType === "error") {
          message.status = "error";
        }
        break;
      }
      case "message_finished": {
        if (!event.messageId) {
          diagnostics.push(`message_finished ${event.seq} has no messageId`);
          break;
        }
        const message = messages.get(event.messageId);
        if (!message) {
          diagnostics.push(`message_finished ${event.seq} precedes message_started`);
          break;
        }
        const settled = event.payload.settled === true;
        const entryId = payloadString(event.payload, "entryId");
        if (settled && entryId) {
          message.status = "settled";
          message.entryId = entryId;
          settledEntryIds.push(entryId);
          if (!knownEntries.has(entryId)) {
            diagnostics.push(`settled entry ${entryId} is missing`);
          }
        } else {
          message.status = "unsettled";
        }
        break;
      }
      case "tool_execution_started": {
        if (!event.toolCallId || !event.messageId) {
          diagnostics.push(`tool_execution_started ${event.seq} is uncorrelated`);
          break;
        }
        const tool: TemporalTool = {
          toolCallId: event.toolCallId,
          messageId: event.messageId,
          toolName: payloadString(event.payload, "toolName") ?? "tool",
          status: "running",
          updates: 0,
          ...(event.payload.args === undefined ? {} : { args: event.payload.args }),
        };
        tools.set(event.toolCallId, tool);
        toolOrder.push(event.toolCallId);
        break;
      }
      case "tool_execution_updated": {
        const tool = event.toolCallId ? tools.get(event.toolCallId) : undefined;
        if (tool) {
          tool.updates += 1;
        } else {
          diagnostics.push(`tool_execution_updated ${event.seq} precedes start`);
        }
        break;
      }
      case "tool_execution_finished": {
        const tool = event.toolCallId ? tools.get(event.toolCallId) : undefined;
        if (!tool) {
          diagnostics.push(`tool_execution_finished ${event.seq} precedes start`);
          break;
        }
        tool.status = event.payload.isError === true ? "failed" : "finished";
        if (event.payload.result !== undefined) {
          tool.result = event.payload.result;
        }
        break;
      }
      case "turn_started":
      case "turn_finished":
        break;
      default:
        break;
    }
  }

  return {
    throughSeq: lastSeq,
    messages: messageOrder.map((messageId) => {
      const message = messages.get(messageId)!;
      return {
        messageId: message.messageId,
        role: message.role,
        status: message.status,
        ...(message.entryId === undefined ? {} : { entryId: message.entryId }),
        blocks: [...message.blocks.values()].toSorted(
          (left, right) => left.contentIndex - right.contentIndex,
        ),
      };
    }),
    tools: toolOrder.map((toolCallId) => tools.get(toolCallId)!),
    settledEntryIds,
    diagnostics,
  };
}
