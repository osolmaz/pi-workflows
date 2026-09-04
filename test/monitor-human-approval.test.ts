import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { resolveWorkflowRef } from "../src/workflows/loader.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, HumanDecisionResponse } from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);
let originalPath = "";
let repository = "";

function repairObservation() {
  return {
    route: "act",
    goalState: "incomplete",
    workState: "failed",
    observation: "A deterministic test fails.",
    report: "A repair is available.",
    targetStateId: "test-a:one",
    authorizedActions: ["repair test-a with operator approval"],
    reason: "Repair is authorized.",
    action: {
      kind: "repair",
      incomplete: "test-a must pass",
      evidence: { test: "test-a" },
      nextAction: "Fix the deterministic test",
      authority: {
        status: "authorized",
        basis: "The task authorizes repair in the current repository.",
        allowedMutations: ["source and tests in the current repository"],
        forbiddenMutations: ["unrelated repositories"],
        costLimit: "No paid resources",
        providerRuntime: "Keep the current runtime",
        requiredChecks: ["run test-a"],
        stopConditions: ["stop if the repair leaves scope"],
        allowedRecoveryActions: ["repair test-a"],
        repository,
        baseBranch: "main",
        merge: true,
        repairApproval: { mode: "required", audience: "operator", maxReplans: 3 },
      },
      cost: {
        paidAction: false,
        status: "not-applicable",
        evidence: "The repair uses local resources.",
      },
      defect: {
        sharedCodeOrDataDefect: true,
        paidRunners: "stopped",
        evidence: "No affected paid workers are active.",
      },
      verification: "Run test-a and confirm it passes.",
      failureId: "test-a",
      targetStateId: "test-a:one",
    },
  };
}

function stopObservation() {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "The test passes.",
    report: "The repair is verified.",
    targetStateId: "test-a:two",
    authorizedActions: [],
    reason: "Complete.",
  };
}

function designResponses(executor: ScriptedExecutor, rounds: number): ScriptedExecutor {
  const repeated = <T>(value: T): Array<{ output: T }> =>
    Array.from({ length: rounds }, () => ({ output: structuredClone(value) }));
  return executor
    .respond(
      "planChange/design/captureIntent",
      ...repeated({ originalUserInstructions: "repair the test failure" }),
    )
    .respond(
      "planChange/design/frame",
      ...repeated({
        problem: "test failure",
        success: ["passes"],
        inScope: ["repository"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repository",
      }),
    )
    .respond(
      "planChange/design/solutions",
      ...repeated({
        candidates: [
          {
            id: "fix",
            title: "Fix",
            gist: "Fix the code.",
            solution: "fix",
            rationale: "owned",
            parts: ["code"],
            tradeoffs: [],
          },
          {
            id: "replace",
            title: "Replace",
            gist: "Replace the code.",
            solution: "replace",
            rationale: "possible",
            parts: ["replacement"],
            tradeoffs: ["larger"],
          },
        ],
        previousPlan: { status: "candidate", candidateId: "fix" },
      }),
    )
    .respond(
      "planChange/design/holyGrail",
      ...repeated({ ideal: "correct", outsideDependencies: [], additionalValue: [] }),
    )
    .respond(
      "planChange/design/select",
      ...repeated({
        status: "ready",
        selectedId: "fix",
        why: "in scope",
        relationshipToIdeal: "same",
        rejected: [
          { id: "replace", reason: "larger than needed" },
          { id: "ideal", reason: "the fix reaches it" },
        ],
        compromises: [],
      }),
    )
    .respond(
      "planChange/design/plan",
      ...Array.from({ length: rounds }, (_, index) => ({
        output: {
          summary: index === 0 ? "first plan" : "revised plan",
          steps: [
            { change: index === 0 ? "first" : "revised", where: "src", verification: "test" },
          ],
          contracts: [],
          tests: ["test"],
          risks: [],
          boundaries: [],
        },
      })),
    )
    .respond(
      "planChange/design/readySummary/summarize",
      ...Array.from({ length: rounds }, () => () => ({
        output: "Fix the code. Replacing it is unnecessary; the ideal adds no value.",
        assistantMessage: { sha256: "a".repeat(64) },
      })),
    )
    .respond(
      "planChange/documentation/inspectDocumentation",
      ...repeated({
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "Current.",
        evidence: "checked",
      }),
    );
}

function completedRepairExecutor(rounds = 1): ScriptedExecutor {
  return designResponses(
    new ScriptedExecutor().respond(
      "observe",
      { output: repairObservation() },
      { output: stopObservation() },
    ),
    rounds,
  )
    .respond("implementation/implement", {
      output: {
        status: "implemented",
        summary: "fixed",
        files: ["src/a.ts"],
        issueKind: null,
        evidence: "change",
      },
    })
    .respond("implementation/classifyImplementation", {
      output: { route: "verify", summary: "ready", evidence: "change" },
    })
    .respond("implementation/planVerification", {
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
    .respond("implementation/verify", {
      output: { passed: true, commands: [], failures: [], untested: [] },
    })
    .respond("implementation/classifyVerification", {
      output: { route: "publish", summary: "passed", evidence: "test" },
    })
    .respond("implementation/publish", {
      output: {
        repositories: [
          {
            repository,
            branch: "feat/fix",
            baseBranch: "main",
            headRevision: "revision",
            pr: "https://example.test/pr/1",
            pushed: true,
          },
        ],
      },
    })
    .respond("implementation/assessReview", {
      output: {
        repositories: [
          {
            id: repositoryId(repository),
            invocationSucceeded: true,
            p0: [],
            p1: [],
            p2: [],
            lower: [],
            reason: "clean",
          },
        ],
        reason: "clean",
      },
    })
    .respond("implementation/inspectComments", {
      output: { route: "ci", summary: "none", evidence: [] },
    })
    .respond("implementation/inspectCi", {
      output: {
        targets: [
          {
            repository,
            headRevision: "revision",
            pr: "https://example.test/pr/1",
            route: "green",
            reason: "green",
            relatedFailures: [],
            unrelatedFailures: [],
          },
        ],
      },
    })
    .respond("implementation/finalizeDelivery", {
      output: {
        status: "completed",
        merged: true,
        pr: "https://example.test/pr/1",
        reportComment: "reported",
        reason: "merged",
      },
    });
}

function makeEngine(executor: ScriptedExecutor, store: WorkflowRunStore): WorkflowEngine {
  return new WorkflowEngine({
    executor,
    store,
    notificationSink: {
      notify() {
        return { notificationId: "notification", targetSessionId: "session" };
      },
    },
  });
}

async function answer(
  store: WorkflowRunStore,
  executor: ScriptedExecutor,
  definition: Awaited<ReturnType<typeof resolveWorkflowRef>>["definition"],
  parentRunId: string,
  response: HumanDecisionResponse,
) {
  const parent = store.readRun(parentRunId);
  if (parent === null) throw new Error("missing waiting bundle");
  const request = parent.state.finalOutput as HumanDecisionRequest;
  if (request?.choices === undefined) {
    throw new Error(`Invalid human decision request: ${JSON.stringify(request)}`);
  }
  const accepted = await new HumanDecisionStore(store.databasePath).accept(request, {
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    ...response,
    source: { channel: "pi", actorId: "person", eventId: `event-${parentRunId}` },
    idempotencyKey: `event-${parentRunId}`,
  });
  return await makeEngine(executor, store).continueRun(
    definition,
    parentRunId,
    {},
    { humanDecision: accepted.decision },
  );
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  repository = await makeTempDir("monitor-approval-repository");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await fs.writeFile(path.join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repository });
  await execFileAsync("git", ["switch", "-c", "feat/repair"], { cwd: repository });
  const commands = await makeTempDir("monitor-approval-commands");
  await fs.writeFile(path.join(commands, "pi-reviewer"), "#!/bin/sh\necho clean\n", {
    mode: 0o755,
  });
  process.env.PATH = `${commands}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("monitor human repair approval", () => {
  it("continues only after the verified human continue answer", async () => {
    const executor = completedRepairExecutor();
    const store = new WorkflowRunStore(await makeStateDatabasePath("monitor-approval-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-approval-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair test-a in the current repository with required operator approval. Merge is authorized.",
      stopWhen: "test passes",
      maxChecks: 3,
    });
    if (first.state.status !== "waiting") {
      throw new Error(
        `${first.state.error ?? "unknown"}\n${first.state.steps.map((step) => step.nodeId).join("\n")}`,
      );
    }
    expect(first.state.waitingOn).toBe("planChange/approval/approve");
    expect(first.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      false,
    );
    const continued = await answer(store, executor, resolved.definition, first.state.runId, {
      choice: "continue",
    });
    expect(continued.state.status).toBe("completed");
    expect(continued.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      true,
    );
    expect(continued.state.steps.filter((step) => step.nodeId === "observe")).toHaveLength(2);
    expect(
      continued.state.steps.filter((step) => step.nodeId.endsWith("approval/approve")),
    ).toHaveLength(1);
    expect(
      continued.state.steps.some(
        (step) => step.nodeId === "implementation/redesign/approval/approve",
      ),
    ).toBe(false);
  });

  it("stops truthfully when the operator rejects the repair", async () => {
    const executor = completedRepairExecutor();
    const store = new WorkflowRunStore(await makeStateDatabasePath("monitor-stop-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-stop-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair test-a in the current repository with required operator approval.",
      stopWhen: "test passes",
      maxChecks: 3,
    });
    const stopped = await answer(store, executor, resolved.definition, first.state.runId, {
      choice: "stop",
    });
    expect(stopped.state.status).toBe("completed");
    expect(stopped.state.finalOutput).toMatchObject({
      reason: "The operator stopped the proposed plan change.",
    });
    expect(stopped.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      false,
    );
  });

  it("feeds exact replan text to autoplan, documents the revision, and asks again", async () => {
    const executor = completedRepairExecutor(2);
    const store = new WorkflowRunStore(await makeStateDatabasePath("monitor-replan-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-replan-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair test-a in the current repository with required operator approval. Merge is authorized.",
      stopWhen: "test passes",
      maxChecks: 3,
    });
    const firstDigest = (first.state.finalOutput as { subject?: { planDigest?: string } }).subject
      ?.planDigest;
    const exact = "  use the smaller repair\nkeep this exact  ";
    const replanned = await answer(store, executor, resolved.definition, first.state.runId, {
      choice: "replan",
      input: { instructions: exact },
    });
    expect(replanned.state.status).toBe("waiting");
    expect(replanned.state.waitingOn).toBe("planChange/approval/approve");
    expect(
      (replanned.state.finalOutput as { subject?: { planDigest?: string } }).subject?.planDigest,
    ).not.toBe(firstDigest);
    const frameRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "planChange/design/frame",
    );
    expect(frameRequests).toHaveLength(2);
    expect(frameRequests[1]?.prompt).toContain(JSON.stringify(exact).slice(1, -1));
    const completed = await answer(store, executor, resolved.definition, replanned.state.runId, {
      choice: "continue",
    });
    expect(completed.state.status).toBe("completed");
    const steps = completed.state.steps.map((step) => step.nodeId);
    expect(steps.filter((step) => step === "planChange/documentation/finalize")).toHaveLength(2);
    expect(steps).toContain("implementation/implement");
  });
});
