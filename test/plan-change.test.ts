import { describe, expect, it } from "vitest";
import planChangeWorkflow from "../src/builtins/plan-change.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

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
        solution: "use the selected plan",
        rationale: "it is in scope",
        parts: ["implement"],
        tradeoffs: [],
      },
    })
    .respond("design/ideal", {
      output: { ideal: "complete", outsideDependencies: [], additionalValue: [] },
    })
    .respond("design/choose", {
      output: {
        status: "ready",
        selected: "use the selected plan",
        why: "it is practical",
        relationshipToIdeal: "same result",
        excluded: [],
        compromises: [],
      },
    })
    .respond("design/plan", { output: plan })
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
  it("uses the shared skip policy without creating a human decision", async () => {
    const result = await new WorkflowEngine({
      outputRoot: await makeTempDir("plan-change-skip"),
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
      outputRoot: await makeTempDir("plan-change-auto"),
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
      outputRoot: await makeTempDir("plan-change-unchanged"),
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
