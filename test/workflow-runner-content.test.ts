import { describe, expect, it } from "vitest";
import {
  boundRunnerResponse,
  materializeRunnerContent,
  readRunnerContentChunk,
} from "../src/server/workflow-runner-content.js";
import {
  MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
  WORKFLOW_RUNNER_STORE_OPERATIONS,
  encodeRunnerLine,
  isRunnerContentReference,
  parseRunnerMessage,
  type WorkflowRunnerResponse,
} from "../src/server/workflow-runner-protocol.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson, type JsonValue } from "../src/state/json.js";
import { makeStateDatabasePath } from "./helpers.js";

function accepted(result: JsonValue): WorkflowRunnerResponse {
  return {
    schema: "pi-workflows.worker-response.v1",
    messageId: "message-1",
    outcome: "accepted",
    revision: 4,
    result,
  };
}

describe("workflow runner content", () => {
  it("rejects the removed complete-run read operation", () => {
    expect(WORKFLOW_RUNNER_STORE_OPERATIONS).toContain("store.readRunState");
    expect(WORKFLOW_RUNNER_STORE_OPERATIONS).not.toContain("store.readRun");
    expect(() =>
      parseRunnerMessage(
        canonicalJson({
          schema: "pi-workflows.worker-message.v1",
          launchSchema: "pi-workflows.worker-launch.v1",
          messageId: "message-1",
          kind: "runner.progress",
          operation: "store.readRun",
          runId: "run-1",
          generation: 1,
          runnerEpoch: "epoch-1",
          expectedRevision: 0,
          payload: { runId: "run-1" },
        }),
      ),
    ).toThrow(/Invalid workflow runner operation/);
  });

  it("keeps small results inline", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-inline") });
    const allowed = new Set<string>();
    const response = accepted({ value: "small" });

    expect(boundRunnerResponse(state, allowed, response)).toEqual(response);
    expect(allowed.size).toBe(0);
    state.close();
  });

  it("keeps the exact frame boundary inline and references one byte over it", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-boundary") });
    const allowed = new Set<string>();
    const empty = accepted({ value: "" });
    const fittingBytes =
      MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES - encodeRunnerLine(empty).byteLength;
    const fitting = accepted({ value: "x".repeat(fittingBytes) });
    expect(encodeRunnerLine(fitting).byteLength).toBe(MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES);
    expect(boundRunnerResponse(state, allowed, fitting)).toEqual(fitting);

    const oversized = accepted({ value: "x".repeat(fittingBytes + 1) });
    expect(() => encodeRunnerLine(oversized)).toThrow(/exceeds 1 MiB/);
    const bounded = boundRunnerResponse(state, allowed, oversized);
    expect(isRunnerContentReference(bounded.result)).toBe(true);
    expect(encodeRunnerLine(bounded).byteLength).toBeLessThanOrEqual(
      MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
    );
    state.close();
  });

  it("transfers a large result through verified bounded chunks", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-large") });
    const allowed = new Set<string>();
    const original = { value: "x".repeat(2 * 1024 * 1024) };
    const response = boundRunnerResponse(state, allowed, accepted(original));

    expect(encodeRunnerLine(response).byteLength).toBeLessThanOrEqual(
      MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
    );
    expect(isRunnerContentReference(response.result)).toBe(true);
    if (!isRunnerContentReference(response.result)) throw new Error("content reference missing");
    const reference = response.result;
    expect(allowed).toEqual(new Set([reference.sha256]));

    const offsets: number[] = [];
    const loaded = await materializeRunnerContent(reference, async (offset) => {
      offsets.push(offset);
      const chunk = readRunnerContentChunk(state, allowed, reference.sha256, offset);
      expect(encodeRunnerLine(accepted(chunk)).byteLength).toBeLessThanOrEqual(
        MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
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

    expect(() => readRunnerContentChunk(state, new Set(), digest, 0)).toThrow(/unavailable/);
    expect(() => readRunnerContentChunk(state, new Set([digest]), digest, 1_000)).toThrow(
      /offset is invalid/,
    );
    state.close();
  });

  it("rejects changed content metadata before parsing", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-changed") });
    const allowed = new Set<string>();
    const response = boundRunnerResponse(
      state,
      allowed,
      accepted({ value: "x".repeat(2 * 1024 * 1024) }),
    );
    if (!isRunnerContentReference(response.result)) throw new Error("content reference missing");
    const reference = response.result;

    await expect(
      materializeRunnerContent(reference, async (offset) => ({
        ...readRunnerContentChunk(state, allowed, reference.sha256, offset),
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
      materializeRunnerContent(reference, async (offset) =>
        readRunnerContentChunk(state, new Set([digest]), digest, offset),
      ),
    ).rejects.toThrow();
    state.close();
  });

  it("returns a bounded rejection when an error response is too large", async () => {
    const state = new StateDatabase({ filePath: await makeStateDatabasePath("worker-error") });
    const response = boundRunnerResponse(state, new Set(), {
      schema: "pi-workflows.worker-response.v1",
      messageId: "message-1",
      outcome: "rejected",
      error: "x".repeat(2 * 1024 * 1024),
    });

    expect(response).toMatchObject({ outcome: "rejected" });
    expect(response.error).toMatch(/could not be transferred/);
    expect(encodeRunnerLine(response).byteLength).toBeLessThanOrEqual(
      MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
    );
    state.close();
  });
});
