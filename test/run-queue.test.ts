import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { makeTempDir } from "./helpers.js";

const T0 = "2026-08-04T00:00:00.000Z";
const T1 = "2026-08-04T00:00:01.000Z";
const T2 = "2026-08-04T00:00:02.000Z";
const T3 = "2026-08-04T00:00:03.000Z";

const stores: SqliteControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function makeStore(): Promise<SqliteControllerStore> {
  const dir = await makeTempDir("pi-run-queue");
  const store = new SqliteControllerStore(path.join(dir, "state", "controller.sqlite"));
  stores.push(store);
  return store;
}

function enqueue(store: SqliteControllerStore, runId = "run-1") {
  return store.enqueueWorkflowRun({
    runId,
    workflowRef: "summarize",
    workflowPath: "/project/.pi/workflows/summarize.workflow.ts",
    input: { task: "hello" },
    runnerId: "runner-a",
    claimToken: "token-a",
    leaseMs: 1_000,
    now: T0,
  });
}

describe("workflow run queue", () => {
  it("inserts and claims a run atomically", async () => {
    const store = await makeStore();
    const record = enqueue(store);
    expect(record).toMatchObject({
      runId: "run-1",
      workflowRef: "summarize",
      input: { task: "hello" },
      status: "claimed",
      runnerId: "runner-a",
      claimToken: "token-a",
      affinityRunnerId: "runner-a",
      parentRunId: null,
      createdAt: T0,
    });
    expect(Date.parse(record.claimExpiresAt as string)).toBe(Date.parse(T0) + 1_000);
    // The fresh claim is live: nothing else can claim it.
    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-b",
        claimToken: "token-b",
        leaseMs: 1_000,
        now: T0,
      }),
    ).toBeUndefined();
  });

  it("rejects duplicate run ids and unsafe inputs", async () => {
    const store = await makeStore();
    enqueue(store);
    expect(() => enqueue(store)).toThrow();
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "../escape",
        workflowRef: "x",
        workflowPath: "/x",
        input: {},
        runnerId: "runner-a",
        claimToken: "token-a",
        leaseMs: 1_000,
      }),
    ).toThrow(/Invalid workflow run id/);
  });

  it("renews, verifies, and strictly rejects expired renewals", async () => {
    const store = await makeStore();
    store.enqueueWorkflowRun({
      runId: "run-1",
      workflowRef: "summarize",
      workflowPath: "/project/.pi/workflows/summarize.workflow.ts",
      input: null,
      runnerId: "runner-a",
      claimToken: "token-a",
      leaseMs: 10_000,
      now: T0,
    });
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "token-a", now: T1 })).toBe(
      true,
    );
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "wrong", now: T1 })).toBe(
      false,
    );

    expect(
      store.renewWorkflowRunClaim({
        runId: "run-1",
        claimToken: "token-a",
        leaseMs: 2_000,
        now: T1,
      }),
    ).toBe(true);
    expect(store.getWorkflowRun("run-1")?.claimExpiresAt).toBe(
      new Date(Date.parse(T1) + 2_000).toISOString(),
    );
    expect(
      store.renewWorkflowRunClaim({ runId: "run-1", claimToken: "wrong", leaseMs: 2_000, now: T1 }),
    ).toBe(false);
    // The lease expired at T1+2s; a renewal at T3 is strictly rejected.
    expect(
      store.renewWorkflowRunClaim({
        runId: "run-1",
        claimToken: "token-a",
        leaseMs: 2_000,
        now: T3,
      }),
    ).toBe(false);
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "token-a", now: T3 })).toBe(
      false,
    );
  });

  it("parks a run and lets another runner claim it, preferring affinity", async () => {
    const store = await makeStore();
    enqueue(store, "run-1");
    store.enqueueWorkflowRun({
      runId: "run-2",
      workflowRef: "other",
      workflowPath: "/other.ts",
      input: null,
      runnerId: "runner-c",
      claimToken: "token-c",
      leaseMs: 1,
      affinityRunnerId: "runner-b",
      now: T1,
    });
    expect(store.parkWorkflowRun({ runId: "run-1", claimToken: "token-a", now: T1 })).toBe(true);
    expect(store.getWorkflowRun("run-1")).toMatchObject({
      status: "parked",
      runnerId: null,
      claimToken: null,
    });
    // run-2 is parked by expiry at T2 (lease was 1ms) and has affinity to runner-b.
    store.parkWorkflowRun({ runId: "run-2", claimToken: "token-c", now: T2 });
    const claimed = store.claimNextWorkflowRun({
      runnerId: "runner-b",
      claimToken: "token-b",
      leaseMs: 10_000,
      now: T2,
    });
    expect(claimed?.runId).toBe("run-2");
    // run-1 remains claimable by anyone later.
    const next = store.claimNextWorkflowRun({
      runnerId: "runner-b",
      claimToken: "token-b2",
      leaseMs: 1_000,
      now: T3,
    });
    expect(next?.runId).toBe("run-1");
  });

  it("reclaims a claimed row once its lease expires", async () => {
    const store = await makeStore();
    enqueue(store); // claimed by runner-a at T0 with a 1s lease
    // While the lease is live, nobody can take the run.
    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-b",
        claimToken: "token-b",
        leaseMs: 1_000,
        now: "2026-08-04T00:00:00.500Z",
      }),
    ).toBeUndefined();
    // The runner dies without releasing; at T2 the lease has expired and
    // another runner takes over. The stale token is now fenced out.
    const claimed = store.claimNextWorkflowRun({
      runnerId: "runner-b",
      claimToken: "token-b",
      leaseMs: 5_000,
      now: T2,
    });
    expect(claimed).toMatchObject({
      runId: "run-1",
      status: "claimed",
      runnerId: "runner-b",
      claimToken: "token-b",
    });
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "token-a", now: T2 })).toBe(
      false,
    );
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "token-b", now: T2 })).toBe(
      true,
    );
  });

  it("admits exactly one continuation row per parent", async () => {
    const store = await makeStore();
    enqueue(store, "parent-1");
    const continuation = {
      workflowRef: "gate",
      workflowPath: "/gate.ts",
      input: { approved: true },
      runnerId: "runner-a",
      leaseMs: 1_000,
      now: T0,
    };
    store.enqueueWorkflowRun({
      ...continuation,
      runId: "child-1",
      claimToken: "token-c1",
      parentRunId: "parent-1",
    });
    expect(() =>
      store.enqueueWorkflowRun({
        ...continuation,
        runId: "child-2",
        claimToken: "token-c2",
        parentRunId: "parent-1",
      }),
    ).toThrow(/UNIQUE/);
    // Exclusion filters keep skipped runs out of the next claim.
    store.completeWorkflowRun({ runId: "parent-1", claimToken: "token-a", now: T1 });
    store.completeWorkflowRun({ runId: "child-1", claimToken: "token-c1", now: T1 });
    store.enqueueWorkflowRun({
      runId: "run-x",
      workflowRef: "x",
      workflowPath: "/x.ts",
      input: null,
      runnerId: "runner-a",
      claimToken: "token-x",
      leaseMs: 10_000,
      now: T1,
    });
    store.parkWorkflowRun({ runId: "run-x", claimToken: "token-x", now: T1 });
    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-b",
        claimToken: "token-b",
        leaseMs: 1_000,
        excludeRunIds: ["run-x"],
        now: T2,
      }),
    ).toBeUndefined();
  });

  it("rejects invalid ids on every claim operation", async () => {
    const store = await makeStore();
    expect(() => store.getWorkflowRun("../bad")).toThrow(/Invalid workflow run id/);
    expect(() =>
      store.renewWorkflowRunClaim({ runId: "../bad", claimToken: "t", leaseMs: 10 }),
    ).toThrow(/Invalid workflow run id/);
    expect(() => store.verifyWorkflowRunClaim({ runId: "../bad", claimToken: "t" })).toThrow(
      /Invalid workflow run id/,
    );
    expect(() => store.parkWorkflowRun({ runId: "../bad", claimToken: "t" })).toThrow(
      /Invalid workflow run id/,
    );
    expect(() => store.completeWorkflowRun({ runId: "../bad", claimToken: "t" })).toThrow(
      /Invalid workflow run id/,
    );
    expect(() => store.deleteWorkflowRun({ runId: "../bad", claimToken: "t" })).toThrow(
      /Invalid workflow run id/,
    );
    expect(() => store.listRunEventsAfter(-1)).toThrow(/Invalid run event watermark/);
    expect(() => store.setSessionWatermark("s", -1)).toThrow(/Invalid run event watermark/);
    expect(() =>
      store.claimNextWorkflowRun({
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
        excludeRunIds: ["../bad"],
      }),
    ).toThrow(/Invalid workflow run id/);
  });

  it("validates run queue inputs and reports missing rows", async () => {
    const store = await makeStore();
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "bad-ref",
        workflowRef: "",
        workflowPath: "/x.ts",
        input: null,
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
      }),
    ).toThrow();
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "big-input",
        workflowRef: "x",
        workflowPath: "/x.ts",
        input: { blob: "x".repeat(2 * 1024 * 1024) },
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "cyclic",
        workflowRef: "x",
        workflowPath: "/x.ts",
        input: (() => {
          const value: { self?: unknown } = {};
          value.self = value;
          return value;
        })(),
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
      }),
    ).toThrow();
    // A fresh database reports missing runs and empty feeds.
    expect(store.getWorkflowRun("never-existed")).toBeUndefined();
    expect(store.listRunEventsAfter(0)).toEqual([]);
    expect(store.latestRunEventSeq()).toBe(0);
  });

  it("deletes a claimed row by token", async () => {
    const store = await makeStore();
    store.enqueueWorkflowRun({
      runId: "child-1",
      workflowRef: "gate",
      workflowPath: "/gate.ts",
      input: {},
      runnerId: "runner-a",
      claimToken: "token-c1",
      leaseMs: 1_000,
      parentRunId: "parent-1",
      now: T0,
    });
    expect(store.deleteWorkflowRun({ runId: "child-1", claimToken: "wrong" })).toBe(false);
    expect(store.deleteWorkflowRun({ runId: "child-1", claimToken: "token-c1" })).toBe(true);
    expect(store.getWorkflowRun("child-1")).toBeUndefined();
    // The freed parent slot admits a fresh continuation.
    store.enqueueWorkflowRun({
      runId: "child-2",
      workflowRef: "gate",
      workflowPath: "/gate.ts",
      input: {},
      runnerId: "runner-a",
      claimToken: "token-c2",
      leaseMs: 1_000,
      parentRunId: "parent-1",
      now: T1,
    });
    expect(store.getWorkflowRun("child-2")).toBeDefined();
  });

  it("completes a run terminally and excludes it from claiming", async () => {
    const store = await makeStore();
    enqueue(store);
    expect(store.completeWorkflowRun({ runId: "run-1", claimToken: "token-a", now: T1 })).toBe(
      true,
    );
    expect(store.getWorkflowRun("run-1")?.status).toBe("done");
    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-b",
        claimToken: "token-b",
        leaseMs: 1_000,
        now: T2,
      }),
    ).toBeUndefined();
    // A stale holder cannot complete or park after the claim is gone.
    expect(store.completeWorkflowRun({ runId: "run-1", claimToken: "token-a", now: T2 })).toBe(
      false,
    );
    expect(store.parkWorkflowRun({ runId: "run-1", claimToken: "token-a", now: T2 })).toBe(false);
    expect(store.listWorkflowRuns({ status: "done" }).map((run) => run.runId)).toEqual(["run-1"]);
  });
});

describe("run event feed and session watermarks", () => {
  it("records events, pages after a watermark, and tracks sessions independently", async () => {
    const store = await makeStore();
    const first = store.recordRunEvent({
      runId: "run-1",
      workflowRef: "summarize",
      type: "queued",
      runnerId: "runner-a",
      now: T0,
    });
    const second = store.recordRunEvent({
      runId: "run-1",
      workflowRef: "summarize",
      type: "completed",
      runnerId: "runner-a",
      payload: { finalOutput: "done" },
      now: T1,
    });
    expect(second).toBeGreaterThan(first);

    expect(store.listRunEventsAfter(0)).toHaveLength(2);
    const after = store.listRunEventsAfter(first);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      seq: second,
      type: "completed",
      payload: { finalOutput: "done" },
    });

    expect(store.getSessionWatermark("session-a")).toBe(0);
    store.setSessionWatermark("session-a", first, T1);
    store.setSessionWatermark("session-b", second, T2);
    expect(store.getSessionWatermark("session-a")).toBe(first);
    expect(store.getSessionWatermark("session-b")).toBe(second);
    // Watermarks never move backwards.
    store.setSessionWatermark("session-b", first, T3);
    expect(store.getSessionWatermark("session-b")).toBe(second);
  });

  it("rejects unsafe event fields", async () => {
    const store = await makeStore();
    expect(() =>
      store.recordRunEvent({ runId: "../escape", workflowRef: "x", type: "queued" }),
    ).toThrow(/Invalid workflow run id/);
    expect(() =>
      store.recordRunEvent({
        runId: "run-1",
        workflowRef: "x",
        type: "queued",
        payload: { blob: "x".repeat(70 * 1024) },
      }),
    ).toThrow(/exceeds/);
  });
});
