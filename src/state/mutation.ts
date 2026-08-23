import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { StateDatabase } from "./database.js";

export type ResourceType =
  | "run"
  | "session"
  | "decision"
  | "controller"
  | "effect"
  | "channel"
  | "notification"
  | "turn_intent";

export type ActorType =
  | "session"
  | "host"
  | "controller"
  | "channel"
  | "human"
  | "policy"
  | "control"
  | "system";

export type OwnerType = "session" | "host" | "controller" | "channel" | "system";

export type MutationActor = {
  type: ActorType;
  id?: string;
};

export type LeaseClaim = {
  resourceId: string;
  ownerType: OwnerType;
  ownerId: string;
  token: string;
  generation: number;
  expiresAt: number;
  resourceRevision: number;
};

export type WritePermit = {
  resourceId: string;
  operation: string;
  actor: MutationActor;
  expectedRevision: number;
  lease?: LeaseClaim;
};

export type MutationResult<T> = {
  value: T;
  revision: number;
  eventId: string;
};

export class StaleResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleResourceError";
  }
}

export class StateMutationStore {
  readonly state: StateDatabase;

  constructor(state: StateDatabase) {
    this.state = state;
  }

  ensureResource(type: ResourceType, aggregateKey: string, now: number = Date.now()): string {
    const resourceId = resourceIdFor(type, aggregateKey);
    this.state.connection
      .prepare(
        `INSERT INTO resources(resource_id, resource_type, aggregate_key, revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(resource_type, aggregate_key) DO NOTHING`,
      )
      .run(resourceId, type, aggregateKey, now, now);
    const row = this.state.connection
      .prepare(
        `SELECT resource_id AS resourceId, resource_type AS resourceType,
                aggregate_key AS aggregateKey
         FROM resources WHERE resource_id = ?`,
      )
      .get(resourceId);
    /* istanbul ignore if -- deterministic identity makes this a collision guard */
    if (
      !isResourceIdentity(row) ||
      row.resourceType !== type ||
      row.aggregateKey !== aggregateKey
    ) {
      throw new Error(`Resource identity conflict for ${type}:${aggregateKey}`);
    }
    this.state.connection
      .prepare(
        `INSERT INTO leases(resource_id, generation)
         VALUES (?, 0)
         ON CONFLICT(resource_id) DO NOTHING`,
      )
      .run(resourceId);
    return resourceId;
  }

  claim(options: {
    resourceId: string;
    ownerType: OwnerType;
    ownerId: string;
    expectedRevision: number;
    leaseMs: number;
    now?: number;
  }): LeaseClaim | undefined {
    const now = options.now ?? Date.now();
    if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new Error("Lease duration must be a positive integer");
    }
    return this.state.transaction(() => {
      const resource = requireResource(this.state.connection, options.resourceId);
      if (resource.revision !== options.expectedRevision) {
        throw new StaleResourceError("Resource revision changed before ownership claim");
      }
      const lease = requireLease(this.state.connection, options.resourceId);
      if (lease.ownerId !== null && lease.expiresAt !== null && lease.expiresAt > now) {
        return undefined;
      }
      const generation = lease.generation + 1;
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now + options.leaseMs;
      const nextRevision = resource.revision + 1;
      this.state.connection
        .prepare(
          `UPDATE leases
           SET generation = ?, owner_type = ?, owner_id = ?, token_hash = ?,
               acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND generation = ?`,
        )
        .run(
          generation,
          options.ownerType,
          options.ownerId,
          tokenHash(token),
          now,
          now,
          expiresAt,
          options.resourceId,
          lease.generation,
        );
      updateResourceRevision(this.state.connection, options.resourceId, resource.revision, now);
      insertEvent(this.state, {
        resourceId: options.resourceId,
        revision: nextRevision,
        type: "lease.claimed",
        actor: { type: options.ownerType, id: options.ownerId },
        leaseGeneration: generation,
        payload: { expiresAt, ownerType: options.ownerType },
        now,
      });
      return {
        resourceId: options.resourceId,
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        token,
        generation,
        expiresAt,
        resourceRevision: nextRevision,
      };
    });
  }

  renew(
    claim: LeaseClaim,
    expectedRevision: number,
    leaseMs: number,
    now: number = Date.now(),
  ): LeaseClaim {
    return this.state.transaction(() => {
      const resource = requireResource(this.state.connection, claim.resourceId);
      if (resource.revision !== expectedRevision) {
        throw new StaleResourceError("Resource revision changed before lease renewal");
      }
      requireCurrentLease(this.state.connection, claim, now);
      const expiresAt = now + leaseMs;
      const nextRevision = resource.revision + 1;
      const update = this.state.connection
        .prepare(
          `UPDATE leases SET heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND owner_type = ? AND owner_id = ?
             AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(
          now,
          expiresAt,
          claim.resourceId,
          claim.ownerType,
          claim.ownerId,
          tokenHash(claim.token),
          claim.generation,
          now,
        );
      /* istanbul ignore if -- BEGIN IMMEDIATE keeps this compare stable */
      if (update.changes !== 1) {
        throw new StaleResourceError("Lease is no longer current");
      }
      updateResourceRevision(this.state.connection, claim.resourceId, resource.revision, now);
      insertEvent(this.state, {
        resourceId: claim.resourceId,
        revision: nextRevision,
        type: "lease.renewed",
        actor: { type: claim.ownerType, id: claim.ownerId },
        leaseGeneration: claim.generation,
        payload: { expiresAt },
        now,
      });
      return { ...claim, expiresAt, resourceRevision: nextRevision };
    });
  }

  release(claim: LeaseClaim, expectedRevision: number, now: number = Date.now()): number {
    return this.state.transaction(() => {
      const resource = requireResource(this.state.connection, claim.resourceId);
      if (resource.revision !== expectedRevision) {
        throw new StaleResourceError("Resource revision changed before lease release");
      }
      requireCurrentLease(this.state.connection, claim, now, false);
      const update = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND owner_type = ? AND owner_id = ?
             AND token_hash = ? AND generation = ?`,
        )
        .run(
          claim.resourceId,
          claim.ownerType,
          claim.ownerId,
          tokenHash(claim.token),
          claim.generation,
        );
      /* istanbul ignore if -- BEGIN IMMEDIATE keeps this compare stable */
      if (update.changes !== 1) {
        throw new StaleResourceError("Lease is no longer current");
      }
      const nextRevision = resource.revision + 1;
      updateResourceRevision(this.state.connection, claim.resourceId, resource.revision, now);
      insertEvent(this.state, {
        resourceId: claim.resourceId,
        revision: nextRevision,
        type: "lease.released",
        actor: { type: claim.ownerType, id: claim.ownerId },
        leaseGeneration: claim.generation,
        now,
      });
      return nextRevision;
    });
  }

  mutate<T>(
    permit: WritePermit,
    eventType: string,
    apply: (context: { database: StateDatabase; nextRevision: number; now: number }) => T,
    options: { payload?: unknown; now?: number } = {},
  ): MutationResult<T> {
    const now = options.now ?? Date.now();
    return this.state.transaction(() => {
      const resource = requireResource(this.state.connection, permit.resourceId);
      if (resource.revision !== permit.expectedRevision) {
        throw new StaleResourceError("Resource revision changed before mutation");
      }
      if (permit.lease !== undefined) {
        if (permit.lease.resourceId !== permit.resourceId) {
          throw new StaleResourceError("Lease does not belong to the mutation resource");
        }
        requireCurrentLease(this.state.connection, permit.lease, now);
      }
      const nextRevision = resource.revision + 1;
      const value = apply({ database: this.state, nextRevision, now });
      updateResourceRevision(this.state.connection, permit.resourceId, resource.revision, now);
      const eventId = insertEvent(this.state, {
        resourceId: permit.resourceId,
        revision: nextRevision,
        type: eventType,
        actor: permit.actor,
        ...(permit.lease !== undefined ? { leaseGeneration: permit.lease.generation } : {}),
        ...(options.payload !== undefined ? { payload: options.payload } : {}),
        now,
      });
      return { value, revision: nextRevision, eventId };
    });
  }
}

export function resourceIdFor(type: ResourceType, aggregateKey: string): string {
  const digest = createHash("sha256").update(`${type}\0${aggregateKey}`).digest("hex").slice(0, 40);
  return `${type}-${digest}`;
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

type ResourceRow = { revision: number };
type ResourceIdentityRow = { resourceId: string; resourceType: string; aggregateKey: string };
type LeaseRow = {
  generation: number;
  ownerType: string | null;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
};

function requireResource(database: Database.Database, resourceId: string): ResourceRow {
  const row = database
    .prepare("SELECT revision FROM resources WHERE resource_id = ?")
    .get(resourceId);
  if (!isResourceRow(row)) {
    throw new Error(`Unknown resource: ${resourceId}`);
  }
  return row;
}

function requireLease(database: Database.Database, resourceId: string): LeaseRow {
  const row = database
    .prepare(
      `SELECT generation, owner_type AS ownerType, owner_id AS ownerId,
              token_hash AS tokenHash, expires_at AS expiresAt
       FROM leases WHERE resource_id = ?`,
    )
    .get(resourceId);
  /* istanbul ignore if -- every resource transaction creates its lease row */
  if (!isLeaseRow(row)) {
    throw new Error(`Resource has no lease row: ${resourceId}`);
  }
  return row;
}

function requireCurrentLease(
  database: Database.Database,
  claim: LeaseClaim,
  now: number,
  requireUnexpired: boolean = true,
): void {
  const lease = requireLease(database, claim.resourceId);
  if (
    lease.ownerType !== claim.ownerType ||
    lease.ownerId !== claim.ownerId ||
    lease.generation !== claim.generation ||
    lease.tokenHash === null ||
    !lease.tokenHash.equals(tokenHash(claim.token)) ||
    (requireUnexpired && (lease.expiresAt === null || lease.expiresAt <= now))
  ) {
    throw new StaleResourceError("Lease is no longer current");
  }
}

function updateResourceRevision(
  database: Database.Database,
  resourceId: string,
  expectedRevision: number,
  now: number,
): void {
  const update = database
    .prepare(
      `UPDATE resources SET revision = revision + 1, updated_at = ?
       WHERE resource_id = ? AND revision = ?`,
    )
    .run(now, resourceId, expectedRevision);
  /* istanbul ignore if -- revision was checked under BEGIN IMMEDIATE */
  if (update.changes !== 1) {
    throw new StaleResourceError("Resource revision changed during mutation");
  }
}

function insertEvent(
  state: StateDatabase,
  options: {
    resourceId: string;
    revision: number;
    type: string;
    actor: MutationActor;
    leaseGeneration?: number;
    payload?: unknown;
    now: number;
  },
): string {
  const eventId = `event-${randomUUID()}`;
  const payloadHash =
    options.payload === undefined ? null : state.putJson(options.payload, options.now);
  state.connection
    .prepare(
      `INSERT INTO events(
         event_id, resource_id, resource_revision, event_type,
         actor_type, actor_id, lease_generation, payload_hash, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      options.resourceId,
      options.revision,
      options.type,
      options.actor.type,
      options.actor.id ?? null,
      options.leaseGeneration ?? null,
      payloadHash,
      options.now,
    );
  return eventId;
}

function isResourceRow(value: unknown): value is ResourceRow {
  return isRecord(value) && typeof value.revision === "number";
}

function isResourceIdentity(value: unknown): value is ResourceIdentityRow {
  return (
    isRecord(value) &&
    typeof value.resourceId === "string" &&
    typeof value.resourceType === "string" &&
    typeof value.aggregateKey === "string"
  );
}

function isLeaseRow(value: unknown): value is LeaseRow {
  return (
    isRecord(value) &&
    typeof value.generation === "number" &&
    (typeof value.ownerType === "string" || value.ownerType === null) &&
    (typeof value.ownerId === "string" || value.ownerId === null) &&
    (Buffer.isBuffer(value.tokenHash) || value.tokenHash === null) &&
    (typeof value.expiresAt === "number" || value.expiresAt === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
