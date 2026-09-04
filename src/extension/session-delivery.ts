import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ClaimedSessionDelivery = {
  deliveryId: string;
  claimExpiresAt: number;
  isStillDeliverable: () => boolean | Promise<boolean>;
  findSessionEntryId: (entries: readonly unknown[]) => string | undefined;
  send: () => void;
  settle: (sessionEntryId: string) => Promise<void>;
};

export type ClaimSessionDelivery = () => Promise<ClaimedSessionDelivery | undefined>;

type QueuedSessionDelivery = {
  delivery: ClaimedSessionDelivery;
  queuedAt: number;
  ambiguityReported: boolean;
};

const SESSION_ENTRY_CONFIRMATION_MS = 10_000;

/**
 * Delivers at most one server-owned message into a Pi session at a time.
 *
 * Pi's public sendMessage API does not return the saved session entry ID. Keep
 * the claimed delivery in memory until that entry becomes observable. Polling
 * may reconcile the delivery, but it must never send the same claim again.
 */
export class SessionDeliveryCoordinator {
  private readonly queued = new Map<string, QueuedSessionDelivery>();
  private claimed: ClaimedSessionDelivery | undefined;
  private synchronizing = false;

  async synchronize(
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager" | "ui">,
    claimers: readonly ClaimSessionDelivery[],
  ): Promise<void> {
    if (this.synchronizing) return;
    this.synchronizing = true;
    try {
      if (await this.settleQueued(ctx)) return;
      if (await this.sendClaimed(ctx)) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      for (const claim of claimers) {
        const delivery = await claim();
        if (delivery === undefined) continue;

        const existingEntryId = delivery.findSessionEntryId(ctx.sessionManager.getBranch());
        if (existingEntryId !== undefined) {
          if (delivery.claimExpiresAt <= Date.now()) return;
          this.rememberQueued(delivery);
          await this.settleDelivery(ctx, delivery.deliveryId, existingEntryId);
          return;
        }

        // Remember the server claim before the final idle check. If Pi starts a
        // turn while the claim request is in flight, a later poll can use this
        // exact still-live claim instead of making a conflicting second claim.
        this.claimed = delivery;
        await this.sendClaimed(ctx);
        return;
      }
    } finally {
      this.synchronizing = false;
    }
  }

  clear(): void {
    this.claimed = undefined;
    this.queued.clear();
  }

  private async sendClaimed(
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager" | "ui">,
  ): Promise<boolean> {
    const delivery = this.claimed;
    if (delivery === undefined) return false;
    if (delivery.claimExpiresAt <= Date.now()) {
      this.claimed = undefined;
      return false;
    }

    const existingEntryId = delivery.findSessionEntryId(ctx.sessionManager.getBranch());
    if (existingEntryId !== undefined) {
      this.rememberQueued(delivery);
      this.claimed = undefined;
      await this.settleDelivery(ctx, delivery.deliveryId, existingEntryId);
      return true;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
    if (!(await delivery.isStillDeliverable())) {
      this.claimed = undefined;
      return false;
    }
    if (delivery.claimExpiresAt <= Date.now()) {
      this.claimed = undefined;
      return false;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;

    this.rememberQueued(delivery);
    this.claimed = undefined;
    try {
      delivery.send();
    } catch (error) {
      this.queued.delete(delivery.deliveryId);
      throw error;
    }

    const insertedEntryId = delivery.findSessionEntryId(ctx.sessionManager.getBranch());
    if (insertedEntryId !== undefined) {
      await this.settleDelivery(ctx, delivery.deliveryId, insertedEntryId);
    }
    return true;
  }

  private rememberQueued(delivery: ClaimedSessionDelivery): void {
    if (this.queued.has(delivery.deliveryId)) return;
    this.queued.set(delivery.deliveryId, {
      delivery,
      queuedAt: Date.now(),
      ambiguityReported: false,
    });
  }

  private async settleQueued(
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager" | "ui">,
  ): Promise<boolean> {
    let hadQueuedDelivery = false;
    for (const [deliveryId, queued] of this.queued) {
      hadQueuedDelivery = true;
      const sessionEntryId = queued.delivery.findSessionEntryId(ctx.sessionManager.getBranch());
      if (sessionEntryId === undefined) {
        if (
          !queued.ambiguityReported &&
          ctx.isIdle() &&
          !ctx.hasPendingMessages() &&
          Date.now() - queued.queuedAt >= SESSION_ENTRY_CONFIRMATION_MS
        ) {
          queued.ambiguityReported = true;
          ctx.ui.notify(
            `Workflow session delivery ${deliveryId} is ambiguous: Pi did not expose a matching session entry. Do not retry it until you check the session history.`,
            "warning",
          );
        }
        return true;
      }
      await this.settleDelivery(ctx, deliveryId, sessionEntryId);
    }
    return hadQueuedDelivery;
  }

  private async settleDelivery(
    ctx: Pick<ExtensionContext, "ui">,
    deliveryId: string,
    sessionEntryId: string,
  ): Promise<void> {
    const queued = this.queued.get(deliveryId);
    if (queued === undefined) return;
    try {
      await queued.delivery.settle(sessionEntryId);
      this.queued.delete(deliveryId);
    } catch (error) {
      if (!queued.ambiguityReported) {
        queued.ambiguityReported = true;
        ctx.ui.notify(
          `Workflow session delivery ${deliveryId} is visible but its durable receipt is ambiguous: ${String(error)}. Do not retry it until recovery checks the session history.`,
          "warning",
        );
      }
    }
  }
}
