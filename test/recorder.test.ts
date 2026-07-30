import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SessionRecorder } from "../src/extension/recorder.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowRunStore, createRunId } from "../src/workflows/store.js";
import type { WorkflowRunState, WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

type FakeEntry = {
  id: string;
  type: string;
  content?: string;
  message?: { role: string; content?: unknown };
};

/** Minimal stand-in for the documented `ctx.sessionManager` read API. */
function makeCtx(branch: FakeEntry[]): ExtensionContext {
  return {
    cwd: "/work",
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getSessionId: () => "pi-session-1",
      getSessionFile: () => "/home/user/.pi/sessions/s.jsonl",
    },
  } as unknown as ExtensionContext;
}

async function makeRun(): Promise<{ store: WorkflowRunStore; runDir: string; runId: string }> {
  const outputRoot = await makeTempDir("pi-workflows-recorder");
  const store = new WorkflowRunStore(outputRoot);
  const workflow = defineWorkflow({
    name: "demo",
    startAt: "one",
    nodes: { one: compute({ run: () => 1 }) },
    edges: [],
  });
  const runId = createRunId("demo");
  const now = new Date().toISOString();
  const state: WorkflowRunState = {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 0,
    runId,
    workflowName: "demo",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  };
  const runDir = await store.initializeRunBundle(workflow, state);
  return { store, runDir, runId };
}

async function readEntries(runDir: string): Promise<Array<{ seq: number; entry: FakeEntry }>> {
  const raw = await fs.readFile(path.join(runDir, "session/entries.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number; entry: FakeEntry });
}

async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(runDir, "session/events.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("SessionRecorder", () => {
  it("binds once and skips entries that predate the run", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [{ id: "e1", type: "message" }];
    await recorder.bind(makeCtx(branch));
    await recorder.bind(makeCtx(branch));

    const binding = JSON.parse(
      await fs.readFile(path.join(runDir, "session/binding.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(binding).toMatchObject({
      schema: "pi-workflows.session-binding.v1",
      runId,
      piSessionId: "pi-session-1",
      cwd: "/work",
    });

    // e1 existed before the run started, so it is not part of the record.
    branch.push({ id: "e2", type: "message" });
    await recorder.record(makeCtx(branch));
    expect((await readEntries(runDir)).map((record) => record.entry.id)).toEqual(["e2"]);
  });

  it("records growing branches verbatim with sequential seq", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [];
    await recorder.bind(makeCtx(branch));

    branch.push({ id: "e1", type: "message", content: "hi" });
    branch.push({ id: "e2", type: "message" });
    await recorder.record(makeCtx(branch));
    branch.push({ id: "e3", type: "toolResult" });
    await recorder.record(makeCtx(branch));
    // No growth: recording again adds nothing.
    await recorder.record(makeCtx(branch));

    const records = await readEntries(runDir);
    expect(records.map((record) => [record.seq, record.entry.id])).toEqual([
      [1, "e1"],
      [2, "e2"],
      [3, "e3"],
    ]);
    expect(records[0]?.entry).toEqual({ id: "e1", type: "message", content: "hi" });
  });

  it("brackets attempts with marks", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [];
    await recorder.bind(makeCtx(branch));

    const before = recorder.mark();
    expect(recorder.rangeSince(before)).toBeUndefined();

    branch.push({ id: "p1", type: "message" }, { id: "a1", type: "message" });
    await recorder.record(makeCtx(branch));
    expect(recorder.rangeSince(before)).toEqual({ firstEntryId: "p1", lastEntryId: "a1" });

    const second = recorder.mark();
    branch.push({ id: "p2", type: "message" });
    await recorder.record(makeCtx(branch));
    expect(recorder.rangeSince(second)).toEqual({ firstEntryId: "p2", lastEntryId: "p2" });
  });

  it("stops recording: pending and later flushes never touch the bundle", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [];
    await recorder.bind(makeCtx(branch));

    branch.push({ id: "e1", type: "message" });
    await recorder.record(makeCtx(branch));

    // A flush accepted before stop() is drained before the terminal capture.
    branch.push({ id: "e2", type: "message" });
    const pending = recorder.record(makeCtx(branch));
    await recorder.stop();
    await pending;
    branch.push({ id: "e3", type: "message" });
    await recorder.record(makeCtx(branch));

    expect((await readEntries(runDir)).map((record) => record.entry.id)).toEqual(["e1", "e2"]);
  });

  it("records normalized temporal events with stable ownership and entry linkage", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [];
    const ctx = makeCtx(branch);
    await recorder.bind(ctx);
    recorder.beginAttempt({
      runId,
      workflowName: "demo",
      nodeId: "review",
      attemptId: "attempt-1",
    });

    const assistant = { role: "assistant", content: [], timestamp: 1_723_000_000_000 };
    recorder.handleTurnStart({ turnIndex: 0 });
    recorder.handleMessageStart({ message: assistant });
    recorder.handleMessageUpdate({
      message: { ...assistant },
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistant },
    });
    recorder.handleMessageUpdate({
      message: assistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: { ...assistant, content: [{ type: "text", text: "hello" }] },
      },
    });
    recorder.handleMessageUpdate({
      message: assistant,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: "call-1", name: "read", arguments: { path: "README.md" } },
        partial: assistant,
      },
    });
    recorder.handleToolStart({
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    recorder.handleToolUpdate({ toolCallId: "call-1" });
    recorder.handleToolEnd({
      toolCallId: "call-1",
      toolName: "read",
      result: { content: "ok" },
      isError: false,
    });

    branch.push({ id: "entry-1", type: "message", message: assistant });
    await recorder.handleMessageEnd({ message: { ...assistant } }, ctx);
    // Ownership was captured at start and must not follow a later attempt.
    recorder.beginAttempt({
      runId,
      workflowName: "demo",
      nodeId: "next",
      attemptId: "attempt-2",
    });
    recorder.handleTurnEnd({ turnIndex: 0, message: { ...assistant } });
    await recorder.stop();

    const events = await readEvents(runDir);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.every((event) => event.nodeId === "review")).toBe(true);
    expect(events.every((event) => event.attemptId === "attempt-1")).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "message_started",
      "assistant_event",
      "assistant_event",
      "assistant_event",
      "tool_execution_started",
      "tool_execution_updated",
      "tool_execution_finished",
      "message_finished",
      "turn_finished",
    ]);
    expect(JSON.stringify(events)).not.toContain('"partial"');
    expect(events.at(-2)?.payload).toMatchObject({
      role: "assistant",
      settled: true,
      entryId: "entry-1",
    });

    const capture = JSON.parse(
      await fs.readFile(path.join(runDir, "session/capture.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(capture).toMatchObject({
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: events.length,
      entryCount: 1,
      lastEventSeq: events.length,
    });
  });

  it("externalizes large tool payloads before enforcing the event limit", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    await recorder.bind(makeCtx([]));
    recorder.beginAttempt({ runId, workflowName: "demo", nodeId: "one", attemptId: "a1" });
    const assistant = { role: "assistant", content: [], timestamp: 1 };
    recorder.handleTurnStart({ turnIndex: 0 });
    recorder.handleMessageStart({ message: assistant });
    recorder.handleMessageUpdate({
      message: assistant,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          id: "large-call",
          name: "write",
          arguments: { text: "x".repeat(1_100_000) },
        },
        partial: assistant,
      },
    });
    await recorder.stop();

    const events = await readEvents(runDir);
    const toolCall = events.find(
      (event) =>
        event.type === "assistant_event" &&
        (event.payload as Record<string, unknown>).type === "toolcall_end",
    );
    expect(toolCall?.payload).toMatchObject({
      toolCall: { arguments: { text: { $artifact: { mediaType: "text/plain" } } } },
    });
    const capture = JSON.parse(
      await fs.readFile(path.join(runDir, "session/capture.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(capture).toMatchObject({ status: "complete", eventCount: 3 });
  });

  it("keeps workflow recording alive when temporal event writes fail", async () => {
    class FailingEventStore extends WorkflowRunStore {
      override async appendSessionEventBatch(): Promise<void> {
        throw new Error("injected event failure");
      }
    }
    const outputRoot = await makeTempDir("pi-workflows-recorder-failure");
    const store = new FailingEventStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "one",
      nodes: { one: compute({ run: () => 1 }) },
      edges: [],
    });
    const runId = createRunId("demo");
    const now = new Date().toISOString();
    const state: WorkflowRunState = {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 0,
      runId,
      workflowName: "demo",
      startedAt: now,
      updatedAt: now,
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await store.initializeRunBundle(workflow, state);
    const recorder = new SessionRecorder(store, runDir, runId);
    const branch: FakeEntry[] = [];
    await recorder.bind(makeCtx(branch));
    recorder.beginAttempt({ runId, workflowName: "demo", nodeId: "one", attemptId: "a1" });
    recorder.handleTurnStart({ turnIndex: 0 });
    await recorder.stop();

    const capture = JSON.parse(
      await fs.readFile(path.join(runDir, "session/capture.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(capture).toMatchObject({
      status: "failed",
      eventCount: 0,
      lastEventSeq: 0,
      failure: { code: "event_write_failed", message: "injected event failure" },
    });
    await expect(
      store.writeSnapshot(runDir, state, { scope: "run", type: "still_runs", payload: {} }),
    ).resolves.toBeDefined();
  });

  it("drains accepted records after bounded queue overflow", async () => {
    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    class BlockingEventStore extends WorkflowRunStore {
      private firstWrite = true;

      override async appendSessionEventBatch(
        runDir: string,
        records: WorkflowSessionEventRecord[],
      ): Promise<void> {
        if (this.firstWrite) {
          this.firstWrite = false;
          await firstWriteGate;
        }
        await super.appendSessionEventBatch(runDir, records);
      }
    }
    const outputRoot = await makeTempDir("pi-workflows-recorder-overflow");
    const store = new BlockingEventStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "one",
      nodes: { one: compute({ run: () => 1 }) },
      edges: [],
    });
    const runId = createRunId("demo");
    const now = new Date().toISOString();
    const state: WorkflowRunState = {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 0,
      runId,
      workflowName: "demo",
      startedAt: now,
      updatedAt: now,
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await store.initializeRunBundle(workflow, state);
    const recorder = new SessionRecorder(store, runDir, runId);
    await recorder.bind(makeCtx([]));
    recorder.beginAttempt({ runId, workflowName: "demo", nodeId: "one", attemptId: "a1" });
    for (let index = 0; index < 8_300; index += 1) {
      recorder.handleTurnStart({ turnIndex: index });
    }
    releaseFirstWrite();
    await recorder.stop();

    const events = await readEvents(runDir);
    expect(events).toHaveLength(8_192);
    expect(events.at(-1)?.seq).toBe(8_192);
    const capture = JSON.parse(
      await fs.readFile(path.join(runDir, "session/capture.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(capture).toMatchObject({
      status: "failed",
      eventCount: 8_192,
      lastEventSeq: 8_192,
      failure: { code: "event_queue_overflow" },
    });
  });

  it("re-anchors when the user branches away mid-run", async () => {
    const { store, runDir, runId } = await makeRun();
    const recorder = new SessionRecorder(store, runDir, runId);
    await recorder.bind(makeCtx([{ id: "e1", type: "message" }]));

    // A different branch that no longer contains the cursor entry.
    const other: FakeEntry[] = [{ id: "x1", type: "message" }];
    await recorder.record(makeCtx(other));
    await expect(readEntries(runDir)).rejects.toThrow();

    // Entries appended after the re-anchor are captured again.
    other.push({ id: "x2", type: "message" });
    await recorder.record(makeCtx(other));
    expect((await readEntries(runDir)).map((record) => record.entry.id)).toEqual(["x2"]);
  });
});
