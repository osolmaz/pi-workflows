import { createHash, randomUUID } from "node:crypto";
import type { StateDatabase } from "./database.js";
import { canonicalJson, type JsonValue } from "./json.js";

export const WORKFLOW_MESSAGE_SCHEMA = "pi-workflows.workflow-message.v1" as const;
export const WORKFLOW_MESSAGE_CONTENT_SCHEMA = "pi-workflows.workflow-message-content.v1" as const;
export const WORKFLOW_TURN_SCHEMA = "pi-workflows.workflow-turn.v1" as const;

export type WorkflowMessageKind = "step" | "decision" | "notification" | "terminal" | "followUp";
export type WorkflowMessageStatus = "pending" | "sent" | "cancelled";
export type WorkflowStepReason = "initial" | "reminder" | "resumed";
export type WorkflowTurnState = "started" | "ended";
export type WorkflowTurnStopReason = "completed" | "aborted" | "error" | "lost";

export type WorkflowMessageContent = {
  schema: typeof WORKFLOW_MESSAGE_CONTENT_SCHEMA;
  customType: string;
  content: string;
  display: boolean;
  details: JsonValue;
  triggerTurn: boolean;
};

export type WorkflowMessage = {
  schema: typeof WORKFLOW_MESSAGE_SCHEMA;
  workflowMessageId: string;
  runId: string;
  targetSessionId: string;
  kind: WorkflowMessageKind;
  sourceId: string;
  contentDigest: string;
  content: WorkflowMessageContent;
  order: number;
  status: WorkflowMessageStatus;
  piSessionEntryId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTurn = {
  schema: typeof WORKFLOW_TURN_SCHEMA;
  workflowTurnId: string;
  workflowMessageId: string;
  runId: string;
  targetSessionId: string;
  state: WorkflowTurnState;
  stopReason: WorkflowTurnStopReason | null;
  responseSessionEntryId: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type WorkflowBranchEntry = {
  workflowMessageId: string;
  piSessionEntryId: string;
};

export type CreateWorkflowMessageOptions = {
  workflowMessageId?: string;
  runId: string;
  targetSessionId: string;
  kind: WorkflowMessageKind;
  sourceId: string;
  idempotencyKey: string;
  content: WorkflowMessageContent;
  now?: number;
};

type WorkflowMessageRow = {
  workflowMessageId: string;
  runId: string;
  targetSessionId: string;
  kind: WorkflowMessageKind;
  sourceId: string;
  contentHash: Buffer;
  orderNumber: number;
  status: WorkflowMessageStatus;
  piSessionEntryId: string | null;
  createdAt: number;
  updatedAt: number;
};

type WorkflowTurnRow = {
  workflowTurnId: string;
  workflowMessageId: string;
  runId: string;
  targetSessionId: string;
  state: WorkflowTurnState;
  stopReason: WorkflowTurnStopReason | null;
  responseSessionEntryId: string | null;
  startedAt: number;
  endedAt: number | null;
};

/** Durable workflow content that the host requires Pi to add to one origin session. */
export class WorkflowMessageStore {
  constructor(readonly state: StateDatabase) {}

  create(options: CreateWorkflowMessageOptions): WorkflowMessage {
    validateContent(options.content, options.kind);
    const now = options.now ?? Date.now();
    const workflowMessageId =
      options.workflowMessageId ??
      workflowMessageIdFor(options.kind, options.sourceId, options.idempotencyKey);
    return this.state.transaction(() => {
      const existing = this.get(workflowMessageId);
      if (existing !== undefined) {
        assertSameMessage(existing, options);
        return existing;
      }
      const contentHash = this.state.putJson(options.content, now);
      const order =
        ((
          this.state.connection
            .prepare(
              `SELECT COALESCE(MAX(order_number), 0) AS value
             FROM workflow_messages WHERE target_session_id = ?`,
            )
            .get(options.targetSessionId) as { value: number }
        ).value ?? 0) + 1;
      this.state.connection
        .prepare(
          `INSERT INTO workflow_messages(
             workflow_message_id, run_id, target_session_id, kind, source_id, content_hash,
             order_number, status, pi_session_entry_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          workflowMessageId,
          options.runId,
          options.targetSessionId,
          options.kind,
          options.sourceId,
          contentHash,
          order,
          now,
          now,
        );
      return this.require(workflowMessageId);
    });
  }

  get(workflowMessageId: string): WorkflowMessage | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT workflow_message_id AS workflowMessageId, run_id AS runId,
                target_session_id AS targetSessionId, kind, source_id AS sourceId,
                content_hash AS contentHash, order_number AS orderNumber, status,
                pi_session_entry_id AS piSessionEntryId, created_at AS createdAt,
                updated_at AS updatedAt
         FROM workflow_messages WHERE workflow_message_id = ?`,
      )
      .get(workflowMessageId);
    return isWorkflowMessageRow(row) ? this.mapMessage(row) : undefined;
  }

  require(workflowMessageId: string): WorkflowMessage {
    const message = this.get(workflowMessageId);
    if (message === undefined) throw new Error(`Workflow message not found: ${workflowMessageId}`);
    return message;
  }

  listSession(targetSessionId: string): WorkflowMessage[] {
    const rows = this.state.connection
      .prepare(
        `SELECT workflow_message_id AS workflowMessageId, run_id AS runId,
                target_session_id AS targetSessionId, kind, source_id AS sourceId,
                content_hash AS contentHash, order_number AS orderNumber, status,
                pi_session_entry_id AS piSessionEntryId, created_at AS createdAt,
                updated_at AS updatedAt
         FROM workflow_messages WHERE target_session_id = ? ORDER BY order_number`,
      )
      .all(targetSessionId);
    return rows.filter(isWorkflowMessageRow).map((row) => this.mapMessage(row));
  }

  listRun(runId: string): WorkflowMessage[] {
    const rows = this.state.connection
      .prepare(
        `SELECT workflow_message_id AS workflowMessageId, run_id AS runId,
                target_session_id AS targetSessionId, kind, source_id AS sourceId,
                content_hash AS contentHash, order_number AS orderNumber, status,
                pi_session_entry_id AS piSessionEntryId, created_at AS createdAt,
                updated_at AS updatedAt
         FROM workflow_messages WHERE run_id = ? ORDER BY target_session_id, order_number`,
      )
      .all(runId);
    return rows.filter(isWorkflowMessageRow).map((row) => this.mapMessage(row));
  }

  latestForSource(kind: WorkflowMessageKind, sourceId: string): WorkflowMessage | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT workflow_message_id AS workflowMessageId, run_id AS runId,
                target_session_id AS targetSessionId, kind, source_id AS sourceId,
                content_hash AS contentHash, order_number AS orderNumber, status,
                pi_session_entry_id AS piSessionEntryId, created_at AS createdAt,
                updated_at AS updatedAt
         FROM workflow_messages WHERE kind = ? AND source_id = ?
         ORDER BY created_at DESC, order_number DESC LIMIT 1`,
      )
      .get(kind, sourceId);
    return isWorkflowMessageRow(row) ? this.mapMessage(row) : undefined;
  }

  cancelPendingForSource(
    sourceId: string,
    kind?: WorkflowMessageKind,
    now: number = Date.now(),
  ): number {
    return this.state.transaction(
      () =>
        this.state.connection
          .prepare(
            `UPDATE workflow_messages SET status = 'cancelled', updated_at = ?
             WHERE source_id = ? AND status = 'pending'${kind === undefined ? "" : " AND kind = ?"}`,
          )
          .run(...(kind === undefined ? [now, sourceId] : [now, sourceId, kind])).changes,
    );
  }

  adoptBranch(
    targetSessionId: string,
    entries: readonly WorkflowBranchEntry[],
    allowedMessageIds: ReadonlySet<string>,
    now: number = Date.now(),
  ): WorkflowMessage[] {
    return this.state.transaction(() => {
      const adopted: WorkflowMessage[] = [];
      for (const entry of entries) {
        if (!allowedMessageIds.has(entry.workflowMessageId)) {
          throw new Error(
            `Workflow branch report contains an unknown message: ${entry.workflowMessageId}`,
          );
        }
        const current = this.require(entry.workflowMessageId);
        if (current.targetSessionId !== targetSessionId) {
          throw new Error("Workflow branch report targets the wrong origin session");
        }
        if (
          current.status === "sent" &&
          current.piSessionEntryId !== null &&
          current.piSessionEntryId !== entry.piSessionEntryId
        ) {
          throw new Error("Workflow message has conflicting Pi session entry evidence");
        }
        if (current.status !== "sent") {
          this.state.connection
            .prepare(
              `UPDATE workflow_messages
               SET status = 'sent', pi_session_entry_id = ?, updated_at = ?
               WHERE workflow_message_id = ? AND status IN ('pending', 'cancelled')`,
            )
            .run(entry.piSessionEntryId, now, entry.workflowMessageId);
        }
        adopted.push(this.require(entry.workflowMessageId));
      }
      return adopted;
    });
  }

  startTurn(options: {
    workflowMessageId: string;
    workflowTurnId?: string;
    runId: string;
    targetSessionId: string;
    now?: number;
  }): WorkflowTurn {
    const now = options.now ?? Date.now();
    const workflowTurnId = options.workflowTurnId ?? `workflow-turn-${randomUUID()}`;
    return this.state.transaction(() => {
      const existing = this.getTurn(workflowTurnId);
      if (existing !== undefined) {
        assertSameTurn(existing, options);
        return existing;
      }
      const message = this.require(options.workflowMessageId);
      if (message.runId !== options.runId || message.targetSessionId !== options.targetSessionId) {
        throw new Error("Workflow turn does not match its message");
      }
      if (message.status !== "sent") throw new Error("Workflow turn requires a sent message");
      this.state.connection
        .prepare(
          `INSERT INTO workflow_turns(
             workflow_turn_id, workflow_message_id, run_id, target_session_id, state,
             stop_reason, response_session_entry_id, started_at, ended_at
           ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, ?, NULL)`,
        )
        .run(
          workflowTurnId,
          options.workflowMessageId,
          options.runId,
          options.targetSessionId,
          now,
        );
      return this.requireTurn(workflowTurnId);
    });
  }

  endTurn(options: {
    workflowMessageId: string;
    workflowTurnId: string;
    runId: string;
    targetSessionId: string;
    stopReason: WorkflowTurnStopReason;
    responseSessionEntryId?: string | null;
    now?: number;
  }): WorkflowTurn {
    const now = options.now ?? Date.now();
    return this.state.transaction(() => {
      const current = this.requireTurn(options.workflowTurnId);
      assertSameTurn(current, options);
      if (current.state === "ended") {
        if (
          current.stopReason !== options.stopReason ||
          current.responseSessionEntryId !== (options.responseSessionEntryId ?? null)
        ) {
          throw new Error("Workflow turn end report conflicts with its saved result");
        }
        return current;
      }
      const changed = this.state.connection
        .prepare(
          `UPDATE workflow_turns SET state = 'ended', stop_reason = ?,
                  response_session_entry_id = ?, ended_at = ?
           WHERE workflow_turn_id = ? AND workflow_message_id = ? AND state = 'started'`,
        )
        .run(
          options.stopReason,
          options.responseSessionEntryId ?? null,
          now,
          options.workflowTurnId,
          options.workflowMessageId,
        );
      if (changed.changes !== 1) throw new Error("Workflow turn changed before its end report");
      return this.requireTurn(options.workflowTurnId);
    });
  }

  getTurn(workflowTurnId: string): WorkflowTurn | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT workflow_turn_id AS workflowTurnId, workflow_message_id AS workflowMessageId,
                run_id AS runId, target_session_id AS targetSessionId, state,
                stop_reason AS stopReason, response_session_entry_id AS responseSessionEntryId,
                started_at AS startedAt, ended_at AS endedAt
         FROM workflow_turns WHERE workflow_turn_id = ?`,
      )
      .get(workflowTurnId);
    return isWorkflowTurnRow(row) ? mapTurn(row) : undefined;
  }

  requireTurn(workflowTurnId: string): WorkflowTurn {
    const turn = this.getTurn(workflowTurnId);
    if (turn === undefined) throw new Error(`Workflow turn not found: ${workflowTurnId}`);
    return turn;
  }

  openTurnForMessage(workflowMessageId: string): WorkflowTurn | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT workflow_turn_id AS workflowTurnId, workflow_message_id AS workflowMessageId,
                run_id AS runId, target_session_id AS targetSessionId, state,
                stop_reason AS stopReason, response_session_entry_id AS responseSessionEntryId,
                started_at AS startedAt, ended_at AS endedAt
         FROM workflow_turns WHERE workflow_message_id = ? AND state = 'started'`,
      )
      .get(workflowMessageId);
    return isWorkflowTurnRow(row) ? mapTurn(row) : undefined;
  }

  latestTurnForMessage(workflowMessageId: string): WorkflowTurn | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT workflow_turn_id AS workflowTurnId, workflow_message_id AS workflowMessageId,
                run_id AS runId, target_session_id AS targetSessionId, state,
                stop_reason AS stopReason, response_session_entry_id AS responseSessionEntryId,
                started_at AS startedAt, ended_at AS endedAt
         FROM workflow_turns WHERE workflow_message_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(workflowMessageId);
    return isWorkflowTurnRow(row) ? mapTurn(row) : undefined;
  }

  openTurnsForSession(targetSessionId: string): WorkflowTurn[] {
    const rows = this.state.connection
      .prepare(
        `SELECT workflow_turn_id AS workflowTurnId, workflow_message_id AS workflowMessageId,
                run_id AS runId, target_session_id AS targetSessionId, state,
                stop_reason AS stopReason, response_session_entry_id AS responseSessionEntryId,
                started_at AS startedAt, ended_at AS endedAt
         FROM workflow_turns WHERE target_session_id = ? AND state = 'started'
         ORDER BY started_at`,
      )
      .all(targetSessionId);
    return rows.filter(isWorkflowTurnRow).map(mapTurn);
  }

  private mapMessage(row: WorkflowMessageRow): WorkflowMessage {
    const content = this.state.readJson(row.contentHash);
    if (!isWorkflowMessageContent(content))
      throw new Error("Stored workflow message content is invalid");
    return {
      schema: WORKFLOW_MESSAGE_SCHEMA,
      workflowMessageId: row.workflowMessageId,
      runId: row.runId,
      targetSessionId: row.targetSessionId,
      kind: row.kind,
      sourceId: row.sourceId,
      contentDigest: row.contentHash.toString("hex"),
      content,
      order: row.orderNumber,
      status: row.status,
      piSessionEntryId: row.piSessionEntryId,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}

export function workflowMessageIdFor(
  kind: WorkflowMessageKind,
  sourceId: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ kind, sourceId, idempotencyKey }))
    .digest("hex");
  return `workflow-message-${digest}`;
}

export function isWorkflowMessageContent(value: unknown): value is WorkflowMessageContent {
  return (
    isRecord(value) &&
    value.schema === WORKFLOW_MESSAGE_CONTENT_SCHEMA &&
    typeof value.customType === "string" &&
    value.customType.length > 0 &&
    typeof value.content === "string" &&
    typeof value.display === "boolean" &&
    Object.hasOwn(value, "details") &&
    typeof value.triggerTurn === "boolean"
  );
}

function validateContent(content: WorkflowMessageContent, kind: WorkflowMessageKind): void {
  if (!isWorkflowMessageContent(content)) throw new Error("Workflow message content is invalid");
  const shouldTrigger = kind === "step" || kind === "terminal" || kind === "followUp";
  if (content.triggerTurn !== shouldTrigger) {
    throw new Error(`Workflow message kind ${kind} has invalid turn behavior`);
  }
  canonicalJson(content);
}

function assertSameMessage(message: WorkflowMessage, options: CreateWorkflowMessageOptions): void {
  const digest = createHash("sha256").update(canonicalJson(options.content)).digest("hex");
  if (
    message.runId !== options.runId ||
    message.targetSessionId !== options.targetSessionId ||
    message.kind !== options.kind ||
    message.sourceId !== options.sourceId ||
    message.contentDigest !== digest
  ) {
    throw new Error(`Workflow message idempotency conflict: ${message.workflowMessageId}`);
  }
}

function assertSameTurn(
  turn: WorkflowTurn,
  options: { workflowMessageId: string; runId: string; targetSessionId: string },
): void {
  if (
    turn.workflowMessageId !== options.workflowMessageId ||
    turn.runId !== options.runId ||
    turn.targetSessionId !== options.targetSessionId
  ) {
    throw new Error(`Workflow turn identity conflict: ${turn.workflowTurnId}`);
  }
}

function mapTurn(row: WorkflowTurnRow): WorkflowTurn {
  return {
    schema: WORKFLOW_TURN_SCHEMA,
    workflowTurnId: row.workflowTurnId,
    workflowMessageId: row.workflowMessageId,
    runId: row.runId,
    targetSessionId: row.targetSessionId,
    state: row.state,
    stopReason: row.stopReason,
    responseSessionEntryId: row.responseSessionEntryId,
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
  };
}

function isWorkflowMessageRow(value: unknown): value is WorkflowMessageRow {
  return (
    isRecord(value) &&
    typeof value.workflowMessageId === "string" &&
    typeof value.runId === "string" &&
    typeof value.targetSessionId === "string" &&
    isWorkflowMessageKind(value.kind) &&
    typeof value.sourceId === "string" &&
    Buffer.isBuffer(value.contentHash) &&
    typeof value.orderNumber === "number" &&
    isWorkflowMessageStatus(value.status) &&
    (value.piSessionEntryId === null || typeof value.piSessionEntryId === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isWorkflowTurnRow(value: unknown): value is WorkflowTurnRow {
  return (
    isRecord(value) &&
    typeof value.workflowTurnId === "string" &&
    typeof value.workflowMessageId === "string" &&
    typeof value.runId === "string" &&
    typeof value.targetSessionId === "string" &&
    (value.state === "started" || value.state === "ended") &&
    (value.stopReason === null || isWorkflowTurnStopReason(value.stopReason)) &&
    (value.responseSessionEntryId === null || typeof value.responseSessionEntryId === "string") &&
    typeof value.startedAt === "number" &&
    (value.endedAt === null || typeof value.endedAt === "number")
  );
}

function isWorkflowMessageKind(value: unknown): value is WorkflowMessageKind {
  return (
    value === "step" ||
    value === "decision" ||
    value === "notification" ||
    value === "terminal" ||
    value === "followUp"
  );
}

function isWorkflowMessageStatus(value: unknown): value is WorkflowMessageStatus {
  return value === "pending" || value === "sent" || value === "cancelled";
}

function isWorkflowTurnStopReason(value: unknown): value is WorkflowTurnStopReason {
  return value === "completed" || value === "aborted" || value === "error" || value === "lost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
