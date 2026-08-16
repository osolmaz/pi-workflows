import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../workflows/errors.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import type { HostProcessRegistry } from "./processes.js";
import { RPC_SUBMISSION_PREFIX } from "./rpc-bridge.js";

// Production resolves the compiled .js; tests and dev checkouts load the .ts
// source, which pi compiles itself when loading extensions.
const BRIDGE_PATH = ["./rpc-bridge.js", "./rpc-bridge.ts"]
  .map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)))
  .find((candidate) => fs.existsSync(candidate));
const ABORT_GRACE_MS = 3_000;

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

export type RpcStepExecutorOptions = {
  cwd: string;
  registry: HostProcessRegistry;
  /** Absolute path to the pi binary; defaults to the installed `pi`. */
  piBin?: string;
  /** Extra environment for the child; the host's environment is inherited. */
  env?: Record<string, string>;
  /** Extra pi arguments, for example a model override. */
  piArgs?: string[];
};

/**
 * Runs agent steps in a headless `pi --mode rpc` child. One child serves one
 * workflow run. The rpc-bridge extension inside the child registers the
 * `workflow` tool and reports submissions over stderr; this executor
 * validates them through `request.accept` and re-prompts on rejection, so
 * the model sees the same tool contract as an in-session run.
 */
export class RpcStepExecutor implements AgentStepExecutor {
  private readonly options: RpcStepExecutorOptions;
  private child: ChildProcess | null = null;
  private childExited: { code: number | null; signal: string | null } | null = null;
  private stderrBuffer = "";
  private actions: StepAction[] = [];
  private submissionWaiters: Array<() => void> = [];
  private stdoutBuffer = "";

  constructor(options: RpcStepExecutorOptions) {
    this.options = options;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    this.ensureStarted();
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

  /** Stop the child's whole process group, then unregister it. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) {
      return;
    }
    const pid = child.pid;
    if (this.childExited === null) {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be closed.
      }
      // The child spawns in its own group; tool calls can leave
      // grandchildren that leader-only signals would orphan forever.
      if (pid !== undefined) {
        killGroup(pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
      const exited = await waitForExit(child, ABORT_GRACE_MS);
      if (!exited) {
        if (pid !== undefined) {
          killGroup(pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      }
    }
    if (pid !== undefined) {
      this.options.registry.unregister(pid);
    }
  }

  private currentExit(): { code: number | null; signal: string | null } | null {
    return this.childExited;
  }

  private ensureStarted(): void {
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
        // tool, and start its own resume and controller workers.
        "--no-extensions",
        "-e",
        BRIDGE_PATH,
        ...(this.options.piArgs ?? []),
      ],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group: the host kills groups, never individual PIDs,
        // so a killed host cannot leave an orphaned agent working.
        detached: true,
      },
    );
    this.child = child;
    if (child.pid !== undefined) {
      this.options.registry.register(child.pid);
    }
    child.on("exit", (code, signal) => {
      this.childExited = { code, signal };
      if (child.pid !== undefined) {
        this.options.registry.unregister(child.pid);
      }
      this.wakeSubmissionWaiters();
    });
    // A failed spawn (missing binary, EACCES) emits error instead of exit;
    // without a listener it would crash the host as an uncaught exception.
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
          throw new Error("This workflow host does not support step updates");
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
