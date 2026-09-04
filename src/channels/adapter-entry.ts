import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../state/json.js";
import { errorMessage } from "../workflows/errors.js";
import {
  CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
  channelStableMessageId,
  encodeChannelLine,
  parseChannelAdapterLaunch,
  parseChannelAdapterResponse,
  type ChannelAdapterLaunch,
  type ChannelAdapterMessage,
  type ChannelAdapterResponse,
} from "./protocol.js";
import { TelegramAdapter } from "./telegram.js";

type ChannelAdapterReport = ChannelAdapterMessage extends infer Message
  ? Message extends ChannelAdapterMessage
    ? Omit<Message, "schema" | "adapterEpoch" | "profile" | "sequence" | "expectedRevision">
    : never
  : never;

class AdapterServerConnection {
  private sequence = 0;
  private revision = 0;
  private readonly lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();

  constructor(private readonly launch: ChannelAdapterLaunch) {}

  async report(message: ChannelAdapterReport): Promise<ChannelAdapterResponse> {
    this.sequence += 1;
    const full = {
      schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
      adapterEpoch: this.launch.adapterEpoch,
      profile: this.launch.profile,
      sequence: this.sequence,
      expectedRevision: this.revision,
      ...message,
    } as ChannelAdapterMessage;
    if (!process.stdout.write(encodeChannelLine(full))) {
      await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
    }
    const next = await this.lines.next();
    if (next.done) throw new Error("Workflow server closed the channel adapter connection");
    const response = parseChannelAdapterResponse(Buffer.from(next.value, "utf8"));
    if (response.sequence !== this.sequence) {
      throw new Error("Workflow server returned a mismatched channel response");
    }
    if (response.outcome !== "accepted") {
      throw new Error(response.error ?? "Workflow server rejected the channel adapter message");
    }
    this.revision = response.revision;
    return response;
  }
}

export async function runChannelAdapter(): Promise<number> {
  const launch = readLaunch();
  const server = new AdapterServerConnection(launch);
  const telegram = new TelegramAdapter({
    profile: launch.profile,
    token: launch.token,
    allowedUserIds: launch.allowedUserIds,
    allowedChatIds: launch.allowedChatIds,
    ...(launch.apiBase === undefined ? {} : { apiBase: launch.apiBase }),
  });
  let cursor = 0;
  let controlSequence = 0;
  const controlId = (kind: "ready" | "exiting") => {
    controlSequence += 1;
    return channelStableMessageId([
      launch.adapterEpoch,
      kind,
      String(controlSequence),
      String(cursor),
    ]);
  };
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });

  let response = await server.report({
    kind: "channel.ready",
    stableMessageId: controlId("ready"),
    cursor,
  });
  while (!stopping) {
    const command = response.command;
    if (command === null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await server.report({
        kind: "channel.ready",
        stableMessageId: controlId("ready"),
        cursor,
      });
      continue;
    }
    if (command.kind === "channel.stop") {
      stopping = true;
      break;
    }
    if (command.kind === "channel.present") {
      try {
        const messages = await telegram.present(command.request);
        response = await server.report({
          kind: "channel.present",
          stableMessageId: command.stableMessageId,
          decisionId: command.request.decisionId,
          requestDigest: command.request.requestDigest,
          attemptId: command.attemptId,
          state: "confirmed",
          messages,
        });
      } catch (error) {
        response = await server.report({
          kind: "channel.present",
          stableMessageId: command.stableMessageId,
          decisionId: command.request.decisionId,
          requestDigest: command.request.requestDigest,
          attemptId: command.attemptId,
          state: "unknown",
          messages: [],
          errorCode: errorMessage(error),
        });
      }
      continue;
    }
    if (command.kind === "channel.settle") {
      try {
        await telegram.settle(command.outcome, command.response, command.messages);
        response = await server.report({
          kind: "channel.settle",
          stableMessageId: command.stableMessageId,
          decisionId: command.request.decisionId,
          requestDigest: command.request.requestDigest,
          attemptId: command.attemptId,
          state: "confirmed",
        });
      } catch (error) {
        response = await server.report({
          kind: "channel.settle",
          stableMessageId: command.stableMessageId,
          decisionId: command.request.decisionId,
          requestDigest: command.request.requestDigest,
          attemptId: command.attemptId,
          state: "unknown",
          errorCode: errorMessage(error),
        });
      }
      continue;
    }

    telegram.setRequests(command.requests);
    const polled = await telegram.poll(command.cursor);
    cursor = polled.cursor;
    for (const answer of polled.answers) {
      await server.report({
        kind: "channel.answer",
        stableMessageId: channelStableMessageId([
          launch.profile,
          answer.request.decisionId,
          answer.eventId,
        ]),
        decisionId: answer.request.decisionId,
        requestDigest: answer.request.requestDigest,
        response: answer.response,
        actorId: answer.actorId,
        chatId: answer.chatId,
        eventId: answer.eventId,
        idempotencyKey: `telegram:${launch.profile}:${answer.eventId}`,
        cursor,
      });
    }
    response = await server.report({
      kind: "channel.ready",
      stableMessageId: controlId("ready"),
      cursor,
    });
  }

  await server.report({
    kind: "channel.exiting",
    stableMessageId: controlId("exiting"),
    cursor,
  });
  return 0;
}

function readLaunch(): ChannelAdapterLaunch {
  const encoded = process.env.PI_WORKFLOWS_CHANNEL_LAUNCH;
  if (encoded === undefined) throw new Error("Channel adapter launch envelope is missing");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Channel adapter launch envelope is invalid");
  }
  return parseChannelAdapterLaunch(value);
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runChannelAdapter();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

export function encodeChannelLaunch(launch: ChannelAdapterLaunch): string {
  return Buffer.from(canonicalJson(launch)).toString("base64url");
}
