import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import {
  SESSION_BINDING_SCHEMA,
  SESSION_CAPTURE_SCHEMA,
  SESSION_EVENT_SCHEMA,
  WorkflowRunStore,
  listWorkflowRuns,
  readWorkflowRun,
} from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

describe("WorkflowRunStore SQLite", () => {
  it("stores one complete run, definition, events, attempts, and output", async () => {
    const databasePath = await makeStateDatabasePath("run-store");
    const engine = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    });

    const result = await engine.run(workflow, { task: "reply" });
    const loaded = readWorkflowRun(result.runId, { databasePath, includeTrace: true });

    expect(result.state.status).toBe("completed");
    expect(loaded?.state.finalOutput).toEqual({ reply: "done" });
    expect(loaded?.snapshot.name).toBe("echo");
    expect(loaded?.traceEvents?.map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "node_started",
      "agent_prompt_sent",
      "node_finished",
      "run_completed",
    ]);

    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM node_attempts").get(),
    ).toEqual({ count: 1 });
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM events").get()).toEqual({
      count: 6,
    });
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM effects").get()).toEqual({
      count: 0,
    });
    store.close();
  });

  it("stores a large output once instead of writing nested run snapshots", async () => {
    const databasePath = await makeStateDatabasePath("run-store-large-output");
    const output = { reply: "x".repeat(1024 * 1024) };
    await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output }),
    }).run(workflow, { task: "reply" });

    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    const stats = store.state.connection
      .prepare(
        `SELECT COUNT(*) AS count, MAX(byte_length) AS largest,
                SUM(byte_length) AS total
         FROM blobs`,
      )
      .get() as { count: number; largest: number; total: number };
    const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    expect(stats.largest).toBeLessThanOrEqual(outputBytes + 1_000);
    expect(stats.total).toBeLessThan(outputBytes + 100_000);
    expect(
      store.state.connection
        .prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'output_hash'")
        .get(),
    ).toBeUndefined();
    store.close();
  });

  it("publishes updates in the same transaction as the run projection", async () => {
    const databasePath = await makeStateDatabasePath("run-updates");
    const executor = new ScriptedExecutor().respond("reply", async (request) => {
      await request.publishUpdate?.({ type: "note", key: "main", data: { completed: 1 } });
      const accepted = await request.accept({ reply: "done" });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
    const result = await new WorkflowEngine({ databasePath, executor }).run(workflow, {});
    const loaded = readWorkflowRun(result.runId, { databasePath, includeTrace: true });

    expect(loaded?.state.updates).toHaveLength(1);
    expect(loaded?.traceEvents?.some((event) => event.type === "update_published")).toBe(true);
    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM workflow_updates").get(),
    ).toEqual({ count: 1 });
    store.close();
  });

  it("stores session capture rows and content-addressed payloads", async () => {
    const databasePath = await makeStateDatabasePath("run-session");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {});
    const store = new WorkflowRunStore(databasePath);
    const binding = {
      schema: SESSION_BINDING_SCHEMA,
      runId: result.runId,
      piSessionId: "session-1",
      cwd: "/tmp/project",
      boundAt: "2026-08-23T00:00:00.000Z",
    } as const;
    await store.writeSessionBinding(result.runId, binding);
    await store.appendSessionEntry(result.runId, { id: "entry-1", type: "message" });
    await store.appendSessionEventBatch(result.runId, [
      {
        seq: 1,
        at: "2026-08-23T00:00:01.000Z",
        nodeId: "reply",
        attemptId: result.state.steps[0]?.attemptId ?? "attempt",
        turnId: "turn-1",
        type: "turn_started",
        payload: { turnIndex: 1 },
      },
    ]);
    await store.writeSessionCapture(result.runId, {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: "complete",
      eventCount: 1,
      entryCount: 1,
      lastEventSeq: 1,
    });

    const loaded = store.readRun(result.runId);
    expect(loaded?.sessionBinding).toEqual(binding);
    expect(loaded?.sessionEntries).toHaveLength(1);
    expect(loaded?.sessionEvents).toHaveLength(1);
    expect(loaded?.sessionIntegrity).toEqual({ status: "complete", diagnostics: [] });
    store.close();
  });

  it("lists runs from one database instead of directories", async () => {
    const databasePath = await makeStateDatabasePath("run-list");
    for (const reply of ["one", "two"]) {
      await new WorkflowEngine({
        databasePath,
        executor: new ScriptedExecutor().respond("reply", { output: { reply } }),
      }).run(workflow, {});
    }
    expect(listWorkflowRuns({ databasePath })).toHaveLength(2);
  });

  it("returns null for a missing run without creating state", async () => {
    const databasePath = await makeStateDatabasePath("run-missing");
    const writer = new WorkflowRunStore(databasePath);
    writer.close();
    expect(readWorkflowRun("missing", { databasePath })).toBeNull();
  });
});
