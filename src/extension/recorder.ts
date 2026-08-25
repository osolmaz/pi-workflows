import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SESSION_BINDING_SCHEMA,
  SESSION_CAPTURE_SCHEMA,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_SCHEMA,
  type WorkflowRunStore,
} from "../workflows/store.js";
import type {
  AgentStepContract,
  ConversationRange,
  WorkflowSessionCaptureFailure,
  WorkflowSessionEventRecord,
  WorkflowSessionEventType,
} from "../workflows/types.js";
import {
  messageRole,
  normalizeAssistantEvent,
  toolCallIdFromAssistantEvent,
  toolFinishedPayload,
  toolStartedPayload,
  turnFinishedPayload,
  type MessageEndEventLike,
  type MessageStartEventLike,
  type MessageUpdateEventLike,
  type ToolExecutionEndEventLike,
  type ToolExecutionStartEventLike,
  type ToolExecutionUpdateEventLike,
  type TurnEndEventLike,
  type TurnStartEventLike,
} from "./session-events.js";

const FLUSH_INTERVAL_MS = 25;
const FINISH_TURN_TIMEOUT_MS = 30_000;
const FLUSH_MAX_RECORDS = 256;
const FLUSH_MAX_BYTES = 256 * 1024;
const QUEUE_MAX_RECORDS = 8_192;
const QUEUE_MAX_BYTES = 16 * 1024 * 1024;

type AttemptOwner = { nodeId: string; attemptId: string };
type TurnOwner = AttemptOwner & { turnId: string; turnIndex: number };
type MessageOwner = TurnOwner & { messageId: string; role: string };
type QueuedEvent = { record: WorkflowSessionEventRecord; bytes: number };
type PendingMessageEnd = { queued: QueuedEvent; role: string; message: unknown };
type RecordedEntry = { id: string; entry: Record<string, unknown>; claimed: boolean };

function objectKey(value: unknown): object | null {
  return typeof value === "object" && value !== null ? value : null;
}

function stableMessageKey(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const message = value as { id?: unknown; role?: unknown; timestamp?: unknown };
  if (typeof message.id === "string" && message.id.length > 0) {
    return `id:${message.id}`;
  }
  if (
    (typeof message.timestamp === "number" || typeof message.timestamp === "string") &&
    typeof message.role === "string"
  ) {
    return `timestamp:${message.role}:${message.timestamp}`;
  }
  return null;
}

function entryRole(entry: Record<string, unknown>): string {
  const message = entry.message;
  return messageRole(message);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records settled Pi entries and normalized temporal events in SQLite.
 */
export class SessionRecorder {
  private readonly store: WorkflowRunStore;
  private readonly runId: string;
  /** Capture segment for this recorder after an ownership handoff. */
  private segmentId: string | undefined;
  private cursor: string | null = null;
  private readonly recorded: string[] = [];
  private readonly unclaimedEntries: RecordedEntry[] = [];
  private bound = false;
  private acceptingEntries = true;
  private acceptingEvents = true;
  private entryChain: Promise<unknown> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;

  private nextEventSeq = 1;
  private nextTurnId = 1;
  private nextMessageId = 1;
  private currentAttempt: AttemptOwner | null = null;
  private currentTurn: TurnOwner | null = null;
  private currentMessage: MessageOwner | null = null;
  private lastFinishedAttempt: AttemptOwner | null = null;
  private finishPromise: Promise<void> | null = null;
  private resolveFinish: (() => void) | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private readonly messageOwners = new WeakMap<object, MessageOwner>();
  private readonly stableMessageOwners = new Map<string, MessageOwner>();
  private readonly toolOwners = new Map<string, MessageOwner>();
  private readonly turnToolCallIds = new Map<string, string[]>();

  private eventQueue: QueuedEvent[] = [];
  private readonly pendingMessageEnds: PendingMessageEnd[] = [];
  private outstandingRecords = 0;
  private outstandingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private captureFailure: WorkflowSessionCaptureFailure | null = null;

  constructor(store: WorkflowRunStore, runId: string) {
    this.store = store;
    this.runId = runId;
  }

  async bind(ctx: ExtensionContext): Promise<void> {
    if (this.bound) {
      return;
    }
    this.bound = true;
    this.cursor = ctx.sessionManager.getLeafId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    // An existing binding belongs to an earlier capture segment.
    if (await this.store.hasSessionBinding(this.runId)) {
      this.segmentId = randomUUID();
    }
    await this.store.writeSessionBinding(
      this.runId,
      {
        schema: SESSION_BINDING_SCHEMA,
        runId: this.runId,
        piSessionId: ctx.sessionManager.getSessionId(),
        ...(sessionFile !== undefined ? { piSessionFile: sessionFile } : {}),
        cwd: ctx.cwd,
        boundAt: new Date().toISOString(),
      },
      this.segmentId,
    );
    await this.store.writeSessionCapture(
      this.runId,
      {
        schema: SESSION_CAPTURE_SCHEMA,
        eventSchema: SESSION_EVENT_SCHEMA,
        status: "recording",
        eventCount: 0,
        entryCount: 0,
        lastEventSeq: 0,
      },
      this.segmentId,
    );
  }

  /** Fix the owner before the executor delivers an agent-step prompt. */
  beginAttempt(contract: AgentStepContract): void {
    this.currentAttempt = { nodeId: contract.nodeId, attemptId: contract.attemptId };
  }

  /** Release ownership of the turn that Pi has fully settled. */
  settleAttempt(): void {
    const finished = this.lastFinishedAttempt;
    this.lastFinishedAttempt = null;
    if (
      this.currentTurn === null &&
      (finished === null ||
        (this.currentAttempt?.nodeId === finished.nodeId &&
          this.currentAttempt.attemptId === finished.attemptId))
    ) {
      this.currentAttempt = null;
    }
  }

  handleTurnStart(event: TurnStartEventLike): void {
    const owner = this.currentAttempt;
    if (!owner) {
      return;
    }
    const turn: TurnOwner = {
      ...owner,
      turnId: `t${this.nextTurnId}`,
      turnIndex: event.turnIndex,
    };
    this.nextTurnId += 1;
    this.currentTurn = turn;
    this.turnToolCallIds.set(turn.turnId, []);
    this.enqueue(turn, "turn_started", { turnIndex: event.turnIndex });
  }

  async handleTurnEnd(event: TurnEndEventLike, ctx: ExtensionContext): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }
    const message = this.ownerForMessage(event.message);
    try {
      await this.synchronize(ctx);
      this.enqueue(
        turn,
        "turn_finished",
        turnFinishedPayload(event, message?.messageId, this.turnToolCallIds.get(turn.turnId) ?? []),
      );
    } catch (error) {
      this.failCapture("entry_write_failed", failureMessage(error));
    }
    this.currentTurn = null;
    this.currentMessage = null;
    this.lastFinishedAttempt = { nodeId: turn.nodeId, attemptId: turn.attemptId };
    if (this.finishPromise) {
      await this.stop();
    }
  }

  async handleMessageStart(event: MessageStartEventLike, ctx: ExtensionContext): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }
    await this.synchronize(ctx);
    const owner: MessageOwner = {
      ...turn,
      messageId: `m${this.nextMessageId}`,
      role: messageRole(event.message),
    };
    this.nextMessageId += 1;
    const key = objectKey(event.message);
    if (key) {
      this.messageOwners.set(key, owner);
    }
    const stableKey = stableMessageKey(event.message);
    if (stableKey) {
      this.stableMessageOwners.set(stableKey, owner);
    }
    this.currentMessage = owner;
    this.enqueue(owner, "message_started", { role: owner.role });
  }

  handleMessageUpdate(event: MessageUpdateEventLike): void {
    const owner = this.ownerForMessage(event.message);
    if (!owner) {
      return;
    }
    const normalized = normalizeAssistantEvent(event.assistantMessageEvent);
    if (
      normalized.type === "text_delta" ||
      normalized.type === "thinking_delta" ||
      normalized.type === "toolcall_delta"
    ) {
      return;
    }
    const toolCallId = toolCallIdFromAssistantEvent(normalized);
    if (toolCallId) {
      this.toolOwners.set(toolCallId, owner);
      const ids = this.turnToolCallIds.get(owner.turnId) ?? [];
      if (!ids.includes(toolCallId)) {
        ids.push(toolCallId);
        this.turnToolCallIds.set(owner.turnId, ids);
      }
    }
    this.enqueue(owner, "assistant_event", normalized as unknown as Record<string, unknown>);
  }

  handleMessageEnd(event: MessageEndEventLike): void {
    const owner = this.ownerForMessage(event.message);
    if (!owner) {
      return;
    }
    // Pi appends the final session entry after message_end handlers return.
    // Keep this record and every later event queued until a documented hook
    // with synchronized session state can attach the exact entry id.
    this.clearFlushTimer();
    const queued = this.enqueue(
      owner,
      "message_finished",
      { role: owner.role, settled: false },
      undefined,
      {},
      true,
    );
    if (queued) {
      this.pendingMessageEnds.push({ queued, role: owner.role, message: event.message });
      this.clearFlushTimer();
    }
    if (this.currentMessage?.messageId === owner.messageId) {
      this.currentMessage = null;
    }
  }

  handleToolStart(event: ToolExecutionStartEventLike): void {
    const owner = this.toolOwners.get(event.toolCallId) ?? this.currentMessage;
    if (!owner) {
      return;
    }
    this.toolOwners.set(event.toolCallId, owner);
    this.enqueue(owner, "tool_execution_started", toolStartedPayload(event), undefined, {
      toolCallId: event.toolCallId,
    });
  }

  handleToolUpdate(_event: ToolExecutionUpdateEventLike): void {
    // Incremental tool progress is transient. The recorder stores the settled
    // tool result and the surrounding lifecycle facts.
  }

  handleToolEnd(event: ToolExecutionEndEventLike): void {
    const owner = this.toolOwners.get(event.toolCallId);
    if (!owner) {
      return;
    }
    this.enqueue(owner, "tool_execution_finished", toolFinishedPayload(event), undefined, {
      toolCallId: event.toolCallId,
    });
  }

  /** Flush new entries on the current branch into the bundle. */
  record(ctx: ExtensionContext): Promise<RecordedEntry[]> {
    if (!this.bound || !this.acceptingEntries) {
      return Promise.resolve([]);
    }
    const task = this.entryChain.then(async () => {
      const branch = ctx.sessionManager.getBranch() as unknown as Array<
        Record<string, unknown> & { id: string }
      >;
      let startIndex = 0;
      if (this.cursor !== null) {
        const cursorIndex = branch.findIndex((entry) => entry.id === this.cursor);
        if (cursorIndex === -1) {
          this.cursor = branch.at(-1)?.id ?? this.cursor;
          return [];
        }
        startIndex = cursorIndex + 1;
      }
      const appended: RecordedEntry[] = [];
      for (const entry of branch.slice(startIndex)) {
        await this.store.appendSessionEntry(this.runId, entry, this.segmentId);
        const recorded = { id: entry.id, entry, claimed: false };
        appended.push(recorded);
        this.unclaimedEntries.push(recorded);
        this.recorded.push(entry.id);
        this.cursor = entry.id;
      }
      return appended;
    });
    this.entryChain = task.catch((error: unknown) => {
      this.failCapture("entry_write_failed", failureMessage(error));
    });
    return task;
  }

  /** Record durable entries, then release deferred message-end events in order. */
  async synchronize(ctx: ExtensionContext): Promise<void> {
    if (this.pendingMessageEnds.length === 0) {
      return;
    }
    await this.record(ctx);
    for (const pending of this.pendingMessageEnds.splice(0)) {
      const entryId = this.claimEntry(pending.role, pending.message);
      pending.queued.record.payload = entryId
        ? { role: pending.role, settled: true, entryId }
        : { role: pending.role, settled: false };
      const bytes = Buffer.byteLength(JSON.stringify(pending.queued.record), "utf8") + 1;
      this.outstandingBytes += bytes - pending.queued.bytes;
      pending.queued.bytes = bytes;
    }
    if (this.eventQueue.length >= FLUSH_MAX_RECORDS || this.queuedBytes() >= FLUSH_MAX_BYTES) {
      this.startFlush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Finalize immediately when no Pi turn is active. Otherwise wait for
   * `turn_end`, which is the last documented lifecycle boundary needed to
   * include the workflow tool result and any following assistant output.
   */
  async finish(): Promise<void> {
    if (this.stopPromise || this.currentTurn === null) {
      return await this.stop();
    }
    if (!this.finishPromise) {
      this.finishPromise = new Promise<void>((resolve) => {
        this.resolveFinish = resolve;
      });
      this.finishTimer = setTimeout(() => {
        this.failCapture(
          "turn_settle_timeout",
          `active Pi turn did not finish within ${FINISH_TURN_TIMEOUT_MS}ms`,
        );
        void this.stop();
      }, FINISH_TURN_TIMEOUT_MS);
      this.finishTimer.unref?.();
    }
    return await this.finishPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (this.currentTurn !== null) {
      this.failCapture(
        "turn_interrupted",
        "session capture stopped before the active Pi turn finished",
      );
    }
    this.acceptingEntries = false;
    this.acceptingEvents = false;
    // If Pi closes before another synchronized hook, preserve the message-end
    // receipts as explicitly unsettled rather than hanging finalization.
    this.pendingMessageEnds.splice(0);
    this.clearFlushTimer();
    this.stopPromise = (async () => {
      try {
        await this.flushAllEvents();
        await this.entryChain;
        const counts = await this.store.sessionCounts(this.runId, this.segmentId);
        await this.store.writeSessionCapture(
          this.runId,
          {
            schema: SESSION_CAPTURE_SCHEMA,
            eventSchema: SESSION_EVENT_SCHEMA,
            status: this.captureFailure ? "failed" : "complete",
            ...counts,
            ...(this.captureFailure ? { failure: this.captureFailure } : {}),
          },
          this.segmentId,
        );
      } catch (error) {
        // Capture is observational. A finalization failure must never reject
        // the workflow's terminal persistence hook.
        this.failCapture("capture_finalize_failed", failureMessage(error));
        try {
          const counts = await this.store.sessionCounts(this.runId, this.segmentId);
          await this.store.writeSessionCapture(
            this.runId,
            {
              schema: SESSION_CAPTURE_SCHEMA,
              eventSchema: SESSION_EVENT_SCHEMA,
              status: "failed",
              ...counts,
              failure: this.captureFailure ?? {
                failedAt: new Date().toISOString(),
                code: "capture_finalize_failed",
                message: failureMessage(error),
              },
            },
            this.segmentId,
          );
        } catch {
          // The viewer will report the missing/invalid capture file.
        }
      } finally {
        if (this.finishTimer) {
          clearTimeout(this.finishTimer);
          this.finishTimer = null;
        }
        this.resolveFinish?.();
        this.resolveFinish = null;
      }
    })();
    return await this.stopPromise;
  }

  mark(): number {
    return this.recorded.length;
  }

  rangeSince(mark: number): ConversationRange | undefined {
    if (this.recorded.length <= mark) {
      return undefined;
    }
    return {
      firstEntryId: this.recorded[mark] as string,
      lastEntryId: this.recorded.at(-1) as string,
    };
  }

  private ownerForMessage(message: unknown): MessageOwner | null {
    const key = objectKey(message);
    const stableKey = stableMessageKey(message);
    return (
      (key ? this.messageOwners.get(key) : undefined) ??
      (stableKey ? this.stableMessageOwners.get(stableKey) : undefined) ??
      this.currentMessage
    );
  }

  private claimEntry(role: string, message: unknown): string | undefined {
    const messageKey = stableMessageKey(message);
    const entry = this.unclaimedEntries.find((candidate) => {
      if (candidate.claimed || entryRole(candidate.entry) !== role) {
        return false;
      }
      return messageKey === null || stableMessageKey(candidate.entry.message) === messageKey;
    });
    if (!entry) {
      return undefined;
    }
    entry.claimed = true;
    return entry.id;
  }

  private enqueue(
    owner: TurnOwner | MessageOwner,
    type: WorkflowSessionEventType,
    payload: Record<string, unknown>,
    at: string = new Date().toISOString(),
    extra: { toolCallId?: string } = {},
    deferFlush = false,
  ): QueuedEvent | null {
    if (!this.bound || !this.acceptingEvents || this.captureFailure) {
      return null;
    }
    const messageId = "messageId" in owner ? owner.messageId : undefined;
    const record: WorkflowSessionEventRecord = {
      seq: this.nextEventSeq,
      at,
      nodeId: owner.nodeId,
      attemptId: owner.attemptId,
      turnId: owner.turnId,
      ...(messageId === undefined ? {} : { messageId }),
      ...(extra.toolCallId === undefined ? {} : { toolCallId: extra.toolCallId }),
      type,
      payload,
    };
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    const externalizable =
      type === "tool_execution_started" ||
      type === "tool_execution_finished" ||
      (type === "assistant_event" && payload.type === "toolcall_end");
    if (bytes > SESSION_EVENT_MAX_BYTES && !externalizable) {
      this.failCapture(
        "event_too_large",
        `session event exceeded ${SESSION_EVENT_MAX_BYTES} bytes`,
      );
      return null;
    }
    if (
      this.outstandingRecords + 1 > QUEUE_MAX_RECORDS ||
      this.outstandingBytes + bytes > QUEUE_MAX_BYTES
    ) {
      this.failCapture("event_queue_overflow", "session event queue limit exceeded");
      return null;
    }
    this.nextEventSeq += 1;
    const queued = { record, bytes };
    this.eventQueue.push(queued);
    this.outstandingRecords += 1;
    this.outstandingBytes += bytes;
    if (!deferFlush) {
      if (this.eventQueue.length >= FLUSH_MAX_RECORDS || this.queuedBytes() >= FLUSH_MAX_BYTES) {
        this.startFlush();
      } else {
        this.scheduleFlush();
      }
    }
    return queued;
  }

  private queuedBytes(): number {
    return this.eventQueue.reduce((sum, queued) => sum + queued.bytes, 0);
  }

  private scheduleFlush(): void {
    if (this.pendingMessageEnds.length > 0 || this.flushTimer || this.flushPromise) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.startFlush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  private startFlush(): void {
    if (this.pendingMessageEnds.length > 0 || this.flushPromise || this.eventQueue.length === 0) {
      return;
    }
    this.clearFlushTimer();
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    while (this.eventQueue.length > 0 && batch.length < FLUSH_MAX_RECORDS) {
      const next = this.eventQueue[0] as QueuedEvent;
      if (batch.length > 0 && bytes + next.bytes > FLUSH_MAX_BYTES) {
        break;
      }
      batch.push(this.eventQueue.shift() as QueuedEvent);
      bytes += next.bytes;
    }
    this.flushPromise = this.store
      .appendSessionEventBatch(
        this.runId,
        batch.map((queued) => queued.record),
        this.segmentId,
      )
      .catch((error: unknown) => {
        const message = failureMessage(error);
        this.failCapture(
          message.includes(`exceeded ${SESSION_EVENT_MAX_BYTES} bytes`)
            ? "event_too_large"
            : "event_write_failed",
          message,
        );
        for (const queued of this.eventQueue.splice(0)) {
          this.outstandingRecords -= 1;
          this.outstandingBytes -= queued.bytes;
        }
      })
      .finally(() => {
        for (const queued of batch) {
          this.outstandingRecords -= 1;
          this.outstandingBytes -= queued.bytes;
        }
        this.flushPromise = null;
        if (this.eventQueue.length > 0 && this.captureFailure?.code !== "event_write_failed") {
          this.startFlush();
        }
      });
  }

  private async flushAllEvents(): Promise<void> {
    this.clearFlushTimer();
    while (this.eventQueue.length > 0 || this.flushPromise) {
      if (!this.flushPromise) {
        this.startFlush();
      }
      await this.flushPromise;
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private failCapture(code: string, message: string): void {
    if (this.captureFailure) {
      return;
    }
    this.captureFailure = {
      failedAt: new Date().toISOString(),
      code,
      message,
    };
    this.acceptingEvents = false;
  }
}
