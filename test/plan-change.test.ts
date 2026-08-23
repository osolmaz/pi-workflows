import { describe, expect, it } from "vitest";
import planChangeWorkflow from "../src/builtins/plan-change.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

function planningExecutor(plan: unknown): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("design/frame", {
      output: {
        problem: "change the implementation",
        success: ["complete"],
        inScope: ["repository"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repository",
      },
    })
    .respond("design/propose", {
      output: {
        candidates: [
          {
            id: "selected-plan",
            title: "Selected plan",
            gist: "Use the selected plan.",
            solution: "use the selected plan",
            rationale: "it is in scope",
            parts: ["implement"],
            tradeoffs: [],
          },
          {
            id: "larger-plan",
            title: "Larger plan",
            gist: "Use a larger change.",
            solution: "use a larger change",
            rationale: "it can work",
            parts: ["redesign"],
            tradeoffs: ["more work"],
          },
        ],
        previousPlan: { status: "candidate", candidateId: "selected-plan" },
      },
    })
    .respond("design/ideal", {
      output: { ideal: "complete", outsideDependencies: [], additionalValue: [] },
    })
    .respond("design/choose", {
      output: {
        status: "ready",
        selectedId: "selected-plan",
        why: "it is practical",
        relationshipToIdeal: "same result",
        rejected: [
          { id: "larger-plan", reason: "it adds unnecessary work" },
          { id: "ideal", reason: "the selected plan already meets the goal" },
        ],
        compromises: [],
      },
    })
    .respond("design/plan", { output: plan })
    .respond("design/readySummary/summarize", () => ({
      output: "Use the selected plan. The larger and ideal options are unnecessary.",
      assistantMessage: { sha256: "a".repeat(64) },
    }))
    .respond("documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/plan.md"],
        digests: {},
        reason: "The selected plan is current.",
        evidence: "checked",
      },
    });
}

describe("plan-change workflow", () => {
  it("budgets enough graph steps for the supported 20-replan limit", () => {
    expect(planChangeWorkflow.maxSteps).toBeGreaterThanOrEqual(300);
  });

  it("rejects unknown input fields before applying approval defaults", async () => {
    const engine = new WorkflowEngine({
      databasePath: await makeStateDatabasePath("plan-change-invalid"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    });
    await expect(
      engine.run(planChangeWorkflow, {
        task: "change the implementation",
        approvals: { mode: "required" },
      }),
    ).rejects.toThrow(/unknown field approvals/);
  });

  it("uses the shared skip policy without creating a human decision", async () => {
    const result = await new WorkflowEngine({
      databasePath: await makeStateDatabasePath("plan-change-skip"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    }).run(planChangeWorkflow, {
      task: "change the implementation",
      approval: { mode: "skip" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "ready",
      plan: { summary: "plan", steps: ["one"] },
      documents: ["docs/plan.md"],
      approval: { provenance: "skipped" },
    });
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain("approval/approve");
  });

  it("uses the default autonomous policy for a new plan", async () => {
    const result = await new WorkflowEngine({
      databasePath: await makeStateDatabasePath("plan-change-auto"),
      executor: planningExecutor({ summary: "plan", steps: ["one"] }),
    }).run(planChangeWorkflow, { task: "change the implementation" });
    expect(result.state.status).toBe("waiting");
    const request = result.state.finalOutput as HumanDecisionRequest;
    expect(request).toMatchObject({
      audience: "operator",
      defaultResponse: { choice: "continue" },
    });
    expect(Date.parse(request.expiresAt ?? "") - Date.parse(request.createdAt)).toBe(600_000);
  });

  it("blocks an unchanged plan before documentation or approval", async () => {
    const plan = { summary: "same", steps: ["one"] };
    const result = await new WorkflowEngine({
      databasePath: await makeStateDatabasePath("plan-change-unchanged"),
      executor: planningExecutor(plan),
    }).run(planChangeWorkflow, {
      task: "change the implementation",
      previousPlan: plan,
      approval: { mode: "required" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.finalOutput).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("same plan"),
    });
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain(
      "documentation/inspectDocumentation",
    );
    expect(result.state.steps.map((step) => step.nodeId)).not.toContain("approval/approve");
  });
});
