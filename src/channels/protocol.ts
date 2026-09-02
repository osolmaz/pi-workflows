import { createHash } from "node:crypto";
import type { JsonValue } from "../state/json.js";
import type { HumanDecisionChannelRequest, HumanDecisionResponse } from "../workflows/types.js";

export const CHANNEL_ADAPTER_PROTOCOL_SCHEMA = "pi-workflows.channel-adapter.v1" as const;

export type TelegramMessageReference = {
  chatId: string;
  messageId: string;
  recipientIndex: number;
  partIndex: number;
  contentDigest: string;
};

type ChannelAdapterMessageBase = {
  schema: typeof CHANNEL_ADAPTER_PROTOCOL_SCHEMA;
  adapterEpoch: string;
  profile: string;
  sequence: number;
  expectedRevision: number;
  stableMessageId: string;
};

export type ChannelAdapterMessage =
  | (ChannelAdapterMessageBase & {
      kind: "channel.ready";
      cursor: number;
    })
  | (ChannelAdapterMessageBase & {
      kind: "channel.present";
      decisionId: string;
      requestDigest: string;
      attemptId: string;
      state: "confirmed" | "failed" | "unknown";
      messages: TelegramMessageReference[];
      errorCode?: string;
    })
  | (ChannelAdapterMessageBase & {
      kind: "channel.answer";
      decisionId: string;
      requestDigest: string;
      response: HumanDecisionResponse;
      actorId: string;
      chatId: string;
      eventId: string;
      idempotencyKey: string;
      cursor: number;
    })
  | (ChannelAdapterMessageBase & {
      kind: "channel.settle";
      decisionId: string;
      requestDigest: string;
      attemptId: string;
      state: "confirmed" | "failed" | "unknown";
      errorCode?: string;
    })
  | (ChannelAdapterMessageBase & {
      kind: "channel.exiting";
      cursor: number;
    });

export type ChannelAdapterCommand =
  | {
      kind: "channel.present";
      stableMessageId: string;
      attemptId: string;
      request: HumanDecisionChannelRequest;
    }
  | {
      kind: "channel.settle";
      stableMessageId: string;
      attemptId: string;
      request: HumanDecisionChannelRequest;
      outcome: "accepted" | "cancelled" | "expired";
      response?: HumanDecisionResponse;
      messages: TelegramMessageReference[];
    }
  | {
      kind: "channel.poll";
      cursor: number;
      requests: HumanDecisionChannelRequest[];
    }
  | { kind: "channel.stop" };

export type ChannelAdapterResponse = {
  schema: typeof CHANNEL_ADAPTER_PROTOCOL_SCHEMA;
  type: "response";
  sequence: number;
  outcome: "accepted" | "rejected";
  revision: number;
  command: ChannelAdapterCommand | null;
  error?: string;
};

export type ChannelAdapterLaunch = {
  schema: "pi-workflows.channel-adapter-launch.v1";
  adapterEpoch: string;
  profile: string;
  token: string;
  allowedUserIds: string[];
  allowedChatIds: string[];
  apiBase?: string;
};

export function encodeChannelLine(value: ChannelAdapterMessage | ChannelAdapterResponse): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function parseChannelAdapterMessage(frame: Buffer): ChannelAdapterMessage {
  const value = parseObject(frame, "channel adapter message");
  requireBase(value);
  const kind = value.kind;
  if (kind === "channel.ready" || kind === "channel.exiting") {
    requireNonNegativeInteger(value.cursor, "channel cursor");
  } else if (kind === "channel.present") {
    requireText(value.decisionId, "decisionId");
    requireText(value.requestDigest, "requestDigest");
    requireText(value.attemptId, "attemptId");
    requireOneOf(value.state, ["confirmed", "failed", "unknown"], "presentation state");
    if (!Array.isArray(value.messages)) throw new Error("Channel message references are invalid");
    value.messages.forEach(validateMessageReference);
    requireOptionalText(value.errorCode, "errorCode");
  } else if (kind === "channel.answer") {
    requireText(value.decisionId, "decisionId");
    requireText(value.requestDigest, "requestDigest");
    validateDecisionResponse(value.response);
    requireText(value.actorId, "actorId");
    requireText(value.chatId, "chatId");
    requireText(value.eventId, "eventId");
    requireText(value.idempotencyKey, "idempotencyKey");
    requireNonNegativeInteger(value.cursor, "channel cursor");
  } else if (kind === "channel.settle") {
    requireText(value.decisionId, "decisionId");
    requireText(value.requestDigest, "requestDigest");
    requireText(value.attemptId, "attemptId");
    requireOneOf(value.state, ["confirmed", "failed", "unknown"], "settlement state");
    requireOptionalText(value.errorCode, "errorCode");
  } else {
    throw new Error("Channel adapter message kind is invalid");
  }
  return value as unknown as ChannelAdapterMessage;
}

export function parseChannelAdapterResponse(frame: Buffer): ChannelAdapterResponse {
  const value = parseObject(frame, "channel adapter response");
  if (
    value.schema !== CHANNEL_ADAPTER_PROTOCOL_SCHEMA ||
    value.type !== "response" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.outcome !== "accepted" && value.outcome !== "rejected") ||
    !Number.isSafeInteger(value.revision)
  ) {
    throw new Error("Channel adapter response is invalid");
  }
  requirePositiveInteger(value.sequence, "channel response sequence");
  requireNonNegativeInteger(value.revision, "channel response revision");
  requireOptionalText(value.error, "channel response error");
  validateCommand(value.command);
  return value as unknown as ChannelAdapterResponse;
}

export function parseChannelAdapterLaunch(value: unknown): ChannelAdapterLaunch {
  const launch = requireObject(value, "channel adapter launch envelope");
  if (launch.schema !== "pi-workflows.channel-adapter-launch.v1") {
    throw new Error("Channel adapter launch envelope is invalid");
  }
  requireText(launch.adapterEpoch, "adapterEpoch");
  requireText(launch.profile, "profile");
  requireText(launch.token, "token");
  requireStringArray(launch.allowedUserIds, "allowedUserIds");
  requireStringArray(launch.allowedChatIds, "allowedChatIds");
  requireOptionalText(launch.apiBase, "apiBase");
  return launch as ChannelAdapterLaunch;
}

export function channelResponse(
  message: ChannelAdapterMessage,
  outcome: ChannelAdapterResponse["outcome"],
  revision: number,
  command: ChannelAdapterCommand | null,
  error?: string,
): ChannelAdapterResponse {
  return {
    schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
    type: "response",
    sequence: message.sequence,
    outcome,
    revision,
    command,
    ...(error === undefined ? {} : { error }),
  };
}

export function channelStableMessageId(parts: readonly string[]): string {
  return `channel-${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function requireBase(value: Record<string, unknown>): void {
  if (value.schema !== CHANNEL_ADAPTER_PROTOCOL_SCHEMA) {
    throw new Error("Channel adapter message is invalid");
  }
  requireText(value.adapterEpoch, "adapterEpoch");
  requireText(value.profile, "profile");
  requirePositiveInteger(value.sequence, "channel sequence");
  requireNonNegativeInteger(value.expectedRevision, "channel expected revision");
  requireText(value.stableMessageId, "stableMessageId");
}

function validateCommand(value: unknown): void {
  if (value === null) return;
  const command = requireObject(value, "channel command");
  if (command.kind === "channel.stop") return;
  if (command.kind === "channel.present") {
    requireText(command.stableMessageId, "stableMessageId");
    requireText(command.attemptId, "attemptId");
    validateChannelRequest(command.request);
    return;
  }
  if (command.kind === "channel.settle") {
    requireText(command.stableMessageId, "stableMessageId");
    requireText(command.attemptId, "attemptId");
    validateChannelRequest(command.request);
    requireOneOf(command.outcome, ["accepted", "cancelled", "expired"], "settlement outcome");
    if (command.response !== undefined) validateDecisionResponse(command.response);
    if (!Array.isArray(command.messages)) throw new Error("Channel message references are invalid");
    command.messages.forEach(validateMessageReference);
    return;
  }
  if (command.kind === "channel.poll") {
    requireNonNegativeInteger(command.cursor, "channel cursor");
    if (!Array.isArray(command.requests)) throw new Error("Channel poll requests are invalid");
    command.requests.forEach(validateChannelRequest);
    return;
  }
  throw new Error("Channel adapter command kind is invalid");
}

function validateChannelRequest(value: unknown): void {
  const request = requireObject(value, "human decision channel request");
  if (
    request.schema !== "pi-workflows.human-decision-channel-request.v1" ||
    request.sourceSchema !== "pi-workflows.human-decision-request.v1" ||
    Object.hasOwn(request, "subject")
  ) {
    throw new Error("Human decision channel request is invalid");
  }
  for (const field of [
    "decisionId",
    "requestDigest",
    "runId",
    "workflowName",
    "nodeId",
    "attemptId",
    "audience",
    "title",
    "presentationDigest",
    "createdAt",
  ]) {
    requireText(request[field], field);
  }
  requireNonNegativeInteger(request.revision, "decision revision");
  requireObject(request.presentation, "decision presentation");
  requireObject(request.choices, "decision choices");
  requireOptionalText(request.expiresAt, "decision expiry");
  if (request.defaultResponse !== undefined) validateDecisionResponse(request.defaultResponse);
}

function validateDecisionResponse(value: unknown): void {
  const response = requireObject(value, "human decision response");
  requireText(response.choice, "decision choice");
  if (response.input === undefined) return;
  const input = requireObject(response.input, "decision input");
  if (Object.values(input).some((item) => typeof item !== "string")) {
    throw new Error("Decision input values must be strings");
  }
}

function validateMessageReference(value: unknown): void {
  const reference = requireObject(value, "Telegram message reference");
  requireText(reference.chatId, "Telegram chat ID");
  requireText(reference.messageId, "Telegram message ID");
  requireNonNegativeInteger(reference.recipientIndex, "Telegram recipient index");
  requireNonNegativeInteger(reference.partIndex, "Telegram part index");
  requireText(reference.contentDigest, "Telegram content digest");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
}

function requireOptionalText(value: unknown, label: string): void {
  if (value !== undefined) requireText(value, label);
}

function requirePositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${label} is invalid`);
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function requireOneOf(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is invalid`);
}

function parseObject(frame: Buffer, label: string): Record<string, unknown> {
  let value: JsonValue;
  try {
    value = JSON.parse(frame.toString("utf8")) as JsonValue;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return requireObject(value, label);
}
