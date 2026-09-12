import { randomUUID } from "node:crypto";
import { closeRunTime } from "../state/attempt-time.js";
import { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonObject } from "../state/json.js";
import { resourceIdFor, tokenHash } from "../state/mutation.js";
import {
  ProjectStore,
  isRecord,
  validTimestamp,
  epoch,
  isSequenceRow,
} from "../state/project-store.js";
import { initializeViewerRun, recordViewerDeltas } from "../state/viewer.js";
import { WorkflowMessageStore } from "../state/workflow-messages.js";

export type WorkflowRunLaunchStatus =
  | "queued"
  | "starting"
  | "running"
  | "parked"
  | "done"
  | "failed"
  | "cancelled";

export type WorkflowRunReservationOptions = {
  runId: string;
  workflowName: string;
  workflowSourceRef: string;
  workflowSource: unknown;
  definitionDigest: string;
  definitionSnapshot: unknown;
  input: unknown;
  launchOptions?: unknown;
  originSessionId: string;
  executionMode?: "interactive" | "headless";
  parentRunId?: string;
  lineageKind?: "restart";
  restartNumber?: number;
  parentRunRevision?: number;
  now?: string;
};

export type WorkflowRunQueueViewRecord = {
  runId: string;
  workflowName: string;
  workflowSourceRef: string;
  workflowSource: unknown;
  initialized: boolean;
  definitionDigest: string;
  runStateStatus: string;
  paused: boolean;
  status: WorkflowRunLaunchStatus;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "restart" | null;
  restartNumber: number;
  parentRunRevision: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunQueueRecord = {
  runId: string;
  workflowName: string;
  workflowSourceRef: string;
  workflowSource: unknown;
  initialized: boolean;
  definitionDigest: string;
  input: unknown;
  launchOptions: unknown;
  status: WorkflowRunLaunchStatus;
  runnerId: string | null;
  claimToken: string | null;
  claimGeneration: number | null;
  claimExpiresAt: string | null;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "restart" | null;
  restartNumber: number;
  parentRunRevision: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunPreparationResult =
  | {
      state: "reserved";
      run: WorkflowRunQueueRecord;
    }
  | {
      state: "adopted";
      run: WorkflowRunQueueRecord;
    };

export type RunEventRecord = {
  seq: number;
  recordedAt: string;
  runId: string;
  workflowRef: string;
  type: string;
  runnerId: string | null;
  payload: JsonObject;
};

type RunRow = {
  runId: string;
  resourceId: string;
  workflowName: string;
  workflowRef: string;
  runStatus: string;
  paused: number;
  definitionDigest: Buffer;
  definitionHash: Buffer;
  inputHash: Buffer;
  launchOptionsHash: Buffer;
  status: WorkflowRunLaunchStatus;
  availableAt: number;
  consecutiveErrors: number;
  errorCode: string | null;
  errorHash: Buffer | null;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "restart" | null;
  restartNumber: number;
  parentRunRevision: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  leaseGeneration: number;
  ownerId: string | null;
  claimExpiresAt: number | null;
};

type WorkflowRunViewRow = {
  runId: string;
  workflowName: string;
  workflowRef: string;
  runStatus: string;
  paused: number;
  definitionDigest: Buffer;
  status: WorkflowRunLaunchStatus;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "restart" | null;
  restartNumber: number;
  parentRunRevision: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sourceType: "builtin" | "file";
  sourceRef: string;
  sourceRevision: string;
};

type RunListRevisionRow = {
  count: number;
  revisionSum: number;
  updatedAt: number;
};

type RunSourceIdentityRow = {
  mountPath: string;
  sourceType: "builtin" | "file";
  sourceRef: string;
  sourceRevision: string;
};

type CancelledRunEffectRow = {
  effectId: string;
  resourceId: string;
  status: "pending" | "applying";
  attemptCount: number;
};

type ExpiredInteractionRow = {
  requestId: string;
  attemptId: string;
};

function workflowRunSelect(clause: string): string {
  return `SELECT r.run_id AS runId, r.resource_id AS resourceId,
    d.workflow_name AS workflowName, r.workflow_ref AS workflowRef, r.status AS runStatus,
    r.paused, r.definition_digest AS definitionDigest, d.definition_hash AS definitionHash,
    r.input_hash AS inputHash,
    r.launch_options_hash AS launchOptionsHash,
    q.status, q.available_at AS availableAt,
    q.consecutive_errors AS consecutiveErrors, q.error_code AS errorCode,
    q.error_hash AS errorHash, b.origin_session_id AS originSessionId,
    b.execution_mode AS executionMode, r.parent_run_id AS parentRunId,
    r.root_run_id AS rootRunId, r.lineage_kind AS lineageKind,
    r.restart_number AS restartNumber,
    r.parent_run_revision AS parentRunRevision,
    q.created_at AS createdAt, q.updated_at AS updatedAt,
    q.started_at AS startedAt, q.finished_at AS finishedAt,
    l.generation AS leaseGeneration, l.owner_id AS ownerId, l.expires_at AS claimExpiresAt
    FROM runs r JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
    JOIN run_queue q ON q.run_id = r.run_id
    LEFT JOIN run_bindings b ON b.run_id = r.run_id
    JOIN leases l ON l.resource_id = r.resource_id ${clause}`;
}

function workflowRunViewSelect(clause: string): string {
  return `SELECT r.run_id AS runId, d.workflow_name AS workflowName,
    r.workflow_ref AS workflowRef, r.status AS runStatus, r.paused,
    r.definition_digest AS definitionDigest, q.status,
    b.origin_session_id AS originSessionId, b.execution_mode AS executionMode,
    r.parent_run_id AS parentRunId, r.root_run_id AS rootRunId,
    r.lineage_kind AS lineageKind, r.restart_number AS restartNumber,
    r.parent_run_revision AS parentRunRevision,
    q.error_code AS errorCode, CAST(error.content AS TEXT) AS errorMessage,
    q.created_at AS createdAt, q.updated_at AS updatedAt,
    q.started_at AS startedAt, q.finished_at AS finishedAt,
    source.source_type AS sourceType, source.source_ref AS sourceRef,
    source.source_revision AS sourceRevision
    FROM runs r JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
    JOIN run_queue q ON q.run_id = r.run_id
    LEFT JOIN run_bindings b ON b.run_id = r.run_id
    LEFT JOIN run_sources source ON source.run_id = r.run_id AND source.mount_path = ''
    LEFT JOIN blobs error ON error.blob_hash = q.error_hash ${clause}`;
}

type RunEventRow = {
  seq: number;
  recordedAt: number;
  runId: string;
  workflowRef: string;
  eventType: string;
  runnerId: string | null;
  payloadHash: Buffer | null;
};

function workflowRunViewRecord(row: WorkflowRunViewRow): WorkflowRunQueueViewRecord {
  const root =
    row.sourceType === "builtin"
      ? { kind: "builtin", id: row.sourceRef, revision: row.sourceRevision }
      : { kind: "file", path: row.sourceRef, hash: row.sourceRevision };
  return {
    runId: row.runId,
    workflowName: row.workflowName,
    workflowSourceRef: row.workflowRef,
    workflowSource: { root, mounted: [] },
    initialized: row.runStatus !== "queued",
    definitionDigest: `sha256:${row.definitionDigest.toString("hex")}`,
    runStateStatus: row.runStatus,
    paused: row.paused === 1,
    status: row.status,
    originSessionId: row.executionMode === "headless" ? null : row.originSessionId,
    executionMode: row.executionMode,
    parentRunId: row.parentRunId,
    rootRunId: row.rootRunId,
    lineageKind: row.lineageKind,
    restartNumber: row.restartNumber,
    parentRunRevision: row.parentRunRevision,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
  };
}

function isWorkflowRunViewRow(value: unknown): value is WorkflowRunViewRow {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.workflowName === "string" &&
    typeof value.workflowRef === "string" &&
    typeof value.runStatus === "string" &&
    typeof value.paused === "number" &&
    Buffer.isBuffer(value.definitionDigest) &&
    typeof value.status === "string" &&
    (value.originSessionId === null || typeof value.originSessionId === "string") &&
    (value.executionMode === "interactive" || value.executionMode === "headless") &&
    (value.parentRunId === null || typeof value.parentRunId === "string") &&
    typeof value.rootRunId === "string" &&
    (value.lineageKind === null || value.lineageKind === "restart") &&
    typeof value.restartNumber === "number" &&
    (value.parentRunRevision === null || typeof value.parentRunRevision === "number") &&
    (value.errorCode === null || typeof value.errorCode === "string") &&
    (value.errorMessage === null || typeof value.errorMessage === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.startedAt === null || typeof value.startedAt === "number") &&
    (value.finishedAt === null || typeof value.finishedAt === "number") &&
    (value.sourceType === "builtin" || value.sourceType === "file") &&
    typeof value.sourceRef === "string" &&
    typeof value.sourceRevision === "string"
  );
}

function isRunListRevisionRow(value: unknown): value is RunListRevisionRow {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    typeof value.revisionSum === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isRunRow(value: unknown): value is RunRow {
  return isRecord(value);
}

function isRunSourceIdentityRow(value: unknown): value is RunSourceIdentityRow {
  return isRecord(value);
}

function isCancelledRunEffectRow(value: unknown): value is CancelledRunEffectRow {
  return (
    isRecord(value) &&
    typeof value.effectId === "string" &&
    typeof value.resourceId === "string" &&
    (value.status === "pending" || value.status === "applying") &&
    typeof value.attemptCount === "number"
  );
}

function isExpiredInteractionRow(value: unknown): value is ExpiredInteractionRow {
  return (
    isRecord(value) && typeof value.requestId === "string" && typeof value.attemptId === "string"
  );
}

function isRunEventRow(value: unknown): value is RunEventRow {
  return isRecord(value);
}

function isCanonicalPathRow(value: unknown): value is { canonicalPath: string } {
  return isRecord(value) && typeof value.canonicalPath === "string";
}

function isEffectIdentityRow(value: unknown): value is { effectId: string; resourceId: string } {
  return isRecord(value);
}

function digestBuffer(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("Expected a SHA-256 digest");
  return Buffer.from(hex, "hex");
}

type QueuedSource = {
  root:
    | { kind: "builtin"; id: string; revision: string }
    | { kind: "file"; path: string; hash: string };
  mounted: Array<{
    mountPath: string[];
    workflowName: string;
    source:
      | { kind: "builtin"; id: string; revision: string }
      | { kind: "file"; path: string; hash: string };
  }>;
};

function queuedWorkflowSource(value: unknown): QueuedSource {
  if (isWorkflowSource(value)) {
    return { root: value, mounted: [] };
  }
  if (
    isRecord(value) &&
    isWorkflowSource(value.root) &&
    Array.isArray(value.mounted) &&
    value.mounted.every(isMountedWorkflowSource)
  ) {
    return { root: value.root, mounted: value.mounted };
  }
  throw new Error("Stored workflow source identity is invalid");
}

function isWorkflowSource(value: unknown): value is QueuedSource["root"] {
  return (
    isRecord(value) &&
    ((value.kind === "builtin" &&
      typeof value.id === "string" &&
      typeof value.revision === "string") ||
      (value.kind === "file" && typeof value.path === "string" && typeof value.hash === "string"))
  );
}

function isMountedWorkflowSource(value: unknown): value is QueuedSource["mounted"][number] {
  return (
    isRecord(value) &&
    Array.isArray(value.mountPath) &&
    value.mountPath.every((part) => typeof part === "string") &&
    typeof value.workflowName === "string" &&
    isWorkflowSource(value.source)
  );
}

function insertQueuedRunSources(state: StateDatabase, runId: string, value: QueuedSource): void {
  const insert = state.connection.prepare(
    `INSERT INTO run_sources(run_id, mount_path, source_type, source_ref, source_revision)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const root = queuedSourceParts(value.root);
  insert.run(runId, "", root.type, root.ref, root.revision);
  for (const mounted of value.mounted) {
    const source = queuedSourceParts(mounted.source);
    insert.run(runId, mounted.mountPath.join("/"), source.type, source.ref, source.revision);
  }
}

function queuedSourceParts(source: QueuedSource["root"]): {
  type: "builtin" | "file";
  ref: string;
  revision: string;
} {
  return source.kind === "builtin"
    ? { type: "builtin", ref: source.id, revision: source.revision }
    : { type: "file", ref: source.path, revision: source.hash };
}

function readQueuedRunSources(state: StateDatabase, run: RunRow): QueuedSource {
  const rows = state.connection
    .prepare(
      `SELECT mount_path AS mountPath, source_type AS sourceType,
              source_ref AS sourceRef, source_revision AS sourceRevision
       FROM run_sources WHERE run_id = ? ORDER BY mount_path`,
    )
    .all(run.runId)
    .filter(isRunSourceIdentityRow);
  const rootRow = rows.find((row) => row.mountPath === "");
  if (rootRow === undefined) throw new Error(`Workflow run source is missing: ${run.runId}`);
  const snapshot = state.readJson(run.definitionHash);
  const mounts =
    isRecord(snapshot) &&
    isRecord(snapshot.composition) &&
    Array.isArray(snapshot.composition.mounts)
      ? snapshot.composition.mounts
      : [];
  const names = new Map(
    mounts.flatMap((mount) => {
      if (
        !isRecord(mount) ||
        !Array.isArray(mount.mountPath) ||
        !mount.mountPath.every((part) => typeof part === "string") ||
        typeof mount.workflowName !== "string"
      ) {
        return [];
      }
      return [[mount.mountPath.join("/"), mount.workflowName] as const];
    }),
  );
  return {
    root: rowToSource(rootRow),
    mounted: rows
      .filter((row) => row.mountPath !== "")
      .map((row) => ({
        mountPath: row.mountPath.split("/"),
        workflowName: names.get(row.mountPath) ?? row.mountPath,
        source: rowToSource(row),
      })),
  };
}

function rowToSource(row: RunSourceIdentityRow): QueuedSource["root"] {
  return row.sourceType === "builtin"
    ? { kind: "builtin", id: row.sourceRef, revision: row.sourceRevision }
    : { kind: "file", path: row.sourceRef, hash: row.sourceRevision };
}

function validateRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))
    throw new Error(`Invalid workflow run id: ${value}`);
}

export class WorkflowRunQueueStore extends ProjectStore {
  private readonly workflowMessages = new WorkflowMessageStore(this.state);
  reserveWorkflowRun(options: WorkflowRunReservationOptions): WorkflowRunQueueRecord {
    validateRunId(options.runId);
    const now = epoch(validTimestamp(options.now));
    const definitionDigest = digestBuffer(options.definitionDigest);
    return this.state.transaction(() =>
      this.reserveWorkflowRunInTransaction(options, now, definitionDigest),
    );
  }

  private reserveWorkflowRunInTransaction(
    options: WorkflowRunReservationOptions,
    now: number,
    definitionDigest: Buffer,
  ): WorkflowRunQueueRecord {
    if (this.getWorkflowRun(options.runId) !== undefined) {
      throw new Error(`Workflow run already reserved: ${options.runId}`);
    }
    const lineageKind = options.parentRunId === undefined ? null : (options.lineageKind ?? null);
    if (
      (options.parentRunId === undefined && options.lineageKind !== undefined) ||
      (options.parentRunId !== undefined && lineageKind !== "restart")
    ) {
      throw new Error("Only an explicit restart can declare a parent run");
    }
    let rootRunId = options.runId;
    let restartNumber = 0;
    let parentRunRevision: number | null = null;
    if (options.parentRunId !== undefined) {
      const parent = this.requireWorkflowRunRow(options.parentRunId);
      if (parent.originSessionId !== options.originSessionId) {
        throw new Error("Workflow parent belongs to another Pi session");
      }
      rootRunId = parent.rootRunId;
      if (lineageKind === "restart") {
        if (
          !["completed", "failed", "timed_out", "cancelled"].includes(parent.runStatus) ||
          !["done", "failed", "cancelled"].includes(parent.status)
        ) {
          throw new Error("Restart parent is not terminal");
        }
        if (
          options.parentRunRevision === undefined ||
          !Number.isSafeInteger(options.parentRunRevision) ||
          options.parentRunRevision < 0
        ) {
          throw new Error("Restart requires the exact parent run revision");
        }
        if (options.parentRunRevision !== this.resourceRevision(parent.resourceId)) {
          throw new Error("Restart parent revision changed");
        }
        parentRunRevision = options.parentRunRevision;
        restartNumber = options.restartNumber ?? parent.restartNumber + 1;
        if (restartNumber !== parent.restartNumber + 1) {
          throw new Error("Restart number does not follow its parent");
        }
      }
    } else if (options.restartNumber !== undefined || options.parentRunRevision !== undefined) {
      throw new Error("A root workflow run cannot declare restart metadata");
    }
    const resourceId = resourceIdFor("run", options.runId);
    const definitionHash = this.state.putJson(options.definitionSnapshot, now);
    const queuedSource = queuedWorkflowSource(options.workflowSource);
    const inputHash = this.state.putJson(options.input ?? null, now);
    const launchHash = this.state.putJson(options.launchOptions ?? {}, now);
    this.state.connection
      .prepare(
        `INSERT INTO workflow_definitions(
             definition_digest, workflow_name, definition_hash, created_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(definition_digest) DO NOTHING`,
      )
      .run(definitionDigest, options.workflowName, definitionHash, now);
    this.state.connection
      .prepare(
        `INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at)
           VALUES (?, 'run', ?, 1, ?, ?)`,
      )
      .run(resourceId, options.runId, now, now);
    this.state.connection
      .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
      .run(resourceId);
    this.state.connection
      .prepare(
        `INSERT INTO runs(
             run_id, resource_id, project_id, parent_run_id, root_run_id, lineage_kind,
             restart_number, parent_run_revision, definition_digest,
             workflow_ref, launch_options_hash, status, paused,
             input_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        options.runId,
        resourceId,
        this.requireProjectId(),
        options.parentRunId ?? null,
        rootRunId,
        lineageKind,
        restartNumber,
        parentRunRevision,
        definitionDigest,
        options.workflowSourceRef,
        launchHash,
        inputHash,
        now,
        now,
      );
    initializeViewerRun(this.state, options.runId, now);
    insertQueuedRunSources(this.state, options.runId, queuedSource);
    this.state.connection
      .prepare(
        `INSERT INTO run_bindings(run_id, origin_session_id, execution_mode, created_at)
           VALUES (?, ?, ?, ?)`,
      )
      .run(options.runId, options.originSessionId, options.executionMode ?? "interactive", now);
    this.state.connection
      .prepare(
        `INSERT INTO run_queue(
             run_id, status, available_at, origin_session_id,
             consecutive_errors, created_at, updated_at
           ) VALUES (?, 'queued', ?, ?, 0, ?, ?)`,
      )
      .run(
        options.runId,
        now,
        options.executionMode === "headless" ? null : options.originSessionId,
        now,
        now,
      );
    this.insertEvent(resourceId, 1, "run.queued", "session", options.originSessionId, {}, now);
    return this.requireWorkflowRun(options.runId);
  }

  reserveOrAdoptWorkflowRun(options: WorkflowRunReservationOptions): WorkflowRunPreparationResult {
    validateRunId(options.runId);
    const now = epoch(validTimestamp(options.now));
    const definitionDigest = digestBuffer(options.definitionDigest);
    return this.state.transaction(() => {
      const existing = this.workflowRunRow(options.runId);
      if (existing !== undefined) {
        this.assertWorkflowRunPreparationCompatible(existing, options, definitionDigest);
        return { state: "adopted", run: this.mapWorkflowRun(existing) };
      }
      return {
        state: "reserved",
        run: this.reserveWorkflowRunInTransaction(options, now, definitionDigest),
      };
    });
  }

  getWorkflowRun(runId: string): WorkflowRunQueueRecord | undefined {
    const row = this.workflowRunRow(runId);
    return row === undefined ? undefined : this.mapWorkflowRun(row);
  }

  getWorkflowRunView(runId: string): WorkflowRunQueueViewRecord | undefined {
    const row = this.workflowRunViewRows("WHERE r.run_id = ?", [runId])[0];
    return row === undefined ? undefined : workflowRunViewRecord(row);
  }

  workflowRunListRevision(): { total: number; revision: string } {
    const row = this.state.connection
      .prepare(
        `SELECT count(*) AS count, COALESCE(sum(res.revision), 0) AS revisionSum,
                COALESCE(max(q.updated_at), 0) AS updatedAt
         FROM runs r JOIN run_queue q ON q.run_id = r.run_id
         JOIN resources res ON res.resource_id = r.resource_id`,
      )
      .get();
    if (!isRunListRevisionRow(row)) throw new Error("Workflow run list revision is invalid");
    return {
      total: row.count,
      revision: `${row.count}:${row.revisionSum}:${row.updatedAt}`,
    };
  }

  listWorkflowRunViews(options: { offset: number; limit: number }): {
    total: number;
    revision: string;
    runs: WorkflowRunQueueViewRecord[];
  } {
    const current = this.workflowRunListRevision();
    const rows = this.workflowRunViewRows("ORDER BY q.created_at DESC LIMIT ? OFFSET ?", [
      options.limit,
      options.offset,
    ]);
    return { ...current, runs: rows.map(workflowRunViewRecord) };
  }

  workflowRunProjectPath(runId: string): string | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT p.canonical_path AS canonicalPath
         FROM runs r JOIN projects p ON p.project_id = r.project_id WHERE r.run_id = ?`,
      )
      .get(runId);
    return isCanonicalPathRow(row) ? row.canonicalPath : undefined;
  }

  listWorkflowRuns(
    options: {
      statuses?: WorkflowRunLaunchStatus[];
      excludeRunIds?: string[];
      limit?: number;
    } = {},
  ): WorkflowRunQueueRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (this.projectId !== null) {
      clauses.push("r.project_id = ?");
      params.push(this.projectId);
    }
    if (options.statuses !== undefined && options.statuses.length > 0) {
      clauses.push(`q.status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    if (options.excludeRunIds !== undefined && options.excludeRunIds.length > 0) {
      clauses.push(`r.run_id NOT IN (${options.excludeRunIds.map(() => "?").join(", ")})`);
      params.push(...options.excludeRunIds);
    }
    if (options.limit !== undefined) params.push(options.limit);
    const rows = this.state.connection
      .prepare(
        workflowRunSelect(
          `${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`} ORDER BY q.created_at DESC${options.limit === undefined ? "" : " LIMIT ?"}`,
        ),
      )
      .all(...params);
    return rows.filter(isRunRow).map((row) => this.mapWorkflowRun(row));
  }

  findSessionReservation(sessionId: string): WorkflowRunQueueRecord | undefined {
    const row = this.state.connection
      .prepare(
        workflowRunSelect(
          "WHERE b.origin_session_id = ? AND b.execution_mode = 'interactive' AND q.status NOT IN ('done', 'failed', 'cancelled') ORDER BY q.created_at DESC LIMIT 1",
        ),
      )
      .get(sessionId);
    return isRunRow(row) ? this.mapWorkflowRun(row) : undefined;
  }

  findSessionReservationView(sessionId: string): WorkflowRunQueueViewRecord | undefined {
    const row = this.workflowRunViewRows(
      "WHERE b.origin_session_id = ? AND b.execution_mode = 'interactive' AND q.status NOT IN ('done', 'failed', 'cancelled') ORDER BY q.created_at DESC LIMIT 1",
      [sessionId],
    )[0];
    return row === undefined ? undefined : workflowRunViewRecord(row);
  }

  claimWorkflowRun(options: {
    runId: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): WorkflowRunQueueRecord | undefined {
    const now = epoch(validTimestamp(options.now));
    return this.claimRun(options.runId, options.runnerId, options.claimToken, options.leaseMs, now);
  }

  /** Schedule a runner that validates one pending interactive submission. */
  claimWorkflowRunForInteractionValidation(options: {
    runId: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): WorkflowRunQueueRecord | undefined {
    const now = epoch(validTimestamp(options.now));
    return this.claimRun(
      options.runId,
      options.runnerId,
      options.claimToken,
      options.leaseMs,
      now,
      {
        allowPendingInteraction: true,
      },
    );
  }

  /** Take a short server claim without scheduling a parked interactive run. */
  claimWorkflowRunForControl(options: {
    runId: string;
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): WorkflowRunQueueRecord | undefined {
    const now = epoch(validTimestamp(options.now));
    return this.claimRun(
      options.runId,
      options.runnerId,
      options.claimToken,
      options.leaseMs,
      now,
      { allowPendingInteraction: true, preserveQueueStatus: true },
    );
  }

  beginWorkflowRunInteractionTimeout(options: {
    runId: string;
    targetSessionId: string;
    claimToken: string;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      if (
        !this.verifyWorkflowRunClaim({
          runId: options.runId,
          claimToken: options.claimToken,
          now: new Date(now).toISOString(),
        })
      ) {
        return false;
      }
      const row = this.requireWorkflowRunRow(options.runId);
      const interaction = this.state.connection
        .prepare(
          `SELECT i.request_id AS requestId, i.attempt_id AS attemptId
           FROM interactive_requests i
           JOIN node_attempts a ON a.attempt_id = i.attempt_id
           JOIN runs r ON r.run_id = i.run_id
           WHERE i.run_id = ? AND i.target_session_id = ?
             AND i.status = 'pending' AND r.paused = 0
             AND a.timeout_ms > 0
             AND (SELECT COALESCE(SUM(elapsed_ms), 0) FROM attempt_active_intervals t
                  WHERE t.attempt_id = a.attempt_id) >= a.timeout_ms
           ORDER BY a.started_at, i.request_id LIMIT 1`,
        )
        .get(options.runId, options.targetSessionId);
      if (!isExpiredInteractionRow(interaction)) return false;
      closeRunTime(this.state, options.runId);
      const request = this.state.connection
        .prepare(
          `UPDATE interactive_requests
           SET status = 'cancelled', revision = revision + 1, updated_at = ?
           WHERE request_id = ? AND run_id = ? AND status = 'pending'`,
        )
        .run(now, interaction.requestId, options.runId);
      const run = this.state.connection
        .prepare(
          `UPDATE runs
           SET status = 'running', status_detail = 'finishing expired interaction deadline',
               updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status = 'waiting'`,
        )
        .run(now, options.runId);
      const queue = this.state.connection
        .prepare(
          `UPDATE run_queue SET status = 'starting', error_code = NULL, error_hash = NULL,
                  updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status = 'parked'`,
        )
        .run(now, options.runId);
      /* istanbul ignore if -- the expired parked interaction was selected above */
      if (request.changes !== 1 || run.changes !== 1 || queue.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} changed during interaction timeout`);
      }
      const error = "Workflow node model-turn deadline expired";
      const receiptHash = this.state.putJson({ status: "rejected", error }, now);
      this.state.connection
        .prepare(
          `UPDATE interactive_submissions SET outcome = 'rejected', receipt_hash = ?
           WHERE request_id = ? AND outcome = 'validating'`,
        )
        .run(receiptHash, interaction.requestId);
      const revision = this.resourceRevision(row.resourceId);
      const lease = this.requireLease(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.interaction_timeout_started",
        lease.ownerType ?? "system",
        lease.ownerId,
        { requestId: interaction.requestId, attemptId: interaction.attemptId },
        now,
        lease.generation || undefined,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }, { targetType: "conversation" }],
        now,
      );
      return true;
    });
  }

  markWorkflowRunRunning(options: { runId: string; claimToken: string; now?: string }): boolean {
    return this.updateClaimedRunStatus(options.runId, options.claimToken, "running", options.now);
  }

  claimNextWorkflowRun(options: {
    runnerId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
    excludeRunIds?: string[];
  }): WorkflowRunQueueRecord | undefined {
    const now = epoch(validTimestamp(options.now));
    const clauses = [
      "q.status IN ('queued', 'parked', 'starting', 'running')",
      "q.available_at <= ?",
      "(l.owner_id IS NULL OR l.expires_at <= ? OR l.owner_id = ?)",
      "NOT (q.status = 'parked' AND (r.status = 'waiting' OR r.paused = 1))",
      "NOT EXISTS (SELECT 1 FROM interactive_requests i WHERE i.run_id = r.run_id AND i.status = 'pending')",
      "(q.error_code IS NULL OR q.error_code NOT IN ('workflowSourceChanged', 'runnerNoProgress'))",
    ];
    const params: unknown[] = [now, now, options.runnerId];
    if (this.projectId !== null) {
      clauses.unshift("r.project_id = ?");
      params.unshift(this.projectId);
    }
    if (options.excludeRunIds !== undefined && options.excludeRunIds.length > 0) {
      clauses.push(`r.run_id NOT IN (${options.excludeRunIds.map(() => "?").join(", ")})`);
      params.push(...options.excludeRunIds);
    }
    const row = this.state.connection
      .prepare(
        workflowRunSelect(
          `WHERE ${clauses.join(" AND ")} ORDER BY q.available_at, q.created_at LIMIT 1`,
        ),
      )
      .get(...params);
    if (!isRunRow(row)) return undefined;
    return this.claimRun(row.runId, options.runnerId, options.claimToken, options.leaseMs, now);
  }

  renewWorkflowRunClaim(options: {
    runId: string;
    claimToken: string;
    leaseMs: number;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (row === undefined || row.ownerId === null) return false;
      const lease = this.requireLease(row.resourceId);
      const result = this.state.connection
        .prepare(
          `UPDATE leases SET heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND owner_type = ? AND owner_id = ?
             AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(
          now,
          now + options.leaseMs,
          row.resourceId,
          lease.ownerType,
          row.ownerId,
          tokenHash(options.claimToken),
          lease.generation,
          now,
        );
      if (result.changes === 1) {
        recordViewerDeltas(
          this.state,
          options.runId,
          [{ targetType: "summary" }, { targetType: "replay" }],
          now,
        );
        return true;
      }
      return false;
    });
  }

  verifyWorkflowRunClaim(options: { runId: string; claimToken: string; now?: string }): boolean {
    const now = epoch(validTimestamp(options.now));
    const row = this.workflowRunRow(options.runId);
    if (row === undefined || row.ownerId === null || row.claimExpiresAt === null) return false;
    const lease = this.requireLease(row.resourceId);
    return (
      lease.tokenHash !== null &&
      lease.tokenHash.equals(tokenHash(options.claimToken)) &&
      row.claimExpiresAt > now
    );
  }

  workflowRunAuthority(
    runId: string,
    claimToken: string,
  ):
    | {
        actor: { type: "session" | "server"; id: string };
        ownerType: "session" | "server";
        ownerId: string;
        token: string;
        generation: number;
        leaseMs: number;
      }
    | undefined {
    const row = this.workflowRunRow(runId);
    if (row === undefined || row.ownerId === null || row.claimExpiresAt === null) return undefined;
    const lease = this.requireLease(row.resourceId);
    if (lease.tokenHash === null || !lease.tokenHash.equals(tokenHash(claimToken)))
      return undefined;
    const ownerType = row.ownerId.startsWith("server-") ? "server" : "session";
    return {
      actor: { type: ownerType, id: row.ownerId },
      ownerType,
      ownerId: row.ownerId,
      token: claimToken,
      generation: row.leaseGeneration,
      leaseMs: 30_000,
    };
  }

  parkWorkflowRun(options: { runId: string; claimToken: string; now?: string }): boolean {
    return this.releaseRunClaim(options.runId, options.claimToken, "parked", options.now);
  }

  parkWorkflowRunForRunnerNoProgress(options: {
    runId: string;
    claimToken: string;
    detail: string;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      if (
        !this.verifyWorkflowRunClaim({
          runId: options.runId,
          claimToken: options.claimToken,
          now: new Date(now).toISOString(),
        })
      ) {
        return false;
      }
      const row = this.requireWorkflowRunRow(options.runId);
      const lease = this.requireLease(row.resourceId);
      const detail = options.detail.slice(0, 8_192);
      const errorHash = this.state.putText(detail, now);
      const run = this.state.connection
        .prepare(
          `UPDATE runs SET status_detail = ?, updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'timed_out', 'cancelled')`,
        )
        .run(detail, now, options.runId);
      const queue = this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = 'parked', error_code = 'runnerNoProgress', error_hash = ?,
               available_at = ?, updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status IN ('queued', 'starting', 'running', 'parked')`,
        )
        .run(errorHash, now, now, options.runId);
      if (run.changes !== 1 || queue.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} changed during runner recovery`);
      }
      const released = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(row.resourceId, tokenHash(options.claimToken), lease.generation, now);
      /* istanbul ignore if -- the exact live claim is stable in this transaction */
      if (released.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} claim changed during runner recovery`);
      }
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.worker_no_progress",
        lease.ownerType ?? "system",
        lease.ownerId,
        { status: "parked", code: "runnerNoProgress" },
        now,
        lease.generation || undefined,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  pauseParkedWorkflowRun(options: { runId: string; now?: string }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (row === undefined || row.status !== "parked") return false;
      const lease = this.requireLease(row.resourceId);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) return false;
      const pending = this.state.connection
        .prepare(
          `SELECT 1 FROM interactive_requests
           WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(options.runId);
      if (pending === undefined) return false;
      if (row.paused === 1) return true;
      if (!["running", "waiting"].includes(row.runStatus)) return false;
      const changed = this.state.connection
        .prepare(
          `UPDATE runs SET paused = 1, status_detail = 'paused', updated_at = ?
           WHERE run_id = ? AND paused = 0 AND status IN ('running', 'waiting')`,
        )
        .run(now, options.runId);
      if (changed.changes !== 1) return false;
      closeRunTime(this.state, options.runId);
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.paused",
        "control",
        null,
        { status: "parked" },
        now,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  resumePausedInteraction(options: { runId: string; now?: string }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (
        row === undefined ||
        row.status !== "parked" ||
        row.runStatus !== "waiting" ||
        row.paused !== 1
      ) {
        return false;
      }
      const lease = this.requireLease(row.resourceId);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) return false;
      const pending = this.state.connection
        .prepare(
          `SELECT 1 FROM interactive_requests
           WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(options.runId);
      if (pending === undefined) return false;
      const changed = this.state.connection
        .prepare(
          `UPDATE runs
           SET paused = 0, status_detail = 'waiting for origin-session input', updated_at = ?
           WHERE run_id = ? AND status = 'waiting' AND paused = 1`,
        )
        .run(now, options.runId);
      if (changed.changes !== 1) return false;
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.resumed",
        "control",
        null,
        { status: "waiting" },
        now,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  requestWorkflowRunResume(options: { runId: string; now?: string }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (row === undefined || ["done", "failed", "cancelled"].includes(row.status)) return false;
      const lease = this.requireLease(row.resourceId);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) return false;
      if (
        this.state.connection
          .prepare("SELECT 1 FROM interactive_requests WHERE run_id = ? AND status = 'pending'")
          .get(options.runId) !== undefined
      )
        return false;
      this.state.connection
        .prepare("UPDATE runs SET paused = 0, updated_at = ? WHERE run_id = ?")
        .run(now, options.runId);
      this.state.connection
        .prepare(
          "UPDATE run_queue SET status = 'queued', error_code = NULL, error_hash = NULL, available_at = ?, updated_at = ? WHERE run_id = ?",
        )
        .run(now, now, options.runId);
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.resume_requested",
        "control",
        null,
        { status: "queued" },
        now,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  isWorkflowRunPaused(runId: string): boolean {
    return this.workflowRunRow(runId)?.paused === 1;
  }

  parkWorkflowRunForSourceChange(options: {
    runId: string;
    claimToken: string;
    detail: string;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (
        row === undefined ||
        !this.verifyWorkflowRunClaim({
          runId: options.runId,
          claimToken: options.claimToken,
          now: new Date(now).toISOString(),
        })
      ) {
        return false;
      }
      const lease = this.requireLease(row.resourceId);
      const detail = options.detail.slice(0, 8_192);
      const errorHash = this.state.putText(detail, now);
      const run = this.state.connection
        .prepare(
          `UPDATE runs SET status_detail = ?, updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'timed_out', 'cancelled')`,
        )
        .run(detail, now, options.runId);
      const queue = this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = 'parked', error_code = 'workflowSourceChanged', error_hash = ?,
               available_at = ?, updated_at = ?, finished_at = NULL
           WHERE run_id = ? AND status IN ('queued', 'starting', 'running', 'parked')`,
        )
        .run(errorHash, now, now, options.runId);
      /* istanbul ignore if -- exact live claim and nonterminal checks make both updates mandatory */
      if (run.changes !== 1 || queue.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} has inconsistent source-change state`);
      }
      const released = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(row.resourceId, tokenHash(options.claimToken), lease.generation, now);
      /* istanbul ignore if -- the exact live claim is stable in this transaction */
      if (released.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} claim changed during source recovery`);
      }
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.source_changed",
        lease.ownerType ?? "system",
        lease.ownerId,
        { status: "parked", code: "workflowSourceChanged" },
        now,
        lease.generation || undefined,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  parkWorkflowRunForAmbiguousEffect(options: {
    runId: string;
    claimToken: string;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (
        row === undefined ||
        !this.verifyWorkflowRunClaim({
          runId: options.runId,
          claimToken: options.claimToken,
          now: new Date(now).toISOString(),
        })
      ) {
        return false;
      }
      const lease = this.requireLease(row.resourceId);
      const detail = "effect outcome is ambiguous; explicit recovery is required";
      const errorHash = this.state.putText(detail, now);
      this.state.connection
        .prepare(
          `UPDATE node_attempts SET status = 'waiting', updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'running')`,
        )
        .run(now, options.runId);
      const run = this.state.connection
        .prepare(
          `UPDATE runs SET status = 'waiting', status_detail = ?, updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(detail, now, null, options.runId);
      const queue = this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = 'parked', error_code = 'effectAmbiguous', error_hash = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('starting', 'running', 'parked')`,
        )
        .run(errorHash, now, options.runId);
      /* istanbul ignore if -- exact live claim and run checks make both updates mandatory */
      if (run.changes !== 1 || queue.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} has inconsistent ambiguous-effect state`);
      }
      const released = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(row.resourceId, tokenHash(options.claimToken), lease.generation, now);
      /* istanbul ignore if -- the exact live claim is stable in this transaction */
      if (released.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} claim changed during effect recovery`);
      }
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.effect_ambiguous",
        lease.ownerType ?? "system",
        lease.ownerId,
        { status: "waiting", code: "effectAmbiguous" },
        now,
        lease.generation || undefined,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  failWorkflowRun(options: {
    runId: string;
    claimToken?: string;
    errorCode: string;
    errorMessage: string;
    now?: string;
  }): boolean {
    return this.terminalRun(
      options.runId,
      options.claimToken,
      "failed",
      options.errorCode,
      options.errorMessage,
      options.now,
    );
  }

  cancelWorkflowRun(options: { runId: string; claimToken?: string; now?: string }): boolean {
    const cancelled = this.terminalRun(
      options.runId,
      options.claimToken,
      "cancelled",
      "cancelled",
      "Workflow run cancelled",
      options.now,
    );
    if (cancelled || options.claimToken !== undefined) return cancelled;
    return this.cancelStaleWorkflowRun({
      runId: options.runId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Cancel a nonterminal run only when its claim is absent or expired. */
  cancelStaleWorkflowRun(options: {
    runId: string;
    controlId?: string;
    claimToken?: string;
    now?: string;
  }): boolean {
    const now = epoch(validTimestamp(options.now));
    const controlId = options.controlId ?? "workflow-control";
    const claimToken = options.claimToken ?? randomUUID();
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (row === undefined || ["done", "failed", "cancelled"].includes(row.status)) return false;
      const lease = this.requireLease(row.resourceId);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) return false;

      const generation = lease.generation + 1;
      const claimed = this.state.connection
        .prepare(
          `UPDATE leases
           SET generation = ?, owner_type = 'system', owner_id = ?, token_hash = ?,
               acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND generation = ?
             AND (owner_id IS NULL OR expires_at IS NULL OR expires_at <= ?)`,
        )
        .run(
          generation,
          controlId,
          tokenHash(claimToken),
          now,
          now,
          now + 30_000,
          row.resourceId,
          lease.generation,
          now,
        );
      if (claimed.changes !== 1) return false;

      const errorHash = this.state.putText("Workflow run cancelled", now);
      const queue = this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = 'cancelled', error_code = 'cancelled', error_hash = ?,
               updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
        )
        .run(errorHash, now, now, options.runId);
      /* istanbul ignore if -- the control claim selects one nonterminal queue row */
      if (queue.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} has inconsistent queue state`);
      }
      const run = this.state.connection
        .prepare(
          `UPDATE runs
           SET status = 'cancelled', paused = 0, status_detail = NULL, error_hash = ?,
               updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'timed_out', 'cancelled')`,
        )
        .run(errorHash, now, now, options.runId);
      /* istanbul ignore if -- the control claim selects one nonterminal durable run */
      if (run.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} has inconsistent durable state`);
      }
      this.workflowMessages.cancelPendingForRun(options.runId, now);
      this.cancelWorkflowRunDependents(options.runId, controlId, errorHash, now);

      const released = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND owner_type = 'system' AND owner_id = ?
             AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(row.resourceId, controlId, tokenHash(claimToken), generation, now);
      /* istanbul ignore if -- the exact control claim was written in this transaction */
      if (released.changes !== 1) {
        throw new Error(`Workflow run ${options.runId} control claim changed during cancellation`);
      }
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        "run.queue_cancelled",
        "control",
        controlId,
        { status: "cancelled", code: "cancelled", staleControl: true },
        now,
        generation,
      );
      recordViewerDeltas(
        this.state,
        options.runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  deleteWorkflowRun(options: { runId: string; claimToken: string }): boolean {
    const now = Date.now();
    return this.state.transaction(() => {
      const row = this.workflowRunRow(options.runId);
      if (row === undefined) return false;
      const lease = this.requireLease(row.resourceId);
      if (
        lease.ownerId === null ||
        lease.tokenHash === null ||
        lease.expiresAt === null ||
        lease.expiresAt <= now ||
        !lease.tokenHash.equals(tokenHash(options.claimToken))
      ) {
        return false;
      }
      return (
        this.state.connection
          .prepare("DELETE FROM resources WHERE resource_id = ?")
          .run(row.resourceId).changes === 1
      );
    });
  }

  completeWorkflowRun(options: { runId: string; claimToken: string; now?: string }): boolean {
    return this.releaseRunClaim(options.runId, options.claimToken, "done", options.now);
  }

  recordRunEvent(options: {
    runId: string;
    workflowRef: string;
    type: string;
    payload?: JsonObject;
    runnerId?: string;
    now?: string;
  }): RunEventRecord {
    return this.state.transaction(() => {
      const row = this.requireWorkflowRunRow(options.runId);
      const now = epoch(validTimestamp(options.now));
      const revision = this.resourceRevision(row.resourceId) + 1;
      this.bumpResource(row.resourceId, revision - 1, now);
      const eventId = this.insertEvent(
        row.resourceId,
        revision,
        options.type,
        options.runnerId?.startsWith("server-") ? "server" : "session",
        options.runnerId ?? null,
        options.payload ?? {},
        now,
        row.leaseGeneration || undefined,
      );
      const seq = this.state.connection
        .prepare("SELECT event_seq AS seq FROM events WHERE event_id = ?")
        .get(eventId);
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isSequenceRow(seq)) throw new Error("Run event was not recorded");
      return {
        seq: seq.seq,
        recordedAt: new Date(now).toISOString(),
        runId: options.runId,
        workflowRef: options.workflowRef,
        type: options.type,
        runnerId: options.runnerId ?? null,
        payload: options.payload ?? {},
      };
    });
  }

  listRunEventsAfter(seq: number, options: { limit?: number } = {}): RunEventRecord[] {
    const rows = this.state.connection
      .prepare(
        `SELECT e.event_seq AS seq, e.recorded_at AS recordedAt, r.run_id AS runId,
                r.workflow_ref AS workflowRef, e.event_type AS eventType,
                e.actor_id AS runnerId, e.payload_hash AS payloadHash
         FROM events e JOIN runs r ON r.resource_id = e.resource_id
         WHERE e.event_seq > ? ORDER BY e.event_seq LIMIT ?`,
      )
      .all(seq, options.limit ?? 100);
    return rows.filter(isRunEventRow).map((row) => ({
      seq: row.seq,
      recordedAt: new Date(row.recordedAt).toISOString(),
      runId: row.runId,
      workflowRef: row.workflowRef,
      type: row.eventType,
      runnerId: row.runnerId,
      payload: row.payloadHash === null ? {} : (this.state.readJson(row.payloadHash) as JsonObject),
    }));
  }

  settleRunEffect(runId: string, effectType: "run.park_queue" | "run.settle_queue"): void {
    const rows = this.state.connection
      .prepare(
        `SELECT e.effect_id AS effectId, e.resource_id AS resourceId
         FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
         WHERE r.run_id = ? AND e.effect_type = ? AND e.status = 'pending'`,
      )
      .all(runId, effectType);
    for (const row of rows) {
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isEffectIdentityRow(row)) continue;
      this.state.transaction(() => {
        const now = Date.now();
        const revision = this.resourceRevision(row.resourceId);
        this.state.connection
          .prepare(
            `UPDATE effects SET status = 'applied', updated_at = ?, settled_at = ?
             WHERE effect_id = ? AND status = 'pending'`,
          )
          .run(now, now, row.effectId);
        this.bumpResource(row.resourceId, revision, now);
        this.insertEvent(
          row.resourceId,
          revision + 1,
          "effect.applied",
          "system",
          null,
          { runId, effectType },
          now,
        );
      });
    }
  }

  private workflowRunRow(runId: string): RunRow | undefined {
    const row = this.state.connection.prepare(workflowRunSelect("WHERE r.run_id = ?")).get(runId);
    return isRunRow(row) ? row : undefined;
  }

  private requireWorkflowRunRow(runId: string): RunRow {
    const row = this.workflowRunRow(runId);
    if (row === undefined) throw new Error(`Workflow run not found: ${runId}`);
    return row;
  }

  private requireWorkflowRun(runId: string): WorkflowRunQueueRecord {
    return this.mapWorkflowRun(this.requireWorkflowRunRow(runId));
  }

  private assertWorkflowRunPreparationCompatible(
    row: RunRow,
    options: WorkflowRunReservationOptions,
    definitionDigest: Buffer,
  ): void {
    const expectedLineageKind =
      options.parentRunId === undefined ? null : (options.lineageKind ?? null);
    const parent =
      options.parentRunId === undefined
        ? undefined
        : this.requireWorkflowRunRow(options.parentRunId);
    const expectedRootRunId = parent?.rootRunId ?? options.runId;
    const expectedRestartNumber =
      expectedLineageKind === "restart"
        ? (options.restartNumber ?? (parent?.restartNumber ?? -1) + 1)
        : (parent?.restartNumber ?? 0);
    const expectedParentRunRevision = options.parentRunRevision ?? null;
    const compatible =
      row.workflowName === options.workflowName &&
      row.workflowRef === options.workflowSourceRef &&
      row.definitionDigest.equals(definitionDigest) &&
      canonicalJson(readQueuedRunSources(this.state, row)) ===
        canonicalJson(queuedWorkflowSource(options.workflowSource)) &&
      canonicalJson(this.state.readJson(row.inputHash)) === canonicalJson(options.input ?? null) &&
      canonicalJson(this.state.readJson(row.launchOptionsHash)) ===
        canonicalJson(options.launchOptions ?? {}) &&
      row.originSessionId === options.originSessionId &&
      row.executionMode === (options.executionMode ?? "interactive") &&
      row.parentRunId === (options.parentRunId ?? null) &&
      row.rootRunId === expectedRootRunId &&
      row.lineageKind === expectedLineageKind &&
      row.restartNumber === expectedRestartNumber &&
      row.parentRunRevision === expectedParentRunRevision;
    if (!compatible) {
      throw new Error(`Workflow run preparation conflicts: ${options.runId}`);
    }
  }

  private workflowRunViewRows(clause: string, params: unknown[]): WorkflowRunViewRow[] {
    return this.state.connection
      .prepare(workflowRunViewSelect(clause))
      .all(...params)
      .filter(isWorkflowRunViewRow);
  }

  /* istanbul ignore next -- pure projection covered by integration tests */
  private mapWorkflowRun(row: RunRow): WorkflowRunQueueRecord {
    return {
      runId: row.runId,
      workflowName: row.workflowName,
      workflowSourceRef: row.workflowRef,
      workflowSource: readQueuedRunSources(this.state, row),
      initialized: row.runStatus !== "queued",
      definitionDigest: `sha256:${row.definitionDigest.toString("hex")}`,
      input: this.state.readJson(row.inputHash),
      launchOptions: this.state.readJson(row.launchOptionsHash),
      status: row.status,
      runnerId: row.ownerId,
      claimToken: null,
      claimGeneration: row.ownerId === null ? null : row.leaseGeneration,
      claimExpiresAt:
        row.claimExpiresAt === null ? null : new Date(row.claimExpiresAt).toISOString(),
      originSessionId: row.executionMode === "headless" ? null : row.originSessionId,
      executionMode: row.executionMode,
      parentRunId: row.parentRunId,
      rootRunId: row.rootRunId,
      lineageKind: row.lineageKind,
      restartNumber: row.restartNumber,
      parentRunRevision: row.parentRunRevision,
      errorCode: row.errorCode,
      errorMessage:
        row.errorHash === null
          ? null
          : (this.state.readBlob(row.errorHash)?.content.toString("utf8") ?? null),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
      finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
    };
  }

  private claimRun(
    runId: string,
    runnerId: string,
    claimToken: string,
    leaseMs: number,
    now: number,
    options: { allowPendingInteraction?: boolean; preserveQueueStatus?: boolean } = {},
  ): WorkflowRunQueueRecord | undefined {
    return this.state.transaction(() =>
      this.claimRunInTransaction(runId, runnerId, claimToken, leaseMs, now, options),
    );
  }

  private claimRunInTransaction(
    runId: string,
    runnerId: string,
    claimToken: string,
    leaseMs: number,
    now: number,
    options: { allowPendingInteraction?: boolean; preserveQueueStatus?: boolean } = {},
  ): WorkflowRunQueueRecord | undefined {
    const row = this.workflowRunRow(runId);
    if (row === undefined || ["done", "failed", "cancelled"].includes(row.status)) return undefined;
    if (
      options.allowPendingInteraction !== true &&
      this.state.connection
        .prepare(
          `SELECT 1 FROM interactive_requests
           WHERE run_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(runId) !== undefined
    ) {
      return undefined;
    }
    const lease = this.requireLease(row.resourceId);
    if (
      lease.ownerId !== null &&
      lease.expiresAt !== null &&
      lease.expiresAt > now &&
      lease.ownerId !== runnerId
    )
      return undefined;
    const generation = lease.generation + 1;
    const expiresAt = now + leaseMs;
    const result = this.state.connection
      .prepare(
        `UPDATE leases SET generation = ?, owner_type = ?, owner_id = ?, token_hash = ?,
                  acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND generation = ?`,
      )
      .run(
        generation,
        runnerId.startsWith("server-") ? "server" : "session",
        runnerId,
        tokenHash(claimToken),
        now,
        now,
        expiresAt,
        row.resourceId,
        lease.generation,
      );
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (result.changes !== 1) return undefined;
    if (options.preserveQueueStatus !== true) {
      this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = 'starting', error_code = NULL, error_hash = NULL, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(now, runId);
    }
    const revision = this.resourceRevision(row.resourceId);
    this.bumpResource(row.resourceId, revision, now);
    this.insertEvent(
      row.resourceId,
      revision + 1,
      "lease.claimed",
      runnerId.startsWith("server-") ? "server" : "session",
      runnerId,
      { expiresAt },
      now,
      generation,
    );
    return { ...this.requireWorkflowRun(runId), claimToken };
  }

  private updateClaimedRunStatus(
    runId: string,
    claimToken: string,
    status: WorkflowRunLaunchStatus,
    nowValue?: string,
  ): boolean {
    const now = epoch(validTimestamp(nowValue));
    return this.state.transaction(() => {
      if (
        !this.verifyWorkflowRunClaim({
          runId,
          claimToken,
          now: new Date(now).toISOString(),
        })
      ) {
        return false;
      }
      const row = this.requireWorkflowRunRow(runId);
      const changed =
        this.state.connection
          .prepare(
            "UPDATE run_queue SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ?",
          )
          .run(status, now, now, runId).changes === 1;
      /* istanbul ignore if -- impossible after exact schema and transaction checks */
      if (!changed) return false;
      const revision = this.resourceRevision(row.resourceId);
      const lease = this.requireLease(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        `run.queue_${status}`,
        lease.ownerType ?? "system",
        lease.ownerId,
        { status },
        now,
        lease.generation || undefined,
      );
      return true;
    });
  }

  private releaseRunClaim(
    runId: string,
    claimToken: string,
    status: WorkflowRunLaunchStatus,
    nowValue?: string,
  ): boolean {
    const now = epoch(validTimestamp(nowValue));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(runId);
      if (
        row === undefined ||
        !this.verifyWorkflowRunClaim({ runId, claimToken, now: new Date(now).toISOString() })
      )
        return false;
      this.state.connection
        .prepare(
          "UPDATE run_queue SET status = ?, updated_at = ?, finished_at = ? WHERE run_id = ?",
        )
        .run(status, now, status === "done" ? now : null, runId);
      const lease = this.requireLease(row.resourceId);
      const update = this.state.connection
        .prepare(
          `UPDATE leases SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
                  acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND token_hash = ? AND generation = ?`,
        )
        .run(row.resourceId, tokenHash(claimToken), lease.generation);
      /* istanbul ignore if -- impossible after exact schema and transaction checks */
      if (update.changes !== 1) return false;
      const revision = this.resourceRevision(row.resourceId);
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        `run.queue_${status}`,
        lease.ownerType ?? "system",
        lease.ownerId,
        { status },
        now,
        lease.generation || undefined,
      );
      this.settleRunEffect(runId, status === "parked" ? "run.park_queue" : "run.settle_queue");
      recordViewerDeltas(
        this.state,
        runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  private terminalRun(
    runId: string,
    claimToken: string | undefined,
    status: "failed" | "cancelled",
    code: string,
    error: string,
    nowValue?: string,
  ): boolean {
    const now = epoch(validTimestamp(nowValue));
    return this.state.transaction(() => {
      const row = this.workflowRunRow(runId);
      if (row === undefined || ["done", "failed", "cancelled"].includes(row.status)) return false;
      const lease = this.requireLease(row.resourceId);
      if (claimToken === undefined) {
        if (!(["queued", "starting"] as WorkflowRunLaunchStatus[]).includes(row.status)) {
          return false;
        }
        if (lease.ownerId !== null) return false;
      } else if (
        lease.ownerId === null ||
        lease.tokenHash === null ||
        lease.expiresAt === null ||
        lease.expiresAt <= now ||
        !lease.tokenHash.equals(tokenHash(claimToken))
      ) {
        return false;
      }
      const revision = this.resourceRevision(row.resourceId);
      const errorHash = this.state.putText(error, now);
      const queueUpdate = this.state.connection
        .prepare(
          `UPDATE run_queue
           SET status = ?, error_code = ?, error_hash = ?, updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
        )
        .run(status, code, errorHash, now, now, runId);
      if (queueUpdate.changes !== 1) return false;
      if (claimToken !== undefined) {
        const leaseUpdate = this.state.connection
          .prepare(
            `UPDATE leases
             SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
                 acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
             WHERE resource_id = ? AND token_hash = ? AND generation = ? AND expires_at > ?`,
          )
          .run(row.resourceId, tokenHash(claimToken), lease.generation, now);
        if (leaseUpdate.changes !== 1) {
          throw new Error(`Workflow run ${runId} claim changed during terminal transition`);
        }
      }
      this.state.connection
        .prepare(
          `UPDATE runs
           SET status = ?, paused = 0, status_detail = NULL, error_hash = ?,
               updated_at = ?, finished_at = ?
           WHERE run_id = ?`,
        )
        .run(status, errorHash, now, now, runId);
      this.workflowMessages.cancelPendingForRun(runId, now);
      if (status === "failed") {
        closeRunTime(this.state, runId);
        this.state.connection
          .prepare(
            `UPDATE node_attempts SET status = 'failed', error_hash = COALESCE(error_hash, ?),
           updated_at = ?, finished_at = COALESCE(finished_at, ?)
           WHERE run_id = ? AND status IN ('pending', 'running', 'waiting', 'interrupted')`,
          )
          .run(errorHash, now, now, runId);
        this.state.connection
          .prepare(
            `UPDATE interactive_requests SET status = 'cancelled', revision = revision + 1, updated_at = ?
           WHERE run_id = ? AND status = 'pending'`,
          )
          .run(now, runId);
      }
      if (status === "cancelled") {
        this.cancelWorkflowRunDependents(
          runId,
          lease.ownerId ?? "workflow-control",
          errorHash,
          now,
        );
      }
      this.bumpResource(row.resourceId, revision, now);
      this.insertEvent(
        row.resourceId,
        revision + 1,
        `run.queue_${status}`,
        lease.ownerType ?? "system",
        lease.ownerId,
        { status, code, error },
        now,
        lease.generation || undefined,
      );
      recordViewerDeltas(
        this.state,
        runId,
        [{ targetType: "summary" }, { targetType: "replay" }],
        now,
      );
      return true;
    });
  }

  private cancelWorkflowRunDependents(
    runId: string,
    actorId: string,
    errorHash: Buffer,
    now: number,
  ): void {
    closeRunTime(this.state, runId);
    this.state.connection
      .prepare(
        `UPDATE node_attempts
         SET status = 'cancelled', error_hash = COALESCE(error_hash, ?),
             updated_at = ?, finished_at = COALESCE(finished_at, ?)
         WHERE run_id = ? AND status IN ('pending', 'running', 'waiting', 'interrupted')`,
      )
      .run(errorHash, now, now, runId);

    const effects = this.state.connection
      .prepare(
        `SELECT e.effect_id AS effectId, e.resource_id AS resourceId,
                e.status, e.attempt_count AS attemptCount
         FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
         WHERE r.run_id = ? AND e.owner_scope = 'run' AND e.status IN ('pending', 'applying')
         ORDER BY e.effect_id`,
      )
      .all(runId)
      .filter(isCancelledRunEffectRow);
    for (const effect of effects) {
      const status = effect.status === "applying" ? "ambiguous" : "cancelled";
      const revision = this.resourceRevision(effect.resourceId);
      const changed = this.state.connection
        .prepare(
          `UPDATE effects
           SET status = ?, next_attempt_at = NULL, error_hash = ?, updated_at = ?, settled_at = ?
           WHERE effect_id = ? AND status = ? AND attempt_count = ?`,
        )
        .run(status, errorHash, now, now, effect.effectId, effect.status, effect.attemptCount);
      /* istanbul ignore if -- cancellation serializes the selected effect transition */
      if (changed.changes !== 1) {
        throw new Error(`Workflow effect ${effect.effectId} changed during cancellation`);
      }
      if (effect.status === "applying") {
        this.state.connection
          .prepare(
            `UPDATE effect_attempts
             SET finished_at = ?, outcome = 'interrupted', error_hash = ?
             WHERE effect_id = ? AND attempt_number = ? AND finished_at IS NULL`,
          )
          .run(now, errorHash, effect.effectId, effect.attemptCount);
      }
      this.bumpResource(effect.resourceId, revision, now);
      this.insertEvent(
        effect.resourceId,
        revision + 1,
        `effect.${status}`,
        "control",
        actorId,
        { runId, reason: "workflowCancelled" },
        now,
      );
    }

    this.state.connection
      .prepare(
        `INSERT INTO human_decision_resolutions(
           decision_id, outcome, provenance, response_hash, reason, channel,
           actor_id, request_digest, resolved_at
         )
         SELECT d.decision_id, 'cancelled', 'explicit_cancel', NULL,
                'Workflow run cancelled', NULL, ?, d.request_digest, ?
         FROM human_decisions d
         LEFT JOIN human_decision_resolutions r ON r.decision_id = d.decision_id
         WHERE d.run_id = ? AND r.decision_id IS NULL`,
      )
      .run(actorId, now, runId);
    const receiptHash = this.state.putJson(
      { status: "rejected", error: "Workflow run cancelled" },
      now,
    );
    this.state.connection
      .prepare(
        `UPDATE interactive_submissions SET outcome = 'rejected', receipt_hash = ?
         WHERE outcome = 'validating'
           AND request_id IN (SELECT request_id FROM interactive_requests WHERE run_id = ?)`,
      )
      .run(receiptHash, runId);
    this.state.connection
      .prepare(
        `UPDATE interactive_requests
         SET status = 'cancelled', revision = revision + 1, updated_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(now, runId);
  }
}
