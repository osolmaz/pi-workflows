import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { workflowStatePath } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  encodeProtocolLine,
  hostSocketPath,
  NdjsonFrameDecoder,
  parseHostResponse,
  type HostOperation,
  type HostRequest,
  type HostResponse,
} from "./protocol.js";
import type { ResolvedSettingsChange, ResolvedWorkflowLaunch } from "./resolver-entry.js";

const CONNECT_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 10_000;

export class WorkflowHostClient {
  readonly clientId: string;
  readonly databasePath: string;
  readonly endpoint: string;

  constructor(
    options: {
      clientId?: string;
      databasePath?: string;
      hostEntryPath?: string;
      env?: Record<string, string>;
    } = {},
  ) {
    this.clientId = options.clientId ?? `client-${randomUUID()}`;
    this.databasePath = options.databasePath ?? workflowStatePath();
    this.endpoint = hostSocketPath(this.databasePath);
    this.hostEntryPath = options.hostEntryPath;
    this.env = options.env;
  }

  private readonly hostEntryPath: string | undefined;
  private readonly env: Record<string, string> | undefined;

  async request(options: {
    operation: HostOperation;
    requestId?: string;
    idempotencyKey?: string;
    runId?: string;
    expectedRevision?: number;
    payload?: JsonValue;
  }): Promise<HostResponse> {
    const request: HostRequest = {
      schema: "pi-workflows.host-request.v1",
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
    return await sendRequest(this.endpoint, request);
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

  private async runResolver(
    request: JsonValue,
    cwd: string,
    expectedSchema: string,
    timeoutMs = START_TIMEOUT_MS,
  ): Promise<JsonValue> {
    const builtEntry = fileURLToPath(new URL("./resolver-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./resolver-entry.ts", import.meta.url));
    const args = fs.existsSync(builtEntry)
      ? [builtEntry]
      : ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry];
    const child = spawn(process.execPath, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
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

  async ensureRunning(): Promise<HostResponse> {
    try {
      return await this.request({
        operation: "host.status",
        requestId: `host-status-${randomUUID()}`,
        idempotencyKey: `host-status-${randomUUID()}`,
      });
    } catch {
      this.startDetached();
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        return await this.request({
          operation: "host.status",
          requestId: `host-status-${randomUUID()}`,
          idempotencyKey: `host-status-${randomUUID()}`,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Workflow host did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private startDetached(): void {
    const builtEntry = fileURLToPath(new URL("./host-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./host-entry.ts", import.meta.url));
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

function stopProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    // The resolver has already exited.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sendRequest(endpoint: string, request: HostRequest): Promise<HostResponse> {
  const socket = net.createConnection(endpoint);
  const decoder = new NdjsonFrameDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(socket, "connect"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Workflow host connection timed out")),
          CONNECT_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
      once(socket, "error").then(([error]) => Promise.reject(error)),
    ]);
    if (!socket.write(encodeProtocolLine(request))) await once(socket, "drain");
    const response = await new Promise<HostResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Workflow host response timed out")),
        CONNECT_TIMEOUT_MS,
      );
      timeout.unref?.();
      socket.on("data", (chunk: Buffer) => {
        try {
          const frame = decoder.push(chunk)[0];
          if (frame === undefined) return;
          clearTimeout(timeout);
          resolve(parseHostResponse(frame));
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Workflow host closed before responding")));
    });
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.destroy();
  }
}
