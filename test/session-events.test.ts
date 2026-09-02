import { describe, expect, it } from "vitest";
import {
  messageRole,
  normalizeAssistantEvent,
  toolCallIdFromAssistantEvent,
  toolFinishedPayload,
  toolStartedPayload,
  turnFinishedPayload,
  type PublicAssistantMessageEvent,
} from "../src/extension/session-events.js";

describe("session event normalization", () => {
  it("keeps semantic assistant events and removes cumulative snapshots", () => {
    const cases: Array<[PublicAssistantMessageEvent, unknown]> = [
      [{ type: "start", partial: { ignored: true } }, { type: "start" }],
      [
        { type: "text_start", contentIndex: 0, partial: { ignored: true } },
        { type: "text_start", contentIndex: 0 },
      ],
      [
        { type: "text_delta", contentIndex: 0, delta: "a", partial: { ignored: true } },
        { type: "text_delta", contentIndex: 0, delta: "a" },
      ],
      [
        { type: "text_end", contentIndex: 0, content: "abc", partial: { ignored: true } },
        { type: "text_end", contentIndex: 0, content: "abc" },
      ],
      [
        { type: "thinking_start", contentIndex: 1, partial: { ignored: true } },
        { type: "thinking_start", contentIndex: 1 },
      ],
      [
        { type: "thinking_delta", contentIndex: 1, delta: "b", partial: { ignored: true } },
        { type: "thinking_delta", contentIndex: 1, delta: "b" },
      ],
      [
        { type: "thinking_end", contentIndex: 1, content: "why", partial: { ignored: true } },
        { type: "thinking_end", contentIndex: 1, content: "why" },
      ],
      [
        { type: "toolcall_start", contentIndex: 2, partial: { ignored: true } },
        { type: "toolcall_start", contentIndex: 2 },
      ],
      [
        { type: "toolcall_delta", contentIndex: 2, delta: "{", partial: { ignored: true } },
        { type: "toolcall_delta", contentIndex: 2, delta: "{" },
      ],
      [
        {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: { id: "tool-1", name: "read" },
          partial: { ignored: true },
        },
        { type: "toolcall_end", contentIndex: 2, toolCall: { id: "tool-1", name: "read" } },
      ],
      [
        { type: "done", reason: "toolUse", message: { ignored: true } },
        { type: "done", reason: "toolUse" },
      ],
      [
        { type: "error", reason: "aborted", error: new Error("ignored") },
        { type: "error", reason: "aborted" },
      ],
    ];

    for (const [input, expected] of cases) {
      expect(normalizeAssistantEvent(input)).toEqual(expected);
    }
  });

  it("reads roles and tool call IDs without trusting malformed messages", () => {
    expect(messageRole({ role: "assistant" })).toBe("assistant");
    expect(messageRole({ role: "" })).toBe("unknown");
    expect(messageRole({})).toBe("unknown");
    expect(messageRole(null)).toBe("unknown");

    expect(
      toolCallIdFromAssistantEvent({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "tool-1" },
      }),
    ).toBe("tool-1");
    expect(
      toolCallIdFromAssistantEvent({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "" },
      }),
    ).toBeNull();
    expect(
      toolCallIdFromAssistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall: null }),
    ).toBeNull();
    expect(toolCallIdFromAssistantEvent({ type: "start" })).toBeNull();
  });

  it("builds bounded tool and turn payloads", () => {
    expect(
      toolStartedPayload({ toolCallId: "tool-1", toolName: "read", args: { path: "x" } }),
    ).toEqual({
      toolName: "read",
      args: { path: "x" },
    });
    expect(
      toolFinishedPayload({
        toolCallId: "tool-1",
        toolName: "read",
        result: { ok: true },
        isError: false,
      }),
    ).toEqual({ toolName: "read", isError: false, result: { ok: true } });
    expect(turnFinishedPayload({ turnIndex: 2, message: {} }, "message-1", ["tool-1"])).toEqual({
      turnIndex: 2,
      messageId: "message-1",
      toolCallIds: ["tool-1"],
    });
    expect(turnFinishedPayload({ turnIndex: 3, message: {} }, undefined, [])).toEqual({
      turnIndex: 3,
      toolCallIds: [],
    });
  });
});
