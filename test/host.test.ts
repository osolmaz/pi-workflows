import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { WorkflowHostClient } from "../src/host/client.js";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { HostStateStore } from "../src/host/state.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function writeComputeWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "compute.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-compute",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => ({ input, pid: process.pid }) }) },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeDeliveryWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "delivery.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, notify } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-delivery",
  presentationPrompt: ({ finalOutput }) => "Present " + JSON.stringify(finalOutput) + ".",
  startAt: "report",
  nodes: {
    report: notify({ kind: "progress", message: () => "Hosted progress." }),
    finish: compute({ run: () => ({ delivered: true }) }),
  },
  edges: [{ from: "report", to: "finish" }],
});\n`,
  );
  return workflowPath;
}

async function writeBlockingWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "blocking.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-blocking",
  startAt: "work",
  nodes: {
    work: compute({
      run: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
        return { finished: true };
      },
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeCrashEffectWorkflow(
  cwd: string,
  recovery: "idempotent" | "manual",
  markerPath?: string,
): Promise<string> {
  const workflowPath = path.join(cwd, `${recovery}-crash.workflow.ts`);
  const effectFactory = recovery === "idempotent" ? "idempotentEffect" : "manualEffect";
  const run =
    recovery === "idempotent"
      ? `() => {
          if (!existsSync(${JSON.stringify(markerPath)})) {
            writeFileSync(${JSON.stringify(markerPath)}, "applied");
            process.exit(23);
          }
          return { applied: true };
        }`
      : "() => process.exit(23)";
  await fs.writeFile(
    workflowPath,
    `import { existsSync, writeFileSync } from "node:fs";
import { action, defineWorkflow, ${effectFactory} } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: ${JSON.stringify(`host-${recovery}-crash`)},
  startAt: "effect",
  nodes: {
    effect: action({
      effect: ${effectFactory}(${JSON.stringify(`test.host-${recovery}-crash`)}),
      run: ${run},
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function startRun(options: {
  client: WorkflowHostClient;
  cwd: string;
  workflowPath: string;
  runId: string;
  executionMode?: "headless" | "interactive";
}): Promise<void> {
  const resolved = await options.client.resolveWorkflow({
    cwd: options.cwd,
    workflowRef: options.workflowPath,
  });
  const response = await options.client.request({
    operation: "run.start",
    runId: options.runId,
    payload: {
      projectPath: options.cwd,
      workflowName: resolved.workflowName,
      workflowSourceRef: resolved.workflowSourceRef,
      workflowSource: resolved.workflowSource,
      definitionDigest: resolved.definitionDigest,
      definitionSnapshot: resolved.definitionSnapshot,
      input: { value: 1 },
      launchOptions: {},
      originSessionId: "host-test-session",
      executionMode: options.executionMode ?? "headless",
    },
  });
  expect(response.outcome).toBe("accepted");
}

describe("global workflow host", () => {
  it("opens the canonical database and shuts down cleanly", async () => {
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    await host.stop();
  });

  it("closes idle client sockets before it waits for listener shutdown", async () => {
    const databasePath = path.join(await makeTempDir("host-idle-client"), "state.sqlite");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    const socket = net.createConnection(host.endpoint);
    await once(socket, "connect");
    const closed = once(socket, "close");
    await host.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "releases its claim and lock when the local listener cannot bind",
    async () => {
      const root = await makeTempDir("host-bind-failure");
      const stateDirectory = path.join(root, "a".repeat(70), "b".repeat(70));
      await fs.mkdir(stateDirectory, { recursive: true });
      const databasePath = path.join(stateDirectory, "state.sqlite");
      const host = new WorkflowHost({ databasePath, runnerId: "failed-host" });
      await expect(host.start()).rejects.toThrow();

      const state = new HostStateStore(databasePath, { readOnly: true });
      try {
        expect(state.hostStatus()).toMatchObject({ hostId: null, live: false });
      } finally {
        state.close();
      }
      await expect(
        fs.access(path.join(stateDirectory, "host", "host.lock.json")),
      ).rejects.toThrow();
      await host.stop();
    },
  );

  it("uses the database directory for its local process registry", async () => {
    const stateDir = await makeTempDir("host-state");
    const registry = new HostProcessRegistry(stateDir);
    const host = new WorkflowHost({
      databasePath: path.join(stateDir, "state.sqlite"),
      registry,
      claimPollMs: 10,
    });
    await host.start();
    await host.stop();
  });

  it("refuses every second host for the same global database", async () => {
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const first = new WorkflowHost({ databasePath, runnerId: "host-one", claimPollMs: 10 });
    const second = new WorkflowHost({ databasePath, runnerId: "host-two", claimPollMs: 10 });
    await first.start();
    await expect(second.start()).rejects.toThrow(/host/i);
    await first.stop();
  });

  it("executes workflow code only in a supervised child", async () => {
    const cwd = await makeTempDir("host-child-project");
    const databasePath = path.join(await makeTempDir("host-child-state"), "state.sqlite");
    const workflowPath = await writeComputeWorkflow(cwd);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "child-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("child-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("child-run")).toMatchObject({
          status: "done",
          executionMode: "headless",
        });
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("stores and serves hosted notifications and completion presentations", async () => {
    const cwd = await makeTempDir("host-delivery-project");
    const databasePath = path.join(await makeTempDir("host-delivery-state"), "state.sqlite");
    const workflowPath = await writeDeliveryWorkflow(cwd);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "delivery-run",
        executionMode: "interactive",
      });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("delivery-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);

      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        expect(
          store.listPendingWorkflowNotifications({ targetSessionId: "host-test-session" }),
        ).toMatchObject([{ content: "Hosted progress.", kind: "progress" }]);
        expect(
          store.listWorkflowTurnIntents({
            targetSessionId: "host-test-session",
            unresolvedOnly: true,
          }),
        ).toMatchObject([
          {
            runId: "delivery-run",
            cause: "terminal",
            fallbackFacts: { presentationPrompt: 'Present {"delivered":true}.' },
          },
        ]);
      } finally {
        store.close();
      }

      const notificationClaim = "notification-claim";
      const notification = await client.request({
        operation: "notification.claim",
        idempotencyKey: notificationClaim,
        payload: { targetSessionId: "host-test-session" },
      });
      expect(notification.receipt).toMatchObject({
        notification: { content: "Hosted progress." },
      });
      const notificationReceipt = notification.receipt as {
        claimId: string;
        notification: { notificationId: string };
      };
      const notificationRecord = notificationReceipt.notification;
      expect(
        await client.request({
          operation: "notification.deliver",
          payload: {
            notificationId: notificationRecord.notificationId,
            targetSessionId: "host-test-session",
            claimId: notificationReceipt.claimId,
          },
        }),
      ).toMatchObject({ outcome: "accepted" });

      const turnClaim = "turn-claim";
      const turn = await client.request({
        operation: "turn.claim",
        idempotencyKey: turnClaim,
        payload: { targetSessionId: "host-test-session" },
      });
      expect(turn.receipt).toMatchObject({
        turn: { runId: "delivery-run" },
      });
      expect(turn.receipt).not.toHaveProperty("state");
      const turnReceipt = turn.receipt as {
        claimId: string;
        turn: { intentId: string };
      };
      const turnRecord = turnReceipt.turn;
      expect(
        await client.request({
          operation: "turn.resolve",
          payload: {
            intentId: turnRecord.intentId,
            targetSessionId: "host-test-session",
            claimId: turnReceipt.claimId,
            messageId: "entry-one",
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("renews a live claim while workflow code blocks longer than its lease", async () => {
    const cwd = await makeTempDir("host-blocked-worker-project");
    const databasePath = path.join(await makeTempDir("host-blocked-worker-state"), "state.sqlite");
    const workflowPath = await writeBlockingWorkflow(cwd);
    const host = new WorkflowHost({
      databasePath,
      claimPollMs: 10,
      hostRenewMs: 40,
      runClaimLeaseMs: 200,
    });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "blocked-child-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("blocked-child-run")?.status === "running";
        } finally {
          store.close();
        }
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        const run = store.getWorkflowRun("blocked-child-run");
        expect(run?.status).toBe("running");
        expect(Date.parse(run?.claimExpiresAt ?? "")).toBeGreaterThan(Date.now());
      } finally {
        store.close();
      }
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("blocked-child-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("retries an interrupted idempotent effect and adopts its durable reservation", async () => {
    const cwd = await makeTempDir("host-idempotent-effect-project");
    const databasePath = path.join(
      await makeTempDir("host-idempotent-effect-state"),
      "state.sqlite",
    );
    const markerPath = path.join(cwd, "effect-applied");
    const workflowPath = await writeCrashEffectWorkflow(cwd, "idempotent", markerPath);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "idempotent-crash-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("idempotent-crash-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        const effect = store.state.connection
          .prepare(
            `SELECT e.status, e.attempt_count AS attemptCount FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("idempotent-crash-run", "test.host-idempotent-crash") as
          | { status: string; attemptCount: number }
          | undefined;
        expect(effect).toEqual({ status: "applied", attemptCount: 2 });
        const workers = store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get("idempotent-crash-run") as { count: number };
        expect(workers.count).toBe(2);
      } finally {
        store.close();
      }
      expect(await fs.readFile(markerPath, "utf8")).toBe("applied");
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("parks an interrupted manual effect as ambiguous without retrying it", async () => {
    const cwd = await makeTempDir("host-manual-effect-project");
    const databasePath = path.join(await makeTempDir("host-manual-effect-state"), "state.sqlite");
    const workflowPath = await writeCrashEffectWorkflow(cwd, "manual");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "manual-crash-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          const run = store.getWorkflowRun("manual-crash-run");
          return run?.status === "parked" && run.errorCode === "effectAmbiguous";
        } finally {
          store.close();
        }
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        const effect = store.state.connection
          .prepare(
            `SELECT e.status, e.attempt_count AS attemptCount FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("manual-crash-run", "test.host-manual-crash") as
          | { status: string; attemptCount: number }
          | undefined;
        expect(effect).toEqual({ status: "ambiguous", attemptCount: 1 });
        const workers = store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get("manual-crash-run") as { count: number };
        expect(workers.count).toBe(1);
      } finally {
        store.close();
      }
      const status = await client.request({ operation: "host.status" });
      expect(status.receipt).toMatchObject({ ambiguousEffects: 1 });
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("returns privacy-safe host status counts", async () => {
    const databasePath = path.join(await makeTempDir("host-status"), "state.sqlite");
    const host = new WorkflowHost({ databasePath });
    const client = new WorkflowHostClient({ databasePath });
    await host.start();
    try {
      const status = await client.request({ operation: "host.status" });
      expect(status.receipt).toMatchObject({
        state: "running",
        socketAvailable: true,
        activeWorkers: 0,
        queuedRuns: 0,
        pendingInteractions: 0,
        ambiguousEffects: 0,
        lifecycleContradictions: 0,
      });
      expect(status.receipt).not.toHaveProperty("hostId");
      expect(status.receipt).not.toHaveProperty("pid");
      expect(status.receipt).not.toHaveProperty("processStartIdentity");
    } finally {
      await host.stop();
    }
  });
});
