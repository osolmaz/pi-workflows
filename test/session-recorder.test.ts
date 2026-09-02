import { describe, expect, it, vi } from "vitest";
import { SessionRecorder, type SessionRecordingStore } from "../src/extension/recorder.js";
import type {
  WorkflowSessionBinding,
  WorkflowSessionCapture,
  WorkflowSessionEventRecord,
} from "../src/workflows/types.js";

function memoryStore(
  options: {
    bound?: boolean;
    entryError?: Error;
    eventError?: Error;
    countError?: Error;
    captureError?: Error;
  } = {},
) {
  const bindings: Array<{ value: WorkflowSessionBinding; attemptId?: string }> = [];
  const captures: Array<{ value: WorkflowSessionCapture; attemptId?: string }> = [];
  const entries: Array<Record<string, unknown>> = [];
  const events: WorkflowSessionEventRecord[] = [];
  const store: SessionRecordingStore = {
    hasSessionBinding: vi.fn(async () => options.bound ?? false),
    writeSessionBinding: vi.fn(async (_runId, value, attemptId) => {
      bindings.push({ value, ...(attemptId === undefined ? {} : { attemptId }) });
    }),
    writeSessionCapture: vi.fn(async (_runId, value, attemptId) => {
      if (options.captureError !== undefined) throw options.captureError;
      captures.push({ value, ...(attemptId === undefined ? {} : { attemptId }) });
    }),
    appendSessionEntry: vi.fn(async (_runId, entry) => {
      if (options.entryError !== undefined) throw options.entryError;
      entries.push(entry);
      return entries.length;
    }),
    appendSessionEventBatch: vi.fn(async (_runId, batch) => {
      if (options.eventError !== undefined) throw options.eventError;
      events.push(...batch);
    }),
    sessionCounts: vi.fn(async () => {
      if (options.countError !== undefined) throw options.countError;
      return {
        eventCount: events.length,
        entryCount: entries.length,
        lastEventSeq: events.at(-1)?.seq ?? 0,
      };
    }),
  };
  return { store, bindings, captures, entries, events };
}

function context(branch: Array<Record<string, unknown> & { id: string }>) {
  return {
    cwd: "/tmp/project",
    sessionManager: {
      getLeafId: () => branch.at(-1)?.id ?? null,
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
  } as never;
}

function contract() {
  return {
    runId: "run-1",
    workflowName: "test",
    nodeId: "step",
    attemptId: "attempt-1",
    completion: "submit",
  } as never;
}

describe("SessionRecorder", () => {
  it("records one complete workflow turn with settled entries and tools", async () => {
    const branch: Array<Record<string, unknown> & { id: string }> = [
      { id: "root", message: { role: "user", content: "start" } },
    ];
    const ctx = context(branch);
    const state = memoryStore();
    const recorder = new SessionRecorder(state.store, "run-1");
    await recorder.bind(ctx);
    await recorder.bind(ctx);

    const mark = recorder.mark();
    recorder.beginAttempt(contract());
    recorder.handleTurnStart({ turnIndex: 1 });
    const message = { id: "assistant-message", role: "assistant", timestamp: 10 };
    await recorder.handleMessageStart({ message }, ctx);
    recorder.handleMessageUpdate({
      message,
      assistantMessageEvent: { type: "start", partial: message },
    });
    recorder.handleMessageUpdate({
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "ignored delta",
        partial: message,
      },
    });
    recorder.handleMessageUpdate({
      message,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: "tool-1", name: "read" },
        partial: message,
      },
    });
    recorder.handleToolStart({
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    recorder.handleToolUpdate({ toolCallId: "tool-1" });
    recorder.handleToolEnd({
      toolCallId: "tool-1",
      toolName: "read",
      result: { text: "ok" },
      isError: false,
    });
    recorder.handleMessageEnd({ message });
    branch.push({ id: "assistant-entry", message });

    const finished = recorder.finish();
    await recorder.handleTurnEnd({ turnIndex: 1, message }, ctx);
    await finished;
    recorder.settleAttempt();

    expect(state.bindings).toHaveLength(1);
    expect(state.captures[0]?.value.status).toBe("recording");
    expect(state.captures.at(-1)?.value.status).toBe("complete");
    expect(state.entries.map((entry) => entry.id)).toEqual(["assistant-entry"]);
    expect(state.events.map((event) => event.type)).toEqual([
      "turn_started",
      "message_started",
      "assistant_event",
      "assistant_event",
      "tool_execution_started",
      "tool_execution_finished",
      "message_finished",
      "turn_finished",
    ]);
    expect(state.events.find((event) => event.type === "message_finished")?.payload).toEqual({
      role: "assistant",
      settled: true,
      entryId: "assistant-entry",
    });
    expect(state.events.at(-1)?.payload).toMatchObject({
      messageId: "m1",
      toolCallIds: ["tool-1"],
    });
    expect(recorder.rangeSince(mark)).toEqual({
      firstEntryId: "assistant-entry",
      lastEntryId: "assistant-entry",
    });
    expect(recorder.rangeSince(recorder.mark())).toBeUndefined();
    await recorder.stop();
  });

  it("starts a new capture segment for an existing binding", async () => {
    const branch = [{ id: "root", message: { role: "user" } }];
    const state = memoryStore({ bound: true });
    const recorder = new SessionRecorder(state.store, "run-1");
    await recorder.bind(context(branch));
    await recorder.finish();

    expect(state.bindings[0]?.attemptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(state.captures.every((item) => item.attemptId === state.bindings[0]?.attemptId)).toBe(
      true,
    );
  });

  it("ignores unrelated hooks and handles a missing branch cursor", async () => {
    const branch = [{ id: "root", message: { role: "user" } }];
    const ctx = context(branch);
    const state = memoryStore();
    const recorder = new SessionRecorder(state.store, "run-1");

    await expect(recorder.record(ctx)).resolves.toEqual([]);
    recorder.handleTurnStart({ turnIndex: 1 });
    await recorder.handleTurnEnd({ turnIndex: 1, message: {} }, ctx);
    await recorder.handleMessageStart({ message: {} }, ctx);
    recorder.handleMessageUpdate({
      message: {},
      assistantMessageEvent: { type: "start", partial: {} },
    });
    recorder.handleMessageEnd({ message: {} });
    recorder.handleToolStart({ toolCallId: "missing", toolName: "read", args: {} });
    recorder.handleToolEnd({ toolCallId: "missing", toolName: "read", result: {}, isError: false });

    await recorder.bind(ctx);
    branch.splice(0, branch.length, { id: "other", message: { role: "user" } });
    await expect(recorder.record(ctx)).resolves.toEqual([]);
    await recorder.stop();
    expect(state.entries).toEqual([]);
  });

  it("records an unsettled message and marks an interrupted turn failed", async () => {
    const branch = [{ id: "root", message: { role: "user" } }];
    const ctx = context(branch);
    const state = memoryStore();
    const recorder = new SessionRecorder(state.store, "run-1");
    await recorder.bind(ctx);
    recorder.beginWorkflowMessage("terminal-message", "terminal");
    recorder.handleTurnStart({ turnIndex: 1 });
    const message = { role: "assistant", timestamp: "time-1" };
    await recorder.handleMessageStart({ message }, ctx);
    recorder.handleMessageEnd({ message });
    await recorder.synchronize(ctx);
    await recorder.stop();

    expect(state.captures.at(-1)?.value).toMatchObject({
      status: "failed",
      failure: { code: "turn_interrupted" },
    });
    recorder.settleAttempt();
  });

  it("keeps capture failures observational", async () => {
    const branch = [{ id: "root", message: { role: "user" } }];
    const ctx = context(branch);
    const entryState = memoryStore({ entryError: new Error("entry failed") });
    const entryRecorder = new SessionRecorder(entryState.store, "run-entry");
    await entryRecorder.bind(ctx);
    branch.push({ id: "entry", message: { role: "assistant" } });
    await expect(entryRecorder.record(ctx)).rejects.toThrow("entry failed");
    await entryRecorder.stop();
    expect(entryState.captures.at(-1)?.value).toMatchObject({
      status: "failed",
      failure: { code: "entry_write_failed" },
    });

    const eventState = memoryStore({ eventError: new Error("event write failed") });
    const eventRecorder = new SessionRecorder(eventState.store, "run-event");
    await eventRecorder.bind(context([{ id: "root", message: { role: "user" } }]));
    eventRecorder.beginAttempt(contract());
    eventRecorder.handleTurnStart({ turnIndex: 1 });
    await eventRecorder.handleTurnEnd(
      { turnIndex: 1, message: {} },
      context([{ id: "root", message: { role: "user" } }]),
    );
    await eventRecorder.stop();
    expect(eventState.captures.at(-1)?.value).toMatchObject({
      status: "failed",
      failure: { code: "event_write_failed" },
    });
  });

  it("does not reject workflow completion when capture finalization fails", async () => {
    const branch = [{ id: "root", message: { role: "user" } }];
    const state = memoryStore({ countError: new Error("counts unavailable") });
    const recorder = new SessionRecorder(state.store, "run-1");
    await recorder.bind(context(branch));
    await expect(recorder.stop()).resolves.toBeUndefined();
  });
});
