import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { resolveWorkflowRef } from "../src/workflows/loader.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, HumanDecisionResponse } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

let originalPath = "";
let repository = "";

function repairCheck() {
  return {
    route: "repair",
    observation: "A deterministic test fails.",
    report: "A repair is available.",
    reason: "Repair is authorized.",
    repair: {
      problem: "Fix the deterministic test",
      evidence: { test: "test-a" },
      issueFingerprint: "test-a:one",
    },
  };
}

function stopCheck() {
  return {
    route: "stop",
    observation: "The test passes.",
    report: "The repair is verified.",
    reason: "Complete.",
  };
}

function designResponses(executor: ScriptedExecutor, rounds: number): ScriptedExecutor {
  const repeated = <T>(value: T): Array<{ output: T }> =>
    Array.from({ length: rounds }, () => ({ output: structuredClone(value) }));
  return executor
    .respond(
      "initialDesign/frame",
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
      "initialDesign/propose",
      ...repeated({ solution: "fix", rationale: "owned", parts: ["code"], tradeoffs: [] }),
    )
    .respond(
      "initialDesign/ideal",
      ...repeated({ ideal: "correct", outsideDependencies: [], additionalValue: [] }),
    )
    .respond(
      "initialDesign/choose",
      ...repeated({
        status: "ready",
        selected: "fix",
        why: "in scope",
        relationshipToIdeal: "same",
        excluded: [],
        compromises: [],
      }),
    )
    .respond(
      "initialDesign/plan",
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
      "documentation/inspectDocumentation",
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
    new ScriptedExecutor().respond("check", { output: repairCheck() }, { output: stopCheck() }),
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
    .respond("implementation/verify", {
      output: { passed: true, commands: [], failures: [], untested: [] },
    })
    .respond("implementation/classifyVerification", {
      output: { route: "publish", summary: "passed", evidence: "test" },
    })
    .respond("implementation/publish", {
      output: {
        branch: "feat/fix",
        baseBranch: "main",
        headRevision: "revision",
        pr: "https://example.test/pr/1",
        pushed: true,
      },
    })
    .respond("implementation/authorReviewCommand", {
      output: {
        command: "pi-reviewer",
        args: ["--base", "main"],
        cwd: repository,
        timeoutMs: 600_000,
      },
    })
    .respond("implementation/assessReview", {
      output: {
        invocationSucceeded: true,
        p0: [],
        p1: [],
        p2: [],
        lower: [],
        reason: "clean",
      },
    })
    .respond("implementation/inspectComments", {
      output: { route: "ci", summary: "none", evidence: [] },
    })
    .respond("implementation/inspectCi", {
      output: {
        route: "green",
        reason: "green",
        relatedFailures: [],
        unrelatedFailures: [],
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
  const parent = await import("../src/workflows/store.js").then(
    async ({ readRunBundle }) => await readRunBundle(store.runDirFor(parentRunId)),
  );
  if (parent === null) throw new Error("missing waiting bundle");
  const request = parent.state.finalOutput as HumanDecisionRequest;
  if (request?.choices === undefined) {
    throw new Error(`Invalid human decision request: ${JSON.stringify(request)}`);
  }
  const accepted = await new HumanDecisionStore(store.outputRoot).accept(request, {
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
  const commands = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-approval-commands-"));
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
    const store = new WorkflowRunStore(await makeTempDir("monitor-approval-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-approval-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        merge: true,
        approval: { audience: "operator", maxReplans: 3 },
      },
    });
    if (first.state.status !== "waiting") {
      throw new Error(
        `${first.state.error ?? "unknown"}\n${first.state.steps.map((step) => step.nodeId).join("\n")}`,
      );
    }
    expect(first.state.waitingOn).toBe("approval/approve");
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
    expect(continued.state.steps.filter((step) => step.nodeId === "check")).toHaveLength(2);
  });

  it("stops truthfully when the operator rejects the repair", async () => {
    const executor = completedRepairExecutor();
    const store = new WorkflowRunStore(await makeTempDir("monitor-stop-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-stop-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        approval: { audience: "operator", maxReplans: 3 },
      },
    });
    const stopped = await answer(store, executor, resolved.definition, first.state.runId, {
      choice: "stop",
    });
    expect(stopped.state.status).toBe("completed");
    expect(stopped.state.finalOutput).toMatchObject({
      reason: "The operator stopped the proposed repair.",
    });
    expect(stopped.state.steps.some((step) => step.nodeId === "implementation/implement")).toBe(
      false,
    );
  });

  it("feeds exact replan text to autoplan, documents the revision, and asks again", async () => {
    const executor = completedRepairExecutor(2);
    const store = new WorkflowRunStore(await makeTempDir("monitor-replan-runs"));
    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("monitor-replan-home") },
      builtinWorkflowCatalog,
    );
    const first = await makeEngine(executor, store).run(resolved.definition, {
      task: "Monitor and repair",
      stopWhen: "test passes",
      maxChecks: 3,
      repair: {
        authorized: true,
        repository,
        merge: true,
        approval: { audience: "operator", maxReplans: 3 },
      },
    });
    const firstDigest = (first.state.finalOutput as { body?: { planDigest?: string } }).body
      ?.planDigest;
    const exact = "  use the smaller repair\nkeep this exact  ";
    const replanned = await answer(store, executor, resolved.definition, first.state.runId, {
      choice: "replan",
      input: { instructions: exact },
    });
    expect(replanned.state.status).toBe("waiting");
    expect(replanned.state.waitingOn).toBe("approval/approve");
    expect(
      (replanned.state.finalOutput as { body?: { planDigest?: string } }).body?.planDigest,
    ).not.toBe(firstDigest);
    const frameRequests = executor.requests.filter(
      (request) => request.contract.nodeId === "initialDesign/frame",
    );
    expect(frameRequests).toHaveLength(2);
    expect(frameRequests[1]?.prompt).toContain(JSON.stringify(exact).slice(1, -1));
    const completed = await answer(store, executor, resolved.definition, replanned.state.runId, {
      choice: "continue",
    });
    expect(completed.state.status).toBe("completed");
    const steps = completed.state.steps.map((step) => step.nodeId);
    expect(steps.filter((step) => step === "documentation/finalize")).toHaveLength(2);
    expect(steps).toContain("implementation/implement");
  });
});
