import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir } from "./helpers.js";

const workflow = compileWorkflowDefinition(rawWorkflow);
const snapshot = createDefinitionSnapshot(workflow);
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

async function setup() {
  const projectPath = await makeTempDir("run-queue-project");
  const databasePath = path.join(await makeTempDir("run-queue-state"), "state.sqlite");
  return {
    store: new SqliteControllerStore(databasePath, { projectPath }),
    projectPath,
  };
}

function reserve(store: SqliteControllerStore, runId = "run-1") {
  return store.reserveWorkflowRun({
    runId,
    workflowName: "echo",
    workflowSourceRef: "builtin:echo",
    workflowSource: { kind: "builtin", id: "echo", revision: "test" },
    definitionDigest,
    definitionSnapshot: snapshot,
    input: { task: "hello" },
    launchOptions: {},
    runnerId: "session-1",
    originSessionId: "session-1",
  });
}

describe("workflow run queue in canonical SQLite", () => {
  it("reserves one run with its definition, input, binding, and queue row", async () => {
    const { store } = await setup();
    const run = reserve(store);
    expect(run).toMatchObject({
      runId: "run-1",
      workflowName: "echo",
      workflowSourceRef: "builtin:echo",
      initialized: false,
      status: "queued",
      originSessionId: "session-1",
    });
    const queuedState = new WorkflowRunStore(store.filePath, { state: store.state }).readRun(
      "run-1",
    )?.state;
    expect(queuedState?.workflowSource).toEqual({
      kind: "builtin",
      id: "echo",
      revision: "test",
    });
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
      count: 1,
    });
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM run_queue").get()).toEqual(
      { count: 1 },
    );
    store.close();
  });

  it("preserves mounted source identity in an uninitialized reservation", async () => {
    const { store } = await setup();
    store.reserveWorkflowRun({
      runId: "composed-run",
      workflowName: "echo",
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [
          {
            mountPath: ["child"],
            workflowName: "child",
            source: { kind: "file", path: "/tmp/child.ts", hash: "child-hash" },
          },
        ],
      },
      definitionDigest: `sha256:${definitionDigest}`,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-mounted",
      originSessionId: "session-mounted",
    });
    const queued = new WorkflowRunStore(store.filePath, { state: store.state }).readRun(
      "composed-run",
    )?.state;
    expect(queued?.workflowSource).toEqual({ kind: "builtin", id: "echo", revision: "test" });
    expect(queued?.workflowSources).toHaveLength(1);
    expect(queued?.definitionDigest).toBe(`sha256:${definitionDigest}`);
    store.close();
  });

  it("rejects an invalid source identity before reserving the run", async () => {
    const { store } = await setup();
    expect(() =>
      store.reserveWorkflowRun({
        runId: "invalid-source",
        workflowName: "echo",
        workflowSourceRef: "builtin:echo",
        workflowSource: { unexpected: true },
        definitionDigest,
        definitionSnapshot: snapshot,
        input: {},
        runnerId: "session-invalid",
        originSessionId: "session-invalid",
      }),
    ).toThrow("Stored workflow source identity is invalid");
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
      count: 0,
    });
    store.close();
  });

  it("rejects duplicate and concurrent session reservations", async () => {
    const { store } = await setup();
    reserve(store);
    expect(() => reserve(store)).toThrow(/already reserved/);
    expect(() => reserve(store, "run-2")).toThrow(/UNIQUE constraint/);
    store.close();
  });

  it("claims one run and exposes generation-based write authority", async () => {
    const { store } = await setup();
    reserve(store);
    const claimed = store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "token-1",
      leaseMs: 60_000,
    });
    expect(claimed).toMatchObject({ claimToken: "token-1", claimGeneration: 1 });
    expect(store.verifyWorkflowRunClaim({ runId: "run-1", claimToken: "token-1" })).toBe(true);
    expect(store.workflowRunAuthority("run-1", "token-1")).toMatchObject({
      generation: 1,
      ownerId: "session-1",
    });
    expect(store.workflowRunAuthority("run-1", "wrong")).toBeUndefined();
    expect(
      store.renewWorkflowRunClaim({
        runId: "run-1",
        claimToken: "token-1",
        leaseMs: 60_000,
      }),
    ).toBe(true);
    expect(store.markWorkflowRunRunning({ runId: "run-1", claimToken: "token-1" })).toBe(true);
    store.close();
  });

  it("keeps fresh interactive reservations out of host claims", async () => {
    const { store } = await setup();
    reserve(store);
    store.state.connection
      .prepare("UPDATE run_queue SET affinity_runner_id = NULL WHERE run_id = 'run-1'")
      .run();
    expect(
      store.claimNextWorkflowRun({
        runnerId: "host-worker",
        claimToken: "host-token",
        leaseMs: 10_000,
      }),
    ).toBeUndefined();
    expect(store.getWorkflowRun("run-1")?.status).toBe("queued");
    store.close();
  });

  it("allows a host to reclaim an abandoned interactive start", async () => {
    const { store } = await setup();
    reserve(store);
    const now = Date.now();
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "expired",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    const reclaimed = store.claimNextWorkflowRun({
      runnerId: "host-worker",
      claimToken: "host-token",
      leaseMs: 10_000,
      now: new Date(now + 2_000).toISOString(),
    });
    expect(reclaimed).toMatchObject({
      runId: "run-1",
      initialized: false,
      claimToken: "host-token",
      claimGeneration: 2,
    });
    store.close();
  });

  it("reclaims an expired running queue entry with a new token", async () => {
    const { store } = await setup();
    reserve(store);
    const now = Date.now();
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "expired",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    expect(
      store.markWorkflowRunRunning({
        runId: "run-1",
        claimToken: "expired",
        now: new Date(now).toISOString(),
      }),
    ).toBe(true);
    const reclaimed = store.claimNextWorkflowRun({
      runnerId: "session-1",
      claimToken: "replacement",
      leaseMs: 10_000,
      now: new Date(now + 2_000).toISOString(),
    });
    expect(reclaimed).toMatchObject({
      runId: "run-1",
      status: "starting",
      claimToken: "replacement",
      claimGeneration: 2,
    });
    store.close();
  });

  it("fences an old claim after ownership changes", async () => {
    const { store } = await setup();
    reserve(store);
    const now = Date.now();
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "old",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    const next = store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "host-2",
      claimToken: "new",
      leaseMs: 10_000,
      now: new Date(now + 2_000).toISOString(),
    });
    expect(next?.claimGeneration).toBe(2);
    expect(
      store.verifyWorkflowRunClaim({
        runId: "run-1",
        claimToken: "old",
        now: new Date(now + 3_000).toISOString(),
      }),
    ).toBe(false);
    expect(
      store.verifyWorkflowRunClaim({
        runId: "run-1",
        claimToken: "new",
        now: new Date(now + 3_000).toISOString(),
      }),
    ).toBe(true);
    expect(store.deleteWorkflowRun({ runId: "run-1", claimToken: "old" })).toBe(false);
    expect(store.getWorkflowRun("run-1")).toBeDefined();
    store.close();
  });

  it("releases a waiting parent reservation before its continuation", async () => {
    const { store } = await setup();
    reserve(store, "parent-run");
    store.claimWorkflowRun({
      runId: "parent-run",
      runnerId: "session-1",
      claimToken: "parent-token",
      leaseMs: 60_000,
    });
    expect(store.parkWorkflowRun({ runId: "parent-run", claimToken: "parent-token" })).toBe(true);
    const continuation = store.reserveWorkflowRun({
      runId: "continuation-run",
      workflowName: "echo",
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-1",
      originSessionId: "session-1",
      parentRunId: "parent-run",
    });
    expect(continuation.status).toBe("queued");
    expect(store.getWorkflowRun("parent-run")?.status).toBe("done");
    expect(() =>
      store.reserveWorkflowRun({
        runId: "duplicate-continuation",
        workflowName: "echo",
        workflowSourceRef: "builtin:echo",
        workflowSource: { kind: "builtin", id: "echo", revision: "test" },
        definitionDigest,
        definitionSnapshot: snapshot,
        input: {},
        runnerId: "session-1",
        originSessionId: "session-1",
        parentRunId: "parent-run",
      }),
    ).toThrow(/already has a reserved continuation/);
    expect(store.getWorkflowRun("duplicate-continuation")).toBeUndefined();
    store.close();
  });

  it("filters queue listings and session reservations", async () => {
    const { store } = await setup();
    reserve(store);
    expect(store.findSessionReservation("session-1")?.runId).toBe("run-1");
    expect(store.listWorkflowRuns({ statuses: ["queued"] })).toHaveLength(1);
    expect(store.listWorkflowRuns({ excludeRunIds: ["run-1"] })).toEqual([]);
    expect(store.listWorkflowRuns({ limit: 0 })).toEqual([]);
    store.close();
  });

  it("parks and completes through idempotent queue transitions", async () => {
    const { store } = await setup();
    reserve(store);
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "host-1",
      claimToken: "token",
      leaseMs: 10_000,
    });
    expect(store.parkWorkflowRun({ runId: "run-1", claimToken: "token" })).toBe(true);
    expect(store.getWorkflowRun("run-1")?.status).toBe("parked");
    const next = store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "host-2",
      claimToken: "token-2",
      leaseMs: 10_000,
    });
    expect(next).toBeDefined();
    expect(store.completeWorkflowRun({ runId: "run-1", claimToken: "token-2" })).toBe(true);
    expect(store.getWorkflowRun("run-1")?.status).toBe("done");
    expect(store.completeWorkflowRun({ runId: "run-1", claimToken: "token-2" })).toBe(false);
    store.close();
  });

  it("records terminal queue failures in the run projection", async () => {
    const { store } = await setup();
    reserve(store);
    expect(
      store.failWorkflowRun({
        runId: "run-1",
        errorCode: "launch_failed",
        errorMessage: "could not launch",
      }),
    ).toBe(true);
    expect(store.getWorkflowRun("run-1")).toMatchObject({
      status: "failed",
      errorCode: "launch_failed",
      errorMessage: "could not launch",
    });
    expect(
      new WorkflowRunStore(store.filePath, { state: store.state }).readRun("run-1")?.state,
    ).toMatchObject({
      status: "failed",
      error: "could not launch",
      finishedAt: expect.any(String),
    });
    expect(store.cancelWorkflowRun({ runId: "missing" })).toBe(false);
    store.close();
  });

  it("does not let an unclaimed cancellation override a live or expired owner", async () => {
    const { store } = await setup();
    reserve(store);
    const now = Date.now();
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "owner",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    expect(
      store.cancelWorkflowRun({ runId: "run-1", now: new Date(now + 500).toISOString() }),
    ).toBe(false);
    expect(
      store.cancelWorkflowRun({ runId: "run-1", now: new Date(now + 2_000).toISOString() }),
    ).toBe(false);
    expect(store.getWorkflowRun("run-1")?.status).toBe("starting");
    store.close();
  });

  it("does not let an expired claimant record a terminal failure", async () => {
    const { store } = await setup();
    reserve(store);
    const now = Date.now();
    store.claimWorkflowRun({
      runId: "run-1",
      runnerId: "session-1",
      claimToken: "expired",
      leaseMs: 1_000,
      now: new Date(now).toISOString(),
    });
    expect(
      store.failWorkflowRun({
        runId: "run-1",
        claimToken: "expired",
        errorCode: "late_failure",
        errorMessage: "stale owner",
        now: new Date(now + 2_000).toISOString(),
      }),
    ).toBe(false);
    expect(store.getWorkflowRun("run-1")?.status).toBe("starting");
    store.close();
  });

  it("records run events in the same audit stream", async () => {
    const { store } = await setup();
    reserve(store);
    const event = store.recordRunEvent({
      runId: "run-1",
      workflowRef: "echo",
      type: "observed",
      payload: { status: "queued" },
    });
    expect(event.seq).toBeGreaterThan(0);
    expect(store.listRunEventsAfter(0).some((item) => item.type === "observed")).toBe(true);
    store.close();
  });
});
