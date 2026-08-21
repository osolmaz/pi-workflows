import { randomUUID } from "node:crypto";
import type {
  SqliteControllerStore,
  WorkflowTurnIntentRecord,
  WorkflowTurnIntentResolution,
} from "../controllers/sqlite.js";
import { deferredTurnMessageId } from "./deferred-turn.js";

export type BranchIntentResolution = {
  resolution: WorkflowTurnIntentResolution;
  messageId: string;
};

type NaturalDelivery = {
  runId: string;
  targetSessionId: string;
  resolution: Exclude<WorkflowTurnIntentResolution, "fallback">;
  send: (turnIntentId?: string) => void;
};

type FallbackDelivery = {
  targetSessionId: string;
  send: (intent: WorkflowTurnIntentRecord) => void;
};

export class DeferredTurnCoordinator {
  private readonly store: () => SqliteControllerStore | null;
  private readonly branchResolution: (intentId: string) => BranchIntentResolution | null;
  private readonly leaseMs: number;
  private readonly deferredNatural = new Map<string, NaturalDelivery>();

  constructor(options: {
    store: () => SqliteControllerStore | null;
    branchResolution: (intentId: string) => BranchIntentResolution | null;
    leaseMs: number;
  }) {
    this.store = options.store;
    this.branchResolution = options.branchResolution;
    this.leaseMs = options.leaseMs;
  }

  sendNatural(delivery: NaturalDelivery, idle: boolean): "sent" | "deferred" | "suppressed" {
    const store = this.store();
    const intent = store?.findPendingWorkflowTurnIntent({
      runId: delivery.runId,
      targetSessionId: delivery.targetSessionId,
    });
    if (store === null || store === undefined || intent === undefined) {
      delivery.send();
      return "sent";
    }
    if (!idle) {
      this.deferredNatural.set(intent.intentId, delivery);
      return "deferred";
    }
    const result = this.deliverNatural(intent.intentId, delivery);
    if (result === "deferred") this.deferredNatural.set(intent.intentId, delivery);
    return result;
  }

  flushNatural(idle: boolean): number {
    if (!idle) return 0;
    let sent = 0;
    for (const [intentId, delivery] of this.deferredNatural) {
      const result = this.deliverNatural(intentId, delivery);
      if (result !== "deferred") {
        this.deferredNatural.delete(intentId);
      }
      if (result === "sent") sent += 1;
    }
    return sent;
  }

  deliverFallbacks(delivery: FallbackDelivery, idle: boolean): number {
    const store = this.store();
    if (!idle || store === null) return 0;
    const claimToken = randomUUID();
    const intents = store.claimEligibleWorkflowTurnIntents({
      targetSessionId: delivery.targetSessionId,
      claimToken,
      leaseMs: this.leaseMs,
    });
    let sent = 0;
    for (const [index, intent] of intents.entries()) {
      const branch = this.branchResolution(intent.intentId);
      if (branch !== null) {
        store.resolveWorkflowTurnIntent({
          intentId: intent.intentId,
          targetSessionId: delivery.targetSessionId,
          claimToken,
          resolution: branch.resolution,
          messageId: branch.messageId,
        });
        continue;
      }
      try {
        delivery.send(intent);
        store.resolveWorkflowTurnIntent({
          intentId: intent.intentId,
          targetSessionId: delivery.targetSessionId,
          claimToken,
          resolution: "fallback",
          messageId: deferredTurnMessageId(intent.intentId, "fallback"),
        });
        sent += 1;
      } catch (error) {
        for (const pending of intents.slice(index)) {
          store.releaseWorkflowTurnIntentClaim({
            intentId: pending.intentId,
            targetSessionId: delivery.targetSessionId,
            claimToken,
          });
        }
        throw error;
      }
    }
    return sent;
  }

  clearDeferred(): void {
    this.deferredNatural.clear();
  }

  private deliverNatural(
    intentId: string,
    delivery: NaturalDelivery,
  ): "sent" | "deferred" | "suppressed" {
    const store = this.store();
    if (store === null) return "deferred";
    const claimToken = randomUUID();
    const intent = store.claimWorkflowTurnIntent({
      intentId,
      targetSessionId: delivery.targetSessionId,
      claimToken,
      leaseMs: this.leaseMs,
    });
    if (intent === undefined) {
      const current = store.getWorkflowTurnIntent(intentId);
      return current?.resolvedAt === null ? "deferred" : "suppressed";
    }
    const branch = this.branchResolution(intent.intentId);
    if (branch !== null) {
      store.resolveWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: delivery.targetSessionId,
        claimToken,
        resolution: branch.resolution,
        messageId: branch.messageId,
      });
      return "suppressed";
    }
    try {
      delivery.send(intent.intentId);
      store.resolveWorkflowTurnIntent({
        intentId: intent.intentId,
        targetSessionId: delivery.targetSessionId,
        claimToken,
        resolution: delivery.resolution,
        messageId: deferredTurnMessageId(intent.intentId, delivery.resolution),
      });
      return "sent";
    } catch (error) {
      store.releaseWorkflowTurnIntentClaim({
        intentId: intent.intentId,
        targetSessionId: delivery.targetSessionId,
        claimToken,
      });
      throw error;
    }
  }
}
