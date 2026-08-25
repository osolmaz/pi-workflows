import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LeaseClaim } from "../state/mutation.js";
import type { WorkflowFollowUpRecord } from "../workflows/settings.js";
import { WorkflowRunStore } from "../workflows/store.js";

const FOLLOW_UP_ID_PREFIX = "pi-workflows-follow-up:";

export type FollowUpDelivery = {
  followUp: WorkflowFollowUpRecord;
  claim: LeaseClaim;
};

export class FollowUpCoordinator {
  private pending: FollowUpDelivery | undefined;
  private synchronizing = false;

  constructor(
    private readonly store: WorkflowRunStore,
    private readonly ownerId: string,
    private readonly sendUserMessage: (text: string, options?: { deliverAs?: "followUp" }) => void,
  ) {}

  async synchronize(ctx: ExtensionContext, workflowActive: boolean): Promise<void> {
    if (this.synchronizing) return;
    this.synchronizing = true;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (this.pending !== undefined) {
        const entryId = findFollowUpEntryId(
          ctx.sessionManager.getBranch(),
          this.pending.followUp.followUpId,
        );
        if (entryId === undefined) return;
        this.store.markFollowUpSent(this.pending.followUp.followUpId, this.pending.claim, entryId);
        this.releaseClaim(this.pending.claim);
        this.pending = undefined;
      }
      if (!ctx.isIdle() || workflowActive) return;
      const claimed = this.store.claimNextFollowUp(sessionId, this.ownerId);
      if (claimed === undefined) return;
      const entryId = findFollowUpEntryId(
        ctx.sessionManager.getBranch(),
        claimed.followUp.followUpId,
      );
      if (entryId !== undefined) {
        this.store.markFollowUpSent(claimed.followUp.followUpId, claimed.claim, entryId);
        this.releaseClaim(claimed.claim);
        return;
      }
      this.pending = claimed;
      try {
        this.sendUserMessage(followUpMessageText(claimed.followUp));
      } catch (error) {
        this.pending = undefined;
        this.releaseClaim(claimed.claim);
        throw error;
      }
    } finally {
      this.synchronizing = false;
    }
  }

  clear(): void {
    this.pending = undefined;
  }

  private releaseClaim(claim: LeaseClaim): void {
    try {
      this.store.releaseFollowUpClaim(claim);
    } catch {
      // The lease can expire or move after delivery evidence is saved.
    }
  }
}

export function followUpMessageText(
  followUp: Pick<WorkflowFollowUpRecord, "followUpId" | "prompt">,
): string {
  return `${followUp.prompt}\n\n<!-- ${FOLLOW_UP_ID_PREFIX}${followUp.followUpId} -->`;
}

export function findFollowUpEntryId(
  entries: readonly unknown[],
  followUpId: string,
): string | undefined {
  const idText = `${FOLLOW_UP_ID_PREFIX}${followUpId}`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "user") continue;
    if (messageText(message.content).includes(idText)) return entry.id;
  }
  return undefined;
}

export function findSettledPresentationEntries(
  entries: readonly unknown[],
  runId: string,
): { presentationEntryId: string; assistantEntryId: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isPresentationEntry(entry, runId)) continue;
    for (let childIndex = index + 1; childIndex < entries.length; childIndex += 1) {
      const child = entries[childIndex];
      if (!isRecord(child) || child.type !== "message" || typeof child.id !== "string") continue;
      const message = child.message;
      if (!isRecord(message)) continue;
      if (message.role === "user") break;
      if (
        message.role === "assistant" &&
        (message.stopReason === "stop" || message.stopReason === "length")
      ) {
        return { presentationEntryId: entry.id, assistantEntryId: child.id };
      }
    }
  }
  return undefined;
}

function isPresentationEntry(value: unknown, runId: string): value is { id: string } {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.type === "custom_message") {
    return (
      value.customType === "pi-workflows-presentation" &&
      isRecord(value.details) &&
      value.details.runId === runId
    );
  }
  if (value.type !== "message" || !isRecord(value.message)) return false;
  return (
    value.message.role === "custom" &&
    value.message.customType === "pi-workflows-presentation" &&
    isRecord(value.message.details) &&
    value.message.details.runId === runId
  );
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
