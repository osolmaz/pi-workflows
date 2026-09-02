import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_PROTOCOL_SCHEMA,
  MAX_PROTOCOL_MESSAGE_BYTES,
  NdjsonFrameDecoder,
  clientRequestFingerprint,
  encodeProtocolLine,
  encodeProtocolMessage,
  parseClientMessage,
  parseClientRequest,
  parseClientResponse,
  type ClientEvent,
  type ClientRequest,
  type ClientResponse,
} from "../src/client/protocol.js";
import { canonicalJson } from "../src/state/json.js";

type ProtocolFixture = {
  valid: string[];
  invalid: string[];
};

const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "protocol/fixtures/client-v1.json"), "utf8"),
) as ProtocolFixture;

const request: ClientRequest = {
  schema: CLIENT_PROTOCOL_SCHEMA,
  type: "request",
  requestId: "request-1",
  clientId: "client-1",
  operation: "host.status",
  idempotencyKey: "request-1",
  payload: {},
};

const response: ClientResponse = {
  schema: CLIENT_PROTOCOL_SCHEMA,
  type: "response",
  requestId: "request-1",
  outcome: "accepted",
};

const event: ClientEvent = {
  schema: CLIENT_PROTOCOL_SCHEMA,
  type: "event",
  subscriptionId: "subscription-1",
  event: "runs",
  payload: {},
};

function expectInvalid(value: unknown): void {
  expect(() => parseClientMessage(canonicalJson(value))).toThrow();
}

describe("client protocol fixtures", () => {
  it("accepts every shared valid fixture", () => {
    for (const line of fixture.valid) expect(() => parseClientMessage(line)).not.toThrow();
  });

  it("rejects every shared invalid fixture", () => {
    for (const line of fixture.invalid) expect(() => parseClientMessage(line)).toThrow();
  });

  it("enforces the encoded message and line size limits", () => {
    const empty = encodeProtocolMessage({ ...request, payload: "" }).byteLength;
    const atLimit = {
      ...request,
      payload: "x".repeat(MAX_PROTOCOL_MESSAGE_BYTES - empty),
    };
    expect(encodeProtocolMessage(atLimit).byteLength).toBe(MAX_PROTOCOL_MESSAGE_BYTES);
    expect(() => encodeProtocolLine(atLimit)).toThrow("exceeds 1 MiB");
    expect(() => encodeProtocolMessage({ ...atLimit, payload: `${atLimit.payload}x` })).toThrow(
      "exceeds 1 MiB",
    );
  });

  it("parses only the requested envelope type", () => {
    expect(parseClientRequest(canonicalJson(request))).toEqual(request);
    expect(parseClientResponse(canonicalJson(response))).toEqual(response);
    expect(() => parseClientRequest(canonicalJson(response))).toThrow("Expected client request");
    expect(() => parseClientResponse(canonicalJson(request))).toThrow("Expected client response");
  });

  it("rejects malformed, noncanonical, and non-object messages", () => {
    expect(() => parseClientMessage("{")).toThrow("not valid canonical JSON");
    expect(() => parseClientMessage("[]")).toThrow("must be an object");
    expect(() =>
      parseClientMessage(
        JSON.stringify({
          type: "hello",
          schema: CLIENT_PROTOCOL_SCHEMA,
          connectionId: "c",
          packageVersion: "1",
        }),
      ),
    ).toThrow("canonical JSON");
    expect(() => parseClientMessage(Buffer.alloc(MAX_PROTOCOL_MESSAGE_BYTES + 1))).toThrow(
      "exceeds 1 MiB",
    );
  });

  it("rejects invalid fields in each envelope", () => {
    const invalid = [
      { ...request, type: "unknown" },
      { ...request, extra: true },
      { ...request, requestId: "" },
      { ...request, clientId: "x".repeat(257) },
      { ...request, idempotencyKey: 1 },
      { ...request, operation: "unknown" },
      { ...request, runId: "" },
      { ...request, expectedRevision: -1 },
      { ...request, payload: undefined },
      { ...response, outcome: "unknown" },
      { ...response, revision: 1.5 },
      { ...response, error: "" },
      { ...event, subscriptionId: "" },
      { ...event, event: "unknown" },
      { ...event, revision: -1 },
      { ...event, runId: "" },
      { ...event, payload: undefined },
      {
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "hello",
        connectionId: "",
        packageVersion: "1",
      },
      {
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "hello",
        connectionId: "connection-1",
        packageVersion: "",
      },
    ];
    for (const value of invalid) expectInvalid(value);
  });

  it("frames split messages and rejects oversized frames", () => {
    const decoder = new NdjsonFrameDecoder();
    const line = encodeProtocolLine(request);
    expect(decoder.push(line.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([line.subarray(3), Buffer.from("\n")]))).toEqual([
      encodeProtocolMessage(request),
    ]);

    expect(() =>
      new NdjsonFrameDecoder().push(Buffer.alloc(MAX_PROTOCOL_MESSAGE_BYTES + 1, 0x78)),
    ).toThrow("exceeds 1 MiB");
    expect(() =>
      new NdjsonFrameDecoder().push(
        Buffer.concat([Buffer.alloc(MAX_PROTOCOL_MESSAGE_BYTES, 0x78), Buffer.from("\n")]),
      ),
    ).toThrow("exceeds 1 MiB");
  });

  it("creates stable durable request fingerprints", () => {
    expect(clientRequestFingerprint(request)).toEqual(clientRequestFingerprint({ ...request }));
    expect(clientRequestFingerprint({ ...request, requestId: "request-2" })).toEqual(
      clientRequestFingerprint(request),
    );
    expect(clientRequestFingerprint({ ...request, payload: { changed: true } })).not.toEqual(
      clientRequestFingerprint(request),
    );
  });
});
