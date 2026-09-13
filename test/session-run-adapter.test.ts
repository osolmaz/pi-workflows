import { describe, expect, it } from "vitest";
import {
  SESSION_RUN_VIEW_SCHEMA,
  type WorkflowSessionNodeRow,
  type WorkflowSessionRunView,
} from "../src/client/view.js";
import { widgetRunInput } from "../src/extension/session-run-adapter.js";

function nodeRow(overrides: Partial<WorkflowSessionNodeRow> & { nodeId: string }) {
  return {
    nodeType: "compute",
    actionExecution: null,
    state: "pending",
    attempts: 0,
    settingsChangeNumber: null,
    statusDetail: null,
    startedAt: null,
    durationMs: null,
    error: null,
    humanDecision: null,
    summary: null,
    assistantResponse: false,
    outcome: null,
    ...overrides,
  } satisfies WorkflowSessionNodeRow;
}

function sessionRun(overrides: Partial<WorkflowSessionRunView> = {}): WorkflowSessionRunView {
  return {
    schema: SESSION_RUN_VIEW_SCHEMA,
    runId: "run-adapter",
    revision: 7,
    runRevision: 3,
    queue: {
      runId: "run-adapter",
      workflowName: "adapter",
      workflowSourceRef: "builtin:adapter",
      initialized: true,
      definitionDigest: "digest",
      status: "running",
      originSessionId: "session-adapter",
      executionMode: "interactive",
      parentRunId: null,
      rootRunId: "run-adapter",
      lineageKind: null,
      restartNumber: 0,
      parentRunRevision: null,
      errorCode: null,
      createdAt: "2026-09-12T09:59:00.000Z",
      updatedAt: "2026-09-12T10:00:00.000Z",
      startedAt: "2026-09-12T10:00:00.000Z",
      finishedAt: null,
    },
    display: {
      status: "running",
      activity: "supervised_runner",
      controls: [],
      reason: null,
      reasonContent: null,
    },
    workflowName: "adapter",
    runTitle: null,
    paused: false,
    currentNode: "work",
    waitingOn: null,
    error: null,
    nodes: [
      nodeRow({ nodeId: "start", state: "ok", attempts: 1, outcome: "ok" }),
      nodeRow({
        nodeId: "work",
        state: "running",
        attempts: 2,
        startedAt: "2026-09-12T10:00:00.000Z",
        statusDetail: "waiting for the agent",
      }),
    ],
    nodeStart: 0,
    nodeTotal: 2,
    progressUpdates: [
      { key: "next-check", at: "2026-09-12T10:01:00.000Z", data: { nextCheckAt: "later" } },
    ],
    monitorEstimate: null,
    monitorSchedule: {
      nextCheckAt: "2026-09-12T10:05:00.000Z",
      recordedAt: "2026-09-12T10:01:00.000Z",
    },
    live: true,
    possiblyInterrupted: false,
    ...overrides,
  };
}

describe("widget run input adapter", () => {
  it("carries the running node start time so the widget can show elapsed time", () => {
    const input = widgetRunInput(sessionRun());
    expect(input.state.currentNode).toBe("work");
    expect(input.state.currentNodeStartedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(input.state.status).toBe("running");
  });

  it("shows a waiting node as running when the run is running", () => {
    const input = widgetRunInput(
      sessionRun({
        currentNode: null,
        waitingOn: "gate",
        nodes: [
          nodeRow({
            nodeId: "gate",
            state: "waiting",
            attempts: 1,
            startedAt: "2026-09-12T11:00:00.000Z",
            summary: "Continue",
          }),
        ],
      }),
    );
    expect(input.state.status).toBe("running");
    expect(input.state.waitingOn).toBe("gate");
    expect(input.state.currentNodeStartedAt).toBe("2026-09-12T11:00:00.000Z");
  });

  it("omits the start time when no node is running", () => {
    const input = widgetRunInput(
      sessionRun({
        currentNode: null,
        display: {
          status: "waiting",
          activity: null,
          controls: [],
          reason: null,
          reasonContent: null,
        },
        nodes: [nodeRow({ nodeId: "work", state: "waiting", attempts: 1, summary: "Wait" })],
      }),
    );
    expect(input.state.currentNodeStartedAt).toBeUndefined();
    expect(input.state.currentNode).toBeUndefined();
  });

  it("carries the action subtype the widget renders", () => {
    const input = widgetRunInput(
      sessionRun({
        nodes: [
          nodeRow({
            nodeId: "build",
            nodeType: "action",
            actionExecution: "shell",
            state: "ok",
            attempts: 1,
            outcome: "ok",
          }),
          nodeRow({ nodeId: "work", nodeType: "action", actionExecution: "function" }),
        ],
      }),
    );
    expect(input.snapshot.nodes.build?.actionExecution).toBe("shell");
    expect(input.snapshot.nodes.work?.actionExecution).toBe("function");
  });

  it("keeps the current node while its attempt is still pending", () => {
    const input = widgetRunInput(
      sessionRun({
        currentNode: "handoff",
        nodes: [
          nodeRow({
            nodeId: "handoff",
            state: "pending",
            attempts: 1,
            startedAt: "2026-09-12T12:00:00.000Z",
          }),
        ],
      }),
    );
    expect(input.state.currentNode).toBe("handoff");
    expect(input.state.currentNodeStartedAt).toBe("2026-09-12T12:00:00.000Z");
  });

  it("restores the progress and monitor facts the widget reads", () => {
    const input = widgetRunInput(sessionRun());
    expect(input.state.updates).toEqual([
      expect.objectContaining({ type: "progress", key: "next-check" }),
      expect.objectContaining({ type: "monitor.schedule", key: "next-check" }),
    ]);
    expect(input.snapshot).toMatchObject({ name: "adapter", startAt: "start" });
    expect(Object.keys(input.snapshot.nodes)).toEqual(["start", "work"]);
  });

  it("maps display states onto run states", () => {
    for (const [display, status] of [
      ["queued", "running"],
      ["paused", "waiting"],
      ["ambiguous", "failed"],
      ["completed", "completed"],
    ] as const) {
      const input = widgetRunInput(
        sessionRun({
          display: {
            status: display,
            activity: null,
            controls: [],
            reason: null,
            reasonContent: null,
          },
        }),
      );
      expect(input.state.status).toBe(status);
    }
  });
});
