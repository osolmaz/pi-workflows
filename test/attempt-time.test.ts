import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { AttemptTime, type AttemptClock } from "../src/state/attempt-time.js";
import { canonicalJson } from "../src/state/json.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import { makeTempDir } from "./helpers.js";

async function fixture() {
  const directory = await makeTempDir("attempt-time");
  const queue = new WorkflowRunQueueStore(path.join(directory, "state.sqlite"), {
    projectPath: directory,
  });
  const snapshot = createDefinitionSnapshot(workflow);
  queue.reserveWorkflowRun({
    runId: "run",
    workflowName: "echo",
    workflowSourceRef: "builtin:echo",
    workflowSource: { kind: "builtin", id: "echo", revision: "test" },
    definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    definitionSnapshot: snapshot,
    input: {},
    launchOptions: {},
    originSessionId: "session",
  });
  queue.state.connection
    .prepare(
      `INSERT INTO node_attempts(attempt_id, run_id, node_id, attempt_number, node_type, status,
       started_at, timeout_ms, created_at, updated_at) VALUES ('attempt', 'run', 'ask', 1, 'agent', 'waiting', 1000, 500, 1000, 1000)`,
    )
    .run();
  let wall = 1000;
  let mono = 0;
  const clock: AttemptClock = { now: () => wall, monotonic: () => mono };
  const time = new AttemptTime(queue.state, clock);
  return {
    queue,
    time,
    clock,
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    setWall(value: number) {
      wall = value;
    },
    elapsed() {
      return (
        queue.state.connection
          .prepare("SELECT COALESCE(SUM(elapsed_ms), 0) AS elapsed FROM attempt_active_intervals")
          .get() as { elapsed: number }
      ).elapsed;
    },
  };
}

it("counts only active monotonic time and never rewrites the attempt start", async () => {
  const f = await fixture();
  try {
    f.advance(10_000); // Delivery and idle time do not create an active interval.
    f.time.start("attempt");
    f.advance(100);
    f.time.start("attempt"); // An overlapping start adopts the same interval.
    f.time.sample();
    expect(f.elapsed()).toBe(100);
    f.setWall(1); // A backward wall-clock change cannot change elapsed time.
    f.advance(50);
    f.time.stop("attempt");
    f.time.stop("attempt");
    expect(f.elapsed()).toBe(150);
    f.advance(100_000); // Pause or disconnect time is outside the budget.
    f.time.start("attempt");
    f.setWall(10_000_000); // A forward wall-clock change cannot exhaust the budget.
    f.advance(75);
    f.time.stop("attempt");
    expect(f.elapsed()).toBe(225);
    expect(
      f.queue.state.connection.prepare("SELECT started_at AS startedAt FROM node_attempts").get(),
    ).toEqual({ startedAt: 1000 });
    expect(
      f.queue.state.connection
        .prepare("SELECT COUNT(*) AS count FROM attempt_active_intervals")
        .get(),
    ).toEqual({ count: 2 });
  } finally {
    f.queue.close();
  }
});

it("recovers only durable samples after a crash and excludes server downtime", async () => {
  const f = await fixture();
  try {
    f.time.start("attempt");
    f.advance(80);
    f.time.sample();
    f.advance(100_000);
    const nextServer = new AttemptTime(f.queue.state, f.clock);
    expect(() => nextServer.start("attempt")).toThrow("Recover the previous workflow server");
    nextServer.recover();
    expect(f.elapsed()).toBe(80);
    nextServer.start("attempt");
    f.advance(20);
    nextServer.stop("attempt");
    expect(f.elapsed()).toBe(100);
  } finally {
    f.queue.close();
  }
});

it("preserves an open clock when a surrounding transaction rolls back", async () => {
  const f = await fixture();
  try {
    f.time.start("attempt");
    f.advance(10);
    expect(() =>
      f.queue.state.transaction(() => {
        f.time.stop("attempt");
        f.time.start("attempt");
        throw new Error("Injected rollback");
      }),
    ).toThrow("Injected rollback");
    f.advance(10);
    f.time.stop("attempt");
    expect(f.elapsed()).toBe(20);
  } finally {
    f.queue.close();
  }
});
