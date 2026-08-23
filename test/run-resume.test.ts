import { describe, expect, it } from "vitest";
import { agent, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowSourceChangedError } from "../src/workflows/errors.js";
import { ScriptedExecutor, makeStateDatabasePath, waitUntil } from "./helpers.js";

function workflow(counter: { count: number }) {
  return defineWorkflow({
    name: "resumable",
    startAt: "prepare",
    nodes: {
      prepare: compute({
        run: () => {
          counter.count += 1;
          return { prepared: true };
        },
      }),
      finish: agent({ prompt: () => "finish" }),
    },
    edges: [{ from: "prepare", to: "finish" }],
  });
}

describe("WorkflowEngine.resumeRun SQLite", () => {
  it("continues at the interrupted node without repeating completed work", async () => {
    const databasePath = await makeStateDatabasePath("resume-run");
    const counter = { count: 0 };
    const definition = workflow(counter);
    const firstExecutor = new ScriptedExecutor().respond("finish", { hang: true });
    const first = new WorkflowEngine({ databasePath, executor: firstExecutor });
    const running = first.run(definition, {}, { runId: "resume-1" });
    await waitUntil(() => firstExecutor.requests.length === 1);
    first.park();
    await running;

    const second = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("finish", { output: { done: true } }),
    });
    const result = await second.resumeRun(definition, "resume-1");
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toEqual({ done: true });
    expect(counter.count).toBe(1);
  });

  it("rejects changed source unless force is explicit", async () => {
    const databasePath = await makeStateDatabasePath("resume-source");
    const definition = workflow({ count: 0 });
    const executor = new ScriptedExecutor().respond("finish", { hang: true });
    const first = new WorkflowEngine({ databasePath, executor });
    const running = first.run(
      definition,
      {},
      {
        runId: "resume-source",
        workflowSource: { kind: "file", path: "/workflow.ts", hash: "old" },
      },
    );
    await waitUntil(() => executor.requests.length === 1);
    first.park();
    await running;

    const second = new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("finish", { output: { done: true } }),
    });
    await expect(
      second.resumeRun(definition, "resume-source", {
        workflowSource: { kind: "file", path: "/workflow.ts", hash: "new" },
      }),
    ).rejects.toThrow(WorkflowSourceChangedError);
    const forced = await second.resumeRun(definition, "resume-source", {
      workflowSource: { kind: "file", path: "/workflow.ts", hash: "new" },
      force: true,
    });
    expect(forced.state.status).toBe("completed");
  });

  it("rejects a terminal run", async () => {
    const databasePath = await makeStateDatabasePath("resume-terminal");
    const definition = defineWorkflow({
      name: "terminal",
      startAt: "done",
      nodes: { done: compute({ run: () => true }) },
      edges: [],
    });
    await new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() }).run(
      definition,
      {},
      { runId: "terminal-run" },
    );
    await expect(
      new WorkflowEngine({ databasePath, executor: new ScriptedExecutor() }).resumeRun(
        definition,
        "terminal-run",
      ),
    ).rejects.toThrow(/status completed/);
  });
});
