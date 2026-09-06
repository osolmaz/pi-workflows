import { describe, expect, it } from "vitest";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { recordWorkflowSubmission, requestForAttempt } from "../src/workflows/requests.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

describe("same-run checkpoint completion", () => {
  it("keeps input, attempt identity, and history across a checkpoint", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("checkpoint-resume"));
    const engine = () => new WorkflowEngine({ store, executor: new ScriptedExecutor() });
    const workflow = defineWorkflow({
      name: "approval",
      startAt: "prepare",
      nodes: {
        prepare: compute({ run: () => "prepared" }),
        approval: checkpoint({ summary: "approve" }),
        finish: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approval }) }),
      },
      edges: [
        { from: "prepare", to: "approval" },
        { from: "approval", to: "finish" },
      ],
    });
    try {
      const waiting = await engine().run(workflow, { task: "original" }, { runId: "one-run" });
      expect(waiting.state.status).toBe("waiting");
      expect(waiting.state.steps.map((step) => step.nodeId)).toEqual(["prepare"]);
      expect(waiting.state.finishedAt).toBeUndefined();
      const attemptId = waiting.state.currentAttemptId!;
      const request = requestForAttempt(store.state, waiting.runId, attemptId)!;
      expect(request.kind).toBe("checkpoint");
      await expect(engine().resumeRun(workflow, waiting.runId)).rejects.toThrow(/waiting/);
      const submission = {
        requestId: request.requestId,
        submissionId: "answer",
        idempotencyKey: "answer",
        expectedRevision: request.revision,
        payload: { approved: true },
        outcome: "accepted" as const,
        settle: true,
      };
      recordWorkflowSubmission(store.state, submission);
      expect(recordWorkflowSubmission(store.state, submission).outcome).toBe("adopted");
      const done = await engine().resumeRun(workflow, waiting.runId);
      expect(done.state.status).toBe("completed");
      expect(done.runId).toBe(waiting.runId);
      expect(done.state.input).toEqual({ task: "original" });
      expect(done.state.steps.map((step) => step.nodeId)).toEqual([
        "prepare",
        "approval",
        "finish",
      ]);
      expect(done.state.steps[1]?.attemptId).toBe(attemptId);
      expect(done.state.finalOutput).toEqual({
        input: { task: "original" },
        answer: { approved: true },
      });
      expect(store.state.connection.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
        count: 1,
      });
    } finally {
      store.close();
    }
  });
});
