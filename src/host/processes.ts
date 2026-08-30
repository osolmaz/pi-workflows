import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ProcessIdentity = {
  pid: number;
  startIdentity: string;
};

type ProcessRegistryFile = {
  schema: "pi-workflows.process-registry.v1";
  processes: ProcessIdentity[];
};

/**
 * Tracks supervised process groups by PID and operating-system start identity.
 * A later host kills a recorded process only when both values still match.
 */
export class HostProcessRegistry {
  private readonly filePath: string;
  private readonly processes = new Map<number, ProcessIdentity>();

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, "host.children.json");
  }

  register(pid: number): ProcessIdentity {
    const startIdentity = processStartIdentity(pid);
    if (startIdentity === undefined) {
      throw new Error(`Cannot attest supervised process start identity: ${pid}`);
    }
    const identity = { pid, startIdentity };
    this.processes.set(pid, identity);
    this.persist();
    return identity;
  }

  unregister(pid: number): void {
    this.processes.delete(pid);
    this.persist();
  }

  get size(): number {
    return this.processes.size;
  }

  /** Kill one exact registered process group and remove its durable record. */
  kill(pid: number): boolean {
    const identity = this.processes.get(pid);
    if (identity === undefined) return false;
    if (matchesProcessIdentity(identity)) {
      killProcessGroup(identity.pid, "SIGTERM");
      if (matchesProcessIdentity(identity)) killProcessGroup(identity.pid, "SIGKILL");
    }
    this.processes.delete(pid);
    this.persist();
    return true;
  }

  /** Kill every process that still has its registered start identity. */
  killAll(): void {
    for (const identity of this.processes.values()) {
      if (matchesProcessIdentity(identity)) killProcessGroup(identity.pid, "SIGTERM");
    }
    for (const identity of this.processes.values()) {
      if (matchesProcessIdentity(identity)) killProcessGroup(identity.pid, "SIGKILL");
    }
    this.processes.clear();
    this.persist();
  }

  /** Reap only exact stale process identities recorded by an older host. */
  reapOrphans(): number[] {
    const recorded = this.readFile();
    const reaped: number[] = [];
    const stillAlive: ProcessIdentity[] = [];
    for (const identity of recorded) {
      if (!matchesProcessIdentity(identity)) continue;
      killProcessGroup(identity.pid, "SIGKILL");
      reaped.push(identity.pid);
      if (matchesProcessIdentity(identity)) stillAlive.push(identity);
    }
    this.processes.clear();
    for (const identity of stillAlive) this.processes.set(identity.pid, identity);
    this.persist();
    return reaped;
  }

  private readFile(): ProcessIdentity[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!isRegistryFile(parsed)) return [];
      return parsed.processes;
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const file: ProcessRegistryFile = {
      schema: "pi-workflows.process-registry.v1",
      processes: [...this.processes.values()].sort((left, right) => left.pid - right.pid),
    };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

/** Return the operating-system parent PID for a live process. */
export function processParentPid(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const fields = linuxStatFields(pid);
      const parentPid = Number(fields[1]);
      return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const parentPid = Number(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`,
          ],
          { encoding: "utf8", timeout: 2_000, windowsHide: true },
        ).trim(),
      );
      return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const parentPid = Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim(),
    );
    return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
  } catch {
    return undefined;
  }
}

/** Return an operating-system process start value that fences PID reuse. */
export function processStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const startTicks = linuxStatFields(pid)[19];
      if (startTicks !== undefined) return `linux-proc-start:${startTicks}`;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const ticks = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", timeout: 2_000, windowsHide: true },
      ).trim();
      return ticks.length === 0 ? undefined : `windows-start-ticks:${ticks}`;
    } catch {
      return undefined;
    }
  }
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    return started.length === 0 ? undefined : `${process.platform}-ps-start:${started}`;
  } catch {
    return undefined;
  }
}

function linuxStatFields(pid: number): string[] {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error(`Linux process stat is invalid: ${pid}`);
  return stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
}

export function matchesProcessIdentity(identity: ProcessIdentity): boolean {
  return processStartIdentity(identity.pid) === identity.startIdentity;
}

function isRegistryFile(value: unknown): value is ProcessRegistryFile {
  if (!isRecord(value) || value.schema !== "pi-workflows.process-registry.v1") return false;
  if (!Array.isArray(value.processes)) return false;
  return value.processes.every(
    (entry) =>
      isRecord(entry) &&
      Number.isSafeInteger(entry.pid) &&
      (entry.pid as number) > 0 &&
      typeof entry.startIdentity === "string" &&
      entry.startIdentity.length > 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The exact process has already exited.
    }
  }
}
