import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, reportBranch, waitUntil } from "./helpers.js";

it("keeps a completed parent's follow-up when its explicit restart fails", async () => {
  const cwd = await makeTempDir("restart-follow-up-project");
  const databasePath = path.join(await makeTempDir("restart-follow-up-state"), "state.sqlite");
  const workflowPath = path.join(cwd, "restart.workflow.ts");
  const gate = path.join(cwd, "finish-original");
  await fs.writeFile(
    workflowPath,
    `
import fs from "node:fs";
import { compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "restart-follow-up", startAt: "done", nodes: {
  done: compute({ run: async ({ state, signal }) => {
    if (state.runId !== "original") throw new Error("Restart failed");
    while (!fs.existsSync(${JSON.stringify(gate)})) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { done: true };
  } })
}, edges: [] });`,
  );
  const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
  const client = new WorkflowClient({ databasePath });
  await server.start();
  const runs = new WorkflowRunStore(databasePath, { readOnly: true });
  const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
  try {
    const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
    expect(
      await client.request({
        operation: "run.start",
        runId: "original",
        payload: {
          projectPath: cwd,
          ...resolved,
          input: {},
          launchOptions: {},
          originSessionId: "session",
          executionMode: "interactive",
        },
      }),
    ).toMatchObject({ outcome: "accepted" });
    await waitUntil(() => runs.readRun("original")?.state.status === "running", 30_000);
    const watched = await client.request({
      operation: "view.session.watch",
      payload: {
        subscriptionId: "owner",
        sessionId: "session",
        coordinator: true,
      },
    });
    const authority = {
      targetSessionId: "session",
      coordinatorEpoch: (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch,
    };
    expect(await reportBranch(client, authority)).toMatchObject({ outcome: "accepted" });
    const followUpResponse = await client.request({
      operation: "followUp.queue",
      runId: "original",
      payload: {
        ...authority,
        prompt: "Keep the successful source run's follow-up.",
      },
    });
    expect(followUpResponse.error).toBeUndefined();
    expect(followUpResponse.outcome).toBe("accepted");
    await fs.writeFile(gate, "finish");
    await waitUntil(() => queue.getWorkflowRun("original")?.status === "done", 30_000);
    const before = runs.readFollowUpQueue("original");
    expect(before?.followUps).toMatchObject([{ state: "queued" }]);
    const row = queue.state.connection
      .prepare(
        "SELECT r.revision FROM resources r JOIN runs w ON w.resource_id = r.resource_id WHERE w.run_id = ?",
      )
      .get("original") as { revision: number };
    const restarted = await client.request({
      operation: "run.restart",
      runId: "original",
      expectedRevision: row.revision,
      payload: authority,
    });
    expect(restarted.outcome).toBe("accepted");
    const childRunId = (restarted.receipt as { runId: string }).runId;
    await waitUntil(() => queue.getWorkflowRun(childRunId)?.status === "failed", 30_000);
    expect(runs.readFollowUpQueue("original")).toEqual(before);
    expect(runs.readRun("original")?.state.status).toBe("completed");
    expect(
      queue.state.connection
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'follow-up.cancelled'")
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    runs.close();
    queue.close();
    await client.close();
    await server.stop();
  }
}, 60_000);

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
  const server = new WorkflowServer({ databasePath, claimPollMs: 10 });
  const client = new WorkflowClient({ databasePath, clientId: "restart-owner" });
  await server.start();
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
    await reportBranch(client, { targetSessionId: "session", coordinatorEpoch });
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
    await server.stop();
  }
}, 60_000);
