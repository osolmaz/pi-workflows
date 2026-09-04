import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";

export const MAX_WORKER_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const WORKER_CONTENT_CHUNK_BYTES = 512 * 1024;
export const WORKER_MESSAGE_SCHEMA = "pi-workflows.worker-message.v1" as const;
export const WORKER_RESPONSE_SCHEMA = "pi-workflows.worker-response.v1" as const;
export const WORKER_CONTENT_REFERENCE_SCHEMA = "pi-workflows.worker-content-reference.v1" as const;
export const WORKER_CONTENT_CHUNK_SCHEMA = "pi-workflows.worker-content-chunk.v1" as const;

export type WorkerRunCommand =
  | { kind: "start"; input: JsonValue }
  | { kind: "resume"; resumeInteractionAttemptId?: string }
  | {
      kind: "continue";
      parentRunId: string;
      input: JsonValue;
      humanDecision?: JsonValue;
    }
  | { kind: "restart"; input: JsonValue };

export const WORKER_MESSAGE_KINDS = [
  "worker.ready",
  "node.started",
  "node.update",
  "node.finished",
  "node.failed",
  "run.parked",
  "run.finished",
  "interaction.requested",
  "interaction.accepted",
  "interaction.rejected",
  "notification.requested",
  "presentation.requested",
  "effect.reserve",
  "effect.settle",
  "worker.progress",
  "worker.exiting",
] as const;

export type WorkerMessageKind = (typeof WORKER_MESSAGE_KINDS)[number];
export const WORKER_STORE_OPERATIONS = [
  "store.initializeRun",
  "store.prepareRunResume",
  "store.readRunState",
  "store.writeSnapshot",
  "store.publishUpdate",
  "store.findSettingsScope",
  "store.ensureSettingsScope",
  "store.getSettingsScopeAtChange",
  "store.createHumanDecisionRequest",
  "store.readResolvedHumanDecision",
  "store.reserveEffect",
  "store.settleEffect",
  "content.read",
  "process.register",
  "process.unregister",
  "interaction.request",
  "interaction.accept",
  "interaction.reject",
  "notification.request",
  "presentation.request",
] as const;
export type WorkerStoreOperation = (typeof WORKER_STORE_OPERATIONS)[number];
const WORKER_CONTROL_OPERATIONS = ["worker.ready", "worker.exiting"] as const;

export type WorkerMessage = {
  schema: typeof WORKER_MESSAGE_SCHEMA;
  launchSchema: "pi-workflows.worker-launch.v1";
  messageId: string;
  kind: WorkerMessageKind;
  operation: WorkerStoreOperation | "worker.ready" | "worker.exiting";
  runId: string;
  generation: number;
  workerEpoch: string;
  expectedRevision: number;
  attemptId?: string;
  payload: JsonValue;
};

export type WorkerResponse = {
  schema: typeof WORKER_RESPONSE_SCHEMA;
  messageId: string;
  outcome: "accepted" | "adopted" | "rejected" | "claimLost";
  revision?: number;
  result?: JsonValue;
  error?: string;
};

export type WorkerContentReference = {
  schema: typeof WORKER_CONTENT_REFERENCE_SCHEMA;
  sha256: string;
  mediaType: "application/json";
  bytes: number;
};

export type WorkerContentChunk = {
  schema: typeof WORKER_CONTENT_CHUNK_SCHEMA;
  sha256: string;
  mediaType: "application/json";
  bytes: number;
  offset: number;
  nextOffset: number;
  complete: boolean;
  data: string;
};

export function isWorkerContentReference(value: unknown): value is WorkerContentReference {
  return (
    isRecord(value) &&
    value.schema === WORKER_CONTENT_REFERENCE_SCHEMA &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    value.mediaType === "application/json" &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0
  );
}

export function isWorkerContentChunk(value: unknown): value is WorkerContentChunk {
  return (
    isRecord(value) &&
    value.schema === WORKER_CONTENT_CHUNK_SCHEMA &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    value.mediaType === "application/json" &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0 &&
    Number.isSafeInteger(value.nextOffset) &&
    (value.nextOffset as number) >= (value.offset as number) &&
    typeof value.complete === "boolean" &&
    typeof value.data === "string"
  );
}

export function workerKindForOperation(
  operation: WorkerStoreOperation,
  payload: Record<string, unknown>,
): WorkerMessageKind {
  if (operation === "store.publishUpdate") return "node.update";
  if (operation === "store.reserveEffect") return "effect.reserve";
  if (operation === "store.settleEffect") return "effect.settle";
  if (operation === "store.createHumanDecisionRequest" || operation === "interaction.request") {
    return "interaction.requested";
  }
  if (operation === "interaction.accept") return "interaction.accepted";
  if (operation === "interaction.reject") return "interaction.rejected";
  if (operation === "notification.request") return "notification.requested";
  if (operation === "presentation.request") return "presentation.requested";
  if (operation === "store.writeSnapshot") {
    const event = payload.event;
    const eventType = isRecord(event) && typeof event.type === "string" ? event.type : "";
    if (eventType === "node_started") return "node.started";
    if (eventType === "node_finished") return "node.finished";
    if (eventType === "node_failed" || eventType === "node_timed_out") return "node.failed";
    if (eventType === "run_waiting" || eventType.includes("park")) return "run.parked";
    if (eventType.startsWith("run_") && eventType !== "run_started") return "run.finished";
  }
  return "worker.progress";
}

export function encodeWorkerLine(message: WorkerMessage | WorkerResponse): Buffer {
  const encoded = Buffer.from(`${canonicalJson(message)}\n`, "utf8");
  if (encoded.byteLength > MAX_WORKER_PROTOCOL_MESSAGE_BYTES) {
    throw new Error("Worker protocol message exceeds 1 MiB");
  }
  return encoded;
}

export function parseWorkerMessage(line: Buffer | string): WorkerMessage {
  const value = parseWorkerValue(line);
  if (
    value.schema !== WORKER_MESSAGE_SCHEMA ||
    value.launchSchema !== "pi-workflows.worker-launch.v1"
  ) {
    throw new Error("Invalid worker message schema");
  }
  requireText(value.messageId, "messageId");
  requireText(value.runId, "runId");
  requireText(value.workerEpoch, "workerEpoch");
  if (!WORKER_MESSAGE_KINDS.includes(value.kind as WorkerMessageKind)) {
    throw new Error("Invalid worker message kind");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new Error("Worker generation must be positive");
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new Error("Worker expectedRevision must be non-negative");
  }
  requireText(value.operation, "operation");
  if (
    !WORKER_STORE_OPERATIONS.includes(value.operation as WorkerStoreOperation) &&
    !WORKER_CONTROL_OPERATIONS.includes(
      value.operation as (typeof WORKER_CONTROL_OPERATIONS)[number],
    )
  ) {
    throw new Error("Invalid worker operation");
  }
  if (value.attemptId !== undefined) requireText(value.attemptId, "attemptId");
  if (!Object.hasOwn(value, "payload")) throw new Error("Worker payload is required");
  return value as WorkerMessage;
}

export function parseWorkerResponse(line: Buffer | string): WorkerResponse {
  const value = parseWorkerValue(line);
  if (value.schema !== WORKER_RESPONSE_SCHEMA) throw new Error("Invalid worker response schema");
  requireText(value.messageId, "messageId");
  if (!["accepted", "adopted", "rejected", "claimLost"].includes(value.outcome as string)) {
    throw new Error("Invalid worker response outcome");
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error("Worker response error must be text");
  }
  return value as WorkerResponse;
}

function parseWorkerValue(line: Buffer | string): Record<string, unknown> {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(line, "utf8");
  if (buffer.byteLength + 1 > MAX_WORKER_PROTOCOL_MESSAGE_BYTES) {
    throw new Error("Worker protocol message exceeds 1 MiB");
  }
  const text = buffer.toString("utf8");
  const value = parseJson(text);
  if (!isRecord(value) || canonicalJson(value) !== text) {
    throw new Error("Worker protocol message must be a canonical JSON object");
  }
  return value;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Worker ${field} must be nonempty bounded text`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
