import { describe, expect, it, vi } from "vitest";
import type { WorkflowSessionView } from "../src/client/view.js";
import { WorkflowMessageCoordinator } from "../src/extension/workflow-message-coordinator.js";
import type { WorkflowMessage } from "../src/state/workflow-messages.js";

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
    const request = vi.fn(async (_options: Record<string, unknown>) => ({ outcome: "accepted" }));
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

  it("does not bind a later manual turn to a terminal message that was already reported", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = terminalMessage();
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    const request = vi.fn(async (_options: Record<string, unknown>) => ({ outcome: "accepted" }));
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
