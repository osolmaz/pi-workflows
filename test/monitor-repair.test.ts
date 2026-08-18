import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { resolveWorkflowRef } from "../src/workflows/loader.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowNotificationRequest } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

let originalPath = "";
let repository = "";

function repairCheck() {
  return {
    route: "repair",
    observation: "A deterministic test fails in target state one.",
    report: "A fixable test failure was found.",
    reason: "Repair is authorized and in scope.",
    repair: {
      problem: "Fix the deterministic test failure",
      evidence: { test: "test-a", state: "one" },
      issueFingerprint: "test-a:state-one",
    },
  };
}

function stopCheck() {
  return {
    route: "stop",
    observation: "The test passes in target state two.",
    report: "The repair is verified.",
    reason: "The monitored success condition is true.",
  };
}

function repairExecutor(secondCheck: unknown): ScriptedExecutor {
  return new ScriptedExecutor()
    .respond("check", { output: repairCheck() }, { output: secondCheck })
    .respond("initialDesign/frame", {
      output: {
        problem: "test failure",
        success: ["test passes"],
        inScope: ["repo"],
        outOfScope: [],
        constraints: [],
        controlBoundary: "repo",
      },
    })
    .respond("initialDesign/propose", {
      output: { solution: "fix code", rationale: "owned", parts: ["code"], tradeoffs: [] },
    })
    .respond("initialDesign/ideal", {
      output: { ideal: "correct code", outsideDependencies: [], additionalValue: [] },
    })
    .respond("initialDesign/choose", {
      output: {
        status: "ready",
        selected: "fix code",
        why: "in scope",
        relationshipToIdeal: "same",
        excluded: [],
        compromises: [],
      },
    })
    .respond("initialDesign/plan", {
      output: {
        summary: "fix test",
        steps: [{ change: "fix", where: "src", verification: "test-a" }],
        contracts: [],
        tests: ["test-a"],
        risks: [],
        boundaries: [],
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
        branch: "feat/fix",
        baseBranch: "main",
        headRevision: "revision-two",
        pr: "https://example.test/pr/2",
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
      output: { route: "ci", summary: "clear", evidence: [] },
    })
    .respond("implementation/inspectCi", {
      output: { route: "green", reason: "green", relatedFailures: [], unrelatedFailures: [] },
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
  it("devises, implements, and then checks the target again", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(stopCheck()),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-repair")),
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
        task: "Monitor and repair test-a",
        stopWhen: "test-a passes",
        maxChecks: 3,
        repair: { authorized: true, scope: "current repository", repository },
      },
      { workflowSource: resolved.source },
    );

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toContain("initialDesign/frame");
    expect(state.steps.map((step) => step.nodeId)).toContain("implementation/implement");
    expect(state.steps.filter((step) => step.nodeId === "check")).toHaveLength(2);
    expect(notifications.map((item) => item.content)).toEqual([
      "A fixable test failure was found.",
      "The repair is verified.",
    ]);
    expect(state.workflowSources?.map((item) => item.mountPath.join("/"))).toEqual([
      "implementation",
      "implementation/redesign",
      "initialDesign",
    ]);
    expect(state.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("stops when the same target evidence returns after repair", async () => {
    const notifications: WorkflowNotificationRequest[] = [];
    const engine = new WorkflowEngine({
      executor: repairExecutor(repairCheck()),
      store: new WorkflowRunStore(await makeTempDir("pi-workflows-monitor-no-progress")),
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
        task: "Monitor and repair test-a",
        stopWhen: "test-a passes",
        maxChecks: 3,
        repair: { authorized: true, scope: "current repository", repository },
      },
      { workflowSource: resolved.source },
    );

    expect(state.status).toBe("completed");
    expect(state.steps.filter((step) => step.nodeId === "implementation")).toHaveLength(1);
    expect(state.steps.map((step) => step.nodeId)).toContain("repairBlocked");
    expect(state.finalOutput).toMatchObject({
      reason: "The same issue returned after a completed repair with no changed target evidence.",
    });
    expect(notifications.at(-1)?.content).toContain("Automatic repair stopped");
  });
});
