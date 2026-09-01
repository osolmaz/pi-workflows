import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net, { type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { workflowStatePath } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  NdjsonFrameDecoder,
  clientSocketPath,
  encodeProtocolLine,
  parseClientMessage,
  type ClientEvent,
  type ClientHello,
  type ClientOperation,
  type ClientRequest,
  type ClientResponse,
} from "./protocol.js";
import type {
  ResolvedControllerInitialization,
  ResolvedSettingsChange,
  ResolvedWorkflowLaunch,
} from "./resolver.js";

const CONNECT_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 250;
const RESOLVER_TIMEOUT_MS = 30_000;
const CLIENT_PACKAGE_VERSION = runtimePackageVersion();

type PendingRequest = {
  resolve: (response: ClientResponse) => void;
  reject: (error: Error) => void;
};

type Subscription = {
  operation: "view.runs.watch" | "view.run.watch" | "view.session.watch";
  runId?: string;
  payload: JsonValue;
  listener: (event: ClientEvent) => void;
};

export class WorkflowClientVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowClientVersionError";
  }
}

export type WorkflowClientOptions = {
  clientId?: string;
  databasePath?: string;
  hostEntryPath?: string;
  env?: Record<string, string>;
};

export class WorkflowClient {
  readonly clientId: string;
  readonly databasePath: string;
  readonly endpoint: string;

  private readonly hostEntryPath: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private socket: Socket | null = null;
  private connectTask: Promise<ClientHello> | null = null;
  private hello: ClientHello | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(options: WorkflowClientOptions = {}) {
    this.clientId = options.clientId ?? `client-${randomUUID()}`;
    this.databasePath = options.databasePath ?? workflowStatePath();
    this.endpoint = clientSocketPath(this.databasePath);
    this.hostEntryPath = options.hostEntryPath;
    this.env = options.env;
  }

  get connectionId(): string | undefined {
    return this.hello?.connectionId;
  }

  get packageVersion(): string | undefined {
    return this.hello?.packageVersion;
  }

  async connect(): Promise<ClientHello> {
    if (this.closed) throw new Error("Workflow client is closed");
    if (this.hello !== null && this.socket !== null && !this.socket.destroyed) return this.hello;
    this.connectTask ??= this.openConnection();
    try {
      return await this.connectTask;
    } finally {
      this.connectTask = null;
    }
  }

  async request(options: {
    operation: ClientOperation;
    requestId?: string;
    idempotencyKey?: string;
    runId?: string;
    expectedRevision?: number;
    payload?: JsonValue;
  }): Promise<ClientResponse> {
    await this.connect();
    return await this.requestConnected(options);
  }

  async watchRuns(
    listener: (event: ClientEvent) => void,
    options: { subscriptionId?: string; limit?: number } = {},
  ): Promise<() => Promise<void>> {
    return await this.subscribe(
      "view.runs.watch",
      undefined,
      {
        subscriptionId: options.subscriptionId ?? randomUUID(),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
      listener,
    );
  }

  async watchRun(
    runId: string,
    listener: (event: ClientEvent) => void,
    options: { subscriptionId?: string; revision?: number } = {},
  ): Promise<() => Promise<void>> {
    return await this.subscribe(
      "view.run.watch",
      runId,
      {
        subscriptionId: options.subscriptionId ?? randomUUID(),
        ...(options.revision === undefined ? {} : { revision: options.revision }),
      },
      listener,
    );
  }

  async watchSession(
    sessionId: string,
    listener: (event: ClientEvent) => void,
    options: { subscriptionId?: string } = {},
  ): Promise<() => Promise<void>> {
    return await this.subscribe(
      "view.session.watch",
      undefined,
      { subscriptionId: options.subscriptionId ?? randomUUID(), sessionId },
      listener,
    );
  }

  async ensureRunning(): Promise<ClientResponse> {
    try {
      return await this.request({ operation: "host.status" });
    } catch (error) {
      if (error instanceof WorkflowClientVersionError) throw error;
      this.resetConnection();
      this.startDetached();
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await delay(50);
      try {
        return await this.request({ operation: "host.status" });
      } catch (error) {
        lastError = error;
        this.resetConnection();
      }
    }
    throw new Error(
      `Workflow host did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async resolveWorkflow(options: {
    cwd: string;
    workflowRef: string;
    timeoutMs?: number;
  }): Promise<ResolvedWorkflowLaunch> {
    return (await this.runResolver(
      {
        schema: "pi-workflows.resolve-request.v1",
        cwd: options.cwd,
        workflowRef: options.workflowRef,
      },
      options.cwd,
      "pi-workflows.resolved-launch.v1",
      options.timeoutMs,
    )) as unknown as ResolvedWorkflowLaunch;
  }

  async resolveControllerInitialization(options: {
    cwd: string;
    controllerName: string;
    spec: JsonValue;
    timeoutMs?: number;
  }): Promise<ResolvedControllerInitialization> {
    return (await this.runResolver(
      {
        schema: "pi-workflows.controller-initialization-request.v1",
        cwd: options.cwd,
        controllerName: options.controllerName,
        spec: options.spec,
      },
      options.cwd,
      "pi-workflows.resolved-controller-initialization.v1",
      options.timeoutMs,
    )) as unknown as ResolvedControllerInitialization;
  }

  async resolveSettingsChange(options: {
    cwd: string;
    workflowRef: string;
    definitionDigest: string;
    mountPath: string;
    current: JsonValue;
    patch: JsonValue;
    actorId: string;
    timeoutMs?: number;
  }): Promise<ResolvedSettingsChange> {
    return (await this.runResolver(
      {
        schema: "pi-workflows.settings-validation-request.v1",
        cwd: options.cwd,
        workflowRef: options.workflowRef,
        definitionDigest: options.definitionDigest,
        mountPath: options.mountPath,
        current: options.current,
        patch: options.patch,
        actorId: options.actorId,
      },
      options.cwd,
      "pi-workflows.resolved-settings-change.v1",
      options.timeoutMs,
    )) as unknown as ResolvedSettingsChange;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.subscriptions.clear();
    const socket = this.socket;
    this.resetConnection(new Error("Workflow client closed"));
    if (socket !== null && !socket.destroyed) {
      socket.end();
      await Promise.race([once(socket, "close").then(() => undefined), delay(250)]);
      socket.destroy();
    }
  }

  private async subscribe(
    operation: Subscription["operation"],
    runId: string | undefined,
    payload: JsonValue,
    listener: (event: ClientEvent) => void,
  ): Promise<() => Promise<void>> {
    if (!isRecord(payload) || typeof payload.subscriptionId !== "string") {
      throw new Error("Workflow subscription requires a subscriptionId");
    }
    const subscriptionId = payload.subscriptionId;
    await this.connect();
    this.subscriptions.set(subscriptionId, {
      operation,
      ...(runId === undefined ? {} : { runId }),
      payload,
      listener,
    });
    try {
      const response = await this.requestConnected({
        operation,
        ...(runId === undefined ? {} : { runId }),
        payload,
      });
      if (response.outcome !== "accepted" && response.outcome !== "adopted") {
        throw new Error(response.error ?? `Workflow subscription was ${response.outcome}`);
      }
    } catch (error) {
      this.subscriptions.delete(subscriptionId);
      throw error;
    }
    return async () => {
      if (!this.subscriptions.delete(subscriptionId)) return;
      if (operation === "view.run.watch" && this.socket !== null && !this.socket.destroyed) {
        await this.request({
          operation: "view.run.unwatch",
          ...(runId === undefined ? {} : { runId }),
          payload: { subscriptionId },
        });
      }
    };
  }

  private async requestConnected(options: {
    operation: ClientOperation;
    requestId?: string;
    idempotencyKey?: string;
    runId?: string;
    expectedRevision?: number;
    payload?: JsonValue;
  }): Promise<ClientResponse> {
    const request: ClientRequest = {
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "request",
      requestId: options.requestId ?? randomUUID(),
      clientId: this.clientId,
      operation: options.operation,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      payload: options.payload ?? {},
    };
    return await this.send(request);
  }

  private async send(request: ClientRequest): Promise<ClientResponse> {
    const socket = this.socket;
    if (socket === null || socket.destroyed) throw new Error("Workflow host is unavailable");
    if (this.pending.has(request.requestId)) {
      throw new Error(`Workflow request is already pending: ${request.requestId}`);
    }
    const response = new Promise<ClientResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
    });
    try {
      if (!socket.write(encodeProtocolLine(request))) await once(socket, "drain");
    } catch (error) {
      this.pending.delete(request.requestId);
      throw error;
    }
    return await response;
  }

  private async openConnection(): Promise<ClientHello> {
    const socket = net.createConnection(this.endpoint);
    const decoder = new NdjsonFrameDecoder();
    this.socket = socket;
    let helloResolve!: (hello: ClientHello) => void;
    let helloReject!: (error: Error) => void;
    const helloPromise = new Promise<ClientHello>((resolve, reject) => {
      helloResolve = resolve;
      helloReject = reject;
    });
    let receivedHello = false;

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (!receivedHello) {
            if (message.type !== "hello") throw new Error("Workflow host did not send hello first");
            if (message.packageVersion !== CLIENT_PACKAGE_VERSION) {
              throw new WorkflowClientVersionError(
                `Workflow client version mismatch: host ${message.packageVersion}, client ${CLIENT_PACKAGE_VERSION}. Install matching pi-workflows and piw packages.`,
              );
            }
            receivedHello = true;
            this.hello = message;
            helloResolve(message);
            continue;
          }
          if (message.type === "response") {
            const pending = this.pending.get(message.requestId);
            if (pending === undefined) continue;
            this.pending.delete(message.requestId);
            pending.resolve(message);
          } else if (message.type === "event") {
            const subscription = this.subscriptions.get(message.subscriptionId);
            if (
              subscription !== undefined &&
              subscription.operation === "view.run.watch" &&
              isRecord(subscription.payload) &&
              isRecord(message.payload) &&
              Number.isSafeInteger(message.payload.revision)
            ) {
              subscription.payload = {
                ...subscription.payload,
                revision: message.payload.revision as number,
              };
            }
            subscription?.listener(message);
          } else {
            throw new Error(`Unexpected workflow client message: ${message.type}`);
          }
        }
      } catch (error) {
        helloReject(toError(error));
        socket.destroy();
      }
    });
    socket.once("error", (error) => {
      helloReject(error);
    });
    socket.once("close", () => {
      if (!receivedHello) helloReject(new Error("Workflow host closed before hello"));
      if (this.socket === socket) {
        this.resetConnection(new Error("Workflow host connection closed"));
        this.scheduleReconnect();
      }
    });

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(socket, "connect"),
        helloPromise.then(() => undefined),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error("Workflow host connection timed out")),
            CONNECT_TIMEOUT_MS,
          );
          connectTimer.unref?.();
        }),
      ]);
      const hello = await Promise.race([
        helloPromise,
        delay(CONNECT_TIMEOUT_MS).then(() => {
          throw new Error("Workflow host hello timed out");
        }),
      ]);
      await this.restoreSubscriptions();
      return hello;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    }
  }

  private async restoreSubscriptions(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      const response = await this.requestConnected({
        operation: subscription.operation,
        ...(subscription.runId === undefined ? {} : { runId: subscription.runId }),
        payload: subscription.payload,
      });
      if (response.outcome !== "accepted" && response.outcome !== "adopted") {
        throw new Error(response.error ?? `Workflow subscription was ${response.outcome}`);
      }
    }
  }

  private resetConnection(reason = new Error("Workflow host is unavailable")): void {
    const socket = this.socket;
    this.socket = null;
    this.hello = null;
    this.connectTask = null;
    if (socket !== null && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    if (!this.closed) {
      for (const [subscriptionId, subscription] of this.subscriptions) {
        try {
          subscription.listener({
            schema: CLIENT_PROTOCOL_SCHEMA,
            type: "event",
            subscriptionId,
            event: "unavailable",
            payload: { message: "Workflow host connection is unavailable." },
          });
        } catch {
          // One renderer cannot block reconnection for other subscriptions.
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subscriptions.size === 0 || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private async runResolver(
    request: JsonValue,
    cwd: string,
    expectedSchema: string,
    timeoutMs = RESOLVER_TIMEOUT_MS,
  ): Promise<JsonValue> {
    const builtEntry = fileURLToPath(new URL("../host/resolver-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("../host/resolver-entry.ts", import.meta.url));
    const args = fs.existsSync(builtEntry)
      ? [builtEntry]
      : ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry];
    const child = spawn(process.execPath, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputError: Error | undefined;
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > 1024 * 1024) {
        outputError = new Error("Workflow resolver output exceeds 1 MiB");
        stopProcessGroup(child.pid);
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.stdin.end(canonicalJson(request));
    const timeout = setTimeout(() => stopProcessGroup(child.pid), timeoutMs);
    timeout.unref?.();
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    if (outputError !== undefined) throw outputError;
    if (code !== 0) {
      const detail = stderr.toString("utf8").trim().slice(0, 2_000);
      throw new Error(
        detail || `Workflow resolver exited before completion (code ${code}, signal ${signal})`,
      );
    }
    const value = parseJson(stdout.toString("utf8").trimEnd());
    if (!isRecord(value) || value.schema !== expectedSchema) {
      throw new Error("Workflow resolver returned an invalid result envelope");
    }
    return value as JsonValue;
  }

  private startDetached(): void {
    const builtEntry = fileURLToPath(new URL("../host/host-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("../host/host-entry.ts", import.meta.url));
    const entry = this.hostEntryPath ?? builtEntry;
    const args =
      this.hostEntryPath === undefined && !fs.existsSync(builtEntry)
        ? ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry]
        : [entry];
    const child = spawn(process.execPath, [...args, "--database", this.databasePath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...this.env },
    });
    child.unref();
  }
}

function runtimePackageVersion(): string {
  const parsed = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("Pi Workflows package version is missing");
  }
  return parsed.version;
}

function stopProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    // The resolver has already exited.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
