import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowSessionMessage, WorkflowSessionView } from "../src/client/view.js";
import { WorkflowMessageCoordinator } from "../src/extension/workflow-message-coordinator.js";
import { canonicalJson, type JsonValue } from "../src/state/json.js";
import { WORKFLOW_TURN_SCHEMA, type WorkflowMessage } from "../src/state/workflow-messages.js";

function followUpMessage(status: "pending" | "sent" = "pending"): WorkflowMessage {
  const content: WorkflowMessage["content"] = {
    schema: "pi-workflows.workflow-message-content.v1",
    customType: "pi-workflows-follow-up",
    content: "Done.",
    display: false,
    details: { workflowMessageId: "follow-up-message" },
    triggerTurn: true,
  };
  return {
    schema: "pi-workflows.workflow-message.v1",
    workflowMessageId: "follow-up-message",
    runId: "run-1",
    targetSessionId: "session-1",
    kind: "followUp",
    sourceId: "run-1",
    contentDigest: contentDigestOf(content),
    order: 1,
    status,
    piSessionEntryId: status === "sent" ? "entry-1" : null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    content,
  };
}

function contentDigestOf(content: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(content as JsonValue))
    .digest("hex");
}

/** Client double that also serves the verified content read Pi now performs. */
function clientDouble(request: (options: Record<string, unknown>) => Promise<unknown>): never {
  return {
    request,
    hydrateContent: async (_runId: string, value: unknown) => value,
  } as never;
}

function sessionMessage(message: WorkflowMessage): WorkflowSessionMessage {
  return {
    schema: "pi-workflows.session-message.v1",
    workflowMessageId: message.workflowMessageId,
    runId: message.runId,
    targetSessionId: message.targetSessionId,
    kind: message.kind,
    sourceId: message.sourceId,
    order: message.order,
    status: message.status,
    piSessionEntryId: message.piSessionEntryId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    triggerTurn: message.content.triggerTurn,
    customType: message.content.customType,
    display: message.content.display,
    content: message.content as unknown as JsonValue,
    contentDigest: message.contentDigest,
    deliveryCancelled: false,
  };
}

function acceptedServerRequest(options: Record<string, unknown>) {
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
    interaction: null,
    workflowMessage: sessionMessage(message),
    openWorkflowTurn: null,
    coordinatorEpoch: "epoch-1",
    coordinatorActive: true,
    branchReportRequired: false,
  };
}

describe("WorkflowMessageCoordinator", () => {
  it.each(["before start", "during start"])(
    "does not let normal chat block delivery %s",
    async (timing) => {
      const coordinator = new WorkflowMessageCoordinator();
      const message = followUpMessage();
      message.kind = "step";
      const branch: Record<string, unknown>[] = [];
      let idle = false;
      const ctx = {
        isIdle: () => idle,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never;
      const sendMessage = vi.fn((entry: { details: unknown }) => {
        branch.push({ type: "custom_message", id: "step-entry", details: entry.details });
        idle = false;
        coordinator.startTurn();
      });
      const request = vi.fn(async (options: Record<string, unknown>) =>
        acceptedServerRequest(options),
      );
      const sync = () =>
        coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);
      coordinator.startTurn();
      if (timing === "during start") {
        coordinator.updateView(view(message));
        await sync();
        expect(sendMessage).not.toHaveBeenCalled();
      }
      idle = true;
      coordinator.endTurn("completed", "ordinary-reply");
      coordinator.updateView(view(message));
      await sync();
      await sync();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);
      const beforeTurnEnd = vi.fn(async () => undefined);
      idle = true;
      coordinator.endTurn("completed", "workflow-reply");
      await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        beforeTurnEnd,
      });
      expect(beforeTurnEnd).toHaveBeenCalledWith(
        expect.objectContaining({ workflowMessageId: message.workflowMessageId }),
        {
        stopReason: "completed",
        responseSessionEntryId: "workflow-reply",
      });
      expect(
        request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
      ).toHaveLength(2);
    },
  );

  it("does not resend an unconfirmed delivery while ordinary events arrive", async () => {
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(followUpMessage()));
    const sendMessage = vi.fn();
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
    } as never;
    for (let count = 0; count < 3; count++) {
      await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);
      coordinator.endTurn("completed", "unrelated-reply");
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(request.mock.calls.every(([call]) => call.operation !== "workflowTurn.report")).toBe(
      true,
    );
  });

  it("retries a lost turn-end acknowledgment without replacing or redelivering the result", async () => {
    const coordinator = new WorkflowMessageCoordinator();
    const message = followUpMessage();
    coordinator.updateView(view(message));
    const branch: Record<string, unknown>[] = [];
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "step-entry", details: entry.details });
      coordinator.startTurn();
    });
    let loseEnd = true;
    const request = vi.fn(async (options: Record<string, unknown>) => {
      if (
        options.operation === "workflowTurn.report" &&
        (options.payload as { state: string }).state === "ended" &&
        loseEnd
      ) {
        loseEnd = false;
        throw new Error("Lost end acknowledgment");
      }
      return acceptedServerRequest(options);
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    const beforeTurnEnd = vi.fn(
      async (_message: WorkflowSessionMessage, _end: { responseSessionEntryId: string | null }) =>
        undefined,
    );
    const sync = () =>
      coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        beforeTurnEnd,
      });
    await sync();
    coordinator.endTurn("completed", "exact-reply");
    await expect(sync()).rejects.toThrow("Lost end acknowledgment");
    coordinator.startTurn();
    coordinator.endTurn("error", "other-reply");
    await sync();
    const ends = request.mock.calls
      .map(([call]) => call)
      .filter(
        (call) =>
          call.operation === "workflowTurn.report" &&
          (call.payload as { state: string }).state === "ended",
      );
    expect(ends).toHaveLength(2);
    expect(ends[0]).toEqual(ends[1]);
    expect(
      beforeTurnEnd.mock.calls.every(([, end]) => end.responseSessionEntryId === "exact-reply"),
    ).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
  });

  it("keeps a response that settles while the start acknowledgment is in flight", async () => {
    const coordinator = new WorkflowMessageCoordinator();
    const message = followUpMessage();
    coordinator.updateView(view(message));
    const branch: Record<string, unknown>[] = [];
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "prompt", details: entry.details });
      coordinator.startTurn();
    });
    const request = vi.fn(async (options: Record<string, unknown>) => {
      if (
        options.operation === "workflowTurn.report" &&
        (options.payload as { state: string }).state === "started"
      ) {
        await Promise.resolve();
        coordinator.endTurn("completed", "response-during-ack");
      }
      return acceptedServerRequest(options);
    });
    const beforeTurnEnd = vi.fn(async () => undefined);
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
      beforeTurnEnd,
    });
    expect(beforeTurnEnd).toHaveBeenCalledWith(
        expect.objectContaining({ workflowMessageId: message.workflowMessageId }),
        {
      stopReason: "completed",
      responseSessionEntryId: "response-during-ack",
    });
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(2);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
  });

  it("finalizes a delivered terminal notice once, without starting a turn", async () => {
    const message = followUpMessage("sent");
    message.kind = "terminal";
    message.content.triggerTurn = false;
    message.contentDigest = contentDigestOf(message.content);
    const current = view(message);
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const branch: Record<string, unknown>[] = [];
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    const sendMessage = vi.fn();
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    const terminalDelivered = vi.fn(async () => undefined);
    const sync = async () =>
      coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        terminalDelivered,
      });
    await sync();
    expect(terminalDelivered).not.toHaveBeenCalled();
    branch.push({ type: "custom_message", id: "entry-1", details: message.content.details });
    terminalDelivered.mockRejectedValueOnce(new Error("Recording transport failed"));
    await expect(sync()).rejects.toThrow("Recording transport failed");
    await sync();
    await sync();
    expect(terminalDelivered).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      request.mock.calls.every(
        ([call]) => (call as { operation: string }).operation !== "workflowTurn.report",
      ),
    ).toBe(true);
  });

  it("retains a settled response through a lost branch acknowledgment before closing its turn", async () => {
    const message = followUpMessage();
    const branch: Record<string, unknown>[] = [];
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    let loseAcknowledgment = true;
    const order: string[] = [];
    const request = vi.fn(async (options: Record<string, unknown>) => {
      if (
        options.operation === "workflowMessage.reportBranch" &&
        branch.length > 0 &&
        loseAcknowledgment
      ) {
        loseAcknowledgment = false;
        throw new Error("Lost branch acknowledgment");
      }
      if (options.operation === "workflowTurn.report")
        order.push((options.payload as { state: string }).state);
      return acceptedServerRequest(options);
    });
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "prompt-entry", details: entry.details });
      coordinator.startTurn();
      coordinator.endTurn("completed", "response-entry");
    });
    const beforeEnd = vi.fn(async (_message, end) => {
      expect(end).toEqual({ stopReason: "completed", responseSessionEntryId: "response-entry" });
      order.push("submit");
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    await expect(
      coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        beforeTurnEnd: beforeEnd,
      }),
    ).rejects.toThrow("Lost branch acknowledgment");
    coordinator.startTurn(); // An unrelated later event cannot replace the pending settled turn.
    coordinator.endTurn("error", "other-response");
    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
      beforeTurnEnd: beforeEnd,
    });
    expect(order).toEqual(["started", "submit", "ended"]);
    expect(beforeEnd).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
  });
  it("clears an explicit follow-up turn locally as soon as the workflow server accepts its end", async () => {
    const message = followUpMessage();
    const current = view(message);
    const branch: Record<string, unknown>[] = [];
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    let activeBeforeServerAcceptance: WorkflowSessionMessage | undefined;
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      coordinator.startTurn();
      activeBeforeServerAcceptance = coordinator.activeTurnMessage();
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);
    expect(activeBeforeServerAcceptance).toBeUndefined();
    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);
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
    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);

    expect(current.workflowMessage?.workflowMessageId).toBe(message.workflowMessageId);
    expect(current.openWorkflowTurn).toBeNull();
    coordinator.startTurn();
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(2);
  });

  it.each([
    { recordedTurn: false, laterInput: null },
    { recordedTurn: true, laterInput: { type: "message", message: { role: "user" } } },
    { recordedTurn: true, laterInput: { role: "user" } },
    { recordedTurn: true, laterInput: { type: "custom_message", details: {} } },
  ])(
    "does not recover ordinary chat as an outstanding step: %j",
    async ({ recordedTurn, laterInput }) => {
      const message = followUpMessage("sent");
      message.kind = "step";
      const current = view(message);
      if (recordedTurn) {
        current.openWorkflowTurn = {
          schema: WORKFLOW_TURN_SCHEMA,
          workflowTurnId: "old-workflow-turn",
          workflowMessageId: message.workflowMessageId,
          runId: message.runId,
          targetSessionId: message.targetSessionId,
          state: "started",
          stopReason: null,
          responseSessionEntryId: null,
          startedAt: "2026-09-02T00:00:00.000Z",
          endedAt: null,
        };
      }
      const branch: unknown[] = [
        { type: "custom_message", id: "entry-1", details: message.content.details },
        { type: "message", id: "old-response", message: { role: "assistant" } },
      ];
      if (laterInput !== null) branch.push(laterInput);
      const coordinator = new WorkflowMessageCoordinator();
      coordinator.updateView(current);
      const sendMessage = vi.fn();
      const beforeTurnEnd = vi.fn(async () => undefined);
      const request = vi.fn(async (options: Record<string, unknown>) =>
        acceptedServerRequest(options),
      );
      let idle = false;
      const ctx = {
        isIdle: () => idle,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never;
      const sync = () =>
        coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
          beforeTurnEnd,
        });
      coordinator.startTurn();
      await sync();
      expect(coordinator.activeTurnMessage()).toBeUndefined();
      coordinator.endTurn("completed", "ordinary-reply");
      idle = true;
      await sync();
      expect(beforeTurnEnd).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(
        request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
      ).toEqual([]);
      expect(current.workflowMessage?.workflowMessageId).toBe(message.workflowMessageId);
      expect(current.openWorkflowTurn?.workflowTurnId ?? null).toBe(
        recordedTurn ? "old-workflow-turn" : null,
      );
    },
  );

  it("keeps the accepted workflow turn through an automatic Pi retry", async () => {
    const message = followUpMessage("sent");
    const current = view(message);
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
      clientDouble(vi.fn(async () => ({ outcome: "accepted" }))),
      {
        isIdle: () => false,
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => [
            { type: "custom_message", id: "entry-1", details: message.content.details },
          ],
        },
      } as never,
    );
    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);

    coordinator.startTurn();

    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);
  });

  it("keeps a sent workflow message ready until its Pi model turn starts", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = followUpMessage();
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(view(message));
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(0);

    coordinator.startTurn();
    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);

    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(1);
  });

  it("keeps an accepted turn until agent settled when a newer view omits its message", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = followUpMessage();
    const current = view(message);
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      coordinator.startTurn();
    });
    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;

    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);
    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);

    coordinator.updateView({
      ...current,
      workflowMessage: null,
      openWorkflowTurn: null,
    });
    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);

    coordinator.endTurn("completed", "response-1");
    await coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx);

    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(
      request.mock.calls.filter(([call]) => call.operation === "workflowTurn.report"),
    ).toHaveLength(2);
  });

  it("enforces the owned turn allowlist before acknowledgment without restricting ordinary chat", async () => {
    const coordinator = new WorkflowMessageCoordinator();
    const message = followUpMessage();
    message.kind = "step";
    const contract = {
      requestId: "exact-request",
      allowedTools: ["read", "list_sessions"] as string[] | string,
    };
    message.content.details = { workflowMessageId: message.workflowMessageId, contract };
    message.contentDigest = contentDigestOf(message.content);
    coordinator.updateView(view(message));
    expect(coordinator.toolCallBlockReason("bash", {})).toBeUndefined();
    const branch: unknown[] = [];
    let idle = true;
    const ctx = {
      isIdle: () => idle,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      idle = false;
      coordinator.startTurn();
      expect(coordinator.toolCallBlockReason("bash", {})).toContain("not allowed");
    });
    await coordinator.synchronize(
      { sendMessage } as never,
      clientDouble(vi.fn(async (options: Record<string, unknown>) => acceptedServerRequest(options))),
      ctx,
    );
    for (const tool of ["read", "list_sessions"])
      expect(coordinator.toolCallBlockReason(tool, {})).toBeUndefined();
    for (const tool of [
      "bash",
      "exec_command",
      "write",
      "edit",
      "write_stdin",
      "kill_session",
      "custom_mutation",
    ]) {
      expect(coordinator.toolCallBlockReason(tool, {})).toContain("not allowed");
    }
    for (const action of ["submit", "update"]) {
      expect(
        coordinator.toolCallBlockReason("workflow", { action, requestId: "exact-request" }),
      ).toBeUndefined();
      expect(
        coordinator.toolCallBlockReason("workflow", { action, requestId: "wrong-request" }),
      ).toContain("not allowed");
    }
    expect(coordinator.toolCallBlockReason("workflow", { action: "start" })).toContain(
      "not allowed",
    );
    contract.allowedTools = "read";
    expect(coordinator.toolCallBlockReason("read", {})).toContain("invalid");
    contract.allowedTools = ["read"];
    coordinator.updateView({
      ...view(message),
      workflowMessage: { ...sessionMessage(message), deliveryCancelled: true },
    });
    expect(coordinator.toolCallBlockReason("read", {})).toContain("cancelled");
    coordinator.endTurn("aborted", null);
    expect(coordinator.toolCallBlockReason("bash", {})).toBeUndefined();
  });

  it("aborts rejected turn ownership and retains it until settlement", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = followUpMessage();
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
    let idle = true;
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      idle = false;
      coordinator.startTurn();
    });
    const abort = vi.fn();
    const ctx = {
      isIdle: () => idle,
      abort,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    const beforeTurnEnd = vi.fn(async () => undefined);
    const sync = () =>
      coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        beforeTurnEnd,
      });
    await sync();
    await sync();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    coordinator.endTurn("aborted", "aborted-response");
    idle = true;
    await sync();
    expect(beforeTurnEnd).not.toHaveBeenCalled();
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    idle = false;
    coordinator.startTurn();
    await sync();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts an expired owned turn once and waits for its exact settlement receipt", async () => {
    const coordinator = new WorkflowMessageCoordinator();
    const message = followUpMessage();
    message.kind = "step";
    const current = view(message);
    coordinator.updateView(current);
    const branch: unknown[] = [];
    let idle = true;
    const abort = vi.fn();
    const ctx = {
      isIdle: () => idle,
      abort,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
    } as never;
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
      idle = false;
      coordinator.startTurn();
    });
    let loseEndAck = true;
    const request = vi.fn(async (options: Record<string, unknown>) => {
      if (
        options.operation === "workflowTurn.report" &&
        (options.payload as { state: string }).state === "ended" &&
        loseEndAck
      ) {
        loseEndAck = false;
        throw new Error("lost end acknowledgment");
      }
      return acceptedServerRequest(options);
    });
    const beforeTurnEnd = vi.fn(async () => undefined);
    const sync = () =>
      coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
        beforeTurnEnd,
      });
    await sync();
    coordinator.updateView({
      ...current,
      workflowMessage: current.workflowMessage === null ? null : { ...current.workflowMessage, deliveryCancelled: true },
    });
    await sync();
    await sync();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(coordinator.activeTurnMessage()?.workflowMessageId).toBe(message.workflowMessageId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(
      request.mock.calls.filter(([call]) => (call.payload as { state?: string }).state === "ended"),
    ).toHaveLength(0);
    coordinator.endTurn("aborted", "expired-response");
    idle = true;
    await expect(sync()).rejects.toThrow("lost end acknowledgment");
    idle = false;
    coordinator.startTurn();
    coordinator.endTurn("completed", "ordinary-response");
    await sync();
    expect(beforeTurnEnd).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
    const ends = request.mock.calls.filter(
      ([call]) => (call.payload as { state?: string }).state === "ended",
    );
    expect(ends).toHaveLength(2);
    expect(ends[0]![0].payload).toEqual(ends[1]![0].payload);
    expect(ends[1]![0].payload).toMatchObject({
      stopReason: "aborted",
      responseSessionEntryId: "expired-response",
    });
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    coordinator.startTurn();
    await sync();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it.each(["branch", "start"])(
    "aborts while the %s acknowledgment is delayed",
    async (boundary) => {
      const coordinator = new WorkflowMessageCoordinator();
      const message = followUpMessage();
      const current = view(message);
      coordinator.updateView(current);
      const branch: unknown[] = [];
      let idle = true;
      const abort = vi.fn();
      const ctx = {
        isIdle: () => idle,
        abort,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never;
      const sendMessage = vi.fn((entry: { details: unknown }) => {
        branch.push({ type: "custom_message", id: "entry-1", details: entry.details });
        idle = false;
        coordinator.startTurn();
      });
      let release!: () => void;
      const acknowledgment = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const request = vi.fn(async (options: Record<string, unknown>) => {
        const isBoundary =
          boundary === "branch"
            ? options.operation === "workflowMessage.reportBranch" && branch.length > 0
            : options.operation === "workflowTurn.report" &&
              (options.payload as { state: string }).state === "started";
        if (isBoundary) {
          reached();
          await acknowledgment;
        }
        return acceptedServerRequest(options);
      });
      const beforeTurnEnd = vi.fn(async () => undefined);
      const sync = () =>
        coordinator.synchronize({ sendMessage } as never, clientDouble(request), ctx, {
          beforeTurnEnd,
        });
      const delivery = sync();
      await waiting;
      coordinator.updateView({
        ...current,
        workflowMessage: current.workflowMessage === null ? null : { ...current.workflowMessage, deliveryCancelled: true },
      });
      // The extension invokes this before its serialized presentation queue.
      coordinator.abortCancelledTurn(ctx);
      await sync();
      expect(abort).toHaveBeenCalledTimes(1);
      coordinator.endTurn("aborted", "cancelled-response");
      idle = true;
      release();
      await delivery;
      await sync();
      expect(beforeTurnEnd).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(coordinator.activeTurnMessage()).toBeUndefined();
    },
  );

  it("does not bind a later manual turn to a terminal message that was already reported", async () => {
    const branch: Record<string, unknown>[] = [];
    const message = followUpMessage();
    const current = view(message);
    const coordinator = new WorkflowMessageCoordinator();
    coordinator.updateView(current);
    const request = vi.fn(async (options: Record<string, unknown>) =>
      acceptedServerRequest(options),
    );
    const sendMessage = vi.fn((entry: { details: unknown }) => {
      branch.push({
        type: "custom_message",
        id: "entry-1",
        details: entry.details,
      });
    });

    await coordinator.synchronize(
      { sendMessage } as never,
      clientDouble(request),
      {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
      } as never,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The branch report confirms the delivery, so the message Pi holds is sent.
    expect(current.workflowMessage?.status).toBe("sent");
    coordinator.startTurn();
    expect(coordinator.activeTurnMessage()).toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "workflowMessage.reportBranch" }),
    );
  });
});
