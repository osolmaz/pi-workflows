import { describe, expect, it } from "vitest";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowSourceChangedError } from "../src/workflows/errors.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { submitCheckpoint } from "./checkpoint-helpers.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

const workflow = defineWorkflow({
  name: "checkpoint",
  startAt: "gate",
  nodes: {
    gate: checkpoint({ summary: "Approve" }),
    finish: compute({ run: () => "done" }),
  },
  edges: [{ from: "gate", to: "finish" }],
});

describe("checkpoint recovery", () => {
  it("completes a final checkpoint with its answer", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("checkpoint-final"));
    try {
      const engine = new WorkflowEngine({ store, executor: new ScriptedExecutor() });
      const final = defineWorkflow({
        name: "final",
        startAt: "gate",
        nodes: { gate: checkpoint({ summary: "Approve" }) },
        edges: [],
      });
      const waiting = await engine.run(final, {});
      submitCheckpoint(store, waiting.state, "yes");
      const done = await engine.resumeRun(final, waiting.runId);
      expect(done.state.status).toBe("completed");
      expect(done.state.finalOutput).toBe("yes");
    } finally {
      store.close();
    }
  });

  it("rejects changed source before changing durable state", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("checkpoint-source"));
    try {
      const engine = new WorkflowEngine({ store, executor: new ScriptedExecutor() });
      const waiting = await engine.run(
        workflow,
        {},
        { workflowSource: { kind: "file", path: "/demo.ts", hash: "old" } },
      );
      submitCheckpoint(store, waiting.state, true);
      const before = store.readRun(waiting.runId, { includeTrace: true });
      await expect(
        engine.resumeRun(workflow, waiting.runId, {
          workflowSource: { kind: "file", path: "/demo.ts", hash: "new" },
        }),
      ).rejects.toThrow(WorkflowSourceChangedError);
      expect(store.readRun(waiting.runId, { includeTrace: true })).toEqual(before);
      const done = await engine.resumeRun(workflow, waiting.runId, {
        workflowSource: { kind: "file", path: "/demo.ts", hash: "new" },
        force: true,
      });
      expect(done.state.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("counts answered checkpoints once against the step budget", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("checkpoint-budget"));
    try {
      const engine = new WorkflowEngine({ store, executor: new ScriptedExecutor() });
      const capped = defineWorkflow({ ...workflow, maxSteps: 1 });
      const waiting = await engine.run(capped, {});
      submitCheckpoint(store, waiting.state, true);
      const done = await engine.resumeRun(capped, waiting.runId);
      expect(done.state.status).toBe("failed");
      expect(done.state.error).toMatch(/maxSteps/);
      expect(done.state.steps).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
