import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SessionRecorder } from "../src/extension/recorder.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowRunStore, createRunId } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

type FakeEntry = { id: string; type: string; content?: string };

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
