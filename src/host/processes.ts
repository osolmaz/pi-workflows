import fs from "node:fs";
import path from "node:path";

/**
 * Tracks headless child processes (spawned `pi --mode rpc` sessions) so a
 * killed host never leaves orphans working. Children spawn in their own
 * process group; the registry file lets a later host reap leftovers by
 * killing the whole group. The file lives next to the project store and is
 * only ever touched by one host at a time (the advisory lock ensures it).
 */
export class HostProcessRegistry {
  private readonly filePath: string;
  private readonly pids = new Set<number>();

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, "host.children.json");
  }

  register(pid: number): void {
    this.pids.add(pid);
    this.persist();
  }

  unregister(pid: number): void {
    this.pids.delete(pid);
    this.persist();
  }

  get size(): number {
    return this.pids.size;
  }

  /** Kill every registered child's process group, escalating to SIGKILL. */
  killAll(): void {
    for (const pid of this.pids) {
      killProcessGroup(pid, "SIGTERM");
    }
    for (const pid of this.pids) {
      killProcessGroup(pid, "SIGKILL");
    }
    this.pids.clear();
    this.persist();
  }

  /**
   * Reap children recorded by a previous host that died without cleanup.
   * Called once at host start, before the lock is taken.
   */
  reapOrphans(): number[] {
    const recorded = this.readFile();
    const reaped: number[] = [];
    for (const pid of recorded) {
      if (isAlive(pid)) {
        killProcessGroup(pid, "SIGKILL");
        reaped.push(pid);
      }
    }
    this.persist();
    return reaped;
  }

  private readFile(): number[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        this.filePath,
        `${JSON.stringify([...this.pids, ...this.readFile().filter((pid) => !this.pids.has(pid))])}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    } catch {
      // Registry bookkeeping is best-effort; orphan reaping is the backstop.
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
