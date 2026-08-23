import { randomUUID } from "node:crypto";
import { applyStatusPatch } from "./conditions.js";
import { asAnyControllerDefinition, asTypedResource } from "./definition.js";
import { ControllerEffectService } from "./effects.js";
import { ResourceConflictError } from "./errors.js";
import { createResultHelpers } from "./results.js";
import type { ControllerStore } from "./store.js";
import type {
  AnyControllerDefinition,
  ControllerDefinition,
  ControllerQueueClaim,
  ControllerResource,
  ControllerResourceRef,
  JsonObject,
  ReconcileContext,
  ReconcileResult,
} from "./types.js";
import { ControllerWorkflowCoordinator, type ControllerWorkflowScheduler } from "./workflows.js";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const MIN_LEASE_MS = 300;

export type ControllerManagerOptions = {
  store: ControllerStore;
  controllers: AnyControllerDefinition[];
  workflowScheduler?: ControllerWorkflowScheduler;
  maxConcurrent?: number;
  controllerConcurrency?: Record<string, number>;
  defaultTimeoutMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  now?: () => Date;
  random?: () => number;
};

export class ControllerManager {
  readonly store: ControllerStore;
  private readonly ownerId = `controller-manager-${randomUUID()}`;
  private readonly definitions = new Map<string, AnyControllerDefinition>();
  private readonly workflowCoordinator: ControllerWorkflowCoordinator;
  private readonly maxConcurrent: number;
  private readonly controllerConcurrency: Record<string, number>;
  private readonly defaultTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly activeByController = new Map<string, number>();
  private readonly activeReconciles = new Map<string, AbortController>();
  private runAbort: AbortController | null = null;
  private workerTasks: Promise<void>[] = [];

  constructor(options: ControllerManagerOptions) {
    this.store = options.store;
    for (const definition of options.controllers) {
      if (this.definitions.has(definition.name)) {
        throw new Error(`Duplicate controller definition: ${definition.name}`);
      }
      this.definitions.set(definition.name, definition);
    }
    this.workflowCoordinator = new ControllerWorkflowCoordinator(
      options.store,
      options.workflowScheduler,
    );
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      "maxConcurrent",
    );
    this.controllerConcurrency = options.controllerConcurrency ?? {};
    for (const [name, value] of Object.entries(this.controllerConcurrency)) {
      if (!this.definitions.has(name)) {
        throw new Error(`Concurrency limit names an unknown controller: ${name}`);
      }
      positiveInteger(value, `controllerConcurrency.${name}`);
    }
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
    if (this.leaseMs < MIN_LEASE_MS) {
      throw new Error(`leaseMs must be at least ${MIN_LEASE_MS}`);
    }
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.baseBackoffMs = positiveInteger(
      options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      "baseBackoffMs",
    );
    this.maxBackoffMs = positiveInteger(
      options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      "maxBackoffMs",
    );
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new Error("maxBackoffMs must be greater than or equal to baseBackoffMs");
    }
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new Error("jitterRatio must be between 0 and 1");
    }
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  putResource<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
    key: string,
    spec: TSpec,
  ): ControllerResource<TSpec, TStatus> {
    const registered = this.definitions.get(definition.name);
    if (registered !== asAnyControllerDefinition(definition)) {
      throw new Error(`Controller definition is not registered: ${definition.name}`);
    }
    const initialStatus = definition.initialStatus(spec);
    const resource = this.store.putResource({
      controller: definition.name,
      key,
      spec,
      initialStatus,
      now: this.now().toISOString(),
    });
    this.recordEvent(
      { controller: definition.name, key },
      resource.metadata.generation === 1 ? "resource_applied" : "resource_updated",
      { generation: resource.metadata.generation },
    );
    return resource;
  }

  putResourceByName(controller: string, key: string, spec: unknown): ControllerResource {
    const definition = this.definitions.get(controller);
    if (definition === undefined) {
      throw new Error(`Unknown controller: ${controller}`);
    }
    const initialStatus = definition.initialStatus(spec);
    const resource = this.store.putResource({
      controller,
      key,
      spec,
      initialStatus,
      now: this.now().toISOString(),
    });
    this.recordEvent(
      { controller, key },
      resource.metadata.generation === 1 ? "resource_applied" : "resource_updated",
      { generation: resource.metadata.generation },
    );
    return resource;
  }

  requestDeletion(ref: ControllerResourceRef): ControllerResource {
    const resource = this.store.requestDeletion(ref, this.now().toISOString());
    this.recordEvent(ref, "deletion_requested");
    return resource;
  }

  enqueue(ref: ControllerResourceRef, afterMs = 0): void {
    if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
      throw new Error("afterMs must be a non-negative safe integer");
    }
    this.store.enqueue(ref, new Date(this.now().getTime() + afterMs).toISOString());
  }

  start(): void {
    if (this.runAbort !== null) {
      return;
    }
    this.runAbort = new AbortController();
    this.workerTasks = Array.from({ length: this.maxConcurrent }, () =>
      this.workerLoop(this.runAbort?.signal as AbortSignal),
    );
  }

  async stop(): Promise<void> {
    const abort = this.runAbort;
    if (abort === null) {
      return;
    }
    this.runAbort = null;
    abort.abort(new Error("Controller manager stopped"));
    for (const controller of this.activeReconciles.values()) {
      controller.abort(new Error("Controller manager stopped"));
    }
    await Promise.allSettled(this.workerTasks);
    this.workerTasks = [];
  }

  async runOne(): Promise<boolean> {
    const claim = this.claimNext();
    if (claim === undefined) {
      return false;
    }
    await this.processClaim(claim);
    return true;
  }

  async runUntilIdle(maxReconciles = 1_000): Promise<number> {
    positiveInteger(maxReconciles, "maxReconciles");
    let count = 0;
    while (count < maxReconciles && (await this.runOne())) {
      count += 1;
    }
    if (count === maxReconciles && this.readyQueueExists()) {
      throw new Error(`Controller manager exceeded ${maxReconciles} reconciliations`);
    }
    return count;
  }

  get workflowRequests(): ControllerWorkflowCoordinator {
    return this.workflowCoordinator;
  }

  private async workerLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const claim = this.claimNext();
      if (claim === undefined) {
        await sleep(this.pollIntervalMs, signal);
        continue;
      }
      try {
        await this.processClaim(claim);
      } catch {
        if (signal.aborted) return;
        // A stale claim means another owner now controls that resource. Keep
        // this worker alive so it can reconcile other queued resources.
      }
    }
  }

  private claimNext(): ControllerQueueClaim | undefined {
    return this.store.claimNext({
      controllers: this.eligibleControllers(),
      ownerId: this.ownerId,
      leaseMs: this.leaseMs,
      now: this.now().toISOString(),
    });
  }

  private eligibleControllers(): string[] {
    return [...this.definitions.keys()].filter((name) => {
      const active = this.activeByController.get(name) ?? 0;
      const limit = this.controllerConcurrency[name] ?? this.maxConcurrent;
      return active < limit;
    });
  }

  private async processClaim(claim: ControllerQueueClaim): Promise<void> {
    const definition = this.definitions.get(claim.controller);
    if (definition === undefined) {
      return;
    }
    this.activeByController.set(
      claim.controller,
      (this.activeByController.get(claim.controller) ?? 0) + 1,
    );
    try {
      await this.reconcileClaim(definition, claim);
    } finally {
      const active = (this.activeByController.get(claim.controller) ?? 1) - 1;
      if (active === 0) {
        this.activeByController.delete(claim.controller);
      } else {
        this.activeByController.set(claim.controller, active);
      }
    }
  }

  private async reconcileClaim(
    definition: AnyControllerDefinition,
    claim: ControllerQueueClaim,
  ): Promise<void> {
    const ref = { controller: claim.controller, key: claim.key };
    const resource = this.store.getResource(ref);
    if (resource === undefined) {
      this.store.settleClaim(claim, this.now().toISOString());
      return;
    }
    const reconcileId = randomUUID();
    const startedAtMs = this.now().getTime();
    const abort = new AbortController();
    this.activeReconciles.set(reconcileId, abort);
    const parentAbort = this.runAbort?.signal;
    const abortFromParent = () => abort.abort(parentAbort?.reason);
    parentAbort?.addEventListener("abort", abortFromParent, { once: true });
    const timeoutMs = definition.timeoutMs ?? this.defaultTimeoutMs;
    const timeout = setTimeout(
      () => abort.abort(new Error(`Reconciliation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const renew = setInterval(
      () => {
        const renewed = this.store.renewClaim(claim, this.leaseMs, this.now().toISOString());
        if (!renewed) {
          abort.abort(new Error("Controller queue claim was lost"));
        }
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    );
    renew.unref?.();
    this.recordEvent(
      ref,
      "reconcile_started",
      {
        reconcileId,
        generation: resource.metadata.generation,
      },
      claim,
    );

    try {
      const result = await raceWithAbort(
        this.callReconciler(definition, resource, claim, abort.signal),
        abort.signal,
      );
      if (abort.signal.aborted) {
        throw abort.signal.reason ?? new Error("Reconciliation aborted");
      }
      await this.finishSuccessfulClaim(claim, resource, result, reconcileId, startedAtMs);
    } catch (error) {
      await this.finishFailedClaim(claim, ref, reconcileId, error, startedAtMs);
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      parentAbort?.removeEventListener("abort", abortFromParent);
      this.activeReconciles.delete(reconcileId);
    }
  }

  private async callReconciler(
    definition: AnyControllerDefinition,
    resource: ControllerResource,
    claim: ControllerQueueClaim,
    signal: AbortSignal,
  ): Promise<ReconcileResult<unknown>> {
    const context: ReconcileContext<unknown> = {
      signal,
      effects: new ControllerEffectService(this.store, resource, claim, signal),
      workflows: this.workflowCoordinator.forResource(resource, claim, signal),
      ...createResultHelpers<unknown>(),
    };
    const result = await definition.reconcile(context, asTypedResource(resource));
    validateResult(result);
    return result;
  }

  private async finishSuccessfulClaim(
    claim: ControllerQueueClaim,
    resource: ControllerResource,
    result: ReconcileResult<unknown>,
    reconcileId: string,
    startedAtMs: number,
  ): Promise<void> {
    const ref = { controller: claim.controller, key: claim.key };
    const now = this.now();
    const status = applyStatusPatch(
      resource.status,
      result.status,
      resource.metadata.generation,
      now.toISOString(),
    );
    try {
      const updated = this.store.updateStatus({
        ref,
        expectedResourceVersion: claim.resourceVersion,
        claim,
        status,
        ...(result.status?.finalizers !== undefined
          ? { finalizers: result.status.finalizers }
          : {}),
        now: now.toISOString(),
      });
      this.recordEvent(
        ref,
        "reconcile_finished",
        {
          reconcileId,
          result: result.kind,
          generation: resource.metadata.generation,
          durationMs: Math.max(0, now.getTime() - startedAtMs),
          ...(result.kind === "requeue" && result.afterMs !== undefined
            ? { requeueAfterMs: result.afterMs }
            : {}),
        },
        claim,
      );
      if (
        result.kind === "settled" &&
        updated.metadata.deletionTimestamp !== undefined &&
        updated.metadata.finalizers.length === 0
      ) {
        this.recordEvent(ref, "resource_deleted", { reconcileId }, claim);
        this.store.deleteResource(ref, claim.resourceVersion, claim);
        return;
      }
    } catch (error) {
      if (error instanceof ResourceConflictError) {
        this.recordEvent(ref, "reconcile_conflict", { reconcileId }, claim);
        this.store.requeueClaim(claim, { availableAt: now.toISOString() }, now.toISOString());
        return;
      }
      throw error;
    }
    if (result.kind === "settled") {
      this.store.settleClaim(claim, now.toISOString());
      return;
    }
    const afterMs = result.afterMs ?? 0;
    this.store.requeueClaim(
      claim,
      { availableAt: new Date(now.getTime() + afterMs).toISOString() },
      now.toISOString(),
    );
  }

  private async finishFailedClaim(
    claim: ControllerQueueClaim,
    ref: ControllerResourceRef,
    reconcileId: string,
    error: unknown,
    startedAtMs: number,
  ): Promise<void> {
    const now = this.now();
    const message = boundedError(error);
    const delay = this.backoffMs(claim.consecutiveErrors + 1);
    this.recordEvent(
      ref,
      "reconcile_failed",
      {
        reconcileId,
        error: message,
        durationMs: Math.max(0, now.getTime() - startedAtMs),
        requeueAfterMs: delay,
      },
      claim,
    );
    this.store.requeueClaim(
      claim,
      {
        availableAt: new Date(now.getTime() + delay).toISOString(),
        error: message,
      },
      now.toISOString(),
    );
  }

  private backoffMs(consecutiveErrors: number): number {
    const exponent = Math.min(consecutiveErrors - 1, 30);
    const raw = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
    const factor = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return Math.max(1, Math.round(raw * factor));
  }

  private readyQueueExists(): boolean {
    const now = this.now().getTime();
    return this.store.listQueue().some((item) => Date.parse(item.availableAt) <= now);
  }

  private recordEvent(
    ref: ControllerResourceRef,
    type: string,
    payload: JsonObject = {},
    claim?: ControllerQueueClaim,
  ): void {
    this.store.recordEvent({
      controller: ref.controller,
      key: ref.key,
      ...(claim === undefined ? {} : { claim }),
      type,
      payload,
      now: this.now().toISOString(),
    });
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const settle = (callback: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(signal.reason ?? new Error("Reconciliation aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function validateResult(result: ReconcileResult<unknown>): void {
  if (result === null || typeof result !== "object") {
    throw new Error("Controller reconcile must return a result object");
  }
  if (result.kind !== "settled" && result.kind !== "requeue") {
    throw new Error("Controller reconcile returned an unknown result kind");
  }
  if (result.kind === "settled" && "afterMs" in result) {
    throw new Error("A settled reconcile result cannot specify afterMs");
  }
  if (
    result.kind === "requeue" &&
    result.afterMs !== undefined &&
    (!Number.isSafeInteger(result.afterMs) || result.afterMs <= 0)
  ) {
    throw new Error("Requeue afterMs must be a positive safe integer");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 8_192 ? message : `${message.slice(0, 8_192)}…`;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}
