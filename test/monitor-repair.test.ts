import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryId } from "../src/builtins/autoimplement-command-batches.js";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { resolveWorkflowRef } from "../src/workflows/loader.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowNotificationRequest } from "../src/workflows/types.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

let originalPath = "";
let repository = "";

function repairObservation() {
  return {
    route: "act",
    goalState: "incomplete",
    workState: "failed",
    observation: "A deterministic test fails in target state one.",
    report: "A fixable test failure was found.",
    targetStateId: "test-a:state-one",
    authorizedActions: ["repair test-a in the current repository"],
    reason: "Repair is authorized and in scope.",
    action: {
      kind: "repair",
      incomplete: "test-a must pass",
      evidence: { test: "test-a", state: "one" },
      nextAction: "Fix the deterministic test failure",
      authority: {
        status: "authorized",
        basis: "The task authorizes repair in the current repository.",
        allowedMutations: ["source and tests in the current repository"],
        forbiddenMutations: ["unrelated repositories"],
        costLimit: "No paid resources",
        providerRuntime: "Keep the current runtime",
        requiredChecks: ["run test-a"],
        stopConditions: ["stop if the defect requires a protected contract change"],
        allowedRecoveryActions: ["repair this deterministic defect"],
        repository,
        baseBranch: "main",
        merge: true,
        repairApproval: { mode: "skip" },
      },
      cost: {
        paidAction: false,
        status: "not-applicable",
        evidence: "The repair uses local resources.",
      },
      defect: {
        sharedCodeOrDataDefect: true,
        paidWorkers: "stopped",
        evidence: "No affected paid worker is active.",
      },
      verification: "Run test-a and confirm it passes.",
      failureId: "test-a",
      targetStateId: "test-a:state-one",
    },
  };
}

function stopObservation() {
  return {
    route: "stop",
    goalState: "complete",
    workState: "stopped",
    observation: "The test passes in target state two.",
    report: "The repair is verified.",
    targetStateId: "test-a:state-two",
    authorizedActions: [],
    reason: "The monitored success condition is true.",
  };
}

function repairExecutor(secondObservation: unknown): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("observe", { output: repairObservation() }, { output: secondObservation })
    .respond("planChange/design/frame", {
      output: {
        problem: "test failure",
        success: ["test passes"],
        inScope: ["repo"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repo",
      },
    })
    .respond("planChange/design/propose", {
      output: { solution: "fix code", rationale: "owned", parts: ["code"], tradeoffs: [] },
    })
    .respond("planChange/design/ideal", {
      output: { ideal: "correct code", outsideDependencies: [], additionalValue: [] },
    })
    .respond("planChange/design/choose", {
      output: {
        status: "ready",
        selected: "fix code",
        why: "in scope",
        relationshipToIdeal: "same",
        excluded: [],
        compromises: [],
      },
    })
    .respond("planChange/design/plan", {
      output: {
        summary: "fix test",
        steps: [{ change: "fix", where: "src", verification: "test-a" }],
        contracts: [],
        tests: ["test-a"],
        risks: [],
        boundaries: [],
      },
    })
    .respond("planChange/documentation/inspectDocumentation", {
      output: {
        route: "current",
        files: ["docs/spec.md", "docs/plans/plan.md"],
        reason: "The repair plan is documented.",
        evidence: "checked",
      },
    })
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
      output: {
        passed: true,
        commands: [{ command: "test-a", outcome: "passed" }],
        failures: [],
        untested: [],
      },
    })
    .respond("implementation/classifyVerification", {
      output: { route: "publish", summary: "passed", evidence: "test-a" },
    })
    .respond("implementation/publish", {
      output: {
        repositories: [
          {
            repository,
            branch: "feat/fix",
            baseBranch: "main",
            headRevision: "revision-two",
            pr: "https://example.test/pr/2",
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
      output: { route: "ci", summary: "clear", evidence: [] },
    })
    .respond("implementation/inspectCi", {
      output: {
        targets: [
          {
            repository,
            headRevision: "revision-two",
            pr: "https://example.test/pr/2",
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
        pr: "https://example.test/pr/2",
        reportComment: "https://example.test/pr/2#comment",
        reason: "merged",
      },
    });
}

beforeEach(async () => {
  originalPath = process.env.PATH ?? "";
  const commandDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-monitor-commands-"));
  repository = await makeTempDir("pi-workflows-monitor-repo");
  await fs.writeFile(path.join(commandDir, "pi-reviewer"), "#!/bin/sh\necho clean\n", {
    mode: 0o755,
  });
  process.env.PATH = `${commandDir}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("monitor automatic repair", () => {
  it("uses the shared repair workflows and then observes immediately", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(stopObservation()),
      store: new WorkflowRunStore(await makeStateDatabasePath("pi-workflows-monitor-repair")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("pi-workflows-monitor-home") },
      builtinWorkflowCatalog,
    );
    const { state } = await engine.run(
      resolved.definition,
      {
        task: "Monitor and repair test-a in the current repository. Merge is authorized. Do not use paid resources.",
        stopWhen: "test-a passes",
        maxChecks: 3,
      },
      { workflowSource: resolved.source },
    );

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toContain("planChange/design/frame");
    expect(state.steps.map((step) => step.nodeId)).toContain("implementation/implement");
    expect(state.steps.filter((step) => step.nodeId === "observe")).toHaveLength(2);
    const repairCompleteIndex = state.steps.findIndex((step) => step.nodeId === "repairComplete");
    expect(state.steps[repairCompleteIndex + 1]?.nodeId).toBe("observe");
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.content).toContain("Next action: Fix the deterministic test failure");
    expect(notifications[1]?.content).toContain("Goal: complete");
    expect(notifications[1]?.content).toContain("Last action: Fix the deterministic test failure");
    expect(state.workflowSources?.map((item) => item.mountPath.join("/"))).toEqual([
      "implementation",
      "implementation/documentation",
      "implementation/redesign",
      "implementation/redesign/approval",
      "implementation/redesign/design",
      "implementation/redesign/documentation",
      "planChange",
      "planChange/approval",
      "planChange/design",
      "planChange/documentation",
    ]);
    expect(state.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("stops when the same failure and target state return after repair", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(repairObservation()),
      store: new WorkflowRunStore(await makeStateDatabasePath("pi-workflows-monitor-no-progress")),
      notificationSink: {
        notify(request) {
          notifications.push(request);
          return { notificationId: `n${notifications.length}`, targetSessionId: "s1" };
        },
      },
    });

    const resolved = await resolveWorkflowRef(
      "monitor",
      { cwd: repository, homeDir: await makeTempDir("pi-workflows-monitor-home") },
      builtinWorkflowCatalog,
    );
    const { state } = await engine.run(
      resolved.definition,
      {
        task: "Monitor and repair test-a in the current repository. Merge is authorized. Do not use paid resources.",
        stopWhen: "test-a passes",
        maxChecks: 3,
      },
      { workflowSource: resolved.source },
    );

    expect(state.status).toBe("completed");
    expect(state.steps.filter((step) => step.nodeId === "implementation")).toHaveLength(1);
    expect(state.steps.filter((step) => step.nodeId === "repairComplete")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).not.toContain("repairBlocked");
    expect(state.finalOutput).toMatchObject({
      goalState: "blocked",
      reason: "Repair stopped because test-a returned in target state test-a:state-one.",
    });
    expect(notifications.at(-1)?.content).toContain(
      "same failure and target state returned after one completed repair",
    );
  });
});
