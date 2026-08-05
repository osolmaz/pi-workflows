import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ControllerManager,
  loadDiscoveredControllers,
  projectControllerStorePath,
  SqliteControllerStore,
  WorkflowEngineScheduler,
  type WorkflowRunQueueRecord,
} from "../controllers/index.js";
import type { JsonObject } from "../controllers/types.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ClaimLostError, errorMessage, isClaimLostError } from "../workflows/errors.js";
import { hashWorkflowSource, loadWorkflowFile, resolveWorkflowRef } from "../workflows/loader.js";
import { WorkflowRunStore } from "../workflows/store.js";
import type { WorkflowDefinition } from "../workflows/types.js";
import { HostProcessRegistry } from "./processes.js";
import { RpcStepExecutor } from "./rpc-executor.js";

const CLAIM_POLL_MS = 2_000;
const RUN_CLAIM_LEASE_MS = 30_000;
const RUN_CLAIM_RENEW_MS = 10_000;

export type WorkflowHostOptions = {
  cwd: string;
  runnerId?: string;
  /** Explicit store path; defaults to the project-scoped controller store. */
  storeFile?: string;
  /** Explicit run-bundle root; defaults to the shared runs directory. */
  runsDir?: string;
  registry?: HostProcessRegistry;
  piArgs?: string[];
  /** Extra environment for headless children (for example a test provider). */
  env?: Record<string, string>;
  /** Poll interval for the claim loop; tests use a faster cadence. */
  claimPollMs?: number;
  onLog?: (message: string) => void;
};

/**
 * The always-on runner: claims parked workflow runs and reconciles durable
 * controllers without a Pi session. Conversation nodes execute in headless
 * `pi --mode rpc` children. Everything the host does is recoverable: claims
 * expire, bundles fence stale writers, and child processes are reaped by
 * the next host.
 */
export class WorkflowHost {
  private readonly options: WorkflowHostOptions;
  private readonly runnerId: string;
  private readonly registry: HostProcessRegistry;
  private readonly store: SqliteControllerStore;
  private readonly childRunStore: WorkflowRunStore;
  private manager: ControllerManager | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private stopping = false;

  private readonly stateDir: string;

  constructor(options: WorkflowHostOptions) {
    this.options = options;
    this.runnerId = options.runnerId ?? `host-${randomUUID().slice(0, 8)}`;
    this.store = new SqliteControllerStore(
      options.storeFile ?? projectControllerStorePath(options.cwd),
    );
    this.stateDir = path.dirname(this.store.filePath);
    this.registry = options.registry ?? new HostProcessRegistry(this.stateDir);
    this.childRunStore = new WorkflowRunStore(
      options.runsDir ?? process.env.PI_WORKFLOWS_RUNS_DIR ?? undefined,
    );
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  /** Reap orphans, take the advisory lock, and start claiming. */
  async start(): Promise<void> {
    const reaped = this.registry.reapOrphans();
    if (reaped.length > 0) {
      this.log(`reaped ${reaped.length} orphaned headless session(s): ${reaped.join(", ")}`);
    }
    acquireHostLock(this.stateDir, this.runnerId, this.options.cwd);

    const definitions = await loadDiscoveredControllers({ cwd: this.options.cwd });
    if (definitions.length > 0) {
      const scheduler = new WorkflowEngineScheduler({
        store: this.childRunStore,
        resolveWorkflow: async (name) => {
          const resolved = await resolveWorkflowRef(name, { cwd: this.options.cwd });
          const workflow = await loadWorkflowFile(resolved.path);
          return { workflow };
        },
        createEngine: () =>
          new WorkflowEngine({
            executor: new RpcStepExecutor({
              cwd: this.options.cwd,
              registry: this.registry,
              ...(this.options.piArgs !== undefined ? { piArgs: this.options.piArgs } : {}),
              ...(this.options.env !== undefined ? { env: this.options.env } : {}),
            }),
            store: this.childRunStore,
          }),
      });
      this.manager = new ControllerManager({
        store: this.store,
        controllers: definitions,
        workflowScheduler: scheduler,
      });
      this.manager.start();
      this.log(`controller workers started for ${definitions.length} controller(s)`);
    }

    this.pollTimer = setInterval(() => {
      this.claimOnce();
    }, this.options.claimPollMs ?? CLAIM_POLL_MS);
    this.pollTimer.unref?.();
    this.claimOnce();
    this.log(`host ${this.runnerId} watching ${this.options.cwd}`);
  }

  /** Drain: stop claiming, park in-flight runs, stop controllers, kill children. */
  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const pending = [...this.activeRuns.values()];
    for (const run of this.parkedEngines.splice(0)) {
      run();
    }
    await Promise.allSettled(pending);
    await this.manager?.stop().catch(() => undefined);
    this.registry.killAll();
    releaseHostLock(this.stateDir, this.runnerId);
    this.store.close();
  }

  private readonly parkedEngines: Array<() => void> = [];

  private claimOnce(): void {
    if (this.stopping || this.activeRuns.size > 0) {
      return;
    }
    let claimed: WorkflowRunQueueRecord | undefined;
    try {
      claimed = this.store.claimNextWorkflowRun({
        runnerId: this.runnerId,
        claimToken: randomUUID(),
        leaseMs: RUN_CLAIM_LEASE_MS,
      });
    } catch (error) {
      // Store contention or corruption must not kill the host's loop.
      this.log(`claim failed, retrying shortly: ${errorMessage(error)}`);
      return;
    }
    if (claimed === undefined) {
      return;
    }
    const task = this.runClaimed(claimed).finally(() => {
      this.activeRuns.delete(claimed.runId);
    });
    this.activeRuns.set(claimed.runId, task);
  }

  private async runClaimed(record: WorkflowRunQueueRecord): Promise<void> {
    const claimToken = record.claimToken as string;
    const runId = record.runId;
    this.log(`resuming ${record.workflowRef} run ${runId}`);
    let workflow: WorkflowDefinition;
    let workflowHash: string;
    try {
      workflow = await loadWorkflowFile(record.workflowPath);
      workflowHash = await hashWorkflowSource(record.workflowPath);
    } catch (error) {
      await this.failUnresumable(record, claimToken, errorMessage(error));
      return;
    }

    const store = this.store;
    const fence = () => {
      if (!store.verifyWorkflowRunClaim({ runId, claimToken })) {
        throw new ClaimLostError(runId);
      }
    };
    const fencedStore = new WorkflowRunStore(this.childRunStore.outputRoot, {
      fenceProvider: () => fence,
    });
    const executor = new RpcStepExecutor({
      cwd: this.options.cwd,
      registry: this.registry,
      ...(this.options.piArgs !== undefined ? { piArgs: this.options.piArgs } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
    const engine = new WorkflowEngine({ executor, store: fencedStore });
    const parkEngine = () => engine.park();
    this.parkedEngines.push(parkEngine);

    const renewTimer = setInterval(() => {
      try {
        if (!store.renewWorkflowRunClaim({ runId, claimToken, leaseMs: RUN_CLAIM_LEASE_MS })) {
          engine.cancel();
        }
      } catch {
        // Transient store errors leave fencing to decide ownership.
      }
    }, RUN_CLAIM_RENEW_MS);
    renewTimer.unref?.();

    this.recordEvent(runId, record.workflowRef, "resumed", { runnerId: this.runnerId });
    try {
      const result = await engine.resumeRun(workflow, runId, { workflowHash });
      clearInterval(renewTimer);
      if (result.state.status === "running") {
        // Parked again mid-drain: leave it claimable for the next runner.
        this.store.parkWorkflowRun({ runId, claimToken });
        this.recordEvent(runId, record.workflowRef, "parked", {});
        this.log(`parked ${record.workflowRef} run ${runId}`);
        return;
      }
      this.store.completeWorkflowRun({ runId, claimToken });
      this.recordEvent(runId, record.workflowRef, result.state.status, {
        ...(result.state.error !== undefined ? { error: result.state.error } : {}),
        ...(result.state.waitingOn !== undefined ? { waitingOn: result.state.waitingOn } : {}),
      });
      this.log(`${record.workflowRef} run ${runId} ${result.state.status}`);
    } catch (error) {
      clearInterval(renewTimer);
      if (isClaimLostError(error)) {
        this.log(`run ${runId} continues under another runner`);
        return;
      }
      await this.failUnresumable(record, claimToken, errorMessage(error));
    } finally {
      const index = this.parkedEngines.indexOf(parkEngine);
      if (index !== -1) {
        this.parkedEngines.splice(index, 1);
      }
      await executor.close().catch(() => undefined);
    }
  }

  private async failUnresumable(
    record: WorkflowRunQueueRecord,
    claimToken: string,
    message: string,
  ): Promise<void> {
    try {
      await this.childRunStore.markRunInterrupted(record.runId, message);
    } catch {
      // The bundle may be unreadable; the queue row still needs closure.
    }
    try {
      this.store.completeWorkflowRun({ runId: record.runId, claimToken });
    } catch {
      // Best-effort.
    }
    this.recordEvent(record.runId, record.workflowRef, "failed", { error: message });
    this.log(`run ${record.runId} cannot resume: ${message}`);
  }

  private recordEvent(runId: string, workflowRef: string, type: string, payload: JsonObject): void {
    try {
      this.store.recordRunEvent({ runId, workflowRef, type, payload, runnerId: this.runnerId });
    } catch {
      // The event feed is best-effort.
    }
  }
}

function hostLockPath(stateDir: string): string {
  return path.join(stateDir, "host.lock");
}

/**
 * The advisory lock guards host-versus-host only: the embedded runner in a
 * Pi session does not take it. A second host refuses to start while the
 * recorded PID is alive.
 */
function acquireHostLock(stateDir: string, runnerId: string, cwd: string): void {
  const lockPath = hostLockPath(stateDir);
  const existing = readLock(lockPath);
  if (existing !== null && existing.runnerId !== runnerId && isAlive(existing.pid)) {
    throw new Error(
      `Another workflow host (pid ${existing.pid}, ${existing.runnerId}) is already running for ${cwd}`,
    );
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: process.pid, runnerId, startedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function releaseHostLock(stateDir: string, runnerId: string): void {
  const lockPath = hostLockPath(stateDir);
  const existing = readLock(lockPath);
  if (existing?.runnerId !== runnerId) {
    return;
  }
  try {
    fs.rmSync(lockPath);
  } catch {
    // Already gone.
  }
}

function readLock(lockPath: string): { pid: number; runnerId: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      runnerId?: unknown;
    };
    if (typeof parsed.pid !== "number" || typeof parsed.runnerId !== "string") {
      return null;
    }
    return { pid: parsed.pid, runnerId: parsed.runnerId };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
