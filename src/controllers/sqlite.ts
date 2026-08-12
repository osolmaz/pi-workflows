import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  EffectRequestConflictError,
  ResourceConflictError,
  ResourceNotFoundError,
  WorkflowRequestConflictError,
} from "./errors.js";
import { canonicalJson, parseStoredJson } from "./json.js";
import {
  CONTROLLER_STORE_SCHEMA,
  type ControllerStore,
  type EffectReservation,
  type QueueItem,
  type QueueRequeueOptions,
  type WorkflowRecordUpdate,
  type WorkflowReservation,
  controllerStorePath,
} from "./store.js";
import type {
  ChildWorkflowRecord,
  ControllerEvent,
  ControllerQueueClaim,
  ControllerResource,
  ControllerResourceRef,
  ControllerResourceStatus,
  EffectRecord,
  JsonObject,
} from "./types.js";

const MAX_KEY_LENGTH = 512;
const MAX_ERROR_LENGTH = 8_192;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_RESOURCE_VALUE_BYTES = 1024 * 1024;

type ResourceRow = {
  controller: string;
  resource_key: string;
  uid: string;
  resource_version: number;
  generation: number;
  spec_json: string;
  status_json: string;
  deletion_timestamp: string | null;
  finalizers_json: string;
};

type QueueRow = {
  controller: string;
  resource_key: string;
  available_at: number;
  version: number;
  consecutive_errors: number;
  claim_token: string | null;
  claim_version: number | null;
  claim_expires_at: number | null;
};

type EffectRow = {
  effect_key: string;
  resource_uid: string;
  generation: number;
  kind: string;
  state: EffectRecord["state"];
  request_fingerprint: string;
  started_at: string;
  completed_at: string | null;
  external_ref: string | null;
  error: string | null;
};

type WorkflowRow = {
  request_id: string;
  resource_uid: string;
  request_key: string;
  input_fingerprint: string;
  workflow: string;
  run_id: string | null;
  state: ChildWorkflowRecord["state"];
  attempt: number;
  error: string | null;
};

type WorkflowRunQueueRow = {
  run_id: string;
  workflow_ref: string;
  workflow_path: string;
  input_json: string;
  status: "claimed" | "parked" | "done";
  runner_id: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  affinity_runner_id: string | null;
  parent_run_id: string | null;
  created_at: string;
  updated_at: string;
};

/** A user-started workflow run tracked by the durable run queue. */
export type WorkflowRunQueueRecord = {
  runId: string;
  /** Human-readable workflow name used in status and event output. */
  workflowName: string;
  /** Canonical source reference used to reopen the run. */
  workflowSourceRef: string;
  input: unknown;
  status: "claimed" | "parked" | "done";
  runnerId: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  affinityRunnerId: string | null;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

type RunEventRow = {
  seq: number;
  recorded_at: string;
  run_id: string;
  workflow_ref: string;
  type: string;
  runner_id: string | null;
  payload_json: string;
};

/** One run lifecycle transition in the cross-session event feed. */
export type RunEventRecord = {
  seq: number;
  recordedAt: string;
  runId: string;
  workflowRef: string;
  type: string;
  runnerId: string | null;
  payload: JsonObject;
};

type EventRow = {
  seq: number;
  recorded_at: string;
  controller: string;
  resource_key: string;
  type: string;
  payload_json: string;
};

export class SqliteControllerStore implements ControllerStore {
  readonly filePath: string;
  private readonly database: Database.Database;
  private closed = false;

  constructor(filePath: string = controllerStorePath(), options: { readOnly?: boolean } = {}) {
    this.filePath = path.resolve(filePath);
    const readOnly = options.readOnly ?? false;
    if (!readOnly) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(this.filePath), 0o700);
    }
    this.database = new Database(this.filePath, {
      readonly: readOnly,
      fileMustExist: readOnly,
    });
    if (!readOnly) {
      fs.chmodSync(this.filePath, 0o600);
    }
    this.configure(readOnly);
    this.initializeSchema(readOnly);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  putResource<TSpec, TStatus>(options: {
    controller: string;
    key: string;
    spec: TSpec;
    initialStatus: TStatus;
    now?: string;
  }): ControllerResource<TSpec, TStatus> {
    validateName(options.controller, "controller");
    validateKey(options.key, "resource key");
    const now = validTimestamp(options.now);
    const specJson = canonicalJson(options.spec, "controller resource spec");
    validateJsonSize(specJson, "Controller resource spec", MAX_RESOURCE_VALUE_BYTES);
    const initialStatus: ControllerResourceStatus<TStatus> = {
      observedGeneration: 0,
      conditions: [],
      controllerStatus: options.initialStatus,
    };
    const statusJson = canonicalJson(initialStatus, "controller resource status");
    validateJsonSize(statusJson, "Controller resource status", MAX_RESOURCE_VALUE_BYTES);

    return this.transaction(() => {
      const existing = this.resourceRow({ controller: options.controller, key: options.key });
      if (existing === undefined) {
        const uid = randomUUID();
        this.database
          .prepare(
            `INSERT INTO resources (
              controller, resource_key, uid, resource_version, generation,
              spec_json, status_json, deletion_timestamp, finalizers_json, updated_at
            ) VALUES (?, ?, ?, 1, 1, ?, ?, NULL, '[]', ?)`,
          )
          .run(options.controller, options.key, uid, specJson, statusJson, now);
        this.enqueueRow({ controller: options.controller, key: options.key }, epoch(now));
      } else if (existing.spec_json !== specJson) {
        this.database
          .prepare(
            `UPDATE resources
             SET spec_json = ?, resource_version = resource_version + 1,
                 generation = generation + 1, updated_at = ?
             WHERE controller = ? AND resource_key = ?`,
          )
          .run(specJson, now, options.controller, options.key);
        this.enqueueRow({ controller: options.controller, key: options.key }, epoch(now));
      }
      return this.requireResource<TSpec, TStatus>({
        controller: options.controller,
        key: options.key,
      });
    });
  }

  getResource<TSpec = unknown, TStatus = unknown>(
    ref: ControllerResourceRef,
  ): ControllerResource<TSpec, TStatus> | undefined {
    const row = this.resourceRow(ref);
    return row === undefined ? undefined : resourceFromRow<TSpec, TStatus>(row);
  }

  getResourceByUid(uid: string): ControllerResource | undefined {
    const row = this.database.prepare("SELECT * FROM resources WHERE uid = ?").get(uid) as
      | ResourceRow
      | undefined;
    return row === undefined ? undefined : resourceFromRow(row);
  }

  listResources<TSpec = unknown, TStatus = unknown>(
    options: {
      controller?: string;
    } = {},
  ): ControllerResource<TSpec, TStatus>[] {
    const rows =
      options.controller === undefined
        ? (this.database
            .prepare("SELECT * FROM resources ORDER BY controller, resource_key")
            .all() as ResourceRow[])
        : (this.database
            .prepare("SELECT * FROM resources WHERE controller = ? ORDER BY resource_key")
            .all(options.controller) as ResourceRow[]);
    return rows.map((row) => resourceFromRow<TSpec, TStatus>(row));
  }

  updateStatus<TStatus>(options: {
    ref: ControllerResourceRef;
    expectedResourceVersion: number;
    status: ControllerResourceStatus<TStatus>;
    finalizers?: string[];
    now?: string;
  }): ControllerResource<unknown, TStatus> {
    const now = validTimestamp(options.now);
    const statusJson = canonicalJson(options.status, "controller resource status");
    validateJsonSize(statusJson, "Controller resource status", MAX_RESOURCE_VALUE_BYTES);
    if (options.finalizers !== undefined) {
      validateFinalizers(options.finalizers);
    }
    return this.transaction(() => {
      const current = this.resourceRow(options.ref);
      if (current === undefined) {
        throw new ResourceNotFoundError(options.ref.controller, options.ref.key);
      }
      if (current.resource_version !== options.expectedResourceVersion) {
        throw new ResourceConflictError(options.ref.controller, options.ref.key);
      }
      const finalizersJson =
        options.finalizers === undefined
          ? current.finalizers_json
          : canonicalJson(options.finalizers);
      if (current.status_json === statusJson && current.finalizers_json === finalizersJson) {
        return resourceFromRow<unknown, TStatus>(current);
      }
      this.database
        .prepare(
          `UPDATE resources
           SET status_json = ?, finalizers_json = ?,
               resource_version = resource_version + 1, updated_at = ?
           WHERE controller = ? AND resource_key = ? AND resource_version = ?`,
        )
        .run(
          statusJson,
          finalizersJson,
          now,
          options.ref.controller,
          options.ref.key,
          options.expectedResourceVersion,
        );
      return this.requireResource<unknown, TStatus>(options.ref);
    });
  }

  requestDeletion(ref: ControllerResourceRef, now?: string): ControllerResource {
    const timestamp = validTimestamp(now);
    return this.transaction(() => {
      const row = this.resourceRow(ref);
      if (row === undefined) {
        throw new ResourceNotFoundError(ref.controller, ref.key);
      }
      if (row.deletion_timestamp === null) {
        this.database
          .prepare(
            `UPDATE resources
             SET deletion_timestamp = ?, resource_version = resource_version + 1, updated_at = ?
             WHERE controller = ? AND resource_key = ?`,
          )
          .run(timestamp, timestamp, ref.controller, ref.key);
      }
      this.enqueueRow(ref, epoch(timestamp));
      return this.requireResource(ref);
    });
  }

  updateFinalizers(options: {
    ref: ControllerResourceRef;
    expectedResourceVersion: number;
    finalizers: string[];
    now?: string;
  }): ControllerResource {
    validateFinalizers(options.finalizers);
    const now = validTimestamp(options.now);
    const result = this.database
      .prepare(
        `UPDATE resources
         SET finalizers_json = ?, resource_version = resource_version + 1, updated_at = ?
         WHERE controller = ? AND resource_key = ? AND resource_version = ?`,
      )
      .run(
        canonicalJson(options.finalizers),
        now,
        options.ref.controller,
        options.ref.key,
        options.expectedResourceVersion,
      );
    if (result.changes !== 1) {
      this.throwMissingOrConflict(options.ref);
    }
    return this.requireResource(options.ref);
  }

  deleteResource(ref: ControllerResourceRef, expectedResourceVersion: number): boolean {
    const row = this.resourceRow(ref);
    if (row === undefined) {
      return false;
    }
    const finalizers = parseStoredJson<string[]>(row.finalizers_json, "resource finalizers");
    if (row.deletion_timestamp === null || finalizers.length > 0) {
      throw new Error(`Controller resource ${ref.controller}/${ref.key} is not ready for deletion`);
    }
    const result = this.database
      .prepare(
        `DELETE FROM resources
         WHERE controller = ? AND resource_key = ? AND resource_version = ?`,
      )
      .run(ref.controller, ref.key, expectedResourceVersion);
    if (result.changes !== 1) {
      throw new ResourceConflictError(ref.controller, ref.key);
    }
    return true;
  }

  enqueue(ref: ControllerResourceRef, availableAt?: string): void {
    const at = validTimestamp(availableAt);
    if (this.resourceRow(ref) === undefined) {
      throw new ResourceNotFoundError(ref.controller, ref.key);
    }
    this.enqueueRow(ref, epoch(at));
  }

  claimNext(options: {
    controllers: string[];
    leaseMs: number;
    now?: string;
  }): ControllerQueueClaim | undefined {
    validateDuration(options.leaseMs, "leaseMs");
    if (options.controllers.length === 0) {
      return undefined;
    }
    const now = validTimestamp(options.now);
    const nowMs = epoch(now);
    const placeholders = options.controllers.map(() => "?").join(", ");
    return this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT * FROM queue
           WHERE controller IN (${placeholders})
             AND available_at <= ?
             AND (claim_token IS NULL OR claim_expires_at <= ?)
           ORDER BY available_at, controller, resource_key
           LIMIT 1`,
        )
        .get(...options.controllers, nowMs, nowMs) as QueueRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const token = randomUUID();
      const expiresAtMs = nowMs + options.leaseMs;
      const result = this.database
        .prepare(
          `UPDATE queue
           SET claim_token = ?, claim_version = version, claim_expires_at = ?
           WHERE controller = ? AND resource_key = ?
             AND (claim_token IS NULL OR claim_expires_at <= ?)`,
        )
        .run(token, expiresAtMs, row.controller, row.resource_key, nowMs);
      if (result.changes !== 1) {
        return undefined;
      }
      return {
        controller: row.controller,
        key: row.resource_key,
        token,
        queueVersion: row.version,
        consecutiveErrors: row.consecutive_errors,
        expiresAt: iso(expiresAtMs),
      };
    });
  }

  renewClaim(claim: ControllerQueueClaim, leaseMs: number, now?: string): boolean {
    validateDuration(leaseMs, "leaseMs");
    const nowMs = epoch(validTimestamp(now));
    const expiresAt = nowMs + leaseMs;
    const result = this.database
      .prepare(
        `UPDATE queue SET claim_expires_at = ?
         WHERE controller = ? AND resource_key = ? AND claim_token = ?
           AND claim_expires_at > ?`,
      )
      .run(expiresAt, claim.controller, claim.key, claim.token, nowMs);
    return result.changes === 1;
  }

  settleClaim(claim: ControllerQueueClaim, now?: string): boolean {
    const nowMs = epoch(validTimestamp(now));
    return this.transaction(() => {
      const row = this.claimedRow(claim);
      if (row === undefined) {
        return false;
      }
      if (row.version === row.claim_version) {
        this.database
          .prepare(
            "DELETE FROM queue WHERE controller = ? AND resource_key = ? AND claim_token = ?",
          )
          .run(claim.controller, claim.key, claim.token);
      } else {
        this.database
          .prepare(
            `UPDATE queue
             SET claim_token = NULL, claim_version = NULL, claim_expires_at = NULL,
                 available_at = MIN(available_at, ?), consecutive_errors = 0, last_error = NULL
             WHERE controller = ? AND resource_key = ? AND claim_token = ?`,
          )
          .run(nowMs, claim.controller, claim.key, claim.token);
      }
      return true;
    });
  }

  requeueClaim(claim: ControllerQueueClaim, options: QueueRequeueOptions, _now?: string): boolean {
    const availableAt = epoch(validTimestamp(options.availableAt));
    const error = options.error === undefined ? null : truncateError(options.error);
    return this.transaction(() => {
      const row = this.claimedRow(claim);
      if (row === undefined) {
        return false;
      }
      const eventArrived = row.version !== row.claim_version;
      const nextAvailableAt = eventArrived ? Math.min(row.available_at, availableAt) : availableAt;
      const nextErrors = options.error === undefined ? 0 : row.consecutive_errors + 1;
      this.database
        .prepare(
          `UPDATE queue
           SET claim_token = NULL, claim_version = NULL, claim_expires_at = NULL,
               available_at = ?, consecutive_errors = ?, last_error = ?
           WHERE controller = ? AND resource_key = ? AND claim_token = ?`,
        )
        .run(nextAvailableAt, nextErrors, error, claim.controller, claim.key, claim.token);
      return true;
    });
  }

  listQueue(): QueueItem[] {
    const rows = this.database
      .prepare("SELECT * FROM queue ORDER BY available_at, controller, resource_key")
      .all() as QueueRow[];
    return rows.map((row) => ({
      controller: row.controller,
      key: row.resource_key,
      availableAt: iso(row.available_at),
      consecutiveErrors: row.consecutive_errors,
      ...(row.claim_expires_at === null ? {} : { claimExpiresAt: iso(row.claim_expires_at) }),
    }));
  }

  reserveEffect(options: {
    key: string;
    resourceUid: string;
    generation: number;
    kind: string;
    requestFingerprint: string;
    now?: string;
  }): EffectReservation {
    validateKey(options.key, "effect key");
    validateName(options.kind, "effect kind");
    const now = validTimestamp(options.now);
    return this.transaction(() => {
      const existing = this.effectRow(options.resourceUid, options.key);
      if (existing !== undefined) {
        if (
          existing.request_fingerprint !== options.requestFingerprint ||
          existing.generation !== options.generation ||
          existing.kind !== options.kind
        ) {
          throw new EffectRequestConflictError(options.key);
        }
        return { record: effectFromRow(existing), created: false };
      }
      this.database
        .prepare(
          `INSERT INTO effects (
            effect_key, resource_uid, generation, kind, state,
            request_fingerprint, started_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          options.key,
          options.resourceUid,
          options.generation,
          options.kind,
          options.requestFingerprint,
          now,
        );
      return {
        record: this.requireEffect(options.resourceUid, options.key),
        created: true,
      };
    });
  }

  getEffect(resourceUid: string, key: string): EffectRecord | undefined {
    const row = this.effectRow(resourceUid, key);
    return row === undefined ? undefined : effectFromRow(row);
  }

  updateEffect(options: {
    resourceUid: string;
    key: string;
    state: EffectRecord["state"];
    externalRef?: string;
    error?: string;
    now?: string;
  }): EffectRecord {
    const row = this.effectRow(options.resourceUid, options.key);
    if (row === undefined) {
      throw new Error(`Effect record not found: ${options.resourceUid}/${options.key}`);
    }
    if ((row.state === "applied" || row.state === "rejected") && row.state !== options.state) {
      throw new Error(`Effect ${JSON.stringify(options.key)} is already ${row.state}`);
    }
    const completedAt =
      options.state === "applied" || options.state === "rejected"
        ? validTimestamp(options.now)
        : null;
    this.database
      .prepare(
        `UPDATE effects
         SET state = ?, external_ref = COALESCE(?, external_ref), error = ?, completed_at = ?
         WHERE resource_uid = ? AND effect_key = ?`,
      )
      .run(
        options.state,
        options.externalRef ?? null,
        options.error === undefined ? null : truncateError(options.error),
        completedAt,
        options.resourceUid,
        options.key,
      );
    return this.requireEffect(options.resourceUid, options.key);
  }

  listEffects(resourceUid: string): EffectRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM effects WHERE resource_uid = ? ORDER BY started_at, effect_key")
      .all(resourceUid) as EffectRow[];
    return rows.map(effectFromRow);
  }

  reserveWorkflow(options: {
    resourceUid: string;
    requestKey: string;
    workflow: string;
    inputFingerprint: string;
  }): WorkflowReservation {
    validateKey(options.requestKey, "workflow request key");
    validateKey(options.workflow, "workflow name");
    return this.transaction(() => {
      const existing = this.workflowRow(options.resourceUid, options.requestKey);
      if (existing !== undefined) {
        if (
          existing.input_fingerprint !== options.inputFingerprint ||
          existing.workflow !== options.workflow
        ) {
          throw new WorkflowRequestConflictError(options.requestKey);
        }
        return { record: workflowFromRow(existing), created: false };
      }
      const requestId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO workflow_requests (
            request_id, resource_uid, request_key, input_fingerprint,
            workflow, state, attempt
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
        )
        .run(
          requestId,
          options.resourceUid,
          options.requestKey,
          options.inputFingerprint,
          options.workflow,
        );
      return {
        record: this.requireWorkflow(requestId),
        created: true,
      };
    });
  }

  getWorkflow(resourceUid: string, requestKey: string): ChildWorkflowRecord | undefined {
    const row = this.workflowRow(resourceUid, requestKey);
    return row === undefined ? undefined : workflowFromRow(row);
  }

  getWorkflowByRequestId(requestId: string): ChildWorkflowRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM workflow_requests WHERE request_id = ?")
      .get(requestId) as WorkflowRow | undefined;
    return row === undefined ? undefined : workflowFromRow(row);
  }

  updateWorkflow(requestId: string, update: WorkflowRecordUpdate): ChildWorkflowRecord {
    const existing = this.database
      .prepare("SELECT * FROM workflow_requests WHERE request_id = ?")
      .get(requestId) as WorkflowRow | undefined;
    if (existing === undefined) {
      throw new Error(`Workflow request not found: ${requestId}`);
    }
    const runId = update.runId === undefined ? existing.run_id : update.runId;
    const attempt = update.attempt ?? existing.attempt;
    const error =
      update.error === undefined
        ? existing.error
        : update.error === null
          ? null
          : truncateError(update.error);
    this.database
      .prepare(
        `UPDATE workflow_requests
         SET run_id = ?, state = ?, attempt = ?, error = ?
         WHERE request_id = ?`,
      )
      .run(runId, update.state, attempt, error, requestId);
    return this.requireWorkflow(requestId);
  }

  listWorkflows(resourceUid: string): ChildWorkflowRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM workflow_requests WHERE resource_uid = ? ORDER BY rowid")
      .all(resourceUid) as WorkflowRow[];
    return rows.map(workflowFromRow);
  }

  recordEvent(options: {
    controller: string;
    key: string;
    type: string;
    payload?: JsonObject;
    now?: string;
  }): ControllerEvent {
    validateName(options.controller, "controller");
    validateKey(options.key, "resource key");
    validateName(options.type, "event type");
    const recordedAt = validTimestamp(options.now);
    const payloadJson = canonicalJson(options.payload ?? {}, "controller event payload");
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_BYTES) {
      throw new Error(`Controller event payload exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    const result = this.database
      .prepare(
        `INSERT INTO events (recorded_at, controller, resource_key, type, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(recordedAt, options.controller, options.key, options.type, payloadJson);
    return this.requireEvent(Number(result.lastInsertRowid));
  }

  listEvents(
    options: {
      controller?: string;
      key?: string;
      limit?: number;
    } = {},
  ): ControllerEvent[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("Event limit must be between 1 and 10000");
    }
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.controller !== undefined) {
      clauses.push("controller = ?");
      values.push(options.controller);
    }
    if (options.key !== undefined) {
      clauses.push("resource_key = ?");
      values.push(options.key);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...values, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  private configure(readOnly: boolean): void {
    if (!readOnly) {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("foreign_keys = ON");
    }
    this.database.pragma("busy_timeout = 5000");
  }

  private initializeSchema(readOnly: boolean): void {
    if (!readOnly) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_info (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_id TEXT NOT NULL
        );
      `);
    }
    const row = this.database
      .prepare("SELECT schema_id FROM schema_info WHERE singleton = 1")
      .get() as { schema_id: string } | undefined;
    if (row !== undefined && row.schema_id !== CONTROLLER_STORE_SCHEMA) {
      throw new Error(`Unsupported controller store schema: ${row.schema_id}`);
    }
    if (readOnly) {
      if (row === undefined) {
        throw new Error("Controller store has no schema identifier");
      }
      return;
    }
    this.transaction(() => {
      this.database
        .prepare("INSERT OR IGNORE INTO schema_info (singleton, schema_id) VALUES (1, ?)")
        .run(CONTROLLER_STORE_SCHEMA);
      this.database.exec(SCHEMA_SQL);
    });
  }

  private transaction<T>(task: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = task();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private resourceRow(ref: ControllerResourceRef): ResourceRow | undefined {
    return this.database
      .prepare("SELECT * FROM resources WHERE controller = ? AND resource_key = ?")
      .get(ref.controller, ref.key) as ResourceRow | undefined;
  }

  private requireResource<TSpec = unknown, TStatus = unknown>(
    ref: ControllerResourceRef,
  ): ControllerResource<TSpec, TStatus> {
    const resource = this.getResource<TSpec, TStatus>(ref);
    if (resource === undefined) {
      throw new ResourceNotFoundError(ref.controller, ref.key);
    }
    return resource;
  }

  private throwMissingOrConflict(ref: ControllerResourceRef): never {
    if (this.resourceRow(ref) === undefined) {
      throw new ResourceNotFoundError(ref.controller, ref.key);
    }
    throw new ResourceConflictError(ref.controller, ref.key);
  }

  private enqueueRow(ref: ControllerResourceRef, availableAt: number): void {
    this.database
      .prepare(
        `INSERT INTO queue (
          controller, resource_key, available_at, version, consecutive_errors
        ) VALUES (?, ?, ?, 1, 0)
        ON CONFLICT(controller, resource_key) DO UPDATE SET
          available_at = MIN(queue.available_at, excluded.available_at),
          version = queue.version + 1`,
      )
      .run(ref.controller, ref.key, availableAt);
  }

  private claimedRow(claim: ControllerQueueClaim): QueueRow | undefined {
    return this.database
      .prepare(
        `SELECT * FROM queue
         WHERE controller = ? AND resource_key = ? AND claim_token = ?`,
      )
      .get(claim.controller, claim.key, claim.token) as QueueRow | undefined;
  }

  private effectRow(resourceUid: string, key: string): EffectRow | undefined {
    return this.database
      .prepare("SELECT * FROM effects WHERE resource_uid = ? AND effect_key = ?")
      .get(resourceUid, key) as EffectRow | undefined;
  }

  private requireEffect(resourceUid: string, key: string): EffectRecord {
    const effect = this.getEffect(resourceUid, key);
    if (effect === undefined) {
      throw new Error(`Effect record not found: ${resourceUid}/${key}`);
    }
    return effect;
  }

  private workflowRow(resourceUid: string, requestKey: string): WorkflowRow | undefined {
    return this.database
      .prepare("SELECT * FROM workflow_requests WHERE resource_uid = ? AND request_key = ?")
      .get(resourceUid, requestKey) as WorkflowRow | undefined;
  }

  private requireWorkflow(requestId: string): ChildWorkflowRecord {
    const workflow = this.getWorkflowByRequestId(requestId);
    if (workflow === undefined) {
      throw new Error(`Workflow request not found: ${requestId}`);
    }
    return workflow;
  }

  /**
   * Insert a user-started run and claim it in one statement, so the
   * originating runner owns the run from birth (origin affinity).
   */
  enqueueWorkflowRun(options: {
    runId: string;
    workflowName: string;
    workflowSourceRef: string;
    input: unknown;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    affinityRunnerId?: string;
    parentRunId?: string;
    now?: string;
  }): WorkflowRunQueueRecord {
    validateRunId(options.runId);
    validateKey(options.workflowName, "workflow name");
    validateKey(options.workflowSourceRef, "workflow source ref");
    validateKey(options.runnerId, "runner id");
    validateKey(options.claimToken, "claim token");
    validateDuration(options.leaseMs, "leaseMs");
    const inputJson = canonicalJson(options.input ?? null, "workflow run input");
    validateJsonSize(inputJson, "Workflow run input", MAX_RESOURCE_VALUE_BYTES);
    const now = validTimestamp(options.now);
    const expiresAt = epoch(now) + options.leaseMs;
    this.database
      .prepare(
        `INSERT INTO workflow_run_queue (
          run_id, workflow_ref, workflow_path, input_json, status,
          runner_id, claim_token, claim_expires_at, affinity_runner_id,
          parent_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.runId,
        options.workflowName,
        options.workflowSourceRef,
        inputJson,
        options.runnerId,
        options.claimToken,
        expiresAt,
        options.affinityRunnerId ?? options.runnerId,
        options.parentRunId ?? null,
        now,
        now,
      );
    return this.requireWorkflowRun(options.runId);
  }

  getWorkflowRun(runId: string): WorkflowRunQueueRecord | undefined {
    validateRunId(runId);
    const row = this.database
      .prepare("SELECT * FROM workflow_run_queue WHERE run_id = ?")
      .get(runId) as WorkflowRunQueueRow | undefined;
    return row === undefined ? undefined : workflowRunFromRow(row);
  }

  listWorkflowRuns(
    options: { status?: WorkflowRunQueueRecord["status"] } = {},
  ): WorkflowRunQueueRecord[] {
    const rows =
      options.status === undefined
        ? (this.database
            .prepare("SELECT * FROM workflow_run_queue ORDER BY created_at")
            .all() as WorkflowRunQueueRow[])
        : (this.database
            .prepare("SELECT * FROM workflow_run_queue WHERE status = ? ORDER BY created_at")
            .all(options.status) as WorkflowRunQueueRow[]);
    return rows.map(workflowRunFromRow);
  }

  /**
   * Claim the oldest claimable run, preferring runs with affinity to this
   * runner. Parked rows are claimable immediately; claimed rows become
   * claimable once their lease expires, so a dead or stalled runner never
   * strands a run. Returns undefined when nothing is claimable.
   */
  claimNextWorkflowRun(options: {
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    excludeRunIds?: string[];
    now?: string;
  }): WorkflowRunQueueRecord | undefined {
    validateKey(options.runnerId, "runner id");
    validateKey(options.claimToken, "claim token");
    validateDuration(options.leaseMs, "leaseMs");
    const now = validTimestamp(options.now);
    const nowMs = epoch(now);
    const expiresAt = nowMs + options.leaseMs;
    const excluded = options.excludeRunIds ?? [];
    for (const runId of excluded) {
      validateRunId(runId);
    }
    const exclusion =
      excluded.length === 0 ? "" : `AND run_id NOT IN (${excluded.map(() => "?").join(", ")})`;
    const claimable = `(
      status = 'parked'
      OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
    )`;
    return this.transaction(() => {
      const candidate = this.database
        .prepare(
          `SELECT run_id FROM workflow_run_queue
           WHERE ${claimable} ${exclusion}
           ORDER BY
             CASE WHEN affinity_runner_id = ? THEN 0 ELSE 1 END,
             created_at ASC
           LIMIT 1`,
        )
        .get(nowMs, ...excluded, options.runnerId) as { run_id: string } | undefined;
      if (candidate === undefined) {
        return undefined;
      }
      const result = this.database
        .prepare(
          `UPDATE workflow_run_queue
           SET status = 'claimed', runner_id = ?, claim_token = ?,
               claim_expires_at = ?, updated_at = ?
           WHERE run_id = ? AND (
             status = 'parked'
             OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
           )`,
        )
        .run(options.runnerId, options.claimToken, expiresAt, now, candidate.run_id, nowMs);
      return result.changes === 1 ? this.requireWorkflowRun(candidate.run_id) : undefined;
    });
  }

  /** Extend a live claim. Rejects expired or foreign claims. */
  renewWorkflowRunClaim(options: {
    runId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): boolean {
    validateRunId(options.runId);
    validateDuration(options.leaseMs, "leaseMs");
    const nowMs = epoch(validTimestamp(options.now));
    const expiresAt = nowMs + options.leaseMs;
    const result = this.database
      .prepare(
        `UPDATE workflow_run_queue SET claim_expires_at = ?
         WHERE run_id = ? AND claim_token = ? AND status = 'claimed'
           AND claim_expires_at > ?`,
      )
      .run(expiresAt, options.runId, options.claimToken, nowMs);
    return result.changes === 1;
  }

  /** The fence check: true only while this exact claim is live. */
  verifyWorkflowRunClaim(options: { runId: string; claimToken: string; now?: string }): boolean {
    validateRunId(options.runId);
    const nowMs = epoch(validTimestamp(options.now));
    const row = this.database
      .prepare(
        `SELECT 1 AS live FROM workflow_run_queue
         WHERE run_id = ? AND claim_token = ? AND status = 'claimed'
           AND claim_expires_at > ?`,
      )
      .get(options.runId, options.claimToken, nowMs);
    return row !== undefined;
  }

  /** Release a claim and park the run so another runner can resume it. */
  parkWorkflowRun(options: { runId: string; claimToken: string; now?: string }): boolean {
    validateRunId(options.runId);
    const now = validTimestamp(options.now);
    const result = this.database
      .prepare(
        `UPDATE workflow_run_queue
         SET status = 'parked', runner_id = NULL, claim_token = NULL,
             claim_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(now, options.runId, options.claimToken);
    return result.changes === 1;
  }

  /**
   * Delete a claimed row. Used when a continuation fails before its bundle
   * exists, so the parent's one-continuation slot is not consumed by a run
   * that never happened.
   */
  deleteWorkflowRun(options: { runId: string; claimToken: string }): boolean {
    validateRunId(options.runId);
    const result = this.database
      .prepare("DELETE FROM workflow_run_queue WHERE run_id = ? AND claim_token = ?")
      .run(options.runId, options.claimToken);
    return result.changes === 1;
  }

  /** Release a claim and mark the run terminal in the queue. */
  completeWorkflowRun(options: { runId: string; claimToken: string; now?: string }): boolean {
    validateRunId(options.runId);
    const now = validTimestamp(options.now);
    const result = this.database
      .prepare(
        `UPDATE workflow_run_queue
         SET status = 'done', runner_id = NULL, claim_token = NULL,
             claim_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND claim_token = ? AND status = 'claimed'`,
      )
      .run(now, options.runId, options.claimToken);
    return result.changes === 1;
  }

  /** Claim and rewrite one proved legacy workflow source queue row atomically. */
  claimLegacyWorkflowSourceRun(options: {
    runId: string;
    oldWorkflowPath: string;
    workflowSourceRef: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): boolean {
    validateRunId(options.runId);
    validateKey(options.oldWorkflowPath, "legacy workflow path");
    validateKey(options.workflowSourceRef, "workflow source ref");
    validateKey(options.runnerId, "runner id");
    validateKey(options.claimToken, "claim token");
    validateDuration(options.leaseMs, "leaseMs");
    const now = validTimestamp(options.now);
    const nowMs = epoch(now);
    const expiresAt = nowMs + options.leaseMs;
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM workflow_run_queue WHERE run_id = ?")
        .get(options.runId) as WorkflowRunQueueRow | undefined;
      if (row === undefined || row.status === "done") return false;
      const sourceMatches =
        row.workflow_path === options.oldWorkflowPath ||
        row.workflow_path === options.workflowSourceRef;
      const claimable =
        row.status === "parked" ||
        (row.status === "claimed" &&
          row.claim_token === options.claimToken &&
          row.claim_expires_at !== null &&
          row.claim_expires_at > nowMs) ||
        (row.status === "claimed" &&
          row.claim_expires_at !== null &&
          row.claim_expires_at <= nowMs);
      if (!sourceMatches || !claimable) return false;
      const result = this.database
        .prepare(
          `UPDATE workflow_run_queue
           SET workflow_path = ?, status = 'claimed', runner_id = ?,
               claim_token = ?, claim_expires_at = ?, updated_at = ?
           WHERE run_id = ? AND status != 'done'`,
        )
        .run(
          options.workflowSourceRef,
          options.runnerId,
          options.claimToken,
          expiresAt,
          now,
          options.runId,
        );
      return result.changes === 1;
    });
  }

  /** Append a run lifecycle transition to the event feed. */
  recordRunEvent(options: {
    runId: string;
    workflowRef: string;
    type: string;
    runnerId?: string;
    payload?: JsonObject;
    now?: string;
  }): number {
    validateRunId(options.runId);
    validateKey(options.type, "run event type");
    const payloadJson = canonicalJson(options.payload ?? {}, "run event payload");
    validateJsonSize(payloadJson, "Run event payload", MAX_EVENT_BYTES);
    const result = this.database
      .prepare(
        `INSERT INTO run_events (recorded_at, run_id, workflow_ref, type, runner_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validTimestamp(options.now),
        options.runId,
        options.workflowRef,
        options.type,
        options.runnerId ?? null,
        payloadJson,
      );
    return Number(result.lastInsertRowid);
  }

  /** List run events after a watermark, oldest first. */
  listRunEventsAfter(seq: number, options: { limit?: number } = {}): RunEventRecord[] {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`Invalid run event watermark: ${seq}`);
    }
    const rows = this.database
      .prepare("SELECT * FROM run_events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(seq, limit) as RunEventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      recordedAt: row.recorded_at,
      runId: row.run_id,
      workflowRef: row.workflow_ref,
      type: row.type,
      runnerId: row.runner_id,
      payload: parseStoredJson<JsonObject>(row.payload_json, "run event payload"),
    }));
  }

  /** The highest run event seq in the feed; 0 when empty. */
  latestRunEventSeq(): number {
    const row = this.database.prepare("SELECT MAX(seq) AS latest FROM run_events").get() as {
      latest: number | null;
    };
    return row.latest ?? 0;
  }

  /** The last run event this session was told about; 0 before any sync. */
  getSessionWatermark(sessionId: string): number {
    validateKey(sessionId, "session id");
    const row = this.database
      .prepare("SELECT last_event_seq FROM session_watermarks WHERE session_id = ?")
      .get(sessionId) as { last_event_seq: number } | undefined;
    return row?.last_event_seq ?? 0;
  }

  setSessionWatermark(sessionId: string, seq: number, now?: string): void {
    validateKey(sessionId, "session id");
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`Invalid run event watermark: ${seq}`);
    }
    this.database
      .prepare(
        `INSERT INTO session_watermarks (session_id, last_event_seq, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_event_seq = MAX(session_watermarks.last_event_seq, excluded.last_event_seq),
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, seq, validTimestamp(now));
  }

  private requireWorkflowRun(runId: string): WorkflowRunQueueRecord {
    const record = this.getWorkflowRun(runId);
    if (record === undefined) {
      throw new Error(`Workflow run queue record not found: ${runId}`);
    }
    return record;
  }

  private requireEvent(seq: number): ControllerEvent {
    const row = this.database.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as
      | EventRow
      | undefined;
    if (row === undefined) {
      throw new Error(`Controller event not found: ${seq}`);
    }
    return eventFromRow(row);
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS resources (
    controller TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    uid TEXT NOT NULL UNIQUE,
    resource_version INTEGER NOT NULL CHECK (resource_version > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    spec_json TEXT NOT NULL,
    status_json TEXT NOT NULL,
    deletion_timestamp TEXT,
    finalizers_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (controller, resource_key)
  );

  CREATE TABLE IF NOT EXISTS queue (
    controller TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    available_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    consecutive_errors INTEGER NOT NULL CHECK (consecutive_errors >= 0),
    last_error TEXT,
    claim_token TEXT,
    claim_version INTEGER,
    claim_expires_at INTEGER,
    PRIMARY KEY (controller, resource_key),
    FOREIGN KEY (controller, resource_key)
      REFERENCES resources(controller, resource_key) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS queue_ready
    ON queue(available_at, controller, resource_key);

  CREATE TABLE IF NOT EXISTS workflow_run_queue (
    run_id TEXT PRIMARY KEY,
    workflow_ref TEXT NOT NULL,
    workflow_path TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('claimed', 'parked', 'done')),
    runner_id TEXT,
    claim_token TEXT,
    claim_expires_at INTEGER,
    affinity_runner_id TEXT,
    parent_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflow_run_queue_claimable
    ON workflow_run_queue(status, claim_expires_at);
  -- A checkpointed parent admits exactly one continuation run, across
  -- sessions and processes.
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_queue_parent
    ON workflow_run_queue(parent_run_id) WHERE parent_run_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS run_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_ref TEXT NOT NULL,
    type TEXT NOT NULL,
    runner_id TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id);

  CREATE TABLE IF NOT EXISTS session_watermarks (
    session_id TEXT PRIMARY KEY,
    last_event_seq INTEGER NOT NULL CHECK (last_event_seq >= 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS effects (
    effect_key TEXT NOT NULL,
    resource_uid TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected', 'indeterminate')),
    request_fingerprint TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    external_ref TEXT,
    error TEXT,
    PRIMARY KEY (resource_uid, effect_key),
    FOREIGN KEY (resource_uid) REFERENCES resources(uid) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workflow_requests (
    request_id TEXT PRIMARY KEY,
    resource_uid TEXT NOT NULL,
    request_key TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    workflow TEXT NOT NULL,
    run_id TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'interrupted')
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    error TEXT,
    UNIQUE (resource_uid, request_key),
    FOREIGN KEY (resource_uid) REFERENCES resources(uid) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    controller TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_resource
    ON events(controller, resource_key, seq DESC);
`;

function resourceFromRow<TSpec, TStatus>(row: ResourceRow): ControllerResource<TSpec, TStatus> {
  const finalizers = parseStoredJson<string[]>(row.finalizers_json, "resource finalizers");
  validateFinalizers(finalizers);
  return {
    metadata: {
      uid: row.uid,
      controller: row.controller,
      key: row.resource_key,
      resourceVersion: row.resource_version,
      generation: row.generation,
      ...(row.deletion_timestamp === null ? {} : { deletionTimestamp: row.deletion_timestamp }),
      finalizers,
    },
    spec: parseStoredJson<TSpec>(row.spec_json, "resource spec"),
    status: parseStoredJson<ControllerResourceStatus<TStatus>>(row.status_json, "resource status"),
  };
}

function effectFromRow(row: EffectRow): EffectRecord {
  return {
    key: row.effect_key,
    resourceUid: row.resource_uid,
    generation: row.generation,
    kind: row.kind,
    state: row.state,
    requestFingerprint: row.request_fingerprint,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.external_ref === null ? {} : { externalRef: row.external_ref }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function workflowFromRow(row: WorkflowRow): ChildWorkflowRecord {
  return {
    requestId: row.request_id,
    resourceUid: row.resource_uid,
    requestKey: row.request_key,
    inputFingerprint: row.input_fingerprint,
    workflow: row.workflow,
    state: row.state,
    attempt: row.attempt,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function workflowRunFromRow(row: WorkflowRunQueueRow): WorkflowRunQueueRecord {
  return {
    runId: row.run_id,
    workflowName: row.workflow_ref,
    workflowSourceRef: row.workflow_path,
    input: parseStoredJson(row.input_json, "workflow run input"),
    status: row.status,
    runnerId: row.runner_id,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at === null ? null : iso(row.claim_expires_at),
    affinityRunnerId: row.affinity_runner_id,
    parentRunId: row.parent_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
    throw new Error(`Invalid workflow run id: ${JSON.stringify(runId)}`);
  }
}

function eventFromRow(row: EventRow): ControllerEvent {
  return {
    seq: row.seq,
    recordedAt: row.recorded_at,
    controller: row.controller,
    key: row.resource_key,
    type: row.type,
    payload: parseStoredJson<JsonObject>(row.payload_json, "controller event payload"),
  };
}

function validTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Invalid timestamp: ${JSON.stringify(timestamp)}`);
  }
  return timestamp;
}

function epoch(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Timestamp is outside the supported range: ${value}`);
  }
  return parsed;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function validateDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateName(value: string, description: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`${description} contains unsupported characters: ${JSON.stringify(value)}`);
  }
}

function validateKey(value: string, description: string): void {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return code < 32 || code === 127;
  });
  if (value.length === 0 || value.length > MAX_KEY_LENGTH || hasControl) {
    throw new Error(`${description} must be 1-${MAX_KEY_LENGTH} printable characters`);
  }
}

function validateFinalizers(finalizers: string[]): void {
  const seen = new Set<string>();
  for (const finalizer of finalizers) {
    validateName(finalizer, "finalizer");
    if (seen.has(finalizer)) {
      throw new Error(`Duplicate finalizer: ${finalizer}`);
    }
    seen.add(finalizer);
  }
}

function validateJsonSize(value: string, description: string, limit: number): void {
  if (Buffer.byteLength(value, "utf8") > limit) {
    throw new Error(`${description} exceeds the ${limit}-byte storage limit`);
  }
}

function truncateError(error: string): string {
  return error.length <= MAX_ERROR_LENGTH ? error : `${error.slice(0, MAX_ERROR_LENGTH)}…`;
}
