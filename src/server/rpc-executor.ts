import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../workflows/errors.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import { RPC_SUBMISSION_PREFIX } from "./rpc-bridge.js";

// Production resolves the compiled .js; tests and dev checkouts load the .ts
// source, which pi compiles itself when loading extensions.
const BRIDGE_PATH = ["./rpc-bridge.js", "./rpc-bridge.ts"]
  .map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)))
  .find((candidate) => fs.existsSync(candidate));
const DEFAULT_ABORT_GRACE_MS = 3_000;

type StepSubmission = {
  action: "submit";
  step: string;
  attempt: string;
  output: unknown;
};

type StepUpdate = {
  action: "update";
  step: string;
  attempt: string;
  update: { type: string; key: string; data: Record<string, unknown> };
  idempotencyKey?: string;
};

type StepAction = StepSubmission | StepUpdate;

export interface SupervisedProcessRegistry {
  register(pid: number): unknown | Promise<unknown>;
  unregister(pid: number): unknown | Promise<unknown>;
}

export type RpcStepExecutorOptions = {
  cwd: string;
  registry?: SupervisedProcessRegistry;
  /** Start a separate process group, or inherit the caller's process group. */
  processGroup?: "own" | "inherit";
  /** Grace period before a process group receives SIGKILL. */
  abortGraceMs?: number;
  /** Absolute path to the pi binary; defaults to the installed `pi`. */
  piBin?: string;
  /** Extra environment for the child; the server's environment is inherited. */
  env?: Record<string, string>;
  /** Extra pi arguments, for example a model override. */
  piArgs?: string[];
  /** Park assistant-message nodes for a visible origin session. */
  assistantMessageMode?: "park";
};

/**
 * Runs agent steps in a headless `pi --mode rpc` child. One child serves one
 * workflow run. The rpc-bridge extension inside the child registers the
 * `workflow` tool and reports submissions over stderr; this executor
 * validates them through `request.accept` and re-prompts on rejection, so
 * the model sees the same tool contract as an in-session run.
 */
export class RpcStepExecutor implements AgentStepExecutor {
  readonly assistantMessageMode: "park" | "unsupported";
  private readonly options: RpcStepExecutorOptions;
  private child: ChildProcess | null = null;
  private childExited: { code: number | null; signal: string | null } | null = null;
  private stderrBuffer = "";
  private actions: StepAction[] = [];
  private submissionWaiters: Array<() => void> = [];
  private stdoutBuffer = "";
  private registeredPid: number | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: RpcStepExecutorOptions) {
    this.options = options;
    this.assistantMessageMode = options.assistantMessageMode ?? "unsupported";
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    await this.ensureStarted();
    let prompt = request.prompt;
    for (;;) {
      throwIfAborted(signal);
      const submission = await this.promptForSubmission(prompt, request, signal);
      const accepted = await request.accept(submission.output);
      if (accepted.ok) {
        return { output: accepted.value };
      }
      prompt = [
        `The workflow rejected your submission for step ${JSON.stringify(request.contract.nodeId)}:`,
        accepted.error,
        "",
        "Call the `workflow` tool again with a corrected output.",
      ].join("\n");
    }
  }

  /** Stop the child process tree, then unregister its exact group leader. */
  async close(): Promise<void> {
    this.closePromise ??= this.closeChild();
    await this.closePromise;
  }

  private async closeChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    const pid = child.pid;
    try {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be closed.
      }
      const ownGroup = this.options.processGroup !== "inherit";
      if (pid !== undefined && ownGroup) {
        killGroup(pid, "SIGTERM");
        const exited = await waitForGroupExit(
          pid,
          this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
        );
        if (!exited) killGroup(pid, "SIGKILL");
      } else if (this.childExited === null) {
        child.kill("SIGTERM");
        const exited = await waitForExit(
          child,
          this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
        );
        if (!exited) child.kill("SIGKILL");
      }
    } finally {
      await this.unregisterChild();
    }
  }

  private currentExit(): { code: number | null; signal: string | null } | null {
    return this.childExited;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closePromise !== null) throw new Error("Headless pi session is closed");
    if (this.child !== null) {
      const exited = this.currentExit();
      if (exited !== null) {
        throw new Error(
          `Headless pi session exited (code ${exited.code}, signal ${exited.signal})`,
        );
      }
      return;
    }
    if (BRIDGE_PATH === undefined) {
      throw new Error("The pi-workflows rpc-bridge extension is missing from this installation");
    }
    const piBin = this.options.piBin ?? "pi";
    const child = spawn(
      piBin,
      [
        "--mode",
        "rpc",
        "--no-session",
        // Isolation is required: an installed pi-workflows extension would
        // otherwise load beside the bridge, register a competing workflow
        // tool, and start its own resume and resource runners.
        "--no-extensions",
        "-e",
        BRIDGE_PATH,
        ...(this.options.piArgs ?? []),
      ],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.options.processGroup !== "inherit",
      },
    );
    this.child = child;
    child.on("exit", (code, signal) => {
      this.childExited = { code, signal };
      this.wakeSubmissionWaiters();
    });
    // A failed spawn (missing binary, EACCES) emits error instead of exit;
    // without a listener it would crash the server as an uncaught exception.
    child.on("error", (error) => {
      this.childExited = { code: null, signal: error.message };
      this.wakeSubmissionWaiters();
    });
    child.stdin?.on("error", () => {
      // Writes racing child exit surface asynchronously as EPIPE; the step
      // fails through the exit path instead of an uncaught stream error.
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      const lines = this.stderrBuffer.split("\n");
      this.stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(RPC_SUBMISSION_PREFIX)) {
          continue;
        }
        try {
          const parsed = JSON.parse(line.slice(RPC_SUBMISSION_PREFIX.length)) as StepAction;
          if (
            (parsed.action === "submit" || parsed.action === "update") &&
            typeof parsed.step === "string" &&
            typeof parsed.attempt === "string"
          ) {
            this.actions.push(parsed);
          }
        } catch {
          // A malformed marker line is ignored; the step times out instead.
        }
      }
      this.wakeSubmissionWaiters();
    });
    // stdout carries the RPC event stream. The submission channel is stderr,
    // so stdout is only drained to keep the pipe from blocking.
    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer = (this.stdoutBuffer + chunk.toString("utf8")).slice(-64 * 1024);
    });
    if (child.pid !== undefined && this.options.registry !== undefined) {
      try {
        await this.options.registry.register(child.pid);
        this.registeredPid = child.pid;
      } catch (error) {
        killGroup(child.pid, "SIGKILL");
        this.child = null;
        throw error;
      }
    }
  }

  private async unregisterChild(): Promise<void> {
    const pid = this.registeredPid;
    if (pid === null) return;
    this.registeredPid = null;
    await this.options.registry?.unregister(pid);
  }

  private async promptForSubmission(
    prompt: string,
    request: AgentStepRequest,
    signal: AbortSignal,
  ): Promise<StepSubmission> {
    const child = this.child;
    if (child === null || this.childExited !== null) {
      throw new Error("Headless pi session is not running");
    }
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    for (;;) {
      throwIfAborted(signal);
      const exited = this.currentExit();
      if (exited !== null) {
        throw new Error(`Headless pi session exited mid-step (code ${exited.code})`);
      }
      const found = this.takeMatchingAction(request);
      if (found?.action === "submit") return found;
      if (found?.action === "update") {
        if (request.publishUpdate === undefined) {
          throw new Error("This workflow server does not support step updates");
        }
        try {
          await request.publishUpdate(found.update, found.idempotencyKey);
        } catch (error) {
          child.stdin?.write(
            `${JSON.stringify({
              type: "prompt",
              message: `Workflow update rejected: ${errorMessage(error)}. Correct the update and continue the same step.`,
            })}\n`,
          );
        }
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.sendAbortQuietly();
          reject(signal.reason ?? new Error("Workflow step aborted"));
        };
        this.submissionWaiters.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private takeMatchingAction(request: AgentStepRequest): StepAction | undefined {
    const index = this.actions.findIndex(
      (candidate) =>
        candidate.step === request.contract.nodeId &&
        candidate.attempt === request.contract.attemptId,
    );
    return index === -1 ? undefined : (this.actions.splice(index, 1)[0] as StepAction);
  }

  private sendAbortQuietly(): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
    } catch {
      // Best-effort.
    }
  }

  private wakeSubmissionWaiters(): void {
    const waiters = this.submissionWaiters;
    this.submissionWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Group signals are unsupported here; the leader still needs it.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (signal.reason as unknown) ?? new Error("Workflow step aborted");
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
