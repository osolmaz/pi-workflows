import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import autoimplementWorkflow from "../src/builtins/autoimplement.workflow.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { digest } from "../src/workflows/human-decision.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

let originalPath = "";
let commandDir = "";
let repository = "";

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

function documentedPlan(plan: unknown) {
  return {
    plan,
    documentation: { status: "current" as const, planDigest: digest(plan), documents: [] },
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

function commonExecutor(publication: unknown = published()): ScriptedExecutor {
  return new ScriptedExecutor()
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
    .respond("planVerification", {
      output: {
        commands: [
          {
            id: "verify",
            command: process.execPath,
            args: ["-e", "process.stdout.write('passed')"],
            cwd: repository,
            timeoutMs: 60_000,
            maxOutputChars: 100_000,
          },
        ],
        untested: [],
      },
    })
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

function continueChallenge(reason: string, nextAction: string) {
  return {
    route: "continue",
    blockingNow: false,
    outsideAuthority: false,
    canProceed: true,
    reason,
    nextAction,
    alternativesChecked: ["Use the supported path", "Keep rollback ready"],
    evidence: ["The task authorizes the required local and rollout work"],
  };
}

function confirmedChallenge(reason: string) {
  return {
    route: "blocked",
    blockingNow: true,
    outsideAuthority: true,
    canProceed: false,
    reason,
    nextAction: "",
    alternativesChecked: ["Complete without the prohibited remote mutation"],
    evidence: ["The required external authorization is absent"],
  };
}

function addRedesignResponses(executor: ScriptedExecutor, plans: unknown[]): ScriptedExecutor {
  return executor
    .respond("redesign/frame", {
      output: {
        problem: "finish the task",
        success: ["work completes"],
        inScope: ["repository and authorized rollout"],
        outOfScope: ["unapproved remote mutation"],
        constraints: [],
        controlBoundary: "authorized repository and rollout",
      },
    })
    .respond("redesign/propose", {
      output: {
        solution: "use the supported path",
        rationale: "it is authorized",
        parts: ["adjust plan", "verify"],
        tradeoffs: [],
      },
    })
    .respond("redesign/ideal", {
      output: { ideal: "completed work", outsideDependencies: [], additionalValue: [] },
    })
    .respond("redesign/choose", {
      output: {
        status: "ready",
        selected: "use the supported path",
        why: "it completes in scope",
        relationshipToIdeal: "same result",
        excluded: [],
        compromises: [],
      },
    })
    .respond("redesign/plan", ...plans.map((plan) => ({ output: plan })))
    .respond("documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/workflows.md"],
        digests: {},
        reason: "The revised plan is documented.",
        evidence: "checked",
      },
    });
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  commandDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-commands-"));
  repository = await makeTempDir("pi-workflows-autoimplement-repo");
  await installCommand("pi-reviewer", "printf '%s\\n' \"review complete\"");
  await installCommand("gh", "printf '%s\\n' \"checks complete\"");
  process.env.PATH = `${commandDir}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("built-in autoimplement", () => {
  it("validates input, reviewer severities, repair commands, and CI tracking", async () => {
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
    expect(await parseInput({ task: "demo" })).toMatchObject({ task: "demo", merge: false });
    expect(
      await parseInput({
        task: "demo",
        plan: {},
        scope: "repo",
        constraints: ["keep API"],
        repository,
        baseBranch: "main",
        merge: false,
      }),
    ).toMatchObject({ task: "demo", scope: "repo", merge: false });
    expect(() => parseInput(null)).toThrow("object");
    expect(() => parseInput({ task: "" })).toThrow("non-empty");
    expect(() => parseInput({ task: "demo", constraints: "bad" })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", constraints: [3] })).toThrow("constraints");
    expect(() => parseInput({ task: "demo", merge: "yes" })).toThrow("boolean");
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
        input: { task: "demo", plan: {} },
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
      validate("planVerification", {
        commands: [
          {
            id: "unsafe",
            command: "bash",
            args: ["-c", "npm test"],
            cwd: repository,
            timeoutMs: 1_000,
            maxOutputChars: 1_000,
          },
        ],
        untested: [],
      }),
    ).rejects.toThrow("not allowed");
    const safeVerification = {
      commands: [
        {
          id: "verify",
          command: process.execPath,
          args: ["-e", "process.stdout.write('ok')"],
          cwd: repository,
          timeoutMs: 1_000,
          maxOutputChars: 1_000,
        },
      ],
      untested: [],
    };
    await expect(
      validate("planVerification", safeVerification, {
        input: { task: "demo", plan: {}, repository },
        outputs: { implement: { repositories: "bad" } },
      }),
    ).resolves.toMatchObject({ commands: [{ id: "verify" }] });
    await expect(
      validate(
        "planVerification",
        {
          ...safeVerification,
          commands: [{ ...safeVerification.commands[0]!, cwd: path.join(repository, "other") }],
        },
        {
          input: { task: "demo", plan: {}, repository },
          outputs: { implement: { repositories: [repository] } },
        },
      ),
    ).rejects.toThrow("was not reported by implementation");
    await expect(
      validate("planVerification", safeVerification, {
        input: { task: "demo", plan: {}, repository },
        outputs: {
          implement: { repositories: [repository, path.join(repository, "second")] },
        },
      }),
    ).rejects.toThrow("missing reported repositories");
    await expect(
      validate("repairReviewCommand", { route: "unknown", reason: "bad" }),
    ).rejects.toThrow("one of retry, blocked");
    await expect(validate("repairCiCommand", { route: "unknown", reason: "bad" })).rejects.toThrow(
      "one of retry, blocked",
    );
    await expect(
      validate("challengeBlocker", continueChallenge("rollout is authorized", "deploy safely")),
    ).resolves.toMatchObject({ route: "continue", canProceed: true });
    await expect(
      validate("challengeBlocker", confirmedChallenge("external authorization is required")),
    ).resolves.toMatchObject({ route: "blocked", outsideAuthority: true });
    await expect(
      validate("challengeBlocker", {
        ...confirmedChallenge("contradictory blocker"),
        canProceed: true,
      }),
    ).rejects.toThrow("blocked challenge requires");
    await expect(
      validate("challengeBlocker", {
        ...continueChallenge("no next action", "deploy safely"),
        nextAction: "",
      }),
    ).rejects.toThrow("practical nextAction");
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

  it("projects redesign evidence, plan changes, blocked reasons, and command history", async () => {
    const makeContext = (overrides: Record<string, unknown> = {}) =>
      ({
        input: { task: "demo", scope: "repo", constraints: ["safe"], plan: { old: true } },
        outputs: {},
        results: {},
        state: { steps: [] },
        signal: new AbortController().signal,
        ...overrides,
      }) as never;

    const redesign = autoimplementWorkflow.includes?.redesign;
    if (redesign?.input === undefined) throw new Error("redesign input mapper is missing");
    expect(
      await redesign.input(
        makeContext({
          outputs: { adoptPlan: { plan: { revised: true } } },
          state: {
            steps: [
              {
                nodeId: "classifyVerification",
                output: { route: "redesign", evidence: "new failure" },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      problem: "demo",
      scope: "repo",
      constraints: ["safe"],
      previousPlan: { revised: true },
      newEvidence: { route: "redesign", evidence: "new failure" },
    });

    const adopt = autoimplementWorkflow.nodes.adoptPlan;
    if (adopt?.nodeType !== "compute") throw new Error("adoptPlan must be compute");
    const ready = (changed: boolean) => ({
      exit: "ready",
      output: {
        status: "ready",
        frame: {},
        proposal: {},
        ideal: {},
        selection: {},
        plan: { revised: true },
        planDigest: "sha256:plan",
        previousPlanDigest: "sha256:old",
        changed,
      },
    });
    expect(await adopt.run(makeContext({ outputs: { redesign: ready(true) } }))).toMatchObject({
      route: "document",
      changed: true,
    });
    expect(await adopt.run(makeContext({ outputs: { redesign: ready(false) } }))).toMatchObject({
      route: "blocked",
      changed: false,
    });
    expect(() =>
      adopt.run(
        makeContext({ outputs: { redesign: { exit: "blocked", output: { reason: "no plan" } } } }),
      ),
    ).toThrow("ready plan");

    const blocked = autoimplementWorkflow.nodes.blocked;
    if (blocked?.nodeType !== "compute") throw new Error("blocked must be compute");
    expect(
      await blocked.run(
        makeContext({
          state: {
            steps: [
              { nodeId: "other", output: {} },
              { nodeId: "classifyCi", output: { blocker: "CI blocked" } },
            ],
          },
        }),
      ),
    ).toMatchObject({ reason: "CI blocked" });
    expect(await blocked.run(makeContext())).toMatchObject({
      reason: "Autoimplementation could not continue within the authorized scope.",
    });

    const track = autoimplementWorkflow.nodes.trackCi;
    if (track?.nodeType !== "action" || !("run" in track)) {
      throw new Error("trackCi must be a function action");
    }
    const pending = ciInspection("pending");
    expect(
      await track.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: { inspectCi: { route: "pending", ...pending } },
          publishUpdate: async () => ({ updateId: "u1", seq: 1, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({ route: "assess", batch: { items: [{ id: repositoryId(repository) }] } });

    await installCommand("gh", "printf '%s\\n' 'checks failed'; exit 1");
    expect(
      await track.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: { inspectCi: { route: "pending", ...pending } },
          publishUpdate: async () => ({ updateId: "u2", seq: 2, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({
      route: "assess",
      batch: { items: [{ outcome: "failed", exitCode: 1 }] },
    });

    const review = autoimplementWorkflow.nodes.runReview;
    if (review?.nodeType !== "action" || !("run" in review)) {
      throw new Error("runReview must be a function action");
    }
    await installCommand("pi-reviewer", "printf '%s\\n' 'P1 finding'; exit 1");
    expect(
      await review.run(
        makeContext({
          input: { task: "demo", concurrency: { reviewer: 1, ciWatch: 1, verification: 1 } },
          outputs: {
            selectReviewCommands: {
              route: "run",
              repositories: [
                {
                  id: repositoryId(repository),
                  repository,
                  branch: "feat/demo",
                  baseBranch: "main",
                  headRevision: "abc123",
                  pr: "https://example.test/pr/1",
                },
              ],
              commands: [
                {
                  id: repositoryId(repository),
                  command: "pi-reviewer",
                  args: ["--base", "main"],
                  cwd: repository,
                  timeoutMs: 600_000,
                  maxOutputChars: 1_000_000,
                },
              ],
            },
          },
          publishUpdate: async () => ({ updateId: "u1", seq: 1, at: "now", type: "x", key: "y" }),
        }),
      ),
    ).toMatchObject({
      route: "assess",
      batch: { items: [{ outcome: "failed", exitCode: 1, stdout: "P1 finding\n" }] },
    });

    const delivery = autoimplementWorkflow.nodes.finalizeDelivery;
    if (delivery?.nodeType !== "agent") throw new Error("finalizeDelivery must be agent");
    expect(
      await delivery.prompt(
        makeContext({ input: { task: "demo", merge: false }, outputs: { publish: published() } }),
      ),
    ).toContain("without merging");
    expect(
      await delivery.prompt(
        makeContext({ input: { task: "demo", merge: true }, outputs: { publish: published() } }),
      ),
    ).toContain("merge each");
    expect(() => delivery.validate?.({ status: "invalid" }, makeContext())).toThrow(
      "delivery status",
    );
    expect(() =>
      delivery.validate?.(
        { status: "completed", merged: true, reason: "merged" },
        makeContext({ input: { task: "demo", merge: false } }),
      ),
    ).toThrow("explicit merge: true");
    expect(
      delivery.validate?.(
        {
          status: "completed",
          merged: false,
          pr: "https://example.test/pr/1",
          reportComment: "done",
          reason: "ready",
        },
        makeContext({
          input: { task: "demo", merge: false },
          outputs: { publish: published() },
        }),
      ),
    ).toMatchObject({ repositories: [{ repository, merged: false }] });

    const secondRepository = path.join(path.dirname(repository), "second-repository");
    const multiPublication = {
      repositories: [
        ...published().repositories,
        {
          repository: secondRepository,
          branch: "feat/second",
          baseBranch: "main",
          headRevision: "def456",
          pr: "https://example.test/pr/2",
          pushed: true,
        },
      ],
    };
    expect(() =>
      delivery.validate?.(
        {
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
          ],
        },
        makeContext({
          input: { task: "demo", merge: false },
          outputs: { publish: multiPublication },
        }),
      ),
    ).toThrow("does not match published repository and PR");
  });

  it("challenges the Bob artifact mismatch and continues through redesign", async () => {
    const executor = new ScriptedExecutor()
      .respond(
        "implement",
        {
          output: {
            status: "blocked",
            summary: "Bob owns an incompatible artifact, so deployment cannot continue.",
            files: [],
            issueKind: "design",
            evidence: "The current artifact does not match the supported package.",
          },
        },
        {
          output: {
            status: "implemented",
            summary: "Deployed through the supported cutover with rollback ready.",
            files: ["deploy/cutover.ts"],
            issueKind: null,
            evidence: "The supported artifact is active.",
          },
        },
      )
      .respond(
        "classifyImplementation",
        {
          output: {
            route: "blocked",
            summary: "Artifact ownership prevents deployment.",
            evidence: "Bob artifact mismatch",
          },
        },
        { output: { route: "verify", summary: "cutover complete", evidence: "deployed" } },
      )
      .respond("challengeBlocker", {
        output: continueChallenge(
          "The mismatch needs an authorized supported cutover, not an external permission.",
          "Revise the rollout plan and deploy the supported artifact with rollback ready.",
        ),
      })
      .respond("planVerification", {
        output: {
          commands: [
            {
              id: "verify-cutover",
              command: process.execPath,
              args: ["-e", "process.stdout.write('passed')"],
              cwd: repository,
              timeoutMs: 60_000,
              maxOutputChars: 100_000,
            },
          ],
          untested: [],
        },
      })
      .respond("verify", {
        output: {
          passed: true,
          commands: [{ command: "npm test", outcome: "passed" }],
          failures: [],
          untested: [],
        },
      })
      .respond("classifyVerification", {
        output: { route: "publish", summary: "verified", evidence: "npm test" },
      })
      .respond("publish", {
        output: published("cutover123", "feat/cutover", "https://example.test/pr/2"),
      })
      .respond("assessReview", { output: cleanReview("cutover123") })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: ciInspection("green", "cutover123", "https://example.test/pr/2"),
      })
      .respond("finalizeDelivery", {
        output: {
          status: "completed",
          merged: false,
          pr: "https://example.test/pr/2",
          reportComment: "done",
          reason: "ready without merge",
        },
      });
    addRedesignResponses(executor, [
      {
        summary: "Use the supported cutover.",
        steps: ["prepare rollback", "deploy supported artifact"],
        revision: 1,
      },
    ]);
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-bob"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Resolve the Bob artifact mismatch and deploy safely",
      ...documentedPlan({ steps: ["deploy Bob artifact"] }),
      scope: "repository deployment and rollback",
      constraints: ["Safe deployment and rollback are authorized"],
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ status: "completed" });
    expect(state.steps.filter((step) => step.nodeId === "challengeBlocker")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("redesign/frame");
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(2);

    const challengeRequest = executor.requests.find(
      (request) => request.contract.nodeId === "challengeBlocker",
    );
    expect(challengeRequest?.prompt).toContain("Are you really blocked?");
    expect(challengeRequest?.prompt).toContain("Is this really a blocker right now?");
    expect(challengeRequest?.prompt).toContain(
      "Can you find a safe way to move forward and finish this?",
    );
    expect(challengeRequest?.prompt).toContain(
      "Are you getting stuck on something trivial, procedural, reversible, or already authorized?",
    );
    expect(challengeRequest?.prompt).toContain("Bob artifact mismatch");

    const redesignRequest = executor.requests.find(
      (request) => request.contract.nodeId === "redesign/frame",
    );
    expect(redesignRequest?.prompt).toContain(
      "Revise the rollout plan and deploy the supported artifact with rollback ready.",
    );
  });

  it("allows a confirmed missing external authorization to stop", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", {
        output: {
          status: "blocked",
          summary: "The task requires a prohibited remote mutation.",
          files: [],
          issueKind: "design",
          evidence: "No external authorization is present.",
        },
      })
      .respond("classifyImplementation", {
        output: {
          route: "blocked",
          summary: "Required remote mutation lacks authorization.",
          evidence: "The non-mutating paths do not meet the task.",
        },
      })
      .respond("challengeBlocker", {
        output: confirmedChallenge("The required remote mutation is outside current authority."),
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-confirmed-blocker"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Complete the protected remote mutation",
      ...documentedPlan({ steps: ["mutate protected remote"] }),
      scope: "local repository only",
      constraints: ["Do not mutate the protected remote without approval"],
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "The required remote mutation is outside current authority.",
    });
  });

  it("limits blocker challenges to three and supplies prior challenge context", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", {
        output: {
          status: "blocked",
          summary: "The same unsupported blocker was asserted again.",
          files: [],
          issueKind: "design",
          evidence: "claim only",
        },
      })
      .respond("classifyImplementation", {
        output: {
          route: "blocked",
          summary: "Cannot continue.",
          evidence: "No new evidence.",
        },
      })
      .respond(
        "challengeBlocker",
        { output: continueChallenge("challenge one", "revise plan one") },
        { output: continueChallenge("challenge two", "revise plan two") },
        { output: continueChallenge("challenge three", "revise plan three") },
      );
    addRedesignResponses(executor, [
      { summary: "revision one", revision: 1 },
      { summary: "revision two", revision: 2 },
      { summary: "revision three", revision: 3 },
    ]);
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-challenge-limit"),
    });

    const { state } = await engine.run(autoimplementWorkflow, {
      task: "Finish despite repeated unsupported blocker claims",
      ...documentedPlan({ summary: "initial plan", revision: 0 }),
      repository,
      merge: false,
    });

    const challengeRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "challengeBlocker",
    );
    expect(challengeRequests).toHaveLength(3);
    expect(challengeRequests[2]?.prompt).toContain("challenge one");
    expect(challengeRequests[2]?.prompt).toContain("challenge two");
    expect(state.finalOutput).toMatchObject({
      status: "blocked",
      reason: "Blocker challenge reached the 3-attempt workflow safety limit.",
      evidence: { evidence: { attempts: 3 } },
    });
  });

  it("routes model blockers through the challenge and preserves hard stops", () => {
    const edge = (from: string) =>
      autoimplementWorkflow.edges.find((candidate) => candidate.from === from);

    expect(edge("classifyImplementation")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("classifyVerification")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("repairReviewCommand")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("routeInspectCommentsResult")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("routeInspectCiResult")).toMatchObject({
      switch: { cases: { unavailable: "challengeBlockerGuard" } },
    });
    expect(edge("repairCiCommand")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("assessTrackedCi")).toMatchObject({
      switch: { cases: { unavailable: "challengeBlockerGuard" } },
    });
    expect(edge("classifyCi")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("routeFinalizeDeliveryResult")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });

    expect(edge("approval.stop")).toMatchObject({ to: "blocked" });
    expect(edge("redesign.blocked")).toMatchObject({ to: "blocked" });
    expect(edge("documentation.blocked")).toMatchObject({ to: "blocked" });
    expect(edge("replanGuard")).toMatchObject({ switch: { cases: { blocked: "blocked" } } });
    expect(edge("challengeBlocker")).toMatchObject({
      switch: { cases: { continue: "redesign", blocked: "blocked" } },
    });
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
      outputRoot: await makeTempDir("pi-workflows-autoimplement-p2"),
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
      outputRoot: await makeTempDir("pi-workflows-autoimplement-p1"),
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
      outputRoot: await makeTempDir("pi-workflows-autoimplement-command"),
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

  it("runs independent repository reviews in a bounded parallel batch", async () => {
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
    const executor = commonExecutor(publication)
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
      outputRoot: await makeTempDir("pi-workflows-autoimplement-parallel-review"),
    });
    const { state } = await engine.run(autoimplementWorkflow, {
      task: "implement in two repositories",
      ...documentedPlan({ steps: ["change both repositories"] }),
      repository,
      concurrency: { reviewer: 2 },
      merge: false,
    });
    expect(state.status, state.error).toBe("completed");
    const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
    let active = 0;
    let maximum = 0;
    for (const event of events) {
      active += event.startsWith("start ") ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(state.steps.filter((step) => step.nodeId === "runReview")).toHaveLength(1);
    const updates = state.updates?.filter((update) => update.type === "command-batch.item") ?? [];
    expect(updates).toHaveLength(3);
    expect(
      updates.every((update) => !("stdout" in update.data) && !("stderr" in update.data)),
    ).toBe(true);
  });

  it("routes a timed-out implementation through the shared fallback", async () => {
    const executor = new ScriptedExecutor()
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
            evidence: "worktree inspection showed the remaining work",
          },
        },
      )
      .respond("timeoutFallback", {
        output: {
          route: "retry",
          reason: "The timed-out implementation has incomplete local work.",
          evidence: ["The current diff still has the planned incomplete change."],
        },
      })
      .respond("classifyImplementation", {
        output: { route: "verify", summary: "ready", evidence: "implementation complete" },
      })
      .respond("planVerification", {
        output: {
          commands: [
            {
              id: "verify",
              command: process.execPath,
              args: ["-e", "process.stdout.write('passed')"],
              cwd: repository,
              timeoutMs: 60_000,
              maxOutputChars: 100_000,
            },
          ],
          untested: [],
        },
      })
      .respond("verify", {
        output: {
          passed: true,
          commands: [{ command: "node verification", outcome: "passed" }],
          failures: [],
          untested: [],
        },
      })
      .respond("classifyVerification", {
        output: { route: "publish", summary: "checks passed", evidence: "verification" },
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
          reportComment: "https://example.test/pr/1#comment",
          reason: "ready",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-timeout-fallback"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 20), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status, state.error).toBe("completed");
    expect(
      state.steps.filter((step) => step.nodeId === "implement").map((step) => step.outcome),
    ).toEqual(["timed_out", "ok"]);
    expect(state.steps.filter((step) => step.nodeId === "timeoutFallback")).toHaveLength(1);
    expect(
      executor.requests.find((request) => request.contract.nodeId === "timeoutFallback")?.prompt,
    ).toContain("read-only fallback step");
  });

  it("stops after three timeout fallback executions", async () => {
    const executor = new ScriptedExecutor()
      .respond("implement", { hang: true }, { hang: true }, { hang: true }, { hang: true })
      .respond(
        "timeoutFallback",
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff is incomplete."],
          },
        },
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff is still incomplete."],
          },
        },
        {
          output: {
            route: "retry",
            reason: "Implementation remains incomplete.",
            evidence: ["The current diff remains incomplete."],
          },
        },
      );
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-timeout-limit"),
    });

    const { state } = await engine.run(autoimplementWithTimeout("implement", 10), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });

    expect(state.status).toBe("completed");
    expect((state.finalOutput as { status: string }).status).toBe("blocked");
    expect(state.steps.filter((step) => step.nodeId === "timeoutFallback")).toHaveLength(3);
    expect(state.steps.filter((step) => step.nodeId === "implement")).toHaveLength(4);
  });

  it("keeps failed implementation and cancellation out of timeout fallback", async () => {
    const failedEngine = new WorkflowEngine({
      executor: new ScriptedExecutor().respond("implement", { error: "implementation failed" }),
      outputRoot: await makeTempDir("pi-workflows-autoimplement-failed"),
    });
    const failed = await failedEngine.run(autoimplementWorkflow, {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });
    expect(failed.state.status).toBe("failed");
    expect(failed.state.error).toBe("implementation failed");
    expect(failed.state.steps.some((step) => step.nodeId === "timeoutFallback")).toBe(false);

    const cancelledExecutor = new ScriptedExecutor().respond("implement", { hang: true });
    const cancelledEngine = new WorkflowEngine({
      executor: cancelledExecutor,
      outputRoot: await makeTempDir("pi-workflows-autoimplement-cancelled"),
    });
    const cancelledPromise = cancelledEngine.run(autoimplementWithTimeout("implement", 1_000), {
      task: "implement demo",
      ...documentedPlan({ steps: ["change code"] }),
      repository,
      merge: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelledEngine.cancel();
    const cancelled = await cancelledPromise;
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.steps.some((step) => step.nodeId === "timeoutFallback")).toBe(false);
  });

  it("uses the eight-hour implementation timeout and shared outcome routes", () => {
    expect(autoimplementWorkflow.nodes.implement?.timeoutMs).toBe(8 * 60 * 60_000);
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    for (const nodeId of [
      "implement",
      "planVerification",
      "verify",
      "fix",
      "publish",
      "addressP2",
      "verifyP2",
      "inspectComments",
      "inspectCi",
      "opportunisticTest",
      "finalizeDelivery",
    ]) {
      const edge = compiled.edges.find((candidate) => candidate.from === nodeId);
      expect(edge).toMatchObject({
        switch: {
          on: "$result.outcome",
          cases: {
            timed_out: "timeoutFallbackGuard",
            failed: "propagateSupportedFailure",
          },
        },
      });
    }
  });

  it("routes completed CI batches through per-PR assessment", () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const track = compiled.nodes.trackCi;
    const edge = compiled.edges.find((candidate) => candidate.from === "trackCi");
    expect(track?.nodeType).toBe("action");
    expect(edge).toMatchObject({
      switch: {
        on: "$.route",
        cases: { assess: "assessTrackedCi", repair: "repairCiCommand" },
      },
    });
  });
});
