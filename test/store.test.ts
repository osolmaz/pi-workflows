import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import {
  WorkflowRunStore,
  createDefinitionSnapshot,
  createRunId,
  listRunBundles,
  readRunBundle,
  workflowRunsBaseDir,
} from "../src/workflows/store.js";
import type { WorkflowRunState, WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function makeState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const now = new Date().toISOString();
  return {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 0,
    runId: createRunId("demo"),
    workflowName: "demo",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: { task: "t" },
    outputs: {},
    results: {},
    steps: [],
    ...overrides,
  };
}

const workflow = defineWorkflow({
  name: "demo",
  startAt: "one",
  nodes: { one: compute({ run: () => 1 }) },
  edges: [],
});

describe("createRunId", () => {
  it("slugifies the workflow name with a timestamp and suffix", () => {
    const runId = createRunId("My Workflow!", new Date("2026-07-19T01:02:03.456Z"));
    expect(runId).toMatch(/^20260719T010203Z-my-workflow-[0-9a-f]{8}$/);
  });
});

describe("workflowRunsBaseDir", () => {
  it("lives under the pi agent directory", () => {
    expect(workflowRunsBaseDir("/home/x")).toBe(
      path.join("/home/x", ".pi", "agent", "workflows", "runs"),
    );
  });
});

describe("WorkflowRunStore", () => {
  it("initializes and updates a run bundle", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();

    const runDir = await store.initializeRunBundle(workflow, state);
    expect(runDir).toBe(path.join(outputRoot, state.runId));

    state.status = "completed";
    state.finishedAt = new Date().toISOString();
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_completed", payload: {} });

    const bundle = await readRunBundle(runDir);
    expect(bundle?.manifest.status).toBe("completed");
    expect(bundle?.state.status).toBe("completed");
    expect(bundle?.snapshot?.schema).toBe("pi-workflows.definition-snapshot.v1");

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(events.map((event) => event.type)).toEqual(["run_completed"]);
  });

  it("assigns monotonic trace sequence numbers", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);

    // The first event carries a payload large enough to externalize, which
    // makes its transition slow; physical order must still match seq order.
    await Promise.all([
      store.writeSnapshot(runDir, state, {
        scope: "node",
        type: "a",
        payload: { text: "z".repeat(50_000) },
      }),
      store.writeSnapshot(runDir, state, { scope: "node", type: "b", payload: {} }),
      store.writeSnapshot(runDir, state, { scope: "node", type: "c", payload: {} }),
    ]);

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(3);
  });

  it("carries the reflected trace seq in state.json", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(0);

    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    await store.writeSnapshot(runDir, state, { scope: "node", type: "node_started", payload: {} });

    expect((await readRunBundle(runDir))?.state.traceSeq).toBe(2);
  });

  it("externalizes large values into content-addressed artifacts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const big = "x".repeat(10_000);
    const state = makeState({ outputs: { one: { text: big } } });
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    const bundle = await readRunBundle(runDir);
    const output = bundle?.state.outputs.one as { text: { $artifact: { path: string } } };
    expect(output.text.$artifact.path).toMatch(/^artifacts\/sha256-[0-9a-f]{64}\.txt$/);
    expect(bundle?.manifest.paths.artifacts).toBe("artifacts");
    const stored = await fs.readFile(path.join(runDir, output.text.$artifact.path), "utf8");
    expect(stored).toBe(big);

    const { resolveArtifacts } = await import("../src/workflows/artifacts.js");
    expect(await resolveArtifacts(bundle?.state.outputs, runDir)).toEqual({
      one: { text: big },
    });
  });

  it("records a session binding, entries, and the session_bound event", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    expect(await store.appendSessionEntry(runDir, { id: "aa11bb22", type: "message" })).toBe(1);
    expect(await store.appendSessionEntry(runDir, { id: "cc33dd44", type: "message" })).toBe(2);

    const binding = JSON.parse(
      await fs.readFile(path.join(runDir, "session/binding.json"), "utf8"),
    ) as { piSessionId: string };
    expect(binding.piSessionId).toBe("session-1");

    const entries = (await fs.readFile(path.join(runDir, "session/entries.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; entry: { id: string } });
    expect(entries.map((record) => [record.seq, record.entry.id])).toEqual([
      [1, "aa11bb22"],
      [2, "cc33dd44"],
    ]);

    const trace = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; scope: string });
    expect(trace.at(-1)).toMatchObject({ type: "session_bound", scope: "session" });

    // The next snapshot advertises the session directory in the manifest.
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_completed", payload: {} });
    expect((await readRunBundle(runDir))?.manifest.paths.session).toBe("session");
  });

  it("appends session event batches and writes verified capture counts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-events");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "recording",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });
    const records: WorkflowSessionEventRecord[] = [
      {
        seq: 1,
        at: "2026-07-30T00:00:00.000Z",
        nodeId: "one",
        attemptId: "a1",
        turnId: "t1",
        type: "turn_started",
        payload: { turnIndex: 0 },
      },
      {
        seq: 2,
        at: "2026-07-30T00:00:00.001Z",
        nodeId: "one",
        attemptId: "a1",
        turnId: "t1",
        messageId: "m1",
        type: "message_started",
        payload: { role: "assistant" },
      },
    ];
    await store.appendSessionEventBatch(runDir, records);
    await store.appendSessionEntry(runDir, { id: "entry-1", type: "message" });
    const counts = await store.sessionCounts(runDir);
    expect(counts).toEqual({ eventCount: 2, entryCount: 1, lastEventSeq: 2 });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      ...counts,
    });

    const lines = (await fs.readFile(path.join(runDir, "session/events.ndjson"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ seq: 2, type: "message_started" });
    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionEvents).toHaveLength(2);
    expect(bundle?.sessionEntries).toHaveLength(1);
    expect(bundle?.sessionIntegrity).toEqual({ status: "complete", diagnostics: [] });
    await expect(store.appendSessionEventBatch(runDir, [])).resolves.toBeUndefined();
    await expect(
      store.appendSessionEventBatch(runDir, [{ ...records[1]!, seq: 3 }]),
    ).rejects.toThrow("stopped");
  });

  it("reports invalid terminal capture counts", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-event-integrity");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "invalid",
      diagnostics: ["session capture counts do not match durable files"],
    });
  });

  it("rejects unknown session capture statuses", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-invalid-capture-status");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/capture.json"),
      JSON.stringify({
        schema: "pi-workflows.session-capture.v1",
        eventSchema: "pi-workflows.session-event.v1",
        status: "finished",
        eventCount: 0,
        entryCount: 0,
        lastEventSeq: 0,
      }),
    );
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "invalid",
      diagnostics: ["Invalid session capture projection"],
    });
  });

  it("accepts unknown future event types without invented correlation requirements", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-unknown-event");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/events.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: new Date().toISOString(),
        nodeId: "one",
        attemptId: "a1",
        type: "future_event",
        payload: {},
      })}\n`,
    );
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    expect((await readRunBundle(runDir))?.sessionIntegrity).toEqual({
      status: "complete",
      diagnostics: [],
    });
  });

  it("rejects known events with missing starts or correlation ids", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-invalid-event");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: state.runId,
      piSessionId: "session-1",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(runDir, "session/events.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: new Date().toISOString(),
        nodeId: "one",
        attemptId: "a1",
        type: "message_finished",
        payload: { settled: false },
      })}\n`,
    );
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      eventCount: 1,
      entryCount: 0,
      lastEventSeq: 1,
    });
    const integrity = (await readRunBundle(runDir))?.sessionIntegrity;
    expect(integrity?.status).toBe("invalid");
    expect(integrity?.diagnostics).toContain("message_finished requires turnId");
  });

  it("rejects sequence gaps and stops later temporal appends", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store-event-gaps");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);
    const event: WorkflowSessionEventRecord = {
      seq: 2,
      at: new Date().toISOString(),
      nodeId: "one",
      attemptId: "a1",
      turnId: "t1",
      type: "turn_started",
      payload: { turnIndex: 0 },
    };
    await expect(store.appendSessionEventBatch(runDir, [event])).rejects.toThrow(
      "Expected session event seq 1",
    );
    await expect(store.appendSessionEventBatch(runDir, [{ ...event, seq: 1 }])).rejects.toThrow(
      "stopped",
    );
  });

  it("keeps bundle files private", async () => {
    const outputRoot = await makeTempDir("pi-workflows-store");
    const store = new WorkflowRunStore(outputRoot);
    const state = makeState();
    const runDir = await store.initializeRunBundle(workflow, state);

    const dirMode = (await fs.stat(runDir)).mode & 0o777;
    const fileMode = (await fs.stat(path.join(runDir, "state.json"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("listRunBundles", () => {
  it("lists bundles most recent first and skips junk", async () => {
    const outputRoot = await makeTempDir("pi-workflows-list");
    const store = new WorkflowRunStore(outputRoot);
    const older = makeState({ startedAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeState({ startedAt: "2026-06-01T00:00:00.000Z" });
    await store.initializeRunBundle(workflow, older);
    await store.initializeRunBundle(workflow, newer);
    await fs.mkdir(path.join(outputRoot, "not-a-bundle"));

    const bundles = await listRunBundles(outputRoot);

    expect(bundles.map((bundle) => bundle.state.runId)).toEqual([newer.runId, older.runId]);
  });

  it("returns empty for a missing directory", async () => {
    expect(await listRunBundles("/nonexistent/definitely/missing")).toEqual([]);
  });

  it("skips schema-tagged bundles with malformed manifests instead of throwing", async () => {
    const outputRoot = await makeTempDir("pi-workflows-list");
    const store = new WorkflowRunStore(outputRoot);
    const good = makeState();
    await store.initializeRunBundle(workflow, good);

    const badDir = path.join(outputRoot, "bad-bundle");
    await fs.mkdir(badDir);
    await fs.writeFile(
      path.join(badDir, "manifest.json"),
      JSON.stringify({ schema: "pi-workflows.run-bundle.v1", paths: { state: 42 } }),
    );

    const bundles = await listRunBundles(outputRoot);
    expect(bundles.map((bundle) => bundle.state.runId)).toEqual([good.runId]);
  });
});

describe("createDefinitionSnapshot", () => {
  it("captures node metadata without functions", () => {
    const snapshot = createDefinitionSnapshot(workflow);
    expect(snapshot.name).toBe("demo");
    expect(snapshot.nodes.one).toEqual({ nodeType: "compute" });
    expect(JSON.stringify(snapshot)).not.toContain("=>");
  });
});
