import { validateProgressData } from "../workflows/index.js";
import {
  JOB_PROGRESS_SCHEMA,
  type JobProgressCost,
  type JobProgressSnapshot,
  type JobProgressState,
  type JobProgressTrack,
} from "./types.js";

export const MAX_JOB_PROGRESS_BYTES = 64 * 1024;
export const MAX_JOB_PROGRESS_TRACKS = 128;

const SNAPSHOT_FIELDS = new Set([
  "schema",
  "application",
  "component",
  "jobId",
  "sourceRevision",
  "contractHash",
  "sequence",
  "state",
  "phase",
  "startedAt",
  "updatedAt",
  "deadlineAt",
  "finishedAt",
  "tracks",
  "cost",
]);
const TRACK_FIELDS = new Set(["key", "data"]);
const COST_FIELDS = new Set(["settledUsd", "reservedUsd"]);
const STATES = new Set<JobProgressState>([
  "queued",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RFC_3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function validateJobProgressSnapshot(value: unknown): JobProgressSnapshot {
  const bytes = jsonBytes(value);
  if (bytes > MAX_JOB_PROGRESS_BYTES) {
    throw new Error(`job progress snapshot must be at most ${MAX_JOB_PROGRESS_BYTES} bytes`);
  }
  if (!isRecord(value)) throw new Error("job progress snapshot must be an object");
  rejectUnknown(value, SNAPSHOT_FIELDS, "job progress");
  if (value.schema !== JOB_PROGRESS_SCHEMA) {
    throw new Error(`job progress.schema must equal ${JOB_PROGRESS_SCHEMA}`);
  }

  const application = requiredText(value.application, "job progress.application", 100);
  const component = requiredText(value.component, "job progress.component", 100);
  const jobId = requiredText(value.jobId, "job progress.jobId", 200);
  const sourceRevision = requiredText(value.sourceRevision, "job progress.sourceRevision", 200);
  const contractHash = requiredText(value.contractHash, "job progress.contractHash", 200);
  const sequence = requiredInteger(value.sequence, "job progress.sequence");
  const state = requiredState(value.state);
  const phase = requiredText(value.phase, "job progress.phase", 100);
  const startedAt = requiredTimestamp(value.startedAt, "job progress.startedAt");
  const updatedAt = requiredTimestamp(value.updatedAt, "job progress.updatedAt");
  const deadlineAt = optionalTimestamp(value.deadlineAt, "job progress.deadlineAt");
  const finishedAt = optionalTimestamp(value.finishedAt, "job progress.finishedAt");
  const tracks = requiredTracks(value.tracks);
  const cost = optionalCost(value.cost);

  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    throw new Error("job progress.updatedAt must not be before startedAt");
  }
  if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.parse(startedAt)) {
    throw new Error("job progress.deadlineAt must be after startedAt");
  }
  if (finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("job progress.finishedAt must not be before startedAt");
  }
  if (finishedAt !== undefined && Date.parse(finishedAt) > Date.parse(updatedAt)) {
    throw new Error("job progress.finishedAt must not be after updatedAt");
  }
  if (isTerminal(state) && finishedAt === undefined) {
    throw new Error("job progress.finishedAt is required for a terminal state");
  }
  if (!isTerminal(state) && finishedAt !== undefined) {
    throw new Error("job progress.finishedAt is allowed only for a terminal state");
  }
  if (isTerminal(state) && tracks.some((track) => !isTerminalTrack(track))) {
    throw new Error("job progress tracks must be terminal when the job state is terminal");
  }

  return {
    schema: JOB_PROGRESS_SCHEMA,
    application,
    component,
    jobId,
    sourceRevision,
    contractHash,
    sequence,
    state,
    phase,
    startedAt,
    updatedAt,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    tracks,
    ...(cost === undefined ? {} : { cost }),
  };
}

export function isTerminalJobProgressState(
  state: JobProgressState,
): state is "completed" | "failed" | "cancelled" {
  return isTerminal(state);
}

function requiredTracks(value: unknown): JobProgressTrack[] {
  if (!Array.isArray(value)) throw new Error("job progress.tracks must be an array");
  if (value.length < 1) throw new Error("job progress.tracks must contain at least one entry");
  if (value.length > MAX_JOB_PROGRESS_TRACKS) {
    throw new Error(`job progress.tracks must contain at most ${MAX_JOB_PROGRESS_TRACKS} entries`);
  }
  const keys = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`job progress.tracks[${index}] must be an object`);
    rejectUnknown(item, TRACK_FIELDS, `job progress.tracks[${index}]`);
    if (typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) {
      throw new Error(
        `job progress.tracks[${index}].key must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`,
      );
    }
    if (keys.has(item.key)) throw new Error(`job progress track key ${item.key} is duplicated`);
    keys.add(item.key);
    if (!isRecord(item.data)) {
      throw new Error(`job progress.tracks[${index}].data must be an object`);
    }
    return { key: item.key, data: structuredClone(validateProgressData(item.data)) };
  });
}

function optionalCost(value: unknown): JobProgressCost | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("job progress.cost must be an object");
  rejectUnknown(value, COST_FIELDS, "job progress.cost");
  return {
    settledUsd: requiredNonNegative(value.settledUsd, "job progress.cost.settledUsd"),
    reservedUsd: requiredNonNegative(value.reservedUsd, "job progress.cost.reservedUsd"),
  };
}

function requiredState(value: unknown): JobProgressState {
  if (typeof value !== "string" || !STATES.has(value as JobProgressState)) {
    throw new Error("job progress.state is invalid");
  }
  return value as JobProgressState;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw new Error(`${field} must be 1 to ${max} characters`);
  }
  if ([...value].some(isControlCharacter))
    throw new Error(`${field} must not contain control characters`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requiredNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function requiredTimestamp(value: unknown, field: string): string {
  const parsed = optionalTimestamp(value, field);
  if (parsed === undefined) throw new Error(`${field} is required`);
  return parsed;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be an RFC 3339 timestamp with an offset`);
  }
  const match = RFC_3339_PATTERN.exec(value);
  if (match === null || !validCalendarDate(match[1], match[2], match[3])) {
    throw new Error(`${field} must be an RFC 3339 timestamp with an offset`);
  }
  return value;
}

function validCalendarDate(
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function jsonBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("job progress snapshot must be JSON serializable");
  }
  if (encoded === undefined) throw new Error("job progress snapshot must be JSON serializable");
  return Buffer.byteLength(encoded, "utf8");
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || (code >= 127 && code <= 159);
}

function isTerminal(state: JobProgressState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function isTerminalTrack(track: JobProgressTrack): boolean {
  return (
    track.data.status === "completed" ||
    track.data.status === "failed" ||
    track.data.status === "cancelled"
  );
}
