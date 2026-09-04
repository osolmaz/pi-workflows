import { describe, expect, it } from "vitest";
import {
  boundWorkerResponse,
  materializeWorkerContent,
  readWorkerContentChunk,
} from "../src/host/worker-content.js";
import {
  MAX_WORKER_PROTOCOL_MESSAGE_BYTES,
  WORKER_STORE_OPERATIONS,
  encodeWorkerLine,
  isWorkerContentReference,
  parseWorkerMessage,
  type WorkerResponse,
} from "../src/host/worker-protocol.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson, type JsonValue } from "../src/state/json.js";
import { makeStateDatabasePath } from "./helpers.js";

function accepted(result: JsonValue): WorkerResponse {
  return {
    schema: "pi-workflows.worker-response.v1",
    messageId: "message-1",
    outcome: "accepted",
    revision: 4,
    result,
  };
}

describe("workflow worker content", () => {
  it("rejects the removed complete-run read operation", () => {
    expect(WORKER_STORE_OPERATIONS).toContain("store.readRunState");
    expect(WORKER_STORE_OPERATIONS).not.toContain("store.readRun");
    expect(() =>
      parseWorkerMessage(
        canonicalJson({
          schema: "pi-workflows.worker-message.v1",
          launchSchema: "pi-workflows.worker-launch.v1",
          messageId: "message-1",
          kind: "worker.progress",
          operation: "store.readRun",
          runId: "run-1",
          generation: 1,
          workerEpoch: "epoch-1",
          expectedRevision: 0,
          payload: { runId: "run-1" },
        }),
      ),
    ).toThrow(/Invalid worker operation/);
  });

  it("keeps small results inline", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-inline") });
    const allowed = new Set<string>();
    const response = accepted({ value: "small" });

    expect(boundWorkerResponse(state, allowed, response)).toEqual(response);
    expect(allowed.size).toBe(0);
    state.close();
  });

  it("keeps the exact frame boundary inline and references one byte over it", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-boundary") });
    const allowed = new Set<string>();
    const empty = accepted({ value: "" });
    const fittingBytes = MAX_WORKER_PROTOCOL_MESSAGE_BYTES - encodeWorkerLine(empty).byteLength;
    const fitting = accepted({ value: "x".repeat(fittingBytes) });
    expect(encodeWorkerLine(fitting).byteLength).toBe(MAX_WORKER_PROTOCOL_MESSAGE_BYTES);
    expect(boundWorkerResponse(state, allowed, fitting)).toEqual(fitting);

    const oversized = accepted({ value: "x".repeat(fittingBytes + 1) });
    expect(() => encodeWorkerLine(oversized)).toThrow(/exceeds 1 MiB/);
    const bounded = boundWorkerResponse(state, allowed, oversized);
    expect(isWorkerContentReference(bounded.result)).toBe(true);
    expect(encodeWorkerLine(bounded).byteLength).toBeLessThanOrEqual(
      MAX_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    state.close();
  });

  it("transfers a large result through verified bounded chunks", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-large") });
    const allowed = new Set<string>();
    const original = { value: "x".repeat(2 * 1024 * 1024) };
    const response = boundWorkerResponse(state, allowed, accepted(original));

    expect(encodeWorkerLine(response).byteLength).toBeLessThanOrEqual(
      MAX_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    expect(isWorkerContentReference(response.result)).toBe(true);
    if (!isWorkerContentReference(response.result)) throw new Error("content reference missing");
    const reference = response.result;
    expect(allowed).toEqual(new Set([reference.sha256]));

    const offsets: number[] = [];
    const loaded = await materializeWorkerContent(reference, async (offset) => {
      offsets.push(offset);
      const chunk = readWorkerContentChunk(state, allowed, reference.sha256, offset);
      expect(encodeWorkerLine(accepted(chunk)).byteLength).toBeLessThanOrEqual(
        MAX_WORKER_PROTOCOL_MESSAGE_BYTES,
      );
      return chunk;
    });

    expect(offsets.length).toBeGreaterThan(1);
    expect(loaded).toEqual(original);
    state.close();
  });

  it("rejects unapproved content and invalid offsets", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-invalid") });
    const digest = state.putJson({ value: true }).toString("hex");

    expect(() => readWorkerContentChunk(state, new Set(), digest, 0)).toThrow(/unavailable/);
    expect(() => readWorkerContentChunk(state, new Set([digest]), digest, 1_000)).toThrow(
      /offset is invalid/,
    );
    state.close();
  });

  it("rejects changed content metadata before parsing", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-changed") });
    const allowed = new Set<string>();
    const response = boundWorkerResponse(
      state,
      allowed,
      accepted({ value: "x".repeat(2 * 1024 * 1024) }),
    );
    if (!isWorkerContentReference(response.result)) throw new Error("content reference missing");
    const reference = response.result;

    await expect(
      materializeWorkerContent(reference, async (offset) => ({
        ...readWorkerContentChunk(state, allowed, reference.sha256, offset),
        bytes: reference.bytes + 1,
      })),
    ).rejects.toThrow(/chunk is invalid/);
    state.close();
  });

  it("rejects missing or malformed stored JSON", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-malformed") });
    const malformed = Buffer.from("not-json", "utf8");
    const digest = state.putBlob(malformed, "application/json").toString("hex");
    const reference = {
      schema: "pi-workflows.worker-content-reference.v1" as const,
      sha256: digest,
      mediaType: "application/json" as const,
      bytes: malformed.byteLength,
    };

    await expect(
      materializeWorkerContent(reference, async (offset) =>
        readWorkerContentChunk(state, new Set([digest]), digest, offset),
      ),
    ).rejects.toThrow();
    state.close();
  });

  it("returns a bounded rejection when an error response is too large", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-error") });
    const response = boundWorkerResponse(state, new Set(), {
      schema: "pi-workflows.worker-response.v1",
      messageId: "message-1",
      outcome: "rejected",
      error: "x".repeat(2 * 1024 * 1024),
    });

    expect(response).toMatchObject({ outcome: "rejected" });
    expect(response.error).toMatch(/could not be transferred/);
    expect(encodeWorkerLine(response).byteLength).toBeLessThanOrEqual(
      MAX_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    state.close();
  });
});
