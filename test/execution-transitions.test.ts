import { describe, expect, it } from "vitest";
import { applyExecutionTransition, type WorkflowTransition } from "../src/workflows/transitions.js";
import type { WorkflowDefinitionSnapshot, WorkflowRunState } from "../src/workflows/types.js";

const now = "2026-09-06T00:00:00.000Z";
const definition: WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1",
  name: "transitions",
  startAt: "work",
  nodes: { work: { nodeType: "compute" } },
  edges: [],
};

function state(): WorkflowRunState {
  return {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 1,
    runId: "run-one",
    workflowName: "transitions",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: { task: "keep the original input" },
    outputs: {},
    results: {},
    steps: [],
  };
}

const start: WorkflowTransition = {
  kind: "startAttempt",
  startedAt: now,
  event: {
    scope: "node",
    type: "node_started",
    nodeId: "work",
    attemptId: "attempt-one",
    payload: { nodeType: "compute" },
  },
};

function apply(current: WorkflowRunState, transition: WorkflowTransition) {
  return applyExecutionTransition(current, definition, transition, now);
}

describe("host-owned execution transitions", () => {
  it("changes only the named attempt and preserves the original projection", () => {
    const original = state();
    const active = apply(original, start);
    expect(original.currentAttemptId).toBeUndefined();
    expect(active.currentAttemptId).toBe("attempt-one");
    expect(active.input).toEqual(original.input);
    const completed = apply(active, {
      kind: "finishAttempt",
      step: {
        attemptId: "attempt-one",
        nodeId: "work",
        nodeType: "compute",
        outcome: "ok",
        startedAt: now,
        finishedAt: now,
        prompt: null,
        output: { result: 1 },
      },
      event: {
        scope: "node",
        type: "node_finished",
        nodeId: "work",
        attemptId: "attempt-one",
        payload: { outcome: "ok", output: { result: 1 } },
      },
    });
    expect(completed.outputs.work).toEqual({ result: 1 });
    expect(completed.currentAttemptId).toBeUndefined();
    expect(completed.steps).toHaveLength(1);
    expect(active.steps).toEqual([]);
  });

  it("rejects stale attempts and conflicting outcomes without changing state", () => {
    const active = apply(state(), start);
    const before = structuredClone(active);
    expect(() =>
      apply(active, { ...start, event: { ...start.event, attemptId: "another" } }),
    ).toThrow(/already active/);
    expect(() =>
      apply(active, {
        kind: "setDeadline",
        deadlineAt: now,
        event: {
          scope: "node",
          type: "node_deadline_set",
          nodeId: "work",
          attemptId: "another",
          payload: {},
        },
      }),
    ).toThrow(/active attempt/);
    expect(() =>
      apply(active, {
        kind: "finish",
        status: "completed",
        event: { scope: "run", type: "run_completed", payload: {} },
      }),
    ).toThrow(/unfinished attempt/);
    expect(() =>
      apply(active, {
        kind: "record",
        event: { scope: "run", type: "run_completed", payload: {} },
      }),
    ).toThrow(/Unknown execution event/);
    expect(active).toEqual(before);
  });

  it("cannot revive terminal execution or use an unknown node", () => {
    const current = state();
    expect(() => apply({ ...current, status: "completed" }, start)).toThrow(/status completed/);
    expect(() =>
      apply(current, { ...start, event: { ...start.event, nodeId: "missing" } }),
    ).toThrow(/definition/);
    expect(current).toEqual(state());
  });

  it("does not mark a waiting run as finished", () => {
    const waiting = apply(state(), {
      kind: "finish",
      status: "waiting",
      finalOutput: { question: "continue?" },
      event: { scope: "run", type: "run_waiting", payload: {} },
    });
    expect(waiting.status).toBe("waiting");
    expect(waiting.finishedAt).toBeUndefined();
  });
});
