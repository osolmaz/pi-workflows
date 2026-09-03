import { describe, expect, it, vi } from "vitest";
import type { WorkflowSessionView } from "../src/client/view.js";
import { WorkflowMessageCoordinator } from "../src/extension/workflow-message-coordinator.js";
import { WORKFLOW_TURN_SCHEMA, type WorkflowMessage } from "../src/state/workflow-messages.js";

function terminalMessage(status: "pending" | "sent" = "pending"): WorkflowMessage {
  return {
    schema: "pi-workflows.workflow-message.v1",
    workflowMessageId: "terminal-message",
    runId: "run-1",
    targetSessionId: "session-1",
    kind: "terminal",
    sourceId: "run-1",
    contentDigest: "sha256:content",
    order: 1,
    status,
    piSessionEntryId: status === "sent" ? "entry-1" : null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    content: {
      schema: "pi-workflows.workflow-message-content.v1",
      customType: "pi-workflows-presentation",
      content: "Done.",
      display: false,
      details: { workflowMessageId: "terminal-message" },
      triggerTurn: true,
    },
  };
}

function acceptedHostRequest(options: Record<string, unknown>) {
  if (options.operation !== "workflowTurn.report") return { outcome: "accepted" };
  const payload = options.payload as {
    state: "started" | "ended";
    workflowMessageId: string;
    workflowTurnId: string;
    runId: string;
    targetSessionId: string;
    stopReason?: "completed" | "aborted" | "error" | "lost";
    responseSessionEntryId?: string | null;
  };
  return {
    outcome: "accepted",
    receipt: {
      schema: "pi-workflows.workflow-turn-report-receipt.v1",
      ownership: payload.state === "started" ? "active" : "settled",
      turn: {
        schema: WORKFLOW_TURN_SCHEMA,
        workflowMessageId: payload.workflowMessageId,
        workflowTurnId: payload.workflowTurnId,
        runId: payload.runId,
        targetSessionId: payload.targetSessionId,
        state: payload.state,
        stopReason: payload.stopReason ?? null,
        responseSessionEntryId: payload.responseSessionEntryId ?? null,
        startedAt: "2026-09-02T00:00:00.000Z",
        endedAt: payload.state === "ended" ? "2026-09-02T00:00:01.000Z" : null,
      },
    },
  };
}

function view(message: WorkflowMessage): WorkflowSessionView {
  return {
    schema: "pi-workflows.session-view.v1",
    sessionId: "session-1",
    run: null,
    pendingInteractions: [],
    pendingInteractionStart: 0,
    pendingInteractionTotal: 0,
    workflowMessages: [message],
    workflowMessageStart: 0,
    workflowMessageTotal: 1,
    workflowMessageWindowComplete: true,
    nextWorkflowMessageId: message.status === "pending" ? message.workflowMessageId : null,
    openWorkflowMessageId: null,
    openWorkflowTurn: null,
    coordinatorEpoch: "epoch-1",
    coordinatorActive: true,
    branchReportRequired: false,
  };
}

describe("WorkflowMessageCoordinator", () => {
  it("clears a terminal turn locally as soon as the host accepts its end", async () => {
    const message = terminalMessage();
    const current = view(message);
    const branch: Record<string, unknown>[] = [];
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const request = vi.fn(async (options: Record<string, unknown>) => acceptedHostRequest(options));
    let activeBeforeHostAcceptance: WorkflowMessage | undefined;
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      coordinator.startTurn();
      activeBeforeHostAcceptance = coordinator.activeTurnMessage();
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);
    expect(activeBeforeHostAcceptance).toBeUndefined();
    expect(coordinator.activeTurnMessage()).toBe(message);
    const started = request.mock.calls
      .map(([call]) => call)
      .find(
        (call) =>
          call.operation === "workflowTurn.report" &&
          (call.payload as { state?: unknown }).state === "started",
      );
    const workflowTurnId =
      started === undefined
        ? undefined
        : (started.payload as { workflowTurnId?: unknown }).workflowTurnId;
    expect(typeof workflowTurnId).toBe("string");
    current.openWorkflowMessageId = message.workflowMessageId;
    current.openWorkflowTurn = {
      schema: "pi-workflows.workflow-turn.v1",
      workflowTurnId: workflowTurnId as string,
      workflowMessageId: message.workflowMessageId,
      runId: message.runId,
      targetSessionId: message.targetSessionId,
      state: "started",
      stopReason: null,
      responseSessionEntryId: null,
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: null,
    };

    coordinator.endTurn("completed", "response-1");
    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);

    expect(current.openWorkflowMessageId).toBeNull();
    expect(current.openWorkflowTurn).toBeNull();
    coordinator.startTurn();
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(2);
  });

  it("requires fresh host acceptance for each new Pi model turn", async () => {
    const message = terminalMessage("sent");
    const current = view(message);
    current.openWorkflowMessageId = message.workflowMessageId;
    current.openWorkflowTurn = {
      schema: "pi-workflows.workflow-turn.v1",
      workflowTurnId: "accepted-turn",
      workflowMessageId: message.workflowMessageId,
      runId: message.runId,
      targetSessionId: message.targetSessionId,
      state: "started",
      stopReason: null,
      responseSessionEntryId: null,
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: null,
    };
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    await coordinator.synchronize(
      { sendMessage: vi.fn() } as never,
      { request: vi.fn(async () => ({ outcome: "accepted" })) } as never,
      {
        isIdle: () => false,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
      } as never,
    );
    expect(coordinator.activeTurnMessage()).toBe(message);

    coordinator.startTurn();

    expect(coordinator.activeTurnMessage()).toBeUndefined();
  });

  it("keeps a sent workflow message ready until its Pi model turn starts", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = terminalMessage();
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    const request = vi.fn(async (options: Record<string, unknown>) => acceptedHostRequest(options));
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(0);

    coordinator.startTurn();
    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);

    expect(coordinator.activeTurnMessage()).toBe(message);
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(1);
  });

  it("keeps an accepted turn until agent end when a newer view omits its message", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = terminalMessage();
    const current = view(message);
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const request = vi.fn(async (options: Record<string, unknown>) => acceptedHostRequest(options));
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      coordinator.startTurn();
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);
    expect(coordinator.activeTurnMessage()).toBe(message);

    coordinator.updateView({
      ...current,
      workflowMessages: [],
      workflowMessageTotal: 0,
      nextWorkflowMessageId: null,
      openWorkflowMessageId: null,
      openWorkflowTurn: null,
    });
    expect(coordinator.activeTurnMessage()).toBe(message);

    coordinator.endTurn("completed", "response-1");
    await coordinator.synchronize({ sendMessage } as never, { request } as never, ctx);

    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(2);
  });

  it("clears local ownership when the host says that no workflow owns the turn", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = terminalMessage();
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    const request = vi.fn(async (options: Record<string, unknown>) => {
      if (options.operation !== "workflowTurn.report") return { outcome: "accepted" };
      return {
        outcome: "adopted",
        receipt: {
          schema: "pi-workflows.workflow-turn-report-receipt.v1",
          ownership: "absent",
          turn: null,
        },
      };
    });
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      coordinator.startTurn();
    });

    await coordinator.synchronize(
      { sendMessage } as never,
      { request } as never,
      {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never,
    );

    expect(coordinator.activeTurnMessage()).toBeUndefined();
  });

  it("does not bind a later manual turn to a terminal message that was already reported", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = terminalMessage();
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    const request = vi.fn(async (options: Record<string, unknown>) => acceptedHostRequest(options));
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({
        type: "custom_message",
        id: "entry-1",
        details: entry.details,
      });
    });

    await coordinator.synchronize(
      { sendMessage } as never,
      { request } as never,
      {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(message.status).toBe("sent");
    coordinator.startTurn();
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "workflowMessage.reportBranch" }),
    );
  });
});
