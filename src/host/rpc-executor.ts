import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RPC_SUBMISSION_PREFIX } from "../extension/rpc-bridge.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";
import type { HostProcessRegistry } from "./processes.js";

const BRIDGE_PATH = fileURLToPath(new URL("../extension/rpc-bridge.js", import.meta.url));
const ABORT_GRACE_MS = 3_000;

type StepSubmission = {
  step: string;
  attempt: string;
  output: unknown;
};

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
  private submissions: StepSubmission[] = [];
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

  /** Stop the child process group. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) {
      return;
    }
    if (this.childExited === null) {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be closed.
      }
      child.kill("SIGTERM");
      const exited = await waitForExit(child, ABORT_GRACE_MS);
      if (!exited) {
        child.kill("SIGKILL");
      }
    }
    if (child.pid !== undefined) {
      this.options.registry.unregister(child.pid);
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
    const piBin = this.options.piBin ?? "pi";
    const child = spawn(
      piBin,
      ["--mode", "rpc", "--no-session", "-e", BRIDGE_PATH, ...(this.options.piArgs ?? [])],
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
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      const lines = this.stderrBuffer.split("\n");
      this.stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(RPC_SUBMISSION_PREFIX)) {
          continue;
        }
        try {
          const parsed = JSON.parse(line.slice(RPC_SUBMISSION_PREFIX.length)) as StepSubmission;
          if (typeof parsed.step === "string" && typeof parsed.attempt === "string") {
            this.submissions.push(parsed);
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
    const matching = this.takeMatchingSubmission(request);
    if (matching !== undefined) {
      return matching;
    }
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    for (;;) {
      throwIfAborted(signal);
      const exited = this.currentExit();
      if (exited !== null) {
        throw new Error(`Headless pi session exited mid-step (code ${exited.code})`);
      }
      const found = this.takeMatchingSubmission(request);
      if (found !== undefined) {
        return found;
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

  private takeMatchingSubmission(request: AgentStepRequest): StepSubmission | undefined {
    const index = this.submissions.findIndex(
      (candidate) =>
        candidate.step === request.contract.nodeId &&
        candidate.attempt === request.contract.attemptId,
    );
    return index === -1 ? undefined : (this.submissions.splice(index, 1)[0] as StepSubmission);
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
