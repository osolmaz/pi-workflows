import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";

export const MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES = 1024 * 1024;
export const WORKFLOW_RUNNER_CONTENT_CHUNK_BYTES = 512 * 1024;
export const WORKFLOW_RUNNER_MESSAGE_SCHEMA = "pi-workflows.worker-message.v1" as const;
export const WORKFLOW_RUNNER_RESPONSE_SCHEMA = "pi-workflows.worker-response.v1" as const;
export const WORKFLOW_RUNNER_CONTENT_REFERENCE_SCHEMA =
  "pi-workflows.worker-content-reference.v1" as const;
export const WORKFLOW_RUNNER_CONTENT_CHUNK_SCHEMA = "pi-workflows.worker-content-chunk.v1" as const;

export type WorkflowRunnerCommand =
  | { kind: "start"; input: JsonValue }
  | { kind: "resume"; resumeInteractionAttemptId?: string }
  | {
      kind: "continue";
      parentRunId: string;
      input: JsonValue;
      humanDecision?: JsonValue;
    }
  | { kind: "restart"; input: JsonValue };

export const WORKFLOW_RUNNER_MESSAGE_KINDS = [
  "runner.ready",
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
  "runner.progress",
  "runner.exiting",
] as const;

export type WorkflowRunnerMessageKind = (typeof WORKFLOW_RUNNER_MESSAGE_KINDS)[number];
export const WORKFLOW_RUNNER_STORE_OPERATIONS = [
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
export type WorkflowRunnerStoreOperation = (typeof WORKFLOW_RUNNER_STORE_OPERATIONS)[number];
const WORKFLOW_RUNNER_CONTROL_OPERATIONS = ["runner.ready", "runner.exiting"] as const;

export type WorkflowRunnerMessage = {
  schema: typeof WORKFLOW_RUNNER_MESSAGE_SCHEMA;
  launchSchema: "pi-workflows.worker-launch.v1";
  messageId: string;
  kind: WorkflowRunnerMessageKind;
  operation: WorkflowRunnerStoreOperation | "runner.ready" | "runner.exiting";
  runId: string;
  generation: number;
  runnerEpoch: string;
  expectedRevision: number;
  attemptId?: string;
  payload: JsonValue;
};

export type WorkflowRunnerResponse = {
  schema: typeof WORKFLOW_RUNNER_RESPONSE_SCHEMA;
  messageId: string;
  outcome: "accepted" | "adopted" | "rejected" | "claimLost";
  revision?: number;
  result?: JsonValue;
  error?: string;
};

export type WorkflowRunnerContentReference = {
  schema: typeof WORKFLOW_RUNNER_CONTENT_REFERENCE_SCHEMA;
  sha256: string;
  mediaType: "application/json";
  bytes: number;
};

export type WorkflowRunnerContentChunk = {
  schema: typeof WORKFLOW_RUNNER_CONTENT_CHUNK_SCHEMA;
  sha256: string;
  mediaType: "application/json";
  bytes: number;
  offset: number;
  nextOffset: number;
  complete: boolean;
  data: string;
};

export function isRunnerContentReference(value: unknown): value is WorkflowRunnerContentReference {
  return (
    isRecord(value) &&
    value.schema === WORKFLOW_RUNNER_CONTENT_REFERENCE_SCHEMA &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    value.mediaType === "application/json" &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0
  );
}

export function isRunnerContentChunk(value: unknown): value is WorkflowRunnerContentChunk {
  return (
    isRecord(value) &&
    value.schema === WORKFLOW_RUNNER_CONTENT_CHUNK_SCHEMA &&
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

export function runnerKindForOperation(
  operation: WorkflowRunnerStoreOperation,
  payload: Record<string, unknown>,
): WorkflowRunnerMessageKind {
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
  return "runner.progress";
}

export function encodeRunnerLine(message: WorkflowRunnerMessage | WorkflowRunnerResponse): Buffer {
  const encoded = Buffer.from(`${canonicalJson(message)}\n`, "utf8");
  if (encoded.byteLength > MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES) {
    throw new Error("Runner protocol message exceeds 1 MiB");
  }
  return encoded;
}

export function parseRunnerMessage(line: Buffer | string): WorkflowRunnerMessage {
  const value = parseRunnerValue(line);
  if (
    value.schema !== WORKFLOW_RUNNER_MESSAGE_SCHEMA ||
    value.launchSchema !== "pi-workflows.worker-launch.v1"
  ) {
    throw new Error("Invalid workflow runner message schema");
  }
  requireText(value.messageId, "messageId");
  requireText(value.runId, "runId");
  requireText(value.runnerEpoch, "runnerEpoch");
  if (!WORKFLOW_RUNNER_MESSAGE_KINDS.includes(value.kind as WorkflowRunnerMessageKind)) {
    throw new Error("Invalid workflow runner message kind");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new Error("Runner generation must be positive");
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new Error("Runner expectedRevision must be non-negative");
  }
  requireText(value.operation, "operation");
  if (
    !WORKFLOW_RUNNER_STORE_OPERATIONS.includes(value.operation as WorkflowRunnerStoreOperation) &&
    !WORKFLOW_RUNNER_CONTROL_OPERATIONS.includes(
      value.operation as (typeof WORKFLOW_RUNNER_CONTROL_OPERATIONS)[number],
    )
  ) {
    throw new Error("Invalid workflow runner operation");
  }
  if (value.attemptId !== undefined) requireText(value.attemptId, "attemptId");
  if (!Object.hasOwn(value, "payload")) throw new Error("Runner payload is required");
  return value as WorkflowRunnerMessage;
}

export function parseRunnerResponse(line: Buffer | string): WorkflowRunnerResponse {
  const value = parseRunnerValue(line);
  if (value.schema !== WORKFLOW_RUNNER_RESPONSE_SCHEMA)
    throw new Error("Invalid workflow runner response schema");
  requireText(value.messageId, "messageId");
  if (!["accepted", "adopted", "rejected", "claimLost"].includes(value.outcome as string)) {
    throw new Error("Invalid workflow runner response outcome");
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error("Runner response error must be text");
  }
  return value as WorkflowRunnerResponse;
}

function parseRunnerValue(line: Buffer | string): Record<string, unknown> {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(line, "utf8");
  if (buffer.byteLength + 1 > MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES) {
    throw new Error("Runner protocol message exceeds 1 MiB");
  }
  const text = buffer.toString("utf8");
  const value = parseJson(text);
  if (!isRecord(value) || canonicalJson(value) !== text) {
    throw new Error("Runner protocol message must be a canonical JSON object");
  }
  return value;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Runner ${field} must be nonempty bounded text`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
