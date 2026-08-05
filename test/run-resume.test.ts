import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowSourceChangedError } from "../src/workflows/errors.js";
import {
  readLastTraceEvent,
  readRunBundle,
  RUN_STATE_SCHEMA,
  WorkflowRunStore,
} from "../src/workflows/store.js";
import type { WorkflowDefinition, WorkflowRunState } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

function runningState(runId: string, workflow: WorkflowDefinition): WorkflowRunState {
  const now = "2026-08-04T00:00:00.000Z";
  return {
    schema: RUN_STATE_SCHEMA,
    traceSeq: 0,
    runId,
    workflowName: workflow.name,
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  };
}

function makeEngine(store: WorkflowRunStore) {
  return new WorkflowEngine({ executor: new ScriptedExecutor(), store });
}

async function traceTypes(runDir: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

describe("WorkflowEngine.resumeRun", () => {
  it("resumes at the interrupted node without rerunning completed work", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const one = vi.fn(() => "first");
    const two = vi.fn(() => "second");
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "one",
      nodes: { one: compute({ run: one }), two: compute({ run: two }) },
      edges: [{ from: "one", to: "two" }],
    });

    // Simulate the crash: node one finished, node two was mid-flight.
    const state = runningState("resume-1", workflow);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    state.currentNode = "one";
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId: "one",
      attemptId: "a1",
      payload: { nodeType: "compute" },
    });
    state.results.one = {
      attemptId: "a1",
      nodeId: "one",
      nodeType: "compute",
      outcome: "ok",
      output: "first",
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      durationMs: 1,
    };
    state.outputs.one = "first";
    state.steps.push({
      attemptId: "a1",
      nodeId: "one",
      nodeType: "compute",
      outcome: "ok",
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      prompt: null,
      output: "first",
    });
    delete state.currentNode;
    state.currentNode = "two";
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_finished",
      nodeId: "one",
      attemptId: "a1",
      payload: { outcome: "ok", output: "first", durationMs: 1 },
    });
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId: "two",
      attemptId: "a2",
      payload: { nodeType: "compute" },
    });

    const engine = makeEngine(store);
    const result = await engine.resumeRun(workflow, "resume-1");

    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toBe("second");
    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
    expect(result.state.steps).toHaveLength(2);
    const types = await traceTypes(runDir);
    expect(types).toContain("run_resumed");
    // Contiguous sequence numbers after resume.
    const bundle = await readRunBundle(runDir);
    const raw = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const seqs = raw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([...Array(seqs.length).keys()].map((index) => index + 1));
    expect(bundle?.state.traceSeq).toBe(seqs.length);
  });

  it("repairs a torn trace tail before resuming", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "work",
      nodes: { work: compute({ run: () => "done" }) },
      edges: [],
    });
    const state = runningState("resume-torn", workflow);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    state.currentNode = "work";
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId: "work",
      attemptId: "a1",
      payload: { nodeType: "compute" },
    });
    // A kill -9 mid-append leaves a partial final line.
    await fs.appendFile(path.join(runDir, "trace.ndjson"), '{"seq": 5, "typ');

    const engine = makeEngine(store);
    const result = await engine.resumeRun(workflow, "resume-torn");
    expect(result.state.status).toBe("completed");
    const raw = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const seqs = raw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([...Array(seqs.length).keys()].map((index) => index + 1));
  });

  it("drops trace events the projection never recorded", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const work = vi.fn(() => "done");
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "work",
      nodes: { work: compute({ run: work }) },
      edges: [],
    });
    const state = runningState("resume-stale", workflow);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    state.currentNode = "work";
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId: "work",
      attemptId: "a1",
      payload: { nodeType: "compute" },
    });
    // Crash between trace append and projection: seq 3 exists only in trace.
    await fs.appendFile(
      path.join(runDir, "trace.ndjson"),
      `${JSON.stringify({
        seq: 3,
        at: new Date().toISOString(),
        runId: "resume-stale",
        scope: "node",
        type: "node_finished",
        nodeId: "work",
        attemptId: "a1",
        payload: { outcome: "ok", output: "phantom", durationMs: 1 },
      })}\n`,
    );

    const engine = makeEngine(store);
    const result = await engine.resumeRun(workflow, "resume-stale");
    expect(result.state.status).toBe("completed");
    // The phantom result was discarded; the node really reran.
    expect(work).toHaveBeenCalledTimes(1);
    expect(result.state.results.work?.output).toBe("done");
  });

  it("refuses to resume against changed source unless forced", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "work",
      nodes: { work: compute({ run: () => "done" }) },
      edges: [],
    });
    const state = { ...runningState("resume-hash", workflow), workflowHash: "old-hash" };
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    const engine = makeEngine(store);
    await expect(
      engine.resumeRun(workflow, "resume-hash", { workflowHash: "new-hash" }),
    ).rejects.toThrow(WorkflowSourceChangedError);

    const forced = await engine.resumeRun(workflow, "resume-hash", {
      workflowHash: "new-hash",
      force: true,
    });
    expect(forced.state.status).toBe("completed");
    const resumed = await readLastTraceEvent(runDir);
    expect(resumed?.type).toBe("run_completed");
    const types = await traceTypes(runDir);
    expect(types).toContain("run_resumed");
  });

  it("restores the waiting gate when a crash hit after a checkpoint", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const downstream = vi.fn(() => "should not run");
    const workflow = defineWorkflow({
      name: "gate-flow",
      startAt: "approval",
      nodes: {
        approval: checkpoint({ summary: "approve" }),
        apply: compute({ run: downstream }),
      },
      edges: [{ from: "approval", to: "apply" }],
    });

    // Crash window: the checkpoint's node_finished persisted, but the
    // terminal run_waiting event did not.
    const state = runningState("resume-checkpoint", workflow);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    state.results.approval = {
      attemptId: "a1",
      nodeId: "approval",
      nodeType: "checkpoint",
      outcome: "ok",
      output: { summary: "approve" },
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      durationMs: 1,
    };
    state.outputs.approval = { summary: "approve" };
    state.steps.push({
      attemptId: "a1",
      nodeId: "approval",
      nodeType: "checkpoint",
      outcome: "ok",
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      prompt: null,
      output: { summary: "approve" },
    });
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_finished",
      nodeId: "approval",
      attemptId: "a1",
      payload: { outcome: "ok", output: { summary: "approve" }, durationMs: 1 },
    });

    const engine = makeEngine(store);
    const result = await engine.resumeRun(workflow, "resume-checkpoint");

    // The human gate is restored; nothing downstream executes.
    expect(result.state.status).toBe("waiting");
    expect(result.state.waitingOn).toBe("approval");
    expect(downstream).not.toHaveBeenCalled();
    void runDir;
  });

  it("resumes a parked continuation past the answered checkpoint", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "gate-flow",
      startAt: "approval",
      nodes: {
        approval: checkpoint({ summary: "approve" }),
        apply: compute({ run: () => "deployed" }),
      },
      edges: [{ from: "approval", to: "apply" }],
    });

    // A parked continuation bundle: the parent's carried checkpoint is the
    // last recorded step, parentRunId is set, and nothing new has run yet.
    const state = {
      ...runningState("continuation-parked", workflow),
      parentRunId: "parent-run",
    };
    state.results.approval = {
      attemptId: "a1",
      nodeId: "approval",
      nodeType: "checkpoint",
      outcome: "ok",
      output: { summary: "approve" },
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      durationMs: 1,
    };
    state.outputs.approval = { summary: "approve" };
    state.steps.push({
      attemptId: "a1",
      nodeId: "approval",
      nodeType: "checkpoint",
      outcome: "ok",
      startedAt: state.startedAt,
      finishedAt: state.startedAt,
      prompt: null,
      output: { summary: "approve" },
    });
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });

    const resumer = makeEngine(store);
    const resumed = await resumer.resumeRun(workflow, "continuation-parked");
    // It routes past the answered checkpoint instead of regressing to waiting.
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.finalOutput).toBe("deployed");
    void runDir;
  });

  it("refuses to resume terminal or waiting runs", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "work",
      nodes: { work: compute({ run: () => "done" }) },
      edges: [],
    });
    const engine = makeEngine(store);
    await engine.run(workflow, {}, { runId: "resume-done" });
    await expect(engine.resumeRun(workflow, "resume-done")).rejects.toThrow(/status/);
  });

  it("accounts replayed steps against maxSteps", async () => {
    const outputRoot = await makeTempDir("pi-resume-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "demo",
      maxSteps: 2,
      startAt: "one",
      nodes: {
        one: compute({ run: () => 1 }),
        two: compute({ run: () => 2 }),
        three: compute({ run: () => 3 }),
      },
      edges: [
        { from: "one", to: "two" },
        { from: "two", to: "three" },
      ],
    });
    const state = runningState("resume-steps", workflow);
    const runDir = await store.initializeRunBundle(workflow, state);
    await store.writeSnapshot(runDir, state, { scope: "run", type: "run_started", payload: {} });
    // Two steps already recorded; the graph was mid-walk to node three.
    for (const nodeId of ["one", "two"]) {
      state.results[nodeId] = {
        attemptId: `a-${nodeId}`,
        nodeId,
        nodeType: "compute",
        outcome: "ok",
        output: nodeId === "one" ? 1 : 2,
        startedAt: state.startedAt,
        finishedAt: state.startedAt,
        durationMs: 1,
      };
      state.steps.push({
        attemptId: `a-${nodeId}`,
        nodeId,
        nodeType: "compute",
        outcome: "ok",
        startedAt: state.startedAt,
        finishedAt: state.startedAt,
        prompt: null,
        output: null,
      });
    }
    state.outputs.one = 1;
    state.outputs.two = 2;
    await store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_finished",
      nodeId: "two",
      attemptId: "a-two",
      payload: { outcome: "ok", output: 2, durationMs: 1 },
    });

    const engine = makeEngine(store);
    const result = await engine.resumeRun(workflow, "resume-steps");
    // The third dispatch exceeds maxSteps=2 with two replayed steps.
    expect(result.state.status).toBe("failed");
    expect(result.state.error).toMatch(/maxSteps/);
  });
});
