import { describe, expect, it } from "vitest";
import planApprovalWorkflow, {
  parsePlanApprovalPolicy,
} from "../src/builtins/plan-approval.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, HumanDecisionResponse } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const planDigest = `sha256:${"a".repeat(64)}`;

async function runChoice(response: HumanDecisionResponse) {
  const runs = await makeTempDir("plan-approval");
  const store = new WorkflowRunStore(runs);
  const makeEngine = () => new WorkflowEngine({ store, executor: new ScriptedExecutor() });
  const parent = await makeEngine().run(
    planApprovalWorkflow,
    {
      task: "implement feature",
      plan: { steps: ["one"] },
      planDigest,
      approval: { mode: "required", audience: "operator" },
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
  it("defaults to a ten-minute autonomous operator policy", () => {
    expect(parsePlanApprovalPolicy(undefined)).toEqual({
      mode: "auto",
      audience: "operator",
      timeoutMinutes: 10,
      maxReplans: 3,
    });
    expect(parsePlanApprovalPolicy({ mode: "required" })).toEqual({
      mode: "required",
      audience: "operator",
      maxReplans: 3,
    });
    expect(parsePlanApprovalPolicy({ mode: "skip" })).toEqual({
      mode: "skip",
      audience: "operator",
      maxReplans: 3,
    });
    expect(() => parsePlanApprovalPolicy({ mode: "required", timeoutMinutes: 10 })).toThrow(
      /only in auto mode/,
    );
  });

  it("stores the typed plan separately from its readable presentation", async () => {
    const runs = await makeTempDir("plan-approval-presentation");
    const store = new WorkflowRunStore(runs);
    const parent = await new WorkflowEngine({ store, executor: new ScriptedExecutor() }).run(
      planApprovalWorkflow,
      {
        task: "implement readable decisions",
        plan: {
          summary: "Show the operator readable text.",
          steps: [
            {
              change: "Separate subject and presentation",
              verification: "Run the decision tests",
            },
          ],
          boundaries: ["Do not change Pi core"],
        },
        planDigest,
        approval: { mode: "required" },
      },
      { runId: "approval-presentation" },
    );
    const request = parent.state.finalOutput as HumanDecisionRequest;
    expect(request.schema).toBe("pi-workflows.human-decision-request.v2");
    if (request.schema !== "pi-workflows.human-decision-request.v2") return;
    expect(request.subject).toMatchObject({
      task: "implement readable decisions",
      planDigest,
      revision: 1,
    });
    expect(JSON.stringify(request.presentation)).toContain("Do not change Pi core");
    expect(request.presentation.summary).toBe("Show the operator readable text.");
    expect(request.expiresAt).toBeUndefined();
  });

  it("uses a durable timeout response in auto mode", async () => {
    const runs = await makeTempDir("plan-approval-timeout");
    const store = new WorkflowRunStore(runs);
    const makeEngine = () => new WorkflowEngine({ store, executor: new ScriptedExecutor() });
    const parent = await makeEngine().run(
      planApprovalWorkflow,
      { task: "demo", plan: { step: 1 }, planDigest },
      { runId: "approval-timeout" },
    );
    const request = parent.state.finalOutput as HumanDecisionRequest;
    expect(request.defaultResponse).toEqual({ choice: "continue" });
    expect(Date.parse(request.expiresAt ?? "") - Date.parse(request.createdAt)).toBe(600_000);

    const resolved = await new HumanDecisionStore(runs).resolveTimeout(
      request,
      new Date(request.expiresAt!),
    );
    expect(resolved.decision).toMatchObject({
      provenance: "timeout",
      response: { choice: "continue" },
    });
    const continuation = await makeEngine().continueRun(
      planApprovalWorkflow,
      parent.state.runId,
      {},
      { humanDecision: resolved.decision },
    );
    expect(continuation.state.finalOutput).toMatchObject({
      status: "continue",
      resolution: {
        provenance: "timeout",
        decision: { provenance: "timeout", response: { choice: "continue" } },
      },
    });
  });

  it("continues immediately without a decision in skip mode", async () => {
    const result = await new WorkflowEngine({
      store: new WorkflowRunStore(await makeTempDir("plan-approval-skip")),
      executor: new ScriptedExecutor(),
    }).run(planApprovalWorkflow, {
      task: "demo",
      plan: { step: 1 },
      planDigest,
      approval: { mode: "skip" },
      revision: 2,
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "continue",
      resolution: { provenance: "skipped", revision: 2 },
    });
  });

  it("rejects malformed input and missing continuation receipts", async () => {
    await expect(
      new WorkflowEngine({
        store: new WorkflowRunStore(await makeTempDir("plan-approval-invalid")),
        executor: new ScriptedExecutor(),
      }).run(planApprovalWorkflow, {
        task: "demo",
        plan: {},
        planDigest: "digest",
        revision: 0,
      }),
    ).rejects.toThrow(/positive integer/);

    const continued = planApprovalWorkflow.nodes.continued;
    if (continued?.nodeType !== "compute") throw new Error("continued is not compute");
    await expect(
      Promise.resolve().then(() =>
        continued.run({
          input: {
            task: "demo",
            plan: {},
            planDigest: "digest",
            approval: parsePlanApprovalPolicy({ mode: "required" }),
          },
          outputs: {},
          results: {},
          state: { steps: [] },
          signal: new AbortController().signal,
        } as never),
      ),
    ).rejects.toThrow(/receipt is missing/);
  });

  it("returns continue with the accepted decision receipt", async () => {
    const result = await runChoice({ choice: "continue" });
    expect(result.state.finalOutput).toMatchObject({
      status: "continue",
      plan: { steps: ["one"] },
      resolution: {
        provenance: "human",
        decision: {
          schema: "pi-workflows.human-decision-receipt.v2",
          provenance: "human",
          response: { choice: "continue" },
        },
      },
    });
  });

  it("returns stop with the accepted decision receipt", async () => {
    const result = await runChoice({ choice: "stop" });
    expect(result.state.finalOutput).toMatchObject({
      status: "stop",
      resolution: { provenance: "human", decision: { response: { choice: "stop" } } },
    });
  });

  it("returns exact replan text without a model classification step", async () => {
    const instructions = "  use option B\nkeep this exact line  ";
    const result = await runChoice({ choice: "replan", input: { instructions } });
    expect(result.state.finalOutput).toMatchObject({
      status: "replan",
      instructions,
      resolution: {
        provenance: "human",
        decision: { response: { choice: "replan", input: { instructions } } },
      },
    });
  });
});
