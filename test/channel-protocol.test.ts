import { describe, expect, it } from "vitest";
import {
  CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
  channelResponse,
  channelStableMessageId,
  encodeChannelLine,
  parseChannelAdapterLaunch,
  parseChannelAdapterMessage,
  parseChannelAdapterResponse,
  type ChannelAdapterResponse,
} from "../src/channels/protocol.js";
import type { HumanDecisionChannelRequest } from "../src/workflows/types.js";

function request(): HumanDecisionChannelRequest {
  return {
    schema: "pi-workflows.human-decision-channel-request.v1",
    sourceSchema: "pi-workflows.human-decision-request.v1",
    decisionId: "decision-1",
    requestDigest: `sha256:${"1".repeat(64)}`,
    runId: "run-1",
    workflowName: "test",
    nodeId: "approve",
    attemptId: "attempt-1",
    audience: "operator",
    title: "Continue?",
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "Choose.",
      blocks: [],
    },
    presentationDigest: `sha256:${"2".repeat(64)}`,
    revision: 1,
    choices: {
      continue: { label: "Continue" },
    },
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function frame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe("channel adapter protocol", () => {
  it("accepts a complete typed message", () => {
    expect(
      parseChannelAdapterMessage(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          adapterEpoch: "adapter-1",
          profile: "approval",
          sequence: 1,
          expectedRevision: 0,
          stableMessageId: "ready-1",
          kind: "channel.ready",
          cursor: 0,
        }),
      ),
    ).toMatchObject({ kind: "channel.ready", cursor: 0 });
  });

  it("rejects malformed child fields before the host handles them", () => {
    expect(() =>
      parseChannelAdapterMessage(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          adapterEpoch: "adapter-1",
          profile: "approval",
          sequence: 1,
          expectedRevision: 0,
          stableMessageId: "answer-1",
          kind: "channel.answer",
          decisionId: "decision-1",
          requestDigest: "digest",
          response: { choice: "continue", input: { reason: 42 } },
          actorId: "100",
          chatId: "-200",
          eventId: "event-1",
          idempotencyKey: "answer-1",
          cursor: 1,
        }),
      ),
    ).toThrow("Decision input values must be strings");
  });

  it("rejects a host command that exposes the private decision subject", () => {
    const response: ChannelAdapterResponse = {
      schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
      type: "response",
      sequence: 1,
      outcome: "accepted",
      revision: 2,
      command: {
        kind: "channel.present",
        stableMessageId: "present-1",
        attemptId: "attempt-1",
        request: request(),
      },
    };
    const exposed = {
      ...response,
      command: {
        ...response.command,
        request: { ...request(), subject: { private: true } },
      },
    };
    expect(() => parseChannelAdapterResponse(frame(exposed))).toThrow(
      "Human decision channel request is invalid",
    );
  });

  it("accepts every child result kind", () => {
    const base = {
      schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
      adapterEpoch: "adapter-1",
      profile: "approval",
      sequence: 2,
      expectedRevision: 1,
      stableMessageId: "message-1",
    };
    const reference = {
      chatId: "-200",
      messageId: "10",
      recipientIndex: 0,
      partIndex: 0,
      contentDigest: "sha256:content",
    };
    const messages = [
      { ...base, kind: "channel.exiting", cursor: 3 },
      {
        ...base,
        kind: "channel.present",
        decisionId: "decision-1",
        requestDigest: "digest-1",
        attemptId: "attempt-1",
        state: "confirmed",
        messages: [reference],
      },
      {
        ...base,
        kind: "channel.present",
        decisionId: "decision-1",
        requestDigest: "digest-1",
        attemptId: "attempt-1",
        state: "failed",
        messages: [],
        errorCode: "rejected",
      },
      {
        ...base,
        kind: "channel.answer",
        decisionId: "decision-1",
        requestDigest: "digest-1",
        response: { choice: "replan", input: { instructions: "smaller" } },
        actorId: "100",
        chatId: "-200",
        eventId: "event-1",
        idempotencyKey: "answer-1",
        cursor: 4,
      },
      {
        ...base,
        kind: "channel.settle",
        decisionId: "decision-1",
        requestDigest: "digest-1",
        attemptId: "attempt-1",
        state: "unknown",
      },
    ];
    for (const message of messages) {
      expect(parseChannelAdapterMessage(frame(message))).toMatchObject({ kind: message.kind });
    }
  });

  it("accepts every host command kind", () => {
    const reference = {
      chatId: "-200",
      messageId: "10",
      recipientIndex: 0,
      partIndex: 0,
      contentDigest: "sha256:content",
    };
    const commands = [
      null,
      { kind: "channel.stop" },
      {
        kind: "channel.present",
        stableMessageId: "present-1",
        attemptId: "attempt-1",
        request: { ...request(), expiresAt: "2026-09-03T00:00:00.000Z" },
      },
      {
        kind: "channel.settle",
        stableMessageId: "settle-1",
        attemptId: "attempt-1",
        request: { ...request(), defaultResponse: { choice: "continue" } },
        outcome: "accepted",
        response: { choice: "continue" },
        messages: [reference],
      },
      { kind: "channel.poll", cursor: 4, requests: [request()] },
    ];
    for (const command of commands) {
      expect(
        parseChannelAdapterResponse(
          frame({
            schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
            type: "response",
            sequence: 1,
            outcome: "accepted",
            revision: 2,
            command,
          }),
        ).command,
      ).toEqual(command);
    }
  });

  it("rejects invalid envelopes, kinds, commands, and references", () => {
    expect(() => parseChannelAdapterMessage(frame([]))).toThrow("must be an object");
    expect(() => parseChannelAdapterMessage(Buffer.from("{"))).toThrow("not valid JSON");
    expect(() =>
      parseChannelAdapterMessage(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          adapterEpoch: "adapter-1",
          profile: "approval",
          sequence: 0,
          expectedRevision: 0,
          stableMessageId: "message-1",
          kind: "channel.ready",
          cursor: 0,
        }),
      ),
    ).toThrow("channel sequence is invalid");
    expect(() =>
      parseChannelAdapterMessage(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          adapterEpoch: "adapter-1",
          profile: "approval",
          sequence: 1,
          expectedRevision: 0,
          stableMessageId: "message-1",
          kind: "channel.other",
        }),
      ),
    ).toThrow("kind is invalid");
    expect(() =>
      parseChannelAdapterResponse(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          type: "response",
          sequence: 1,
          outcome: "accepted",
          revision: 0,
          command: { kind: "channel.other" },
        }),
      ),
    ).toThrow("command kind is invalid");
    expect(() =>
      parseChannelAdapterResponse(
        frame({
          schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
          type: "response",
          sequence: 1,
          outcome: "accepted",
          revision: 0,
          command: {
            kind: "channel.settle",
            stableMessageId: "settle-1",
            attemptId: "attempt-1",
            request: request(),
            outcome: "cancelled",
            messages: [{ chatId: "-200", messageId: "10", recipientIndex: -1, partIndex: 0 }],
          },
        }),
      ),
    ).toThrow("recipient index is invalid");
  });

  it("validates the private launch envelope and helper output", () => {
    const launch = {
      schema: "pi-workflows.channel-adapter-launch.v1",
      adapterEpoch: "adapter-1",
      profile: "approval",
      token: "private-token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      apiBase: "https://telegram.invalid",
    };
    expect(parseChannelAdapterLaunch(launch)).toMatchObject({ profile: "approval" });
    expect(() =>
      parseChannelAdapterLaunch({
        schema: "pi-workflows.channel-adapter-launch.v1",
        adapterEpoch: "adapter-1",
        profile: "approval",
        allowedUserIds: ["100"],
        allowedChatIds: ["-200"],
      }),
    ).toThrow("token is invalid");
    expect(() => parseChannelAdapterLaunch({ schema: "wrong" })).toThrow("envelope is invalid");
    expect(() => parseChannelAdapterLaunch({ ...launch, allowedUserIds: [] })).toThrow(
      "allowedUserIds is invalid",
    );

    const ready = parseChannelAdapterMessage(
      frame({
        schema: CHANNEL_ADAPTER_PROTOCOL_SCHEMA,
        adapterEpoch: "adapter-1",
        profile: "approval",
        sequence: 1,
        expectedRevision: 0,
        stableMessageId: "ready-1",
        kind: "channel.ready",
        cursor: 0,
      }),
    );
    expect(channelResponse(ready, "rejected", 2, null, "stop")).toMatchObject({ error: "stop" });
    expect(encodeChannelLine(channelResponse(ready, "accepted", 2, null)).toString()).toMatch(
      /\n$/u,
    );
    expect(channelStableMessageId(["a", "b"])).toMatch(/^channel-[0-9a-f]{64}$/u);
  });
});
