import { randomUUID } from "node:crypto";
import { applyStatusPatch } from "./conditions.js";
import { asAnyResourceManagerDefinition, asTypedResource } from "./definition.js";
import { ResourceManagerEffectService } from "./effects.js";
import { ManagedResourceConflictError } from "./errors.js";
import { createResultHelpers } from "./results.js";
import type { ResourceManagerStore } from "./store.js";
import type {
  AnyResourceManagerDefinition,
  ResourceManagerDefinition,
  ResourceManagerQueueClaim,
  ManagedResource,
  ManagedResourceRef,
  JsonObject,
  ReconcileContext,
  ReconcileResult,
} from "./types.js";
import {
  ResourceManagerWorkflowCoordinator,
  type ResourceManagerWorkflowScheduler,
} from "./workflows.js";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const MIN_LEASE_MS = 300;

export type ResourceManagerRuntimeOptions = {
  store: ResourceManagerStore;
  resourceManagers: AnyResourceManagerDefinition[];
  workflowScheduler?: ResourceManagerWorkflowScheduler;
  maxConcurrent?: number;
  resourceManagerConcurrency?: Record<string, number>;
  defaultTimeoutMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  now?: () => Date;
  random?: () => number;
};

export class ResourceManagerRuntime {
  readonly store: ResourceManagerStore;
  private readonly ownerId = `resource-manager-runtime-${randomUUID()}`;
  private readonly definitions = new Map<string, AnyResourceManagerDefinition>();
  private readonly workflowCoordinator: ResourceManagerWorkflowCoordinator;
  private readonly maxConcurrent: number;
  private readonly resourceManagerConcurrency: Record<string, number>;
  private readonly defaultTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly activeByResourceManager = new Map<string, number>();
  private readonly activeReconciles = new Map<string, AbortController>();
  private runAbort: AbortController | null = null;
  private runnerTasks: Promise<void>[] = [];

  constructor(options: ResourceManagerRuntimeOptions) {
    this.store = options.store;
    for (const definition of options.resourceManagers) {
      if (this.definitions.has(definition.name)) {
        throw new Error(`Duplicate resource manager definition: ${definition.name}`);
      }
      this.definitions.set(definition.name, definition);
    }
    this.workflowCoordinator = new ResourceManagerWorkflowCoordinator(
      options.store,
      options.workflowScheduler,
    );
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      "maxConcurrent",
    );
    this.resourceManagerConcurrency = options.resourceManagerConcurrency ?? {};
    for (const [name, value] of Object.entries(this.resourceManagerConcurrency)) {
      if (!this.definitions.has(name)) {
        throw new Error(`Concurrency limit names an unknown resource manager: ${name}`);
      }
      positiveInteger(value, `resourceManagerConcurrency.${name}`);
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
    definition: ResourceManagerDefinition<TSpec, TStatus>,
    key: string,
    spec: TSpec,
  ): ManagedResource<TSpec, TStatus> {
    const registered = this.definitions.get(definition.name);
    if (registered !== asAnyResourceManagerDefinition(definition)) {
      throw new Error(`ResourceManager definition is not registered: ${definition.name}`);
    }
    const initialStatus = definition.initialStatus(spec);
    const resource = this.store.putResource({
      resourceManager: definition.name,
      key,
      spec,
      initialStatus,
      now: this.now().toISOString(),
    });
    this.recordEvent(
      { resourceManager: definition.name, key },
      resource.metadata.generation === 1 ? "resource_applied" : "resource_updated",
      { generation: resource.metadata.generation },
    );
    const current = this.store.getResource<TSpec, TStatus>({
      resourceManager: definition.name,
      key,
    });
    if (current === undefined) throw new Error("Managed resource disappeared after its event");
    return current;
  }

  putResourceByName(resourceManager: string, key: string, spec: unknown): ManagedResource {
    const definition = this.definitions.get(resourceManager);
    if (definition === undefined) {
      throw new Error(`Unknown resource manager: ${resourceManager}`);
    }
    const initialStatus = definition.initialStatus(spec);
    const resource = this.store.putResource({
      resourceManager,
      key,
      spec,
      initialStatus,
      now: this.now().toISOString(),
    });
    this.recordEvent(
      { resourceManager, key },
      resource.metadata.generation === 1 ? "resource_applied" : "resource_updated",
      { generation: resource.metadata.generation },
    );
    const current = this.store.getResource({ resourceManager, key });
    if (current === undefined) throw new Error("Managed resource disappeared after its event");
    return current;
  }

  requestDeletion(ref: ManagedResourceRef): ManagedResource {
    this.store.requestDeletion(ref, this.now().toISOString());
    this.recordEvent(ref, "deletion_requested");
    const current = this.store.getResource(ref);
    if (current === undefined) throw new Error("Managed resource disappeared after its event");
    return current;
  }

  enqueue(ref: ManagedResourceRef, afterMs = 0): void {
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
    this.runnerTasks = Array.from({ length: this.maxConcurrent }, () =>
      this.runnerLoop(this.runAbort?.signal as AbortSignal),
    );
  }

  async stop(): Promise<void> {
    const abort = this.runAbort;
    if (abort === null) {
      return;
    }
    this.runAbort = null;
    abort.abort(new Error("Resource manager stopped"));
    for (const abortController of this.activeReconciles.values()) {
      abortController.abort(new Error("Resource manager stopped"));
    }
    await Promise.allSettled(this.runnerTasks);
    this.runnerTasks = [];
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
      throw new Error(`Resource manager exceeded ${maxReconciles} reconciliations`);
    }
    return count;
  }

  get workflowRequests(): ResourceManagerWorkflowCoordinator {
    return this.workflowCoordinator;
  }

  private async runnerLoop(signal: AbortSignal): Promise<void> {
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
        // this runner alive so it can reconcile other queued resources.
      }
    }
  }

  private claimNext(): ResourceManagerQueueClaim | undefined {
    return this.store.claimNext({
      resourceManagers: this.eligibleResourceManagers(),
      ownerId: this.ownerId,
      leaseMs: this.leaseMs,
      now: this.now().toISOString(),
    });
  }

  private eligibleResourceManagers(): string[] {
    return [...this.definitions.keys()].filter((name) => {
      const active = this.activeByResourceManager.get(name) ?? 0;
      const limit = this.resourceManagerConcurrency[name] ?? this.maxConcurrent;
      return active < limit;
    });
  }

  private async processClaim(claim: ResourceManagerQueueClaim): Promise<void> {
    const definition = this.definitions.get(claim.resourceManager);
    if (definition === undefined) {
      return;
    }
    this.activeByResourceManager.set(
      claim.resourceManager,
      (this.activeByResourceManager.get(claim.resourceManager) ?? 0) + 1,
    );
    try {
      await this.reconcileClaim(definition, claim);
    } finally {
      const active = (this.activeByResourceManager.get(claim.resourceManager) ?? 1) - 1;
      if (active === 0) {
        this.activeByResourceManager.delete(claim.resourceManager);
      } else {
        this.activeByResourceManager.set(claim.resourceManager, active);
      }
    }
  }

  private async reconcileClaim(
    definition: AnyResourceManagerDefinition,
    claim: ResourceManagerQueueClaim,
  ): Promise<void> {
    const ref = { resourceManager: claim.resourceManager, key: claim.key };
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
          abort.abort(new Error("ResourceManager queue claim was lost"));
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
    definition: AnyResourceManagerDefinition,
    resource: ManagedResource,
    claim: ResourceManagerQueueClaim,
    signal: AbortSignal,
  ): Promise<ReconcileResult<unknown>> {
    const context: ReconcileContext<unknown> = {
      signal,
      effects: new ResourceManagerEffectService(this.store, resource, claim, signal),
      workflows: this.workflowCoordinator.forResource(resource, claim, signal),
      ...createResultHelpers<unknown>(),
    };
    const result = await definition.reconcile(context, asTypedResource(resource));
    validateResult(result);
    return result;
  }

  private async finishSuccessfulClaim(
    claim: ResourceManagerQueueClaim,
    resource: ManagedResource,
    result: ReconcileResult<unknown>,
    reconcileId: string,
    startedAtMs: number,
  ): Promise<void> {
    const ref = { resourceManager: claim.resourceManager, key: claim.key };
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
      if (error instanceof ManagedResourceConflictError) {
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
    claim: ResourceManagerQueueClaim,
    ref: ManagedResourceRef,
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
    ref: ManagedResourceRef,
    type: string,
    payload: JsonObject = {},
    claim?: ResourceManagerQueueClaim,
  ): void {
    this.store.recordEvent({
      resourceManager: ref.resourceManager,
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
    throw new Error("ResourceManager reconcile must return a result object");
  }
  if (result.kind !== "settled" && result.kind !== "requeue") {
    throw new Error("ResourceManager reconcile returned an unknown result kind");
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
