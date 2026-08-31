import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ClaimedSessionDelivery = {
  deliveryId: string;
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
 * Delivers at most one host-owned message into a Pi session at a time.
 *
 * Pi's public sendMessage API does not return the saved session entry ID. Keep
 * the claimed delivery in memory until that entry becomes observable. Polling
 * may reconcile the delivery, but it must never send the same claim again.
 */
export class SessionDeliveryCoordinator {
  private readonly queued = new Map<string, QueuedSessionDelivery>();
  private synchronizing = false;

  async synchronize(
    ctx: Pick<ExtensionContext, "hasPendingMessages" | "isIdle" | "sessionManager" | "ui">,
    claimers: readonly ClaimSessionDelivery[],
  ): Promise<void> {
    if (this.synchronizing) return;
    this.synchronizing = true;
    try {
      if (await this.settleQueued(ctx)) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      for (const claim of claimers) {
        const delivery = await claim();
        if (delivery === undefined) continue;

        const existingEntryId = delivery.findSessionEntryId(ctx.sessionManager.getBranch());
        if (existingEntryId !== undefined) {
          await delivery.settle(existingEntryId);
          return;
        }

        this.queued.set(delivery.deliveryId, {
          delivery,
          queuedAt: Date.now(),
          ambiguityReported: false,
        });
        try {
          delivery.send();
        } catch (error) {
          this.queued.delete(delivery.deliveryId);
          throw error;
        }

        const insertedEntryId = delivery.findSessionEntryId(ctx.sessionManager.getBranch());
        if (insertedEntryId !== undefined) {
          this.queued.delete(delivery.deliveryId);
          await delivery.settle(insertedEntryId);
        }
        return;
      }
    } finally {
      this.synchronizing = false;
    }
  }

  clear(): void {
    this.queued.clear();
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
      this.queued.delete(deliveryId);
      await queued.delivery.settle(sessionEntryId);
    }
    return hadQueuedDelivery;
  }
}
