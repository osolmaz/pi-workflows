import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { canonicalJson } from "../state/json.js";
import { resourceIdFor, tokenHash } from "../state/mutation.js";
import { initializeViewerRun, recordViewerDeltas } from "../state/viewer.js";
import { WorkflowMessageStore } from "../state/workflow-messages.js";
import {
  EffectRequestConflictError,
  ManagedResourceConflictError,
  ManagedResourceNotFoundError,
  WorkflowRequestConflictError,
} from "./errors.js";
import type {
  ResourceManagerStore,
  EffectReservation,
  QueueItem,
  QueueRequeueOptions,
  WorkflowRecordUpdate,
  WorkflowReservation,
} from "./store.js";
import type {
  ChildWorkflowRecord,
  ResourceManagerEvent,
  ResourceManagerQueueClaim,
  ManagedResource,
  ManagedResourceRef,
  ManagedResourceStatus,
  EffectRecord,
  JsonObject,
} from "./types.js";

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
  runnerId: string;
  originSessionId: string;
  executionMode?: "interactive" | "headless";
  parentRunId?: string;
  lineageKind?: "continuation" | "restart";
  restartNumber?: number;
  parentTerminalFingerprint?: string;
  now?: string;
};

export type WorkflowRunClaimOptions = WorkflowRunReservationOptions & {
  claimToken: string;
  leaseMs: number;
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
  lineageKind: "continuation" | "restart" | null;
  restartNumber: number;
  parentTerminalFingerprint: string | null;
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
  affinityRunnerId: string | null;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "continuation" | "restart" | null;
  restartNumber: number;
  parentTerminalFingerprint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunPreparationResult =
  | {
      state: "claimed";
      run: WorkflowRunQueueRecord & { claimToken: string };
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

type ResourceManagerRow = {
  managedResourceId: string;
  resourceId: string;
  resourceVersion: number;
  resourceManagerName: string;
  resourceKey: string;
  uid: string;
  generation: number;
  specHash: Buffer;
  statusHash: Buffer;
  deletionRequestedAt: number | null;
};

type LeaseRow = {
  generation: number;
  ownerType: string | null;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
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
  affinityRunnerId: string | null;
  consecutiveErrors: number;
  errorCode: string | null;
  errorHash: Buffer | null;
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "continuation" | "restart" | null;
  restartNumber: number;
  parentTerminalFingerprint: Buffer | null;
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
  lineageKind: "continuation" | "restart" | null;
  restartNumber: number;
  parentTerminalFingerprint: Buffer | null;
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

type EffectRow = {
  effectId: string;
  resourceUid: string;
  generation: number;
  kind: string;
  state: string;
  requestFingerprint: string;
  startedAt: number;
  completedAt: number | null;
  externalRef: string | null;
  errorHash: Buffer | null;
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

type WorkflowRow = {
  requestId: string;
  resourceUid: string;
  requestKey: string;
  inputFingerprint: Buffer;
  workflowName: string;
  runId: string | null;
  status: ChildWorkflowRecord["state"];
  attemptCount: number;
  errorHash: Buffer | null;
};

export class SqliteResourceManagerStore implements ResourceManagerStore {
  readonly filePath: string;
  readonly state: StateDatabase;
  private readonly workflowMessages: WorkflowMessageStore;
  private readonly ownsState: boolean;
  private readonly projectId: string | null;
  private closed = false;

  constructor(
    filePath: string = workflowStatePath(),
    options: {
      readOnly?: boolean;
      projectPath?: string;
      state?: StateDatabase;
      /** Server-only global view. Project-scoped mutations still require projectPath. */
      global?: boolean;
    } = {},
  ) {
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
        checkLegacyState: filePath === workflowStatePath(),
      });
    this.filePath = this.state.filePath;
    this.workflowMessages = new WorkflowMessageStore(this.state);
    if (options.global === true) {
      this.projectId = null;
    } else {
      const projectPath = options.projectPath === undefined ? process.cwd() : options.projectPath;
      this.projectId =
        options.readOnly === true ? this.findProject(projectPath) : this.ensureProject(projectPath);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsState) this.state.close();
  }

  putResource<TSpec, TStatus>(options: {
    resourceManager: string;
    key: string;
    spec: TSpec;
    initialStatus: TStatus;
    now?: string;
  }): ManagedResource<TSpec, TStatus> {
    this.assertWritable();
    validateName(options.resourceManager, "resource manager");
    validateKey(options.key, "resource key");
    const now = epoch(validTimestamp(options.now));
    const specHash = this.state.putJson(options.spec, now);
    const initialStatus: ManagedResourceStatus<TStatus> = {
      observedGeneration: 0,
      conditions: [],
      resourceManagerStatus: options.initialStatus,
    };
    const statusHash = this.state.putJson(initialStatus, now);
    return this.state.transaction(() => {
      const existing = this.resourceManagerRow({
        resourceManager: options.resourceManager,
        key: options.key,
      });
      if (existing === undefined) {
        const uid = randomUUID();
        const managedResourceId = `controller-resource-${randomUUID()}`;
        const resourceId = resourceIdFor(
          "controller",
          `${this.requireProjectId()}:${options.resourceManager}:${options.key}`,
        );
        this.state.connection
          .prepare(
            `INSERT INTO resources(
               resource_id, resource_type, aggregate_key, revision, created_at, updated_at
             ) VALUES (?, 'controller', ?, 1, ?, ?)`,
          )
          .run(resourceId, managedResourceId, now, now);
        this.state.connection
          .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
          .run(resourceId);
        this.state.connection
          .prepare(
            `INSERT INTO controller_resources(
               controller_resource_id, resource_id, project_id, controller_name,
               resource_key, uid, generation, spec_hash, status_hash, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            managedResourceId,
            resourceId,
            this.requireProjectId(),
            options.resourceManager,
            options.key,
            uid,
            specHash,
            statusHash,
            now,
            now,
          );
        this.enqueueResourceManagerRow(managedResourceId, now, now);
        this.insertEvent(
          resourceId,
          1,
          "resource.created",
          "control",
          null,
          { generation: 1 },
          now,
        );
      } else if (!existing.specHash.equals(specHash)) {
        const revision = existing.resourceVersion + 1;
        this.state.connection
          .prepare(
            `UPDATE controller_resources
             SET spec_hash = ?, generation = generation + 1, updated_at = ?
             WHERE controller_resource_id = ?`,
          )
          .run(specHash, now, existing.managedResourceId);
        this.bumpResource(existing.resourceId, existing.resourceVersion, now);
        this.enqueueResourceManagerRow(existing.managedResourceId, now, now);
        this.insertEvent(
          existing.resourceId,
          revision,
          "resource.spec_updated",
          "control",
          null,
          { generation: existing.generation + 1 },
          now,
        );
      }
      return this.requireResource({
        resourceManager: options.resourceManager,
        key: options.key,
      }) as ManagedResource<TSpec, TStatus>;
    });
  }

  getResource<TSpec = unknown, TStatus = unknown>(
    ref: ManagedResourceRef,
  ): ManagedResource<TSpec, TStatus> | undefined {
    const row = this.resourceManagerRow(ref);
    return row === undefined
      ? undefined
      : (this.mapManagedResource(row) as ManagedResource<TSpec, TStatus>);
  }

  getResourceByUid(uid: string): ManagedResource | undefined {
    const row = this.state.connection.prepare(resourceManagerSelect("WHERE c.uid = ?")).get(uid);
    return isResourceManagerRow(row) ? this.mapManagedResource(row) : undefined;
  }

  listResources<TSpec = unknown, TStatus = unknown>(
    options: { resourceManager?: string } = {},
  ): ManagedResource<TSpec, TStatus>[] {
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    if (this.projectId !== null) {
      clauses.push("c.project_id = ?");
      params.push(this.projectId);
    }
    if (options.resourceManager !== undefined) {
      clauses.push("c.controller_name = ?");
      params.push(options.resourceManager);
    }
    const rows = this.state.connection
      .prepare(
        resourceManagerSelect(
          `WHERE ${clauses.join(" AND ")} ORDER BY c.controller_name, c.resource_key`,
        ),
      )
      .all(...params);
    return rows
      .filter(isResourceManagerRow)
      .map((row) => this.mapManagedResource(row) as ManagedResource<TSpec, TStatus>);
  }

  updateStatus<TStatus>(options: {
    ref: ManagedResourceRef;
    expectedResourceVersion: number;
    claim: ResourceManagerQueueClaim;
    status: ManagedResourceStatus<TStatus>;
    finalizers?: string[];
    now?: string;
  }): ManagedResource<unknown, TStatus> {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.requireResourceManagerRow(options.ref);
      this.assertResourceManagerClaim(row, options.claim, now);
      if (row.resourceVersion !== options.expectedResourceVersion) {
        throw new ManagedResourceConflictError(options.ref.resourceManager, options.ref.key);
      }
      const statusHash = this.state.putJson(options.status, now);
      this.state.connection
        .prepare(
          "UPDATE controller_resources SET status_hash = ?, updated_at = ? WHERE controller_resource_id = ?",
        )
        .run(statusHash, now, row.managedResourceId);
      if (options.finalizers !== undefined)
        this.replaceFinalizers(row.managedResourceId, options.finalizers);
      this.bumpResource(row.resourceId, row.resourceVersion, now);
      this.insertEvent(
        row.resourceId,
        row.resourceVersion + 1,
        "resource.status_updated",
        "controller",
        options.claim.ownerId,
        {},
        now,
        options.claim.generation,
      );
      options.claim.resourceVersion = row.resourceVersion + 1;
      return this.requireResource(options.ref) as ManagedResource<unknown, TStatus>;
    });
  }

  requestDeletion(ref: ManagedResourceRef, nowValue?: string): ManagedResource {
    const now = epoch(validTimestamp(nowValue));
    return this.state.transaction(() => {
      const row = this.requireResourceManagerRow(ref);
      if (row.deletionRequestedAt === null) {
        this.state.connection
          .prepare(
            "UPDATE controller_resources SET deletion_requested_at = ?, updated_at = ? WHERE controller_resource_id = ?",
          )
          .run(now, now, row.managedResourceId);
        this.bumpResource(row.resourceId, row.resourceVersion, now);
        this.enqueueResourceManagerRow(row.managedResourceId, now, now);
        this.insertEvent(
          row.resourceId,
          row.resourceVersion + 1,
          "resource.deletion_requested",
          "control",
          null,
          {},
          now,
        );
      }
      return this.requireResource(ref);
    });
  }

  updateFinalizers(options: {
    ref: ManagedResourceRef;
    expectedResourceVersion: number;
    finalizers: string[];
    now?: string;
  }): ManagedResource {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.requireResourceManagerRow(options.ref);
      if (row.resourceVersion !== options.expectedResourceVersion) {
        throw new ManagedResourceConflictError(options.ref.resourceManager, options.ref.key);
      }
      this.replaceFinalizers(row.managedResourceId, options.finalizers);
      this.state.connection
        .prepare("UPDATE controller_resources SET updated_at = ? WHERE controller_resource_id = ?")
        .run(now, row.managedResourceId);
      this.bumpResource(row.resourceId, row.resourceVersion, now);
      this.insertEvent(
        row.resourceId,
        row.resourceVersion + 1,
        "resource.finalizers_updated",
        "control",
        null,
        {},
        now,
      );
      return this.requireResource(options.ref);
    });
  }

  deleteResource(
    ref: ManagedResourceRef,
    expectedResourceVersion: number,
    claim: ResourceManagerQueueClaim,
  ): boolean {
    return this.state.transaction(() => {
      const row = this.requireResourceManagerRow(ref);
      this.assertResourceManagerClaim(row, claim, Date.now());
      if (row.resourceVersion !== expectedResourceVersion) {
        throw new ManagedResourceConflictError(ref.resourceManager, ref.key);
      }
      if (row.deletionRequestedAt === null || this.finalizers(row.managedResourceId).length > 0)
        return false;
      this.state.connection
        .prepare("DELETE FROM controller_resources WHERE controller_resource_id = ?")
        .run(row.managedResourceId);
      return true;
    });
  }

  enqueue(ref: ManagedResourceRef, availableAt?: string): void {
    const row = this.requireResourceManagerRow(ref);
    const now = Date.now();
    this.enqueueResourceManagerRow(row.managedResourceId, epoch(validTimestamp(availableAt)), now);
  }

  claimNext(options: {
    resourceManagers: string[];
    ownerId: string;
    leaseMs: number;
    now?: string;
    exclude?: ManagedResourceRef[];
  }): ResourceManagerQueueClaim | undefined {
    if (options.resourceManagers.length === 0) return undefined;
    const now = epoch(validTimestamp(options.now));
    const placeholders = options.resourceManagers.map(() => "?").join(", ");
    const exclusions = options.exclude ?? [];
    const exclusionSql = exclusions
      .map(() => "AND NOT (c.controller_name = ? AND c.resource_key = ?)")
      .join("\n               ");
    const exclusionParams = exclusions.flatMap((ref) => [ref.resourceManager, ref.key]);
    return this.state.transaction(() => {
      const row = this.state.connection
        .prepare(
          `${resourceManagerSelect(`
             JOIN controller_queue q ON q.controller_resource_id = c.controller_resource_id
             JOIN leases l ON l.resource_id = c.resource_id
             WHERE c.project_id = ?
               AND c.controller_name IN (${placeholders})
               ${exclusionSql}
               AND q.available_at <= ?
               AND (l.owner_id IS NULL OR l.expires_at <= ?)
             ORDER BY q.available_at, c.controller_name, c.resource_key
             LIMIT 1`)}`,
        )
        .get(this.requireProjectId(), ...options.resourceManagers, ...exclusionParams, now, now);
      if (!isResourceManagerRow(row)) return undefined;
      const lease = this.requireLease(row.resourceId);
      const token = randomBytes(32).toString("base64url");
      const generation = lease.generation + 1;
      const expiresAt = now + options.leaseMs;
      const result = this.state.connection
        .prepare(
          `UPDATE leases
           SET generation = ?, owner_type = 'controller', owner_id = ?, token_hash = ?,
               acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND generation = ?
             AND (owner_id IS NULL OR expires_at <= ?)`,
        )
        .run(
          generation,
          options.ownerId,
          tokenHash(token),
          now,
          now,
          expiresAt,
          row.resourceId,
          lease.generation,
          now,
        );
      /* istanbul ignore if -- impossible after exact schema and transaction checks */
      if (result.changes !== 1) return undefined;
      this.bumpResource(row.resourceId, row.resourceVersion, now);
      this.insertEvent(
        row.resourceId,
        row.resourceVersion + 1,
        "lease.claimed",
        "controller",
        options.ownerId,
        { expiresAt },
        now,
        generation,
      );
      return {
        resourceManager: row.resourceManagerName,
        key: row.resourceKey,
        ownerId: options.ownerId,
        token,
        generation,
        queueVersion: this.queueVersion(row.managedResourceId),
        resourceVersion: row.resourceVersion + 1,
        consecutiveErrors: this.queueErrors(row.managedResourceId),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
  }

  renewClaim(claim: ResourceManagerQueueClaim, leaseMs: number, nowValue?: string): boolean {
    const now = epoch(validTimestamp(nowValue));
    const expiresAt = now + leaseMs;
    const row = this.resourceManagerRow({ resourceManager: claim.resourceManager, key: claim.key });
    if (row === undefined) return false;
    const result = this.state.connection
      .prepare(
        `UPDATE leases SET heartbeat_at = ?, expires_at = ?
         WHERE resource_id = ? AND owner_type = 'controller' AND owner_id = ?
           AND token_hash = ? AND generation = ? AND expires_at > ?`,
      )
      .run(
        now,
        expiresAt,
        row.resourceId,
        claim.ownerId,
        tokenHash(claim.token),
        claim.generation,
        now,
      );
    if (result.changes === 1) claim.expiresAt = new Date(expiresAt).toISOString();
    return result.changes === 1;
  }

  settleClaim(claim: ResourceManagerQueueClaim, nowValue?: string): boolean {
    return this.settleResourceManagerClaim(claim, undefined, nowValue);
  }

  requeueClaim(
    claim: ResourceManagerQueueClaim,
    options: QueueRequeueOptions,
    nowValue?: string,
  ): boolean {
    return this.settleResourceManagerClaim(claim, options, nowValue);
  }

  listQueue(): QueueItem[] {
    const rows = this.state.connection
      .prepare(
        `SELECT c.controller_name AS resourceManager, c.resource_key AS resourceKey,
                q.available_at AS availableAt, q.consecutive_errors AS consecutiveErrors,
                l.expires_at AS claimExpiresAt
         FROM controller_queue q
         JOIN controller_resources c ON c.controller_resource_id = q.controller_resource_id
         JOIN leases l ON l.resource_id = c.resource_id
         WHERE c.project_id = ? ORDER BY q.available_at, c.controller_name, c.resource_key`,
      )
      .all(this.requireProjectId());
    return rows.filter(isQueueListRow).map((row) => ({
      resourceManager: row.resourceManager,
      key: row.resourceKey,
      availableAt: new Date(row.availableAt).toISOString(),
      consecutiveErrors: row.consecutiveErrors,
      ...(row.claimExpiresAt === null
        ? {}
        : { claimExpiresAt: new Date(row.claimExpiresAt).toISOString() }),
    }));
  }

  reserveEffect(options: {
    key: string;
    resourceUid: string;
    claim: ResourceManagerQueueClaim;
    generation: number;
    kind: string;
    requestFingerprint: string;
    now?: string;
  }): EffectReservation {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const source = this.requireResourceManagerRowByUid(options.resourceUid);
      this.assertResourceManagerClaim(source, options.claim, now);
      const effectId = effectIdFor(source.resourceId, options.key);
      const existing = this.effectRow(options.resourceUid, options.key);
      if (existing !== undefined) {
        if (
          existing.generation !== options.generation ||
          existing.kind !== options.kind ||
          existing.requestFingerprint !== options.requestFingerprint
        ) {
          throw new EffectRequestConflictError(options.key);
        }
        return { record: this.mapEffect(existing), created: false };
      }
      const effectResourceId = resourceIdFor("effect", effectId);
      const payloadHash = this.state.putJson(
        {
          key: options.key,
          resourceUid: options.resourceUid,
          generation: options.generation,
          kind: options.kind,
          requestFingerprint: options.requestFingerprint,
        },
        now,
      );
      this.state.connection
        .prepare(
          `INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at)
           VALUES (?, 'effect', ?, 1, ?, ?)`,
        )
        .run(effectResourceId, effectId, now, now);
      this.state.connection
        .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
        .run(effectResourceId);
      this.state.connection
        .prepare(
          `INSERT INTO effects(
             effect_id, resource_id, source_resource_id, source_revision, effect_type,
             idempotency_key, payload_hash, owner_scope, status, attempt_count,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'controller', 'pending', 0, ?, ?)`,
        )
        .run(
          effectId,
          effectResourceId,
          source.resourceId,
          source.resourceVersion,
          options.kind,
          options.key,
          payloadHash,
          now,
          now,
        );
      this.insertEvent(
        effectResourceId,
        1,
        "effect.reserved",
        "controller",
        options.claim.ownerId,
        {},
        now,
        options.claim.generation,
      );
      return {
        record: this.mapEffect(this.requireEffectRow(options.resourceUid, options.key)),
        created: true,
      };
    });
  }

  getEffect(resourceUid: string, key: string): EffectRecord | undefined {
    const row = this.effectRow(resourceUid, key);
    return row === undefined ? undefined : this.mapEffect(row);
  }

  updateEffect(options: {
    resourceUid: string;
    key: string;
    claim: ResourceManagerQueueClaim;
    state: EffectRecord["state"];
    externalRef?: string;
    error?: string;
    now?: string;
  }): EffectRecord {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const source = this.requireResourceManagerRowByUid(options.resourceUid);
      this.assertResourceManagerClaim(source, options.claim, now);
      const row = this.requireEffectRow(options.resourceUid, options.key);
      const effectResourceId = resourceIdFor("effect", row.effectId);
      const revision = this.resourceRevision(effectResourceId);
      const errorHash = options.error === undefined ? null : this.state.putText(options.error, now);
      this.state.connection
        .prepare(
          `UPDATE effects
           SET status = ?, external_ref = ?, error_hash = ?, updated_at = ?, settled_at = ?
           WHERE effect_id = ?`,
        )
        .run(
          effectStatus(options.state),
          options.externalRef ?? null,
          errorHash,
          now,
          options.state === "pending" ? null : now,
          row.effectId,
        );
      this.bumpResource(effectResourceId, revision, now);
      this.insertEvent(
        effectResourceId,
        revision + 1,
        `effect.${options.state}`,
        "controller",
        options.claim.ownerId,
        {},
        now,
        options.claim.generation,
      );
      return this.mapEffect(this.requireEffectRow(options.resourceUid, options.key));
    });
  }

  listEffects(resourceUid: string): EffectRecord[] {
    const rows = this.state.connection
      .prepare(effectSelect("WHERE c.uid = ? ORDER BY e.created_at, e.effect_id"))
      .all(resourceUid);
    return rows.filter(isEffectRow).map((row) => this.mapEffect(row));
  }

  reserveWorkflow(options: {
    resourceUid: string;
    claim: ResourceManagerQueueClaim;
    requestKey: string;
    workflow: string;
    inputFingerprint: string;
  }): WorkflowReservation {
    const now = Date.now();
    return this.state.transaction(() => {
      const source = this.requireResourceManagerRowByUid(options.resourceUid);
      this.assertResourceManagerClaim(source, options.claim, now);
      const existing = this.workflowRow(options.resourceUid, options.requestKey);
      if (existing !== undefined) {
        if (
          existing.workflowName !== options.workflow ||
          existing.inputFingerprint.toString("hex") !== options.inputFingerprint
        ) {
          throw new WorkflowRequestConflictError(options.requestKey);
        }
        return { record: this.mapWorkflow(existing), created: false };
      }
      const requestId = randomUUID();
      this.state.connection
        .prepare(
          `INSERT INTO controller_workflows(
             request_id, controller_resource_id, request_key, workflow_name,
             input_fingerprint, status, attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          requestId,
          source.managedResourceId,
          options.requestKey,
          options.workflow,
          Buffer.from(options.inputFingerprint, "hex"),
          now,
          now,
        );
      return { record: this.mapWorkflow(this.requireWorkflowRow(requestId)), created: true };
    });
  }

  getWorkflow(resourceUid: string, requestKey: string): ChildWorkflowRecord | undefined {
    const row = this.workflowRow(resourceUid, requestKey);
    return row === undefined ? undefined : this.mapWorkflow(row);
  }

  getWorkflowByRequestId(requestId: string): ChildWorkflowRecord | undefined {
    const row = this.workflowRowById(requestId);
    return row === undefined ? undefined : this.mapWorkflow(row);
  }

  updateWorkflow(
    requestId: string,
    update: WorkflowRecordUpdate,
    claim: ResourceManagerQueueClaim,
  ): ChildWorkflowRecord {
    const now = Date.now();
    return this.state.transaction(() => {
      const row = this.requireWorkflowRow(requestId);
      const source = this.requireResourceManagerRowByUid(row.resourceUid);
      this.assertResourceManagerClaim(source, claim, now);
      const errorHash =
        update.error === undefined || update.error === null
          ? null
          : this.state.putText(update.error, now);
      this.state.connection
        .prepare(
          `UPDATE controller_workflows
           SET reserved_run_id = COALESCE(?, reserved_run_id),
               run_id = CASE
                 WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE run_id = ?) THEN ?
                 ELSE run_id
               END,
               status = ?, attempt_count = COALESCE(?, attempt_count),
               error_hash = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(
          update.runId ?? null,
          update.runId ?? null,
          update.runId ?? null,
          update.runId ?? null,
          update.state,
          update.attempt ?? null,
          errorHash,
          now,
          requestId,
        );
      return this.mapWorkflow(this.requireWorkflowRow(requestId));
    });
  }

  completeWorkflow(requestId: string, update: WorkflowRecordUpdate): ChildWorkflowRecord {
    const row = this.requireWorkflowRow(requestId);
    if (update.state === "pending" || update.state === "running") {
      throw new Error("Scheduler completion must report a settled child state");
    }
    if (update.runId !== undefined && row.runId !== null && update.runId !== row.runId) {
      throw new Error("Scheduler completion run ID does not match the reserved child run");
    }
    const source = this.requireResourceManagerRowByUid(row.resourceUid);
    const now = Date.now();
    return this.state.transaction(() => {
      const errorHash =
        update.error === undefined || update.error === null
          ? null
          : this.state.putText(update.error, now);
      this.state.connection
        .prepare(
          `UPDATE controller_workflows
           SET run_id = CASE
                 WHEN ? IS NOT NULL AND EXISTS(SELECT 1 FROM runs WHERE run_id = ?) THEN ?
                 ELSE run_id
               END,
               status = ?, attempt_count = COALESCE(?, attempt_count),
               error_hash = ?, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(
          update.runId ?? null,
          update.runId ?? null,
          update.runId ?? null,
          update.state,
          update.attempt ?? null,
          errorHash,
          now,
          requestId,
        );
      const revision = this.resourceRevision(source.resourceId);
      this.bumpResource(source.resourceId, revision, now);
      this.insertEvent(
        source.resourceId,
        revision + 1,
        "workflow_state_changed",
        "system",
        null,
        { requestId, state: update.state, runId: update.runId ?? row.runId },
        now,
      );
      return this.mapWorkflow(this.requireWorkflowRow(requestId));
    });
  }

  listWorkflows(resourceUid: string): ChildWorkflowRecord[] {
    const rows = this.state.connection
      .prepare(workflowSelect("WHERE c.uid = ? ORDER BY w.created_at, w.request_id"))
      .all(resourceUid);
    return rows.filter(isWorkflowRow).map((row) => this.mapWorkflow(row));
  }

  recordEvent(options: {
    resourceManager: string;
    key: string;
    claim?: ResourceManagerQueueClaim;
    type: string;
    payload?: JsonObject;
    now?: string;
  }): ResourceManagerEvent {
    const now = epoch(validTimestamp(options.now));
    return this.state.transaction(() => {
      const row = this.requireResourceManagerRow({
        resourceManager: options.resourceManager,
        key: options.key,
      });
      if (options.claim !== undefined) this.assertResourceManagerClaim(row, options.claim, now);
      const revision = this.resourceRevision(row.resourceId) + 1;
      this.bumpResource(row.resourceId, revision - 1, now);
      const eventId = this.insertEvent(
        row.resourceId,
        revision,
        options.type,
        options.claim === undefined ? "control" : "controller",
        options.claim?.ownerId ?? null,
        options.payload ?? {},
        now,
        options.claim?.generation,
      );
      if (options.claim !== undefined) options.claim.resourceVersion = revision;
      const event = this.state.connection
        .prepare("SELECT event_seq AS seq FROM events WHERE event_id = ?")
        .get(eventId);
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isSequenceRow(event)) throw new Error("ResourceManager event was not recorded");
      return {
        seq: event.seq,
        recordedAt: new Date(now).toISOString(),
        resourceManager: options.resourceManager,
        key: options.key,
        type: options.type,
        payload: options.payload ?? {},
      };
    });
  }

  listEvents(
    options: { resourceManager?: string; key?: string; limit?: number } = {},
  ): ResourceManagerEvent[] {
    const clauses = ["r.resource_type = 'controller'"];
    const params: unknown[] = [];
    if (this.projectId !== null) {
      clauses.push("c.project_id = ?");
      params.push(this.projectId);
    }
    if (options.resourceManager !== undefined) {
      clauses.push("c.controller_name = ?");
      params.push(options.resourceManager);
    }
    if (options.key !== undefined) {
      clauses.push("c.resource_key = ?");
      params.push(options.key);
    }
    params.push(options.limit ?? 100);
    const rows = this.state.connection
      .prepare(
        `SELECT e.event_seq AS seq, e.recorded_at AS recordedAt,
                c.controller_name AS resourceManager, c.resource_key AS resourceKey,
                e.event_type AS eventType, e.payload_hash AS payloadHash
         FROM events e
         JOIN resources r ON r.resource_id = e.resource_id
         JOIN controller_resources c ON c.resource_id = r.resource_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY e.event_seq DESC LIMIT ?`,
      )
      .all(...params);
    return rows.filter(isResourceManagerEventRow).map((row) => ({
      seq: row.seq,
      recordedAt: new Date(row.recordedAt).toISOString(),
      resourceManager: row.resourceManager,
      key: row.resourceKey,
      type: row.eventType,
      payload: row.payloadHash === null ? {} : (this.state.readJson(row.payloadHash) as JsonObject),
    }));
  }

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
    const lineageKind =
      options.parentRunId === undefined ? null : (options.lineageKind ?? "continuation");
    if (options.parentRunId === undefined && options.lineageKind !== undefined) {
      throw new Error("A root workflow run cannot declare lineage");
    }
    let rootRunId = options.runId;
    let restartNumber = 0;
    let parentTerminalFingerprint: Buffer | null = null;
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
        if (options.parentTerminalFingerprint === undefined) {
          throw new Error("Restart requires the parent terminal fingerprint");
        }
        parentTerminalFingerprint = terminalFingerprintBuffer(options.parentTerminalFingerprint);
        restartNumber = options.restartNumber ?? parent.restartNumber + 1;
        if (restartNumber !== parent.restartNumber + 1) {
          throw new Error("Restart number does not follow its parent");
        }
      } else {
        if (
          options.parentTerminalFingerprint !== undefined ||
          (options.restartNumber !== undefined && options.restartNumber !== parent.restartNumber)
        ) {
          throw new Error("Continuation lineage conflicts with restart metadata");
        }
        restartNumber = parent.restartNumber;
        if (parent.status === "parked") {
          const parentLease = this.requireLease(parent.resourceId);
          if (parentLease.ownerId !== null) {
            throw new Error("Continuation parent still has an active owner");
          }
          this.state.connection
            .prepare(
              `UPDATE run_queue
                 SET status = 'done', updated_at = ?, finished_at = ?
                 WHERE run_id = ? AND status = 'parked'`,
            )
            .run(now, now, parent.runId);
          const parentRevision = this.resourceRevision(parent.resourceId);
          this.bumpResource(parent.resourceId, parentRevision, now);
          this.insertEvent(
            parent.resourceId,
            parentRevision + 1,
            "run.queue_done_for_continuation",
            "session",
            options.originSessionId,
            { continuationRunId: options.runId },
            now,
          );
        } else if (parent.status === "done") {
          throw new Error("Continuation parent already has a reserved continuation");
        } else {
          throw new Error(`Continuation parent queue is ${parent.status}`);
        }
      }
    } else if (
      options.restartNumber !== undefined ||
      options.parentTerminalFingerprint !== undefined
    ) {
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
             restart_number, parent_terminal_fingerprint, definition_digest,
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
        parentTerminalFingerprint,
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
             run_id, status, available_at, affinity_runner_id, origin_session_id,
             consecutive_errors, created_at, updated_at
           ) VALUES (?, 'queued', ?, ?, ?, 0, ?, ?)`,
      )
      .run(options.runId, now, options.runnerId, options.originSessionId, now, now);
    this.insertEvent(resourceId, 1, "run.queued", "session", options.originSessionId, {}, now);
    return this.requireWorkflowRun(options.runId);
  }

  prepareOrAdoptWorkflowRun(options: WorkflowRunClaimOptions): WorkflowRunPreparationResult {
    validateRunId(options.runId);
    const now = epoch(validTimestamp(options.now));
    const definitionDigest = digestBuffer(options.definitionDigest);
    return this.state.transaction(() => {
      const existing = this.workflowRunRow(options.runId);
      if (existing !== undefined) {
        this.assertWorkflowRunPreparationCompatible(existing, options, definitionDigest);
        return { state: "adopted", run: this.mapWorkflowRun(existing) };
      }
      this.reserveWorkflowRunInTransaction(options, now, definitionDigest);
      const claimed = this.claimRunInTransaction(
        options.runId,
        options.runnerId,
        options.claimToken,
        options.leaseMs,
        now,
      );
      if (claimed === undefined) {
        throw new Error(`Workflow run could not be claimed: ${options.runId}`);
      }
      return {
        state: "claimed",
        run: claimed as WorkflowRunQueueRecord & { claimToken: string },
      };
    });
  }

  enqueueWorkflowRun(options: WorkflowRunClaimOptions): WorkflowRunQueueRecord {
    if (this.getWorkflowRun(options.runId) === undefined) {
      this.reserveWorkflowRun({
        runId: options.runId,
        workflowName: options.workflowName,
        workflowSourceRef: options.workflowSourceRef,
        workflowSource: options.workflowSource,
        definitionDigest: options.definitionDigest,
        definitionSnapshot: options.definitionSnapshot,
        input: options.input,
        launchOptions: options.launchOptions ?? {},
        runnerId: options.runnerId,
        originSessionId: options.originSessionId,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
        ...(options.lineageKind === undefined ? {} : { lineageKind: options.lineageKind }),
        ...(options.restartNumber === undefined ? {} : { restartNumber: options.restartNumber }),
        ...(options.parentTerminalFingerprint === undefined
          ? {}
          : { parentTerminalFingerprint: options.parentTerminalFingerprint }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    }
    const claimed = this.claimWorkflowRun({
      runId: options.runId,
      runnerId: options.runnerId,
      claimToken: options.claimToken,
      leaseMs: options.leaseMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (claimed === undefined) {
      throw new Error(`Workflow run could not be claimed: ${options.runId}`);
    }
    return claimed;
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
          "WHERE b.origin_session_id = ? AND q.status NOT IN ('done', 'failed', 'cancelled') ORDER BY q.created_at DESC LIMIT 1",
        ),
      )
      .get(sessionId);
    return isRunRow(row) ? this.mapWorkflowRun(row) : undefined;
  }

  findSessionReservationView(sessionId: string): WorkflowRunQueueViewRecord | undefined {
    const row = this.workflowRunViewRows(
      "WHERE b.origin_session_id = ? AND q.status NOT IN ('done', 'failed', 'cancelled') ORDER BY q.created_at DESC LIMIT 1",
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
             AND a.deadline_at IS NOT NULL AND a.deadline_at <= ?
             AND EXISTS (
               SELECT 1 FROM workflow_messages m
               JOIN workflow_turns t ON t.workflow_message_id = m.workflow_message_id
               WHERE m.source_id = i.request_id AND m.kind = 'step' AND t.state = 'started'
             )
           ORDER BY a.deadline_at, i.request_id LIMIT 1`,
        )
        .get(options.runId, options.targetSessionId, now);
      if (!isExpiredInteractionRow(interaction)) return false;
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
    sessionId?: string;
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
      "(q.affinity_runner_id IS NULL OR q.affinity_runner_id = ? OR q.status IN ('parked', 'starting', 'running'))",
      "NOT (q.status = 'parked' AND (r.status = 'waiting' OR r.paused = 1))",
      "NOT EXISTS (SELECT 1 FROM interactive_requests i WHERE i.run_id = r.run_id AND i.status = 'pending')",
      "(q.error_code IS NULL OR q.error_code NOT IN ('workflowSourceChanged', 'runnerNoProgress'))",
    ];
    const params: unknown[] = [now, now, options.runnerId, options.runnerId];
    if (this.projectId !== null) {
      clauses.unshift("r.project_id = ?");
      params.unshift(this.projectId);
    }
    if (options.sessionId !== undefined) {
      clauses.push("b.origin_session_id = ?");
      params.push(options.sessionId);
    } else {
      clauses.push("(b.execution_mode = 'headless' OR q.status <> 'queued')");
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
        actor: { type: "session" | "host"; id: string };
        ownerType: "session" | "host";
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
    const ownerType = row.ownerId.startsWith("host-") ? "host" : "session";
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
        .run(detail, now, now, options.runId);
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
      this.settleWorkflowRunMessages(options.runId, now);
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

  repairCanonicalWorkflowSourceRun(): never {
    throw new Error("Legacy workflow source repair is not available after the SQLite cutover");
  }

  claimLegacyWorkflowSourceRun(): never {
    throw new Error("Legacy workflow source claims are not available after the SQLite cutover");
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
        options.runnerId?.startsWith("host-") ? "host" : "session",
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

  setWorkflowRunOriginSession(runId: string, originSessionId: string): boolean {
    const now = Date.now();
    return (
      this.state.connection
        .prepare(
          `INSERT INTO run_bindings(run_id, origin_session_id, execution_mode, created_at)
         VALUES (?, ?, 'interactive', ?)
         ON CONFLICT(run_id) DO UPDATE SET origin_session_id = excluded.origin_session_id`,
        )
        .run(runId, originSessionId, now).changes === 1
    );
  }

  private ensureProject(projectPath: string): string {
    const canonicalPath = canonicalProjectPath(projectPath);
    const projectId = projectIdFor(canonicalPath);
    this.state.connection
      .prepare(
        `INSERT INTO projects(project_id, canonical_path, created_at)
         VALUES (?, ?, ?) ON CONFLICT(project_id) DO NOTHING`,
      )
      .run(projectId, canonicalPath, Date.now());
    return projectId;
  }

  private findProject(projectPath: string): string | null {
    const row = this.state.connection
      .prepare("SELECT project_id AS projectId FROM projects WHERE canonical_path = ?")
      .get(canonicalProjectPath(projectPath));
    return isProjectRow(row) ? row.projectId : null;
  }

  private requireProjectId(): string {
    if (this.projectId === null)
      throw new Error("ResourceManager project is not registered in the state database");
    return this.projectId;
  }

  private resourceManagerRow(ref: ManagedResourceRef): ResourceManagerRow | undefined {
    if (this.projectId === null) return undefined;
    const row = this.state.connection
      .prepare(
        resourceManagerSelect(
          "WHERE c.project_id = ? AND c.controller_name = ? AND c.resource_key = ?",
        ),
      )
      .get(this.projectId, ref.resourceManager, ref.key);
    return isResourceManagerRow(row) ? row : undefined;
  }

  private requireResourceManagerRow(ref: ManagedResourceRef): ResourceManagerRow {
    const row = this.resourceManagerRow(ref);
    if (row === undefined) throw new ManagedResourceNotFoundError(ref.resourceManager, ref.key);
    return row;
  }

  private requireResourceManagerRowByUid(uid: string): ResourceManagerRow {
    const row = this.state.connection.prepare(resourceManagerSelect("WHERE c.uid = ?")).get(uid);
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isResourceManagerRow(row)) throw new Error(`Managed resource not found: ${uid}`);
    return row;
  }

  private requireResource(ref: ManagedResourceRef): ManagedResource {
    const resource = this.getResource(ref);
    if (resource === undefined)
      throw new ManagedResourceNotFoundError(ref.resourceManager, ref.key);
    return resource;
  }

  /* istanbul ignore next -- pure projection covered by integration tests */
  private mapManagedResource(row: ResourceManagerRow): ManagedResource {
    const spec = this.state.readJson(row.specHash);
    const status = this.state.readJson(row.statusHash) as ManagedResourceStatus<unknown>;
    return {
      metadata: {
        uid: row.uid,
        resourceManager: row.resourceManagerName,
        key: row.resourceKey,
        resourceVersion: row.resourceVersion,
        generation: row.generation,
        ...(row.deletionRequestedAt === null
          ? {}
          : { deletionTimestamp: new Date(row.deletionRequestedAt).toISOString() }),
        finalizers: this.finalizers(row.managedResourceId),
      },
      spec,
      status,
    };
  }

  private finalizers(managedResourceId: string): string[] {
    const rows = this.state.connection
      .prepare(
        "SELECT finalizer FROM controller_finalizers WHERE controller_resource_id = ? ORDER BY position",
      )
      .all(managedResourceId);
    return rows.flatMap((row) => (isFinalizerRow(row) ? [row.finalizer] : []));
  }

  private replaceFinalizers(managedResourceId: string, finalizers: string[]): void {
    const unique = [...new Set(finalizers)];
    if (unique.length !== finalizers.length)
      throw new Error("ResourceManager finalizers must be unique");
    this.state.connection
      .prepare("DELETE FROM controller_finalizers WHERE controller_resource_id = ?")
      .run(managedResourceId);
    const insert = this.state.connection.prepare(
      "INSERT INTO controller_finalizers(controller_resource_id, finalizer, position) VALUES (?, ?, ?)",
    );
    unique.forEach((finalizer, index) => insert.run(managedResourceId, finalizer, index));
  }

  private enqueueResourceManagerRow(
    managedResourceId: string,
    availableAt: number,
    now: number,
  ): void {
    this.state.connection
      .prepare(
        `INSERT INTO controller_queue(
           controller_resource_id, available_at, queue_version,
           consecutive_errors, created_at, updated_at
         ) VALUES (?, ?, 1, 0, ?, ?)
         ON CONFLICT(controller_resource_id) DO UPDATE SET
           available_at = MIN(controller_queue.available_at, excluded.available_at),
           queue_version = controller_queue.queue_version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(managedResourceId, availableAt, now, now);
  }

  private queueErrors(managedResourceId: string): number {
    const row = this.state.connection
      .prepare(
        "SELECT consecutive_errors AS consecutiveErrors FROM controller_queue WHERE controller_resource_id = ?",
      )
      .get(managedResourceId);
    return isErrorCountRow(row) ? row.consecutiveErrors : 0;
  }

  private queueVersion(managedResourceId: string): number {
    const row = this.state.connection
      .prepare(
        "SELECT queue_version AS queueVersion FROM controller_queue WHERE controller_resource_id = ?",
      )
      .get(managedResourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isQueueVersionRow(row)) throw new Error("ResourceManager queue item is missing");
    return row.queueVersion;
  }

  private settleResourceManagerClaim(
    claim: ResourceManagerQueueClaim,
    requeue: QueueRequeueOptions | undefined,
    nowValue?: string,
  ): boolean {
    const now = epoch(validTimestamp(nowValue));
    return this.state.transaction(() => {
      const row = this.resourceManagerRow({
        resourceManager: claim.resourceManager,
        key: claim.key,
      });
      if (row === undefined) return false;
      try {
        this.assertResourceManagerClaim(row, claim, now, false);
      } catch {
        return false;
      }
      const currentQueueVersion = this.queueVersion(row.managedResourceId);
      if (requeue === undefined) {
        if (currentQueueVersion === claim.queueVersion) {
          this.state.connection
            .prepare("DELETE FROM controller_queue WHERE controller_resource_id = ?")
            .run(row.managedResourceId);
        }
      } else {
        const errorHash =
          requeue.error === undefined ? null : this.state.putText(requeue.error, now);
        this.state.connection
          .prepare(
            `UPDATE controller_queue
             SET available_at = ?, queue_version = queue_version + 1,
                 consecutive_errors = consecutive_errors + 1,
                 last_error_hash = ?, updated_at = ? WHERE controller_resource_id = ?`,
          )
          .run(epoch(requeue.availableAt), errorHash, now, row.managedResourceId);
      }
      this.releaseLease(row.resourceId, claim, now);
      return true;
    });
  }

  private assertResourceManagerClaim(
    row: ResourceManagerRow,
    claim: ResourceManagerQueueClaim,
    now: number,
    requireUnexpired = true,
  ): void {
    if (row.resourceManagerName !== claim.resourceManager || row.resourceKey !== claim.key)
      throw new Error("ResourceManager claim targets another resource");
    const lease = this.requireLease(row.resourceId);
    if (
      lease.ownerType !== "controller" ||
      lease.ownerId !== claim.ownerId ||
      lease.generation !== claim.generation ||
      lease.tokenHash === null ||
      !lease.tokenHash.equals(tokenHash(claim.token)) ||
      (requireUnexpired && (lease.expiresAt === null || lease.expiresAt <= now))
    ) {
      throw new Error("ResourceManager claim is stale");
    }
  }

  private requireLease(resourceId: string): LeaseRow {
    const row = this.state.connection
      .prepare(
        `SELECT generation, owner_type AS ownerType, owner_id AS ownerId,
                token_hash AS tokenHash, expires_at AS expiresAt
         FROM leases WHERE resource_id = ?`,
      )
      .get(resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isLeaseRow(row)) throw new Error(`Lease is missing: ${resourceId}`);
    return row;
  }

  private releaseLease(resourceId: string, claim: ResourceManagerQueueClaim, now: number): void {
    const row = this.resourceManagerRow({ resourceManager: claim.resourceManager, key: claim.key });
    if (row === undefined) return;
    const revision = this.resourceRevision(resourceId);
    const result = this.state.connection
      .prepare(
        `UPDATE leases SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
                acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
         WHERE resource_id = ? AND owner_id = ? AND token_hash = ? AND generation = ?`,
      )
      .run(resourceId, claim.ownerId, tokenHash(claim.token), claim.generation);
    if (result.changes === 1) {
      this.bumpResource(resourceId, revision, now);
      this.insertEvent(
        resourceId,
        revision + 1,
        "lease.released",
        "controller",
        claim.ownerId,
        {},
        now,
        claim.generation,
      );
      claim.resourceVersion = revision + 1;
    }
  }

  private resourceRevision(resourceId: string): number {
    const row = this.state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isRevisionRow(row)) throw new Error(`Resource is missing: ${resourceId}`);
    return row.revision;
  }

  private bumpResource(resourceId: string, expectedRevision: number, now: number): void {
    const result = this.state.connection
      .prepare(
        "UPDATE resources SET revision = revision + 1, updated_at = ? WHERE resource_id = ? AND revision = ?",
      )
      .run(now, resourceId, expectedRevision);
    if (result.changes !== 1) throw new Error("Resource revision conflict");
    const run = this.state.connection
      .prepare(
        `SELECT r.run_id AS runId
         FROM runs r JOIN viewer_runs v ON v.run_id = r.run_id
         WHERE r.resource_id = ?`,
      )
      .get(resourceId);
    if (isRecord(run) && typeof run.runId === "string") {
      recordViewerDeltas(
        this.state,
        run.runId,
        [
          { targetType: "summary" },
          { targetType: "graph" },
          { targetType: "replay" },
          { targetType: "inspector", targetKey: "run" },
        ],
        now,
      );
    }
  }

  private insertEvent(
    resourceId: string,
    revision: number,
    type: string,
    actorType: string,
    actorId: string | null,
    payload: unknown,
    now: number,
    leaseGeneration?: number,
  ): string {
    const eventId = `event-${randomUUID()}`;
    const payloadHash = this.state.putJson(payload, now);
    this.state.connection
      .prepare(
        `INSERT INTO events(
           event_id, resource_id, resource_revision, event_type, actor_type,
           actor_id, lease_generation, payload_hash, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        resourceId,
        revision,
        type,
        actorType,
        actorId,
        leaseGeneration ?? null,
        payloadHash,
        now,
      );
    return eventId;
  }

  private effectRow(resourceUid: string, key: string): EffectRow | undefined {
    const row = this.state.connection
      .prepare(effectSelect("WHERE c.uid = ? AND e.idempotency_key = ?"))
      .get(resourceUid, key);
    return isEffectRow(row) ? row : undefined;
  }

  private requireEffectRow(resourceUid: string, key: string): EffectRow {
    const row = this.effectRow(resourceUid, key);
    if (row === undefined) throw new Error(`Effect record not found: ${resourceUid}/${key}`);
    return row;
  }

  /* istanbul ignore next -- pure projection covered by integration tests */
  private mapEffect(row: EffectRow): EffectRecord {
    return {
      key: this.effectKey(row.effectId),
      resourceUid: row.resourceUid,
      generation: row.generation,
      kind: row.kind,
      state: resourceManagerEffectState(row.state),
      requestFingerprint: row.requestFingerprint,
      startedAt: new Date(row.startedAt).toISOString(),
      ...(row.completedAt === null ? {} : { completedAt: new Date(row.completedAt).toISOString() }),
      ...(row.externalRef === null ? {} : { externalRef: row.externalRef }),
      ...(row.errorHash === null
        ? {}
        : { error: this.state.readBlob(row.errorHash)?.content.toString("utf8") ?? "" }),
    };
  }

  private effectKey(effectId: string): string {
    const row = this.state.connection
      .prepare("SELECT idempotency_key AS key FROM effects WHERE effect_id = ?")
      .get(effectId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isKeyRow(row)) throw new Error(`Effect is missing: ${effectId}`);
    return row.key;
  }

  private workflowRow(resourceUid: string, requestKey: string): WorkflowRow | undefined {
    const row = this.state.connection
      .prepare(workflowSelect("WHERE c.uid = ? AND w.request_key = ?"))
      .get(resourceUid, requestKey);
    return isWorkflowRow(row) ? row : undefined;
  }

  private workflowRowById(requestId: string): WorkflowRow | undefined {
    const row = this.state.connection
      .prepare(workflowSelect("WHERE w.request_id = ?"))
      .get(requestId);
    return isWorkflowRow(row) ? row : undefined;
  }

  private requireWorkflowRow(requestId: string): WorkflowRow {
    const row = this.workflowRowById(requestId);
    if (row === undefined) throw new Error(`Workflow request not found: ${requestId}`);
    return row;
  }

  /* istanbul ignore next -- pure projection covered by integration tests */
  private mapWorkflow(row: WorkflowRow): ChildWorkflowRecord {
    return {
      requestId: row.requestId,
      resourceUid: row.resourceUid,
      requestKey: row.requestKey,
      inputFingerprint: row.inputFingerprint.toString("hex"),
      workflow: row.workflowName,
      ...(row.runId === null ? {} : { runId: row.runId }),
      state: row.status,
      attempt: row.attemptCount,
      ...(row.errorHash === null
        ? {}
        : { error: this.state.readBlob(row.errorHash)?.content.toString("utf8") ?? "" }),
    };
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
      options.parentRunId === undefined ? null : (options.lineageKind ?? "continuation");
    const parent =
      options.parentRunId === undefined
        ? undefined
        : this.requireWorkflowRunRow(options.parentRunId);
    const expectedRootRunId = parent?.rootRunId ?? options.runId;
    const expectedRestartNumber =
      expectedLineageKind === "restart"
        ? (options.restartNumber ?? (parent?.restartNumber ?? -1) + 1)
        : (parent?.restartNumber ?? 0);
    const expectedParentTerminalFingerprint =
      options.parentTerminalFingerprint === undefined
        ? null
        : terminalFingerprintBuffer(options.parentTerminalFingerprint);
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
      ((row.parentTerminalFingerprint === null && expectedParentTerminalFingerprint === null) ||
        (row.parentTerminalFingerprint !== null &&
          expectedParentTerminalFingerprint !== null &&
          row.parentTerminalFingerprint.equals(expectedParentTerminalFingerprint)));
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
      affinityRunnerId: row.affinityRunnerId,
      originSessionId: row.executionMode === "headless" ? null : row.originSessionId,
      executionMode: row.executionMode,
      parentRunId: row.parentRunId,
      rootRunId: row.rootRunId,
      lineageKind: row.lineageKind,
      restartNumber: row.restartNumber,
      parentTerminalFingerprint: row.parentTerminalFingerprint?.toString("hex") ?? null,
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
        runnerId.startsWith("host-") ? "host" : "session",
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
      runnerId.startsWith("host-") ? "host" : "session",
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
      this.settleWorkflowRunMessages(runId, now);
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

  private settleWorkflowRunMessages(runId: string, now: number): void {
    this.workflowMessages.settleOpenTurnsForRun(runId, "lost", now);
    this.workflowMessages.cancelPendingForRun(runId, now);
  }

  private cancelWorkflowRunDependents(
    runId: string,
    actorId: string,
    errorHash: Buffer,
    now: number,
  ): void {
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

  private assertWritable(): void {
    if (this.state.mode === "read-only") throw new Error("ResourceManager store is read-only");
  }
}

function resourceManagerSelect(clause: string): string {
  return `SELECT c.controller_resource_id AS managedResourceId,
    c.resource_id AS resourceId, r.revision AS resourceVersion,
    c.controller_name AS resourceManagerName, c.resource_key AS resourceKey,
    c.uid, c.generation, c.spec_hash AS specHash, c.status_hash AS statusHash,
    c.deletion_requested_at AS deletionRequestedAt
    FROM controller_resources c JOIN resources r ON r.resource_id = c.resource_id ${clause}`;
}

function effectSelect(clause: string): string {
  return `SELECT e.effect_id AS effectId, c.uid AS resourceUid, c.generation,
    e.effect_type AS kind, e.status AS state,
    json_extract(CAST(b.content AS TEXT), '$.requestFingerprint') AS requestFingerprint,
    e.created_at AS startedAt, e.settled_at AS completedAt,
    e.external_ref AS externalRef, e.error_hash AS errorHash
    FROM effects e
    JOIN controller_resources c ON c.resource_id = e.source_resource_id
    JOIN blobs b ON b.blob_hash = e.payload_hash ${clause}`;
}

function workflowSelect(clause: string): string {
  return `SELECT w.request_id AS requestId, c.uid AS resourceUid,
    w.request_key AS requestKey, w.input_fingerprint AS inputFingerprint,
    w.workflow_name AS workflowName, COALESCE(w.run_id, w.reserved_run_id) AS runId, w.status,
    w.attempt_count AS attemptCount, w.error_hash AS errorHash
    FROM controller_workflows w
    JOIN controller_resources c ON c.controller_resource_id = w.controller_resource_id ${clause}`;
}

function workflowRunSelect(clause: string): string {
  return `SELECT r.run_id AS runId, r.resource_id AS resourceId,
    d.workflow_name AS workflowName, r.workflow_ref AS workflowRef, r.status AS runStatus,
    r.paused, r.definition_digest AS definitionDigest, d.definition_hash AS definitionHash,
    r.input_hash AS inputHash,
    r.launch_options_hash AS launchOptionsHash,
    q.status, q.available_at AS availableAt, q.affinity_runner_id AS affinityRunnerId,
    q.consecutive_errors AS consecutiveErrors, q.error_code AS errorCode,
    q.error_hash AS errorHash, b.origin_session_id AS originSessionId,
    b.execution_mode AS executionMode, r.parent_run_id AS parentRunId,
    r.root_run_id AS rootRunId, r.lineage_kind AS lineageKind,
    r.restart_number AS restartNumber,
    r.parent_terminal_fingerprint AS parentTerminalFingerprint,
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
    r.parent_terminal_fingerprint AS parentTerminalFingerprint,
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

type QueueListRow = {
  resourceManager: string;
  resourceKey: string;
  availableAt: number;
  consecutiveErrors: number;
  claimExpiresAt: number | null;
};
type ResourceManagerEventRow = {
  seq: number;
  recordedAt: number;
  resourceManager: string;
  resourceKey: string;
  eventType: string;
  payloadHash: Buffer | null;
};
type RunEventRow = {
  seq: number;
  recordedAt: number;
  runId: string;
  workflowRef: string;
  eventType: string;
  runnerId: string | null;
  payloadHash: Buffer | null;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isResourceManagerRow(value: unknown): value is ResourceManagerRow {
  return isRecord(value);
}
function isLeaseRow(value: unknown): value is LeaseRow {
  return isRecord(value);
}
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
    parentTerminalFingerprint: row.parentTerminalFingerprint?.toString("hex") ?? null,
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
    (value.lineageKind === null ||
      value.lineageKind === "continuation" ||
      value.lineageKind === "restart") &&
    typeof value.restartNumber === "number" &&
    (value.parentTerminalFingerprint === null ||
      Buffer.isBuffer(value.parentTerminalFingerprint)) &&
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
function isEffectRow(value: unknown): value is EffectRow {
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
function isWorkflowRow(value: unknown): value is WorkflowRow {
  return isRecord(value);
}
function isQueueListRow(value: unknown): value is QueueListRow {
  return isRecord(value);
}
function isResourceManagerEventRow(value: unknown): value is ResourceManagerEventRow {
  return isRecord(value);
}
function isRunEventRow(value: unknown): value is RunEventRow {
  return isRecord(value);
}
function isProjectRow(value: unknown): value is { projectId: string } {
  return isRecord(value);
}
function isCanonicalPathRow(value: unknown): value is { canonicalPath: string } {
  return isRecord(value) && typeof value.canonicalPath === "string";
}
function isFinalizerRow(value: unknown): value is { finalizer: string } {
  return isRecord(value);
}
function isErrorCountRow(value: unknown): value is { consecutiveErrors: number } {
  return isRecord(value);
}
function isQueueVersionRow(value: unknown): value is { queueVersion: number } {
  return isRecord(value);
}
function isRevisionRow(value: unknown): value is { revision: number } {
  return isRecord(value);
}
function isSequenceRow(value: unknown): value is { seq: number } {
  return isRecord(value);
}
function isKeyRow(value: unknown): value is { key: string } {
  return isRecord(value);
}
function isEffectIdentityRow(value: unknown): value is { effectId: string; resourceId: string } {
  return isRecord(value);
}

function effectIdFor(sourceResourceId: string, key: string): string {
  return `effect-${createHash("sha256").update(`${sourceResourceId}\0${key}`).digest("hex").slice(0, 40)}`;
}
function projectIdFor(canonicalPath: string): string {
  return `project-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 40)}`;
}
function canonicalProjectPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}
function digestBuffer(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("Expected a SHA-256 digest");
  return Buffer.from(hex, "hex");
}
function terminalFingerprintBuffer(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error("Expected a terminal fingerprint");
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

function effectStatus(value: EffectRecord["state"]): string {
  return value === "indeterminate" ? "ambiguous" : value;
}
function resourceManagerEffectState(value: string): EffectRecord["state"] {
  return value === "ambiguous" ? "indeterminate" : (value as EffectRecord["state"]);
}
function validTimestamp(value?: string): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp");
  return date.toISOString();
}
function epoch(value: string): number {
  return Date.parse(value);
}
function validateName(value: string, label: string): void {
  validateKey(value, label);
}
function validateKey(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} is invalid`);
}
function validateRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))
    throw new Error(`Invalid workflow run id: ${value}`);
}
