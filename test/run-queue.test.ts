import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
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
    workflowName: "summarize",
    workflowSourceRef: "/project/.pi/workflows/summarize.workflow.ts",
    input: { task: "hello" },
    runnerId: "runner-a",
    claimToken: "token-a",
    leaseMs: 1_000,
    now: T0,
  });
}

describe("workflow run queue", () => {
  it("rejects an incompatible older alpha layout without changing it", async () => {
    const dir = await makeTempDir("pi-run-queue-old-alpha");
    const databasePath = path.join(dir, "state", "controller.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TABLE schema_info (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_id TEXT NOT NULL
      );
      INSERT INTO schema_info (singleton, schema_id)
      VALUES (1, 'pi-workflows.controller-store.v1');
      CREATE TABLE workflow_run_queue (
        run_id TEXT PRIMARY KEY,
        workflow_ref TEXT NOT NULL,
        workflow_path TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    raw.close();

    expect(() => new SqliteControllerStore(databasePath)).toThrow(
      /incompatible alpha layout.*reset the project controller store/,
    );
    const unchanged = new Database(databasePath, { readonly: true });
    try {
      const columns = unchanged.pragma("table_info(workflow_run_queue)") as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain("workflow_source_json");
    } finally {
      unchanged.close();
    }
  });

  it("inserts and claims a run atomically", async () => {
    const store = await makeStore();
    const record = enqueue(store);
    expect(record).toMatchObject({
      runId: "run-1",
      workflowName: "summarize",
      input: { task: "hello" },
      status: "starting",
      runnerId: "runner-a",
      claimToken: "token-a",
      affinityRunnerId: "runner-a",
      originSessionId: null,
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

  it("persists a prepared run before activation and releases the reservation on failure", async () => {
    const store = await makeStore();
    const prepared = store.reserveWorkflowRun({
      runId: "prepared-1",
      workflowName: "summarize",
      workflowSourceRef: "/project/.pi/workflows/summarize.workflow.ts",
      workflowSource: { kind: "file", path: "/project/summarize.workflow.ts", hash: "abc" },
      definitionDigest: "sha256:abc",
      input: { secretMarker: "private-input" },
      launchOptions: { presentation: false },
      runnerId: "runner-a",
      originSessionId: "session-a",
      now: T0,
    });
    expect(prepared).toMatchObject({
      runId: "prepared-1",
      status: "queued",
      originSessionId: "session-a",
      definitionDigest: "sha256:abc",
      launchOptions: { presentation: false },
    });
    expect(store.findSessionReservation("session-a")?.runId).toBe("prepared-1");

    const claimed = store.claimWorkflowRun({
      runId: "prepared-1",
      runnerId: "runner-a",
      claimToken: "claim-a",
      leaseMs: 1_000,
      now: T1,
    });
    expect(claimed?.status).toBe("starting");
    expect(
      store.failWorkflowRun({
        runId: "prepared-1",
        claimToken: "claim-a",
        errorCode: "workflow_not_found",
        errorMessage: "Workflow source is missing",
        now: T2,
      }),
    ).toBe(true);
    expect(store.getWorkflowRun("prepared-1")).toMatchObject({
      status: "failed",
      input: null,
      launchOptions: {},
      errorCode: "workflow_not_found",
      errorMessage: "Workflow source is missing",
      finishedAt: T2,
    });
    expect(store.findSessionReservation("session-a")).toBeUndefined();
  });

  it("keeps an unactivated starting run out of detached host recovery", async () => {
    const store = await makeStore();
    store.reserveWorkflowRun({
      runId: "prepared-1",
      workflowName: "summarize",
      workflowSourceRef: "/project/summarize.workflow.ts",
      workflowSource: { kind: "file", path: "/project/summarize.workflow.ts", hash: "abc" },
      definitionDigest: "sha256:abc",
      input: {},
      runnerId: "runner-a",
      originSessionId: "session-a",
      now: T0,
    });
    store.claimWorkflowRun({
      runId: "prepared-1",
      runnerId: "runner-a",
      claimToken: "claim-a",
      leaseMs: 1_000,
      now: T0,
    });

    expect(
      store.claimNextWorkflowRun({
        runnerId: "detached-host",
        claimToken: "host-claim",
        leaseMs: 1_000,
        now: T2,
      }),
    ).toBeUndefined();
    expect(
      store.claimNextWorkflowRun({
        runnerId: "session-runner",
        claimToken: "session-claim",
        leaseMs: 1_000,
        sessionId: "session-a",
        now: T2,
      })?.runId,
    ).toBe("prepared-1");
  });

  it("cancels a prepared run and permits another session reservation", async () => {
    const store = await makeStore();
    const reserve = (runId: string) =>
      store.reserveWorkflowRun({
        runId,
        workflowName: "summarize",
        workflowSourceRef: "/project/summarize.workflow.ts",
        workflowSource: { kind: "file", path: "/project/summarize.workflow.ts", hash: "abc" },
        definitionDigest: "sha256:abc",
        input: {},
        runnerId: "runner-a",
        originSessionId: "session-a",
        now: T0,
      });
    reserve("prepared-1");
    expect(() => reserve("prepared-2")).toThrow(/UNIQUE constraint/);
    expect(store.cancelWorkflowRun({ runId: "prepared-1", now: T1 })).toBe(true);
    expect(store.getWorkflowRun("prepared-1")?.status).toBe("cancelled");
    expect(reserve("prepared-2").status).toBe("queued");
  });

  it("restricts session-bound runs to their origin session", async () => {
    const store = await makeStore();
    store.enqueueWorkflowRun({
      runId: "bound-run",
      workflowName: "monitor",
      workflowSourceRef: "builtin:monitor",
      input: {},
      runnerId: "runner-a",
      claimToken: "token-a",
      leaseMs: 1_000,
      originSessionId: "session-a",
      now: T0,
    });
    store.parkWorkflowRun({ runId: "bound-run", claimToken: "token-a", now: T1 });

    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-b",
        claimToken: "token-b",
        leaseMs: 1_000,
        sessionId: "session-b",
        now: T2,
      }),
    ).toBeUndefined();
    expect(
      store.claimNextWorkflowRun({
        runnerId: "runner-c",
        claimToken: "token-c",
        leaseMs: 1_000,
        sessionId: "session-a",
        now: T2,
      })?.originSessionId,
    ).toBe("session-a");
  });

  it("stores and delivers session-addressed notifications idempotently", async () => {
    const store = await makeStore();
    const first = store.enqueueWorkflowNotification({
      runId: "run-1",
      nodeId: "report",
      attemptId: "attempt-1",
      notificationIndex: 1,
      targetSessionId: "session-a",
      kind: "progress",
      content: "State changed",
      notificationId: "notification-1",
      now: T0,
    });
    const duplicate = store.enqueueWorkflowNotification({
      runId: "run-1",
      nodeId: "report",
      attemptId: "attempt-2",
      notificationIndex: 1,
      targetSessionId: "session-a",
      kind: "progress",
      content: "State changed",
      notificationId: "notification-2",
      now: T1,
    });
    expect(duplicate.notificationId).toBe(first.notificationId);
    expect(
      store.claimPendingWorkflowNotifications({
        targetSessionId: "session-b",
        claimToken: "claim-b",
        leaseMs: 1_000,
        now: T0,
      }),
    ).toEqual([]);
    const claimed = store.claimPendingWorkflowNotifications({
      targetSessionId: "session-a",
      claimToken: "claim-a",
      leaseMs: 1_000,
      now: T0,
    });
    expect(claimed).toMatchObject([{ notificationId: first.notificationId }]);
    expect(
      store.claimPendingWorkflowNotifications({
        targetSessionId: "session-a",
        claimToken: "claim-other",
        leaseMs: 1_000,
        now: T0,
      }),
    ).toEqual([]);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: first.notificationId,
        targetSessionId: "session-a",
        claimToken: "wrong-claim",
        now: T1,
      }),
    ).toBe(false);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: first.notificationId,
        targetSessionId: "session-a",
        claimToken: "claim-a",
        now: T1,
      }),
    ).toBe(true);

    const reclaimable = store.enqueueWorkflowNotification({
      runId: "run-1",
      nodeId: "report",
      attemptId: "attempt-3",
      notificationIndex: 2,
      targetSessionId: "session-a",
      kind: "final",
      content: "Finished",
      notificationId: "notification-3",
      now: T1,
    });
    store.claimPendingWorkflowNotifications({
      targetSessionId: "session-a",
      claimToken: "expired-claim",
      leaseMs: 1_000,
      now: T1,
    });
    expect(
      store.claimPendingWorkflowNotifications({
        targetSessionId: "session-a",
        claimToken: "replacement-claim",
        leaseMs: 1_000,
        now: T3,
      }),
    ).toMatchObject([{ notificationId: reclaimable.notificationId }]);
    expect(
      store.markWorkflowNotificationDelivered({
        notificationId: reclaimable.notificationId,
        targetSessionId: "session-a",
        claimToken: "expired-claim",
        now: T3,
      }),
    ).toBe(false);
  });

  it("stores and resolves deferred turn intents exactly once", async () => {
    const store = await makeStore();
    const fallbackFacts = {
      schema: "pi-workflows.deferred-turn-facts.v1" as const,
      workflowName: "autoimplement",
      runId: "run-1",
      observedState: "interrupted",
      cause: "agentCancelled" as const,
      nodeId: "implement",
      attemptId: "attempt-1",
      reason: "cancelled",
      handoff: false,
    };
    const first = store.ensureWorkflowTurnIntent({
      intentId: "intent-1",
      sourceEventId: "event-1",
      runId: "run-1",
      workflowRef: "autoimplement",
      targetSessionId: "session-a",
      cause: "agentCancelled",
      nodeId: "implement",
      attemptId: "attempt-1",
      fallbackFacts,
      now: T0,
    });
    expect(
      store.ensureWorkflowTurnIntent({
        intentId: "intent-1",
        sourceEventId: "event-1",
        runId: "run-1",
        workflowRef: "autoimplement",
        targetSessionId: "session-a",
        cause: "agentCancelled",
        nodeId: "implement",
        attemptId: "attempt-1",
        fallbackFacts,
        now: T1,
      }),
    ).toEqual(first);
    expect(() =>
      store.ensureWorkflowTurnIntent({
        intentId: "intent-1",
        sourceEventId: "different-event",
        runId: "run-1",
        workflowRef: "autoimplement",
        targetSessionId: "session-a",
        cause: "agentCancelled",
        fallbackFacts,
        now: T1,
      }),
    ).toThrow(/identity conflict/);
    expect(
      store.claimEligibleWorkflowTurnIntents({
        targetSessionId: "session-a",
        claimToken: "claim-a",
        leaseMs: 1_000,
        now: T0,
      }),
    ).toEqual([]);
    expect(
      store.makeWorkflowTurnIntentEligible({
        intentId: "intent-1",
        fallbackFacts: { ...fallbackFacts, observedState: "cancelled" },
        now: T1,
      }),
    ).toBe(true);
    expect(
      store.claimWorkflowTurnIntent({
        intentId: "intent-1",
        targetSessionId: "session-a",
        claimToken: "natural-claim",
        leaseMs: 1_000,
        now: T1,
      })?.eligibleAt,
    ).toBe(T1);
    expect(
      store.resolveWorkflowTurnIntent({
        intentId: "intent-1",
        targetSessionId: "session-a",
        claimToken: "wrong-claim",
        resolution: "workflowPrompt",
        messageId: "message-1",
        now: T2,
      }),
    ).toBe(false);
    expect(
      store.resolveWorkflowTurnIntent({
        intentId: "intent-1",
        targetSessionId: "session-a",
        claimToken: "natural-claim",
        resolution: "workflowPrompt",
        messageId: "message-1",
        now: T2,
      }),
    ).toBe(true);
    expect(store.getWorkflowTurnIntent("intent-1")).toMatchObject({
      resolvedAt: T2,
      resolution: "workflowPrompt",
      resolutionMessageId: "message-1",
    });
    expect(
      store.claimEligibleWorkflowTurnIntents({
        targetSessionId: "session-a",
        claimToken: "fallback-claim",
        leaseMs: 1_000,
        now: T3,
      }),
    ).toEqual([]);
  });

  it("rejects pending legacy launch-failure notifications", async () => {
    const dir = await makeTempDir("pi-run-queue-legacy-launch");
    const databasePath = path.join(dir, "state", "controller.sqlite");
    const store = new SqliteControllerStore(databasePath);
    store.close();
    const raw = new Database(databasePath);
    raw.pragma("ignore_check_constraints = ON");
    raw
      .prepare(
        `INSERT INTO workflow_notifications (
          notification_id, run_id, node_id, attempt_id, notification_index,
          target_session_id, kind, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-launch",
        "run-1",
        "$launch",
        "run-1",
        1,
        "session-a",
        "launch_failure",
        "failed",
        T0,
      );
    raw.exec("DROP TABLE workflow_turn_intents");
    raw.close();

    expect(() => new SqliteControllerStore(databasePath)).toThrow(
      /pending alpha launch-failure notifications.*reset the project controller store/,
    );
    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(
        unchanged
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_turn_intents'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it("rejects duplicate run ids and unsafe inputs", async () => {
    const store = await makeStore();
    enqueue(store);
    expect(() => enqueue(store)).toThrow();
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "../escape",
        workflowName: "x",
        workflowSourceRef: "/x",
        input: {},
        runnerId: "runner-a",
        claimToken: "token-a",
        leaseMs: 1_000,
      }),
    ).toThrow(/Invalid workflow run id/);
  });

  it("claims and rewrites a legacy built-in source ref", async () => {
    const store = await makeStore();
    const record = enqueue(store);
    store.parkWorkflowRun({ runId: record.runId, claimToken: "token-a", now: T1 });

    expect(
      store.claimLegacyWorkflowSourceRun({
        runId: record.runId,
        workflowName: "summarize",
        oldWorkflowPath: record.workflowSourceRef,
        workflowSourceRef: "builtin:summarize",
        runnerId: "migration",
        claimToken: "migration-token",
        leaseMs: 1_000,
        now: T1,
      }),
    ).toBe(true);
    expect(store.getWorkflowRun(record.runId)).toMatchObject({
      workflowSourceRef: "builtin:summarize",
      status: "starting",
      runnerId: "migration",
      claimToken: "migration-token",
    });
    expect(
      store.claimLegacyWorkflowSourceRun({
        runId: record.runId,
        workflowName: "summarize",
        oldWorkflowPath: record.workflowSourceRef,
        workflowSourceRef: "builtin:summarize",
        runnerId: "other",
        claimToken: "other-token",
        leaseMs: 1_000,
        now: T1,
      }),
    ).toBe(false);
  });

  it("repairs a canonical queue source after an expired migration claim", async () => {
    const store = await makeStore();
    const record = enqueue(store);

    expect(
      store.repairCanonicalWorkflowSourceRun({
        runId: record.runId,
        workflowName: "summarize",
        workflowSourceRef: "builtin:summarize",
        runnerId: "migration",
        claimToken: "migration-token",
        leaseMs: 1_000,
        now: T2,
      }),
    ).toBe("claimed");
    expect(store.getWorkflowRun(record.runId)?.workflowSourceRef).toBe("builtin:summarize");
    expect(
      store.parkWorkflowRun({ runId: record.runId, claimToken: "migration-token", now: T2 }),
    ).toBe(true);
    expect(
      store.repairCanonicalWorkflowSourceRun({
        runId: record.runId,
        workflowName: "summarize",
        workflowSourceRef: "builtin:summarize",
        runnerId: "migration",
        claimToken: "migration-token-2",
        leaseMs: 1_000,
        now: T3,
      }),
    ).toBe("unchanged");
  });

  it("renews, verifies, and strictly rejects expired renewals", async () => {
    const store = await makeStore();
    store.enqueueWorkflowRun({
      runId: "run-1",
      workflowName: "summarize",
      workflowSourceRef: "/project/.pi/workflows/summarize.workflow.ts",
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
      workflowName: "other",
      workflowSourceRef: "/other.ts",
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
      status: "starting",
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
      workflowName: "gate",
      workflowSourceRef: "/gate.ts",
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
      workflowName: "x",
      workflowSourceRef: "/x.ts",
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
        workflowName: "",
        workflowSourceRef: "/x.ts",
        input: null,
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
      }),
    ).toThrow();
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "big-input",
        workflowName: "x",
        workflowSourceRef: "/x.ts",
        input: { blob: "x".repeat(2 * 1024 * 1024) },
        runnerId: "r",
        claimToken: "t",
        leaseMs: 10,
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      store.enqueueWorkflowRun({
        runId: "cyclic",
        workflowName: "x",
        workflowSourceRef: "/x.ts",
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
  });

  it("deletes a claimed row by token", async () => {
    const store = await makeStore();
    store.enqueueWorkflowRun({
      runId: "child-1",
      workflowName: "gate",
      workflowSourceRef: "/gate.ts",
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
      workflowName: "gate",
      workflowSourceRef: "/gate.ts",
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

describe("run event audit feed", () => {
  it("records events and pages after a sequence", async () => {
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
