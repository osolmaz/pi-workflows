import { describe, expect, it } from "vitest";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
    approval: { mode: "skip" as const },
  };
}

function blockedImplementation(executor: ScriptedExecutor): ScriptedExecutor {
  return executor
    .respond("implement", {
      output: {
        status: "blocked",
        summary: "stop after startup test",
        files: [],
        issueKind: null,
        evidence: "test boundary",
      },
    })
    .respond("classifyImplementation", {
      output: { route: "blocked", summary: "test boundary", evidence: "done" },
    })
    .respond("challengeBlocker", {
      output: {
        route: "blocked",
        blockingNow: true,
        outsideAuthority: true,
        canProceed: false,
        reason: "The startup test intentionally stops here.",
        nextAction: "",
        nextStage: null,
        alternativesChecked: ["Continue beyond the startup boundary"],
        evidence: ["The test does not authorize later stages"],
      },
    });
}

async function run(executor: ScriptedExecutor, input: unknown) {
  const repository = await makeTempDir("autoimplement-plan-discovery-repo");
  const request = input as Record<string, unknown>;
  return await new WorkflowEngine({
    executor,
    databasePath: await makeStateDatabasePath("autoimplement-plan-discovery"),
  }).run(autoimplementWorkflow, {
    ...request,
    repository,
    preparedWorkspace: {
      schema: "pi-workflows.prepared-workspace.v1",
      mode: "branch",
      repository,
      baseBranch: "main",
      baseRevision: "test-base",
      workBranch: "feat/test",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: ["test fixture"],
      scope: `Only ${repository}`,
    },
    verificationChecks: [
      {
        id: "verify",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: repository,
        timeoutMs: 10_000,
        maxOutputChars: 100_000,
        readOnly: true,
        baseEligible: false,
        changedFileScope: false,
        findingFormat: "text",
      },
    ],
  });
}

describe("autoimplement existing-plan startup", () => {
  it("uses a current plan from context without initial autoplan or autodoc", async () => {
    const plan = { summary: "existing", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor().respond("findPlan", {
        output: {
          route: "found",
          plan,
          documentation: "current",
          documents: ["docs/plans/plan.md"],
          reason: "The conversation has one clear current plan.",
          evidence: "context",
        },
      }),
    );
    const { state } = await run(executor, { task: "implement existing plan" });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).toContain("findPlan");
    expect(steps).toContain("implement");
    expect(steps.some((step) => step.startsWith("redesign/"))).toBe(false);
    expect(steps.some((step) => step.startsWith("documentation/"))).toBe(false);
  });

  it("runs standalone autodoc for an undocumented existing plan", async () => {
    const plan = { summary: "existing", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor()
        .respond("findPlan", {
          output: {
            route: "found",
            plan,
            documentation: "stale",
            documents: ["docs/spec.md", "docs/plans/plan.md"],
            reason: "The implementation plan is stale.",
            evidence: "digest changed",
          },
        })
        .respond("documentation/inspectDocumentation", {
          output: {
            route: "update",
            files: ["docs/spec.md", "docs/plans/plan.md"],
            reason: "The documents are stale.",
            evidence: "digest changed",
          },
        })
        .respond("documentation/updateDocumentation", {
          output: {
            updated: true,
            files: ["docs/spec.md", "docs/plans/plan.md"],
            summary: "Recorded the selected plan.",
          },
        })
        .respond("documentation/verifyDocumentation", {
          output: { passed: true, commands: [], failures: [] },
        }),
    );
    const { state } = await run(executor, { task: "implement existing plan" });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).toContain("documentation/updateDocumentation");
    expect(steps.some((step) => step.startsWith("redesign/"))).toBe(false);
    expect(steps.indexOf("documentation/finalize")).toBeLessThan(steps.indexOf("implement"));
  });

  it("blocks instead of devising when no clear plan exists", async () => {
    const executor = new ScriptedExecutor()
      .respond("findPlan", {
        output: {
          route: "blocked",
          documents: [],
          reason: "No clear selected plan exists.",
          evidence: null,
        },
      })
      .respond("challengeBlocker", {
        output: {
          route: "blocked",
          blockingNow: true,
          outsideAuthority: true,
          canProceed: false,
          reason: "No existing plan can be adopted.",
          nextAction: "",
          nextStage: null,
          alternativesChecked: ["Search referenced canonical documents"],
          evidence: ["No selected plan exists"],
        },
      });
    const { state } = await run(executor, { task: "implement something" });
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "No clear selected plan exists.",
    });
    expect(state.steps.some((step) => step.nodeId.startsWith("redesign/"))).toBe(false);
    expect(state.steps.some((step) => step.nodeId === "implement")).toBe(false);
  });

  it("lets an explicit documented plan bypass discovery and autodoc", async () => {
    const executor = blockedImplementation(new ScriptedExecutor());
    const plan = { summary: "explicit", steps: ["implement"] };
    const { state } = await run(executor, {
      task: "implement explicit plan",
      ...documentedPlan(plan),
    });
    const steps = state.steps.map((step) => step.nodeId);
    expect(steps).not.toContain("findPlan");
    expect(steps.some((step) => step.startsWith("documentation/"))).toBe(false);
    expect(steps[0]).toBe("prepare");
    expect(steps).toContain("implement");
  });

  it("inspects documentation when an explicit plan has no current-document evidence", async () => {
    const plan = { summary: "explicit", steps: ["implement"] };
    const executor = blockedImplementation(
      new ScriptedExecutor().respond("documentation/inspectDocumentation", {
        output: {
          route: "current",
          files: ["docs/plans/plan.md"],
          digests: { "docs/plans/plan.md": `sha256:${"a".repeat(64)}` },
          reason: "The canonical plan is current.",
          evidence: "checked",
        },
      }),
    );
    const { state } = await run(executor, {
      task: "implement explicit plan",
      plan,
    });
    expect(state.steps.map((step) => step.nodeId)).toContain("documentation/inspectDocumentation");
    expect(state.steps.some((step) => step.nodeId.startsWith("redesign/"))).toBe(false);
  });

  it("does not gate an existing plan even when later plan changes require approval", async () => {
    const executor = blockedImplementation(new ScriptedExecutor());
    const plan = { summary: "explicit", steps: ["implement"] };
    const { state } = await run(executor, {
      task: "implement selected plan",
      ...documentedPlan(plan),
      approval: { mode: "required" },
    });
    expect(state.steps.some((step) => step.nodeId === "implement")).toBe(true);
    expect(state.steps.some((step) => step.nodeId.includes("approval/approve"))).toBe(false);
  });

  it("documents every evidence-driven redesign before implementation resumes", async () => {
    const revised = { summary: "revised", steps: ["change approach"] };
    const executor = new ScriptedExecutor()
      .respond(
        "implement",
        {
          output: {
            status: "issue",
            summary: "new design evidence",
            files: [],
            issueKind: "design",
            evidence: "API cannot support old plan",
          },
        },
        {
          output: {
            status: "blocked",
            summary: "stop after redesign test",
            files: [],
            issueKind: null,
            evidence: "done",
          },
        },
      )
      .respond(
        "classifyImplementation",
        {
          output: {
            route: "redesign",
            summary: "The API evidence invalidates the plan.",
            evidence: "API cannot support old plan",
          },
        },
        { output: { route: "blocked", summary: "done", evidence: "done" } },
      )
      .respond("redesign/design/frame", {
        output: {
          problem: "API mismatch",
          success: ["works"],
          inScope: ["repository"],
          outOfScope: [],
          constraints: [],
          controlBoundary: "repository",
        },
      })
      .respond("redesign/design/propose", {
        output: {
          candidates: [
            {
              id: "revised",
              title: "Revised",
              gist: "Use the revised plan.",
              solution: "revised",
              rationale: "in scope",
              parts: ["code"],
              tradeoffs: [],
            },
            {
              id: "rewrite",
              title: "Rewrite",
              gist: "Rewrite the feature.",
              solution: "rewrite",
              rationale: "possible",
              parts: ["rewrite"],
              tradeoffs: ["larger"],
            },
          ],
          previousPlan: { status: "rejected", reason: "API evidence invalidated it" },
        },
      })
      .respond("redesign/design/ideal", {
        output: { ideal: "revised", outsideDependencies: [], additionalValue: [] },
      })
      .respond("redesign/design/choose", {
        output: {
          status: "ready",
          selectedId: "revised",
          why: "in scope",
          relationshipToIdeal: "same",
          rejected: [
            { id: "rewrite", reason: "larger than needed" },
            { id: "ideal", reason: "the revised plan reaches it" },
          ],
          compromises: [],
        },
      })
      .respond("redesign/design/plan", { output: revised })
      .respond("redesign/design/readySummary/summarize", () => ({
        output: "Use the revised plan. The rewrite and ideal add no value.",
        assistantMessage: { sha256: "a".repeat(64) },
      }))
      .respond("redesign/documentation/inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/plans/plan.md"],
          reason: "The plan changed.",
          evidence: "new plan digest",
        },
      })
      .respond("redesign/documentation/updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/plans/plan.md"],
          summary: "Recorded the revised plan.",
        },
      })
      .respond("redesign/documentation/verifyDocumentation", {
        output: { passed: true, commands: [], failures: [] },
      });
    const oldPlan = { summary: "old", steps: ["old"] };
    const { state } = await run(executor, {
      task: "implement and redesign",
      ...documentedPlan(oldPlan),
    });
    const steps = state.steps.map((step) => step.nodeId);
    const redesigned = steps.indexOf("redesign/design/plan");
    const documented = steps.indexOf("redesign/documentation/finalize");
    const implementations = steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step === "implement");
    expect(redesigned).toBeGreaterThanOrEqual(0);
    expect(documented).toBeGreaterThan(redesigned);
    expect(implementations[1]?.index).toBeGreaterThan(documented);
    const implementationRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "implement",
    );
    expect(implementationRequests[1]?.prompt).toContain(JSON.stringify(revised));
    expect(implementationRequests[1]?.prompt).not.toContain(
      JSON.stringify({ summary: "old", steps: ["old"] }),
    );
  });
});
