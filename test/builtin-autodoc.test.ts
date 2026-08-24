import { describe, expect, it } from "vitest";
import autodocWorkflow from "../src/builtins/autodoc.workflow.js";
import type { VerificationCheck } from "../src/builtins/change-verification.workflow.js";
import {
  PREPARED_WORKSPACE_SCHEMA,
  type PreparedWorkspace,
} from "../src/builtins/workspace-preparation.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    databasePath: await makeStateDatabasePath("builtin-autodoc"),
  }).run(autodocWorkflow, input);
}

async function prepared(): Promise<PreparedWorkspace> {
  const repository = await makeTempDir("autodoc-prepared");
  return {
    schema: PREPARED_WORKSPACE_SCHEMA,
    mode: "branch",
    repository,
    baseBranch: "main",
    baseRevision: "test-base",
    workBranch: "feat/docs",
    directDefaultBranchAuthorized: false,
    preExistingChangedPaths: [],
    evidence: ["prepared by test"],
    scope: `Only ${repository}`,
  };
}

function check(workspace: PreparedWorkspace, pass = true): VerificationCheck {
  return {
    id: "docs",
    command: process.execPath,
    args: ["-e", `process.exit(${pass ? 0 : 1})`],
    cwd: workspace.repository,
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    readOnly: true,
    baseEligible: false,
    changedFileScope: false,
    findingFormat: "text",
  };
}

describe("built-in autodoc", () => {
  it("rejects malformed input and agent contracts", async () => {
    const parse = autodocWorkflow.input;
    if (parse === undefined) throw new Error("missing autodoc input parser");
    expect(() => parse(null)).toThrow(/object/);
    expect(() => parse({ task: "" })).toThrow(/non-empty/);
    expect(() => parse({ task: "demo", documents: "bad" })).toThrow(/array/);
    expect(() => parse({ task: "demo", repository: "relative" })).toThrow(/absolute/);
    expect(() => parse({ task: "demo", workspaceMode: "legacy" })).toThrow(/workspaceMode/);

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
      validate("inspectDocumentation", {
        route: "current",
        files: "bad",
        reason: "reason",
        evidence: null,
      }),
    ).rejects.toThrow(/array/);
    await expect(validate("updateDocumentation", { updated: false })).rejects.toThrow(/updated/);
  });

  it("adopts current canonical documentation without preparing a workspace", async () => {
    const plan = { steps: ["one"] };
    const executor = new ScriptedExecutor().respond("inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/plans/plan.md"],
        digests: { "docs/plans/plan.md": "sha256:abc" },
        reason: "Current.",
        evidence: "digest checked",
      },
    });
    const { state } = await run(executor, { task: "implement feature", plan });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      plan,
      documentation: { state: "current" },
      verification: { route: "ready" },
    });
    expect(state.steps.some((step) => step.nodeId.startsWith("workspace/"))).toBe(false);
  });

  it("prepares, updates, and programmatically verifies stale documentation", async () => {
    const workspace = await prepared();
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
          digests: { "docs/spec.md": "sha256:new" },
          summary: "Recorded the selected plan.",
        },
      });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository: workspace.repository,
      preparedWorkspace: workspace,
      verificationChecks: [check(workspace)],
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      documentation: { state: "updated" },
      verification: { route: "ready", candidateCommands: { items: [{ id: "docs" }] } },
      workspace,
    });
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual([
      "inspectDocumentation",
      "updateDocumentation",
    ]);
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
          digests: {},
          reason: "Current.",
          evidence: "checked",
        },
      });
    const { state } = await run(executor, { task: "implement feature" });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "ready", plan });
  });

  it("preserves qualified verification evidence on the blocked exit", async () => {
    const workspace = await prepared();
    const executor = new ScriptedExecutor()
      .respond("inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/spec.md"],
          digests: {},
          reason: "Stale.",
          evidence: "old",
        },
      })
      .respond("updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/spec.md"],
          digests: {},
          summary: "Updated.",
        },
      })
      .respond("verification/semanticRepair", {
        output: { changedFiles: [], result: "No in-scope repair was available." },
      });
    const { state } = await run(executor, {
      task: "implement feature",
      plan: { steps: ["one"] },
      repository: workspace.repository,
      preparedWorkspace: workspace,
      verificationChecks: [check(workspace, false)],
    });
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      sourceNode: "autodoc/verification",
      evidence: {
        qualifiedNode: "autodoc/verification",
        relatedFailures: [{ checkId: "docs" }],
        repairAttempts: [{ kind: "semantic" }],
      },
    });
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
      sourceNode: "autodoc/locatePlan",
    });
  });
});
