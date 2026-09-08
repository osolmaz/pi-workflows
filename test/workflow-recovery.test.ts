import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { WorkflowClient } from "../src/client/client.js";
import { terminalMessageView } from "../src/extension/terminal-message.js";
import { WorkflowRecovery, recoveryStopped } from "../src/server/recovery.js";
import { WorkflowServer } from "../src/server/server.js";
import { canonicalJson } from "../src/state/json.js";
import { WorkflowMessageStore } from "../src/state/workflow-messages.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import { terminalWorkflowMessageContent } from "../src/workflows/workflow-message-content.js";
import { makeTempDir } from "./helpers.js";

async function fixture() {
  const directory = await makeTempDir("workflow-recovery");
  const queue = new WorkflowRunQueueStore(path.join(directory, "state.sqlite"), {
    projectPath: directory,
  });
  const messages = new WorkflowMessageStore(queue.state);
  const snapshot = createDefinitionSnapshot(workflow);
  let mono = 0;
  let wall = 1000;
  const clock = { monotonic: () => mono, now: () => wall };
  const recovery = new WorkflowRecovery(queue.state, clock, 500);
  function reserve(runId: string) {
    queue.reserveWorkflowRun({
      runId,
      workflowName: "echo",
      workflowSourceRef: "builtin:echo",
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
      definitionSnapshot: snapshot,
      input: {},
      launchOptions: {},
      originSessionId: "session",
    });
  }
  function run(runId: string) {
    reserve(runId);
    expect(queue.failWorkflowRun({ runId, errorCode: "fixture", errorMessage: "fixture" })).toBe(
      true,
    );
    const id = `terminal-${runId}`;
    const message = messages.create({
      workflowMessageId: id,
      runId,
      targetSessionId: "session",
      kind: "terminal",
      sourceId: id,
      idempotencyKey: id,
      content: terminalWorkflowMessageContent({
        workflowMessageId: id,
        runId,
        content: "Inspect the failure",
        details: { status: "failed" },
      }),
    });
    messages.adoptBranch(
      "session",
      [{ workflowMessageId: id, piSessionEntryId: `entry-${runId}` }],
      new Set([id]),
    );
    return message;
  }
  function start(runId: string) {
    return messages.startTurn({
      workflowMessageId: `terminal-${runId}`,
      workflowTurnId: `turn-${runId}`,
      runId,
      targetSessionId: "session",
    });
  }
  function end(runId: string) {
    messages.endTurn({
      workflowMessageId: `terminal-${runId}`,
      workflowTurnId: `turn-${runId}`,
      runId,
      targetSessionId: "session",
      stopReason: "completed",
      responseSessionEntryId: `reply-${runId}`,
    });
  }
  return {
    databasePath: path.join(directory, "state.sqlite"),
    reserve,
    queue,
    messages,
    recovery,
    clock,
    run,
    start,
    end,
    advance(ms: number) {
      mono += ms;
      wall += ms;
    },
    setWall(ms: number) {
      wall = ms;
    },
  };
}

it("counts corrected starts and restarts in the same durable recovery budget", async () => {
  const f = await fixture();
  try {
    f.run("root");
    f.start("root");
    for (let index = 1; index <= 2; index++) {
      const source = f.recovery.sourceForLaunch("session");
      expect(source?.rootRunId).toBe("root");
      const child = `child-${index}`;
      f.run(child);
      f.recovery.attach(child, source);
      f.recovery.attach(child, source); // Repeated receipt adoption is not another launch.
      expect(() => f.recovery.sourceForLaunch("session")).toThrow("already started recovery run");
      f.end(index === 1 ? "root" : "child-1");
      f.start(child);
    }
    const restarted = new WorkflowRecovery(f.queue.state, f.clock);
    expect(restarted.launchCount("root")).toBe(2);
    expect(() => restarted.sourceForLaunch("session")).toThrow("2-launch limit");
    restarted.cancel("root");
    expect(recoveryStopped(f.queue.state, "terminal-child-2")).toBe(true);
    expect(() => restarted.sourceForLaunch("session")).toThrow("stopped");
  } finally {
    f.queue.close();
  }
});

it("rejects a second launch from a consumed handoff even after the first run finishes", async () => {
  const f = await fixture();
  try {
    f.run("root");
    f.start("root");
    const source = f.recovery.sourceForLaunch("session");
    f.run("first");
    f.recovery.attach("first", source);
    expect(() => new WorkflowRecovery(f.queue.state).sourceForLaunch("session")).toThrow(
      "already started recovery run first",
    );
    f.run("second");
    expect(() => f.recovery.attach("second", source)).toThrow(
      "UNIQUE constraint failed: runs.recovery_source_message_id",
    );
    expect(f.recovery.launchCount("root")).toBe(1);
  } finally {
    f.queue.close();
  }
});

it("prevents concurrent recovery siblings and cancels the sole queued child", async () => {
  const f = await fixture();
  const host = new WorkflowServer({ databasePath: f.databasePath, claimPollMs: 60_000 });
  const client = new WorkflowClient({ databasePath: f.databasePath });
  try {
    await host.start();
    f.run("root");
    const source = { rootRunId: "root", runId: "root", messageId: "terminal-root" };
    f.reserve("first");
    f.recovery.attach("first", source);
    expect(() => f.reserve("second")).toThrow(
      "UNIQUE constraint failed: run_queue.origin_session_id",
    );
    expect(await client.request({ operation: "run.cancel", runId: "first" })).toMatchObject({
      outcome: "accepted",
    });
    expect(f.queue.getWorkflowRun("first")?.status).toBe("cancelled");
    expect(f.queue.getWorkflowRun("second")).toBeUndefined();
    expect(f.queue.getWorkflowRun("root")?.status).toBe("failed");
  } finally {
    await client.close();
    await host.stop();
    f.queue.close();
  }
});

it("keeps cancellation effective for a child terminal message created later", async () => {
  const f = await fixture();
  try {
    f.run("root");
    f.start("root");
    const source = f.recovery.sourceForLaunch("session");
    f.recovery.cancel("root");
    f.end("root");
    f.run("late-child");
    f.recovery.attach("late-child", source);
    expect(recoveryStopped(f.queue.state, "terminal-late-child")).toBe(true);
  } finally {
    f.queue.close();
  }
});

it("counts terminal active time without charging disconnects, downtime, or wall-clock jumps", async () => {
  const f = await fixture();
  try {
    f.run("root");
    f.start("root");
    f.recovery.begin("turn-root");
    f.advance(200);
    f.recovery.sample();
    f.recovery.suspendSession("session");
    f.advance(100_000);
    const restarted = new WorkflowRecovery(f.queue.state, f.clock, 500);
    restarted.resumeSession("session");
    f.setWall(1);
    f.advance(200);
    restarted.sample();
    expect(restarted.stopped("terminal-root")).toBe(false);
    f.advance(100);
    restarted.sample();
    restarted.sample();
    expect(restarted.stopped("terminal-root")).toBe(true);
    expect(
      f.messages.listRun("root").filter((message) => message.kind === "notification"),
    ).toHaveLength(1);
    expect(
      f.queue.state.connection
        .prepare("SELECT active_elapsed_ms AS elapsed FROM workflow_turns")
        .get(),
    ).toEqual({ elapsed: 500 });
  } finally {
    f.queue.close();
  }
});

it("preserves delivery evidence while cancellation stops recovery after reconnect", async () => {
  const f = await fixture();
  try {
    const message = f.run("root");
    f.start("root");
    f.recovery.cancel("root");
    f.messages.adoptBranch(
      "session",
      [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-root" }],
      new Set([message.workflowMessageId]),
    );
    expect(f.messages.require(message.workflowMessageId).status).toBe("sent");
    expect(new WorkflowRecovery(f.queue.state).stopped(message.workflowMessageId)).toBe(true);
    expect(f.queue.getWorkflowRun("root")?.status).toBe("failed");
  } finally {
    f.queue.close();
  }
});

it("reports interrupted recovery without replaying the model turn", async () => {
  const f = await fixture();
  try {
    const message = f.run("root");
    f.start("root");
    f.recovery.end(message, "error");
    f.recovery.end(message, "error");
    expect(f.recovery.stopped(message.workflowMessageId)).toBe(true);
    expect(f.messages.listRun("root").filter((item) => item.kind === "notification")).toHaveLength(
      1,
    );
  } finally {
    f.queue.close();
  }
});

it("renders a compact terminal card and keeps the complete source expandable", () => {
  const message = {
    content: "Full recorded result\n" + "x".repeat(10000),
    details: { terminal: { workflowName: "autoplan", status: "completed" } },
  };
  expect(terminalMessageView(message, false)).toEqual({ title: "autoplan · completed" });
  expect(terminalMessageView(message, true).expandedText).toBe(message.content);
  expect(terminalMessageView({ content: "fallback", details: null }, true)).toEqual({
    title: "Workflow · finished",
    expandedText: "fallback",
  });
});
