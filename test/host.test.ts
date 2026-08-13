import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectControllerStorePath, SqliteControllerStore } from "../src/controllers/index.js";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { compute, defineWorkflow, notify } from "../src/workflows/definition.js";
import { hashWorkflowSource } from "../src/workflows/loader.js";
import { RUN_STATE_SCHEMA, readRunBundle, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runningState(runId: string): WorkflowRunState {
  const now = "2026-08-04T00:00:00.000Z";
  return {
    schema: RUN_STATE_SCHEMA,
    traceSeq: 0,
    runId,
    workflowName: "parked-demo",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  };
}

describe("WorkflowHost", () => {
  it(
    "claims a parked run, resumes it, and completes the queue row",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-host-project");
      const runsDir = await makeTempDir("pi-host-runs");
      const controllerDir = await makeTempDir("pi-host-controllers");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
      try {
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        const workflowPath = path.join(cwd, ".pi", "workflows", "parked-demo.workflow.ts");
        await fs.writeFile(
          workflowPath,
          `import { compute, defineWorkflow, notify } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "parked-demo",
  startAt: "work",
  nodes: {
    work: compute({ run: () => "host-finished" }),
    report: notify({ kind: "final", message: ({ outputs }) => String(outputs.work) }),
  },
  edges: [{ from: "work", to: "report" }],
});
`,
          "utf8",
        );

        // A parked queue row with a bundle stopped mid-node.
        const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
        queue.enqueueWorkflowRun({
          runId: "host-run-1",
          workflowName: "parked-demo",
          workflowSourceRef: workflowPath,
          input: {},
          runnerId: "session-a",
          claimToken: "token-a",
          leaseMs: 60_000,
          originSessionId: "origin-session",
        });
        queue.parkWorkflowRun({ runId: "host-run-1", claimToken: "token-a" });
        const runStore = new WorkflowRunStore(runsDir);
        const workflow = defineWorkflow({
          name: "parked-demo",
          startAt: "work",
          nodes: {
            work: compute({ run: () => "ignored" }),
            report: notify({ kind: "final", message: ({ outputs }) => String(outputs.work) }),
          },
          edges: [{ from: "work", to: "report" }],
        });
        const state = {
          ...runningState("host-run-1"),
          workflowSource: {
            kind: "file" as const,
            path: workflowPath,
            hash: await hashWorkflowSource(workflowPath),
          },
        };
        const runDir = await runStore.initializeRunBundle(workflow, state);
        state.currentNode = "work";
        await runStore.writeSnapshot(runDir, state, {
          scope: "run",
          type: "run_started",
          payload: {},
        });
        await runStore.writeSnapshot(runDir, state, {
          scope: "node",
          type: "node_started",
          nodeId: "work",
          attemptId: "a1",
          payload: { nodeType: "compute" },
        });

        const logs: string[] = [];
        const host = new WorkflowHost({ cwd, claimPollMs: 25, onLog: (line) => logs.push(line) });
        await host.start();
        try {
          await waitFor(() => queue.getWorkflowRun("host-run-1")?.status === "done");
        } finally {
          await host.stop();
          queue.close();
        }

        const bundle = await readRunBundle(runDir);
        expect(bundle?.state.status).toBe("completed");
        expect(bundle?.state.outputs.work).toBe("host-finished");
        const reader = new SqliteControllerStore(projectControllerStorePath(cwd));
        try {
          const types = reader.listRunEventsAfter(0).map((event) => event.type);
          expect(types).toContain("resumed");
          expect(types).toContain("completed");
          expect(
            reader.claimPendingWorkflowNotifications({
              targetSessionId: "origin-session",
              claimToken: "host-test-reader",
              leaseMs: 1_000,
            }),
          ).toMatchObject([{ runId: "host-run-1", kind: "final", content: "host-finished" }]);
        } finally {
          reader.close();
        }
        expect(logs.some((line) => line.includes("completed"))).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("gates fail-unresumable interruption on the claim", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const runsDir = await makeTempDir("pi-host-runs");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowRun({
        runId: "fenced-fail",
        workflowName: "demo",
        workflowSourceRef: "/missing.workflow.ts",
        input: {},
        runnerId: "runner-a",
        claimToken: "token-a",
        leaseMs: 60_000,
      });
      const runStore = new WorkflowRunStore(runsDir);
      const workflow = defineWorkflow({
        name: "demo",
        startAt: "work",
        nodes: { work: compute({ run: () => 1 }) },
        edges: [],
      });
      const state = runningState("fenced-fail");
      const runDir = await runStore.initializeRunBundle(workflow, state);
      await runStore.writeSnapshot(runDir, state, {
        scope: "run",
        type: "run_started",
        payload: {},
      });

      // The host lost the claim (a new holder took over) before it failed.
      queue.parkWorkflowRun({ runId: "fenced-fail", claimToken: "token-a" });
      queue.claimNextWorkflowRun({ runnerId: "runner-b", claimToken: "token-b", leaseMs: 60_000 });

      const host = new WorkflowHost({ cwd, claimPollMs: 50 });
      const record = queue.getWorkflowRun("fenced-fail");
      if (record === undefined) {
        throw new Error("missing queue row");
      }
      await (
        host as unknown as {
          failUnresumable: (
            record: import("../src/controllers/index.js").WorkflowRunQueueRecord,
            claimToken: string,
            message: string,
          ) => Promise<void>;
        }
      ).failUnresumable(
        { ...record, runnerId: "runner-a", claimToken: "token-a" },
        "token-a",
        "load failed",
      );
      // The bundle belongs to the new claim holder: no interruption write.
      const last = await import("../src/workflows/store.js").then((module) =>
        module.readLastTraceEvent(runDir),
      );
      expect(last?.type).toBe("run_started");
      const bundle = await readRunBundle(runDir);
      expect(bundle?.state.status).toBe("running");
      queue.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("re-parks and skips a run whose workflow source changed", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-host-project");
    const runsDir = await makeTempDir("pi-host-runs");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      const workflowPath = path.join(cwd, ".pi", "workflows", "parked-demo.workflow.ts");
      await fs.writeFile(
        workflowPath,
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "parked-demo",
  startAt: "work",
  nodes: { work: compute({ run: () => "done" }) },
  edges: [],
});
`,
        "utf8",
      );
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowRun({
        runId: "edited-run",
        workflowName: "parked-demo",
        workflowSourceRef: workflowPath,
        input: {},
        runnerId: "session-a",
        claimToken: "token-a",
        leaseMs: 60_000,
      });
      queue.parkWorkflowRun({ runId: "edited-run", claimToken: "token-a" });
      const runStore = new WorkflowRunStore(runsDir);
      const workflow = defineWorkflow({
        name: "parked-demo",
        startAt: "work",
        nodes: { work: compute({ run: () => "ignored" }) },
        edges: [],
      });
      const state = {
        ...runningState("edited-run"),
        workflowSource: { kind: "file" as const, path: workflowPath, hash: "wrong-hash" },
      };
      const runDir = await runStore.initializeRunBundle(workflow, state);
      state.currentNode = "work";
      await runStore.writeSnapshot(runDir, state, {
        scope: "run",
        type: "run_started",
        payload: {},
      });

      const host = new WorkflowHost({ cwd, claimPollMs: 25 });
      await host.start();
      try {
        await waitFor(() => queue.getWorkflowRun("edited-run")?.status === "parked");
        // It stays parked (not done, not failed) and is not retried in a loop.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(queue.getWorkflowRun("edited-run")?.status).toBe("parked");
        const bundle = await readRunBundle(runDir);
        expect(bundle?.state.status).toBe("running");
      } finally {
        await host.stop();
        queue.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps an unproven legacy built-in parked", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-host-project");
    const runsDir = await makeTempDir("pi-host-runs");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowRun({
        runId: "unknown-built-in",
        workflowName: "monitor",
        workflowSourceRef: "/package/dist/workflows/monitor.workflow.js",
        input: {},
        runnerId: "session-a",
        claimToken: "token-a",
        leaseMs: 60_000,
      });
      queue.parkWorkflowRun({ runId: "unknown-built-in", claimToken: "token-a" });
      const runStore = new WorkflowRunStore(runsDir);
      const workflow = defineWorkflow({
        name: "monitor",
        startAt: "work",
        nodes: { work: compute({ run: () => "ignored" }) },
        edges: [],
      });
      const state = {
        ...runningState("unknown-built-in"),
        workflowName: "monitor",
        workflowPath: "/package/dist/workflows/monitor.workflow.js",
        workflowHash: "unknown-hash",
      };
      const runDir = await runStore.initializeRunBundle(workflow, state);
      const logs: string[] = [];
      const host = new WorkflowHost({ cwd, claimPollMs: 25, onLog: (line) => logs.push(line) });
      await host.start();
      try {
        await waitFor(() => logs.some((line) => line.includes("unknown source revision")));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(queue.getWorkflowRun("unknown-built-in")?.status).toBe("parked");
        expect((await readRunBundle(runDir))?.state.status).toBe("running");
      } finally {
        await host.stop();
        queue.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not reap the live host's children when a second host fails to start", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    const child = spawn("sleep", ["60"], { detached: true });
    const pid = child.pid as number;
    try {
      const first = new WorkflowHost({ cwd, claimPollMs: 50 });
      await first.start();
      // A live child registered as if the first host spawned it.
      const registry = new HostProcessRegistry(path.dirname(projectControllerStorePath(cwd)));
      registry.register(pid);
      try {
        const second = new WorkflowHost({ cwd, claimPollMs: 50 });
        await expect(second.start()).rejects.toThrow(/already running/);
        // The failed second host must not have touched the child.
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        await first.stop();
      }
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      vi.unstubAllEnvs();
    }
  });

  it(
    "runs controller workers headlessly and disposes their engines",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-host-project");
      const runsDir = await makeTempDir("pi-host-runs");
      const controllerDir = await makeTempDir("pi-host-controllers");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
      try {
        await fs.mkdir(path.join(cwd, ".pi", "controllers"), { recursive: true });
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        await fs.writeFile(
          path.join(cwd, ".pi", "workflows", "child.workflow.ts"),
          `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "child",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => input }) },
  edges: [],
});
`,
          "utf8",
        );
        await fs.writeFile(
          path.join(cwd, ".pi", "controllers", "demo.controller.ts"),
          `import { conditionTrue, defineController } from "@osolmaz/pi-workflows/controllers";
export default defineController({
  name: "demo",
  initialStatus: () => ({ phase: "new" }),
  async reconcile(ctx, resource) {
    const child = await ctx.workflows.ensure({
      requestKey: \`child:\${resource.metadata.generation}\`,
      workflow: "child",
      input: { value: resource.spec.value },
    });
    if (child.state === "succeeded") {
      return ctx.settled({
        controllerStatus: { phase: "done" },
        conditions: [conditionTrue("Ready", "Complete")],
      });
    }
    return ctx.requeueAfter(10, { controllerStatus: { phase: "running" } });
  },
});
`,
          "utf8",
        );
        const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
        queue.putResource({
          controller: "demo",
          key: "item-1",
          spec: { value: 41 },
          initialStatus: { phase: "new" },
        });

        const logs: string[] = [];
        const host = new WorkflowHost({ cwd, claimPollMs: 25, onLog: (line) => logs.push(line) });
        await host.start();
        try {
          await waitFor(
            () =>
              (
                queue.getResource({ controller: "demo", key: "item-1" })?.status
                  .controllerStatus as { phase?: string } | undefined
              )?.phase === "done",
          );
          expect(logs.some((line) => line.includes("controller workers started"))).toBe(true);
        } finally {
          await host.stop();
          queue.close();
        }
        // Scheduler engines were disposed: no registry entries linger.
        expect(logs.some((line) => line.includes("claim failed"))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("records a failed event for an unreadable bundle", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const runsDir = await makeTempDir("pi-host-runs");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowRun({
        runId: "corrupt-row",
        workflowName: "demo",
        workflowSourceRef: "/missing.workflow.ts",
        input: {},
        runnerId: "runner-a",
        claimToken: "token-a",
        leaseMs: 60_000,
      });
      // A bundle directory with a garbage manifest: unreadable.
      await fs.mkdir(path.join(runsDir, "corrupt-row"), { recursive: true });
      await fs.writeFile(path.join(runsDir, "corrupt-row", "manifest.json"), "junk", "utf8");

      const host = new WorkflowHost({ cwd, claimPollMs: 50 });
      const record = queue.getWorkflowRun("corrupt-row");
      if (record === undefined) {
        throw new Error("missing row");
      }
      await (
        host as unknown as {
          failUnresumable: (
            record: import("../src/controllers/index.js").WorkflowRunQueueRecord,
            claimToken: string,
            message: string,
          ) => Promise<void>;
        }
      ).failUnresumable(record, "token-a", "Cannot resume workflow run corrupt-row");
      expect(queue.listRunEventsAfter(0).at(-1)?.type).toBe("failed");
      queue.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a waiting bundle truthfully instead of a bogus failure", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const runsDir = await makeTempDir("pi-host-runs");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowRun({
        runId: "waiting-row",
        workflowName: "gate",
        workflowSourceRef: path.join(cwd, ".pi", "workflows", "gate.workflow.ts"),
        input: {},
        runnerId: "runner-a",
        claimToken: "token-a",
        leaseMs: 60_000,
      });
      // The bundle is already waiting at a checkpoint (terminal).
      const runStore = new WorkflowRunStore(runsDir);
      const { checkpoint, defineWorkflow } = await import("../src/workflows/definition.js");
      const { WorkflowEngine } = await import("../src/workflows/engine.js");
      const workflow = defineWorkflow({
        name: "gate",
        startAt: "approval",
        nodes: { approval: checkpoint({ summary: "approve" }) },
        edges: [],
      });
      const engine = new WorkflowEngine({
        executor: new (await import("./helpers.js")).ScriptedExecutor(),
        store: runStore,
      });
      await engine.run(workflow, {}, { runId: "waiting-row" });

      const host = new WorkflowHost({ cwd, claimPollMs: 50 });
      const record = queue.getWorkflowRun("waiting-row");
      if (record === undefined) {
        throw new Error("missing row");
      }
      await (
        host as unknown as {
          failUnresumable: (
            record: import("../src/controllers/index.js").WorkflowRunQueueRecord,
            claimToken: string,
            message: string,
          ) => Promise<void>;
        }
      ).failUnresumable(
        record,
        "token-a",
        "Cannot resume workflow run waiting-row with status waiting",
      );

      const events = queue.listRunEventsAfter(0);
      expect(events.at(-1)?.type).toBe("waiting");
      expect(events.some((event) => event.type === "failed")).toBe(false);
      queue.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("survives store errors in the claim loop", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const logs: string[] = [];
      const host = new WorkflowHost({ cwd, claimPollMs: 25, onLog: (line) => logs.push(line) });
      await host.start();
      const store = (host as unknown as { store: SqliteControllerStore }).store;
      const spy = vi.spyOn(store, "claimNextWorkflowRun").mockImplementation(() => {
        throw new Error("SQLITE_BUSY");
      });
      try {
        await waitFor(() => logs.some((line) => line.includes("claim failed, retrying shortly")));
      } finally {
        spy.mockRestore();
        await host.stop();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a second host for the same project", async () => {
    const cwd = await makeTempDir("pi-host-project");
    const controllerDir = await makeTempDir("pi-host-controllers");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      const first = new WorkflowHost({ cwd, claimPollMs: 50 });
      await first.start();
      try {
        const second = new WorkflowHost({ cwd, claimPollMs: 50 });
        await expect(second.start()).rejects.toThrow(/already running/);
      } finally {
        await first.stop();
      }
      // The lock is released; another host may start now.
      const third = new WorkflowHost({ cwd, claimPollMs: 50 });
      await third.start();
      await third.stop();
      // Stopping is idempotent.
      await third.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("HostProcessRegistry", () => {
  it("shrinks the file on unregister and never resurrects exited pids", async () => {
    const dir = await makeTempDir("pi-host-registry");
    const fsModule = await import("node:fs/promises");
    const registry = new HostProcessRegistry(dir);
    registry.register(424_242);
    registry.register(424_243);
    registry.unregister(424_242);
    const file = path.join(dir, "host.children.json");
    expect(JSON.parse(await fsModule.readFile(file, "utf8"))).toEqual([424_243]);
    registry.unregister(424_243);
    expect(JSON.parse(await fsModule.readFile(file, "utf8"))).toEqual([]);
    // A new registry over the same file finds nothing to reap.
    expect(new HostProcessRegistry(dir).reapOrphans()).toEqual([]);
  });

  it("reaps orphaned child process groups from a dead host", async () => {
    const dir = await makeTempDir("pi-host-registry");
    const child = spawn("sleep", ["60"], { detached: true });
    const pid = child.pid as number;
    try {
      const first = new HostProcessRegistry(dir);
      first.register(pid);
      // The "host" dies without unregistering; a new registry reaps.
      const second = new HostProcessRegistry(dir);
      const reaped = second.reapOrphans();
      expect(reaped).toContain(pid);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already reaped.
      }
    }
  });
});
