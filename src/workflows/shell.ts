import { spawn } from "node:child_process";
import { CancelledError, TimeoutError } from "./errors.js";
import type { ShellActionExecution, ShellActionResult } from "./types.js";

/** Default cap on captured stdout/stderr, each. */
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n…[output truncated]";

const SHELL_RESULT = Symbol.for("pi-workflows.shell-result");

/**
 * Retrieve the shell result attached to an error thrown by
 * {@link runShellAction}, so callers can persist the action receipt even when
 * the command failed.
 */
export function shellResultFromError(error: unknown): ShellActionResult | null {
  if (error instanceof Error) {
    const attached = (error as Error & { [SHELL_RESULT]?: ShellActionResult })[SHELL_RESULT];
    return attached ?? null;
  }
  return null;
}

export function renderShellCommand(command: string, args: string[]): string {
  const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function shellFailure(
  spec: ShellActionExecution,
  args: string[],
  result: ShellActionResult,
  killedBy: "timeout" | "abort" | null,
): Error | undefined {
  if (killedBy === "timeout") {
    return new TimeoutError(spec.timeoutMs ?? 0);
  }
  if (killedBy === "abort") {
    return new CancelledError();
  }
  if (((result.exitCode ?? 0) !== 0 || result.signal != null) && spec.allowNonZeroExit !== true) {
    const status = result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`;
    const details = result.stderr.length > 0 ? `\n${result.stderr.trim()}` : "";
    return new Error(
      `Shell action failed (${renderShellCommand(spec.command, args)}): ${status}${details}`,
    );
  }
  return undefined;
}

export async function runShellAction(
  spec: ShellActionExecution,
  signal?: AbortSignal,
): Promise<ShellActionResult> {
  // The node may have been cancelled while an async `exec` callback resolved;
  // never start side effects for an already-abandoned attempt.
  if (signal?.aborted) {
    throw new CancelledError();
  }
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
  // POSIX: run in its own process group so timeout/abort can kill the whole
  // tree, including descendants that inherited the stdio pipes.
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(spec.command, args, {
    cwd,
    env: { ...process.env, ...spec.env },
    shell: spec.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: useProcessGroup,
  });

  let stdout = "";
  let stderr = "";
  let killedBy: "timeout" | "abort" | null = null;
  let timeout: NodeJS.Timeout | undefined;

  // Cap retained output so a verbose or unending command cannot exhaust
  // memory before its timeout fires.
  const maxOutputChars = spec.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const appendCapped = (current: string, chunk: string): string => {
    if (current.endsWith(TRUNCATION_MARKER)) {
      return current;
    }
    const room = maxOutputChars - current.length;
    if (chunk.length <= room) {
      return current + chunk;
    }
    return current + chunk.slice(0, Math.max(0, room)) + TRUNCATION_MARKER;
  };

  const signalTree = (killSignal: NodeJS.Signals) => {
    if (useProcessGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, killSignal);
        return;
      } catch {
        // Group already gone; fall back to the direct child.
      }
    }
    child.kill(killSignal);
  };

  let killEscalation: NodeJS.Timeout | undefined;
  const kill = (reason: "timeout" | "abort") => {
    killedBy ??= reason;
    signalTree("SIGTERM");
    killEscalation ??= setTimeout(() => {
      signalTree("SIGKILL");
    }, 1_000);
    killEscalation.unref();
  };
  const onAbort = () => kill("abort");

  const finish = new Promise<ShellActionResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.once("error", (error) => {
      // Spawn failures (missing executable, EACCES) still get a receipt so
      // failed actions remain auditable.
      const result: ShellActionResult = {
        command: spec.command,
        args,
        cwd,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startMs,
      };
      (error as Error & { [SHELL_RESULT]?: ShellActionResult })[SHELL_RESULT] = result;
      reject(error);
    });
    // `close` (unlike `exit`) fires only after stdio has fully closed, so
    // captured output is never truncated.
    child.once("close", (exitCode, signalName) => {
      const result: ShellActionResult = {
        command: spec.command,
        args,
        cwd,
        stdout,
        stderr,
        exitCode,
        signal: signalName,
        durationMs: Date.now() - startMs,
      };
      const error = shellFailure(spec, args, result, killedBy);
      if (error) {
        // Attach the result so callers can persist the action receipt.
        (error as Error & { [SHELL_RESULT]?: ShellActionResult })[SHELL_RESULT] = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });

  // A child that exits without consuming stdin emits EPIPE; without a
  // listener that would crash the whole process instead of just this action.
  child.stdin.on("error", () => {});
  if (spec.stdin != null) {
    child.stdin.write(spec.stdin);
  }
  child.stdin.end();

  if (spec.timeoutMs != null && spec.timeoutMs > 0) {
    timeout = setTimeout(() => kill("timeout"), spec.timeoutMs);
  }
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    return await finish;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (killEscalation) {
      // The group pid may be reused after the child exits; never let the
      // delayed SIGKILL fire once the command has fully closed.
      clearTimeout(killEscalation);
    }
    signal?.removeEventListener("abort", onAbort);
  }
}
