import { describe, expect, it } from "vitest";
import {
  normalizeAssistantEvent,
  type PublicAssistantMessageEvent,
} from "../src/extension/session-events.js";

const partial = { role: "assistant", content: "cumulative" };

const cases: Array<{
  event: PublicAssistantMessageEvent;
  expected: Record<string, unknown>;
}> = [
  { event: { type: "start", partial }, expected: { type: "start" } },
  {
    event: { type: "text_start", contentIndex: 0, partial },
    expected: { type: "text_start", contentIndex: 0 },
  },
  {
    event: { type: "text_delta", contentIndex: 0, delta: "hi", partial },
    expected: { type: "text_delta", contentIndex: 0, delta: "hi" },
  },
  {
    event: { type: "text_end", contentIndex: 0, content: "hi", partial },
    expected: { type: "text_end", contentIndex: 0, content: "hi" },
  },
  {
    event: { type: "thinking_start", contentIndex: 1, partial },
    expected: { type: "thinking_start", contentIndex: 1 },
  },
  {
    event: { type: "thinking_delta", contentIndex: 1, delta: "hmm", partial },
    expected: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
  },
  {
    event: { type: "thinking_end", contentIndex: 1, content: "hmm", partial },
    expected: { type: "thinking_end", contentIndex: 1, content: "hmm" },
  },
  {
    event: { type: "toolcall_start", contentIndex: 2, partial },
    expected: { type: "toolcall_start", contentIndex: 2 },
  },
  {
    event: { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial },
    expected: { type: "toolcall_delta", contentIndex: 2, delta: "{}" },
  },
  {
    event: {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: { id: "call-1", name: "read", arguments: {} },
      partial,
    },
    expected: {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: { id: "call-1", name: "read", arguments: {} },
    },
  },
  {
    event: { type: "done", reason: "stop", message: partial },
    expected: { type: "done", reason: "stop" },
  },
  {
    event: { type: "error", reason: "aborted", error: partial },
    expected: { type: "error", reason: "aborted" },
  },
];

describe("normalizeAssistantEvent", () => {
  it.each(cases)("normalizes $event.type without cumulative snapshots", ({ event, expected }) => {
    const normalized = normalizeAssistantEvent(event);
    expect(normalized).toEqual(expected);
    const json = JSON.stringify(normalized);
    expect(json).not.toContain("partial");
    expect(json).not.toContain("cumulative");
  });
});
