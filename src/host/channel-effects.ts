import { createHash } from "node:crypto";
import { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { StateMutationStore } from "../state/mutation.js";
import type { HumanDecisionChannelRequest } from "../workflows/types.js";

export type ChannelEffectPurpose = "delivery" | "settlement";
export type ChannelEffectStatus =
  | "pending"
  | "applying"
  | "applied"
  | "rejected"
  | "ambiguous"
  | "cancelled";

export type ChannelEffectPayload = {
  schema: "pi-workflows.channel-effect.v1";
  channelId: string;
  profile: string;
  decisionId: string;
  purpose: ChannelEffectPurpose;
  request: HumanDecisionChannelRequest;
};

export type ChannelEffectRecord = {
  effectId: string;
  resourceId: string;
  sourceResourceId: string;
  status: ChannelEffectStatus;
  attemptNumber: number;
  attemptStartedAt: number;
  settledAt?: number;
  payload: ChannelEffectPayload;
  result?: JsonValue;
};

type EffectRow = {
  effectId: string;
  resourceId: string;
  sourceResourceId: string;
  status: ChannelEffectStatus;
  attemptNumber: number;
  attemptStartedAt: number;
  settledAt: number | null;
  payloadHash: Buffer;
  resultHash: Buffer | null;
};

export class ChannelEffectStore {
  private readonly mutations: StateMutationStore;

  constructor(private readonly state: StateDatabase) {
    this.mutations = new StateMutationStore(state);
  }

  ensureApplying(options: {
    channelResourceId: string;
    channelId: string;
    profile: string;
    decisionId: string;
    purpose: ChannelEffectPurpose;
    request: HumanDecisionChannelRequest;
    ownerId: string;
    leaseGeneration: number;
    maxAutomaticAttempts: number;
  }): ChannelEffectRecord {
    const effectId = channelEffectId(
      options.channelId,
      options.decisionId,
      options.request.requestDigest,
      options.purpose,
    );
    const existing = this.read(effectId);
    if (existing !== undefined) {
      if (existing.status === "rejected" && existing.attemptNumber < options.maxAutomaticAttempts) {
        return this.beginAttempt(
          existing,
          options.ownerId,
          options.leaseGeneration,
          "automatic",
          options.ownerId,
        );
      }
      return existing;
    }
    const payload: ChannelEffectPayload = {
      schema: "pi-workflows.channel-effect.v1",
      channelId: options.channelId,
      profile: options.profile,
      decisionId: options.decisionId,
      purpose: options.purpose,
      request: options.request,
    };
    const now = Date.now();
    const payloadHash = this.state.putJson(payload, now);
    const sourceRevision = this.resourceRevision(options.channelResourceId);
    const resourceId = this.mutations.ensureResource("effect", effectId, now);
    this.mutations.mutate(
      {
        resourceId,
        operation: "channel.effect.create",
        actor: { type: "host", id: options.ownerId },
        expectedRevision: 0,
      },
      "effect.applying",
      () => {
        this.state.connection
          .prepare(
            `INSERT INTO effects(
               effect_id, resource_id, source_resource_id, source_revision,
               effect_type, idempotency_key, payload_hash, owner_scope,
               status, attempt_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'channel', 'applying', 1, ?, ?)`,
          )
          .run(
            effectId,
            resourceId,
            options.channelResourceId,
            sourceRevision,
            `channel.${options.purpose}`,
            effectId,
            payloadHash,
            now,
            now,
          );
        this.insertAttempt(effectId, 1, options.ownerId, options.leaseGeneration, now);
      },
      { now, payload: { channelId: options.channelId, decisionId: options.decisionId } },
    );
    return this.require(effectId);
  }

  settle(options: {
    effectId: string;
    attemptNumber: number;
    outcome: "applied" | "rejected" | "ambiguous";
    result?: JsonValue;
    error?: string;
    actorType: "channel" | "human";
    actorId: string;
  }): ChannelEffectRecord {
    const current = this.require(options.effectId);
    if (current.status !== "applying" || current.attemptNumber !== options.attemptNumber) {
      throw new Error("Channel effect attempt is stale");
    }
    const now = Date.now();
    const resultHash =
      options.result === undefined ? null : this.state.putJson(options.result, now);
    const errorHash = options.error === undefined ? null : this.state.putText(options.error, now);
    this.mutations.mutate(
      {
        resourceId: current.resourceId,
        operation: "channel.effect.settle",
        actor: { type: options.actorType, id: options.actorId },
        expectedRevision: this.resourceRevision(current.resourceId),
      },
      `effect.${options.outcome}`,
      () => {
        const changed = this.state.connection
          .prepare(
            `UPDATE effects
             SET status = ?, result_hash = ?, error_hash = ?, updated_at = ?, settled_at = ?
             WHERE effect_id = ? AND status = 'applying' AND attempt_count = ?`,
          )
          .run(
            options.outcome,
            resultHash,
            errorHash,
            now,
            now,
            options.effectId,
            options.attemptNumber,
          );
        if (changed.changes !== 1) throw new Error("Channel effect attempt changed");
        this.state.connection
          .prepare(
            `UPDATE effect_attempts
             SET finished_at = ?, outcome = ?, result_hash = ?, error_hash = ?
             WHERE effect_id = ? AND attempt_number = ? AND finished_at IS NULL`,
          )
          .run(
            now,
            options.outcome,
            resultHash,
            errorHash,
            options.effectId,
            options.attemptNumber,
          );
      },
      { now, payload: { attemptNumber: options.attemptNumber } },
    );
    return this.require(options.effectId);
  }

  markApplyingAmbiguous(options: {
    sourceResourceId?: string;
    stableMessageIds?: readonly string[];
    error: string;
    actorId: string;
  }): ChannelEffectRecord[] {
    const rows = this.state.connection
      .prepare(
        `SELECT effect_id AS effectId
         FROM effects
         WHERE owner_scope = 'channel' AND status = 'applying'
           AND (? IS NULL OR source_resource_id = ?)
         ORDER BY created_at`,
      )
      .all(options.sourceResourceId ?? null, options.sourceResourceId ?? null);
    const settled: ChannelEffectRecord[] = [];
    for (const row of rows) {
      if (!isEffectIdRow(row)) continue;
      const current = this.require(row.effectId);
      if (
        options.stableMessageIds !== undefined &&
        !options.stableMessageIds.includes(
          channelEffectAttemptId(current.effectId, current.attemptNumber),
        )
      ) {
        continue;
      }
      settled.push(
        this.settle({
          effectId: current.effectId,
          attemptNumber: current.attemptNumber,
          outcome: "ambiguous",
          error: options.error,
          actorType: "channel",
          actorId: options.actorId,
        }),
      );
    }
    return settled;
  }

  recover(options: {
    stableMessageId: string;
    action: "confirm" | "retry";
    actorId: string;
    ownerId: string;
    leaseGeneration: number;
  }): ChannelEffectRecord {
    const current = this.listAmbiguous().find(
      (effect) =>
        channelEffectAttemptId(effect.effectId, effect.attemptNumber) === options.stableMessageId,
    );
    if (current === undefined) throw new Error("Ambiguous channel operation was not found");
    if (options.action === "confirm") {
      return this.confirmAmbiguous(current, options.actorId);
    }
    return this.beginAttempt(
      current,
      options.ownerId,
      options.leaseGeneration,
      "explicit",
      options.actorId,
    );
  }

  read(effectId: string): ChannelEffectRecord | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT e.effect_id AS effectId, e.resource_id AS resourceId,
                e.source_resource_id AS sourceResourceId, e.status,
                e.attempt_count AS attemptNumber, a.started_at AS attemptStartedAt,
                e.settled_at AS settledAt, e.payload_hash AS payloadHash,
                e.result_hash AS resultHash
         FROM effects e JOIN effect_attempts a
           ON a.effect_id = e.effect_id AND a.attempt_number = e.attempt_count
         WHERE e.effect_id = ? AND e.owner_scope = 'channel'`,
      )
      .get(effectId);
    return isEffectRow(row) ? this.materialize(row) : undefined;
  }

  listAmbiguous(): ChannelEffectRecord[] {
    return this.state.connection
      .prepare(
        `SELECT e.effect_id AS effectId, e.resource_id AS resourceId,
                e.source_resource_id AS sourceResourceId, e.status,
                e.attempt_count AS attemptNumber, a.started_at AS attemptStartedAt,
                e.settled_at AS settledAt, e.payload_hash AS payloadHash,
                e.result_hash AS resultHash
         FROM effects e JOIN effect_attempts a
           ON a.effect_id = e.effect_id AND a.attempt_number = e.attempt_count
         WHERE e.owner_scope = 'channel' AND e.status = 'ambiguous'
         ORDER BY e.created_at`,
      )
      .all()
      .filter(isEffectRow)
      .map((row) => this.materialize(row));
  }

  private confirmAmbiguous(current: ChannelEffectRecord, actorId: string): ChannelEffectRecord {
    const now = Date.now();
    this.mutations.mutate(
      {
        resourceId: current.resourceId,
        operation: "channel.effect.confirm",
        actor: { type: "human", id: actorId },
        expectedRevision: this.resourceRevision(current.resourceId),
      },
      "effect.recovered_confirmed",
      () => {
        const changed = this.state.connection
          .prepare(
            `UPDATE effects SET status = 'applied', updated_at = ?, settled_at = ?
             WHERE effect_id = ? AND status = 'ambiguous' AND attempt_count = ?`,
          )
          .run(now, now, current.effectId, current.attemptNumber);
        if (changed.changes !== 1) throw new Error("Channel effect recovery is stale");
      },
      { now, payload: { attemptNumber: current.attemptNumber } },
    );
    return this.require(current.effectId);
  }

  private beginAttempt(
    current: ChannelEffectRecord,
    ownerId: string,
    leaseGeneration: number,
    reason: "automatic" | "explicit",
    actorId: string,
  ): ChannelEffectRecord {
    if (current.status !== "rejected" && current.status !== "ambiguous") {
      throw new Error("Channel effect is not retryable");
    }
    const attemptNumber = current.attemptNumber + 1;
    const now = Date.now();
    this.mutations.mutate(
      {
        resourceId: current.resourceId,
        operation: "channel.effect.retry",
        actor: { type: reason === "explicit" ? "human" : "host", id: actorId },
        expectedRevision: this.resourceRevision(current.resourceId),
      },
      "effect.applying",
      () => {
        const changed = this.state.connection
          .prepare(
            `UPDATE effects
             SET status = 'applying', attempt_count = ?, result_hash = NULL,
                 error_hash = NULL, updated_at = ?, settled_at = NULL
             WHERE effect_id = ? AND status = ? AND attempt_count = ?`,
          )
          .run(attemptNumber, now, current.effectId, current.status, current.attemptNumber);
        if (changed.changes !== 1) throw new Error("Channel effect retry is stale");
        this.insertAttempt(current.effectId, attemptNumber, ownerId, leaseGeneration, now);
      },
      { now, payload: { attemptNumber, reason } },
    );
    return this.require(current.effectId);
  }

  private insertAttempt(
    effectId: string,
    attemptNumber: number,
    ownerId: string,
    leaseGeneration: number,
    now: number,
  ): void {
    this.state.connection
      .prepare(
        `INSERT INTO effect_attempts(
           effect_id, attempt_number, owner_id, lease_generation, started_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(effectId, attemptNumber, ownerId, leaseGeneration, now);
  }

  private require(effectId: string): ChannelEffectRecord {
    const value = this.read(effectId);
    if (value === undefined) throw new Error(`Channel effect is missing: ${effectId}`);
    return value;
  }

  private materialize(row: EffectRow): ChannelEffectRecord {
    const payload = this.state.readJson(row.payloadHash);
    if (!isChannelEffectPayload(payload)) throw new Error("Channel effect payload is invalid");
    return {
      effectId: row.effectId,
      resourceId: row.resourceId,
      sourceResourceId: row.sourceResourceId,
      status: row.status,
      attemptNumber: row.attemptNumber,
      attemptStartedAt: row.attemptStartedAt,
      ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
      payload,
      ...(row.resultHash === null ? {} : { result: this.state.readJson(row.resultHash) }),
    };
  }

  private resourceRevision(resourceId: string): number {
    const row = this.state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(resourceId);
    if (!isRevisionRow(row)) throw new Error(`Resource is missing: ${resourceId}`);
    return row.revision;
  }
}

export function channelEffectId(
  channelId: string,
  decisionId: string,
  requestDigest: string,
  purpose: ChannelEffectPurpose,
): string {
  return `effect-${createHash("sha256")
    .update(canonicalJson({ channelId, decisionId, requestDigest, purpose }))
    .digest("hex")
    .slice(0, 40)}`;
}

export function channelEffectAttemptId(effectId: string, attemptNumber: number): string {
  return `channel-${createHash("sha256").update(`${effectId}\0${attemptNumber}`).digest("hex")}`;
}

function isChannelEffectPayload(value: unknown): value is ChannelEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<ChannelEffectPayload>;
  return (
    payload.schema === "pi-workflows.channel-effect.v1" &&
    typeof payload.channelId === "string" &&
    typeof payload.profile === "string" &&
    typeof payload.decisionId === "string" &&
    (payload.purpose === "delivery" || payload.purpose === "settlement") &&
    payload.request !== null &&
    typeof payload.request === "object"
  );
}

function isEffectRow(value: unknown): value is EffectRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<EffectRow>;
  return (
    typeof row.effectId === "string" &&
    typeof row.resourceId === "string" &&
    typeof row.sourceResourceId === "string" &&
    typeof row.status === "string" &&
    ["pending", "applying", "applied", "rejected", "ambiguous", "cancelled"].includes(row.status) &&
    typeof row.attemptNumber === "number" &&
    typeof row.attemptStartedAt === "number" &&
    (row.settledAt === null || typeof row.settledAt === "number") &&
    Buffer.isBuffer(row.payloadHash) &&
    (row.resultHash === null || Buffer.isBuffer(row.resultHash))
  );
}

function isEffectIdRow(value: unknown): value is { effectId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { effectId?: unknown }).effectId === "string"
  );
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}
