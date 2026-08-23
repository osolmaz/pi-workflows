import { describe, expect, it, vi } from "vitest";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import {
  RUN_STATE_SCHEMA,
  SESSION_BINDING_SCHEMA,
  SESSION_CAPTURE_SCHEMA,
  SESSION_EVENT_SCHEMA,
  WorkflowRunStore,
  listWorkflowRuns,
  readLastTraceEvent,
} from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir } from "./helpers.js";

const workflow = defineWorkflow({
  name: "store-branches",
  startAt: "work",
  nodes: { work: compute({ run: () => true }) },
  edges: [],
});

function state(runId: string): WorkflowRunState {
  const now = new Date().toISOString();
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
    updates: [],
  };
}

describe("WorkflowRunStore branch behavior", () => {
  it("uses default database and read options without creating run directories", async () => {
    const home = await makeTempDir("run-default-home");
    vi.stubEnv("HOME", home);
    try {
      const store = new WorkflowRunStore();
      expect(store.listRuns()).toEqual([]);
      expect(store.readLastTraceEvent("missing")).toBeNull();
      expect(readLastTraceEvent("missing")).toBeNull();
      expect(listWorkflowRuns()).toEqual([]);
      store.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects duplicate runs and leaves terminal runs unchanged", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-duplicate"));
    const current = state("run-1");
    await store.initializeRun(workflow, current);
    await expect(store.initializeRun(workflow, state("run-1"))).rejects.toThrow(/already exists/);
    current.status = "completed";
    current.finishedAt = new Date().toISOString();
    await store.writeSnapshot("run-1", current, {
      scope: "run",
      type: "run_completed",
      payload: { finalOutput: true },
    });
    expect((await store.markRunInterrupted("run-1"))?.state.status).toBe("completed");
    expect(await store.markRunInterrupted("missing")).toBeNull();
    store.close();
  });

  it("rejects aborted and over-limit update publication", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-update-branches"));
    const current = state("run-2");
    current.currentNode = "work";
    current.currentAttemptId = "attempt-1";
    current.currentNodeStartedAt = new Date().toISOString();
    await store.initializeRun(workflow, current);
    await store.writeSnapshot("run-2", current, {
      scope: "node",
      type: "node_started",
      nodeId: "work",
      attemptId: "attempt-1",
      payload: {},
    });
    const abort = new AbortController();
    abort.abort(new Error("closed"));
    await expect(
      store.publishUpdate(
        "run-2",
        current,
        "work",
        "attempt-1",
        { type: "note", key: "one", data: {} },
        { signal: abort.signal },
      ),
    ).rejects.toThrow("closed");
    current.updates = Array.from({ length: 1_024 }, (_, index) => ({
      updateId: `update-${index}`,
      seq: index + 1,
      at: new Date().toISOString(),
      runId: current.runId,
      nodeId: "work",
      attemptId: "attempt-1",
      type: "note",
      key: `key-${index}`,
      data: {},
    }));
    await expect(
      store.publishUpdate("run-2", current, "work", "attempt-1", {
        type: "note",
        key: "new",
        data: {},
      }),
    ).rejects.toThrow(/at most 1024/);
    store.close();
  });

  it("adopts one binding and creates later capture segments", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-segments"));
    const current = state("run-3");
    await store.initializeRun(workflow, current);
    const binding = {
      schema: SESSION_BINDING_SCHEMA,
      runId: "run-3",
      piSessionId: "session-a",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    } as const;
    await store.writeSessionBinding("run-3", binding);
    await store.writeSessionBinding("run-3", binding);
    await store.writeSessionBinding(
      "run-3",
      { ...binding, piSessionId: "session-b", boundAt: new Date().toISOString() },
      "capture-b",
    );
    expect(await store.hasSessionBinding("run-3")).toBe(true);
    expect(await store.listSessionSegments("run-3")).toEqual(["capture-b"]);
    expect(store.readRun("run-3")?.sessionSegments).toHaveLength(1);
    store.close();
  });

  it("validates event sequences and terminal capture states", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-capture-branches"));
    await store.initializeRun(workflow, state("run-4"));
    await store.writeSessionBinding("run-4", {
      schema: SESSION_BINDING_SCHEMA,
      runId: "run-4",
      piSessionId: "session-a",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await expect(
      store.appendSessionEventBatch("run-4", [
        {
          seq: 2,
          at: new Date().toISOString(),
          nodeId: "work",
          attemptId: "attempt",
          type: "future_event" as never,
          payload: {},
        },
      ]),
    ).rejects.toThrow(/Expected session event seq 1/);
    await expect(
      store.writeSessionCapture("run-4", {
        schema: SESSION_CAPTURE_SCHEMA,
        eventSchema: SESSION_EVENT_SCHEMA,
        status: "failed",
        eventCount: 0,
        entryCount: 0,
        lastEventSeq: 0,
      }),
    ).rejects.toThrow(/requires failure details/);
    await store.writeSessionCapture("run-4", {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: "failed",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
      failure: { failedAt: new Date().toISOString(), code: "failed", message: "failed" },
    });
    await store.writeSessionCapture("run-4", {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: "complete",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });
    expect(store.readRun("run-4")?.sessionCapture?.status).toBe("failed");
    store.close();
  });

  it("adopts an already terminal capture during run preparation", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-terminal-capture"));
    await store.initializeRun(workflow, state("run-5"));
    await store.writeSessionBinding("run-5", {
      schema: SESSION_BINDING_SCHEMA,
      runId: "run-5",
      piSessionId: "session-a",
      cwd: "/tmp",
      boundAt: new Date().toISOString(),
    });
    await store.writeSessionCapture("run-5", {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: "complete",
      eventCount: 0,
      entryCount: 0,
      lastEventSeq: 0,
    });
    expect((await store.prepareRunResume("run-5")).sessionCapture?.status).toBe("complete");
    store.close();
  });

  it("stores builtin and file source identities", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("run-sources"));
    const builtin = state("builtin-run");
    builtin.workflowSource = { kind: "builtin", id: "demo", revision: "1" };
    await store.initializeRun(workflow, builtin);
    const file = state("file-run");
    file.workflowSource = { kind: "file", path: "/tmp/demo.ts", hash: "abc" };
    await store.initializeRun(workflow, file);
    const rows = store.state.connection
      .prepare("SELECT source_type AS sourceType FROM runs ORDER BY run_id")
      .all();
    expect(rows).toEqual([{ sourceType: "builtin" }, { sourceType: "file" }]);
    store.close();
  });
});
