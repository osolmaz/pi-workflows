import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { WorkflowHostClient } from "../src/host/client.js";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { HostStateStore, type InteractiveRequestRecord } from "../src/host/state.js";
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

async function writeInteractiveWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-interactive",
  startAt: "ask",
  nodes: {
    ask: agent({ prompt: () => "Return a result." }),
    done: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "done" }],
});\n`,
  );
  return workflowPath;
}

async function writeIncludedInteractiveWorkflow(
  cwd: string,
): Promise<{ workflowPath: string; childPath: string }> {
  const childPath = path.join(cwd, "child.workflow.ts");
  const workflowPath = path.join(cwd, "included.workflow.ts");
  await fs.writeFile(
    childPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-included-child",
  startAt: "ask",
  exits: { done: { from: "finish" } },
  nodes: {
    ask: agent({ prompt: () => "Return a child result." }),
    finish: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "finish" }],
});\n`,
  );
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, includeWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-included-parent",
  startAt: "start",
  includes: { child: includeWorkflow({ workflow: "./child.workflow.ts" }) },
  nodes: {
    start: compute({ run: () => ({}) }),
    done: compute({ run: ({ outputs }) => outputs.child }),
  },
  edges: [
    { from: "start", to: "child" },
    { from: "child.done", to: "done" },
  ],
});\n`,
  );
  return { workflowPath, childPath };
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

async function writeBlockingEffectWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "blocking-effect.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { action, defineWorkflow, manualEffect } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-blocking-effect",
  startAt: "effect",
  nodes: {
    effect: action({
      effect: manualEffect("test.host-blocking-effect"),
      run: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        return { applied: true };
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

  it("contains accepted-client socket errors", async () => {
    const databasePath = path.join(await makeTempDir("host-client-error"), "state.sqlite");
    const logs: string[] = [];
    const host = new WorkflowHost({
      databasePath,
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    await host.start();
    try {
      const socket = net.createConnection(host.endpoint);
      await once(socket, "connect");
      await waitUntil(() => (host as unknown as { sockets: Set<net.Socket> }).sockets.size === 1);
      const acceptedSocket = [...(host as unknown as { sockets: Set<net.Socket> }).sockets][0];
      if (acceptedSocket === undefined) throw new Error("accepted socket was not tracked");
      const closed = once(socket, "close");
      expect(() => acceptedSocket.emit("error", new Error("test reset"))).not.toThrow();
      await closed;
      expect(logs).toContain("client socket error: test reset");

      const client = new WorkflowHostClient({ databasePath });
      await expect(client.request({ operation: "host.status" })).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { state: "running" },
      });
    } finally {
      await host.stop();
    }
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

  it("recovers a validating submission when the host restarts before activation", async () => {
    const cwd = await makeTempDir("host-validation-recovery-project");
    const databasePath = path.join(
      await makeTempDir("host-validation-recovery-state"),
      "state.sqlite",
    );
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const first = new WorkflowHost({ databasePath, runnerId: "host-first", claimPollMs: 10 });
    await first.start();
    await startRun({
      client: new WorkflowHostClient({ databasePath }),
      cwd,
      workflowPath,
      runId: "validation-recovery-run",
      executionMode: "interactive",
    });
    let interaction: InteractiveRequestRecord | undefined;
    await waitUntil(() => {
      const state = new HostStateStore(databasePath, { readOnly: true });
      try {
        interaction = state.listPendingInteractions("host-test-session")[0];
        return interaction !== undefined;
      } finally {
        state.close();
      }
    }, 30_000);
    await first.stop();
    if (interaction === undefined) throw new Error("interaction was not created");
    const recoveredInteraction = interaction;
    const state = new HostStateStore(databasePath);
    state.beginInteractionValidation({
      requestId: recoveredInteraction.requestId,
      submissionId: "restart-submission",
      idempotencyKey: "restart-submission",
      expectedRevision: recoveredInteraction.revision,
      payload: { output: { answer: "done" } },
      receipt: { status: "validating" },
    });
    state.close();

    const restarted = new WorkflowHost({
      databasePath,
      runnerId: "host-restarted",
      claimPollMs: 10,
    });
    await restarted.start();
    try {
      await waitUntil(() => {
        const observed = new HostStateStore(databasePath, { readOnly: true });
        try {
          return (
            observed.interactionSubmission(recoveredInteraction.requestId, "restart-submission")
              ?.outcome === "accepted"
          );
        } finally {
          observed.close();
        }
      }, 30_000);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("rejects changed mounted source before the resumed child executes it", async () => {
    const cwd = await makeTempDir("host-mounted-source-project");
    const databasePath = path.join(await makeTempDir("host-mounted-source-state"), "state.sqlite");
    const markerPath = path.join(cwd, "changed-source-executed");
    const { workflowPath, childPath } = await writeIncludedInteractiveWorkflow(cwd);
    const first = new WorkflowHost({
      databasePath,
      runnerId: "host-source-first",
      claimPollMs: 10,
    });
    await first.start();
    await startRun({
      client: new WorkflowHostClient({ databasePath }),
      cwd,
      workflowPath,
      runId: "mounted-source-run",
      executionMode: "interactive",
    });
    let interaction: InteractiveRequestRecord | undefined;
    await waitUntil(() => {
      const observed = new HostStateStore(databasePath, { readOnly: true });
      try {
        interaction = observed.listPendingInteractions("host-test-session")[0];
        return interaction !== undefined;
      } finally {
        observed.close();
      }
    }, 30_000);
    await first.stop();
    if (interaction === undefined) throw new Error("interaction was not created");
    const changedSourceInteraction = interaction;
    const state = new HostStateStore(databasePath);
    state.beginInteractionValidation({
      requestId: changedSourceInteraction.requestId,
      submissionId: "changed-source-submission",
      idempotencyKey: "changed-source-submission",
      expectedRevision: changedSourceInteraction.revision,
      payload: { output: { answer: "done" } },
      receipt: { status: "validating" },
    });
    state.close();
    await fs.writeFile(
      childPath,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");
export { default } from ${JSON.stringify(path.resolve("examples/workflows/echo.workflow.ts"))};\n`,
    );

    const restarted = new WorkflowHost({
      databasePath,
      runnerId: "host-source-restarted",
      claimPollMs: 10,
    });
    await restarted.start();
    try {
      await waitUntil(() => {
        const observed = new HostStateStore(databasePath, { readOnly: true });
        try {
          return (
            observed.interactionSubmission(
              changedSourceInteraction.requestId,
              "changed-source-submission",
            )?.outcome === "rejected"
          );
        } finally {
          observed.close();
        }
      }, 30_000);
      await expect(fs.access(markerPath)).rejects.toThrow();
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("commits active cancellation before it returns the durable receipt", async () => {
    const cwd = await makeTempDir("host-cancel-project");
    const databasePath = path.join(await makeTempDir("host-cancel-state"), "state.sqlite");
    const workflowPath = await writeBlockingWorkflow(cwd);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath, clientId: "cancel-client" });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "cancel-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          return store.getWorkflowRun("cancel-run")?.status === "running";
        } finally {
          store.close();
        }
      }, 30_000);
      const cancelled = await client.request({
        operation: "run.cancel",
        runId: "cancel-run",
        requestId: "cancel-request",
        idempotencyKey: "cancel-request",
      });
      expect(cancelled).toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-run", status: "cancelled" },
      });
      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("cancel-run")?.status).toBe("cancelled");
      } finally {
        store.close();
      }
      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-run",
          requestId: "cancel-request",
          idempotencyKey: "cancel-request",
        }),
      ).resolves.toMatchObject({ outcome: "adopted", receipt: { status: "cancelled" } });
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("cancels a parked interaction in the same durable transition", async () => {
    const cwd = await makeTempDir("host-cancel-interaction-project");
    const databasePath = path.join(
      await makeTempDir("host-cancel-interaction-state"),
      "state.sqlite",
    );
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath, clientId: "cancel-interaction-client" });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "cancel-interaction-run",
        executionMode: "interactive",
      });
      let interaction: InteractiveRequestRecord | undefined;
      await waitUntil(() => {
        const state = new HostStateStore(databasePath, { readOnly: true });
        try {
          interaction = state.listPendingInteractions("host-test-session")[0];
          const worker = state.state.connection
            .prepare(
              `SELECT status FROM run_workers
               WHERE run_id = ? ORDER BY started_at DESC LIMIT 1`,
            )
            .get("cancel-interaction-run") as { status: string } | undefined;
          return (
            interaction !== undefined &&
            worker !== undefined &&
            !["starting", "ready", "running"].includes(worker.status)
          );
        } finally {
          state.close();
        }
      }, 30_000);
      if (interaction === undefined) throw new Error("interaction was not created");

      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-interaction-run",
          requestId: "cancel-interaction-request",
          idempotencyKey: "cancel-interaction-request",
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-interaction-run", status: "cancelled" },
      });

      const state = new HostStateStore(databasePath, { readOnly: true });
      try {
        expect(state.getInteraction(interaction.requestId)?.status).toBe("cancelled");
        expect(state.listPendingInteractions("host-test-session")).toEqual([]);
      } finally {
        state.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("marks an applying effect ambiguous before cancellation returns", async () => {
    const cwd = await makeTempDir("host-cancel-effect-project");
    const databasePath = path.join(await makeTempDir("host-cancel-effect-state"), "state.sqlite");
    const workflowPath = await writeBlockingEffectWorkflow(cwd);
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    const client = new WorkflowHostClient({ databasePath, clientId: "cancel-effect-client" });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "cancel-effect-run" });
      await waitUntil(() => {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
        try {
          const effect = store.state.connection
            .prepare(
              `SELECT e.status FROM effects e
               JOIN runs r ON r.resource_id = e.source_resource_id
               WHERE r.run_id = ? AND e.effect_type = ?`,
            )
            .get("cancel-effect-run", "test.host-blocking-effect") as
            | { status: string }
            | undefined;
          return effect?.status === "applying";
        } finally {
          store.close();
        }
      }, 30_000);

      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-effect-run",
          requestId: "cancel-effect-request",
          idempotencyKey: "cancel-effect-request",
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-effect-run", status: "cancelled" },
      });

      const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("cancel-effect-run")?.status).toBe("cancelled");
        const effect = store.state.connection
          .prepare(
            `SELECT e.effect_id AS effectId, e.status, e.settled_at AS settledAt,
                    a.outcome AS attemptOutcome
             FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             JOIN effect_attempts a ON a.effect_id = e.effect_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("cancel-effect-run", "test.host-blocking-effect") as
          | {
              effectId: string;
              status: string;
              settledAt: number | null;
              attemptOutcome: string | null;
            }
          | undefined;
        expect(effect).toMatchObject({
          status: "ambiguous",
          attemptOutcome: "interrupted",
        });
        expect(effect?.settledAt).toEqual(expect.any(Number));
        const event = store.state.connection
          .prepare(
            `SELECT event_type AS eventType FROM events
             WHERE resource_id = (SELECT resource_id FROM effects WHERE effect_id = ?)`,
          )
          .all(effect?.effectId) as Array<{ eventType: string }>;
        expect(event.map((record) => record.eventType)).toContain("effect.ambiguous");
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

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
