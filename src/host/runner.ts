import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { applyStatusPatch } from "../controllers/conditions.js";
import { ResourceConflictError } from "../controllers/errors.js";
import {
  controllerFileStem,
  controllerSearchDirs,
  discoverControllers,
} from "../controllers/loader.js";
import {
  SqliteControllerStore,
  type WorkflowRunQueueRecord,
  type WorkflowTurnIntentFacts,
} from "../controllers/sqlite.js";
import type {
  ControllerQueueClaim,
  ControllerResource,
  ControllerSettingsChangeRequest,
  ControllerSettingsChangeResult,
  ReconcileResult,
} from "../controllers/types.js";
import {
  ControllerWorkflowCoordinator,
  type ControllerWorkflowControlRequest,
  type ControllerWorkflowScheduler,
  type WorkflowSchedulerRequest,
  type WorkflowSchedulerResult,
} from "../controllers/workflows.js";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { recordViewerDeltas } from "../state/viewer.js";
import { errorMessage } from "../workflows/errors.js";
import { HumanDecisionStore } from "../workflows/human-decision.js";
import {
  type WorkflowSettingsDefinition,
  type WorkflowSettingsPathRule,
} from "../workflows/settings.js";
import { WorkflowRunStore } from "../workflows/store.js";
import type {
  HumanDecisionRequest,
  HumanDecisionResponse,
  ResolvedHumanDecision,
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
} from "../workflows/types.js";
import { validateWorkflowUpdate } from "../workflows/updates.js";
import { WorkflowHostClient } from "./client.js";
import type {
  ControllerWorkerLaunchEnvelope,
  ControllerWorkerMessage,
  ControllerWorkerResponse,
} from "./controller-worker-protocol.js";
import { ControllerWorkerSupervisor } from "./controller-worker-supervisor.js";
import {
  HostProcessRegistry,
  matchesProcessIdentity,
  processParentPid,
  processStartIdentity,
} from "./processes.js";
import {
  encodeProtocolLine,
  hostSocketPath,
  NdjsonFrameDecoder,
  parseHostRequest,
  type HostRequest,
  type HostResponse,
} from "./protocol.js";
import {
  HostStateStore,
  type HostClaim,
  type InteractiveRequestRecord,
  type InteractiveSubmissionRecord,
  type WorkerLaunchEnvelope,
} from "./state.js";
import type { WorkerMessage, WorkerResponse } from "./worker-protocol.js";
import { WorkflowWorkerSupervisor } from "./worker-supervisor.js";

const HOST_LEASE_MS = 30_000;
const HOST_RENEW_MS = 10_000;
const CLAIM_POLL_MS = 2_000;
const RUN_CLAIM_LEASE_MS = 30_000;
const PRESENTATION_CLAIM_LEASE_MS = 10_000;
const DELIVERY_CLAIM_LEASE_MS = 10_000;
const CONTROLLER_CLAIM_LEASE_MS = 120_000;
const CONTROLLER_RENEW_MS = 30_000;
const MAX_CONTROLLER_WORKERS = 4;
const DEFAULT_CONTROLLER_TIMEOUT_MS = 60_000;

export type WorkflowHostOptions = {
  /** Retained for callers; the host itself is global to the state database. */
  cwd?: string;
  runnerId?: string;
  databasePath?: string;
  registry?: HostProcessRegistry;
  piArgs?: string[];
  env?: Record<string, string>;
  claimPollMs?: number;
  hostLeaseMs?: number;
  hostRenewMs?: number;
  runClaimLeaseMs?: number;
  workerEntryPath?: string;
  workerStartupTimeoutMs?: number;
  controllerWorkerEntryPath?: string;
  onLog?: (message: string) => void;
};

type ActiveRun = {
  record: WorkflowRunQueueRecord;
  claimToken: string;
  generation: number;
  supervisor: WorkflowWorkerSupervisor;
  workerPid?: number;
  exiting: boolean;
  workflowLoadFailure?: string;
  control?: "cancel" | "pause" | "handoff";
  claimLost?: boolean;
};

type DeliveryClaim = {
  clientId: string;
  token: string;
  targetSessionId: string;
  kind: "notification" | "turn";
  resourceId: string;
  expiresAt: number;
};

type ActiveController = {
  key: string;
  projectPath: string;
  store: SqliteControllerStore;
  claim: ControllerQueueClaim;
  resource: ControllerResource;
  reconcileId: string;
  startedAt: number;
  supervisor: ControllerWorkerSupervisor;
  renewTimer: ReturnType<typeof setInterval>;
  settled: boolean;
};

/** Global package-owned host. It writes state and supervises code-only workers. */
export class WorkflowHost {
  private readonly options: WorkflowHostOptions;
  private readonly hostId: string;
  private readonly databasePath: string;
  private readonly stateDirectory: string;
  private readonly socketPath: string;
  private readonly lockPath: string;
  private readonly state: StateDatabase;
  private readonly hostState: HostStateStore;
  private readonly queue: SqliteControllerStore;
  private readonly decisions: HumanDecisionStore;
  private readonly runStore: WorkflowRunStore;
  private readonly registry: HostProcessRegistry;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly workerDescendants = new Map<string, Set<number>>();
  private readonly activeControllers = new Map<string, ActiveController>();
  private readonly controlClaims = new Map<string, string>();
  private readonly activationTasks = new Map<string, Promise<void>>();
  private readonly pendingStarts = new Set<string>();
  private readonly pendingRunClaims = new Map<string, string>();
  private readonly pendingResumes = new Set<string>();
  private readonly blockedRuns = new Set<string>();
  private readonly deliveryClaims = new Map<string, DeliveryClaim>();
  private readonly sockets = new Set<Socket>();
  private server: net.Server | null = null;
  private claim: HostClaim | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private started = false;
  private controllerPollActive = false;
  private decisionTimeoutActive = false;

  constructor(options: WorkflowHostOptions = {}) {
    this.options = options;
    this.hostId = options.runnerId ?? `host-${randomUUID()}`;
    this.databasePath = path.resolve(options.databasePath ?? workflowStatePath());
    this.stateDirectory = path.join(path.dirname(this.databasePath), "host");
    this.socketPath = hostSocketPath(this.databasePath);
    this.lockPath = path.join(this.stateDirectory, "host.lock.json");
    this.state = new StateDatabase({ filePath: this.databasePath });
    this.hostState = new HostStateStore(this.databasePath, { state: this.state });
    this.queue = new SqliteControllerStore(this.databasePath, { state: this.state, global: true });
    this.decisions = new HumanDecisionStore(this.databasePath, {
      state: this.state,
      authorityProvider: (runId) => {
        const token = this.controlClaims.get(runId) ?? this.activeRuns.get(runId)?.claimToken;
        return token === undefined ? undefined : this.queue.workflowRunAuthority(runId, token);
      },
    });
    this.runStore = new WorkflowRunStore(this.databasePath, {
      state: this.state,
      authorityProvider: (runId) => {
        const token = this.controlClaims.get(runId) ?? this.activeRuns.get(runId)?.claimToken;
        return token === undefined ? undefined : this.queue.workflowRunAuthority(runId, token);
      },
      snapshotLifecycle: (context) => this.applyLifecycleProjection(context),
    });
    this.registry = options.registry ?? new HostProcessRegistry(this.stateDirectory);
  }

  get endpoint(): string {
    return this.socketPath;
  }

  private get runClaimLeaseMs(): number {
    return this.options.runClaimLeaseMs ?? RUN_CLAIM_LEASE_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    fs.mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDirectory, 0o700);
    const startIdentity = processStartIdentity(process.pid);
    if (startIdentity === undefined) {
      throw new Error("Cannot attest the workflow host process start identity");
    }
    acquireHostLock(this.lockPath, { pid: process.pid, startIdentity, hostId: this.hostId });
    try {
      const reaped = this.registry.reapOrphans();
      if (reaped.length > 0) this.log(`reaped ${reaped.length} exact orphan process(es)`);
      const previousHost = this.hostState.hostStatus();
      this.claim = this.hostState.acquireHost({
        hostId: this.hostId,
        pid: process.pid,
        processStartIdentity: startIdentity,
        leaseMs: this.options.hostLeaseMs ?? HOST_LEASE_MS,
      });
      this.recoverPreviousHost(previousHost.hostId, this.claim.epoch);
      await this.listen();
      this.startTimers();
      this.started = true;
      this.log(`ready on ${this.socketPath} at epoch ${this.claim.epoch}`);
      this.expireTimedOutInteraction();
      void this.expireTimedOutDecision();
      void this.claimOne();
      void this.claimControllerOne();
    } catch (error) {
      const server = this.server;
      this.server = null;
      await this.closeServer(server);
      if (this.claim !== null) {
        try {
          this.hostState.releaseHost(this.claim);
        } catch {
          // Preserve the startup error when cleanup cannot release an already-lost claim.
        }
      }
      this.claim = null;
      if (process.platform !== "win32") fs.rmSync(this.socketPath, { force: true });
      this.releaseLock();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
    const server = this.server;
    this.server = null;
    await this.closeServer(server);
    for (const [runId, claimToken] of this.pendingRunClaims) {
      this.queue.parkWorkflowRun({ runId, claimToken });
    }
    this.pendingRunClaims.clear();
    this.pendingStarts.clear();
    await Promise.allSettled(
      [...this.activeRuns.values()].map(async (active) => {
        active.control = "handoff";
        await active.supervisor.stop("orphaned");
        this.queue.parkWorkflowRun({ runId: active.record.runId, claimToken: active.claimToken });
      }),
    );
    await Promise.allSettled(
      [...this.activeControllers.values()].map(async (active) => {
        clearInterval(active.renewTimer);
        await active.supervisor.stop("orphaned");
        if (!active.settled) {
          active.store.requeueClaim(
            active.claim,
            { availableAt: new Date().toISOString(), error: "Workflow host stopped" },
            new Date().toISOString(),
          );
        }
      }),
    );
    await Promise.allSettled(this.activationTasks.values());
    this.registry.killAll();
    this.deliveryClaims.clear();
    if (this.claim !== null) this.hostState.releaseHost(this.claim);
    this.claim = null;
    if (process.platform !== "win32") fs.rmSync(this.socketPath, { force: true });
    this.releaseLock();
    this.runStore.close();
    this.queue.close();
    this.hostState.close();
    this.state.close();
    this.started = false;
  }

  private async closeServer(server: net.Server | null): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      if (server === null || !server.listening) {
        resolve();
        return;
      }
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    for (const socket of this.sockets) socket.destroy();
    await closed;
    this.sockets.clear();
  }

  private recoverPreviousHost(previousHostId: string | null, hostEpoch: number): void {
    if (previousHostId === null || previousHostId === this.hostId) return;
    const now = Date.now();
    this.state.transaction(() => {
      this.state.connection
        .prepare(
          `UPDATE leases SET expires_at = ?
           WHERE owner_id = ? AND owner_type IN ('host', 'controller') AND expires_at > ?`,
        )
        .run(now, previousHostId, now);
      this.state.connection
        .prepare(
          `UPDATE run_workers SET status = 'orphaned', finished_at = ?
           WHERE host_epoch < ? AND status IN ('starting', 'ready', 'running')`,
        )
        .run(now, hostEpoch);
    });
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.claim === null) return;
        this.claim = this.hostState.renewHost(
          this.claim,
          this.options.hostLeaseMs ?? HOST_LEASE_MS,
        );
        for (const active of this.activeRuns.values()) {
          if (active.control !== undefined || active.exiting) continue;
          if (
            !this.queue.renewWorkflowRunClaim({
              runId: active.record.runId,
              claimToken: active.claimToken,
              leaseMs: this.runClaimLeaseMs,
            })
          ) {
            active.claimLost = true;
            void active.supervisor.stop("claimLost");
          }
        }
      } catch (error) {
        this.log(`host claim lost: ${errorMessage(error)}`);
        void this.stop();
      }
    }, this.options.hostRenewMs ?? HOST_RENEW_MS);
    this.heartbeatTimer.unref?.();
    this.pollTimer = setInterval(() => {
      this.expireTimedOutInteraction();
      void this.expireTimedOutDecision();
      void this.claimOne();
      void this.claimControllerOne();
    }, this.options.claimPollMs ?? CLAIM_POLL_MS);
    this.pollTimer.unref?.();
  }

  private async listen(): Promise<void> {
    if (process.platform !== "win32") fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      try {
        server.listen(this.socketPath);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    server.on("error", (error) => this.log(`socket error: ${errorMessage(error)}`));
    if (process.platform !== "win32") fs.chmodSync(this.socketPath, 0o600);
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new NdjsonFrameDecoder();
    let processing = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        processing = processing
          .then(async () => {
            const request = parseHostRequest(frame);
            const response = this.handleRequest(request);
            if (!socket.write(encodeProtocolLine(response))) await once(socket, "drain");
          })
          .catch(() => {
            socket.destroy();
          });
      }
    });
    socket.on("error", (error) => {
      this.log(`client socket error: ${errorMessage(error)}`);
      socket.destroy();
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  private handleRequest(request: HostRequest): HostResponse {
    if (this.claim === null || this.stopping) {
      return {
        schema: "pi-workflows.host-response.v1",
        requestId: request.requestId,
        outcome: "unavailable",
        error: "Workflow host is stopping",
      };
    }
    const afterCommit: Array<() => void> = [];
    let response: HostResponse;
    try {
      response = this.hostState.executeCommand(request, this.claim.epoch, () =>
        this.executeOperation(request, afterCommit),
      );
    } catch (error) {
      response = {
        schema: "pi-workflows.host-response.v1",
        requestId: request.requestId,
        outcome: "rejected",
        error: errorMessage(error),
      };
    }
    for (const effect of afterCommit) setImmediate(effect);
    return response;
  }

  private executeOperation(
    request: HostRequest,
    afterCommit: Array<() => void>,
  ): Omit<HostResponse, "schema" | "requestId"> {
    switch (request.operation) {
      case "host.status":
        return { outcome: "accepted", receipt: this.statusReceipt() };
      case "host.stop":
        afterCommit.push(() => void this.stop());
        return { outcome: "accepted", receipt: { stopping: true } };
      case "run.list":
        return {
          outcome: "accepted",
          receipt: this.queue.listWorkflowRuns({
            limit: payloadLimit(request.payload),
          }) as JsonValue,
        };
      case "run.status": {
        const runId = requireRunId(request);
        const run = this.queue.getWorkflowRun(runId);
        return run === undefined
          ? { outcome: "notFound", error: `Workflow run not found: ${runId}` }
          : { outcome: "accepted", receipt: run as unknown as JsonValue };
      }
      case "run.cancel": {
        const runId = requireRunId(request);
        const active = this.activeRuns.get(runId);
        if (active !== undefined) {
          if (
            !this.queue.cancelWorkflowRun({
              runId: active.record.runId,
              claimToken: active.claimToken,
            })
          ) {
            return { outcome: "claimLost", error: "Run claim was lost before cancellation" };
          }
          active.control = "cancel";
          afterCommit.push(() => void active.supervisor.stop("cancelled"));
          return { outcome: "accepted", receipt: { runId, status: "cancelled" } };
        }
        const pendingClaim = this.pendingRunClaims.get(runId);
        if (pendingClaim !== undefined) {
          if (!this.queue.cancelWorkflowRun({ runId, claimToken: pendingClaim })) {
            return { outcome: "claimLost", error: "Run claim was lost before cancellation" };
          }
          this.clearPendingStart(runId, pendingClaim);
          return { outcome: "accepted", receipt: { runId, status: "cancelled" } };
        }
        const cancelled = this.queue.cancelWorkflowRun({ runId });
        return cancelled
          ? { outcome: "accepted", receipt: { runId, status: "cancelled" } }
          : { outcome: "rejected", error: "Run has a live owner or is already terminal" };
      }
      case "run.pause": {
        const runId = requireRunId(request);
        const active = this.activeRuns.get(runId);
        if (active !== undefined) {
          if (active.control === "pause") {
            return { outcome: "adopted", receipt: { runId, status: "parked", paused: true } };
          }
          if (active.control === "handoff") {
            const paused = this.queue.pauseParkedWorkflowRun({ runId });
            return paused
              ? { outcome: "accepted", receipt: { runId, status: "parked", paused: true } }
              : { outcome: "rejected", error: "Run handoff is not pausable" };
          }
          if (active.control !== undefined) {
            return { outcome: "rejected", error: `Run is already handling ${active.control}` };
          }
          this.commitActivePause(active);
          active.control = "pause";
          afterCommit.push(() => void active.supervisor.stop("cancelled"));
          return { outcome: "accepted", receipt: { runId, status: "parked", paused: true } };
        }
        const paused = this.queue.pauseParkedWorkflowRun({ runId });
        return paused
          ? { outcome: "accepted", receipt: { runId, status: "parked", paused: true } }
          : { outcome: "rejected", error: "Run is not pausable" };
      }
      case "run.resume": {
        const runId = requireRunId(request);
        if (this.activeRuns.has(runId) || this.pendingStarts.has(runId)) {
          return { outcome: "adopted", receipt: { runId, active: true } };
        }
        if (this.queue.resumePausedInteraction({ runId })) {
          return {
            outcome: "accepted",
            receipt: { runId, status: "parked", paused: false, waitingForInteraction: true },
          };
        }
        const token = randomUUID();
        const claimed = this.queue.claimWorkflowRun({
          runId,
          runnerId: this.hostId,
          claimToken: token,
          leaseMs: this.runClaimLeaseMs,
        });
        if (claimed === undefined) return { outcome: "rejected", error: "Run is not resumable" };
        this.markPendingStart(runId, token);
        afterCommit.push(() => void this.activateRun(claimed, token));
        return { outcome: "accepted", receipt: { runId, generation: claimed.claimGeneration } };
      }
      case "run.start":
        return this.startRun(request, afterCommit);
      case "checkpoint.answer":
        return this.answerCheckpoint(request, afterCommit);
      case "notification.claim":
        return this.claimNotification(request);
      case "notification.deliver":
        return this.deliverNotification(request);
      case "turn.claim":
        return this.claimTurn(request);
      case "turn.resolve":
        return this.resolveTurn(request);
      case "controller.list":
      case "controller.get":
      case "controller.apply":
      case "controller.reconcile":
      case "controller.delete":
        return this.executeControllerOperation(request);
      case "interaction.update": {
        const payload = requireRecord(request.payload, "interaction update payload");
        if (payload.claimPresentation === true) {
          try {
            const interaction = this.hostState.claimInteractionPresentation({
              requestId: requireString(payload.requestId, "requestId"),
              expectedRevision: requireNonNegativeInteger(
                request.expectedRevision,
                "expectedRevision",
              ),
              presenterId: request.clientId,
              leaseMs: PRESENTATION_CLAIM_LEASE_MS,
            });
            return {
              outcome: "accepted",
              revision: interaction.revision,
              receipt: interaction as unknown as JsonValue,
            };
          } catch (error) {
            if (errorMessage(error) === "Interactive request presentation claim conflict") {
              return { outcome: "conflict", error: errorMessage(error) };
            }
            throw error;
          }
        }
        if (typeof payload.sessionEntryId === "string") {
          const interaction = this.hostState.markInteractionPresented({
            requestId: requireString(payload.requestId, "requestId"),
            expectedRevision: requireNonNegativeInteger(
              request.expectedRevision,
              "expectedRevision",
            ),
            sessionEntryId: payload.sessionEntryId,
          });
          return {
            outcome: "accepted",
            revision: interaction.revision,
            receipt: interaction as unknown as JsonValue,
          };
        }
        return this.publishInteractionUpdate(request);
      }
      case "interaction.submit":
        return this.submitInteraction(request);
      case "decision.answer":
        return this.answerDecision(request, afterCommit);
    }
  }

  private executeControllerOperation(
    request: HostRequest,
  ): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(request.payload, "controller payload");
    const projectPath = path.resolve(requireString(payload.projectPath, "projectPath"));
    if (payload.projectPath !== projectPath) {
      return {
        outcome: "rejected",
        error: "Controller projectPath must be absolute and normalized",
      };
    }
    const store = new SqliteControllerStore(this.databasePath, {
      state: this.state,
      projectPath,
    });
    if (request.operation === "controller.list") {
      return { outcome: "accepted", receipt: store.listResources() as unknown as JsonValue };
    }
    const controller = requireString(payload.controller, "controller");
    const key = requireString(payload.key, "key");
    const ref = { controller, key };
    if (request.operation === "controller.get") {
      const resource = store.getResource(ref);
      return resource === undefined
        ? { outcome: "notFound", error: `Controller resource not found: ${controller}/${key}` }
        : { outcome: "accepted", receipt: resource as unknown as JsonValue };
    }
    if (request.operation === "controller.apply") {
      if (!Object.hasOwn(payload, "spec") || !Object.hasOwn(payload, "initialStatus")) {
        return { outcome: "rejected", error: "Controller apply requires spec and initialStatus" };
      }
      const spec = payload.spec as JsonValue;
      const initialStatus = payload.initialStatus as JsonValue;
      const controllerPath = path.resolve(requireString(payload.controllerPath, "controllerPath"));
      const sourceHash = requireString(payload.sourceHash, "sourceHash");
      if (!controllerPathAllowed(projectPath, controller, controllerPath)) {
        return { outcome: "rejected", error: "Controller source does not match discovery rules" };
      }
      const observedHash = createHash("sha256")
        .update(fs.readFileSync(controllerPath))
        .digest("hex");
      if (observedHash !== sourceHash) {
        return { outcome: "conflict", error: "Controller source changed before apply committed" };
      }
      const resource = store.putResource({ controller, key, spec, initialStatus });
      return { outcome: "accepted", receipt: resource as unknown as JsonValue };
    }
    const existing = store.getResource(ref);
    if (existing === undefined) {
      return { outcome: "notFound", error: `Controller resource not found: ${controller}/${key}` };
    }
    if (request.operation === "controller.reconcile") {
      store.enqueue(ref);
      return { outcome: "accepted", receipt: existing as unknown as JsonValue };
    }
    const deleting = store.requestDeletion(ref);
    store.enqueue(ref);
    return { outcome: "accepted", receipt: deleting as unknown as JsonValue };
  }

  private statusReceipt(): JsonValue {
    const host = this.hostState.hostStatus();
    const count = (sql: string, ...params: unknown[]): number => {
      const row = this.state.connection.prepare(sql).get(...params) as
        | { count?: unknown }
        | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    };
    const now = Date.now();
    return {
      state: host.live ? "running" : "stale",
      epoch: host.epoch,
      socketAvailable: this.server?.listening === true,
      startedAt: host.startedAt,
      heartbeatAt: host.heartbeatAt,
      expiresAt: host.expiresAt,
      activeWorkers: this.activeRuns.size,
      connectedClients: this.sockets.size,
      queuedRuns: count("SELECT COUNT(*) AS count FROM run_queue WHERE status = 'queued'"),
      runningRuns: count(
        "SELECT COUNT(*) AS count FROM run_queue WHERE status IN ('starting', 'running')",
      ),
      parkedRuns: count("SELECT COUNT(*) AS count FROM run_queue WHERE status = 'parked'"),
      waitingRuns: count("SELECT COUNT(*) AS count FROM runs WHERE status = 'waiting'"),
      expiredClaims: count(
        `SELECT COUNT(*) AS count FROM run_queue q
         JOIN runs r ON r.run_id = q.run_id
         JOIN leases l ON l.resource_id = r.resource_id
         WHERE q.status NOT IN ('done', 'failed', 'cancelled')
           AND l.owner_id IS NOT NULL AND l.expires_at <= ?`,
        now,
      ),
      pendingInteractions: count(
        "SELECT COUNT(*) AS count FROM interactive_requests WHERE status IN ('pending', 'presenting')",
      ),
      ambiguousEffects: count("SELECT COUNT(*) AS count FROM effects WHERE status = 'ambiguous'"),
      pendingControllers: count("SELECT COUNT(*) AS count FROM controller_queue"),
      activeControllerWorkers: this.activeControllers.size,
      lifecycleContradictions: count(
        `SELECT COUNT(*) AS count
         FROM runs r JOIN run_queue q ON q.run_id = r.run_id
         WHERE NOT (
           (r.status = 'queued' AND q.status = 'queued')
           OR (r.status = 'running' AND q.status IN ('starting', 'running', 'parked'))
           OR (r.status = 'waiting' AND q.status = 'parked')
           OR (r.status = 'completed' AND q.status = 'done')
           OR (r.status IN ('failed', 'timed_out') AND q.status = 'failed')
           OR (r.status = 'cancelled' AND q.status = 'cancelled')
         )`,
      ),
    };
  }

  private rememberDeliveryClaim(options: Omit<DeliveryClaim, "expiresAt">): {
    claimId: string;
    claimExpiresAt: string;
  } {
    const now = Date.now();
    for (const [claimId, claim] of this.deliveryClaims) {
      if (claim.expiresAt <= now) this.deliveryClaims.delete(claimId);
    }
    const claimId = randomUUID();
    const expiresAt = now + DELIVERY_CLAIM_LEASE_MS;
    this.deliveryClaims.set(claimId, { ...options, expiresAt });
    return { claimId, claimExpiresAt: new Date(expiresAt).toISOString() };
  }

  private deliveryClaim(
    claimId: string,
    clientId: string,
    kind: DeliveryClaim["kind"],
    resourceId: string,
    targetSessionId: string,
  ): DeliveryClaim | undefined {
    const claim = this.deliveryClaims.get(claimId);
    if (
      claim === undefined ||
      claim.expiresAt <= Date.now() ||
      claim.clientId !== clientId ||
      claim.kind !== kind ||
      claim.resourceId !== resourceId ||
      claim.targetSessionId !== targetSessionId
    ) {
      this.deliveryClaims.delete(claimId);
      return undefined;
    }
    return claim;
  }

  private claimNotification(command: HostRequest): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(command.payload, "notification claim payload");
    const targetSessionId = requireString(payload.targetSessionId, "targetSessionId");
    const token = randomUUID();
    const notification = this.queue.claimPendingWorkflowNotifications({
      targetSessionId,
      claimToken: token,
      leaseMs: DELIVERY_CLAIM_LEASE_MS,
      limit: 1,
    })[0];
    if (notification === undefined) {
      return { outcome: "accepted", receipt: { notification: null } };
    }
    const claim = this.rememberDeliveryClaim({
      clientId: command.clientId,
      token,
      targetSessionId,
      kind: "notification",
      resourceId: notification.notificationId,
    });
    return {
      outcome: "accepted",
      receipt: { ...claim, notification } as unknown as JsonValue,
    };
  }

  private deliverNotification(command: HostRequest): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(command.payload, "notification delivery payload");
    const notificationId = requireString(payload.notificationId, "notificationId");
    const targetSessionId = requireString(payload.targetSessionId, "targetSessionId");
    const claimId = requireString(payload.claimId, "claimId");
    const claim = this.deliveryClaim(
      claimId,
      command.clientId,
      "notification",
      notificationId,
      targetSessionId,
    );
    if (claim === undefined) {
      return { outcome: "conflict", error: "Notification delivery claim is stale" };
    }
    const delivered = this.queue.markWorkflowNotificationDelivered({
      notificationId,
      targetSessionId,
      claimToken: claim.token,
    });
    this.deliveryClaims.delete(claimId);
    return delivered
      ? { outcome: "accepted", receipt: { notificationId, delivered: true } }
      : { outcome: "conflict", error: "Notification delivery claim is stale" };
  }

  private claimTurn(command: HostRequest): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(command.payload, "turn claim payload");
    const targetSessionId = requireString(payload.targetSessionId, "targetSessionId");
    const token = randomUUID();
    const intent = this.queue.claimEligibleWorkflowTurnIntents({
      targetSessionId,
      claimToken: token,
      leaseMs: DELIVERY_CLAIM_LEASE_MS,
      limit: 1,
    })[0];
    if (intent === undefined) {
      return { outcome: "accepted", receipt: { turn: null } };
    }
    const claim = this.rememberDeliveryClaim({
      clientId: command.clientId,
      token,
      targetSessionId,
      kind: "turn",
      resourceId: intent.intentId,
    });
    return {
      outcome: "accepted",
      receipt: { ...claim, turn: intent } as unknown as JsonValue,
    };
  }

  private resolveTurn(command: HostRequest): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(command.payload, "turn resolution payload");
    const intentId = requireString(payload.intentId, "intentId");
    const targetSessionId = requireString(payload.targetSessionId, "targetSessionId");
    const claimId = requireString(payload.claimId, "claimId");
    const claim = this.deliveryClaim(claimId, command.clientId, "turn", intentId, targetSessionId);
    if (claim === undefined) {
      return { outcome: "conflict", error: "Workflow turn delivery claim is stale" };
    }
    const resolved = this.queue.resolveWorkflowTurnIntent({
      intentId,
      targetSessionId,
      claimToken: claim.token,
      resolution: "presentation",
      ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
    });
    this.deliveryClaims.delete(claimId);
    return resolved
      ? { outcome: "accepted", receipt: { intentId, resolved: true } }
      : { outcome: "conflict", error: "Workflow turn delivery claim is stale" };
  }

  private answerCheckpoint(
    command: HostRequest,
    afterCommit: Array<() => void>,
  ): Omit<HostResponse, "schema" | "requestId"> {
    const parentRunId = requireRunId(command);
    const payload = requireRecord(command.payload, "checkpoint answer payload");
    const continuationRunId = requireString(payload.continuationRunId, "continuationRunId");
    const parent = this.queue.getWorkflowRun(parentRunId);
    const bundle = this.runStore.readRun(parentRunId);
    if (parent === undefined || bundle === null || bundle instanceof Promise) {
      return { outcome: "notFound", error: `Checkpoint run not found: ${parentRunId}` };
    }
    const waitingOn = bundle.state.waitingOn;
    if (bundle.state.status !== "waiting" || waitingOn === undefined) {
      return { outcome: "rejected", error: "Workflow run is not waiting at a checkpoint" };
    }
    if (bundle.snapshot.nodes[waitingOn]?.humanDecision !== undefined) {
      return { outcome: "rejected", error: "Protected human decisions require a human channel" };
    }
    const projectPath = this.queue.workflowRunProjectPath(parentRunId);
    if (projectPath === undefined || parent.originSessionId === null) {
      throw new Error("Checkpoint parent provenance is missing");
    }
    const prepared = this.prepareContinuation(
      {
        parent,
        parentRunId,
        continuationRunId,
        projectPath,
        definitionSnapshot: bundle.snapshot,
        input: payload.input as JsonValue,
        launchOptions: {},
        originSessionId: parent.originSessionId,
      },
      afterCommit,
    );
    return {
      outcome: prepared.state === "adopted" ? "adopted" : "accepted",
      receipt: {
        parentRunId,
        runId: continuationRunId,
        status: prepared.run.status,
      } as JsonValue,
    };
  }

  private answerDecision(
    command: HostRequest,
    afterCommit: Array<() => void>,
  ): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(command.payload, "decision answer payload");
    const requestId = requireString(payload.requestId, "requestId");
    const interaction = this.hostState.getInteraction(requestId);
    if (interaction === undefined || interaction.kind !== "decision") {
      return { outcome: "notFound", error: `Decision request not found: ${requestId}` };
    }
    if (this.queue.isWorkflowRunPaused(interaction.runId)) {
      return { outcome: "conflict", error: "Workflow run is paused" };
    }
    const request = interaction.contract as unknown as HumanDecisionRequest;
    const response = payload.response as HumanDecisionResponse;
    const accepted = this.decisions.acceptSync(request, {
      ...response,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      source: {
        channel: "pi",
        actorId: interaction.targetSessionId,
        eventId: command.idempotencyKey,
      },
      idempotencyKey: command.idempotencyKey,
    });
    if (accepted.status === "conflict") {
      return { outcome: "conflict", error: "Another human decision answer already won" };
    }
    this.hostState.submitInteraction({
      requestId,
      submissionId: requireString(payload.submissionId, "submissionId"),
      idempotencyKey: command.idempotencyKey,
      expectedRevision: requireNonNegativeInteger(command.expectedRevision, "expectedRevision"),
      payload: response as JsonValue,
      accepted: true,
      receipt: accepted.decision as unknown as JsonValue,
    });

    const continuationRunId = this.prepareDecisionContinuation(
      interaction,
      request,
      accepted.decision,
      afterCommit,
    );
    return {
      outcome: accepted.status === "adopted" ? "adopted" : "accepted",
      receipt: {
        requestId,
        parentRunId: interaction.runId,
        runId: continuationRunId,
        decision: accepted.decision,
      } as JsonValue,
    };
  }

  private prepareDecisionContinuation(
    interaction: InteractiveRequestRecord,
    request: HumanDecisionRequest,
    decision: ResolvedHumanDecision,
    afterCommit: Array<() => void>,
  ): string {
    const parent = this.queue.getWorkflowRun(interaction.runId);
    const bundle = this.runStore.readRun(interaction.runId);
    if (parent === undefined || bundle === null || bundle instanceof Promise) {
      throw new Error(`Decision parent run is unreadable: ${interaction.runId}`);
    }
    const continuationRunId = `continuation-${request.decisionId.replace(/^decision-/, "")}`;
    const projectPath = this.queue.workflowRunProjectPath(interaction.runId);
    if (projectPath === undefined) throw new Error("Decision parent project is missing");
    this.prepareContinuation(
      {
        parent,
        parentRunId: interaction.runId,
        continuationRunId,
        projectPath,
        definitionSnapshot: bundle.snapshot,
        input: {},
        launchOptions: { humanDecision: decision },
        originSessionId: interaction.targetSessionId,
      },
      afterCommit,
    );
    return continuationRunId;
  }

  private prepareContinuation(
    options: {
      parent: WorkflowRunQueueRecord;
      parentRunId: string;
      continuationRunId: string;
      projectPath: string;
      definitionSnapshot: WorkflowDefinitionSnapshot;
      input: unknown;
      launchOptions: JsonValue;
      originSessionId: string;
    },
    afterCommit: Array<() => void>,
  ) {
    const token = randomUUID();
    const scoped = new SqliteControllerStore(this.databasePath, {
      state: this.state,
      projectPath: options.projectPath,
    });
    const prepared = scoped.prepareOrAdoptWorkflowRun({
      runId: options.continuationRunId,
      workflowName: options.parent.workflowName,
      workflowSourceRef: options.parent.workflowSourceRef,
      workflowSource: options.parent.workflowSource,
      definitionDigest: options.parent.definitionDigest,
      definitionSnapshot: options.definitionSnapshot,
      input: options.input,
      launchOptions: options.launchOptions,
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
      originSessionId: options.originSessionId,
      executionMode: options.parent.executionMode,
      parentRunId: options.parentRunId,
    });
    if (prepared.state === "claimed") {
      this.markPendingStart(options.continuationRunId, token);
      afterCommit.push(() => void this.activateRun(prepared.run, token));
    }
    return prepared;
  }

  private startRun(
    request: HostRequest,
    afterCommit: Array<() => void>,
  ): Omit<HostResponse, "schema" | "requestId"> {
    const runId = requireRunId(request);
    const payload = requireRecord(request.payload, "run.start payload");
    const projectPath = requireAbsolutePath(payload.projectPath, "projectPath");
    const workflowName = requireString(payload.workflowName, "workflowName");
    const workflowSourceRef = requireString(payload.workflowSourceRef, "workflowSourceRef");
    const definitionDigest = requireString(payload.definitionDigest, "definitionDigest");
    const originSessionId = requireString(payload.originSessionId, "originSessionId");
    const executionMode = payload.executionMode === "headless" ? "headless" : "interactive";
    const token = randomUUID();
    const scoped = new SqliteControllerStore(this.databasePath, {
      state: this.state,
      projectPath,
    });
    const prepared = scoped.prepareOrAdoptWorkflowRun({
      runId,
      workflowName,
      workflowSourceRef,
      workflowSource: payload.workflowSource,
      definitionDigest,
      definitionSnapshot: payload.definitionSnapshot,
      input: payload.input,
      launchOptions: payload.launchOptions ?? {},
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
      originSessionId,
      executionMode,
      ...(typeof payload.parentRunId === "string" ? { parentRunId: payload.parentRunId } : {}),
    });
    if (prepared.state === "adopted") {
      return {
        outcome: "adopted",
        receipt: { runId, status: prepared.run.status } as JsonValue,
      };
    }
    this.markPendingStart(runId, token);
    afterCommit.push(() => void this.activateRun(prepared.run, token));
    return {
      outcome: "accepted",
      revision: runRevision(this.state, runId),
      receipt: { runId, generation: prepared.run.claimGeneration } as JsonValue,
    };
  }

  private publishInteractionUpdate(
    request: HostRequest,
  ): Omit<HostResponse, "schema" | "requestId"> {
    const runId = requireRunId(request);
    const payload = requireRecord(request.payload, "interaction update payload");
    const requestId = requireString(payload.requestId, "requestId");
    const interaction = this.hostState.getInteraction(requestId);
    if (interaction === undefined || interaction.runId !== runId) {
      return { outcome: "notFound", error: `Interactive request not found: ${requestId}` };
    }
    if (this.queue.isWorkflowRunPaused(runId)) {
      return { outcome: "conflict", error: "Workflow run is paused" };
    }
    const attemptId = requireString(payload.attempt, "attempt");
    const nodeId = requireString(payload.step, "step");
    const storedContract = requireRecord(interaction.contract, "interactive contract");
    const stepContract = requireRecord(storedContract.contract, "workflow step contract");
    if (
      interaction.attemptId !== attemptId ||
      requireString(stepContract.nodeId, "contract.nodeId") !== nodeId ||
      !["pending", "presenting"].includes(interaction.status)
    ) {
      return { outcome: "conflict", error: "Interactive request attempt is stale" };
    }
    if (
      interaction.revision !==
      requireNonNegativeInteger(request.expectedRevision, "expectedRevision")
    ) {
      return { outcome: "conflict", error: "Interactive request revision is stale" };
    }
    const value = requireRecord(payload.value, "interaction update value");
    const update = validateWorkflowUpdate(value.update);
    const token = randomUUID();
    const claimed = this.queue.claimWorkflowRunForControl({
      runId,
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
    });
    if (claimed === undefined) {
      return { outcome: "claimLost", error: "Interactive run is not available for update" };
    }
    this.controlClaims.set(runId, token);
    try {
      this.runStore.synchronizeRevision(runId);
      const loaded = this.runStore.readRun(runId);
      if (loaded === null || loaded.state.status !== "waiting") {
        throw new Error("Interactive update does not match a waiting workflow run");
      }
      const result = this.runStore.publishUpdateSynchronous(
        runId,
        loaded.state,
        nodeId,
        attemptId,
        update,
      );
      if (!this.queue.parkWorkflowRun({ runId, claimToken: token })) {
        throw new Error("Interactive update could not release its control claim");
      }
      return {
        outcome: "accepted",
        revision: result.event.seq,
        receipt: result.record as unknown as JsonValue,
      };
    } finally {
      this.controlClaims.delete(runId);
    }
  }

  private submitInteraction(request: HostRequest): Omit<HostResponse, "schema" | "requestId"> {
    const payload = requireRecord(request.payload, "interaction payload");
    const requestId = requireString(payload.requestId, "requestId");
    const current = this.hostState.getInteraction(requestId);
    if (current === undefined || current.runId !== requireRunId(request)) {
      return { outcome: "notFound", error: `Interactive request not found: ${requestId}` };
    }
    if (this.queue.isWorkflowRunPaused(current.runId)) {
      return { outcome: "conflict", error: "Workflow run is paused" };
    }
    const attemptId = requireString(payload.attempt, "attempt");
    const nodeId = requireString(payload.step, "step");
    const storedContract = requireRecord(current.contract, "interactive contract");
    const stepContract = requireRecord(storedContract.contract, "workflow step contract");
    if (
      current.attemptId !== attemptId ||
      requireString(stepContract.nodeId, "contract.nodeId") !== nodeId
    ) {
      return { outcome: "conflict", error: "Interactive request attempt is stale" };
    }
    const submissionId = requireString(payload.submissionId, "submissionId");
    const submission = this.hostState.beginInteractionValidation({
      requestId,
      submissionId,
      idempotencyKey: request.idempotencyKey,
      expectedRevision: requireNonNegativeInteger(request.expectedRevision, "expectedRevision"),
      payload: (payload.value ?? null) as JsonValue,
      receipt: {
        operation: request.operation,
        requestId,
        submissionId,
        status: "validating",
      },
    });
    const interaction = submission.interaction;
    if (this.activeRuns.has(interaction.runId) || this.activationTasks.has(interaction.runId)) {
      this.pendingResumes.add(interaction.runId);
    } else {
      const token = randomUUID();
      const claimed = this.queue.claimWorkflowRunForInteractionValidation({
        runId: interaction.runId,
        runnerId: this.hostId,
        claimToken: token,
        leaseMs: this.runClaimLeaseMs,
      });
      if (claimed !== undefined) {
        this.markPendingStart(interaction.runId, token);
        setImmediate(() => void this.activateRun(claimed, token));
      }
    }
    return {
      outcome: submission.outcome,
      revision: interaction.revision,
      receipt: submission.receipt,
    };
  }

  private async claimControllerOne(): Promise<void> {
    if (
      this.stopping ||
      this.claim === null ||
      this.controllerPollActive ||
      this.activeControllers.size >= MAX_CONTROLLER_WORKERS
    ) {
      return;
    }
    this.controllerPollActive = true;
    try {
      const rows = this.state.connection
        .prepare(
          `SELECT DISTINCT p.canonical_path AS projectPath
           FROM controller_queue q
           JOIN controller_resources c ON c.controller_resource_id = q.controller_resource_id
           JOIN projects p ON p.project_id = c.project_id
           JOIN leases l ON l.resource_id = c.resource_id
           WHERE q.available_at <= ? AND (l.owner_id IS NULL OR l.expires_at <= ?)
           ORDER BY q.available_at, p.canonical_path`,
        )
        .all(Date.now(), Date.now()) as Array<{ projectPath?: unknown }>;
      for (const row of rows) {
        if (typeof row.projectPath !== "string") continue;
        const discovered = await discoverControllers({ cwd: row.projectPath });
        if (discovered.length === 0) continue;
        const byName = new Map(discovered.map((item) => [item.name, item.path]));
        const store = new SqliteControllerStore(this.databasePath, {
          state: this.state,
          projectPath: row.projectPath,
        });
        const claim = store.claimNext({
          controllers: [...byName.keys()],
          ownerId: this.hostId,
          leaseMs: CONTROLLER_CLAIM_LEASE_MS,
          exclude: [...this.activeControllers.values()]
            .filter((active) => active.projectPath === row.projectPath)
            .map((active) => ({
              controller: active.claim.controller,
              key: active.claim.key,
            })),
        });
        if (claim === undefined) continue;
        const definitionPath = byName.get(claim.controller);
        const resource = store.getResource({ controller: claim.controller, key: claim.key });
        if (definitionPath === undefined || resource === undefined) {
          store.requeueClaim(claim, {
            availableAt: new Date().toISOString(),
            error: "Controller source is unavailable",
          });
          continue;
        }
        void this.activateController(row.projectPath, definitionPath, store, claim, resource);
        break;
      }
    } catch (error) {
      this.log(`controller scheduling failed: ${errorMessage(error)}`);
    } finally {
      this.controllerPollActive = false;
    }
  }

  private async activateController(
    projectPath: string,
    definitionPath: string,
    store: SqliteControllerStore,
    claim: ControllerQueueClaim,
    resource: ControllerResource,
  ): Promise<void> {
    if (this.claim === null || this.stopping) {
      store.requeueClaim(claim, { availableAt: new Date().toISOString() });
      return;
    }
    const workerEpoch = randomUUID();
    const key = `${projectPath}\u0000${claim.controller}\u0000${claim.key}`;
    const reconcileId = randomUUID();
    const envelope: ControllerWorkerLaunchEnvelope = {
      schema: "pi-workflows.controller-worker-launch.v1",
      workerEpoch,
      hostEpoch: this.claim.epoch,
      generation: claim.generation,
      projectPath,
      definitionPath,
      controllerName: claim.controller,
      resource,
      timeoutMs: DEFAULT_CONTROLLER_TIMEOUT_MS,
    };
    let active: ActiveController;
    const supervisor = new ControllerWorkerSupervisor(envelope, {
      registry: this.registry,
      onMessage: async (message) => await this.handleControllerWorkerMessage(active, message),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.controllerWorkerEntryPath === undefined
        ? {}
        : { workerEntryPath: this.options.controllerWorkerEntryPath }),
      ...(this.options.workerStartupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: this.options.workerStartupTimeoutMs }),
      onDiagnostic: (message) => this.log(`controller worker ${workerEpoch}: ${message}`),
    });
    const renewTimer = setInterval(() => {
      if (!store.renewClaim(claim, CONTROLLER_CLAIM_LEASE_MS)) {
        void supervisor.stop("claimLost");
      }
    }, CONTROLLER_RENEW_MS);
    renewTimer.unref?.();
    active = {
      key,
      projectPath,
      store,
      claim,
      resource,
      reconcileId,
      startedAt: Date.now(),
      supervisor,
      renewTimer,
      settled: false,
    };
    this.activeControllers.set(key, active);
    store.recordEvent({
      controller: claim.controller,
      key: claim.key,
      claim,
      type: "reconcile_started",
      payload: { reconcileId, generation: resource.metadata.generation },
    });
    try {
      await supervisor.start();
      const result = await supervisor.wait();
      if (result.outcome !== "exited" && !active.settled) {
        this.finishControllerFailure(
          active,
          result.diagnostic ?? `Controller worker ${result.outcome}`,
        );
      }
    } catch (error) {
      await supervisor.stop("crashed");
      if (!active.settled) this.finishControllerFailure(active, errorMessage(error));
    } finally {
      clearInterval(renewTimer);
      this.activeControllers.delete(key);
      if (!this.stopping) setImmediate(() => void this.claimControllerOne());
    }
  }

  private async handleControllerWorkerMessage(
    active: ActiveController,
    message: ControllerWorkerMessage,
  ): Promise<ControllerWorkerResponse> {
    const current = this.activeControllers.get(active.key);
    if (
      current !== active ||
      message.workerEpoch !== active.supervisor.envelope.workerEpoch ||
      message.generation !== active.claim.generation
    ) {
      return controllerWorkerResponse(
        message,
        "claimLost",
        undefined,
        "Controller worker is stale",
      );
    }
    if (!active.store.renewClaim(active.claim, CONTROLLER_CLAIM_LEASE_MS)) {
      return controllerWorkerResponse(message, "claimLost", undefined, "Controller claim expired");
    }
    try {
      const payload = requireRecord(message.payload, "controller worker payload");
      switch (message.operation) {
        case "worker.ready":
          return controllerWorkerResponse(message, "accepted", {});
        case "effect.reserve": {
          const reservation = active.store.reserveEffect({
            key: requireString(payload.key, "key"),
            resourceUid: active.resource.metadata.uid,
            claim: active.claim,
            generation: active.resource.metadata.generation,
            kind: requireString(payload.kind, "kind"),
            requestFingerprint: requireString(payload.requestFingerprint, "requestFingerprint"),
          });
          return controllerWorkerResponse(message, "accepted", reservation as unknown as JsonValue);
        }
        case "effect.settle": {
          const state = requireString(payload.state, "state");
          if (!["applied", "rejected", "indeterminate"].includes(state)) {
            throw new Error("Controller effect state is invalid");
          }
          const record = active.store.updateEffect({
            resourceUid: active.resource.metadata.uid,
            key: requireString(payload.key, "key"),
            claim: active.claim,
            state: state as "applied" | "rejected" | "indeterminate",
            ...(typeof payload.externalRef === "string"
              ? { externalRef: payload.externalRef }
              : {}),
            ...(typeof payload.error === "string" ? { error: payload.error } : {}),
          });
          active.store.recordEvent({
            controller: active.claim.controller,
            key: active.claim.key,
            claim: active.claim,
            type: `effect_${state}`,
            payload: { effectKey: record.key },
          });
          return controllerWorkerResponse(message, "accepted", record as unknown as JsonValue);
        }
        case "workflow.ensure":
        case "workflow.changeSettings":
        case "workflow.queueFollowUp":
        case "workflow.removeFollowUp": {
          const workflows = new ControllerWorkflowCoordinator(
            active.store,
            this.controllerWorkflowScheduler(active),
          ).forResource(active.resource, active.claim, new AbortController().signal);
          const result =
            message.operation === "workflow.ensure"
              ? await workflows.ensure(payload as never)
              : message.operation === "workflow.changeSettings"
                ? await workflows.changeSettings(payload as never)
                : message.operation === "workflow.queueFollowUp"
                  ? await workflows.queueFollowUp(payload as never)
                  : await workflows.removeFollowUp(payload as never);
          return controllerWorkerResponse(message, "accepted", result as unknown as JsonValue);
        }
        case "worker.finished":
          this.finishControllerSuccess(
            active,
            message.payload as unknown as ReconcileResult<unknown>,
          );
          return controllerWorkerResponse(message, "accepted", {});
        case "worker.failed":
          this.finishControllerFailure(active, requireString(payload.error, "error"));
          return controllerWorkerResponse(message, "accepted", {});
      }
    } catch (error) {
      return controllerWorkerResponse(message, "rejected", undefined, errorMessage(error));
    }
  }

  private controllerWorkflowScheduler(active: ActiveController): ControllerWorkflowScheduler {
    return {
      ensure: async (request, _signal, _onComplete) =>
        await this.ensureControllerWorkflow(active, request),
      changeSettings: async (request) =>
        await this.changeControllerWorkflowSettings(active, request),
      queueFollowUp: async (request) => {
        const targetSessionId = this.runStore.originSessionId(request.runId);
        if (targetSessionId === undefined) {
          throw new Error("Controller follow-up requires an origin Pi session");
        }
        const result = this.runStore.queueFollowUp({
          runId: request.runId,
          requestId: request.actorRequestKey,
          targetSessionId,
          actor: { type: "controller", id: request.controllerResourceUid },
          source: "controller-request",
          prompt: request.prompt,
        });
        return {
          runId: request.runId,
          followUpId: result.followUp.followUpId,
          order: result.followUp.order,
          state: result.followUp.state,
          adopted: result.adopted,
        };
      },
      removeFollowUp: async (request) => {
        const result = this.runStore.removeFollowUp({
          runId: request.runId,
          followUpId: request.followUpId,
          actor: { type: "controller", id: request.controllerResourceUid },
          source: "controller-request",
        });
        return {
          runId: request.runId,
          followUpId: result.followUpId,
          order: result.order,
          state: result.state,
          adopted: false,
        };
      },
    };
  }

  private async changeControllerWorkflowSettings(
    _active: ActiveController,
    request: ControllerWorkflowControlRequest<ControllerSettingsChangeRequest>,
  ): Promise<ControllerSettingsChangeResult> {
    const run = this.queue.getWorkflowRun(request.runId);
    if (run === undefined) throw new Error(`Workflow run not found: ${request.runId}`);
    const scopes = this.runStore.listSettingsScopes(request.runId);
    const scopeId = request.scopeId ?? (scopes.length === 1 ? scopes[0]?.scopeId : undefined);
    if (scopeId === undefined) {
      throw new Error("Controller settings changes require scopeId when several scopes exist");
    }
    const scope = this.runStore.getSettingsScope(scopeId);
    if (scope === undefined || scope.activeRunId !== request.runId) {
      throw new Error(`Workflow settings scope not found: ${scopeId}`);
    }
    const prior = this.state.connection
      .prepare(
        `SELECT change_number AS changeNumber
         FROM workflow_setting_changes WHERE scope_id = ? AND request_id = ?`,
      )
      .get(scopeId, request.actorRequestKey) as { changeNumber?: unknown } | undefined;
    if (typeof prior?.changeNumber === "number") {
      return { runId: request.runId, scopeId, changeNumber: prior.changeNumber, adopted: true };
    }
    const projectPath = this.queue.workflowRunProjectPath(request.runId);
    if (projectPath === undefined) throw new Error("Workflow run project is missing");
    const resolver = new WorkflowHostClient({
      databasePath: this.databasePath,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    });
    const proposal = await resolver.resolveSettingsChange({
      cwd: projectPath,
      workflowRef: run.workflowSourceRef,
      definitionDigest: run.definitionDigest,
      mountPath: scope.mountPath,
      current: scope.settings,
      patch: request.patch as unknown as JsonValue,
      actorId: request.controllerResourceUid,
    });
    if (proposal.definitionDigest !== run.definitionDigest || !Array.isArray(proposal.paths)) {
      throw new Error("Workflow settings proposal does not match the durable source");
    }
    const proposedSettings = canonicalJson(proposal.settings);
    const definition: WorkflowSettingsDefinition<JsonValue> = {
      initial: proposal.settings,
      paths: proposal.paths as unknown as WorkflowSettingsPathRule[],
      parse: (value) => {
        if (canonicalJson(value) !== proposedSettings) {
          throw new Error("Workflow settings proposal changed before commit");
        }
        return proposal.settings;
      },
    };
    const result = await this.runStore.changeSettings(definition, {
      runId: request.runId,
      scopeId,
      requestId: request.actorRequestKey,
      expectedChangeNumber: request.expectedChangeNumber ?? scope.changeNumber,
      actor: { type: "controller", id: request.controllerResourceUid },
      source: "controller-request",
      patch: proposal.patch,
    });
    return {
      runId: request.runId,
      scopeId,
      changeNumber: result.scope.changeNumber,
      adopted: result.adopted,
    };
  }

  private async ensureControllerWorkflow(
    active: ActiveController,
    request: WorkflowSchedulerRequest,
  ): Promise<WorkflowSchedulerResult> {
    const existing = this.queue.getWorkflowRun(request.runId);
    if (existing !== undefined) return controllerWorkflowResult(existing);
    const resolver = new WorkflowHostClient({
      databasePath: this.databasePath,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    });
    const resolved = await resolver.resolveWorkflow({
      cwd: active.projectPath,
      workflowRef: request.workflow,
    });
    const token = randomUUID();
    const scoped = new SqliteControllerStore(this.databasePath, {
      state: this.state,
      projectPath: active.projectPath,
    });
    const prepared = scoped.prepareOrAdoptWorkflowRun({
      runId: request.runId,
      workflowName: resolved.workflowName,
      workflowSourceRef: resolved.workflowSourceRef,
      workflowSource: resolved.workflowSource,
      definitionDigest: resolved.definitionDigest,
      definitionSnapshot: resolved.definitionSnapshot,
      input: request.input,
      launchOptions: {},
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
      originSessionId: `controller-${active.resource.metadata.uid}`,
      executionMode: "headless",
    });
    if (prepared.state === "claimed") {
      this.markPendingStart(request.runId, token);
      setImmediate(() => void this.activateRun(prepared.run, token));
    }
    return controllerWorkflowResult(prepared.run);
  }

  private finishControllerSuccess(
    active: ActiveController,
    result: ReconcileResult<unknown>,
  ): void {
    if (active.settled) return;
    const now = new Date();
    const ref = { controller: active.claim.controller, key: active.claim.key };
    const status = applyStatusPatch(
      active.resource.status,
      result.status,
      active.resource.metadata.generation,
      now.toISOString(),
    );
    try {
      const updated = active.store.updateStatus({
        ref,
        expectedResourceVersion: active.claim.resourceVersion,
        claim: active.claim,
        status,
        ...(result.status?.finalizers === undefined
          ? {}
          : { finalizers: result.status.finalizers }),
        now: now.toISOString(),
      });
      active.store.recordEvent({
        ...ref,
        claim: active.claim,
        type: "reconcile_finished",
        payload: {
          reconcileId: active.reconcileId,
          result: result.kind,
          generation: active.resource.metadata.generation,
          durationMs: Math.max(0, now.getTime() - active.startedAt),
          ...(result.kind === "requeue" && result.afterMs !== undefined
            ? { requeueAfterMs: result.afterMs }
            : {}),
        },
      });
      if (
        result.kind === "settled" &&
        updated.metadata.deletionTimestamp !== undefined &&
        updated.metadata.finalizers.length === 0
      ) {
        active.store.recordEvent({
          ...ref,
          claim: active.claim,
          type: "resource_deleted",
          payload: { reconcileId: active.reconcileId },
        });
        active.store.deleteResource(ref, active.claim.resourceVersion, active.claim);
      } else if (result.kind === "settled") {
        active.store.settleClaim(active.claim, now.toISOString());
      } else {
        active.store.requeueClaim(
          active.claim,
          { availableAt: new Date(now.getTime() + (result.afterMs ?? 0)).toISOString() },
          now.toISOString(),
        );
      }
      active.settled = true;
    } catch (error) {
      if (error instanceof ResourceConflictError) {
        active.store.recordEvent({
          ...ref,
          claim: active.claim,
          type: "reconcile_conflict",
          payload: { reconcileId: active.reconcileId },
        });
        active.store.requeueClaim(
          active.claim,
          { availableAt: now.toISOString() },
          now.toISOString(),
        );
        active.settled = true;
        return;
      }
      throw error;
    }
  }

  private finishControllerFailure(active: ActiveController, failure: string): void {
    if (active.settled) return;
    const now = new Date();
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(active.claim.consecutiveErrors, 6));
    const error = failure.slice(0, 8_192);
    active.store.recordEvent({
      controller: active.claim.controller,
      key: active.claim.key,
      claim: active.claim,
      type: "reconcile_failed",
      payload: {
        reconcileId: active.reconcileId,
        error,
        durationMs: Math.max(0, now.getTime() - active.startedAt),
        requeueAfterMs: delay,
      },
    });
    active.store.requeueClaim(
      active.claim,
      { availableAt: new Date(now.getTime() + delay).toISOString(), error },
      now.toISOString(),
    );
    active.settled = true;
  }

  private async expireTimedOutDecision(): Promise<void> {
    if (this.stopping || this.claim === null || this.decisionTimeoutActive) return;
    this.decisionTimeoutActive = true;
    try {
      const now = new Date();
      const requests = await this.decisions.listExpiredDefaultRequests(now);
      const candidate = requests
        .map((request) => ({
          request,
          interaction: this.hostState.getInteraction(request.decisionId),
        }))
        .find(
          ({ request, interaction }) =>
            interaction?.kind === "decision" &&
            interaction.runId === request.runId &&
            ["pending", "presenting"].includes(interaction.status) &&
            !this.activeRuns.has(request.runId) &&
            !this.pendingStarts.has(request.runId),
        );
      if (
        candidate === undefined ||
        candidate.interaction === undefined ||
        candidate.request.defaultResponse === undefined
      ) {
        return;
      }
      const { request, interaction } = candidate;
      const claimToken = randomUUID();
      const claimed = this.queue.claimWorkflowRunForControl({
        runId: request.runId,
        runnerId: this.hostId,
        claimToken,
        leaseMs: this.runClaimLeaseMs,
      });
      if (claimed === undefined) return;
      this.controlClaims.set(request.runId, claimToken);
      let committed = false;
      const afterCommit: Array<() => void> = [];
      try {
        this.state.transaction(() => {
          const accepted = this.decisions.resolveTimeoutSync(request, new Date());
          const submissionId = `timeout-${request.decisionId}`;
          this.hostState.submitInteraction({
            requestId: interaction.requestId,
            submissionId,
            idempotencyKey: submissionId,
            expectedRevision: interaction.revision,
            payload: request.defaultResponse as JsonValue,
            accepted: true,
            receipt: accepted.decision as unknown as JsonValue,
          });
          if (!this.queue.parkWorkflowRun({ runId: request.runId, claimToken })) {
            throw new Error("Decision timeout could not release the parent run claim");
          }
          this.prepareDecisionContinuation(interaction, request, accepted.decision, afterCommit);
        });
        committed = true;
        for (const effect of afterCommit) setImmediate(effect);
        this.log(`human decision ${request.decisionId} resolved by its timeout policy`);
      } catch (error) {
        this.log(`human decision timeout failed for ${request.decisionId}: ${errorMessage(error)}`);
      } finally {
        this.controlClaims.delete(request.runId);
        if (!committed) this.queue.parkWorkflowRun({ runId: request.runId, claimToken });
      }
    } catch (error) {
      this.log(`human decision timeout scan failed: ${errorMessage(error)}`);
    } finally {
      this.decisionTimeoutActive = false;
    }
  }

  private expireTimedOutInteraction(): void {
    if (this.stopping || this.claim === null) return;
    const runId = this.hostState
      .expiredInteractionRunIds()
      .find((candidate) => !this.activeRuns.has(candidate) && !this.pendingStarts.has(candidate));
    if (runId === undefined) return;
    const claimToken = randomUUID();
    const claimed = this.queue.claimWorkflowRunForControl({
      runId,
      runnerId: this.hostId,
      claimToken,
      leaseMs: this.runClaimLeaseMs,
    });
    if (claimed === undefined) return;
    let activated = false;
    try {
      activated = this.queue.beginWorkflowRunInteractionTimeout({ runId, claimToken });
      if (activated) {
        this.markPendingStart(runId, claimToken);
        setImmediate(() => void this.activateRun(claimed, claimToken));
        this.log(`run ${runId} is finishing its expired origin-session deadline`);
      }
    } catch (error) {
      this.log(`interaction timeout failed for run ${runId}: ${errorMessage(error)}`);
    } finally {
      if (!activated) this.queue.parkWorkflowRun({ runId, claimToken });
    }
  }

  private markPendingStart(runId: string, claimToken: string): void {
    this.pendingStarts.add(runId);
    this.pendingRunClaims.set(runId, claimToken);
  }

  private clearPendingStart(runId: string, claimToken: string): void {
    if (this.pendingRunClaims.get(runId) !== claimToken) return;
    this.pendingRunClaims.delete(runId);
    this.pendingStarts.delete(runId);
  }

  private async claimOne(): Promise<void> {
    if (this.stopping || this.claim === null) return;
    const excluded = new Set([
      ...this.activeRuns.keys(),
      ...this.pendingStarts,
      ...this.blockedRuns,
    ]);
    const validatingRunId = this.hostState
      .validatingInteractionRunIds()
      .find((runId) => !excluded.has(runId));
    if (validatingRunId !== undefined) {
      const validationToken = randomUUID();
      const validationRun = this.queue.claimWorkflowRunForInteractionValidation({
        runId: validatingRunId,
        runnerId: this.hostId,
        claimToken: validationToken,
        leaseMs: this.runClaimLeaseMs,
      });
      if (validationRun !== undefined) {
        this.markPendingStart(validatingRunId, validationToken);
        await this.activateRun(validationRun, validationToken);
        return;
      }
    }
    const token = randomUUID();
    const claimed = this.queue.claimNextWorkflowRun({
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
      excludeRunIds: [...excluded],
    });
    if (claimed === undefined) return;
    this.markPendingStart(claimed.runId, token);
    await this.activateRun(claimed, token);
  }

  private activateRun(record: WorkflowRunQueueRecord, claimToken: string): Promise<void> {
    const existing = this.activationTasks.get(record.runId);
    if (existing !== undefined) return existing;
    const task = this.activateRunNow(record, claimToken).finally(() => {
      if (this.activationTasks.get(record.runId) === task) {
        this.activationTasks.delete(record.runId);
      }
      if (this.stopping) return;
      if (this.pendingResumes.delete(record.runId)) {
        setImmediate(() => void this.resumePendingRun(record.runId));
      } else {
        setImmediate(() => void this.claimOne());
      }
    });
    this.activationTasks.set(record.runId, task);
    return task;
  }

  private async activateRunNow(record: WorkflowRunQueueRecord, claimToken: string): Promise<void> {
    const runId = record.runId;
    if (this.pendingRunClaims.get(runId) !== claimToken) return;
    if (this.stopping) {
      this.clearPendingStart(runId, claimToken);
      this.queue.parkWorkflowRun({ runId, claimToken });
      return;
    }
    const existingActive = this.activeRuns.get(runId);
    if (existingActive !== undefined) {
      this.clearPendingStart(runId, claimToken);
      if (existingActive.claimToken !== claimToken) {
        this.queue.parkWorkflowRun({ runId, claimToken });
      }
      return;
    }
    const generation = record.claimGeneration;
    const projectPath = this.queue.workflowRunProjectPath(runId);
    if (generation === null || projectPath === undefined || this.claim === null) {
      this.clearPendingStart(runId, claimToken);
      this.queue.parkWorkflowRun({ runId, claimToken });
      return;
    }
    const envelope: WorkerLaunchEnvelope = {
      schema: "pi-workflows.worker-launch.v1",
      runId,
      generation,
      workerEpoch: randomUUID(),
      projectPath,
      workflowSource: record.workflowSource as JsonValue,
      definitionDigest: record.definitionDigest,
      inputHash: `sha256:${createHash("sha256").update(canonicalJson(record.input)).digest("hex")}`,
      protocolVersion: 1,
    };
    this.hostState.recordWorkerStart(envelope, this.claim.epoch);
    let active: ActiveRun;
    const supervisor = new WorkflowWorkerSupervisor(envelope, {
      registry: this.registry,
      onMessage: async (message) => await this.handleWorkerMessage(message),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.workerEntryPath === undefined
        ? {}
        : { workerEntryPath: this.options.workerEntryPath }),
      ...(this.options.workerStartupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: this.options.workerStartupTimeoutMs }),
      onSpawn: (identity) => {
        active.workerPid = identity.pid;
        this.hostState.attachWorkerProcess(
          envelope.workerEpoch,
          identity.pid,
          identity.startIdentity,
        );
      },
      onDiagnostic: (message) => this.log(`worker ${envelope.workerEpoch}: ${message}`),
    });
    active = { record, claimToken, generation, supervisor, exiting: false };
    this.activeRuns.set(runId, active);
    this.clearPendingStart(runId, claimToken);
    try {
      this.runStore.synchronizeRevision(runId);
      const effectRecovery = await this.runStore.recoverApplyingEffects(runId);
      if (effectRecovery === "ambiguous" || hasUncertainEffect(this.state, runId)) {
        if (!this.queue.parkWorkflowRunForAmbiguousEffect({ runId, claimToken })) {
          throw new Error("Run claim was lost during ambiguous-effect recovery");
        }
        this.hostState.finishWorker({
          workerEpoch: envelope.workerEpoch,
          outcome: "orphaned",
          diagnostic: "effect outcome is ambiguous",
        });
        return;
      }
      await supervisor.start();
      const result = await supervisor.wait();
      this.hostState.finishWorker({
        workerEpoch: envelope.workerEpoch,
        outcome: result.outcome,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      });
      if (
        active.control === undefined &&
        (result.outcome !== "exited" ||
          this.hostState.validatingInteraction(active.record.runId) !== undefined)
      ) {
        await this.recoverWorkerExit(active, result.outcome);
      }
    } catch (error) {
      this.log(`worker ${envelope.workerEpoch} failed: ${errorMessage(error)}`);
      await supervisor.stop("crashed");
      const result = await supervisor.wait();
      try {
        this.hostState.finishWorker({
          workerEpoch: envelope.workerEpoch,
          outcome: "crashed",
          exitCode: result.exitCode,
          signal: result.signal,
          diagnostic: result.diagnostic ?? errorMessage(error),
        });
      } catch {
        // A completed worker record wins.
      }
      if (active.control === undefined) {
        await this.recoverWorkerExit(active, "crashed");
      }
    } finally {
      this.reapWorkerDescendants(envelope.workerEpoch);
      this.activeRuns.delete(runId);
    }
  }

  private async resumePendingRun(runId: string): Promise<void> {
    if (this.stopping || this.claim === null) return;
    const token = randomUUID();
    const claimed = this.queue.claimWorkflowRunForInteractionValidation({
      runId,
      runnerId: this.hostId,
      claimToken: token,
      leaseMs: this.runClaimLeaseMs,
    });
    if (claimed === undefined) {
      await this.claimOne();
      return;
    }
    this.markPendingStart(runId, token);
    await this.activateRun(claimed, token);
  }

  private async handleWorkerMessage(message: WorkerMessage): Promise<WorkerResponse> {
    const active = this.activeRuns.get(message.runId);
    if (
      active === undefined ||
      active.generation !== message.generation ||
      active.supervisor.envelope.workerEpoch !== message.workerEpoch
    ) {
      return workerResponse(message, "claimLost", undefined, "Worker epoch is stale");
    }
    const stored = this.hostState.readWorkerMessage(message);
    if (stored !== undefined) return stored;
    const response = await this.handleFreshWorkerMessage(active, message);
    return this.hostState.recordWorkerMessage(message, response);
  }

  private async handleFreshWorkerMessage(
    active: ActiveRun,
    message: WorkerMessage,
  ): Promise<WorkerResponse> {
    if (message.operation === "worker.ready") {
      if (
        !this.queue.verifyWorkflowRunClaim({ runId: message.runId, claimToken: active.claimToken })
      ) {
        active.claimLost = true;
        setImmediate(() => void active.supervisor.stop("claimLost"));
        return workerResponse(message, "claimLost", undefined, "Run claim expired");
      }
      this.hostState.markWorkerReady(message.workerEpoch);
      this.queue.markWorkflowRunRunning({ runId: message.runId, claimToken: active.claimToken });
      const revision = this.runStore.synchronizeRevision(message.runId);
      const current = this.queue.getWorkflowRun(message.runId);
      const candidateInteraction =
        this.hostState.acceptedInteraction(message.runId) ??
        this.hostState.validatingInteraction(message.runId);
      const timedOutInteraction = this.hostState.timedOutInteraction(message.runId);
      const resumeInteractionAttemptId =
        candidateInteraction?.attemptId ?? timedOutInteraction?.attemptId;
      return workerResponse(
        message,
        "accepted",
        {
          initialized: current?.initialized ?? active.record.initialized,
          input: active.record.input,
          launchOptions: active.record.launchOptions,
          parentRunId: active.record.parentRunId,
          originSessionId: active.record.originSessionId,
          stateDirectory: this.stateDirectory,
          ...(resumeInteractionAttemptId === undefined ? {} : { resumeInteractionAttemptId }),
          ...(candidateInteraction === undefined ? {} : { candidateInteraction }),
          ...(this.options.piArgs === undefined ? {} : { piArgs: this.options.piArgs }),
        } as JsonValue,
        undefined,
        revision,
      );
    }
    if (message.operation === "worker.exiting") {
      const payload = requireRecord(message.payload, "worker exit payload");
      if (payload.status === "workflowLoadFailed") {
        active.workflowLoadFailure = requireString(payload.error, "workflow load error").slice(
          0,
          8_192,
        );
      }
      active.exiting = true;
      return workerResponse(message, "accepted", {});
    }
    if (message.operation === "process.register" || message.operation === "process.unregister") {
      return this.handleWorkerProcessOperation(active, message);
    }
    const currentRevision = runRevision(this.state, message.runId);
    if (message.expectedRevision !== currentRevision) {
      return workerResponse(
        message,
        "rejected",
        undefined,
        `Workflow run revision conflict: expected ${message.expectedRevision}, got ${currentRevision}`,
        currentRevision,
      );
    }
    if (
      !this.queue.verifyWorkflowRunClaim({ runId: message.runId, claimToken: active.claimToken })
    ) {
      active.claimLost = true;
      setImmediate(() => void active.supervisor.stop("claimLost"));
      return workerResponse(message, "claimLost", undefined, "Run claim expired");
    }
    try {
      const payload = requireRecord(message.payload, "worker payload");
      let result: unknown;
      switch (message.operation) {
        case "store.initializeRun":
          result = await this.runStore.initializeRunFromSnapshot(
            payload.snapshot as WorkflowDefinitionSnapshot,
            requireString(payload.workflowName, "workflowName"),
            payload.state as WorkflowRunState,
            payload.options as never,
          );
          break;
        case "store.prepareRunResume":
          await this.prepareInteractionResume(message.runId);
          result = await this.runStore.prepareRunResume(message.runId);
          break;
        case "store.readRun":
          result = this.runStore.readRun(
            requireString(payload.runId, "runId"),
            payload.options as never,
          );
          break;
        case "store.writeSnapshot":
          result = await this.runStore.writeSnapshot(
            message.runId,
            payload.state as WorkflowRunState,
            payload.event as WorkflowTraceEventDraft,
          );
          break;
        case "store.publishUpdate":
          result = await this.runStore.publishUpdate(
            message.runId,
            payload.state as WorkflowRunState,
            requireString(payload.nodeId, "nodeId"),
            requireString(payload.attemptId, "attemptId"),
            payload.update as WorkflowUpdateInput,
          );
          break;
        case "store.findSettingsScope":
          result = this.runStore.findSettingsScope(
            message.runId,
            requireString(payload.mountPath, "mountPath", true),
            requireNonNegativeInteger(payload.invocation, "invocation"),
          );
          break;
        case "store.ensureSettingsScope":
          result = this.runStore.ensureSettingsScope(payload.options as never);
          break;
        case "store.getSettingsScopeAtChange":
          result = this.runStore.getSettingsScopeAtChange(
            requireString(payload.scopeId, "scopeId"),
            requireNonNegativeInteger(payload.changeNumber, "changeNumber"),
          );
          break;
        case "store.createHumanDecisionRequest": {
          const decision = payload.request as HumanDecisionRequest;
          result = await this.runStore.createHumanDecisionRequest(decision);
          if (active.record.originSessionId !== null) {
            this.hostState.createInteractiveRequest({
              requestId: decision.decisionId,
              runId: decision.runId,
              attemptId: decision.attemptId,
              targetSessionId: active.record.originSessionId,
              kind: "decision",
              contract: decision as unknown as JsonValue,
            });
          }
          break;
        }
        case "store.readResolvedHumanDecision":
          result = await this.runStore.readResolvedHumanDecision(
            requireString(payload.decisionId, "decisionId"),
          );
          break;
        case "store.reserveEffect":
          result = await this.runStore.reserveEffect(payload.options as never);
          if (
            typeof result === "object" &&
            result !== null &&
            (result as { disposition?: unknown }).disposition === "ambiguous" &&
            !this.queue.parkWorkflowRunForAmbiguousEffect({
              runId: message.runId,
              claimToken: active.claimToken,
            })
          ) {
            throw new Error("Run claim was lost during ambiguous-effect recovery");
          }
          break;
        case "store.settleEffect": {
          const options = payload.options as {
            outcome?: unknown;
          };
          await this.runStore.settleEffect(payload.options as never);
          if (
            options.outcome === "ambiguous" &&
            !this.queue.parkWorkflowRunForAmbiguousEffect({
              runId: message.runId,
              claimToken: active.claimToken,
            })
          ) {
            throw new Error("Run claim was lost during ambiguous-effect recovery");
          }
          result = null;
          break;
        }
        case "interaction.accept":
          result = this.acceptWorkerInteraction(message, payload);
          break;
        case "interaction.reject":
          result = this.rejectWorkerInteraction(active, message, payload);
          break;
        case "notification.request":
          result = this.enqueueWorkerNotification(active, message, payload);
          break;
        case "presentation.request":
          result = this.requestWorkerPresentation(active, message, payload);
          break;
        case "interaction.request": {
          result = this.parkForInteraction(active, message, payload);
          const exitDeadline = setTimeout(() => {
            if (this.activeRuns.get(message.runId) === active && !active.exiting) {
              active.control = "handoff";
              void active.supervisor.stop("orphaned");
            }
          }, 1_000);
          exitDeadline.unref?.();
          break;
        }
        default:
          return workerResponse(message, "rejected", undefined, "Unknown worker operation");
      }
      return workerResponse(
        message,
        "accepted",
        result === undefined ? null : (result as JsonValue),
        undefined,
        runRevision(this.state, message.runId),
      );
    } catch (error) {
      return workerResponse(message, "rejected", undefined, errorMessage(error));
    }
  }

  private handleWorkerProcessOperation(active: ActiveRun, message: WorkerMessage): WorkerResponse {
    if (
      message.operation === "process.register" &&
      !this.queue.verifyWorkflowRunClaim({ runId: message.runId, claimToken: active.claimToken })
    ) {
      active.claimLost = true;
      setImmediate(() => void active.supervisor.stop("claimLost"));
      return workerResponse(message, "claimLost", undefined, "Run claim expired");
    }
    try {
      const payload = requireRecord(message.payload, "worker process payload");
      const pid = requireNonNegativeInteger(payload.pid, "pid");
      if (pid === 0) throw new Error("Worker process PID must be positive");
      const owned = this.workerDescendants.get(message.workerEpoch);
      if (message.operation === "process.unregister") {
        if (owned?.has(pid) !== true) {
          throw new Error("Worker process is not registered to this worker epoch");
        }
        this.registry.unregister(pid);
        owned.delete(pid);
        if (owned.size === 0) this.workerDescendants.delete(message.workerEpoch);
        return workerResponse(message, "accepted", { pid });
      }
      if (active.workerPid === undefined || processParentPid(pid) !== active.workerPid) {
        throw new Error("Worker process is not a direct child of the active worker");
      }
      for (const [workerEpoch, pids] of this.workerDescendants) {
        if (workerEpoch !== message.workerEpoch && pids.has(pid)) {
          throw new Error("Worker process is already registered to another worker epoch");
        }
      }
      this.registry.register(pid);
      const descendants = owned ?? new Set<number>();
      descendants.add(pid);
      this.workerDescendants.set(message.workerEpoch, descendants);
      return workerResponse(message, "accepted", { pid });
    } catch (error) {
      return workerResponse(message, "rejected", undefined, errorMessage(error));
    }
  }

  private reapWorkerDescendants(workerEpoch: string): void {
    const descendants = this.workerDescendants.get(workerEpoch);
    if (descendants === undefined) return;
    this.workerDescendants.delete(workerEpoch);
    for (const pid of descendants) this.registry.kill(pid);
  }

  private acceptWorkerInteraction(
    message: WorkerMessage,
    payload: Record<string, unknown>,
  ): InteractiveSubmissionRecord {
    const candidate = this.requireWorkerInteraction(message, payload, true);
    return this.hostState.finishInteractionValidation({
      requestId: candidate.requestId,
      submissionId: candidate.submissionId,
      accepted: true,
      receipt: { status: "accepted" },
    });
  }

  private rejectWorkerInteraction(
    active: ActiveRun,
    message: WorkerMessage,
    payload: Record<string, unknown>,
  ): InteractiveSubmissionRecord {
    const candidate = this.requireWorkerInteraction(message, payload, false);
    return this.settleRejectedInteraction(
      active,
      candidate,
      requireString(payload.error, "interaction validation error"),
    );
  }

  private requireWorkerInteraction(
    message: WorkerMessage,
    payload: Record<string, unknown>,
    acceptSettled: boolean,
  ) {
    const candidate =
      this.hostState.validatingInteraction(message.runId) ??
      (acceptSettled ? this.hostState.acceptedInteraction(message.runId) : undefined);
    if (
      candidate === undefined ||
      candidate.requestId !== requireString(payload.requestId, "interaction requestId") ||
      candidate.submissionId !== requireString(payload.submissionId, "interaction submissionId") ||
      candidate.attemptId !== message.attemptId ||
      candidate.attemptId !== requireString(payload.attemptId, "interaction attemptId")
    ) {
      throw new Error("Interactive submission does not match the worker candidate");
    }
    return candidate;
  }

  private settleRejectedInteraction(
    active: ActiveRun,
    candidate: {
      requestId: string;
      submissionId: string;
      attemptId: string;
    },
    error: string,
  ): InteractiveSubmissionRecord {
    const result = this.state.transaction(() => {
      const submission = this.hostState.finishInteractionValidation({
        requestId: candidate.requestId,
        submissionId: candidate.submissionId,
        accepted: false,
        receipt: { status: "rejected", error },
      });
      const now = Date.now();
      this.state.connection
        .prepare(
          `UPDATE node_attempts SET status = 'waiting', updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status IN ('running', 'interrupted')`,
        )
        .run(now, candidate.attemptId, active.record.runId);
      this.state.connection
        .prepare(
          `UPDATE runs SET status = 'waiting', status_detail = ?, updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(error, now, now, active.record.runId);
      if (
        !this.queue.parkWorkflowRun({
          runId: active.record.runId,
          claimToken: active.claimToken,
        })
      ) {
        throw new Error("Rejected interaction could not release the run claim");
      }
      recordViewerDeltas(
        this.state,
        active.record.runId,
        [{ targetType: "summary" }, { targetType: "replay" }, { targetType: "conversation" }],
        now,
      );
      return submission;
    });
    active.control = "handoff";
    return result;
  }

  private enqueueWorkerNotification(
    active: ActiveRun,
    message: WorkerMessage,
    payload: Record<string, unknown>,
  ): JsonValue {
    if (active.record.originSessionId === null) {
      throw new Error("Workflow notification has no origin Pi session");
    }
    const request = requireRecord(payload.request, "notification request");
    if (
      requireString(request.runId, "notification.runId") !== message.runId ||
      requireString(request.workflowName, "notification.workflowName") !==
        active.record.workflowName
    ) {
      throw new Error("Workflow notification provenance does not match the active run");
    }
    const notificationIndex = requireNonNegativeInteger(
      request.notificationIndex,
      "notificationIndex",
    );
    if (notificationIndex === 0) throw new Error("notificationIndex must be positive");
    const kind = request.kind;
    if (kind !== "progress" && kind !== "final") {
      throw new Error("Workflow notification kind is invalid");
    }
    const record = this.queue.enqueueWorkflowNotification({
      runId: message.runId,
      nodeId: requireString(request.nodeId, "notification.nodeId"),
      attemptId: requireString(request.attemptId, "notification.attemptId"),
      notificationIndex,
      targetSessionId: active.record.originSessionId,
      kind,
      content: requireString(request.content, "notification.content"),
    });
    return {
      notificationId: record.notificationId,
      targetSessionId: record.targetSessionId,
    };
  }

  private requestWorkerPresentation(
    active: ActiveRun,
    message: WorkerMessage,
    payload: Record<string, unknown>,
  ): JsonValue {
    if (active.record.originSessionId === null) {
      throw new Error("Workflow presentation has no origin Pi session");
    }
    const instructions = requireString(payload.instructions, "presentation instructions").trim();
    if (instructions.length === 0) throw new Error("Presentation instructions must not be empty");
    const facts: WorkflowTurnIntentFacts & { presentationPrompt: string } = {
      schema: "pi-workflows.deferred-turn-facts.v1",
      workflowName: active.record.workflowName,
      runId: message.runId,
      observedState: "completed",
      cause: "terminal",
      nodeId: null,
      attemptId: null,
      reason: null,
      handoff: false,
      presentationPrompt: instructions,
    };
    const intent = this.queue.ensureWorkflowTurnIntent({
      intentId: `presentation-${message.runId}`,
      sourceEventId: `presentation-request-${message.runId}`,
      runId: message.runId,
      workflowRef: active.record.workflowSourceRef,
      targetSessionId: active.record.originSessionId,
      cause: "terminal",
      fallbackFacts: facts,
      eligible: false,
    });
    return intent as unknown as JsonValue;
  }

  private parkForInteraction(
    active: ActiveRun,
    message: WorkerMessage,
    payload: Record<string, unknown>,
  ): JsonValue {
    if (active.record.originSessionId === null) {
      throw new Error("Interactive request has no origin Pi session");
    }
    const attemptId = requireString(payload.attemptId, "attemptId");
    const requestId = `interaction-${message.runId}-${attemptId}`;
    return this.state.transaction(() => {
      const request = this.hostState.createInteractiveRequest({
        requestId,
        runId: message.runId,
        attemptId,
        targetSessionId: active.record.originSessionId as string,
        kind: payload.kind === "assistant" ? "assistant" : "agent",
        contract: payload.contract as JsonValue,
      });
      const now = Date.now();
      this.state.connection
        .prepare(
          `UPDATE node_attempts SET status = 'waiting', updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(now, attemptId, message.runId);
      this.state.connection
        .prepare(
          `UPDATE runs SET status = 'waiting', status_detail = ?, updated_at = ?, finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run("waiting for origin Pi session", now, now, message.runId);
      if (!this.queue.parkWorkflowRun({ runId: message.runId, claimToken: active.claimToken })) {
        throw new Error("Interactive request could not release the run claim");
      }
      active.control = "handoff";
      recordViewerDeltas(
        this.state,
        message.runId,
        [{ targetType: "summary" }, { targetType: "replay" }, { targetType: "conversation" }],
        now,
      );
      return request as unknown as JsonValue;
    });
  }

  private async prepareInteractionResume(runId: string): Promise<void> {
    const accepted = this.hostState.acceptedInteraction(runId);
    const candidate = accepted ?? this.hostState.validatingInteraction(runId);
    const timedOut = this.hostState.timedOutInteraction(runId);
    if (candidate === undefined && timedOut === undefined) return;
    const loaded = this.runStore.readRun(runId);
    if (loaded === null) return;
    if (timedOut !== undefined) {
      if (loaded.state.status !== "running") {
        throw new Error(`Timed-out interaction run ${runId} is not running`);
      }
      return;
    }
    if (candidate === undefined || loaded.state.status !== "waiting") return;
    loaded.state.status = "running";
    delete loaded.state.statusDetail;
    delete loaded.state.finishedAt;
    await this.runStore.writeSnapshot(runId, loaded.state, {
      scope: "node",
      type: accepted === undefined ? "interaction_validation_started" : "interaction_accepted",
      nodeId: candidate.nodeId,
      attemptId: candidate.attemptId,
      payload: {
        requestId: candidate.requestId,
        submissionId: candidate.submissionId,
      },
    });
  }

  private applyLifecycleProjection(context: {
    runId: string;
    state: WorkflowRunState;
    event: { type: string; attemptId?: string; payload?: Record<string, unknown> };
    database: StateDatabase;
    now: number;
  }): void {
    const active = this.activeRuns.get(context.runId);
    if (active === undefined) return;
    if (context.event.type === "node_finished" && context.event.attemptId !== undefined) {
      this.hostState.consumeAcceptedInteraction(
        context.runId,
        context.event.attemptId,
        context.now,
      );
    }
    if (context.state.status === "running") {
      if (context.event.type === "run_started" || context.event.type === "run_resumed") {
        context.database.connection
          .prepare(
            `UPDATE run_queue SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE run_id = ? AND status IN ('starting', 'parked')`,
          )
          .run(context.now, context.now, context.runId);
      }
      return;
    }
    this.completeControllerWorkflow(context.runId, context.state);
    const queueStatus =
      context.state.status === "completed"
        ? "done"
        : context.state.status === "waiting"
          ? "parked"
          : context.state.status === "cancelled"
            ? "cancelled"
            : "failed";
    const run = context.database.connection
      .prepare("SELECT error_hash AS errorHash FROM runs WHERE run_id = ?")
      .get(context.runId) as { errorHash?: Buffer | null } | undefined;
    context.database.connection
      .prepare(
        `UPDATE run_queue
         SET status = ?, error_code = ?, error_hash = ?, updated_at = ?, finished_at = ?
         WHERE run_id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .run(
        queueStatus,
        queueStatus === "failed" ? context.state.status : null,
        run?.errorHash ?? null,
        context.now,
        ["done", "failed", "cancelled"].includes(queueStatus) ? context.now : null,
        context.runId,
      );
    if (context.state.status === "completed") {
      if (
        context.event.payload?.presentationRequired === true &&
        active.record.originSessionId !== null &&
        this.queue.findPendingWorkflowTurnIntent({
          runId: context.runId,
          targetSessionId: active.record.originSessionId,
        }) === undefined
      ) {
        const facts: WorkflowTurnIntentFacts & { presentationPrompt: string } = {
          schema: "pi-workflows.deferred-turn-facts.v1",
          workflowName: active.record.workflowName,
          runId: context.runId,
          observedState: "completed",
          cause: "terminal",
          nodeId: null,
          attemptId: null,
          reason: "workflow presentation instructions were unavailable",
          handoff: false,
          presentationPrompt:
            "Summarize the completed workflow result for the user in a normal response.",
        };
        this.queue.ensureWorkflowTurnIntent({
          intentId: `presentation-${context.runId}`,
          sourceEventId: `presentation-request-${context.runId}`,
          runId: context.runId,
          workflowRef: active.record.workflowSourceRef,
          targetSessionId: active.record.originSessionId,
          cause: "terminal",
          fallbackFacts: facts,
          eligible: false,
        });
      }
      context.database.connection
        .prepare(
          `UPDATE turn_intents SET eligible_at = ?
           WHERE run_id = ? AND resolved_at IS NULL AND eligible_at IS NULL`,
        )
        .run(context.now, context.runId);
    }
    context.database.connection
      .prepare(
        `UPDATE leases
         SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
             acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
         WHERE resource_id = (SELECT resource_id FROM runs WHERE run_id = ?)
           AND generation = ?`,
      )
      .run(context.runId, active.generation);
  }

  private completeControllerWorkflow(runId: string, state: WorkflowRunState): void {
    const row = this.state.connection
      .prepare(
        `SELECT w.request_id AS requestId, c.controller_name AS controller,
                c.resource_key AS resourceKey, p.canonical_path AS projectPath
         FROM controller_workflows w
         JOIN controller_resources c ON c.controller_resource_id = w.controller_resource_id
         JOIN projects p ON p.project_id = c.project_id
         WHERE w.run_id = ? LIMIT 1`,
      )
      .get(runId) as
      | {
          requestId?: unknown;
          controller?: unknown;
          resourceKey?: unknown;
          projectPath?: unknown;
        }
      | undefined;
    if (
      typeof row?.requestId !== "string" ||
      typeof row.controller !== "string" ||
      typeof row.resourceKey !== "string" ||
      typeof row.projectPath !== "string"
    ) {
      return;
    }
    const store = new SqliteControllerStore(this.databasePath, {
      state: this.state,
      projectPath: row.projectPath,
    });
    const childState =
      state.status === "completed"
        ? "succeeded"
        : state.status === "waiting"
          ? "waiting"
          : "failed";
    store.completeWorkflow(row.requestId, {
      state: childState,
      runId,
      ...(state.error === undefined ? {} : { error: state.error }),
    });
    store.enqueue({ controller: row.controller, key: row.resourceKey });
  }

  private commitActivePause(active: ActiveRun): void {
    const now = Date.now();
    this.state.transaction(() => {
      this.state.connection
        .prepare("UPDATE runs SET paused = 1, status_detail = ?, updated_at = ? WHERE run_id = ?")
        .run("paused", now, active.record.runId);
      if (
        !this.queue.parkWorkflowRun({
          runId: active.record.runId,
          claimToken: active.claimToken,
        })
      ) {
        throw new Error("Run claim was lost before pause committed");
      }
    });
  }

  private async recoverWorkerExit(active: ActiveRun, outcome: string): Promise<void> {
    if (
      !this.queue.verifyWorkflowRunClaim({
        runId: active.record.runId,
        claimToken: active.claimToken,
      })
    ) {
      return;
    }
    const recovery = await this.runStore.recoverApplyingEffects(active.record.runId);
    if (recovery === "ambiguous" || hasUncertainEffect(this.state, active.record.runId)) {
      this.blockedRuns.add(active.record.runId);
      if (
        !this.queue.parkWorkflowRunForAmbiguousEffect({
          runId: active.record.runId,
          claimToken: active.claimToken,
        })
      ) {
        return;
      }
      this.log(`run ${active.record.runId} parked for ambiguous effect recovery`);
      return;
    }
    const validating = this.hostState.validatingInteraction(active.record.runId);
    if (validating !== undefined) {
      this.settleRejectedInteraction(
        active,
        validating,
        `Workflow worker ${outcome} before it completed interaction validation`,
      );
      this.log(`run ${active.record.runId} rejected an interrupted interaction validation`);
      return;
    }
    if (active.workflowLoadFailure !== undefined) {
      if (
        this.queue.parkWorkflowRunForSourceChange({
          runId: active.record.runId,
          claimToken: active.claimToken,
          detail: active.workflowLoadFailure,
        })
      ) {
        this.log(`run ${active.record.runId} parked because its workflow source could not load`);
      }
      return;
    }
    this.queue.parkWorkflowRun({ runId: active.record.runId, claimToken: active.claimToken });
    this.log(`run ${active.record.runId} parked after worker ${outcome}`);
  }

  private releaseLock(): void {
    try {
      const current = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as unknown;
      if (isLockRecord(current) && current.hostId === this.hostId) fs.rmSync(this.lockPath);
    } catch {
      // The lock is already gone.
    }
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }
}

function acquireHostLock(
  lockPath: string,
  record: { pid: number; startIdentity: string; hostId: string },
): void {
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (isLockRecord(existing) && matchesProcessIdentity(existing)) {
      throw new Error(`A workflow host is already running with PID ${existing.pid}`);
    }
    fs.rmSync(lockPath, { force: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("A workflow host is already"))
      throw error;
  }
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ schema: "pi-workflows.host-lock.v1", ...record })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

function workerResponse(
  message: WorkerMessage,
  outcome: WorkerResponse["outcome"],
  result?: JsonValue,
  error?: string,
  revision?: number,
): WorkerResponse {
  return {
    schema: "pi-workflows.worker-response.v1",
    messageId: message.messageId,
    outcome,
    ...(revision === undefined ? {} : { revision }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function controllerWorkerResponse(
  message: ControllerWorkerMessage,
  outcome: ControllerWorkerResponse["outcome"],
  result?: JsonValue,
  error?: string,
): ControllerWorkerResponse {
  return {
    schema: "pi-workflows.controller-worker-response.v1",
    messageId: message.messageId,
    outcome,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function controllerWorkflowResult(record: WorkflowRunQueueRecord): WorkflowSchedulerResult {
  switch (record.status) {
    case "queued":
    case "starting":
    case "running":
      return { state: "running", runId: record.runId };
    case "parked":
      return { state: "waiting", runId: record.runId };
    case "done":
      return { state: "succeeded", runId: record.runId };
    case "failed":
    case "cancelled":
      return {
        state: "failed",
        runId: record.runId,
        ...(record.errorMessage === null ? {} : { error: record.errorMessage }),
      };
  }
}

function runRevision(state: StateDatabase, runId: string): number {
  const row = state.connection
    .prepare(
      `SELECT resources.revision FROM resources
       JOIN runs ON runs.resource_id = resources.resource_id WHERE runs.run_id = ?`,
    )
    .get(runId);
  if (!isRevisionRow(row)) throw new Error(`Workflow run not found: ${runId}`);
  return row.revision;
}

function hasUncertainEffect(state: StateDatabase, runId: string): boolean {
  const row = state.connection
    .prepare(
      `SELECT 1 AS present FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
       WHERE r.run_id = ? AND e.status IN ('applying', 'ambiguous') LIMIT 1`,
    )
    .get(runId);
  return row !== undefined;
}

function controllerPathAllowed(
  projectPath: string,
  controllerName: string,
  controllerPath: string,
): boolean {
  if (
    controllerFileStem(controllerPath) !== controllerName ||
    !/\.controller\.(?:ts|js|mts|mjs)$/u.test(controllerPath)
  ) {
    return false;
  }
  return controllerSearchDirs({ cwd: projectPath }).some(
    ({ dir }) => path.dirname(controllerPath) === path.resolve(dir),
  );
}

function payloadLimit(payload: JsonValue): number {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return 100;
  const limit = (payload as Record<string, unknown>).limit;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
}

function requireRunId(request: HostRequest): string {
  if (request.runId === undefined) throw new Error(`${request.operation} requires runId`);
  return request.runId;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be text`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, name: string): string {
  const parsed = requireString(value, name);
  if (!path.isAbsolute(parsed)) throw new Error(`${name} must be an absolute path`);
  return parsed;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}

function isLockRecord(
  value: unknown,
): value is { schema: string; pid: number; startIdentity: string; hostId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema?: unknown }).schema === "pi-workflows.host-lock.v1" &&
    typeof (value as { pid?: unknown }).pid === "number" &&
    typeof (value as { startIdentity?: unknown }).startIdentity === "string" &&
    typeof (value as { hostId?: unknown }).hostId === "string"
  );
}
