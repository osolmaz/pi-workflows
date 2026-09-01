import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { NdjsonFrameDecoder } from "../client/protocol.js";
import { errorMessage } from "../workflows/errors.js";
import { HostProcessRegistry, type ProcessIdentity } from "./processes.js";
import type { WorkerOutcome } from "./state.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export type SupervisedWorkerResult = {
  outcome: WorkerOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic?: string;
};

type ChildWorkerSupervisorOptions<Message, Response> = {
  label: string;
  registry: HostProcessRegistry;
  onMessage: (message: Message) => Promise<Response>;
  parseMessage: (frame: Buffer) => Message;
  encodeResponse: (response: Response) => Buffer;
  isReady: (message: Message) => boolean;
  isTerminal: (message: Message) => boolean;
  startupTimeoutMs?: number;
  onSpawn?: (identity: ProcessIdentity) => void;
  onDiagnostic?: (message: string) => void;
};

type ChildWorkerStartOptions = {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Shared supervision, framing, diagnostics, and process-group shutdown for host workers. */
export class ChildWorkerSupervisor<Message, Response> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private identity: ProcessIdentity | null = null;
  private readonly decoder = new NdjsonFrameDecoder();
  private diagnostic = Buffer.alloc(0);
  private terminalMessage = false;
  private stopping: WorkerOutcome | null = null;
  private processing = Promise.resolve();
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private exitResolve: ((result: SupervisedWorkerResult) => void) | undefined;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private readonly exitPromise = new Promise<SupervisedWorkerResult>((resolve) => {
    this.exitResolve = resolve;
  });

  constructor(private readonly options: ChildWorkerSupervisorOptions<Message, Response>) {}

  async start(options: ChildWorkerStartOptions): Promise<void> {
    if (this.child !== null) throw new Error(`${this.options.label} already started`);
    const child = spawn(process.execPath, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid === undefined) throw new Error(`${this.options.label} did not receive a PID`);
    this.identity = this.options.registry.register(child.pid);
    this.options.onSpawn?.(this.identity);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.on("error", (error) => this.readyReject?.(error));
    child.on("exit", (code, signal) => this.onExit(code, signal));

    const timeout = setTimeout(() => {
      this.readyReject?.(new Error(`${this.options.label} startup timed out`));
      void this.stop("timedOut");
    }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  async wait(): Promise<SupervisedWorkerResult> {
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
          const message = this.options.parseMessage(frame);
          if (this.options.isTerminal(message)) this.terminalMessage = true;
          const response = await this.options.onMessage(message);
          if (this.child?.stdin.destroyed !== false) return;
          if (!this.child.stdin.write(this.options.encodeResponse(response))) {
            await once(this.child.stdin, "drain");
          }
          if (this.options.isReady(message)) this.readyResolve?.();
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
    const result: SupervisedWorkerResult = {
      outcome,
      exitCode: code,
      signal,
      ...(diagnostic.length === 0 ? {} : { diagnostic }),
    };
    if (outcome !== "exited") {
      this.readyReject?.(
        new Error(diagnostic || `${this.options.label} exited with code ${String(code)}`),
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
