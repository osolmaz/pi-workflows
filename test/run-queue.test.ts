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
        now: T1,
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
      leaseMs: 1_000,
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
