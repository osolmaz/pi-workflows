import { spawn } from "node:child_process";
import { CancelledError, TimeoutError } from "./errors.js";
import type { ShellActionExecution, ShellActionResult } from "./types.js";

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
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
  const child = spawn(spec.command, args, {
    cwd,
    env: { ...process.env, ...spec.env },
    shell: spec.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let killedBy: "timeout" | "abort" | null = null;
  let timeout: NodeJS.Timeout | undefined;

  const kill = (reason: "timeout" | "abort") => {
    killedBy ??= reason;
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
    }, 1_000).unref();
  };
  const onAbort = () => kill("abort");

  const finish = new Promise<ShellActionResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
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
        reject(error);
        return;
      }
      resolve(result);
    });
  });

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
    signal?.removeEventListener("abort", onAbort);
  }
}
