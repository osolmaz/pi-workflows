import { describe, expect, it } from "vitest";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import {
  HumanDecisionStore,
  choice,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
} from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { humanRequest, submitCheckpoint } from "./checkpoint-helpers.js";
import { makeStateDatabasePath, decisionPrompt, ScriptedExecutor } from "./helpers.js";

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});
const workflow = defineWorkflow({
  name: "human-decision-engine",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      request: ({ input }) => decisionPrompt(input),
    }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
    stopped: compute({ run: () => "stopped" }),
  },
  edges: [
    humanDecisionEdge({
      from: "approve",
      choices,
      cases: { continue: "continued", stop: "stopped" },
    }),
  ],
});
function engine(store: WorkflowRunStore) {
  return new WorkflowEngine({ store, executor: new ScriptedExecutor() });
}

describe("same-run human decision completion", () => {
  it("stores the request atomically and resumes the exact attempt with a verified receipt", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("human-decision-engine"));
    const decisions = new HumanDecisionStore(store.databasePath, { state: store.state });
    try {
      const waiting = await engine(store).run(
        workflow,
        { task: "keep original" },
        { runId: "human-run" },
      );
      expect(waiting.state.status).toBe("waiting");
      expect(waiting.state.steps).toHaveLength(0);
      const request = humanRequest(store, waiting.state);
      expect(await decisions.readRequest(request.decisionId)).toEqual(request);
      const accepted = await decisions.accept(request, {
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        choice: "continue",
        source: { channel: "pi", actorId: "person", eventId: "event" },
        idempotencyKey: "event",
      });
      submitCheckpoint(store, waiting.state, accepted.decision.response);
      const done = await engine(store).resumeRun(workflow, waiting.runId);
      expect(done.state.status).toBe("completed");
      expect(done.state.finalOutput).toEqual({
        input: { task: "keep original" },
        answer: { choice: "continue" },
      });
      expect(done.state.humanDecision).toMatchObject({
        provenance: "human",
        response: { choice: "continue" },
      });
      expect(done.state.humanDecision).not.toHaveProperty("source");
      expect(store.readRun(waiting.runId)?.state.humanDecision).toEqual(done.state.humanDecision);
      expect(done.state.steps[0]?.attemptId).toBe(waiting.state.currentAttemptId);
      expect(store.state.connection.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
        count: 1,
      });
    } finally {
      store.close();
    }
  });

  it("rejects a response without human provenance before it changes the request", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("human-decision-forged"));
    try {
      const waiting = await engine(store).run(workflow, {}, { runId: "human-forged" });
      expect(() => submitCheckpoint(store, waiting.state, { choice: "continue" })).toThrow(
        /verified human decision/,
      );
      await expect(engine(store).resumeRun(workflow, waiting.runId)).rejects.toThrow(/waiting/);
      expect(
        store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM interactive_submissions")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("rejects a response that differs from the accepted human decision", async () => {
    const store = new WorkflowRunStore(await makeStateDatabasePath("human-decision-mismatch"));
    try {
      const waiting = await engine(store).run(workflow, {}, { runId: "human-mismatch" });
      const request = humanRequest(store, waiting.state);
      await new HumanDecisionStore(store.databasePath, { state: store.state }).accept(request, {
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        choice: "continue",
        source: { channel: "pi", actorId: "person", eventId: "event" },
        idempotencyKey: "event",
      });
      expect(() => submitCheckpoint(store, waiting.state, { choice: "stop" })).toThrow(
        /verified human decision/,
      );
      expect(
        store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM interactive_submissions")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });
});
