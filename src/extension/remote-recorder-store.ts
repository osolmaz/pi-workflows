import { randomUUID } from "node:crypto";
import type { WorkflowClient } from "../client/client.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import type {
  WorkflowSessionBinding,
  WorkflowSessionCapture,
  WorkflowSessionEventRecord,
} from "../workflows/types.js";
import type { SessionRecordingStore } from "./recorder.js";

type SessionCommandContext = {
  targetSessionId: string;
  coordinatorEpoch: string;
};

/** Sends bounded session recording batches to the single workflow server writer. */
export class RemoteSessionRecordingStore implements SessionRecordingStore {
  constructor(
    private readonly client: WorkflowClient,
    private readonly context: () => SessionCommandContext,
  ) {}

  async hasSessionBinding(runId: string): Promise<boolean> {
    const receipt = await this.request(runId, "status");
    if (typeof receipt.bound !== "boolean") throw new Error("Session recording status is invalid");
    return receipt.bound;
  }

  async writeSessionBinding(
    runId: string,
    binding: WorkflowSessionBinding,
    attemptId?: string,
  ): Promise<void> {
    await this.request(runId, "bind", {
      binding: toJson(binding),
      ...(attemptId === undefined ? {} : { attemptId }),
    });
  }

  async writeSessionCapture(
    runId: string,
    capture: WorkflowSessionCapture,
    attemptId?: string,
  ): Promise<void> {
    await this.request(runId, "capture", {
      capture: toJson(capture),
      ...(attemptId === undefined ? {} : { attemptId }),
    });
  }

  async appendSessionEntry(
    runId: string,
    entry: Record<string, unknown>,
    attemptId?: string,
  ): Promise<number> {
    const receipt = await this.request(runId, "entries", {
      entries: [toJson(entry)],
      ...(attemptId === undefined ? {} : { attemptId }),
    });
    if (!Number.isSafeInteger(receipt.entrySequence) || (receipt.entrySequence as number) <= 0) {
      throw new Error("Session recording entry receipt is invalid");
    }
    return receipt.entrySequence as number;
  }

  async appendSessionEventBatch(
    runId: string,
    events: WorkflowSessionEventRecord[],
    attemptId?: string,
  ): Promise<void> {
    await this.request(runId, "events", {
      events: toJson(events),
      ...(attemptId === undefined ? {} : { attemptId }),
    });
  }

  async sessionCounts(
    runId: string,
    attemptId?: string,
  ): Promise<{ eventCount: number; entryCount: number; lastEventSeq: number }> {
    const receipt = await this.request(
      runId,
      "status",
      attemptId === undefined ? {} : { attemptId },
    );
    const eventCount = positiveOrZero(receipt.eventCount, "eventCount");
    const entryCount = positiveOrZero(receipt.entryCount, "entryCount");
    const lastEventSeq = positiveOrZero(receipt.lastEventSeq, "lastEventSeq");
    return { eventCount, entryCount, lastEventSeq };
  }

  private async request(
    runId: string,
    action: "status" | "bind" | "entries" | "events" | "capture",
    extra: Record<string, JsonValue> = {},
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = `session-record-${randomUUID()}`;
    const response = await this.client.requestDurable({
      operation: "session.record",
      requestId: idempotencyKey,
      idempotencyKey,
      runId,
      payload: { ...this.context(), action, ...extra },
    });
    if (response.outcome !== "accepted" && response.outcome !== "adopted") {
      throw new Error(response.error ?? "Workflow server rejected the session recording batch");
    }
    if (!isRecord(response.receipt)) throw new Error("Session recording receipt is invalid");
    return response.receipt;
  }
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function positiveOrZero(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Session recording ${name} is invalid`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
