import { describe, expect, it } from "vitest";
import autodocWorkflow from "../src/builtins/autodoc.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    databasePath: await makeStateDatabasePath("builtin-autodoc"),
  }).run(autodocWorkflow, input);
}

describe("built-in autodoc", () => {
  it("rejects malformed input and agent contracts", async () => {
    const parse = autodocWorkflow.input;
    if (parse === undefined) throw new Error("missing autodoc input parser");
    expect(() => parse(null)).toThrow(/object/);
    expect(() => parse({ task: "" })).toThrow(/non-empty/);
    expect(() => parse({ task: "demo", documents: "bad" })).toThrow(/array/);

    const validate = async (nodeId: string, value: unknown) => {
      const node = autodocWorkflow.nodes[nodeId];
      if (node?.nodeType !== "agent" || node.validate === undefined) {
        throw new Error(`${nodeId} is not validated`);
      }
      return await node.validate(value, {
        input: { task: "demo", plan: {} },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
      } as never);
    };
    await expect(validate("locatePlan", { route: "other" })).rejects.toThrow(/route/);
    await expect(
      validate("locatePlan", { route: "found", sources: [], reason: "reason", evidence: null }),
    ).rejects.toThrow(/include the selected plan/);
    await expect(
      validate("locatePlan", {
        route: "blocked",
        sources: [3],
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/strings/);
    await expect(
      validate("inspectDocumentation", {
        route: "current",
        files: "bad",
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/array/);
    await expect(
      validate("inspectDocumentation", {
        route: "current",
        files: [],
        digests: { file: 3 },
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/values/);
    await expect(validate("updateDocumentation", { updated: false })).rejects.toThrow(/updated/);
    await expect(validate("verifyDocumentation", { passed: "yes" })).rejects.toThrow(/boolean/);
  });

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
