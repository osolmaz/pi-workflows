import { describe, expect, it } from "vitest";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore, digest } from "../src/workflows/human-decision.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
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
    });
}

async function run(executor: ScriptedExecutor, input: unknown) {
  return await new WorkflowEngine({
    executor,
    outputRoot: await makeTempDir("autoimplement-plan-discovery"),
  }).run(autoimplementWorkflow, input);
}

describe("autoimplement existing-plan startup", () => {
  it("uses a current plan from context without initial autodevise or autodoc", async () => {
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
    const executor = new ScriptedExecutor().respond("findPlan", {
      output: {
        route: "blocked",
        documents: [],
        reason: "No clear selected plan exists.",
        evidence: null,
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

  it("uses optional plan approval before implementation", async () => {
    const executor = blockedImplementation(new ScriptedExecutor());
    const store = new WorkflowRunStore(await makeTempDir("autoimplement-approval"));
    const plan = { summary: "explicit", steps: ["implement"] };
    const first = await new WorkflowEngine({ executor, store }).run(autoimplementWorkflow, {
      task: "implement approved plan",
      ...documentedPlan(plan),
      approval: { audience: "operator", maxReplans: 3 },
    });
    expect(first.state.status).toBe("waiting");
    expect(first.state.waitingOn).toBe("approval/approve");
    expect(first.state.steps.some((step) => step.nodeId === "implement")).toBe(false);
    const request = first.state.finalOutput as HumanDecisionRequest;
    const accepted = await new HumanDecisionStore(store.outputRoot).accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
    });
    const continued = await new WorkflowEngine({ executor, store }).continueRun(
      autoimplementWorkflow,
      first.state.runId,
      {},
      { humanDecision: accepted.decision },
    );
    expect(continued.state.steps.some((step) => step.nodeId === "implement")).toBe(true);
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
      .respond("redesign/frame", {
        output: {
          problem: "API mismatch",
          success: ["works"],
          inScope: ["repository"],
          outOfScope: [],
          constraints: [],
          controlBoundary: "repository",
        },
      })
      .respond("redesign/propose", {
        output: { solution: "revised", rationale: "in scope", parts: ["code"], tradeoffs: [] },
      })
      .respond("redesign/ideal", {
        output: { ideal: "revised", outsideDependencies: [], additionalValue: [] },
      })
      .respond("redesign/choose", {
        output: {
          status: "ready",
          selected: "revised",
          why: "in scope",
          relationshipToIdeal: "same",
          excluded: [],
          compromises: [],
        },
      })
      .respond("redesign/plan", { output: revised })
      .respond("documentation/inspectDocumentation", {
        output: {
          route: "update",
          files: ["docs/plans/plan.md"],
          reason: "The plan changed.",
          evidence: "new plan digest",
        },
      })
      .respond("documentation/updateDocumentation", {
        output: {
          updated: true,
          files: ["docs/plans/plan.md"],
          summary: "Recorded the revised plan.",
        },
      })
      .respond("documentation/verifyDocumentation", {
        output: { passed: true, commands: [], failures: [] },
      });
    const oldPlan = { summary: "old", steps: ["old"] };
    const { state } = await run(executor, {
      task: "implement and redesign",
      ...documentedPlan(oldPlan),
    });
    const steps = state.steps.map((step) => step.nodeId);
    const redesigned = steps.indexOf("redesign/plan");
    const documented = steps.indexOf("documentation/finalize");
    const implementations = steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step === "implement");
    expect(redesigned).toBeGreaterThanOrEqual(0);
    expect(documented).toBeGreaterThan(redesigned);
    expect(implementations[1]?.index).toBeGreaterThan(documented);
  });
});
