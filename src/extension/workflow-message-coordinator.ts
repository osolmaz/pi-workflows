import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowClient } from "../client/client.js";
import type { WorkflowSessionView, WorkflowTurnReport } from "../client/view.js";
import type { JsonValue } from "../state/json.js";
import type { WorkflowMessage, WorkflowTurnStopReason } from "../state/workflow-messages.js";

const WORKFLOW_MESSAGE_ID_FIELD = "workflowMessageId";

type PendingTurn = {
  workflowTurnId: string;
  workflowMessageId: string | null;
  runId: string | null;
  startedReported: boolean;
  end: { stopReason: WorkflowTurnStopReason; responseSessionEntryId: string | null } | null;
};

/** Adds every host-owned workflow message to one Pi session through one public API path. */
export class WorkflowMessageCoordinator {
  private readonly queued = new Set<string>();
  private synchronizing = false;
  private lastBranchEpoch: string | null = null;
  private view: WorkflowSessionView | null = null;
  private turn: PendingTurn | null = null;

  updateView(view: WorkflowSessionView): void {
    this.view = view;
    for (const message of view.workflowMessages) {
      if (message.status === "sent" || message.status === "cancelled") {
        this.queued.delete(message.workflowMessageId);
      }
    }
    if (
      this.turn !== null &&
      this.turn.workflowMessageId === null &&
      view.openWorkflowMessageId !== null
    ) {
      const message = messageById(view, view.openWorkflowMessageId);
      if (message !== undefined && messageStartsTurn(message)) this.bindTurn(message);
    }
  }

  branchChanged(): void {
    this.lastBranchEpoch = null;
  }

  startTurn(): void {
    if (this.turn !== null && this.turn.end === null) return;
    this.turn = {
      workflowTurnId: `workflow-turn-${randomUUID()}`,
      workflowMessageId: null,
      runId: null,
      startedReported: false,
      end: null,
    };
    const candidate = this.turnCandidate();
    if (candidate !== undefined) this.bindTurn(candidate);
  }

  endTurn(stopReason: WorkflowTurnStopReason, responseSessionEntryId: string | null): void {
    if (this.turn === null) this.startTurn();
    if (this.turn !== null) this.turn.end = { stopReason, responseSessionEntryId };
  }

  activeTurnMessage(): WorkflowMessage | undefined {
    if (this.view === null || this.turn?.workflowMessageId === null || this.turn === null) {
      return undefined;
    }
    return messageById(this.view, this.turn.workflowMessageId);
  }

  async synchronize(
    pi: ExtensionAPI,
    client: WorkflowClient,
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager">,
  ): Promise<void> {
    if (this.synchronizing || this.view === null) return;
    this.synchronizing = true;
    try {
      const view = this.view;
      if (!view.coordinatorActive || view.coordinatorEpoch === null) return;
      if (this.turn === null && !ctx.isIdle() && view.openWorkflowTurn !== null) {
        this.turn = {
          workflowTurnId: view.openWorkflowTurn.workflowTurnId,
          workflowMessageId: view.openWorkflowTurn.workflowMessageId,
          runId: view.openWorkflowTurn.runId,
          startedReported: false,
          end: null,
        };
      }
      if (
        view.branchReportRequired ||
        this.lastBranchEpoch !== view.coordinatorEpoch ||
        this.hasUnconfirmedBranchEntry(ctx, view)
      ) {
        await this.reportBranch(client, ctx, view);
      }
      await this.flushTurn(client, view);
      const messageId = view.nextWorkflowMessageId;
      if (messageId === null || this.queued.has(messageId)) return;
      const message = messageById(view, messageId);
      if (message === undefined || message.status !== "pending") return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      this.queued.add(messageId);
      const existingEntry = branchWorkflowEntries(ctx.sessionManager.getBranch()).get(messageId);
      if (existingEntry !== undefined) {
        await this.reportBranch(client, ctx, view);
        return;
      }

      // There must be no asynchronous boundary between these final checks and
      // the documented Pi sendMessage call.
      if (
        this.view !== view ||
        !view.coordinatorActive ||
        view.coordinatorEpoch === null ||
        view.nextWorkflowMessageId !== messageId ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        branchWorkflowEntries(ctx.sessionManager.getBranch()).has(messageId)
      ) {
        this.queued.delete(messageId);
        return;
      }
      try {
        pi.sendMessage(
          {
            customType: message.content.customType,
            content: message.content.content,
            display: message.content.display,
            details: message.content.details,
          },
          { triggerTurn: message.content.triggerTurn },
        );
      } catch (error) {
        this.queued.delete(messageId);
        throw error;
      }
      await this.reportBranch(client, ctx, view);
      await this.flushTurn(client, view);
    } finally {
      this.synchronizing = false;
    }
  }

  clear(): void {
    this.queued.clear();
    this.view = null;
    this.turn = null;
    this.lastBranchEpoch = null;
    this.synchronizing = false;
  }

  private turnCandidate(): WorkflowMessage | undefined {
    const view = this.view;
    if (view === null) return undefined;
    if (view.openWorkflowMessageId !== null) {
      const open = messageById(view, view.openWorkflowMessageId);
      if (open !== undefined && messageStartsTurn(open)) return open;
    }
    for (const messageId of this.queued) {
      const queued = messageById(view, messageId);
      if (queued !== undefined && messageStartsTurn(queued)) return queued;
    }
    return undefined;
  }

  private bindTurn(message: WorkflowMessage): void {
    if (this.turn === null) return;
    this.turn.workflowMessageId = message.workflowMessageId;
    this.turn.runId = message.runId;
  }

  private async flushTurn(client: WorkflowClient, view: WorkflowSessionView): Promise<void> {
    const pending = this.turn;
    if (
      pending === null ||
      pending.workflowMessageId === null ||
      pending.runId === null ||
      view.coordinatorEpoch === null ||
      this.lastBranchEpoch !== view.coordinatorEpoch
    ) {
      return;
    }
    const message = messageById(view, pending.workflowMessageId);
    if (message?.status !== "sent") return;
    if (!pending.startedReported) {
      await reportTurn(client, {
        state: "started",
        workflowMessageId: pending.workflowMessageId,
        workflowTurnId: pending.workflowTurnId,
        runId: pending.runId,
        targetSessionId: view.sessionId,
        coordinatorEpoch: view.coordinatorEpoch,
      });
      pending.startedReported = true;
    }
    if (pending.end === null) return;
    await reportTurn(client, {
      state: "ended",
      workflowMessageId: pending.workflowMessageId,
      workflowTurnId: pending.workflowTurnId,
      runId: pending.runId,
      targetSessionId: view.sessionId,
      coordinatorEpoch: view.coordinatorEpoch,
      stopReason: pending.end.stopReason,
      responseSessionEntryId: pending.end.responseSessionEntryId,
    });
    this.turn = null;
  }

  private async reportBranch(
    client: WorkflowClient,
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager">,
    view: WorkflowSessionView,
  ): Promise<void> {
    if (view.coordinatorEpoch === null) return;
    const allowed = new Set(view.workflowMessages.map((message) => message.workflowMessageId));
    const branch = branchWorkflowEntries(ctx.sessionManager.getBranch());
    const entries = [...branch]
      .filter(([workflowMessageId]) => allowed.has(workflowMessageId))
      .map(([workflowMessageId, piSessionEntryId]) => ({ workflowMessageId, piSessionEntryId }));
    const isIdle = ctx.isIdle();
    const hasPendingMessages = ctx.hasPendingMessages();
    const response = await client.request({
      operation: "workflowMessage.reportBranch",
      payload: {
        targetSessionId: view.sessionId,
        coordinatorEpoch: view.coordinatorEpoch,
        entries,
        isIdle,
        hasPendingMessages,
      },
    });
    if (response.outcome !== "accepted" && response.outcome !== "adopted") {
      throw new Error(response.error ?? "Workflow host rejected the Pi branch report");
    }
    for (const entry of entries) {
      const message = messageById(view, entry.workflowMessageId);
      if (message !== undefined) {
        message.status = "sent";
        message.piSessionEntryId = entry.piSessionEntryId;
      }
    }
    this.lastBranchEpoch = view.coordinatorEpoch;
  }

  private hasUnconfirmedBranchEntry(
    ctx: Pick<ExtensionContext, "sessionManager">,
    view: WorkflowSessionView,
  ): boolean {
    const branch = branchWorkflowEntries(ctx.sessionManager.getBranch());
    return view.workflowMessages.some(
      (message) => message.status !== "sent" && branch.has(message.workflowMessageId),
    );
  }
}

export function branchWorkflowEntries(entries: readonly unknown[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const value of entries) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (value.type !== "custom_message" && value.role !== "custom") continue;
    if (!isRecord(value.details)) continue;
    const workflowMessageId = value.details[WORKFLOW_MESSAGE_ID_FIELD];
    if (typeof workflowMessageId === "string") found.set(workflowMessageId, value.id);
  }
  return found;
}

export function responseEntryId(entries: readonly unknown[]): string | null {
  for (const value of [...entries].reverse()) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (value.type === "message" && isRecord(value.message) && value.message.role === "assistant") {
      return value.id;
    }
    if (value.role === "assistant") return value.id;
  }
  return null;
}

function messageById(view: WorkflowSessionView, workflowMessageId: string): WorkflowMessage | undefined {
  return view.workflowMessages.find((message) => message.workflowMessageId === workflowMessageId);
}

function messageStartsTurn(message: WorkflowMessage): boolean {
  return message.kind === "step" || message.kind === "terminal" || message.kind === "followUp";
}

async function reportTurn(client: WorkflowClient, report: WorkflowTurnReport): Promise<void> {
  const response = await client.request({
    operation: "workflowTurn.report",
    runId: report.runId,
    payload: report as unknown as JsonValue,
  });
  if (response.outcome !== "accepted" && response.outcome !== "adopted") {
    throw new Error(response.error ?? "Workflow host rejected the model-turn report");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
