import type { ManagedResource } from "../resource-managers/types.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";

export const RESOURCE_RUNNER_LAUNCH_SCHEMA = "pi-workflows.controller-worker-launch.v1" as const;
export const RESOURCE_RUNNER_MESSAGE_SCHEMA = "pi-workflows.controller-worker-message.v1" as const;
export const RESOURCE_RUNNER_RESPONSE_SCHEMA =
  "pi-workflows.controller-worker-response.v1" as const;

export type ResourceRunnerLaunchEnvelope = {
  schema: typeof RESOURCE_RUNNER_LAUNCH_SCHEMA;
  runnerEpoch: string;
  serverEpoch: number;
  generation: number;
  projectPath: string;
  definitionPath: string;
  resourceManagerName: string;
  resource: ManagedResource;
  timeoutMs: number;
};

export type ResourceRunnerOperation =
  | "runner.ready"
  | "effect.reserve"
  | "effect.settle"
  | "workflow.ensure"
  | "workflow.changeSettings"
  | "workflow.queueFollowUp"
  | "workflow.removeFollowUp"
  | "runner.finished"
  | "runner.failed";

export type ResourceRunnerMessage = {
  schema: typeof RESOURCE_RUNNER_MESSAGE_SCHEMA;
  launchSchema: typeof RESOURCE_RUNNER_LAUNCH_SCHEMA;
  messageId: string;
  runnerEpoch: string;
  generation: number;
  operation: ResourceRunnerOperation;
  payload: JsonValue;
};

export type ResourceRunnerResponse = {
  schema: typeof RESOURCE_RUNNER_RESPONSE_SCHEMA;
  messageId: string;
  outcome: "accepted" | "rejected" | "claimLost";
  result?: JsonValue;
  error?: string;
};

export function encodeResourceRunnerLine(
  value: ResourceRunnerMessage | ResourceRunnerResponse,
): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function parseResourceRunnerMessage(frame: Buffer): ResourceRunnerMessage {
  const value = parseJson(frame.toString("utf8"));
  if (!isRecord(value) || value.schema !== RESOURCE_RUNNER_MESSAGE_SCHEMA) {
    throw new Error("Invalid resource runner message schema");
  }
  if (
    value.launchSchema !== RESOURCE_RUNNER_LAUNCH_SCHEMA ||
    typeof value.messageId !== "string" ||
    typeof value.runnerEpoch !== "string" ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation as ResourceRunnerOperation) ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new Error("Invalid resource runner message");
  }
  return value as ResourceRunnerMessage;
}

export function parseResourceRunnerResponse(frame: Buffer): ResourceRunnerResponse {
  const value = parseJson(frame.toString("utf8"));
  if (!isRecord(value) || value.schema !== RESOURCE_RUNNER_RESPONSE_SCHEMA) {
    throw new Error("Invalid resource runner response schema");
  }
  if (
    typeof value.messageId !== "string" ||
    !["accepted", "rejected", "claimLost"].includes(String(value.outcome))
  ) {
    throw new Error("Invalid resource runner response");
  }
  return value as ResourceRunnerResponse;
}

const OPERATIONS = new Set<ResourceRunnerOperation>([
  "runner.ready",
  "effect.reserve",
  "effect.settle",
  "workflow.ensure",
  "workflow.changeSettings",
  "workflow.queueFollowUp",
  "workflow.removeFollowUp",
  "runner.finished",
  "runner.failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
