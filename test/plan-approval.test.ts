import { describe, expect, it } from "vitest";
import planApprovalWorkflow from "../src/builtins/plan-approval.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, HumanDecisionResponse } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

async function runChoice(response: HumanDecisionResponse) {
  const runs = await makeTempDir("plan-approval");
  const store = new WorkflowRunStore(runs);
  const makeEngine = () => new WorkflowEngine({ store, executor: new ScriptedExecutor() });
  const parent = await makeEngine().run(
    planApprovalWorkflow,
    {
      task: "implement feature",
      plan: { steps: ["one"] },
      planDigest: `sha256:${"a".repeat(64)}`,
      audience: "operator",
    },
    { runId: `approval-${response.choice}` },
  );
  const request = parent.state.finalOutput as HumanDecisionRequest;
  const accepted = await new HumanDecisionStore(runs).accept(request, {
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    ...response,
    source: { channel: "pi", actorId: "person", eventId: `event-${response.choice}` },
    idempotencyKey: `event-${response.choice}`,
  });
  return await makeEngine().continueRun(
    planApprovalWorkflow,
    parent.state.runId,
    {},
    { humanDecision: accepted.decision },
  );
}

describe("plan-approval workflow", () => {
  it("rejects malformed input and missing continuation receipts", async () => {
    const parse = planApprovalWorkflow.input;
    if (parse === undefined) throw new Error("missing plan approval input parser");
    expect(() => parse(null)).toThrow(/object/);
    expect(() => parse({ task: "demo" })).toThrow(/requires a plan/);
    expect(() =>
      parse({ task: "demo", plan: {}, planDigest: "digest", audience: "operator", revision: 0 }),
    ).toThrow(/positive integer/);
    expect(() => parse({ task: "", plan: {}, planDigest: "digest", audience: "operator" })).toThrow(
      /task/,
    );

    const continued = planApprovalWorkflow.nodes.continued;
    if (continued?.nodeType !== "compute") throw new Error("continued is not compute");
    await expect(
      Promise.resolve().then(() =>
        continued.run({
          input: { task: "demo", plan: {}, planDigest: "digest", audience: "operator" },
          outputs: {},
          results: {},
          state: { steps: [] },
          signal: new AbortController().signal,
        } as never),
      ),
    ).rejects.toThrow(/accepted decision/);

    const replan = planApprovalWorkflow.nodes.replan;
    if (replan?.nodeType !== "compute") throw new Error("replan is not compute");
    await expect(
      Promise.resolve().then(() =>
        replan.run({
          input: { task: "demo", plan: {}, planDigest: "digest", audience: "operator" },
          outputs: { approve: { choice: "replan", input: {} } },
          results: {},
          state: {
            steps: [],
            humanDecision: {
              schema: "pi-workflows.human-decision-receipt.v1",
              decisionId: "decision",
              requestDigest: `sha256:${"a".repeat(64)}`,
              nodeId: "approve",
              response: { choice: "replan" },
              acceptedAt: "2026-08-19T00:00:00.000Z",
              answerDigest: `sha256:${"b".repeat(64)}`,
            },
          },
          signal: new AbortController().signal,
        } as never),
      ),
    ).rejects.toThrow(/missing exact instructions/);
  });

  it("returns continue with the accepted decision receipt", async () => {
    const result = await runChoice({ choice: "continue" });
    expect(result.state.finalOutput).toMatchObject({
      status: "continue",
      plan: { steps: ["one"] },
      decision: { response: { choice: "continue" } },
    });
  });

  it("returns stop with the accepted decision receipt", async () => {
    const result = await runChoice({ choice: "stop" });
    expect(result.state.finalOutput).toMatchObject({
      status: "stop",
      decision: { response: { choice: "stop" } },
    });
  });

  it("returns exact replan text without a model classification step", async () => {
    const instructions = "  use option B\nkeep this exact line  ";
    const result = await runChoice({ choice: "replan", input: { instructions } });
    expect(result.state.finalOutput).toMatchObject({
      status: "replan",
      instructions,
      decision: { response: { choice: "replan", input: { instructions } } },
    });
  });
});
