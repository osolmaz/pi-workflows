import { describe, expect, it } from "vitest";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath, waitUntil } from "./helpers.js";

const workflow = defineWorkflow({
  name: "handoff",
  startAt: "first",
  nodes: {
    first: compute({ run: () => ({ first: true }) }),
    second: agent({ prompt: () => "finish" }),
  },
  edges: [{ from: "first", to: "second" }],
});

describe("durable run handoff in SQLite", () => {
  it("parks active work and continues it from the same database", async () => {
    const databasePath = await makeStateDatabasePath("park-run");
    const firstExecutor = new ScriptedExecutor().respond("second", { hang: true });
    const firstEngine = new WorkflowEngine({ databasePath, executor: firstExecutor });
    const running = firstEngine.run(workflow, {});
    await waitUntil(() => firstExecutor.requests.length === 1);
    firstEngine.park();
    const parked = await running;
    expect(parked.state.status).toBe("running");

    const secondEngine = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("second", { output: { done: true } }),
    });
    const completed = await secondEngine.resumeRun(workflow, parked.runId);
    expect(completed.state.status).toBe("completed");
    expect(completed.state.finalOutput).toEqual({ done: true });
  });

  it("marks an abandoned active run as interrupted through one transaction", async () => {
    const databasePath = await makeStateDatabasePath("interrupted-run");
    const store = new WorkflowRunStore(databasePath);
    const executor = new ScriptedExecutor().respond("second", { hang: true });
    const engine = new WorkflowEngine({ store, executor });
    const running = engine.run(workflow, {});
    await waitUntil(() => executor.requests.length === 1);
    engine.park();
    const parked = await running;
    const interrupted = await store.markRunInterrupted(parked.runId, "owner disappeared");
    expect(interrupted?.state).toMatchObject({ status: "failed", error: "owner disappeared" });
    expect(interrupted?.traceEvents?.at(-1)?.type).toBe("run_interrupted");
    store.close();
  });
});
