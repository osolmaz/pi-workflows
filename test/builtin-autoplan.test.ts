import { describe, expect, it } from "vitest";
import autoplanWorkflow from "../src/builtins/autoplan.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

const ORIGINAL_USER_INSTRUCTIONS =
  "  Solve the complete demo request.\n\nKeep the queued requirement exactly.  ";

const proposal = {
  candidates: [
    {
      id: "public-extension",
      title: "Public extension",
      gist: "Use the supported extension point.",
      solution: "Add one extension adapter.",
      rationale: "It stays within authority.",
      parts: ["adapter"],
      tradeoffs: ["one local layer"],
    },
    {
      id: "local-wrapper",
      title: "Local wrapper",
      gist: "Wrap the current command locally.",
      solution: "Add a repository-owned wrapper.",
      rationale: "It avoids upstream changes.",
      parts: ["wrapper"],
      tradeoffs: ["more local code"],
    },
  ],
};

function commonExecutor(
  selection: Record<string, unknown>,
  options: { previousPlan?: boolean; summaryNode: string; summary: string },
) {
  return new ScriptedExecutor()
    .respond("captureIntent", {
      output: { originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS },
    })
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
    .respond("solutions", {
      output: {
        ...proposal,
        ...(options.previousPlan
          ? { previousPlan: { status: "rejected", reason: "new evidence invalidated it" } }
          : {}),
      },
    })
    .respond("holyGrail", {
      output: {
        ideal: "Upstream supports it directly.",
        outsideDependencies: ["upstream release"],
        additionalValue: ["less local code"],
      },
    })
    .respond("select", { output: selection })
    .respond(options.summaryNode, (request) => {
      expect(request.contract.completion).toBe("assistant");
      expect(request.contract).not.toHaveProperty("maxOutputChars");
      expect(request.prompt).not.toContain("Maximum characters:");
      expect(request.prompt).not.toContain("Maximum sentences:");
      expect(request.prompt).toContain("Required points:");
      expect(request.prompt).toContain("Use the supported extension point.");
      expect(request.prompt).toContain("Wrap the current command locally.");
      expect(request.prompt).toContain("Upstream supports it directly.");
      expect(request.prompt).toContain(JSON.stringify(ORIGINAL_USER_INSTRUCTIONS));
      if (options.previousPlan) {
        expect(request.prompt).toContain("old plan");
        expect(request.prompt).toContain("new evidence invalidated it");
      }
      return {
        output: options.summary,
        assistantMessage: { sha256: "a".repeat(64) },
      };
    });
}

const readySelection = {
  status: "ready",
  selectedId: "public-extension",
  why: "it stays in scope",
  relationshipToIdeal: "it can be removed after upstream support exists",
  rejected: [
    { id: "local-wrapper", reason: "it adds more local code" },
    { id: "ideal", reason: "it depends on an upstream release" },
  ],
  compromises: ["one local adapter"],
};

describe("built-in autoplan", () => {
  it("records all candidates and presents one plain selected-plan message", async () => {
    const previousPlan = { summary: "old plan" };
    const executor = commonExecutor(readySelection, {
      previousPlan: true,
      summaryNode: "readySummary/summarize",
      summary:
        "Use the public extension. Add and test one adapter. The local wrapper adds code; the ideal needs upstream work. This plan is selected for approval.",
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
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan"),
    });

    const { state } = await engine.run(autoplanWorkflow, {
      problem: "solve demo",
      previousPlan,
      newEvidence: { failure: "old plan failed" },
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "ready",
      originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS,
      changed: true,
      proposal: { candidates: [{ id: "public-extension" }, { id: "local-wrapper" }] },
      selection: {
        selectedId: "public-extension",
        rejected: [{ id: "local-wrapper" }, { id: "ideal" }],
      },
      plainSummary: { text: expect.stringContaining("selected for approval") },
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      previousPlanDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const prompts = new Map(
      executor.requests.map((request) => [request.contract.nodeId, request.prompt]),
    );
    expect(executor.requests[0]?.contract.nodeId).toBe("captureIntent");
    expect(prompts.get("captureIntent")).toContain(
      "Include everything that the user has instructed for the intended purpose in the given context.",
    );
    expect(prompts.get("captureIntent")).toContain(
      "Do not summarize, rewrite, explain, label, omit, or add instructions.",
    );
    expect(prompts.get("captureIntent")).toContain("Do not return an array or message objects.");
    expect(prompts.get("frame")).toContain("State the goal and describe what success looks like");
    expect(prompts.get("solutions")).toContain("Give two to four practical options");
    expect(prompts.get("solutions")).toContain("Long term elegant and production ready");
    expect(prompts.get("holyGrail")).toContain("Describe the Holy grail");
    expect(prompts.get("holyGrail")).toContain("Is this the Holy grail");
    expect(prompts.get("select")).toContain("Select one option");
    expect(prompts.get("select")).toContain("Long term elegant and production ready");
    expect(prompts.get("select")).toContain("Holy grail");
    expect(prompts.get("plan")).toContain("plan that another engineer can implement");
    for (const nodeId of ["frame", "solutions", "holyGrail", "select", "plan"]) {
      expect(prompts.get(nodeId)).toContain(ORIGINAL_USER_INSTRUCTIONS);
      expect(prompts.get(nodeId)).toContain("Continue in this Pi session");
    }
    expect([...prompts.values()].join("\n")).not.toMatch(
      /materially equivalent|implementation-ready/u,
    );
    expect(autoplanWorkflow.presentationPrompt).toBeUndefined();
    expect(
      executor.requests.filter((request) => request.contract.completion === "assistant"),
    ).toHaveLength(1);
  });

  it("does not cap the selected-plan summary by characters or sentences", async () => {
    const summary = `${"Sentence. ".repeat(16)}${"detail ".repeat(500)}`.trim();
    expect(summary.length).toBeGreaterThan(2_500);
    const executor = commonExecutor(readySelection, {
      summaryNode: "readySummary/summarize",
      summary,
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
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-unlimited-summary"),
    });

    const { state } = await engine.run(autoplanWorkflow, { problem: "solve demo" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ plainSummary: { text: summary } });
  });

  it("blocks only after recording and summarizing every considered option", async () => {
    const executor = commonExecutor(
      {
        status: "blocked",
        selectedId: "public-extension",
        why: "it is the closest option but cannot meet the required capability",
        relationshipToIdeal: "the ideal requires external authority",
        rejected: [
          { id: "local-wrapper", reason: "it cannot provide the missing interface" },
          { id: "ideal", reason: "it requires an unapproved upstream change" },
        ],
        compromises: [],
        blocker: "No public interface can meet the success criteria.",
      },
      {
        summaryNode: "blockedSummary/summarize",
        summary:
          "Planning is blocked because no public interface works. The public extension is closest; the wrapper lacks the interface, and the ideal needs upstream work.",
      },
    );
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-blocked"),
    });

    const { state } = await engine.run(autoplanWorkflow, { problem: "solve demo" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS,
      reason: "No public interface can meet the success criteria.",
      plainSummary: { text: expect.stringContaining("Planning is blocked") },
    });
    expect(state.steps.some((step) => step.nodeId === "plan")).toBe(false);
    expect(
      executor.requests.filter((request) => request.contract.completion === "assistant"),
    ).toHaveLength(1);
  });

  it("rejects invalid intent, candidate, and selection records", async () => {
    const badIntent = new ScriptedExecutor().respond("captureIntent", {
      output: { originalUserInstructions: ["demo"] },
    });
    const intentEngine = new WorkflowEngine({
      executor: badIntent,
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-bad-intent"),
    });
    expect((await intentEngine.run(autoplanWorkflow, { problem: "demo" })).state.error).toMatch(
      /originalUserInstructions must be a non-empty string/,
    );

    const emptyIntent = new ScriptedExecutor().respond("captureIntent", {
      output: { originalUserInstructions: " \n\t " },
    });
    const emptyIntentEngine = new WorkflowEngine({
      executor: emptyIntent,
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-empty-intent"),
    });
    expect(
      (await emptyIntentEngine.run(autoplanWorkflow, { problem: "demo" })).state.error,
    ).toMatch(/originalUserInstructions must be a non-empty string/);

    const badProposal = new ScriptedExecutor()
      .respond("captureIntent", {
        output: { originalUserInstructions: ORIGINAL_USER_INSTRUCTIONS },
      })
      .respond("frame", {
        output: {
          problem: "demo",
          success: [],
          inScope: [],
          outOfScope: [],
          constraints: [],
          controlBoundary: "repo",
        },
      })
      .respond("solutions", { output: { candidates: [proposal.candidates[0]] } });
    const proposalEngine = new WorkflowEngine({
      executor: badProposal,
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-bad-proposal"),
    });
    expect((await proposalEngine.run(autoplanWorkflow, { problem: "demo" })).state.error).toMatch(
      /two through four candidates/,
    );

    const badSelection = commonExecutor(
      { ...readySelection, rejected: [{ id: "local-wrapper", reason: "more code" }] },
      { summaryNode: "readySummary/summarize", summary: "unused" },
    );
    const selectionEngine = new WorkflowEngine({
      executor: badSelection,
      databasePath: await makeStateDatabasePath("pi-workflows-autoplan-bad-selection"),
    });
    expect((await selectionEngine.run(autoplanWorkflow, { problem: "demo" })).state.error).toMatch(
      /reject every non-selected candidate/,
    );
  });
});
