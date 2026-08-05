import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { readLastTraceEvent, readRunBundle, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

function makeEngine(store: WorkflowRunStore) {
  return new WorkflowEngine({ executor: new ScriptedExecutor(), store });
}

describe("engine park", () => {
  it("stops mid-node without a terminal event and resumes later", { timeout: 45_000 }, async () => {
    const outputRoot = await makeTempDir("pi-park-runs");
    const store = new WorkflowRunStore(outputRoot);
    let blocked = true;
    const two = vi.fn(async ({ signal }: { input: unknown; signal: AbortSignal }) => {
      if (!blocked) {
        return "second";
      }
      return await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const workflow = defineWorkflow({
      name: "park-demo",
      startAt: "one",
      nodes: {
        one: compute({ run: () => "first" }),
        two: compute({ run: two as unknown as () => Promise<unknown> }),
      },
      edges: [{ from: "one", to: "two" }],
    });

    const engine = makeEngine(store);
    const runPromise = engine.run(workflow, {}, { runId: "park-1" });
    // Wait until node two is in flight.
    const runDir = store.runDirFor("park-1");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const last = await readLastTraceEvent(runDir);
      if (last?.type === "node_started" && last.nodeId === "two") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("node two never started");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    engine.park();
    const parked = await runPromise;
    expect(parked.state.status).toBe("running");

    // The aborted attempt left no result and no terminal event.
    const bundle = await readRunBundle(runDir);
    expect(bundle?.state.results.two).toBeUndefined();
    expect(bundle?.state.currentNode).toBe("two");
    const last = await readLastTraceEvent(runDir);
    expect(last?.type).toBe("node_started");

    // Another runner resumes at node two and completes.
    blocked = false;
    const resumer = makeEngine(store);
    const resumed = await resumer.resumeRun(workflow, "park-1");
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.finalOutput).toBe("second");
    expect(resumed.state.steps).toHaveLength(2);
  });
});

describe("park during resume preparation", () => {
  it("keeps a park that lands while the bundle is being prepared", async () => {
    const outputRoot = await makeTempDir("pi-park-prepare-runs");
    const store = new WorkflowRunStore(outputRoot);
    const work = vi.fn(() => "should not run");
    const workflow = defineWorkflow({
      name: "park-prepare",
      startAt: "work",
      nodes: { work: compute({ run: work }) },
      edges: [],
    });
    const state = {
      schema: "pi-workflows.run-state.v1" as const,
      traceSeq: 0,
      runId: "prepare-park",
      workflowName: workflow.name,
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "running" as const,
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    // Make preparation slow so the park lands mid-await.
    const resumer = new WorkflowEngine({ executor: new ScriptedExecutor(), store });
    const original = store.prepareRunResume.bind(store);
    const spy = vi.spyOn(store, "prepareRunResume").mockImplementation(async (runId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return await original(runId);
    });
    const resumePromise = resumer.resumeRun(workflow, "prepare-park");
    resumer.park();
    const result = await resumePromise;
    spy.mockRestore();

    // The park survived preparation: nothing executed and the bundle stays
    // resumable instead of running to completion.
    expect(result.state.status).toBe("running");
    expect(work).not.toHaveBeenCalled();
    void runDir;
  });
});

describe("bundle reading and resume-prepare edge cases", () => {
  it("treats malformed and escaped bundles as unreadable", async () => {
    const outputRoot = await makeTempDir("pi-edge-runs");
    const runDir = path.join(outputRoot, "edge-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "manifest.json"), "not json", "utf8");
    expect(await readRunBundle(runDir)).toBeNull();

    // A manifest whose paths escape the bundle falls back safely.
    await fs.writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({
        schema: "pi-workflows.run-bundle.v1",
        runId: "edge-1",
        workflowName: "demo",
        startedAt: "2026-08-04T00:00:00.000Z",
        status: "running",
        traceSchema: "pi-workflows.trace-event.v1",
        paths: { state: "../../../etc/passwd", workflow: 42 },
      }),
      "utf8",
    );
    expect(await readRunBundle(runDir)).toBeNull();
  });

  it("rejects resume preparation for unreadable and non-running bundles", async () => {
    const outputRoot = await makeTempDir("pi-edge-runs");
    const store = new WorkflowRunStore(outputRoot);
    await expect(store.prepareRunResume("missing")).rejects.toThrow(/unreadable/);
    const workflow = defineWorkflow({
      name: "edge",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), store });
    await engine.run(workflow, {}, { runId: "done-run" });
    await expect(store.prepareRunResume("done-run")).rejects.toThrow(/status completed/);
  });

  it("prepares a clean bundle without rewriting the trace", async () => {
    const outputRoot = await makeTempDir("pi-edge-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "edge",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const state = {
      schema: "pi-workflows.run-state.v1" as const,
      traceSeq: 0,
      runId: "clean-1",
      workflowName: workflow.name,
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "running" as const,
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    const before = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const prepared = await store.prepareRunResume("clean-1");
    const after = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    expect(after).toBe(before);
    expect(prepared.state.runId).toBe("clean-1");
    expect(await store.hasSessionBinding(runDir)).toBe(false);
    expect(await store.listSessionSegments(runDir)).toEqual([]);
  });
});

describe("capture segments", () => {
  it("keeps the first capture flat and writes later captures as segments", async () => {
    const outputRoot = await makeTempDir("pi-segment-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "seg-demo",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const engine = makeEngine(store);
    const { runDir, state } = await engine.run(workflow, {}, { runId: "seg-1" });
    void state;

    const binding = (piSessionId: string) => ({
      schema: "pi-workflows.session-binding.v1" as const,
      runId: "seg-1",
      piSessionId,
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    const eventRecord = (seq: number): WorkflowSessionEventRecord => ({
      seq,
      at: new Date().toISOString(),
      nodeId: "work",
      attemptId: "a1",
      turnId: "t1",
      type: "turn_started",
      payload: { turnIndex: 0 },
    });

    // First recorder: flat stream, finalized as every stopped recorder does.
    await store.writeSessionBinding(runDir, binding("session-a"));
    await store.appendSessionEventBatch(runDir, [eventRecord(1)]);
    await store.appendSessionEntry(runDir, { id: "entry-a" });
    const flatCounts = await store.sessionCounts(runDir);
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "complete",
      ...flatCounts,
    });
    expect(await store.hasSessionBinding(runDir)).toBe(true);

    // Second recorder (resume): its own segment, flat stream untouched.
    await store.writeSessionBinding(runDir, binding("session-b"), "seg-b");
    await store.appendSessionEventBatch(runDir, [eventRecord(1)], "seg-b");
    await store.appendSessionEntry(runDir, { id: "entry-b" }, "seg-b");
    const counts = await store.sessionCounts(runDir, "seg-b");
    expect(counts).toEqual({ eventCount: 1, entryCount: 1, lastEventSeq: 1 });
    await store.writeSessionCapture(
      runDir,
      {
        schema: "pi-workflows.session-capture.v1",
        eventSchema: "pi-workflows.session-event.v1",
        status: "complete",
        ...counts,
      },
      "seg-b",
    );

    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionBinding?.piSessionId).toBe("session-a");
    expect(bundle?.sessionEntries).toHaveLength(1);
    expect(bundle?.sessionSegments).toHaveLength(1);
    expect(bundle?.sessionSegments[0]).toMatchObject({
      attemptId: "seg-b",
      integrity: { status: "complete" },
    });
    expect(bundle?.sessionSegments[0]?.binding?.piSessionId).toBe("session-b");
    expect(bundle?.sessionSegments[0]?.entries).toHaveLength(1);
    // The flat stream is intact and still speaks for headline integrity.
    expect(bundle?.sessionIntegrity.status).toBe("complete");
  });

  it("re-verifies the fence before repairing a torn trace", async () => {
    const outputRoot = await makeTempDir("pi-fence-repair-runs");
    const plain = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "repair-fence",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const state = {
      schema: "pi-workflows.run-state.v1" as const,
      traceSeq: 0,
      runId: "repair-1",
      workflowName: workflow.name,
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "running" as const,
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await plain.initializeRunBundle(workflow, state);
    await plain.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    // A torn tail that requires repair.
    await fs.appendFile(path.join(runDir, "trace.ndjson"), '{"seq": 99, "typ');

    let fenceCalls = 0;
    const fenced = new WorkflowRunStore(outputRoot, {
      fenceProvider: () => () => {
        fenceCalls += 1;
        if (fenceCalls > 1) {
          throw new Error("claim lost mid-repair");
        }
      },
    });
    await expect(fenced.prepareRunResume("repair-1")).rejects.toThrow(/claim lost/);
    expect(fenceCalls).toBe(2);
    // The trace was left untouched by the refused repair.
    const raw = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    expect(raw).toContain('"seq": 99');
  });

  it("finalizes a dangling recording capture when preparing a resume", async () => {
    const outputRoot = await makeTempDir("pi-segment-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "seg-resume",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const state = {
      schema: "pi-workflows.run-state.v1" as const,
      traceSeq: 0,
      runId: "seg-dangle",
      workflowName: workflow.name,
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "running" as const,
      input: {},
      outputs: {},
      results: {},
      steps: [],
    };
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: "seg-dangle",
      piSessionId: "crashed-session",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    // The crashed session never finalized its capture.
    await store.writeSessionCapture(runDir, {
      schema: "pi-workflows.session-capture.v1",
      eventSchema: "pi-workflows.session-event.v1",
      status: "recording",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });

    await store.prepareRunResume("seg-dangle");
    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionCapture?.status).toBe("failed");
    expect(bundle?.sessionCapture?.failure?.code).toBe("host_interrupted");
  });

  it("finalizes recording segments when a run is interrupted", async () => {
    const outputRoot = await makeTempDir("pi-segment-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "seg-interrupt",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const runDir = await store.initializeRunBundle(workflow, {
      schema: "pi-workflows.run-state.v1",
      traceSeq: 0,
      runId: "seg-run",
      workflowName: workflow.name,
      startedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
    });
    await store.writeSnapshot(
      runDir,
      {
        schema: "pi-workflows.run-state.v1",
        traceSeq: 0,
        runId: "seg-run",
        workflowName: workflow.name,
        startedAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
        status: "running",
        input: {},
        outputs: {},
        results: {},
        steps: [],
      },
      { scope: "run", type: "run_started", payload: {} },
    );
    await store.writeSessionBinding(runDir, {
      schema: "pi-workflows.session-binding.v1",
      runId: "seg-run",
      piSessionId: "session-b",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    // A segment left recording by a crashed session.
    await store.writeSessionBinding(
      runDir,
      {
        schema: "pi-workflows.session-binding.v1",
        runId: "seg-run",
        piSessionId: "session-c",
        cwd: "/tmp",
        boundAt: new Date().toISOString(),
      },
      "seg-c",
    );
    await store.writeSessionCapture(
      runDir,
      {
        schema: "pi-workflows.session-capture.v1",
        eventSchema: "pi-workflows.session-event.v1",
        status: "recording",
        eventCount: 0,
        entryCount: 0,
        lastEventSeq: 0,
      },
      "seg-c",
    );

    const interrupted = await store.markRunInterrupted("seg-run");
    expect(interrupted?.state.status).toBe("failed");
    const bundle = await readRunBundle(runDir);
    expect(bundle?.sessionSegments[0]?.capture?.status).toBe("failed");
    expect(bundle?.sessionSegments[0]?.capture?.failure?.code).toBe("host_interrupted");
  });
});
