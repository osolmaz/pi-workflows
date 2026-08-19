import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function cleanReview() {
  return {
    invocationSucceeded: true,
    p0: [],
    p1: [],
    p2: [],
    lower: [],
    reason: "No P0, P1, or P2 findings.",
  };
}

function commonExecutor(reviewerCwd = repository): ScriptedExecutor {
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
    .respond("verify", {
      output: {
        passed: true,
        commands: [{ command: "npm test", outcome: "passed" }],
        failures: [],
        untested: [],
      },
    })
    .respond("classifyVerification", {
      output: { route: "publish", summary: "checks passed", evidence: "npm test" },
    })
    .respond("publish", {
      output: {
        branch: "feat/demo",
        baseBranch: "main",
        headRevision: "abc123",
        pr: "https://example.test/pr/1",
        pushed: true,
      },
    })
    .respond("authorReviewCommand", { output: reviewerCommand(reviewerCwd) });
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

    const validate = async (nodeId: string, output: unknown) => {
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
      } as never);
    };

    await expect(
      validate("assessReview", {
        invocationSucceeded: true,
        p0: [{ kind: "design", summary: "P0 design" }],
        p1: [{ kind: "implementation", summary: "P1 code" }],
        p2: [{ kind: "implementation", summary: "P2 code" }],
        lower: [{ kind: "implementation", summary: "lower" }],
        reason: "findings",
      }),
    ).resolves.toMatchObject({ route: "critical", p0: [{ severity: "P0" }] });
    await expect(
      validate("assessReview", {
        invocationSucceeded: false,
        p0: [],
        p1: [],
        p2: [],
        lower: [],
        reason: "invalid invocation",
      }),
    ).resolves.toMatchObject({ route: "command_error" });
    await expect(
      validate("assessReview", {
        invocationSucceeded: true,
        p0: [{ kind: "unknown", summary: "bad" }],
        p1: [],
        p2: [],
        lower: [],
        reason: "bad",
      }),
    ).rejects.toThrow("kind");

    await expect(
      validate("repairReviewCommand", { route: "blocked", reason: "reviewer missing" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("repairCiCommand", { route: "blocked", reason: "CI unavailable" }),
    ).resolves.toMatchObject({ route: "blocked" });
    await expect(
      validate("inspectCi", {
        route: "pending",
        reason: "running",
        relatedFailures: [],
        unrelatedFailures: [],
        trackingCommand: {
          command: "gh",
          args: ["pr", "checks", "--watch"],
          cwd: repository,
          timeoutMs: 300_000,
        },
      }),
    ).resolves.toMatchObject({ route: "pending", trackingCommand: { command: "gh" } });
    await expect(
      validate("inspectCi", {
        route: "pending",
        reason: "running",
        relatedFailures: [],
        unrelatedFailures: [],
      }),
    ).rejects.toThrow("must be an object");
    await expect(
      validate("authorReviewCommand", {
        command: "codex",
        args: ["review"],
        cwd: repository,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("pi-reviewer");
    await expect(
      validate("authorReviewCommand", {
        command: "pi-reviewer",
        args: "--base main",
        cwd: repository,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("array of strings");
    await expect(
      validate("authorReviewCommand", {
        command: "pi-reviewer",
        args: ["--base", 3],
        cwd: repository,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("array of strings");
    await expect(
      validate("authorReviewCommand", {
        command: "pi-reviewer",
        args: ["--base"],
        cwd: repository,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("not allowed");
    await expect(
      validate("authorReviewCommand", {
        command: "pi-reviewer",
        args: ["--base", "main"],
        cwd: "relative",
        timeoutMs: 1,
      }),
    ).rejects.toThrow("absolute");
    for (const timeoutMs of [0, 600_001, 1.5, "600000"]) {
      await expect(
        validate("authorReviewCommand", {
          command: "pi-reviewer",
          args: ["--base", "main"],
          cwd: repository,
          timeoutMs,
        }),
      ).rejects.toThrow("timeoutMs");
    }
    await expect(
      validate("repairReviewCommand", { route: "unknown", reason: "bad" }),
    ).rejects.toThrow("retry or blocked");
    await expect(validate("repairCiCommand", { route: "unknown", reason: "bad" })).rejects.toThrow(
      "retry or blocked",
    );
    await expect(
      validate("inspectCi", {
        route: "pending",
        reason: "running",
        relatedFailures: [],
        unrelatedFailures: [],
        trackingCommand: {
          command: "gh",
          args: ["run", "watch", "123"],
          cwd: repository,
          timeoutMs: 300_000,
        },
      }),
    ).resolves.toMatchObject({ trackingCommand: { args: ["run", "watch", "123"] } });
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
    if (track?.nodeType !== "action" || !("exec" in track)) {
      throw new Error("trackCi must be shell action");
    }
    const command = {
      command: "gh",
      args: ["pr", "checks", "--watch"],
      cwd: repository,
      timeoutMs: 300_000,
    };
    expect(
      await track.exec(
        makeContext({
          state: { steps: [{ nodeId: "inspectCi", output: { trackingCommand: command } }] },
        }),
      ),
    ).toMatchObject(command);
    expect(
      await track.exec(
        makeContext({
          state: {
            steps: [
              { nodeId: "inspectCi", output: { trackingCommand: command } },
              { nodeId: "repairCiCommand", output: { route: "retry", ...command } },
            ],
          },
        }),
      ),
    ).toMatchObject(command);
    expect(() => track.exec(makeContext())).toThrow("No CI tracking command");

    const review = autoimplementWorkflow.nodes.runReview;
    if (review?.nodeType !== "action" || !("exec" in review)) {
      throw new Error("runReview must be shell action");
    }
    expect(() => review.exec(makeContext())).toThrow("No output found");

    const delivery = autoimplementWorkflow.nodes.finalizeDelivery;
    if (delivery?.nodeType !== "agent") throw new Error("finalizeDelivery must be agent");
    expect(await delivery.prompt(makeContext({ input: { task: "demo", merge: false } }))).toContain(
      "without merging",
    );
    expect(await delivery.prompt(makeContext({ input: { task: "demo", merge: true } }))).toContain(
      "Merge the verified PR",
    );
    expect(() => delivery.validate?.({ status: "invalid" }, makeContext())).toThrow(
      "delivery status",
    );
    expect(() =>
      delivery.validate?.(
        { status: "completed", merged: true, reason: "merged" },
        makeContext({ input: { task: "demo", merge: false } }),
      ),
    ).toThrow("explicit merge: true");
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
        output: {
          branch: "feat/cutover",
          baseBranch: "main",
          headRevision: "cutover123",
          pr: "https://example.test/pr/2",
          pushed: true,
        },
      })
      .respond("authorReviewCommand", { output: reviewerCommand() })
      .respond("assessReview", { output: cleanReview() })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: { route: "green", reason: "green", relatedFailures: [], unrelatedFailures: [] },
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
    expect(edge("inspectComments")).toMatchObject({
      switch: { cases: { blocked: "challengeBlockerGuard" } },
    });
    expect(edge("inspectCi")).toMatchObject({
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
    expect(edge("finalizeDelivery")).toMatchObject({
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
          invocationSucceeded: true,
          p0: [],
          p1: [],
          p2: [{ kind: "implementation", summary: "simplify one branch" }],
          lower: [],
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
        },
      })
      .respond("inspectComments", {
        output: { route: "ci", summary: "no actionable comments", evidence: [] },
      })
      .respond("inspectCi", {
        output: {
          route: "green",
          reason: "all checks passed",
          relatedFailures: [],
          unrelatedFailures: [],
        },
      })
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
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "authorReviewCommand"),
    ).toHaveLength(1);
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
      .respond(
        "publish",
        {
          output: {
            branch: "feat/demo",
            baseBranch: "main",
            headRevision: "one",
            pr: "https://example.test/pr/1",
            pushed: true,
          },
        },
        {
          output: {
            branch: "feat/demo",
            baseBranch: "main",
            headRevision: "two",
            pr: "https://example.test/pr/1",
            pushed: true,
          },
        },
      )
      .respond("authorReviewCommand", { output: reviewerCommand() }, { output: reviewerCommand() })
      .respond(
        "assessReview",
        {
          output: {
            invocationSucceeded: true,
            p0: [],
            p1: [{ kind: "implementation", summary: "fix race" }],
            p2: [],
            lower: [],
            reason: "One P1.",
          },
        },
        { output: cleanReview() },
      )
      .respond("fix", { output: { fixed: "fixed race", files: ["src/change.ts"] } })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: { route: "green", reason: "green", relatedFailures: [], unrelatedFailures: [] },
      })
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

    expect(state.status).toBe("completed");
    expect(
      executor.requests.filter((request) => request.contract.nodeId === "assessReview"),
    ).toHaveLength(2);
    const result = state.finalOutput as { reviewRounds: unknown[] };
    expect(result.reviewRounds).toHaveLength(2);
  });

  it("asks for a corrected reviewer command after an invocation failure", async () => {
    const executor = commonExecutor("/missing-review-cwd")
      .respond("repairReviewCommand", {
        output: { route: "retry", ...reviewerCommand(), reason: "corrected cwd" },
      })
      .respond("assessReview", { output: cleanReview() })
      .respond("inspectComments", {
        output: { route: "ci", summary: "clear", evidence: [] },
      })
      .respond("inspectCi", {
        output: { route: "green", reason: "green", relatedFailures: [], unrelatedFailures: [] },
      })
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

  it("routes a five-minute CI timeout to opportunistic tests", () => {
    const compiled = compileWorkflowDefinition(autoimplementWorkflow);
    const track = compiled.nodes.trackCi;
    const edge = compiled.edges.find((candidate) => candidate.from === "trackCi");
    expect(track?.timeoutMs).toBe(FIVE_MINUTES_FOR_TEST + 10_000);
    expect(edge).toMatchObject({
      switch: {
        on: "$result.outcome",
        cases: { timed_out: "opportunisticTest" },
      },
    });
  });
});

const FIVE_MINUTES_FOR_TEST = 5 * 60_000;
