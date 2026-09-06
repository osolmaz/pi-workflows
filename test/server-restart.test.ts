import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, waitUntil } from "./helpers.js";

it("restarts only an exact terminal revision and does not require terminal model work", async () => {
  const cwd = await makeTempDir("restart-project");
  const databasePath = path.join(await makeTempDir("restart-state"), "state.sqlite");
  const workflowPath = path.join(cwd, "restart.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `
import { compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "restart", startAt: "done",
  nodes: { done: compute({ run: ({ input }) => input }) }, edges: [] });`,
  );
  const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
  const client = new WorkflowClient({ databasePath, clientId: "restart-owner" });
  await host.start();
  const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  try {
    const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
    await client.request({
      operation: "run.start",
      runId: "original",
      payload: {
        projectPath: cwd,
        ...resolved,
        input: { original: true },
        launchOptions: {},
        originSessionId: "session",
        executionMode: "interactive",
      },
    });
    const watch = await client.request({
      operation: "view.session.watch",
      payload: {
        subscriptionId: "restart-watch",
        sessionId: "session",
        coordinator: true,
      },
    });
    const coordinatorEpoch = (watch.receipt as { coordinatorEpoch: string }).coordinatorEpoch;
    await client.request({
      operation: "workflowMessage.reportBranch",
      payload: {
        targetSessionId: "session",
        coordinatorEpoch,
        entries: [],
        isIdle: true,
        hasPendingMessages: false,
      },
    });
    let runId = "original";
    for (let restartNumber = 1; restartNumber <= 5; restartNumber += 1) {
      await waitUntil(() => store.getWorkflowRun(runId)?.status === "done", 30_000);
      const row = store.state.connection
        .prepare(
          "SELECT r.revision FROM resources r JOIN runs w ON w.resource_id = r.resource_id WHERE w.run_id = ?",
        )
        .get(runId) as { revision: number };
      const payload = { targetSessionId: "session", coordinatorEpoch };
      const before = store.listWorkflowRuns().length;
      await expect(
        client.request({
          operation: "run.restart",
          runId,
          expectedRevision: row.revision + 1,
          payload,
        }),
      ).resolves.toMatchObject({ outcome: "conflict", error: "Workflow run revision changed" });
      expect(store.listWorkflowRuns()).toHaveLength(before);
      const restarted = await client.request({
        operation: "run.restart",
        runId,
        expectedRevision: row.revision,
        payload,
        idempotencyKey: `restart-${restartNumber}`,
      });
      const child = (restarted.receipt as { runId: string }).runId;
      expect(restarted).toMatchObject({
        outcome: "accepted",
        receipt: { parentRunId: runId, restartNumber },
      });
      expect(
        await client.request({
          operation: "run.restart",
          runId,
          expectedRevision: row.revision,
          payload,
          idempotencyKey: `restart-${restartNumber}`,
        }),
      ).toMatchObject({ outcome: "adopted", receipt: { runId: child } });
      expect(store.getWorkflowRun(child)).toMatchObject({
        input: { original: true },
        parentRunId: runId,
        parentRunRevision: row.revision,
        restartNumber,
      });
      runId = child;
    }
    await waitUntil(() => store.getWorkflowRun(runId)?.status === "done", 30_000);
    expect(store.listWorkflowRuns()).toHaveLength(6);
    expect(
      store.state.connection.prepare("SELECT COUNT(*) AS count FROM workflow_turns").get(),
    ).toEqual({ count: 0 });
    expect(
      store.state.connection.prepare("SELECT COUNT(*) AS count FROM node_attempts").get(),
    ).toEqual({ count: 6 });
    const runs = new WorkflowRunStore(databasePath);
    try {
      // Simulate external success with a missing receipt. Restart must not repeat it.
      await runs.reserveEffect({
        runId,
        attemptId: "lost-effect-attempt",
        effectType: "test.delivery",
        idempotencyKey: "delivery",
        request: { target: "test" },
        recovery: "manual",
      });
      const row = store.state.connection
        .prepare(
          "SELECT r.revision FROM resources r JOIN runs w ON w.resource_id = r.resource_id WHERE w.run_id = ?",
        )
        .get(runId) as { revision: number };
      expect(
        await client.request({
          operation: "run.restart",
          runId,
          expectedRevision: row.revision,
          payload: { targetSessionId: "session", coordinatorEpoch },
        }),
      ).toMatchObject({ outcome: "rejected", error: expect.stringContaining("unsettled effects") });
      expect(store.listWorkflowRuns()).toHaveLength(6);
    } finally {
      runs.close();
    }
  } finally {
    store.close();
    await client.close();
    await host.stop();
  }
}, 60_000);
