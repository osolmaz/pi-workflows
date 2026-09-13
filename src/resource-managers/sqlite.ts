import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resourceIdFor, tokenHash } from "../state/mutation.js";
import {
  ProjectStore,
  isRecord,
  validTimestamp,
  epoch,
  isSequenceRow,
} from "../state/project-store.js";
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

function resourceManagerSelect(clause: string): string {
  return `SELECT c.managed_resource_id AS managedResourceId,
    c.resource_id AS resourceId, r.revision AS resourceVersion,
    c.resource_manager_name AS resourceManagerName, c.resource_key AS resourceKey,
    c.uid, c.generation, c.spec_hash AS specHash, c.status_hash AS statusHash,
    c.deletion_requested_at AS deletionRequestedAt
    FROM managed_resources c JOIN resources r ON r.resource_id = c.resource_id ${clause}`;
}

function effectSelect(clause: string): string {
  return `SELECT e.effect_id AS effectId, c.uid AS resourceUid, c.generation,
    e.effect_type AS kind, e.status AS state,
    json_extract(CAST(b.content AS TEXT), '$.requestFingerprint') AS requestFingerprint,
    e.created_at AS startedAt, e.settled_at AS completedAt,
    e.external_ref AS externalRef, e.error_hash AS errorHash
    FROM effects e
    JOIN managed_resources c ON c.resource_id = e.source_resource_id
    JOIN blobs b ON b.blob_hash = e.payload_hash ${clause}`;
}

function workflowSelect(clause: string): string {
  return `SELECT w.request_id AS requestId, c.uid AS resourceUid,
    w.request_key AS requestKey, w.input_fingerprint AS inputFingerprint,
    w.workflow_name AS workflowName, COALESCE(w.run_id, w.reserved_run_id) AS runId, w.status,
    w.attempt_count AS attemptCount, w.error_hash AS errorHash
    FROM managed_resource_workflows w
    JOIN managed_resources c ON c.managed_resource_id = w.managed_resource_id ${clause}`;
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

function isResourceManagerRow(value: unknown): value is ResourceManagerRow {
  return isRecord(value);
}

function isEffectRow(value: unknown): value is EffectRow {
  return isRecord(value);
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

function isFinalizerRow(value: unknown): value is { finalizer: string } {
  return isRecord(value);
}

function isErrorCountRow(value: unknown): value is { consecutiveErrors: number } {
  return isRecord(value);
}

function isQueueVersionRow(value: unknown): value is { queueVersion: number } {
  return isRecord(value);
}

function isKeyRow(value: unknown): value is { key: string } {
  return isRecord(value);
}

function effectIdFor(sourceResourceId: string, key: string): string {
  return `effect-${createHash("sha256").update(`${sourceResourceId}\0${key}`).digest("hex").slice(0, 40)}`;
}

function effectStatus(value: EffectRecord["state"]): string {
  return value === "indeterminate" ? "ambiguous" : value;
}

function resourceManagerEffectState(value: string): EffectRecord["state"] {
  return value === "ambiguous" ? "indeterminate" : (value as EffectRecord["state"]);
}

function validateName(value: string, label: string): void {
  validateKey(value, label);
}

function validateKey(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} is invalid`);
}

export class SqliteResourceManagerStore extends ProjectStore implements ResourceManagerStore {
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
        const managedResourceId = `managed-resource-${randomUUID()}`;
        const resourceId = resourceIdFor(
          "managed_resource",
          `${this.requireProjectId()}:${options.resourceManager}:${options.key}`,
        );
        this.state.connection
          .prepare(
            `INSERT INTO resources(
               resource_id, resource_type, aggregate_key, revision, created_at, updated_at
             ) VALUES (?, 'managed_resource', ?, 1, ?, ?)`,
          )
          .run(resourceId, managedResourceId, now, now);
        this.state.connection
          .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
          .run(resourceId);
        this.state.connection
          .prepare(
            `INSERT INTO managed_resources(
               managed_resource_id, resource_id, project_id, resource_manager_name,
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
            `UPDATE managed_resources
             SET spec_hash = ?, generation = generation + 1, updated_at = ?
             WHERE managed_resource_id = ?`,
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
      clauses.push("c.resource_manager_name = ?");
      params.push(options.resourceManager);
    }
    const rows = this.state.connection
      .prepare(
        resourceManagerSelect(
          `WHERE ${clauses.join(" AND ")} ORDER BY c.resource_manager_name, c.resource_key`,
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
          "UPDATE managed_resources SET status_hash = ?, updated_at = ? WHERE managed_resource_id = ?",
        )
        .run(statusHash, now, row.managedResourceId);
      if (options.finalizers !== undefined)
        this.replaceFinalizers(row.managedResourceId, options.finalizers);
      this.bumpResource(row.resourceId, row.resourceVersion, now);
      this.insertEvent(
        row.resourceId,
        row.resourceVersion + 1,
        "resource.status_updated",
        "resource_manager",
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
            "UPDATE managed_resources SET deletion_requested_at = ?, updated_at = ? WHERE managed_resource_id = ?",
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
        .prepare("UPDATE managed_resources SET updated_at = ? WHERE managed_resource_id = ?")
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
        .prepare("DELETE FROM managed_resources WHERE managed_resource_id = ?")
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
      .map(() => "AND NOT (c.resource_manager_name = ? AND c.resource_key = ?)")
      .join("\n               ");
    const exclusionParams = exclusions.flatMap((ref) => [ref.resourceManager, ref.key]);
    return this.state.transaction(() => {
      const row = this.state.connection
        .prepare(
          `${resourceManagerSelect(`
             JOIN managed_resource_queue q ON q.managed_resource_id = c.managed_resource_id
             JOIN leases l ON l.resource_id = c.resource_id
             WHERE c.project_id = ?
               AND c.resource_manager_name IN (${placeholders})
               ${exclusionSql}
               AND q.available_at <= ?
               AND (l.owner_id IS NULL OR l.expires_at <= ?)
             ORDER BY q.available_at, c.resource_manager_name, c.resource_key
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
           SET generation = ?, owner_type = 'resource_manager', owner_id = ?, token_hash = ?,
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
        "resource_manager",
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
         WHERE resource_id = ? AND owner_type = 'resource_manager' AND owner_id = ?
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
        `SELECT c.resource_manager_name AS resourceManager, c.resource_key AS resourceKey,
                q.available_at AS availableAt, q.consecutive_errors AS consecutiveErrors,
                l.expires_at AS claimExpiresAt
         FROM managed_resource_queue q
         JOIN managed_resources c ON c.managed_resource_id = q.managed_resource_id
         JOIN leases l ON l.resource_id = c.resource_id
         WHERE c.project_id = ? ORDER BY q.available_at, c.resource_manager_name, c.resource_key`,
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
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resource_manager', 'pending', 0, ?, ?)`,
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
        "resource_manager",
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
        "resource_manager",
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
          `INSERT INTO managed_resource_workflows(
             request_id, managed_resource_id, request_key, workflow_name,
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
          `UPDATE managed_resource_workflows
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
          `UPDATE managed_resource_workflows
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
        options.claim === undefined ? "control" : "resource_manager",
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
    const clauses = ["r.resource_type = 'managed_resource'"];
    const params: unknown[] = [];
    if (this.projectId !== null) {
      clauses.push("c.project_id = ?");
      params.push(this.projectId);
    }
    if (options.resourceManager !== undefined) {
      clauses.push("c.resource_manager_name = ?");
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
                c.resource_manager_name AS resourceManager, c.resource_key AS resourceKey,
                e.event_type AS eventType, e.payload_hash AS payloadHash
         FROM events e
         JOIN resources r ON r.resource_id = e.resource_id
         JOIN managed_resources c ON c.resource_id = r.resource_id
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

  private resourceManagerRow(ref: ManagedResourceRef): ResourceManagerRow | undefined {
    if (this.projectId === null) return undefined;
    const row = this.state.connection
      .prepare(
        resourceManagerSelect(
          "WHERE c.project_id = ? AND c.resource_manager_name = ? AND c.resource_key = ?",
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
        "SELECT finalizer FROM managed_resource_finalizers WHERE managed_resource_id = ? ORDER BY position",
      )
      .all(managedResourceId);
    return rows.flatMap((row) => (isFinalizerRow(row) ? [row.finalizer] : []));
  }

  private replaceFinalizers(managedResourceId: string, finalizers: string[]): void {
    const unique = [...new Set(finalizers)];
    if (unique.length !== finalizers.length)
      throw new Error("ResourceManager finalizers must be unique");
    this.state.connection
      .prepare("DELETE FROM managed_resource_finalizers WHERE managed_resource_id = ?")
      .run(managedResourceId);
    const insert = this.state.connection.prepare(
      "INSERT INTO managed_resource_finalizers(managed_resource_id, finalizer, position) VALUES (?, ?, ?)",
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
        `INSERT INTO managed_resource_queue(
           managed_resource_id, available_at, queue_version,
           consecutive_errors, created_at, updated_at
         ) VALUES (?, ?, 1, 0, ?, ?)
         ON CONFLICT(managed_resource_id) DO UPDATE SET
           available_at = MIN(managed_resource_queue.available_at, excluded.available_at),
           queue_version = managed_resource_queue.queue_version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(managedResourceId, availableAt, now, now);
  }

  private queueErrors(managedResourceId: string): number {
    const row = this.state.connection
      .prepare(
        "SELECT consecutive_errors AS consecutiveErrors FROM managed_resource_queue WHERE managed_resource_id = ?",
      )
      .get(managedResourceId);
    return isErrorCountRow(row) ? row.consecutiveErrors : 0;
  }

  private queueVersion(managedResourceId: string): number {
    const row = this.state.connection
      .prepare(
        "SELECT queue_version AS queueVersion FROM managed_resource_queue WHERE managed_resource_id = ?",
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
            .prepare("DELETE FROM managed_resource_queue WHERE managed_resource_id = ?")
            .run(row.managedResourceId);
        }
      } else {
        const errorHash =
          requeue.error === undefined ? null : this.state.putText(requeue.error, now);
        this.state.connection
          .prepare(
            `UPDATE managed_resource_queue
             SET available_at = ?, queue_version = queue_version + 1,
                 consecutive_errors = consecutive_errors + 1,
                 last_error_hash = ?, updated_at = ? WHERE managed_resource_id = ?`,
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
      lease.ownerType !== "resource_manager" ||
      lease.ownerId !== claim.ownerId ||
      lease.generation !== claim.generation ||
      lease.tokenHash === null ||
      !lease.tokenHash.equals(tokenHash(claim.token)) ||
      (requireUnexpired && (lease.expiresAt === null || lease.expiresAt <= now))
    ) {
      throw new Error("ResourceManager claim is stale");
    }
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
        "resource_manager",
        claim.ownerId,
        {},
        now,
        claim.generation,
      );
      claim.resourceVersion = revision + 1;
    }
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
}
