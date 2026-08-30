#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { jsonFingerprint } from "../controllers/json.js";
import { loadControllerFile } from "../controllers/loader.js";
import { createResultHelpers } from "../controllers/results.js";
import type {
  ChildWorkflowRecord,
  ControllerEffects,
  ControllerFollowUpResult,
  ControllerQueueFollowUpRequest,
  ControllerRemoveFollowUpRequest,
  ControllerSettingsChangeRequest,
  ControllerSettingsChangeResult,
  ControllerWorkflows,
  EffectApplication,
  EffectDefinition,
  EffectObservation,
  EffectRecord,
  ReconcileContext,
  ReconcileResult,
} from "../controllers/types.js";
import { parseJson, type JsonValue } from "../state/json.js";
import { errorMessage } from "../workflows/errors.js";
import {
  CONTROLLER_WORKER_LAUNCH_SCHEMA,
  encodeControllerWorkerLine,
  parseControllerWorkerResponse,
  type ControllerWorkerLaunchEnvelope,
  type ControllerWorkerMessage,
  type ControllerWorkerOperation,
  type ControllerWorkerResponse,
} from "./controller-worker-protocol.js";

const STARTUP_ENV = "PI_WORKFLOWS_CONTROLLER_WORKER_LAUNCH";
const MAX_FRAME_BYTES = 1024 * 1024;

class ControllerWorkerTransport {
  private readonly pending = new Map<
    string,
    { resolve: (response: ControllerWorkerResponse) => void; reject: (error: Error) => void }
  >();
  private buffered = Buffer.alloc(0);

  constructor(private readonly launch: ControllerWorkerLaunchEnvelope) {
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("error", (error) => this.failAll(error));
    process.stdin.resume();
  }

  async request<T>(operation: ControllerWorkerOperation, payload: JsonValue): Promise<T> {
    const message: ControllerWorkerMessage = {
      schema: "pi-workflows.controller-worker-message.v1",
      launchSchema: this.launch.schema,
      messageId: randomUUID(),
      workerEpoch: this.launch.workerEpoch,
      generation: this.launch.generation,
      operation,
      payload,
    };
    const response = await this.send(message);
    if (response.outcome !== "accepted") {
      throw new Error(response.error ?? `Controller worker ${response.outcome}`);
    }
    return response.result as T;
  }

  close(): void {
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("error");
    this.failAll(new Error("Controller worker transport closed"));
  }

  private async send(message: ControllerWorkerMessage): Promise<ControllerWorkerResponse> {
    const response = new Promise<ControllerWorkerResponse>((resolve, reject) => {
      this.pending.set(message.messageId, { resolve, reject });
    });
    if (!process.stdout.write(encodeControllerWorkerLine(message))) {
      await once(process.stdout, "drain");
    }
    return await response;
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.byteLength > MAX_FRAME_BYTES && !this.buffered.includes(0x0a)) {
      this.failAll(new Error("Controller worker response exceeds 1 MiB"));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      try {
        const response = parseControllerWorkerResponse(frame);
        const pending = this.pending.get(response.messageId);
        if (pending === undefined) throw new Error("Controller worker response is unexpected");
        this.pending.delete(response.messageId);
        pending.resolve(response);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class HostedControllerEffects implements ControllerEffects {
  private used = false;

  constructor(
    private readonly transport: ControllerWorkerTransport,
    private readonly signal: AbortSignal,
  ) {}

  async ensure<TRequest>(definition: EffectDefinition<TRequest>): Promise<EffectRecord> {
    if (this.used) throw new Error("A reconciliation pass may ensure only one external effect");
    this.used = true;
    const reservation = await this.transport.request<{ record: EffectRecord; created: boolean }>(
      "effect.reserve",
      {
        key: definition.key,
        kind: definition.kind,
        requestFingerprint: jsonFingerprint(definition.request),
      },
    );
    if (["applied", "rejected", "indeterminate"].includes(reservation.record.state)) {
      return reservation.record;
    }
    if (!reservation.created) {
      const observation = await definition.observe(this.signal);
      if (observation.state !== "not_applied") {
        return await this.settleObservation(definition.key, observation);
      }
    }
    let applied: EffectApplication;
    try {
      applied = await definition.apply(this.signal);
    } catch (error) {
      applied = { state: "indeterminate", error: boundedError(error) };
    }
    return await this.transport.request<EffectRecord>("effect.settle", {
      key: definition.key,
      state: applied.state,
      ...(applied.state === "applied" && applied.externalRef !== undefined
        ? { externalRef: applied.externalRef }
        : {}),
      ...(applied.state !== "applied" && applied.error !== undefined
        ? { error: applied.error }
        : {}),
    });
  }

  private async settleObservation(
    key: string,
    observation: EffectObservation,
  ): Promise<EffectRecord> {
    return await this.transport.request<EffectRecord>("effect.settle", {
      key,
      state: observation.state === "applied" ? "applied" : "indeterminate",
      ...(observation.state === "applied" && observation.externalRef !== undefined
        ? { externalRef: observation.externalRef }
        : {}),
    });
  }
}

class HostedControllerWorkflows implements ControllerWorkflows {
  constructor(private readonly transport: ControllerWorkerTransport) {}

  async ensure(request: {
    requestKey: string;
    workflow: string;
    input: unknown;
  }): Promise<ChildWorkflowRecord> {
    return await this.transport.request<ChildWorkflowRecord>(
      "workflow.ensure",
      request as JsonValue,
    );
  }

  async changeSettings(
    request: ControllerSettingsChangeRequest,
  ): Promise<ControllerSettingsChangeResult> {
    return await this.transport.request<ControllerSettingsChangeResult>(
      "workflow.changeSettings",
      request as unknown as JsonValue,
    );
  }

  async queueFollowUp(request: ControllerQueueFollowUpRequest): Promise<ControllerFollowUpResult> {
    return await this.transport.request<ControllerFollowUpResult>(
      "workflow.queueFollowUp",
      request as unknown as JsonValue,
    );
  }

  async removeFollowUp(
    request: ControllerRemoveFollowUpRequest,
  ): Promise<ControllerFollowUpResult> {
    return await this.transport.request<ControllerFollowUpResult>(
      "workflow.removeFollowUp",
      request as unknown as JsonValue,
    );
  }
}

export async function runControllerWorker(): Promise<number> {
  const launch = readLaunchEnvelope();
  const transport = new ControllerWorkerTransport(launch);
  try {
    const definition = await loadControllerFile(launch.definitionPath);
    if (definition.name !== launch.controllerName) {
      throw new Error(
        `Controller source name changed: expected ${launch.controllerName}, got ${definition.name}`,
      );
    }
    await transport.request("worker.ready", {});
    const abort = new AbortController();
    const timeoutMs = definition.timeoutMs ?? launch.timeoutMs;
    const timer = setTimeout(
      () => abort.abort(new Error(`Reconciliation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const context: ReconcileContext<unknown> = {
        signal: abort.signal,
        effects: new HostedControllerEffects(transport, abort.signal),
        workflows: new HostedControllerWorkflows(transport),
        ...createResultHelpers<unknown>(),
      };
      const result = await raceWithAbort(
        Promise.resolve(definition.reconcile(context, launch.resource)),
        abort.signal,
      );
      validateResult(result);
      await transport.request("worker.finished", result as unknown as JsonValue);
    } catch (error) {
      await transport.request("worker.failed", { error: boundedError(error) });
    } finally {
      clearTimeout(timer);
    }
    return 0;
  } finally {
    transport.close();
  }
}

function readLaunchEnvelope(): ControllerWorkerLaunchEnvelope {
  const encoded = process.env[STARTUP_ENV];
  if (encoded === undefined) throw new Error("Controller worker launch envelope is missing");
  const value = parseJson(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== CONTROLLER_WORKER_LAUNCH_SCHEMA
  ) {
    throw new Error("Controller worker launch envelope is invalid");
  }
  return value as unknown as ControllerWorkerLaunchEnvelope;
}

function validateResult(value: unknown): asserts value is ReconcileResult<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Controller reconcile result must be an object");
  }
  const result = value as { kind?: unknown; afterMs?: unknown };
  if (result.kind !== "settled" && result.kind !== "requeue") {
    throw new Error("Controller reconcile result kind is invalid");
  }
  if (
    result.afterMs !== undefined &&
    (!Number.isSafeInteger(result.afterMs) || (result.afterMs as number) < 0)
  ) {
    throw new Error("Controller reconcile afterMs must be a non-negative safe integer");
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Reconciliation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

function boundedError(error: unknown): string {
  const message = errorMessage(error);
  return message.length <= 8_192 ? message : `${message.slice(0, 8_192)}…`;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runControllerWorker();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
