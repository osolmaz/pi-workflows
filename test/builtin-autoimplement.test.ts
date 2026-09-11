import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { compute, defineWorkflow } from "../src/workflows/index.js";
import {
  applyWorkflowSettingsPatch,
  resolveInitialWorkflowSettings,
} from "../src/workflows/settings.js";
import type { AgentStepRequest, AgentStepSubmission } from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor, waitUntil } from "./helpers.js";

const execFileAsync = promisify(execFile);
let originalPath = "";
let commandDir = "";
let repository = "";
let baseRevision = "";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function installCommand(name: string, body: string): Promise<void> {
  const target = path.join(commandDir, name);
  await fs.writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function reviewerCommand(cwd = repository) {
  return {
    command: "pi-reviewer",
    args: ["--base", "main"],
    cwd,
    timeoutMs: 600_000,
  };
}

function preparedWorkspaceFor(target = repository) {
  return {
    schema: "pi-workflows.prepared-workspace.v1" as const,
    mode: "branch" as const,
    repository: target,
    baseBranch: "main",
    baseRevision,
    workBranch: "feat/demo",
    directDefaultBranchAuthorized: false,
    preExistingChangedPaths: [],
    evidence: ["test fixture"],
    scope: `Only ${target}`,
  };
}

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
    approval: { mode: "skip" as const },
  };
}

function published(
  headRevision = "abc123",
  branch = "feat/demo",
  pr = "https://example.test/pr/1",
) {
  return {
    repositories: [
      {
        repository,
        branch,
        baseBranch: "main",
        headRevision,
        pr,
        pushed: true,
      },
    ],
  };
}

function autoimplementWithTimeout(nodeId: string, timeoutMs: number) {
  const node = autoimplementWorkflow.nodes[nodeId];
  if (node === undefined) throw new Error(`autoimplement node is missing: ${nodeId}`);
  return {
    ...autoimplementWorkflow,
    nodes: {
      ...autoimplementWorkflow.nodes,
      [nodeId]: { ...node, timeoutMs },
    },
  };
}

function cleanReview(headRevision = "abc123") {
  return {
    repositories: [
      {
        id: repositoryId(repository),
        invocationSucceeded: true,
        p0: [],
        p1: [],
        p2: [],
        lower: [],
        reason: `No findings for ${headRevision}.`,
      },
    ],
    reason: "No P0, P1, or P2 findings.",
  };
}

function ciInspection(
  route: "green" | "failed" | "pending" | "unavailable",
  headRevision = "abc123",
  pr = "https://example.test/pr/1",
) {
  return {
    targets: [
      {
        repository,
        headRevision,
        pr,
        route,
        reason: route,
        relatedFailures: [],
        unrelatedFailures: [],
        ...(route === "pending"
          ? {
              trackingCommand: {
                id: repositoryId(repository),
                command: "gh",
                args: ["pr", "checks", "--watch"],
                cwd: repository,
                timeoutMs: 300_000,
                maxOutputChars: 1_000_000,
              },
            }
          : {}),
      },
    ],
  };
}

function controlDecision(route: string, reason = `Choose ${route}.`): AgentStepSubmission {
  const complete = route === "complete";
  const blocked = route === "blocked";
  return {
    output: {
      route,
      goalMet: complete,
      blockingNow: blocked,
      outsideAuthority: blocked,
      canProceed: !complete && !blocked,
      reason,
      nextAction: complete || blocked ? "" : `Run the ${route} branch.`,
      alternativesChecked: blocked ? ["No safe continuing route remains"] : [],
      evidence: [`Current evidence supports ${route}.`],
    },
  };
}

function chooseFirstControlRoute(request: AgentStepRequest): AgentStepSubmission {
  const match = /Observation: (.+)\nRecent attempts:/.exec(request.prompt);
  if (match?.[1] === undefined)
    throw new Error("Autoimplement controller prompt lacks observation");
  const observation = JSON.parse(match[1]) as { availableRoutes: string[] };
  const route = observation.availableRoutes[0];
  if (route === undefined) throw new Error("Autoimplement controller has no available route");
  return controlDecision(route, `Choose ${route} from the current evidence.`);
}

function summaryExecutor(): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("completedSummary", () => ({
      output: "The approved work is complete. Validation passed.",
      assistantMessage: { sha256: "a".repeat(64) },
    }))
    .respond("blockedSummary", () => ({
      output: "Work stopped at the recorded blocker.",
      assistantMessage: { sha256: "b".repeat(64) },
    }));
}

function verificationPlan(id = "verify") {
  return {
    checks: [
      {
        id,
        command: process.execPath,
        args: ["-e", "process.stdout.write('passed')"],
        cwd: repository,
        timeoutMs: 60_000,
        maxOutputChars: 100_000,
        readOnly: true,
        baseEligible: true,
        changedFileScope: false,
        findingFormat: "text",
      },
    ],
    untested: [],
  };
}

function commonExecutor(
  publication: unknown = published(),
  decide: (request: AgentStepRequest) => AgentStepSubmission = chooseFirstControlRoute,
): ScriptedExecutor {
  return summaryExecutor()
    .respond("decide", decide)
    .respond("implement", {
      output: {
        status: "implemented",
        summary: "implemented",
        files: ["src/change.ts"],
        issueKind: null,
        evidence: "complete",
      },
    })
    .respond("classifyImplementation", {
      output: { route: "verify", summary: "ready", evidence: "implementation complete" },
    })
    .respond("localVerification/planChecks", { output: verificationPlan() })
    .respond("verify", {
      output: {
        passed: true,
        commands: [{ command: "node verification", outcome: "passed" }],
        failures: [],
        untested: [],
      },
    })
    .respond("classifyVerification", {
      output: { route: "publish", summary: "checks passed", evidence: "npm test" },
    })
    .respond("publish", { output: publication });
}

function addRedesignResponses(executor: ScriptedExecutor, plans: unknown[]): ScriptedExecutor {
  return executor
    .respond(
      "redesign/design/captureIntent",
      ...plans.map(() => ({
        output: { originalUserInstructions: "finish the task" },
      })),
    )
    .respond("redesign/design/frame", {
      output: {
        problem: "finish the task",
        success: ["work completes"],
        inScope: ["repository and authorized rollout"],
        outOfScope: ["unapproved remote mutation"],
        constraints: [],
        controlBoundary: "authorized repository and rollout",
      },
    })
    .respond("redesign/design/solutions", {
      output: {
        candidates: [
          {
            id: "supported-path",
            title: "Supported path",
            gist: "Use the supported path.",
            solution: "use the supported path",
            rationale: "it is authorized",
            parts: ["adjust plan", "verify"],
            tradeoffs: [],
          },
          {
            id: "larger-path",
            title: "Larger path",
            gist: "Use a larger replacement.",
            solution: "use a larger replacement",
            rationale: "it can work",
            parts: ["replace"],
            tradeoffs: ["larger"],
          },
        ],
        previousPlan: { status: "rejected", reason: "new evidence invalidated it" },
      },
    })
    .respond("redesign/design/holyGrail", {
      output: { ideal: "completed work", outsideDependencies: [], additionalValue: [] },
    })
    .respond("redesign/design/select", {
      output: {
        status: "ready",
        selectedId: "supported-path",
        why: "it completes in scope",
        relationshipToIdeal: "same result",
        rejected: [
          { id: "larger-path", reason: "larger than needed" },
          { id: "ideal", reason: "the supported path reaches it" },
        ],
        compromises: [],
      },
    })
    .respond("redesign/design/plan", ...plans.map((plan) => ({ output: plan })))
    .respond(
      "redesign/design/readySummary/summarize",
      ...plans.map(() => () => ({
        output: "Use the supported path. The larger and ideal options add no value.",
        assistantMessage: { sha256: "a".repeat(64) },
      })),
    )
    .respond("redesign/documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/WORKFLOWS.md"],
        digests: {},
        reason: "The revised plan is documented.",
        evidence: "checked",
      },
    });
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  commandDir = await makeTempDir("pi-workflows-commands");
  repository = await makeTempDir("pi-workflows-autoimplement-repo");
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repository, "README.md"), "fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "fixture"]);
  baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "-c", "feat/demo"]);
  await installCommand("pi-reviewer", "printf '%s\\n' \"review complete\"");
  await installCommand("gh", "printf '%s\\n' \"checks complete\"");
  process.env.PATH = `${commandDir}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("built-in autoimplement", () => {
  it("preserves the prepared result when its explicit summary fails", async () => {
    const result = { status: "completed", summary: "Accepted work", validation: ["npm test"] };
    const executor = new ScriptedExecutor().respond("completedSummary", {
      error: "Provider unavailable",
    });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-summary-failure"),
    });
    const workflow = defineWorkflow({
      name: "summary-failure",
      startAt: "prepareCompleted",
      nodes: {
        prepareCompleted: compute({ run: () => result }),
        completedSummary: autoimplementWorkflow.nodes.completedSummary,
        finalize: autoimplementWorkflow.nodes.finalize,
      },
      edges: [
        { from: "prepareCompleted", to: "completedSummary" },
        { from: "completedSummary", to: "finalize" },
      ],
    });
    const { state } = await engine.run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.outputs.prepareCompleted).toEqual(result);
    expect(state.steps.map((step) => [step.nodeId, step.outcome])).toEqual([
      ["prepareCompleted", "ok"],
      ["completedSummary", "failed"],
    ]);
    expect(executor.requests).toHaveLength(1);
  });
  it("allows a model to disable merge but not grant merge authority", async () => {
    const definition = autoimplementWorkflow.settings;
    if (definition === undefined) throw new Error("autoimplement settings are missing");
    await expect(
      resolveInitialWorkflowSettings(definition, {
        task: "demo",
        repository: "/tmp/demo",
        merge: true,
      }),
    ).resolves.toMatchObject({ settings: { merge: true, addedInstructions: [] } });
    await expect(
      applyWorkflowSettingsPatch(
        definition,
        { merge: true, addedInstructions: [] },
        [{ op: "replace", path: "/merge", value: false }],
        { type: "session" },
        "workflow-tool",
      ),
    ).resolves.toMatchObject({ settings: { merge: false } });
    await expect(
      applyWorkflowSettingsPatch(
        definition,
        { merge: false, addedInstructions: [] },
        [{ op: "replace", path: "/merge", value: true }],
        { type: "session" },
        "workflow-tool",
      ),
    ).rejects.toThrow(/cannot grant merge authority/);
  });

  it("validates input, reviewer severities, repair commands, and CI tracking", async () => {
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
    expect(() => parseInput({ task: "demo" })).toThrow(/repository/);
    expect(() => parseInput({ task: "demo", repository: "relative" })).toThrow(/absolute/);
    expect(
      await parseInput({
        task: "demo",
        plan: {},
        scope: "repo",
        constraints: ["keep API"],
        repository,
        baseBranch: "main",
        workspaceMode: "auto",
        merge: false,
      }),
    ).toMatchObject({
      task: "demo",
      scope: "repo",
      workspaceMode: "auto",
      merge: false,
      approval: { mode: "auto" },
    });
    expect(() => parseInput(null)).toThrow("object");
    expect(() => parseInput({ task: "" })).toThrow("non-empty");
    expect(() => parseInput({ task: "demo", constraints: "bad" })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", constraints: [3] })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", merge: "yes" })).toThrow("boolean");
    expect(() => parseInput({ task: "demo", repository, verificationChecks: [] })).toThrow(
      "non-empty",
    );
    expect(() =>
      parseInput({ task: "demo", repository, verificationUntested: ["browser tests"] }),
    ).toThrow("requires verificationChecks");
    expect(() =>
      parseInput({
        task: "demo",
        repository,
        verificationChecks: verificationPlan().checks,
        verificationUntested: [""],
      }),
    ).toThrow("non-empty");
    expect(
      parseInput({
        task: "demo",
        repository,
        verificationChecks: verificationPlan().checks,
        verificationUntested: ["remote browser tests"],
      }),
    ).toMatchObject({ verificationUntested: ["remote browser tests"] });
    expect(() =>
      parseInput({
        task: "demo",
        documentation: { status: "current", planDigest: digest({}), documents: [] },
      }),
    ).toThrow("requires an explicit plan");
    expect(() =>
      parseInput({
        task: "demo",
        plan: {},
        documentation: { status: "current", planDigest: "sha256:wrong", documents: [] },
      }),
    ).toThrow("does not match");

    const validate = async (
      nodeId: string,
      output: unknown,
      overrides: Record<string, unknown> = {},
    ) => {
      const node = autoimplementWorkflow.nodes[nodeId];
      if (node?.nodeType !== "agent" || node.validate === undefined) {
        throw new Error(`${nodeId} must be a validated agent node`);
      }
      return await node.validate(output, {
        input: { task: "demo", plan: {}, repository, preparedWorkspace: preparedWorkspaceFor() },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
      } as never);
    };

    const normalizedPublished = {
      id: repositoryId(repository),
      repository,
      branch: "feat/demo",
      baseBranch: "main",
      headRevision: "abc123",
      pr: "https://example.test/pr/1",
    };
    const preparedWorktree = path.join(repository, "prepared-worktree");
    const worktreeWorkspace = {
      ...preparedWorkspaceFor(),
      mode: "worktree" as const,
      worktreePath: preparedWorktree,
    };
    const publicationRecord = published().repositories[0]!;
    await expect(
      validate("publish", {
        repositories: [
          publicationRecord,
          {
            ...publicationRecord,
            repository: path.join(repository, "unprepared"),
            pr: "https://example.test/pr/2",
          },
        ],
      }),
    ).rejects.toThrow("cannot include an unprepared repository");
    await expect(
      validate("publish", published(), {
        input: {
          task: "demo",
          plan: {},
          repository,
          preparedWorkspace: worktreeWorkspace,
        },
      }),
    ).rejects.toThrow("must match the prepared workspace");
    await expect(
      validate(
        "publish",
        {
          repositories: [{ ...publicationRecord, repository: preparedWorktree }],
        },
        {
          input: {
            task: "demo",
            plan: {},
            repository,
            preparedWorkspace: worktreeWorkspace,
          },
        },
      ),
    ).resolves.toMatchObject({ repositories: [{ repository: preparedWorktree }] });
    await expect(
      validate(
        "publish",
        {
          repositories: [
            { ...publicationRecord, repository: preparedWorktree },
            { ...publicationRecord, repository, pr: "https://example.test/pr/2" },
          ],
        },
        {
          input: {
            task: "demo",
            plan: {},
            repository,
            preparedWorkspace: worktreeWorkspace,
          },
        },
      ),
    ).rejects.toThrow("cannot include an unprepared repository");

    const reviewSelection = {
      route: "run",
      repositories: [normalizedPublished],
      commands: [reviewerCommand()],
    };
    const reviewContext = {
      outputs: { selectReviewCommands: reviewSelection },
      state: { steps: [{ nodeId: "selectReviewCommands", output: reviewSelection }] },
    };
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: true,
              p0: [{ kind: "design", summary: "P0 design" }],
              p1: [{ kind: "implementation", summary: "P1 code" }],
              p2: [{ kind: "implementation", summary: "P2 code" }],
              lower: [{ kind: "implementation", summary: "lower" }],
              reason: "findings",
            },
          ],
          reason: "findings",
        },
        reviewContext,
      ),
    ).resolves.toMatchObject({ route: "critical", p0: [{ severity: "P0" }] });
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: false,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "invalid invocation",
            },
          ],
          reason: "invalid invocation",
        },
        reviewContext,
      ),
    ).resolves.toMatchObject({ route: "command_error" });
    await expect(
      validate("assessReview", { repositories: "bad", reason: "bad" }, reviewContext),
    ).rejects.toThrow("must be an array");
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: "unexpected",
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [],
              lower: [],
              reason: "bad",
            },
          ],
          reason: "bad",
        },
        reviewContext,
      ),
    ).rejects.toThrow("was not in the batch");
    await expect(
      validate(
        "assessReview",
        {
          repositories: [
            {
              id: normalizedPublished.id,
              invocationSucceeded: true,
              p0: "bad",
              p1: [],
              p2: [],
              lower: [],
              reason: "bad",
            },
          ],
          reason: "bad",
        },
        reviewContext,
      ),
    ).rejects.toThrow("p0 must be an array");
    await expect(
      validate("assessReview", { repositories: [], reason: "bad" }, reviewContext),
    ).rejects.toThrow("missing repository ids");

    const selectReview = autoimplementWorkflow.nodes.selectReviewCommands;
    if (selectReview?.nodeType !== "compute") {
      throw new Error("selectReviewCommands must be a compute node");
    }
    const reviewedRepository = {
      ...normalizedPublished,
      invocationSucceeded: true,
    };
    const reviewSelectionContext = (overrides: Record<string, unknown>) =>
      ({
        input: { task: "demo", plan: {} },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
      }) as never;
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [normalizedPublished] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: { repositories: [reviewedRepository] },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "reuse", repositories: [] });
    expect(
      await selectReview.run(
        reviewSelectionContext({
          outputs: { publish: { repositories: [normalizedPublished] } },
          state: {
            steps: [
              {
                nodeId: "assessReview",
                outcome: "ok",
                output: {
                  repositories: [{ ...reviewedRepository, invocationSucceeded: false }],
                },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ route: "run", repositories: [normalizedPublished] });

    await expect(
      validate("repairReviewCommand", { route: "blocked", reason: "reviewer missing" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("repairCiCommand", { route: "blocked", reason: "CI unavailable" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("inspectCi", ciInspection("pending"), {
        outputs: { publish: { repositories: [normalizedPublished] } },
      }),
    ).resolves.toMatchObject({ route: "pending", targets: [{ route: "pending" }] });
    await expect(
      validate(
        "inspectCi",
        { targets: [{ repository, route: "pending" }] },
        {
          outputs: { publish: { repositories: [normalizedPublished] } },
        },
      ),
    ).rejects.toThrow();
    await expect(
      validate("inspectCi", ciInspection("green", "wrong-head"), {
        outputs: { publish: { repositories: [normalizedPublished] } },
      }),
    ).rejects.toThrow("does not match the published repository and head");
    const additionalPublished = {
      ...normalizedPublished,
      id: repositoryId(path.join(repository, "additional")),
      repository: path.join(repository, "additional"),
      pr: "https://example.test/pr/additional",
    };
    await expect(
      validate("inspectCi", ciInspection("green"), {
        outputs: { publish: { repositories: [normalizedPublished, additionalPublished] } },
      }),
    ).rejects.toThrow("missing repository ids");

    const refreshedPublished = {
      ...normalizedPublished,
      headRevision: "def456",
    };
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).resolves.toMatchObject({ repositories: [{ headRevision: "def456" }] });
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          commands: [],
          pushed: true,
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("repositories");
    await expect(
      validate(
        "verifyP2",
        {
          passed: "yes",
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("passed must be a boolean");
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: false,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("pushed must be true");
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: true,
          repositories: [{ ...refreshedPublished, branch: "other", pushed: true }],
        },
        { outputs: { publish: { repositories: [normalizedPublished] } } },
      ),
    ).rejects.toThrow("does not match publication");
    const secondPublished = {
      ...normalizedPublished,
      id: repositoryId(path.join(repository, "second")),
      repository: path.join(repository, "second"),
      pr: "https://example.test/pr/2",
    };
    await expect(
      validate(
        "verifyP2",
        {
          passed: true,
          pushed: true,
          repositories: [{ ...refreshedPublished, pushed: true }],
        },
        {
          outputs: {
            publish: { repositories: [normalizedPublished, secondPublished] },
          },
        },
      ),
    ).rejects.toThrow("missing repository ids");

    const pendingInspection = ciInspection("pending");
    const trackedInspection = {
      ...pendingInspection,
      targets: pendingInspection.targets.map((target) => ({
        ...target,
        id: normalizedPublished.id,
      })),
    };
    const trackedContext = {
      outputs: {
        inspectCi: trackedInspection,
        trackCi: {
          route: "assess",
          batch: { items: [{ id: normalizedPublished.id }] },
        },
      },
    };
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("exactly cover watched ids");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [{ id: normalizedPublished.id, route: "pending", reason: "still pending" }],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("route must be pending");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "still pending",
          targets: [{ id: normalizedPublished.id, route: "pending", reason: "still pending" }],
          relatedFailures: [],
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).resolves.toMatchObject({ route: "pending", targets: [{ id: normalizedPublished.id }] });
    await expect(
      validate(
        "assessTrackedCi",
        { route: "pending", reason: "pending", targets: "bad" },
        trackedContext,
      ),
    ).rejects.toThrow("targets must be an array");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
          ],
        },
        trackedContext,
      ),
    ).rejects.toThrow("duplicated");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [{ id: "unexpected", route: "pending", reason: "pending" }],
        },
        trackedContext,
      ),
    ).rejects.toThrow("unexpected: unexpected");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [{ id: normalizedPublished.id, route: "unknown", reason: "unknown" }],
        },
        trackedContext,
      ),
    ).rejects.toThrow("route is invalid");
    for (const route of ["green", "failed", "unavailable"] as const) {
      await expect(
        validate(
          "assessTrackedCi",
          {
            route,
            reason: route,
            targets: [{ id: normalizedPublished.id, route, reason: route }],
          },
          trackedContext,
        ),
      ).resolves.toMatchObject({ route, relatedFailures: [], unrelatedFailures: [] });
    }
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "pending",
          reason: "pending",
          targets: [
            { id: normalizedPublished.id, route: "pending", reason: "pending" },
            { id: "unexpected", route: "pending", reason: "pending" },
          ],
        },
        trackedContext,
      ),
    ).rejects.toThrow("unexpected: unexpected");
    await expect(
      validate(
        "assessTrackedCi",
        {
          route: "green",
          reason: "green",
          targets: [{ id: normalizedPublished.id, route: "green", reason: "green" }],
          relatedFailures: "bad",
          unrelatedFailures: [],
        },
        trackedContext,
      ),
    ).rejects.toThrow("relatedFailures must be an array");

    await expect(
      validate("repairReviewCommand", { route: "unknown", reason: "bad" }),
    ).rejects.toThrow("one of retry, blocked");
    await expect(validate("repairCiCommand", { route: "unknown", reason: "bad" })).rejects.toThrow(
      "one of retry, blocked",
    );
    const observation = {
      decisionNumber: 2,
      decisionLimit: 40,
      consecutiveNoProgressAttempts: 0,
      progressFingerprint: "sha256:test",
      lastRoute: "implementation",
      latestAttempt: null,
      availableRoutes: ["repair", "blocked"],
    };
    await expect(
      validate(
        "decide",
        {
          route: "repair",
          goalMet: false,
          blockingNow: false,
          outsideAuthority: false,
          canProceed: true,
          reason: "The local issue can be fixed.",
          nextAction: "Repair the implementation.",
          alternativesChecked: [],
          evidence: ["The failure is local."],
        },
        { outputs: { observe: observation } },
      ),
    ).resolves.toMatchObject({ route: "repair", canProceed: true });
    await expect(
      validate(
        "decide",
        {
          route: "blocked",
          goalMet: false,
          blockingNow: true,
          outsideAuthority: true,
          canProceed: false,
          reason: "External authorization is required.",
          nextAction: "",
          alternativesChecked: ["Continue without the external action"],
          evidence: ["The required authorization is absent."],
        },
        { outputs: { observe: observation } },
      ),
    ).resolves.toMatchObject({ route: "blocked", outsideAuthority: true });
    await expect(
      validate(
        "decide",
        {
          route: "review",
          goalMet: false,
          blockingNow: false,
          outsideAuthority: false,
          canProceed: true,
          reason: "Review next.",
          nextAction: "Run review.",
          alternativesChecked: [],
          evidence: ["Verification passed."],
        },
        { outputs: { observe: observation } },
      ),
    ).rejects.toThrow("route review is not available");
    await expect(
      validate("inspectComments", { route: "unknown", summary: "bad", evidence: [] }),
    ).rejects.toThrow("route must be one of");
    await expect(
      validate("assessReview", {
        invocationSucceeded: true,
        p0: "bad",
        p1: [],
        p2: [],
        lower: [],
        reason: "bad",
      }),
    ).rejects.toThrow("must be an array");
  });

  it("uses supplied verification checks and preserves explicit untested work", async () => {
    const routes = ["implementation", "verification", "blocked"];
    let routeIndex = 0;
    const executor = commonExecutor(published(), () => {
      const route = routes[routeIndex++];
      if (route === undefined) throw new Error("unexpected controller visit");
      return controlDecision(route, `Choose ${route}.`);
    }).respond("localVerification/judge", {
      output: {
        route: "blocked",
        reason: "Remote browser evidence is missing.",
        evidence: ["Remote browser tests remain untested."],
      },
    });
    const checks = verificationPlan().checks;
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-supplied-verification"),
    });
    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
      verificationChecks: checks,
      verificationUntested: ["Remote browser tests remain untested."],
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "Choose blocked.",
    });
    expect(
      state.steps.find((step) => step.nodeId === "localVerification/blocked")?.output,
    ).toMatchObject({
      route: "blocked",
      untestedChecks: [{ summary: "Remote browser tests remain untested." }],
    });
    expect(
      executor.requests.some(
        (request) => request.contract.nodeId === "localVerification/planChecks",
      ),
    ).toBe(false);
  });

  it("uses one controller for all branch choices and returns", async () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const edge = (from: string) => compiled.edges.find((candidate) => candidate.from === from);
    const decide = autoimplementWorkflow.nodes.decide;
    const observe = autoimplementWorkflow.nodes.observe;
    expect(decide?.nodeType).toBe("agent");
    expect(observe?.nodeType).toBe("compute");
    expect(edge("dispatch")).toMatchObject({
      switch: {
        on: "$.route",
        cases: {
          planDiscovery: "findPlan",
          workspace: "workspace",
          documentation: "documentation",
          implementation: "implement",
          repair: "fix",
          verification: "localVerification",
          publication: "routeVerifiedWorkspace",
          review: "selectReviewCommands",
          addressP2: "addressP2",
          comments: "inspectComments",
          ci: "inspectCi",
          delivery: "finalizeDelivery",
          redesign: "redesign",
          complete: "prepareCompleted",
          blocked: "prepareBlocked",
        },
      },
    });
    expect(edge("classifyImplementation")).toMatchObject({ to: "observe" });
    expect(edge("localVerification/__piw_exit_ready")).toMatchObject({ to: "observe" });
    expect(edge("localVerification/__piw_exit_blocked")).toMatchObject({ to: "observe" });
    expect(edge("publicationResult")).toMatchObject({ to: "observe" });
    expect(edge("reviewResult")).toMatchObject({ to: "observe" });
    expect(edge("ciResult")).toMatchObject({ to: "observe" });
    expect(autoimplementWorkflow.nodes.timeoutFallback).toBeUndefined();
    expect(autoimplementWorkflow.nodes.challengeBlocker).toBeUndefined();

    if (observe?.nodeType !== "compute") throw new Error("observe must be compute");
    const input = {
      task: "demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    };
    expect(
      await Promise.resolve(
        observe.run({
          input,
          outputs: {},
          results: {},
          state: {
            steps: [{ nodeId: "prepare", outcome: "ok", output: { task: "demo", repository } }],
          },
          settings: { merge: false, addedInstructions: [] },
          signal: new AbortController().signal,
        } as never),
      ),
    ).toMatchObject({ availableRoutes: ["implementation", "redesign", "blocked"] });

    expect(
      await Promise.resolve(
        observe.run({
          input,
          outputs: {
            observe: {
              decisionNumber: 1,
              decisionLimit: 40,
              consecutiveRouteAttempts: 0,
              lastRoute: null,
              latestAttempt: null,
              availableRoutes: ["implementation", "redesign", "blocked"],
            },
          },
          results: {},
          state: {
            steps: [
              {
                nodeId: "decide",
                outcome: "ok",
                output: {
                  route: "implementation",
                  goalMet: false,
                  blockingNow: false,
                  outsideAuthority: false,
                  canProceed: true,
                  reason: "Implement next.",
                  nextAction: "Implement.",
                  alternativesChecked: [],
                  evidence: ["The plan is ready."],
                },
              },
              { nodeId: "implement", outcome: "timed_out", output: null, error: "deadline" },
            ],
          },
          settings: { merge: false, addedInstructions: [] },
          signal: new AbortController().signal,
        } as never),
      ),
    ).toMatchObject({
      latestAttempt: { nodeId: "implement", outcome: "timed_out" },
      availableRoutes: ["implementation", "repair", "redesign", "blocked"],
    });
  });

  it("returns a design issue to the controller and follows the redesign branch", async () => {
    const revisedPlan = { steps: ["use supported artifact"] };
    const executor = addRedesignResponses(
      summaryExecutor()
        .respond(
          "decide",
          controlDecision("implementation"),
          controlDecision("redesign"),
          controlDecision("implementation"),
          controlDecision("verification"),
          controlDecision("publication"),
          controlDecision("review"),
          controlDecision("comments"),
          controlDecision("ci"),
          controlDecision("delivery"),
          controlDecision("complete"),
        )
        .respond(
          "implement",
          {
            output: {
              status: "issue",
              summary: "The planned artifact is unavailable.",
              files: [],
              issueKind: "design",
              evidence: "The supported artifact differs.",
            },
          },
          {
            output: {
              status: "implemented",
              summary: "Implemented the supported path.",
              files: ["src/change.ts"],
              issueKind: null,
              evidence: "complete",
            },
          },
        )
        .respond(
          "classifyImplementation",
          {
            output: {
              route: "redesign",
              summary: "The plan needs the supported artifact.",
              evidence: "The planned artifact is unavailable.",
            },
          },
          {
            output: { route: "verify", summary: "ready", evidence: "implementation complete" },
          },
        )
        .respond("localVerification/planChecks", { output: verificationPlan() })
        .respond("verify", {
          output: {
            passed: true,
            commands: [{ command: "node verification", outcome: "passed" }],
            failures: [],
            untested: [],
          },
        })
        .respond("classifyVerification", {
          output: { route: "publish", summary: "checks passed", evidence: "node verification" },
        })
        .respond("publish", { output: published() })
        .respond("assessReview", { output: cleanReview() })
        .respond("inspectComments", {
          output: { route: "ci", summary: "no actionable comments", evidence: [] },
        })
        .respond("inspectCi", { output: ciInspection("green") })
        .respond("finalizeDelivery", {
          output: {
            status: "completed",
            merged: false,
            pr: "https://example.test/pr/1",
            reportComment: "ready",
            reason: "ready",
          },
        }),
      [revisedPlan],
    );
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-redesign"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement supported artifact",
      ...documentedPlan({ steps: ["use missing artifact"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "completed", plan: revisedPlan });
    expect(state.steps.map((step) => step.nodeId)).toContain("redesign/design/frame");
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(2);
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "decide"),
    ).toHaveLength(10);
  });

  it("uses blocked only after the controller records proof and alternatives", async () => {
    const executor = summaryExecutor()
      .respond("decide", controlDecision("implementation"), {
        output: {
          route: "blocked",
          goalMet: false,
          blockingNow: true,
          outsideAuthority: true,
          canProceed: false,
          reason: "The required external authorization is absent.",
          nextAction: "",
          alternativesChecked: ["Finish without the prohibited remote change"],
          evidence: ["The task does not grant that authorization."],
        },
      })
      .respond("implement", {
        output: {
          status: "blocked",
          summary: "External authorization is required.",
          files: [],
          issueKind: null,
          evidence: "No authorization exists.",
        },
      })
      .respond("classifyImplementation", {
        output: {
          route: "blocked",
          summary: "External authorization is required.",
          evidence: "No authorization exists.",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-blocked"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change external state"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The required external authorization is absent.",
    });
    expect(state.steps.map((step) => step.nodeId)).not.toContain("challengeBlocker");
  });

  it("addresses P2 findings without running a second review round", async () => {
    const executor = commonExecutor()
      .respond("assessReview", {
        output: {
          repositories: [
            {
              id: repositoryId(repository),
              invocationSucceeded: true,
              p0: [],
              p1: [],
              p2: [{ kind: "implementation", summary: "simplify one branch" }],
              lower: [],
              reason: "One P2 finding.",
            },
          ],
          reason: "One P2 finding.",
        },
      })
      .respond("addressP2", {
        output: { addressed: ["simplified branch"], skipped: [] },
      })
      .respond("verifyP2", {
        output: {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          pushed: true,
          repositories: published("def456").repositories,
        },
      })
      .respond("inspectComments", {
        output: { route: "ci", summary: "no actionable comments", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green", "def456") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://example.test/pr/1",
          reportComment: "https://example.test/pr/1#comment",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("pi-workflows-autoimplement-p2"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status).toBe("completed");
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "assessReview"),
    ).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("verifyP2");
    expect(
      executor.requests.some((request) => request.contract.nodeId === "challengeBlocker"),
    ).toBe(false);
    const result = state.finalOutput as { reviewRounds: Array<{ p2: unknown[] }> };
    expect(result.reviewRounds).toHaveLength(1);
    expect(result.reviewRounds[0]?.p2).toHaveLength(1);
  });

  it("runs another review after a P1 implementation fix", async () => {
    const executor = commonExecutor()
      .respond(
        "verify",
        {
          output: {
            passed: true,
            commands: [{ command: "npm test", outcome: "passed" }],
            failures: [],
            untested: [],
          },
        },
        {
          output: {
            passed: true,
            commands: [{ command: "npm test", outcome: "passed again" }],
            failures: [],
            untested: [],
          },
        },
      )
      .respond(
        "classifyVerification",
        { output: { route: "publish", summary: "passed", evidence: "first" } },
        { output: { route: "publish", summary: "passed", evidence: "second" } },
      )
      .respond("publish", { output: published("one") }, { output: published("two") })
      .respond(
        "assessReview",
        {
          output: {
            repositories: [
              {
                id: repositoryId(repository),
                invocationSucceeded: true,
                p0: [],
                p1: [{ kind: "implementation", summary: "fix race" }],
                p2: [],
                lower: [],
                reason: "One P1.",
              },
            ],
            reason: "One P1.",
          },
        },
        { output: cleanReview("two") },
      )
      .respond("fix", { output: { fixed: "fixed race", files: ["src/change.ts"] } })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green", "one") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://example.test/pr/1",
          reportComment: "done",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("pi-workflows-autoimplement-p1"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status, state.error).toBe("completed");
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "assessReview"),
    ).toHaveLength(2);
    const result = state.finalOutput as { reviewRounds: unknown[] };
    expect(result.reviewRounds).toHaveLength(2);
  });

  it("asks for repaired reviewer prerequisites after an invocation failure", async () => {
    const marker = path.join(commandDir, "reviewer-retried");
    await installCommand(
      "pi-reviewer",
      `if [ ! -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; exit 1; fi\nprintf '%s\\n' "review complete"`,
    );
    const executor = commonExecutor()
      .respond("repairReviewCommand", {
        output: { route: "retry", reason: "reviewer configuration repaired" },
      })
      .respond(
        "assessReview",
        {
          output: {
            repositories: [
              {
                id: repositoryId(repository),
                invocationSucceeded: false,
                p0: [],
                p1: [],
                p2: [],
                lower: [],
                reason: "The reviewer exited without a valid review.",
              },
            ],
            reason: "The first invocation did not produce a valid review.",
          },
        },
        { output: cleanReview() },
      )
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: true,
          pr: "https://example.test/pr/1",
          reportComment: "done",
          reason: "merged",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("pi-workflows-autoimplement-command"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: true,
    });

    expect(state.status).toBe("completed");
    expect(
      executor.requests.some((request) => request.contract.nodeId === "repairReviewCommand"),
    ).toBe(true);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(2);
  });

  it("rejects publication of an unprepared second repository before review", async () => {
    const secondRepository = await makeTempDir("pi-workflows-autoimplement-second-repo");
    const eventsPath = path.join(commandDir, "review-events.log");
    await installCommand(
      "pi-reviewer",
      `printf 'start %s\\n' "$PWD" >> ${JSON.stringify(eventsPath)}\nsleep 0.15\nprintf 'end %s\\n' "$PWD" >> ${JSON.stringify(eventsPath)}\nprintf '%s\\n' "review complete"`,
    );
    const publication = {
      repositories: [
        {
          repository,
          branch: "feat/demo",
          baseBranch: "main",
          headRevision: "head-one",
          pr: "https://example.test/pr/1",
          pushed: true,
        },
        {
          repository: secondRepository,
          branch: "feat/demo-two",
          baseBranch: "main",
          headRevision: "head-two",
          pr: "https://example.test/pr/2",
          pushed: true,
        },
      ],
    };
    const executor = commonExecutor(publication, (request) => {
      const match = /Observation: (.+)\nRecent attempts:/.exec(request.prompt);
      if (match?.[1] === undefined) return chooseFirstControlRoute(request);
      const observation = JSON.parse(match[1]) as {
        latestAttempt?: { nodeId?: string; outcome?: string };
      };
      return observation.latestAttempt?.nodeId === "publish" &&
        observation.latestAttempt.outcome === "failed"
        ? controlDecision("blocked", "Publication included an unprepared repository.")
        : chooseFirstControlRoute(request);
    })
      .respond("assessReview", {
        output: {
          repositories: [repository, secondRepository].map((cwd) => ({
            id: repositoryId(cwd),
            invocationSucceeded: true,
            p0: [],
            p1: [],
            p2: [],
            lower: [],
            reason: "clean",
          })),
          reason: "Both reviews are clean.",
        },
      })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: {
          targets: [
            {
              repository,
              headRevision: "head-one",
              pr: "https://example.test/pr/1",
              route: "green",
              reason: "green",
              relatedFailures: [],
              unrelatedFailures: [],
            },
            {
              repository: secondRepository,
              headRevision: "head-two",
              pr: "https://example.test/pr/2",
              route: "green",
              reason: "green",
              relatedFailures: [],
              unrelatedFailures: [],
            },
          ],
        },
      })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://example.test/pr/1",
          reportComment: "done",
          reason: "ready",
          repositories: [
            {
              repository,
              pr: "https://example.test/pr/1",
              merged: false,
              reportComment: "done",
              reason: "ready",
            },
            {
              repository: secondRepository,
              pr: "https://example.test/pr/2",
              merged: false,
              reportComment: "done for second repository",
              reason: "ready",
            },
          ],
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("pi-workflows-autoimplement-parallel-review"),
    });
    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement in two repositories",
      ...documentedPlan({ steps: ["change both repositories"] }),
      repository,
      concurrency: { reviewer: 2 },
      merge: false,
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "Publication included an unprepared repository.",
    });
    expect(state.steps.some((step) => step.nodeId === "runReview")).toBe(false);
  });

  it("returns a timed-out implementation to the controller and retries safely", async () => {
    const verificationCheck = {
      id: "verify",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: repository,
      timeoutMs: 10_000,
      maxOutputChars: 100_000,
      readOnly: true,
      baseEligible: false,
      changedFileScope: false,
      findingFormat: "text" as const,
    };
    const executor = summaryExecutor()
      .respond(
        "decide",
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("verification"),
        controlDecision("publication"),
        controlDecision("review"),
        controlDecision("comments"),
        controlDecision("ci"),
        controlDecision("delivery"),
        controlDecision("complete"),
      )
      .respond(
        "implement",
        { hang: true },
        {
          output: {
            status: "implemented",
            summary: "continued existing work",
            files: ["src/change.ts"],
            repositories: [repository],
            issueKind: null,
            evidence: "complete",
          },
        },
      )
      .respond("classifyImplementation", {
        output: { route: "verify", summary: "ready", evidence: "complete" },
      })
      .respond("publish", { output: published() })
      .respond("assessReview", { output: cleanReview() })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", { output: ciInspection("green") })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://example.test/pr/1",
          reportComment: "ready",
          reason: "ready",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-timeout"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 50), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
      verificationChecks: [verificationCheck],
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "completed" });
    expect(
      state.steps.filter((step) => step.nodeId === "implement").map((step) => step.outcome),
    ).toEqual(["timed_out", "ok"]);
    expect(state.steps.filter((step) => step.nodeId === "decide")).toHaveLength(9);
  });

  it("stops a repeated route after three no-progress attempts", async () => {
    const executor = summaryExecutor()
      .respond(
        "decide",
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("blocked", "The bounded retry limit is exhausted."),
      )
      .respond("implement", { hang: true });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-bound"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 20), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The bounded retry limit is exhausted.",
    });
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(3);
    const lastObservation = state.steps.filter((step) => step.nodeId === "observe").at(-1)
      ?.output as { availableRoutes: string[] };
    expect(lastObservation.availableRoutes).not.toContain("implementation");
  });

  it("keeps a route available while its accepted evidence changes", async () => {
    const executor = summaryExecutor()
      .respond(
        "decide",
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("implementation"),
        controlDecision("blocked", "The work remains blocked after new evidence."),
      )
      .respond("implement", {
        output: {
          status: "issue",
          summary: "More implementation work is needed.",
          files: [],
          issueKind: "implementation",
          evidence: "The implementation is incomplete.",
        },
      })
      .respond(
        "classifyImplementation",
        ...Array.from({ length: 4 }, (_, index) => ({
          output: {
            route: "blocked",
            summary: `Observed issue ${index + 1}`,
            evidence: `New evidence ${index + 1}`,
          },
        })),
      );
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-progress"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The work remains blocked after new evidence.",
    });
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(4);
    expect(
      state.steps
        .filter((step) => step.nodeId === "observe")
        .map(
          (step) =>
            (step.output as { consecutiveNoProgressAttempts: number })
              .consecutiveNoProgressAttempts,
        ),
    ).toEqual(expect.arrayContaining([1]));
  });

  it("reports blocked after three controller failures", async () => {
    const executor = summaryExecutor().respond("decide", { hang: true });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-failure-bound"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("decide", 20), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    });

    expect(state.status, state.error).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The controller failed 3 times without an accepted decision.",
    });
    expect(state.steps.filter((step) => step.nodeId === "decide")).toHaveLength(3);
    expect(state.steps.filter((step) => step.nodeId === "controlFailure")).toHaveLength(3);
  });

  it("keeps explicit cancellation terminal", async () => {
    const executor = summaryExecutor()
      .respond("decide", controlDecision("implementation"))
      .respond("implement", { hang: true });
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-controller-cancelled"),
    });
    const running = engine.run(autoimplementWithTimeout("implement", 1_000), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      preparedWorkspace: preparedWorkspaceFor(),
    });
    await waitUntil(() =>
      executor.requests.some((request) => request.contract.nodeId === "implement"),
    );
    engine.cancel();
    const { state } = await running;
    expect(state.status).toBe("cancelled");
    expect(state.steps.filter((step) => step.nodeId === "decide")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "observe")).toHaveLength(1);
  });

  it("returns timed-out default-branch delivery to the controller", async () => {
    await git(repository, ["switch", "main"]);
    const prepared = {
      ...preparedWorkspaceFor(),
      mode: "defaultBranch" as const,
      workBranch: "main",
      directDefaultBranchAuthorized: true,
    };
    const verificationCheck = {
      id: "verify",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: repository,
      timeoutMs: 10_000,
      maxOutputChars: 100_000,
      readOnly: true,
      baseEligible: false,
      changedFileScope: false,
      findingFormat: "text" as const,
    };
    const executor = summaryExecutor()
      .respond(
        "decide",
        controlDecision("implementation"),
        controlDecision("verification"),
        controlDecision("publication"),
        controlDecision("publication"),
        controlDecision("complete"),
      )
      .respond("implement", {
        output: {
          status: "implemented",
          summary: "done",
          files: [],
          repositories: [repository],
          issueKind: null,
          evidence: "done",
        },
      })
      .respond("classifyImplementation", {
        output: { route: "verify", summary: "ready", evidence: "done" },
      })
      .respond(
        "finalizeDefaultBranch",
        { hang: true },
        {
          output: {
            status: "completed",
            committed: false,
            pushed: false,
            merged: false,
            pr: "none",
            reportComment: "Verified local change retained.",
            reason: "No commit or push authority.",
          },
        },
      );
    const engine = new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("autoimplement-default-branch"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("finalizeDefaultBranch", 50), {
      task: "Verify direct default-branch work",
      ...documentedPlan({ steps: ["verify"] }),
      repository,
      preparedWorkspace: prepared,
      directDefaultBranchAuthorized: true,
      verificationChecks: [verificationCheck],
      merge: false,
    });

    expect(state.finalOutput).toMatchObject({
      status: "completed",
      reviewRounds: [],
      ci: { route: "notApplicable" },
      delivery: { pr: "none", merged: false },
    });
    expect(executor.requests.some((request) => request.contract.nodeId === "publish")).toBe(false);
    expect(
      state.steps
        .filter((step) => step.nodeId === "finalizeDefaultBranch")
        .map((step) => step.outcome),
    ).toEqual(["timed_out", "ok"]);
  });

  it("uses the eight-hour implementation timeout and shared controller returns", () => {
    expect(autoimplementWorkflow.nodes.implement?.timeoutMs).toBe(8 * 60 * 60_000);
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    expect(autoimplementWorkflow.nodes.timeoutFallback).toBeUndefined();
    expect(autoimplementWorkflow.nodes.challengeBlocker).toBeUndefined();
    expect(compiled.edges.find((candidate) => candidate.from === "decide")).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: { ok: "dispatch", timed_out: "controlFailure", failed: "controlFailure" },
      },
    });
    expect(
      (
        compiled.edges.find((candidate) => candidate.from === "decide") as {
          switch: { cases: Record<string, string> };
        }
      ).switch.cases,
    ).not.toHaveProperty("cancelled");
    for (const nodeId of [
      "implement",
      "fix",
      "publish",
      "addressP2",
      "verifyP2",
      "inspectComments",
      "inspectCi",
      "trackCi",
      "repairCiCommand",
      "opportunisticTest",
      "finalizeDefaultBranch",
      "finalizeDelivery",
    ]) {
      const edge = compiled.edges.find((candidate) => candidate.from === nodeId);
      expect(edge).toMatchObject({
        switch: {
          on: "$result.outcome",
          cases: { timed_out: "observe", failed: "observe" },
        },
      });
      expect(
        (edge as { switch: { cases: Record<string, string> } }).switch.cases,
      ).not.toHaveProperty("cancelled");
    }
  });

  it("routes completed CI batches through per-PR assessment", () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const track = compiled.nodes.trackCi;
    const trackOutcome = compiled.edges.find((candidate) => candidate.from === "trackCi");
    const batchRoute = compiled.edges.find((candidate) => candidate.from === "routeTrackCiResult");
    expect(track?.nodeType).toBe("action");
    expect(trackOutcome).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: { ok: "routeTrackCiResult", timed_out: "observe", failed: "observe" },
      },
    });
    expect(batchRoute).toMatchObject({
      switch: {
        on: "$.route",
        cases: { assess: "assessTrackedCi", repair: "repairCiCommand" },
      },
    });
  });
});
