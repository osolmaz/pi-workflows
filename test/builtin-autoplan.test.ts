import { describe, expect, it } from "vitest";
import autoplanWorkflow from "../src/builtins/autoplan.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

function commonExecutor(selection: Record<string, unknown>) {
  return new ScriptedExecutor()
    .respond("frame", {
      output: {
        problem: "demo",
        success: ["tests pass"],
        inScope: ["current repository"],
        outOfScope: ["upstream library"],
        constraints: [],
        controlBoundary: "current repository",
      },
    })
    .respond("propose", {
      output: {
        solution: "use the public extension point",
        rationale: "owned and maintainable",
        parts: ["adapter"],
        tradeoffs: ["one local layer"],
      },
    })
    .respond("ideal", {
      output: {
        ideal: "upstream supports it directly",
        outsideDependencies: ["upstream release"],
        additionalValue: ["less local code"],
      },
    })
    .respond("choose", { output: selection });
}

describe("built-in autoplan", () => {
  it("selects a practical plan and records plan lineage", async () => {
    const previousPlan = { summary: "old plan" };
    const executor = commonExecutor({
      status: "ready",
      selected: "use the public extension point",
      why: "it stays in scope",
      relationshipToIdeal: "can be removed if upstream later supports it",
      excluded: ["upstream change"],
      compromises: ["local adapter"],
    }).respond("plan", {
      output: {
        summary: "add adapter",
        steps: [{ change: "add adapter", where: "src", verification: "tests" }],
        contracts: [],
        tests: ["unit test"],
        risks: [],
        boundaries: ["no upstream patch"],
      },
    });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoplan"),
    });

    const { state } = await engine.run(autoplanWorkflow, {
      problem: "solve demo",
      previousPlan,
      newEvidence: { failure: "old plan failed" },
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      changed: true,
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      previousPlanDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("blocks only when no in-scope solution exists", async () => {
    const executor = commonExecutor({
      status: "blocked",
      selected: "none",
      why: "the required interface is unavailable",
      relationshipToIdeal: "the ideal requires external authority",
      excluded: ["unapproved upstream change"],
      compromises: [],
      blocker: "No public interface can meet the success criteria.",
    });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoplan-blocked"),
    });

    const { state } = await engine.run(autoplanWorkflow, { problem: "solve demo" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "No public interface can meet the success criteria.",
    });
    expect(state.steps.some((step) => step.nodeId === "plan")).toBe(false);
  });
});
