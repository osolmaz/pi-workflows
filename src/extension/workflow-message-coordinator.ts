import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowClient } from "../client/client.js";
import {
  WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA,
  type WorkflowSessionView,
  type WorkflowTurnReport,
  type WorkflowTurnReportReceipt,
} from "../client/view.js";
import type { JsonValue } from "../state/json.js";
import {
  WORKFLOW_TURN_SCHEMA,
  type WorkflowMessage,
  type WorkflowTurnStopReason,
} from "../state/workflow-messages.js";

const WORKFLOW_MESSAGE_ID_FIELD = "workflowMessageId";

type SettledTurn = { stopReason: WorkflowTurnStopReason; responseSessionEntryId: string | null };
type BeforeTurnEnd = (message: WorkflowMessage, end: SettledTurn) => Promise<void>;
type DeliveryCallbacks = {
  beforeTurnEnd?: BeforeTurnEnd;
  terminalDelivered?: (message: WorkflowMessage) => Promise<void>;
};

type OwnedTurn = {
  workflowTurnId: string;
  message: WorkflowMessage;
  startedReported: boolean;
  stopRequested: boolean;
  abortSent: boolean;
} & ({ phase: "delivering" | "running" } | { phase: "settled"; end: SettledTurn });

/** Adds every server-owned workflow message to one Pi session through one public API path. */
export class WorkflowMessageCoordinator {
  private readonly queued = new Set<string>();
  private readonly closedTurnMessages = new Set<string>();
  private readonly finalizedTerminals = new Set<string>();
  private synchronizing = false;
  private lastBranchEpoch: string | null = null;
  private view: WorkflowSessionView | null = null;
  private turn: OwnedTurn | null = null;

  updateView(view: WorkflowSessionView): void {
    this.view = view;
    if (
      this.turn !== null &&
      view.cancelledWorkflowMessageIds.includes(this.turn.message.workflowMessageId)
    ) {
      this.turn.stopRequested = true;
    }
    const visibleIds = new Set(view.workflowMessages.map((message) => message.workflowMessageId));
    for (const messageId of this.closedTurnMessages) {
      if (!visibleIds.has(messageId)) this.closedTurnMessages.delete(messageId);
    }
    for (const messageId of this.finalizedTerminals) {
      if (!visibleIds.has(messageId)) this.finalizedTerminals.delete(messageId);
    }
    for (const message of view.workflowMessages) {
      if (message.status === "sent" || message.status === "cancelled") {
        this.queued.delete(message.workflowMessageId);
      }
    }
  }

  branchChanged(): void {
    this.lastBranchEpoch = null;
  }

  startTurn(): void {
    // Ordinary chat owns no workflow turn. Automatic Pi retries retain the
    // existing turn, including a settled result whose acknowledgment is pending.
    if (this.turn?.phase === "delivering") this.turn = { ...this.turn, phase: "running" };
  }

  endTurn(stopReason: WorkflowTurnStopReason, responseSessionEntryId: string | null): void {
    if (this.turn?.phase === "running") {
      this.turn = { ...this.turn, phase: "settled", end: { stopReason, responseSessionEntryId } };
    }
  }

  activeTurnMessage(): WorkflowMessage | undefined {
    if (this.turn === null || !this.turn.startedReported) return undefined;
    return this.turn.message ?? undefined;
  }

  toolCallBlockReason(toolName: string, input: unknown): string | undefined {
    const turn = this.turn;
    if (turn === null || turn.phase !== "running") return undefined;
    if (turn.stopRequested) return "The workflow-owned turn was cancelled; no more tools may run.";
    const details = turn.message.content.details;
    const contract = isRecord(details) && isRecord(details.contract) ? details.contract : undefined;
    if (contract?.allowedTools === undefined) return undefined;
    if (
      !Array.isArray(contract.allowedTools) ||
      contract.allowedTools.some((name) => typeof name !== "string")
    ) {
      return "The workflow tool allowlist is invalid; no tools may run.";
    }
    if (toolName === "workflow") {
      if (
        isRecord(input) &&
        (input.action === "submit" || input.action === "update") &&
        typeof contract.requestId === "string" &&
        input.requestId === contract.requestId
      )
        return undefined;
    } else if (contract.allowedTools.includes(toolName)) {
      return undefined;
    }
    return `Tool ${toolName} is not allowed during this workflow step. Inspect with the allowed tools or report a blocker.`;
  }

  async synchronize(
    pi: ExtensionAPI,
    client: WorkflowClient,
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager" | "abort">,
    callbacks: DeliveryCallbacks = {},
  ): Promise<void> {
    // Cancellation must not wait behind an in-flight transport acknowledgment.
    this.abortCancelledTurn(ctx);
    if (this.synchronizing || this.view === null) return;
    this.synchronizing = true;
    try {
      const view = this.view;
      if (!view.coordinatorActive || view.coordinatorEpoch === null) return;
      const branchEntries = branchWorkflowEntries(ctx.sessionManager.getBranch());
      if (this.turn === null && !ctx.isIdle()) {
        const candidate = this.turnCandidate();
        const open = view.openWorkflowTurn;
        if (
          candidate !== undefined &&
          open?.state === "started" &&
          open.workflowMessageId === candidate.workflowMessageId &&
          open.runId === candidate.runId &&
          open.targetSessionId === view.sessionId &&
          latestTurnInputIsWorkflow(ctx.sessionManager.getBranch(), candidate.workflowMessageId)
        ) {
          this.turn = {
            workflowTurnId: open.workflowTurnId,
            message: candidate,
            startedReported: true,
            stopRequested: view.cancelledWorkflowMessageIds.includes(candidate.workflowMessageId),
            abortSent: false,
            phase: "running",
          };
        }
      }
      this.abortCancelledTurn(ctx);
      if (
        view.branchReportRequired ||
        this.lastBranchEpoch !== view.coordinatorEpoch ||
        this.hasUnconfirmedBranchEntry(ctx, view)
      ) {
        await this.reportBranch(client, ctx, view);
      }
      await this.flushTurn(client, view, callbacks.beforeTurnEnd);
      this.abortCancelledTurn(ctx);
      if (this.turn !== null || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      for (const message of view.workflowMessages) {
        if (
          message.kind === "terminal" &&
          message.status === "sent" &&
          branchEntries.has(message.workflowMessageId) &&
          !this.finalizedTerminals.has(message.workflowMessageId)
        ) {
          await callbacks.terminalDelivered?.(message);
          this.finalizedTerminals.add(message.workflowMessageId);
        }
      }
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
      if (messageStartsTurn(message)) {
        this.turn = {
          workflowTurnId: `workflow-turn-${randomUUID()}`,
          message,
          startedReported: false,
          stopRequested: false,
          abortSent: false,
          phase: "delivering",
        };
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
        if (
          this.turn?.phase === "delivering" &&
          this.turn.message.workflowMessageId === messageId
        ) {
          this.turn = null;
        }
        throw error;
      }
      await this.reportBranch(client, ctx, view);
      await this.flushTurn(client, view, callbacks.beforeTurnEnd);
      this.abortCancelledTurn(ctx);
    } finally {
      this.synchronizing = false;
    }
  }

  clear(): void {
    this.queued.clear();
    this.closedTurnMessages.clear();
    this.finalizedTerminals.clear();
    this.view = null;
    this.turn = null;
    this.lastBranchEpoch = null;
    this.synchronizing = false;
  }

  abortCancelledTurn(ctx: Pick<ExtensionContext, "isIdle" | "abort">): void {
    const turn = this.turn;
    if (
      !this.view?.coordinatorActive ||
      turn === null ||
      turn.phase !== "running" ||
      !turn.stopRequested ||
      turn.abortSent ||
      ctx.isIdle()
    )
      return;
    // Set before calling Pi: abort can cause lifecycle events immediately.
    turn.abortSent = true;
    ctx.abort();
  }

  private turnCandidate(): WorkflowMessage | undefined {
    const view = this.view;
    if (view === null) return undefined;
    if (view.openWorkflowMessageId !== null) {
      const open = messageById(view, view.openWorkflowMessageId);
      if (
        open !== undefined &&
        !this.closedTurnMessages.has(open.workflowMessageId) &&
        messageStartsTurn(open)
      ) {
        return open;
      }
    }
    for (const messageId of this.queued) {
      const queued = messageById(view, messageId);
      if (queued?.status === "pending" && messageStartsTurn(queued)) return queued;
    }
    return undefined;
  }

  private async flushTurn(
    client: WorkflowClient,
    view: WorkflowSessionView,
    beforeTurnEnd?: BeforeTurnEnd,
  ): Promise<void> {
    let pending = this.turn;
    if (
      pending === null ||
      pending.phase === "delivering" ||
      view.coordinatorEpoch === null ||
      this.lastBranchEpoch !== view.coordinatorEpoch
    ) {
      return;
    }
    let message = pending.message;
    if (!pending.startedReported && !pending.stopRequested) {
      const confirmed = messageById(view, message.workflowMessageId);
      if (confirmed?.status !== "sent") return;
      message = confirmed;
      const receipt = await reportTurn(client, {
        state: "started",
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: pending.workflowTurnId,
        runId: message.runId,
        targetSessionId: view.sessionId,
        coordinatorEpoch: view.coordinatorEpoch,
      });
      // Pi can settle while the start report is in flight. Keep that exact
      // response and do not restore a turn cleared by session shutdown.
      if (this.turn?.workflowTurnId !== pending.workflowTurnId) return;
      pending = this.turn;
      if (
        receipt.ownership !== "active" &&
        !(receipt.ownership === "settled" && pending.phase === "settled")
      ) {
        // Rejected ownership must stop the delivered turn, not forget it.
        pending.stopRequested = true;
        return;
      }
      pending.message = message;
      pending.startedReported = true;
    }
    if (pending.phase !== "settled") return;
    if (!pending.stopRequested) await beforeTurnEnd?.(message, pending.end);
    await reportTurn(client, {
      state: "ended",
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: pending.workflowTurnId,
      runId: message.runId,
      targetSessionId: view.sessionId,
      coordinatorEpoch: view.coordinatorEpoch,
      stopReason: pending.end.stopReason,
      responseSessionEntryId: pending.end.responseSessionEntryId,
    });
    if (message.kind === "followUp") {
      this.closedTurnMessages.add(message.workflowMessageId);
    }
    for (const current of new Set([view, this.view])) {
      if (current?.openWorkflowTurn?.workflowTurnId === pending.workflowTurnId) {
        current.openWorkflowTurn = null;
      }
      if (
        current?.openWorkflowMessageId === message.workflowMessageId &&
        message.kind === "followUp"
      ) {
        current.openWorkflowMessageId = null;
      }
    }
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
      throw new Error(response.error ?? "Workflow server rejected the Pi branch report");
    }
    for (const entry of entries) {
      const message = messageById(view, entry.workflowMessageId);
      if (message !== undefined) {
        message.status = "sent";
        message.piSessionEntryId = entry.piSessionEntryId;
      }
      this.queued.delete(entry.workflowMessageId);
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

function latestTurnInputIsWorkflow(
  entries: readonly unknown[],
  workflowMessageId: string,
): boolean {
  for (const value of [...entries].reverse()) {
    if (!isRecord(value)) continue;
    if (
      value.role === "user" ||
      (value.type === "message" && isRecord(value.message) && value.message.role === "user")
    ) {
      return false;
    }
    if (value.type === "custom_message" || value.role === "custom") {
      return (
        isRecord(value.details) && value.details[WORKFLOW_MESSAGE_ID_FIELD] === workflowMessageId
      );
    }
  }
  return false;
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

function messageById(
  view: WorkflowSessionView,
  workflowMessageId: string,
): WorkflowMessage | undefined {
  return view.workflowMessages.find((message) => message.workflowMessageId === workflowMessageId);
}

function messageStartsTurn(message: WorkflowMessage): boolean {
  return message.content.triggerTurn;
}

async function reportTurn(
  client: WorkflowClient,
  report: WorkflowTurnReport,
): Promise<WorkflowTurnReportReceipt> {
  const response = await client.request({
    operation: "workflowTurn.report",
    runId: report.runId,
    payload: report as unknown as JsonValue,
  });
  if (response.outcome !== "accepted" && response.outcome !== "adopted") {
    throw new Error(response.error ?? "Workflow server rejected the model-turn report");
  }
  const receipt = response.receipt;
  if (
    !isRecord(receipt) ||
    receipt.schema !== WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA ||
    !["active", "settled", "absent"].includes(String(receipt.ownership))
  ) {
    throw new Error("Workflow server returned an invalid model-turn receipt");
  }
  const ownership = receipt.ownership as WorkflowTurnReportReceipt["ownership"];
  if (ownership === "absent") {
    if (receipt.turn !== null) {
      throw new Error("Workflow server returned an invalid model-turn receipt");
    }
  } else if (
    !isRecord(receipt.turn) ||
    receipt.turn.schema !== WORKFLOW_TURN_SCHEMA ||
    receipt.turn.workflowTurnId !== report.workflowTurnId ||
    receipt.turn.workflowMessageId !== report.workflowMessageId ||
    receipt.turn.runId !== report.runId ||
    receipt.turn.targetSessionId !== report.targetSessionId ||
    receipt.turn.state !== (ownership === "active" ? "started" : "ended")
  ) {
    throw new Error("Workflow server returned an invalid model-turn receipt");
  }
  return receipt as unknown as WorkflowTurnReportReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
