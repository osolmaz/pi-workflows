import { randomUUID } from "node:crypto";
import type {
  WorkflowProgressData,
  WorkflowUpdateInput,
  WorkflowUpdateReceipt,
  WorkflowUpdateRecord,
} from "./types.js";

export const MAX_UPDATE_DATA_BYTES = 64 * 1024;
export const MAX_CURRENT_UPDATES = 1_024;
export const UPDATE_RATE_PER_SECOND = 20;
export const UPDATE_RATE_BURST = 100;

const TYPE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROGRESS_STATUSES = new Set([
  "pending",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const PROGRESS_FIELDS = new Set([
  "schema",
  "status",
  "label",
  "phase",
  "completed",
  "total",
  "unit",
  "sourceUpdatedAt",
  "sourceEstimatedFinishAt",
]);

export function validateWorkflowUpdate(input: unknown): WorkflowUpdateInput {
  if (!isRecord(input)) throw new Error("update must be an object");
  const type = input.type;
  const key = input.key;
  const data = input.data;
  if (typeof type !== "string" || !TYPE_PATTERN.test(type)) {
    throw new Error("update.type must match [a-z][a-z0-9.-]{0,63}");
  }
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new Error("update.key must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,127}");
  }
  if (!isRecord(data)) throw new Error("update.data must be a non-null JSON object");
  assertJsonValue(data, "update.data");
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > MAX_UPDATE_DATA_BYTES) {
    throw new Error(`update.data must be at most ${MAX_UPDATE_DATA_BYTES} bytes`);
  }
  const normalized = { type, key, data };
  if (type === "progress") validateProgressData(data);
  return normalized;
}

export function validateProgressData(data: Record<string, unknown>): WorkflowProgressData {
  for (const field of Object.keys(data)) {
    if (!PROGRESS_FIELDS.has(field)) throw new Error(`progress.${field} is not supported`);
  }
  if (data.schema !== "pi-workflows.progress.v1") {
    throw new Error("progress.schema must equal pi-workflows.progress.v1");
  }
  if (typeof data.status !== "string" || !PROGRESS_STATUSES.has(data.status)) {
    throw new Error("progress.status is invalid");
  }
  optionalString(data.label, "progress.label", 200);
  optionalString(data.phase, "progress.phase", 128);
  optionalFiniteNonNegative(data.completed, "progress.completed");
  if (data.total !== undefined) {
    if (typeof data.total !== "number" || !Number.isFinite(data.total) || data.total <= 0) {
      throw new Error("progress.total must be a finite number greater than zero");
    }
    if (typeof data.completed === "number" && data.total < data.completed) {
      throw new Error("progress.total must be at least progress.completed");
    }
  }
  if (data.completed !== undefined || data.total !== undefined) {
    if (
      typeof data.unit !== "string" ||
      data.unit.trim().length < 1 ||
      data.unit.trim().length > 32
    ) {
      throw new Error("progress.unit is required with counts and must be 1 to 32 characters");
    }
  } else if (data.unit !== undefined) {
    optionalString(data.unit, "progress.unit", 32);
  }
  optionalDate(data.sourceUpdatedAt, "progress.sourceUpdatedAt");
  optionalDate(data.sourceEstimatedFinishAt, "progress.sourceEstimatedFinishAt");
  return data as WorkflowProgressData;
}

export function updateProjection(
  current: WorkflowUpdateRecord[] | undefined,
  record: WorkflowUpdateRecord,
): WorkflowUpdateRecord[] {
  const next = (current ?? []).filter(
    (entry) => !(entry.type === record.type && entry.key === record.key),
  );
  next.push(record);
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

export function createUpdateId(): string {
  return `upd_${randomUUID()}`;
}

export function updateReceipt(record: WorkflowUpdateRecord): WorkflowUpdateReceipt {
  return {
    updateId: record.updateId,
    seq: record.seq,
    at: record.at,
    type: record.type,
    key: record.key,
  };
}

export class UpdateRateLimiter {
  private tokens = UPDATE_RATE_BURST;
  private lastMs = Date.now();

  take(nowMs = Date.now()): void {
    const elapsed = Math.max(0, nowMs - this.lastMs) / 1_000;
    this.tokens = Math.min(UPDATE_RATE_BURST, this.tokens + elapsed * UPDATE_RATE_PER_SECOND);
    this.lastMs = nowMs;
    if (this.tokens < 1) throw new Error("workflow update rate limit exceeded");
    this.tokens -= 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error(`${path}.${key} is undefined`);
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains a non-JSON value`);
}

function optionalString(value: unknown, field: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw new Error(`${field} must be 1 to ${max} characters`);
  }
}

function optionalFiniteNonNegative(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function optionalDate(value: unknown, field: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !/[zZ]|[+-]\d\d:\d\d$/.test(value)
  ) {
    throw new Error(`${field} must be an RFC 3339 timestamp with an offset`);
  }
}
