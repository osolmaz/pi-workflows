import type { ControllerResource } from "../controllers/types.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";

export const CONTROLLER_WORKER_LAUNCH_SCHEMA = "pi-workflows.controller-worker-launch.v1" as const;
export const CONTROLLER_WORKER_MESSAGE_SCHEMA =
  "pi-workflows.controller-worker-message.v1" as const;
export const CONTROLLER_WORKER_RESPONSE_SCHEMA =
  "pi-workflows.controller-worker-response.v1" as const;

export type ControllerWorkerLaunchEnvelope = {
  schema: typeof CONTROLLER_WORKER_LAUNCH_SCHEMA;
  workerEpoch: string;
  hostEpoch: number;
  generation: number;
  projectPath: string;
  definitionPath: string;
  controllerName: string;
  resource: ControllerResource;
  timeoutMs: number;
};

export type ControllerWorkerOperation =
  | "worker.ready"
  | "effect.reserve"
  | "effect.settle"
  | "workflow.ensure"
  | "workflow.changeSettings"
  | "workflow.queueFollowUp"
  | "workflow.removeFollowUp"
  | "worker.finished"
  | "worker.failed";

export type ControllerWorkerMessage = {
  schema: typeof CONTROLLER_WORKER_MESSAGE_SCHEMA;
  launchSchema: typeof CONTROLLER_WORKER_LAUNCH_SCHEMA;
  messageId: string;
  workerEpoch: string;
  generation: number;
  operation: ControllerWorkerOperation;
  payload: JsonValue;
};

export type ControllerWorkerResponse = {
  schema: typeof CONTROLLER_WORKER_RESPONSE_SCHEMA;
  messageId: string;
  outcome: "accepted" | "rejected" | "claimLost";
  result?: JsonValue;
  error?: string;
};

export function encodeControllerWorkerLine(
  value: ControllerWorkerMessage | ControllerWorkerResponse,
): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function parseControllerWorkerMessage(frame: Buffer): ControllerWorkerMessage {
  const value = parseJson(frame.toString("utf8"));
  if (!isRecord(value) || value.schema !== CONTROLLER_WORKER_MESSAGE_SCHEMA) {
    throw new Error("Invalid controller worker message schema");
  }
  if (
    value.launchSchema !== CONTROLLER_WORKER_LAUNCH_SCHEMA ||
    typeof value.messageId !== "string" ||
    typeof value.workerEpoch !== "string" ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation as ControllerWorkerOperation) ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new Error("Invalid controller worker message");
  }
  return value as ControllerWorkerMessage;
}

export function parseControllerWorkerResponse(frame: Buffer): ControllerWorkerResponse {
  const value = parseJson(frame.toString("utf8"));
  if (!isRecord(value) || value.schema !== CONTROLLER_WORKER_RESPONSE_SCHEMA) {
    throw new Error("Invalid controller worker response schema");
  }
  if (
    typeof value.messageId !== "string" ||
    !["accepted", "rejected", "claimLost"].includes(String(value.outcome))
  ) {
    throw new Error("Invalid controller worker response");
  }
  return value as ControllerWorkerResponse;
}

const OPERATIONS = new Set<ControllerWorkerOperation>([
  "worker.ready",
  "effect.reserve",
  "effect.settle",
  "workflow.ensure",
  "workflow.changeSettings",
  "workflow.queueFollowUp",
  "workflow.removeFollowUp",
  "worker.finished",
  "worker.failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
