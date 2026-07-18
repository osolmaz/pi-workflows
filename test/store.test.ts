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
import type { WorkflowRunState } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function makeState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const now = new Date().toISOString();
  return {
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

    await Promise.all([
      store.appendTrace(runDir, state, { scope: "node", type: "a", payload: {} }),
      store.appendTrace(runDir, state, { scope: "node", type: "b", payload: {} }),
      store.appendTrace(runDir, state, { scope: "node", type: "c", payload: {} }),
    ]);

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const seqs = trace
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3]);
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
});

describe("createDefinitionSnapshot", () => {
  it("captures node metadata without functions", () => {
    const snapshot = createDefinitionSnapshot(workflow);
    expect(snapshot.name).toBe("demo");
    expect(snapshot.nodes.one).toEqual({ nodeType: "compute" });
    expect(JSON.stringify(snapshot)).not.toContain("=>");
  });
});
