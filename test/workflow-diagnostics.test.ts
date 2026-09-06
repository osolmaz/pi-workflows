import { expect, it } from "vitest";
import { checkpoint, defineWorkflow } from "../src/workflows/definition.js";
import { workflowStateViolations } from "../src/workflows/diagnostics.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

it("reports exact request contradictions without repairing them", async () => {
  const store = new WorkflowRunStore(await makeStateDatabasePath("workflow-diagnostics"));
  try {
    const engine = new WorkflowEngine({ store, executor: new ScriptedExecutor() });
    const workflow = defineWorkflow({
      name: "diagnostic",
      startAt: "gate",
      nodes: { gate: checkpoint({ summary: "Answer this checkpoint" }) },
      edges: [],
    });
    const waiting = await engine.run(workflow, {});
    expect(workflowStateViolations(store.state)).toEqual([]);
    store.state.connection
      .prepare(
        "INSERT INTO attempt_active_intervals(attempt_id, interval_number, started_at, observed_at) VALUES (?, 1, 100, 100)",
      )
      .run(waiting.state.currentAttemptId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "activeClock", runId: waiting.runId, detail: expect.any(String) },
    ]);
    store.state.connection
      .prepare("UPDATE attempt_active_intervals SET ended_at = observed_at")
      .run();
    store.state.connection
      .prepare("UPDATE runs SET status = 'completed', finished_at = 1 WHERE run_id = ?")
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "pendingRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
    expect(store.readRun(waiting.runId)?.state.status).toBe("completed");
    store.state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(waiting.runId);
    store.state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'settled', accepted_submission_id = 'missing', settled_at = 1 WHERE run_id = ?",
      )
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "acceptedRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
    store.state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'cancelled', accepted_submission_id = NULL, settled_at = NULL WHERE run_id = ?",
      )
      .run(waiting.runId);
    expect(workflowStateViolations(store.state)).toEqual([
      { code: "waitingRequest", runId: waiting.runId, detail: expect.any(String) },
    ]);
  } finally {
    store.close();
  }
});
