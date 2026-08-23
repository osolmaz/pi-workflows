import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { builtinWorkflowCatalog } from "../builtins/catalog.js";
import {
  ControllerManager,
  loadDiscoveredControllers,
  SqliteControllerStore,
  WorkflowEngineScheduler,
  type WorkflowRunQueueRecord,
} from "../controllers/index.js";
import type { JsonObject } from "../controllers/types.js";
import { workflowStatePath } from "../state/database.js";
import { WorkflowEngine } from "../workflows/engine.js";
import {
  ClaimLostError,
  errorMessage,
  isClaimLostError,
  WorkflowSourceChangedError,
} from "../workflows/errors.js";
import { resolveWorkflowRef, resolveWorkflowSource } from "../workflows/loader.js";
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
  /** Explicit database path; defaults to the canonical workflow state database. */
  databasePath?: string;
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
 * expire, SQLite leases fence stale writers, and child processes are reaped by
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
  private readonly schedulerExecutors = new Map<WorkflowEngine, RpcStepExecutor>();
  /** Runs whose resume refused (edited source); skipped until a host restart. */
  private readonly skippedRuns = new Set<string>();
  private stopping = false;

  private readonly stateDir: string;

  constructor(options: WorkflowHostOptions) {
    this.options = options;
    this.runnerId = options.runnerId ?? `host-${randomUUID().slice(0, 8)}`;
    const databasePath = options.databasePath ?? workflowStatePath();
    this.store = new SqliteControllerStore(databasePath, { projectPath: options.cwd });
    this.stateDir = path.join(
      path.dirname(this.store.filePath),
      "hosts",
      hostProjectScope(options.cwd),
    );
    this.registry = options.registry ?? new HostProcessRegistry(this.stateDir);
    this.childRunStore = new WorkflowRunStore(databasePath);
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  /** Take the advisory lock, reap orphans, and start claiming. */
  async start(): Promise<void> {
    // The lock comes first: a second host must refuse before touching the
    // children registry, or it would kill the live host's child processes
    // as supposed orphans.
    acquireHostLock(this.stateDir, this.runnerId, this.options.cwd);
    const reaped = this.registry.reapOrphans();
    if (reaped.length > 0) {
      this.log(`reaped ${reaped.length} orphaned headless session(s): ${reaped.join(", ")}`);
    }

    const definitions = await loadDiscoveredControllers({ cwd: this.options.cwd });
    if (definitions.length > 0) {
      const scheduler = new WorkflowEngineScheduler({
        store: this.childRunStore,
        resolveWorkflow: async (name) => {
          const resolved = await resolveWorkflowRef(
            name,
            { cwd: this.options.cwd },
            builtinWorkflowCatalog,
          );
          return { workflow: resolved.definition, workflowSource: resolved.source };
        },
        createEngine: () => {
          const executor = new RpcStepExecutor({
            cwd: this.options.cwd,
            registry: this.registry,
            ...(this.options.piArgs !== undefined ? { piArgs: this.options.piArgs } : {}),
            ...(this.options.env !== undefined ? { env: this.options.env } : {}),
          });
          const engine = new WorkflowEngine({ executor, store: this.childRunStore });
          this.schedulerExecutors.set(engine, executor);
          return engine;
        },
        disposeEngine: async (engine) => {
          const executor = this.schedulerExecutors.get(engine);
          if (executor !== undefined) {
            this.schedulerExecutors.delete(engine);
            await executor.close();
          }
        },
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
    for (const executor of this.schedulerExecutors.values()) {
      await executor.close().catch(() => undefined);
    }
    this.schedulerExecutors.clear();
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
        excludeRunIds: [...this.skippedRuns],
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
    this.log(`resuming ${record.workflowName} run ${runId}`);
    let workflow: WorkflowDefinition;
    let workflowSource: import("../workflows/types.js").WorkflowSource;
    try {
      const bundle = this.childRunStore.readRun(runId);
      if (bundle?.state.workflowSource === undefined) {
        throw new Error(`Workflow run ${runId} has no canonical workflow source`);
      }
      workflow = await resolveWorkflowSource(
        bundle.state.workflowSource,
        builtinWorkflowCatalog,
        runId,
      );
      workflowSource = bundle.state.workflowSource;
    } catch (error) {
      if (error instanceof WorkflowSourceChangedError) {
        try {
          this.store.parkWorkflowRun({ runId, claimToken });
        } catch {
          // Best-effort.
        }
        this.skippedRuns.add(runId);
        this.recordEvent(runId, record.workflowName, "parked", {
          reason: "workflow source changed",
        });
        this.log(
          `run ${runId} skipped: workflow source changed; install the matching package revision, then restart the host`,
        );
        return;
      }
      await this.failUnresumable(record, claimToken, errorMessage(error));
      return;
    }
    if (this.stopping) {
      // The drain started during setup: park before anything executes.
      try {
        this.store.parkWorkflowRun({ runId, claimToken });
      } catch {
        // Best-effort.
      }
      return;
    }

    const store = this.store;
    const fence = () => {
      if (!store.verifyWorkflowRunClaim({ runId, claimToken })) {
        throw new ClaimLostError(runId);
      }
    };
    const fencedStore = new WorkflowRunStore(this.childRunStore.databasePath, {
      authorityProvider: () => store.workflowRunAuthority(runId, claimToken),
    });
    const executor = new RpcStepExecutor({
      cwd: this.options.cwd,
      registry: this.registry,
      ...(this.options.piArgs !== undefined ? { piArgs: this.options.piArgs } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
    const engine = new WorkflowEngine({
      executor,
      store: fencedStore,
      notificationSink: {
        notify: (request) => {
          fence();
          if (record.originSessionId === null) {
            throw new Error(`Workflow run ${request.runId} has no origin session`);
          }
          const notification = store.enqueueWorkflowNotification({
            ...request,
            targetSessionId: record.originSessionId,
          });
          return {
            notificationId: notification.notificationId,
            targetSessionId: notification.targetSessionId,
          };
        },
      },
    });
    if (!store.markWorkflowRunRunning({ runId, claimToken })) {
      throw new ClaimLostError(runId);
    }
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

    this.recordEvent(runId, record.workflowName, "resumed", { runnerId: this.runnerId });
    try {
      const result = await engine.resumeRun(workflow, runId, { workflowSource });
      clearInterval(renewTimer);
      if (result.state.status === "running") {
        // Parked again mid-drain: leave it claimable for the next runner.
        this.store.parkWorkflowRun({ runId, claimToken });
        this.store.settleRunEffect(runId, "run.park_queue");
        this.recordEvent(runId, record.workflowName, "parked", {});
        this.log(`parked ${record.workflowName} run ${runId}`);
        return;
      }
      this.store.completeWorkflowRun({ runId, claimToken });
      this.store.settleRunEffect(runId, "run.settle_queue");
      this.recordEvent(runId, record.workflowName, result.state.status, {
        ...(result.state.error !== undefined ? { error: result.state.error } : {}),
        ...(result.state.waitingOn !== undefined ? { waitingOn: result.state.waitingOn } : {}),
      });
      this.log(`${record.workflowName} run ${runId} ${result.state.status}`);
    } catch (error) {
      clearInterval(renewTimer);
      if (isClaimLostError(error)) {
        this.log(`run ${runId} continues under another runner`);
        return;
      }
      if (error instanceof WorkflowSourceChangedError) {
        // Edited source is a refusal, not a failure: keep the run claimable
        // for a later fix, and stop spinning on it for this host's lifetime.
        try {
          this.store.parkWorkflowRun({ runId, claimToken });
        } catch {
          // Best-effort.
        }
        this.skippedRuns.add(runId);
        this.recordEvent(runId, record.workflowName, "parked", {
          reason: "workflow source changed",
        });
        this.log(
          `run ${runId} skipped: workflow source changed; revert or force-resume it, then restart the host`,
        );
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
    let actualStatus: string | undefined;
    let heldClaim = false;
    try {
      // The interruption write obeys the same fencing rule as every other
      // state write: without a live claim, the current owner decides.
      heldClaim = this.store.verifyWorkflowRunClaim({ runId: record.runId, claimToken });
      if (heldClaim) {
        const claimedStore = new WorkflowRunStore(this.store.filePath, {
          state: this.store.state,
          authorityProvider: () => this.store.workflowRunAuthority(record.runId, claimToken),
        });
        const bundle = await claimedStore.markRunInterrupted(record.runId, message);
        actualStatus = bundle?.state.status;
      }
    } catch {
      // The run state may be unreadable; the queue row still needs closure.
    }
    try {
      this.store.completeWorkflowRun({ runId: record.runId, claimToken });
      this.store.settleRunEffect(record.runId, "run.settle_queue");
    } catch {
      // Best-effort.
    }
    if (!heldClaim) {
      // Another runner owns the run; its owner reports from here.
      this.log(`run ${record.runId} continues under another runner`);
      return;
    }
    // Report the run's real terminal state when the interruption was a
    // no-op (the run was already waiting or completed), so the feed
    // stays truthful for sessions syncing from it.
    if (actualStatus !== undefined && actualStatus !== "failed") {
      this.recordEvent(record.runId, record.workflowName, actualStatus, {});
    } else {
      this.recordEvent(record.runId, record.workflowName, "failed", { error: message });
    }
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

function hostProjectScope(cwd: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
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
