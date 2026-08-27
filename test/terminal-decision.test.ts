import { describe, expect, it } from "vitest";
import {
  createTerminalLaunchSelection,
  evaluateRestartPolicy,
  MAX_RESTARTS,
  parseRestartLineage,
  parseTerminalLaunchSelection,
  restartChainRunIds,
  terminalSuccessorRunId,
  type RestartLineage,
} from "../src/extension/restart-policy.js";
import {
  buildTerminalDecisionContent,
  MAX_TERMINAL_RESULT_CHARS,
  terminalFingerprint,
  terminalReason,
  type TerminalDecision,
} from "../src/extension/terminal-decision.js";

function fingerprint(result: unknown): string {
  return terminalFingerprint({
    workflowSourceRef: "builtin:autoimplement",
    workflowSource: { root: { kind: "builtin", id: "autoimplement", revision: "r1" } },
    definitionDigest: `sha256:${"a".repeat(64)}`,
    input: { task: "finish it", nested: { exact: true } },
    state: "failed",
    result,
    reason: terminalReason({ state: "failed", error: "temporary failure" }),
  });
}

describe("terminal workflow decisions", () => {
  it("builds stable fingerprints from canonical terminal facts", () => {
    const first = fingerprint({ b: 2, a: 1 });
    const reordered = fingerprint({ a: 1, b: 2 });
    const changed = fingerprint({ a: 1, b: 3 });

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("classifies completed, blocked, timeout, maxSteps, cancellation, and launch failure", () => {
    expect(terminalReason({ state: "completed" })).toEqual({ kind: "completed", message: null });
    expect(terminalReason({ state: "completed", error: "blocked" })).toEqual({
      kind: "completed",
      message: "blocked",
    });
    expect(terminalReason({ state: "failed", error: "technical failure" })).toEqual({
      kind: "failed",
      message: "technical failure",
    });
    expect(terminalReason({ state: "timed_out", error: "node timed out" })).toEqual({
      kind: "timedOut",
      message: "node timed out",
    });
    expect(
      terminalReason({
        state: "failed",
        error: "Workflow exceeded maxSteps=2; aborting to avoid an unbounded loop",
      }),
    ).toEqual({
      kind: "maxSteps",
      message: "Workflow exceeded maxSteps=2; aborting to avoid an unbounded loop",
    });
    expect(terminalReason({ state: "cancelled", error: "cancelled" })).toEqual({
      kind: "cancelled",
      message: "cancelled",
    });
    expect(
      terminalReason({ state: "failed", error: "missing file", launchErrorCode: "not_found" }),
    ).toEqual({ kind: "launchFailed", message: "missing file" });
  });

  it("includes exact input, terminal reason, restart history, and bounded result", () => {
    const decision: TerminalDecision = {
      workflowName: "autoimplement",
      workflowSourceRef: "builtin:autoimplement",
      workflowSource: { root: { kind: "builtin", id: "autoimplement", revision: "r1" } },
      definitionDigest: `sha256:${"a".repeat(64)}`,
      runId: "run-2",
      input: { task: "exact task", constraints: ["keep scope"] },
      result: { report: "x".repeat(MAX_TERMINAL_RESULT_CHARS + 100) },
      state: "failed",
      reason: { kind: "maxSteps", message: "Workflow exceeded maxSteps=2" },
      restartNumber: 1,
      restartLimit: MAX_RESTARTS,
      history: [
        {
          runId: "run-1",
          state: "failed",
          reason: { kind: "failed", message: "temporary" },
          result: { progress: "first attempt saved one artifact" },
          fingerprint: `sha256:${"b".repeat(64)}`,
        },
      ],
      fingerprint: `sha256:${"c".repeat(64)}`,
    };

    const content = buildTerminalDecisionContent(decision, "Explain the result plainly.");

    expect(content).toContain(
      "A workflow run ended, but that does not prove the user's task is complete.",
    );
    expect(content).toContain('"task": "exact task"');
    expect(content).toContain('"kind": "maxSteps"');
    expect(content).toContain('"runId": "run-1"');
    expect(content).toContain("Earlier terminal outcome 1 result (run-1):");
    expect(content).toContain("first attempt saved one artifact");
    expect(content).toContain("Explain the result plainly.");
    expect(content).toContain(
      "[result truncated; inspect workflow status for the complete result]",
    );
    expect(content).not.toContain("originalUserMessage");
    expect(content).not.toContain("original user message");
  });

  it("preserves a blocked completed result for the model's terminal decision", () => {
    const decision: TerminalDecision = {
      workflowName: "autodoc",
      workflowSourceRef: "builtin:autodoc",
      workflowSource: { root: { kind: "builtin", id: "autodoc", revision: "r1" } },
      definitionDigest: `sha256:${"d".repeat(64)}`,
      runId: "blocked-run",
      input: { task: "record the plan" },
      result: { status: "blocked", reason: "A maintainer decision is required." },
      state: "completed",
      reason: { kind: "completed", message: null },
      restartNumber: 0,
      restartLimit: MAX_RESTARTS,
      history: [],
      fingerprint: `sha256:${"e".repeat(64)}`,
    };

    const content = buildTerminalDecisionContent(decision);

    expect(content).toContain('"status": "blocked"');
    expect(content).toContain("A maintainer decision is required.");
    expect(content).toContain("the user must make a decision");
  });
});

describe("workflow restart policy", () => {
  it("allows changed outcomes and rejects a repeated outcome", () => {
    const firstFingerprint = fingerprint({ error: "first" });
    const first = evaluateRestartPolicy({
      runId: "run-1",
      terminalFingerprint: firstFingerprint,
      lineage: undefined,
      lineageForRun: () => undefined,
    });
    const lineageByRun = new Map<string, RestartLineage>([["run-2", first.lineage]]);

    expect(() =>
      evaluateRestartPolicy({
        runId: "run-2",
        terminalFingerprint: firstFingerprint,
        lineage: first.lineage,
        lineageForRun: (runId) => lineageByRun.get(runId),
      }),
    ).toThrow(/same terminal outcome/u);

    const second = evaluateRestartPolicy({
      runId: "run-2",
      terminalFingerprint: fingerprint({ error: "made progress, then failed differently" }),
      lineage: first.lineage,
      lineageForRun: (runId) => lineageByRun.get(runId),
    });
    expect(second.lineage).toMatchObject({
      rootRunId: "run-1",
      parentRunId: "run-2",
      restartNumber: 2,
    });
    expect(second.chainRunIds).toEqual(["run-1", "run-2"]);
  });

  it("enforces three restarts across a valid chain", () => {
    const root = evaluateRestartPolicy({
      runId: "run-1",
      terminalFingerprint: fingerprint(1),
      lineage: undefined,
      lineageForRun: () => undefined,
    });
    const lineages = new Map<string, RestartLineage>([["run-2", root.lineage]]);
    const second = evaluateRestartPolicy({
      runId: "run-2",
      terminalFingerprint: fingerprint(2),
      lineage: root.lineage,
      lineageForRun: (runId) => lineages.get(runId),
    });
    lineages.set("run-3", second.lineage);
    const third = evaluateRestartPolicy({
      runId: "run-3",
      terminalFingerprint: fingerprint(3),
      lineage: second.lineage,
      lineageForRun: (runId) => lineages.get(runId),
    });
    lineages.set("run-4", third.lineage);

    expect(third.lineage.restartNumber).toBe(3);
    expect(() =>
      evaluateRestartPolicy({
        runId: "run-4",
        terminalFingerprint: fingerprint(4),
        lineage: third.lineage,
        lineageForRun: (runId) => lineages.get(runId),
      }),
    ).toThrow(/restart limit reached/u);
    expect(restartChainRunIds("run-4", third.lineage, (runId) => lineages.get(runId))).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ]);
  });

  it("creates strict durable lineage and idempotent terminal selections", () => {
    const selection = createTerminalLaunchSelection({
      sourceRunId: "run-1",
      turnIntentId: "intent-1",
      toolCallId: "call-1",
      request: { action: "restart", runId: "run-1" },
    });
    expect(parseTerminalLaunchSelection(selection)).toEqual(selection);
    expect(terminalSuccessorRunId("intent-1")).toBe(terminalSuccessorRunId("intent-1"));
    expect(terminalSuccessorRunId("intent-2")).not.toBe(terminalSuccessorRunId("intent-1"));

    const lineage = evaluateRestartPolicy({
      runId: "run-1",
      terminalFingerprint: fingerprint("one"),
      lineage: undefined,
      lineageForRun: () => undefined,
    }).lineage;
    expect(parseRestartLineage(lineage)).toEqual(lineage);
    expect(() => parseRestartLineage({ ...lineage, extra: true })).toThrow(/lineage is invalid/u);
    expect(() => parseTerminalLaunchSelection({ ...selection, toolCallId: 1 })).toThrow(
      /selection is invalid/u,
    );
  });
});
