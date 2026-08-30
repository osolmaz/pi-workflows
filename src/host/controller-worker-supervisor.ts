import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../state/json.js";
import { errorMessage } from "../workflows/errors.js";
import {
  encodeControllerWorkerLine,
  parseControllerWorkerMessage,
  type ControllerWorkerLaunchEnvelope,
  type ControllerWorkerMessage,
  type ControllerWorkerResponse,
} from "./controller-worker-protocol.js";
import { HostProcessRegistry, type ProcessIdentity } from "./processes.js";
import { NdjsonFrameDecoder } from "./protocol.js";
import type { WorkerOutcome } from "./state.js";
import type { WorkflowWorkerResult } from "./worker-supervisor.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export class ControllerWorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private identity: ProcessIdentity | null = null;
  private readonly decoder = new NdjsonFrameDecoder();
  private diagnostic = Buffer.alloc(0);
  private terminalMessage = false;
  private stopping: WorkerOutcome | null = null;
  private processing = Promise.resolve();
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private exitResolve: ((result: WorkflowWorkerResult) => void) | undefined;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private readonly exitPromise = new Promise<WorkflowWorkerResult>((resolve) => {
    this.exitResolve = resolve;
  });

  constructor(
    readonly envelope: ControllerWorkerLaunchEnvelope,
    private readonly options: {
      registry: HostProcessRegistry;
      onMessage: (message: ControllerWorkerMessage) => Promise<ControllerWorkerResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      workerEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.child !== null) throw new Error("Controller worker already started");
    const builtEntry = fileURLToPath(new URL("./controller-worker-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./controller-worker-entry.ts", import.meta.url));
    const workerEntry = this.options.workerEntryPath ?? builtEntry;
    const args =
      this.options.workerEntryPath === undefined && !fs.existsSync(builtEntry)
        ? ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry]
        : [workerEntry];
    const child = spawn(process.execPath, args, {
      cwd: this.envelope.projectPath,
      env: {
        ...process.env,
        ...this.options.env,
        PI_WORKFLOWS_CONTROLLER_WORKER_LAUNCH: Buffer.from(
          canonicalJson(this.envelope as unknown as import("../state/json.js").JsonValue),
        ).toString("base64url"),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid === undefined) throw new Error("Controller worker did not receive a PID");
    this.identity = this.options.registry.register(child.pid);
    this.options.onSpawn?.(this.identity);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.on("error", (error) => this.readyReject?.(error));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    const timeout = setTimeout(() => {
      this.readyReject?.(new Error("Controller worker startup timed out"));
      void this.stop("timedOut");
    }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  async wait(): Promise<WorkflowWorkerResult> {
    return await this.exitPromise;
  }

  async stop(outcome: WorkerOutcome = "cancelled"): Promise<void> {
    if (this.child === null) {
      this.exitResolve?.({ outcome, exitCode: null, signal: null });
      return;
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stopping = outcome;
    signalProcess(this.child.pid, "SIGTERM");
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), DEFAULT_KILL_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (!exited) signalProcess(this.child.pid, "SIGKILL");
  }

  private onStdout(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.appendDiagnostic(errorMessage(error));
      void this.stop("crashed");
      return;
    }
    for (const frame of frames) {
      this.processing = this.processing
        .then(async () => {
          const message = parseControllerWorkerMessage(frame);
          if (message.operation === "worker.finished" || message.operation === "worker.failed") {
            this.terminalMessage = true;
          }
          const response = await this.options.onMessage(message);
          if (this.child?.stdin.destroyed !== false) return;
          if (!this.child.stdin.write(encodeControllerWorkerLine(response))) {
            await once(this.child.stdin, "drain");
          }
          if (message.operation === "worker.ready") this.readyResolve?.();
        })
        .catch((error: unknown) => {
          this.appendDiagnostic(errorMessage(error));
          void this.stop("crashed");
        });
    }
  }

  private onStderr(chunk: Buffer): void {
    this.options.onDiagnostic?.(chunk.toString("utf8").trimEnd());
    if (this.diagnostic.byteLength >= MAX_DIAGNOSTIC_BYTES) return;
    this.diagnostic = Buffer.concat([
      this.diagnostic,
      chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - this.diagnostic.byteLength),
    ]);
  }

  private appendDiagnostic(message: string): void {
    this.onStderr(Buffer.from(`${message}\n`, "utf8"));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.identity !== null) this.options.registry.unregister(this.identity.pid);
    const outcome =
      this.stopping ?? (code === 0 && this.terminalMessage ? "exited" : ("crashed" as const));
    const diagnostic = this.diagnostic.toString("utf8").trim();
    const result: WorkflowWorkerResult = {
      outcome,
      exitCode: code,
      signal,
      ...(diagnostic.length === 0 ? {} : { diagnostic }),
    };
    if (outcome !== "exited") {
      this.readyReject?.(
        new Error(diagnostic || `Controller worker exited with code ${String(code)}`),
      );
    }
    this.exitResolve?.(result);
  }
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process has already exited.
    }
  }
}
