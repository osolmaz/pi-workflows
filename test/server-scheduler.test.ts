import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function setup(maxWorkers: number) {
  const cwd = await makeTempDir("scheduler-project");
  const databasePath = path.join(await makeTempDir("scheduler-state"), "state.sqlite");
  const workflowPath = path.join(cwd, "gate.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import fs from "node:fs/promises";
import { compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "gate", startAt: "work", nodes: {
  work: compute({ run: async ({ input }) => {
    await fs.writeFile(input.started, "started");
    for (;;) {
      try { await fs.access(input.release); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { done: true };
  } }),
}, edges: [] });`,
  );
  const host = new WorkflowServer({ databasePath, claimPollMs: 10, maxWorkers });
  const client = new WorkflowClient({ databasePath });
  await host.start();
  const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
  const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  const state = new ServerStateStore(databasePath, { readOnly: true });
  return {
    cwd,
    databasePath,
    client,
    queue,
    state,
    async start(runId: string) {
      const response = await client.request({
        operation: "run.start",
        runId,
        payload: {
          ...resolved,
          projectPath: cwd,
          originSessionId: "scheduler-session",
          executionMode: "headless",
          input: {
            started: path.join(cwd, `${runId}.started`),
            release: path.join(cwd, `${runId}.release`),
          },
          launchOptions: {},
        },
      });
      expect(response, JSON.stringify(response)).toMatchObject({ outcome: "accepted" });
    },
    async release(runId: string) {
      await fs.writeFile(path.join(cwd, `${runId}.release`), "release");
    },
    async close() {
      await client.close();
      await host.stop();
      queue.close();
      state.close();
    },
  };
}

describe("shared execution scheduler", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid capacity %s before opening state",
    (maxWorkers) => {
      expect(() => new WorkflowServer({ maxWorkers })).toThrow(
        "maxWorkers must be a positive safe integer",
      );
    },
  );

  it("bounds concurrent starts and does not make cancellation wait for capacity", async () => {
    const test = await setup(2);
    try {
      await Promise.all(Array.from({ length: 6 }, (_, index) => test.start(`run-${index}`)));
      await waitUntil(
        () => test.queue.listWorkflowRuns().filter((run) => run.status === "running").length === 2,
        30_000,
      );
      const running = test.queue.listWorkflowRuns().filter((run) => run.status === "running");
      expect(test.queue.listWorkflowRuns().filter((run) => run.status === "queued")).toHaveLength(
        4,
      );
      const status = await test.client.request({ operation: "server.status" });
      expect(status.receipt).toMatchObject({ executionWorkers: 2, maxWorkers: 2 });
      const cancelled = running[0];
      if (cancelled === undefined) throw new Error("No active worker");
      expect(
        (await test.client.request({ operation: "run.cancel", runId: cancelled.runId })).outcome,
      ).toBe("accepted");
      await waitUntil(
        () => test.queue.getWorkflowRun(cancelled.runId)?.status === "cancelled",
        30_000,
      );
      for (let index = 0; index < 6; index += 1) await test.release(`run-${index}`);
      await waitUntil(
        () =>
          test.queue.listWorkflowRuns().every((run) => ["done", "cancelled"].includes(run.status)),
        30_000,
      );
      expect(test.queue.listWorkflowRuns().filter((run) => run.status === "done")).toHaveLength(5);
    } finally {
      await test.close();
    }
  }, 60_000);

  it("keeps a submitted result durable while all worker slots are occupied", async () => {
    const test = await setup(1);
    try {
      const workflowPath = path.join(test.cwd, "agent.workflow.ts");
      await fs.writeFile(
        workflowPath,
        `import { agent, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "agent", startAt: "work", nodes: { work: agent({ prompt: () => "Return the result." }) }, edges: [] });`,
      );
      const resolved = await test.client.resolveWorkflow({
        cwd: test.cwd,
        workflowRef: workflowPath,
      });
      expect(
        (
          await test.client.request({
            operation: "run.start",
            runId: "interactive",
            payload: {
              ...resolved,
              projectPath: test.cwd,
              originSessionId: "scheduler-session",
              executionMode: "interactive",
              input: {},
              launchOptions: {},
            },
          })
        ).outcome,
      ).toBe("accepted");
      await waitUntil(() => test.queue.getWorkflowRun("interactive")?.status === "parked", 30_000);
      const interaction = test.state.listPendingInteractions("scheduler-session")[0];
      if (interaction === undefined) throw new Error("Missing request");
      await test.start("blocker");
      await waitUntil(() => existsSync(path.join(test.cwd, "blocker.started")), 30_000);
      const watched = await test.client.request({
        operation: "view.session.watch",
        payload: { subscriptionId: "scheduler", sessionId: "scheduler-session", coordinator: true },
      });
      const authority = {
        targetSessionId: "scheduler-session",
        coordinatorEpoch: (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch,
      };
      expect(
        (
          await test.client.request({
            operation: "workflowMessage.reportBranch",
            payload: { ...authority, entries: [], isIdle: true, hasPendingMessages: false },
          })
        ).outcome,
      ).toBe("accepted");
      const submitted = test.client.request({
        operation: "interaction.submit",
        idempotencyKey: "result",
        payload: {
          ...authority,
          requestId: interaction.requestId,
          submissionId: "result",
          value: { output: { done: true } },
        },
      });
      await waitUntil(
        () =>
          test.state.interactionSubmission(interaction.requestId, "result")?.outcome ===
          "validating",
        5_000,
      );
      expect(test.state.getInteraction(interaction.requestId)?.status).toBe("pending");
      expect(test.queue.getWorkflowRun("interactive")?.status).toBe("parked");
      expect((await test.client.request({ operation: "server.status" })).receipt).toMatchObject({
        executionWorkers: 1,
        maxWorkers: 1,
      });
      await test.release("blocker");
      expect((await submitted).outcome).toBe("accepted");
      await waitUntil(() => test.queue.getWorkflowRun("interactive")?.status === "done", 30_000);
      expect(test.state.getInteraction(interaction.requestId)?.status).toBe("settled");
    } finally {
      await test.close();
    }
  }, 60_000);
});
