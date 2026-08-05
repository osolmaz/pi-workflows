import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectControllerStorePath, SqliteControllerStore } from "../src/controllers/index.js";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
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
          `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "parked-demo",
  startAt: "work",
  nodes: { work: compute({ run: () => "host-finished" }) },
  edges: [],
});
`,
          "utf8",
        );

        // A parked queue row with a bundle stopped mid-node.
        const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
        queue.enqueueWorkflowRun({
          runId: "host-run-1",
          workflowRef: "parked-demo",
          workflowPath,
          input: {},
          runnerId: "session-a",
          claimToken: "token-a",
          leaseMs: 60_000,
        });
        queue.parkWorkflowRun({ runId: "host-run-1", claimToken: "token-a" });
        const runStore = new WorkflowRunStore(runsDir);
        const workflow = defineWorkflow({
          name: "parked-demo",
          startAt: "work",
          nodes: { work: compute({ run: () => "ignored" }) },
          edges: [],
        });
        const state = runningState("host-run-1");
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
        expect(bundle?.state.finalOutput).toBe("host-finished");
        const reader = new SqliteControllerStore(projectControllerStorePath(cwd), {
          readOnly: true,
        });
        try {
          const types = reader.listRunEventsAfter(0).map((event) => event.type);
          expect(types).toContain("resumed");
          expect(types).toContain("completed");
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
        workflowRef: "demo",
        workflowPath: "/missing.workflow.ts",
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
        workflowRef: "parked-demo",
        workflowPath,
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
      const state = { ...runningState("edited-run"), workflowHash: "/dev/null" };
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
