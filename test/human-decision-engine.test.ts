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
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { decisionPrompt, makeTempDir, ScriptedExecutor } from "./helpers.js";

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

const workflow = defineWorkflow({
  name: "human-decision-engine",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: ({ input }) => (input as { audience: string }).audience,
      choices,
      request: ({ input }) => decisionPrompt(input),
    }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
    stopped: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
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

describe("human decision engine continuation", () => {
  it("stores the request, waits, preserves input, and routes from the accepted answer", async () => {
    const runs = await makeTempDir("human-decision-engine");
    const store = new WorkflowRunStore(runs);
    const parent = await engine(store).run(
      workflow,
      { audience: "operator", task: "keep original" },
      { runId: "human-parent" },
    );
    expect(parent.state.status).toBe("waiting");
    expect(parent.state.waitingOn).toBe("approve");
    const request = parent.state.finalOutput as HumanDecisionRequest;
    expect(request).toMatchObject({
      schema: "pi-workflows.human-decision-request.v1",
      audience: "operator",
      runId: "human-parent",
    });
    const decisionStore = new HumanDecisionStore(runs);
    expect(await decisionStore.readRequest(request.decisionId)).toEqual(request);

    const accepted = await decisionStore.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
    });
    expect(accepted.status).toBe("accepted");
    const continued = await engine(store).continueRun(
      workflow,
      parent.state.runId,
      { ignored: true },
      { humanDecision: accepted.decision, runId: "human-continuation" },
    );
    expect(continued.state.status).toBe("completed");
    expect(continued.state.input).toEqual({ audience: "operator", task: "keep original" });
    expect(continued.state.finalOutput).toEqual({
      input: { audience: "operator", task: "keep original" },
      answer: { choice: "continue" },
    });
    expect(continued.state.humanDecision).toMatchObject({
      schema: "pi-workflows.human-decision-receipt.v1",
      provenance: "human",
      response: { choice: "continue" },
    });
    expect(continued.state.humanDecision).not.toHaveProperty("source");
  });

  it("rejects a forged accepted object that is not in the durable decision store", async () => {
    const runs = await makeTempDir("human-decision-engine-forged");
    const store = new WorkflowRunStore(runs);
    const parent = await engine(store).run(
      workflow,
      { audience: "operator" },
      { runId: "human-parent-forged" },
    );
    const request = parent.state.finalOutput as HumanDecisionRequest;
    await expect(
      engine(store).continueRun(
        workflow,
        parent.state.runId,
        {},
        {
          humanDecision: {
            schema: "pi-workflows.human-decision-accepted.v1",
            provenance: "human",
            decisionId: request.decisionId,
            requestDigest: request.requestDigest,
            subjectDigest: request.subjectDigest,
            presentationDigest: request.presentationDigest,
            revision: request.revision,
            response: { choice: "continue" },
            source: { channel: "pi", actorId: "forged", eventId: "forged" },
            idempotencyKey: "forged",
            acceptedAt: "2026-08-19T00:00:00.000Z",
            answerDigest: `sha256:${"0".repeat(64)}`,
          },
        },
      ),
    ).rejects.toThrow(/durable decision record/);
  });

  it("rejects a continuation without the verified accepted decision", async () => {
    const runs = await makeTempDir("human-decision-engine-reject");
    const store = new WorkflowRunStore(runs);
    await engine(store).run(workflow, { audience: "operator" }, { runId: "human-parent-reject" });
    await expect(engine(store).continueRun(workflow, "human-parent-reject", {})).rejects.toThrow(
      /accepted verified human decision/,
    );
  });

  it("rejects an accepted answer for a different request revision", async () => {
    const runs = await makeTempDir("human-decision-engine-stale");
    const store = new WorkflowRunStore(runs);
    const parent = await engine(store).run(
      workflow,
      { audience: "operator" },
      { runId: "human-parent-stale" },
    );
    const request = parent.state.finalOutput as HumanDecisionRequest;
    const accepted = await new HumanDecisionStore(runs).accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
    });
    await expect(
      engine(store).continueRun(
        workflow,
        parent.state.runId,
        {},
        {
          humanDecision: { ...accepted.decision, requestDigest: `sha256:${"0".repeat(64)}` },
        },
      ),
    ).rejects.toThrow(/does not match/);
  });
});
