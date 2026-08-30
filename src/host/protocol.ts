import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_REQUEST_SCHEMA = "pi-workflows.host-request.v1" as const;
export const HOST_RESPONSE_SCHEMA = "pi-workflows.host-response.v1" as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;

export const HOST_OPERATIONS = [
  "run.start",
  "run.pause",
  "run.resume",
  "run.cancel",
  "run.status",
  "run.list",
  "checkpoint.answer",
  "decision.answer",
  "interaction.submit",
  "interaction.update",
  "notification.claim",
  "notification.deliver",
  "turn.claim",
  "turn.resolve",
  "controller.list",
  "controller.get",
  "controller.apply",
  "controller.reconcile",
  "controller.delete",
  "host.status",
  "host.stop",
] as const;

export type HostOperation = (typeof HOST_OPERATIONS)[number];
export type HostOutcome =
  | "accepted"
  | "adopted"
  | "rejected"
  | "conflict"
  | "notFound"
  | "claimLost"
  | "unavailable";

export type HostRequest = {
  schema: typeof HOST_REQUEST_SCHEMA;
  requestId: string;
  clientId: string;
  operation: HostOperation;
  idempotencyKey: string;
  runId?: string;
  expectedRevision?: number;
  payload: JsonValue;
};

export type HostResponse = {
  schema: typeof HOST_RESPONSE_SCHEMA;
  requestId: string;
  outcome: HostOutcome;
  revision?: number;
  receipt?: JsonValue;
  error?: string;
};

export class HostProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostProtocolError";
  }
}

export function encodeProtocolLine(message: HostRequest | HostResponse): Buffer {
  const encoded = Buffer.from(`${canonicalJson(message)}\n`, "utf8");
  if (encoded.byteLength > MAX_PROTOCOL_MESSAGE_BYTES) {
    throw new HostProtocolError("Host protocol message exceeds 1 MiB");
  }
  return encoded;
}

export function parseHostRequest(line: string | Buffer): HostRequest {
  const value = parseProtocolValue(line);
  if (value.schema !== HOST_REQUEST_SCHEMA)
    throw new HostProtocolError("Invalid host request schema");
  requireOpaqueId(value.requestId, "requestId");
  requireOpaqueId(value.clientId, "clientId");
  requireOpaqueId(value.idempotencyKey, "idempotencyKey");
  if (!HOST_OPERATIONS.includes(value.operation as HostOperation)) {
    throw new HostProtocolError("Invalid host request operation");
  }
  if (value.runId !== undefined) requireOpaqueId(value.runId, "runId");
  if (
    value.expectedRevision !== undefined &&
    (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0)
  ) {
    throw new HostProtocolError("Host request expectedRevision must be a non-negative integer");
  }
  if (!Object.hasOwn(value, "payload"))
    throw new HostProtocolError("Host request payload is required");
  canonicalJson(value.payload);
  return value as HostRequest;
}

export function parseHostResponse(line: string | Buffer): HostResponse {
  const value = parseProtocolValue(line);
  if (value.schema !== HOST_RESPONSE_SCHEMA) {
    throw new HostProtocolError("Invalid host response schema");
  }
  requireOpaqueId(value.requestId, "requestId");
  const outcomes: HostOutcome[] = [
    "accepted",
    "adopted",
    "rejected",
    "conflict",
    "notFound",
    "claimLost",
    "unavailable",
  ];
  if (!outcomes.includes(value.outcome as HostOutcome)) {
    throw new HostProtocolError("Invalid host response outcome");
  }
  if (
    value.revision !== undefined &&
    (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
  ) {
    throw new HostProtocolError("Host response revision must be a non-negative integer");
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new HostProtocolError("Host response error must be text");
  }
  if (value.receipt !== undefined) canonicalJson(value.receipt);
  return value as HostResponse;
}

export function requestFingerprint(request: HostRequest): Buffer {
  return createHash("sha256").update(canonicalJson(request)).digest();
}

export function hostSocketPath(databasePath: string): string {
  const stateDirectory = path.dirname(path.resolve(databasePath));
  if (process.platform === "win32") {
    const suffix = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\pi-workflows-${suffix}`;
  }
  return path.join(stateDirectory, "host", "host.sock");
}

export class NdjsonFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.byteLength > MAX_PROTOCOL_MESSAGE_BYTES && !this.buffered.includes(0x0a)) {
      throw new HostProtocolError("Host protocol message exceeds 1 MiB");
    }
    const frames: Buffer[] = [];
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) break;
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      if (frame.byteLength + 1 > MAX_PROTOCOL_MESSAGE_BYTES) {
        throw new HostProtocolError("Host protocol message exceeds 1 MiB");
      }
      frames.push(frame);
    }
    return frames;
  }
}

function parseProtocolValue(line: string | Buffer): Record<string, unknown> {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(line, "utf8");
  if (buffer.byteLength + 1 > MAX_PROTOCOL_MESSAGE_BYTES) {
    throw new HostProtocolError("Host protocol message exceeds 1 MiB");
  }
  let value: unknown;
  try {
    value = parseJson(buffer.toString("utf8"));
  } catch {
    throw new HostProtocolError("Host protocol message is not valid canonical JSON");
  }
  if (!isRecord(value)) throw new HostProtocolError("Host protocol message must be an object");
  if (canonicalJson(value) !== buffer.toString("utf8")) {
    throw new HostProtocolError("Host protocol message must use canonical JSON");
  }
  return value;
}

function requireOpaqueId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new HostProtocolError(`Host request ${field} must be nonempty text of at most 256 bytes`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
