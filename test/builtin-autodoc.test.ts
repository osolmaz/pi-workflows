import { describe, expect, it } from "vitest";
import autodocWorkflow from "../src/builtins/autodoc.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    outputRoot: await makeTempDir("builtin-autodoc"),
  }).run(autodocWorkflow, input);
}

describe("built-in autodoc", () => {
  it("adopts current canonical documentation without a write step", async () => {
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "The selected plan is already complete.",
        evidence: "checked",
      },
    });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
    });
    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).not.toContain("updateDocumentation");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "current" },
    });
  });

  it("updates and verifies stale documentation", async () => {
    const executor = new ScriptedExecutor()
      .respond("inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/spec.md", "docs/plans/plan.md"],
          reason: "The plan changed.",
          evidence: "stale digest",
        },
      })
      .respond("updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/spec.md", "docs/plans/plan.md"],
          summary: "Recorded the selected plan.",
        },
      })
      .respond("verifyDocumentation", {
        output: {
          passed: true,
          commands: [{ command: "docs-check", outcome: "passed" }],
          failures: [],
        },
      });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "updated" },
      verification: { passed: true },
    });
  });

  it("finds an existing plan from context without devising one", async () => {
    const plan = { summary: "existing plan", steps: ["one"] };
    const executor = new ScriptedExecutor()
      .respond("locatePlan", {
        output: {
          route: "found",
          plan,
          sources: ["conversation"],
          reason: "One clear plan is present.",
          evidence: "current context",
        },
      })
      .respond("inspectDocumentation", {
        output: {
          route: "current",
          files: ["docs/plans/plan.md"],
          reason: "Current.",
          evidence: "checked",
        },
      });
    const { state } = await run(executor, { task: "implement feature" });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "ready", plan });
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "locatePlan",
      "inspectDocumentation",
    ]);
  });

  it("blocks when no selected plan exists", async () => {
    const executor = new ScriptedExecutor().respond("locatePlan", {
      output: {
        route: "blocked",
        sources: [],
        reason: "No clear selected plan exists.",
        evidence: null,
      },
    });
    const { state } = await run(executor, { task: "implement feature" });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "No clear selected plan exists.",
    });
  });
});
