import { describe, expect, it, vi } from "vitest";
import { RemoteSessionRecordingStore } from "../src/extension/remote-recorder-store.js";
import type { WorkflowSessionBinding, WorkflowSessionCapture } from "../src/workflows/types.js";

const binding: WorkflowSessionBinding = {
  schema: "pi-workflows.session-binding.v1",
  runId: "run-1",
  piSessionId: "session-1",
  cwd: "/tmp/project",
  boundAt: "2026-09-02T00:00:00.000Z",
};

const capture: WorkflowSessionCapture = {
  schema: "pi-workflows.session-capture.v1",
  eventSchema: "pi-workflows.session-event.v1",
  status: "recording",
  eventCount: 0,
  entryCount: 0,
  lastEventSeq: 0,
};

function createStore(receipts: Array<Record<string, unknown> | Error>) {
  const requestDurable = vi.fn(async () => {
    const value = receipts.shift();
    if (value instanceof Error) throw value;
    return { outcome: "accepted", receipt: value ?? {} };
  });
  return {
    store: new RemoteSessionRecordingStore({ requestDurable } as never, () => ({
      targetSessionId: "session-1",
      coordinatorEpoch: "epoch-1",
    })),
    requestDurable,
  };
}

describe("RemoteSessionRecordingStore", () => {
  it("sends every recording operation through one durable host command", async () => {
    const { store, requestDurable } = createStore([
      { bound: true },
      {},
      {},
      { entrySequence: 4 },
      {},
      { eventCount: 3, entryCount: 4, lastEventSeq: 3 },
    ]);

    await expect(store.hasSessionBinding("run-1")).resolves.toBe(true);
    await store.writeSessionBinding("run-1", binding, "segment-1");
    await store.writeSessionCapture("run-1", capture);
    await expect(
      store.appendSessionEntry("run-1", { id: "entry-1", message: { role: "assistant" } }),
    ).resolves.toBe(4);
    await store.appendSessionEventBatch(
      "run-1",
      [
        {
          seq: 1,
          at: "2026-09-02T00:00:00.000Z",
          nodeId: "step",
          attemptId: "attempt-1",
          turnId: "turn-1",
          type: "turn_started",
          payload: { turnIndex: 1 },
        },
      ],
      "segment-1",
    );
    await expect(store.sessionCounts("run-1", "segment-1")).resolves.toEqual({
      eventCount: 3,
      entryCount: 4,
      lastEventSeq: 3,
    });

    expect(requestDurable).toHaveBeenCalledTimes(6);
    expect(requestDurable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: "session.record",
        runId: "run-1",
        payload: expect.objectContaining({
          action: "bind",
          targetSessionId: "session-1",
          coordinatorEpoch: "epoch-1",
          attemptId: "segment-1",
        }),
      }),
    );
  });

  it("rejects malformed host outcomes and receipts", async () => {
    const rejectedClient = {
      requestDurable: vi.fn(async () => ({ outcome: "rejected", error: "denied" })),
    };
    const rejected = new RemoteSessionRecordingStore(rejectedClient as never, () => ({
      targetSessionId: "session-1",
      coordinatorEpoch: "epoch-1",
    }));
    await expect(rejected.hasSessionBinding("run-1")).rejects.toThrow("denied");

    const invalidReceiptClient = {
      requestDurable: vi.fn(async () => ({ outcome: "accepted", receipt: [] })),
    };
    const invalidReceipt = new RemoteSessionRecordingStore(invalidReceiptClient as never, () => ({
      targetSessionId: "session-1",
      coordinatorEpoch: "epoch-1",
    }));
    await expect(invalidReceipt.hasSessionBinding("run-1")).rejects.toThrow(
      "Session recording receipt is invalid",
    );

    for (const receipt of [{ bound: "yes" }, { entrySequence: 0 }, { eventCount: -1 }]) {
      const { store } = createStore([receipt]);
      const operation =
        "bound" in receipt
          ? store.hasSessionBinding("run-1")
          : "entrySequence" in receipt
            ? store.appendSessionEntry("run-1", { id: "entry-1" })
            : store.sessionCounts("run-1");
      await expect(operation).rejects.toThrow("Session recording");
    }

    const { store } = createStore([{ eventCount: 1, entryCount: "bad", lastEventSeq: 1 }]);
    await expect(store.sessionCounts("run-1")).rejects.toThrow(
      "Session recording entryCount is invalid",
    );
  });
});
