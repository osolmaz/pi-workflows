import fs from "node:fs";
import path from "node:path";
import { killProcessGroup, matchesProcessIdentity, type ProcessIdentity } from "./processes.js";

export const SERVER_LOCK_SCHEMA = "pi-workflows.server-lock.v1" as const;

/** Grace between the graceful stop request and the forced stop. */
export const SERVER_STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 50;

/** One lock record names the server process and fences a reused process ID. */
export type ServerLockRecord = ProcessIdentity & { serverId: string };

export type RecordedServerStop = {
  pid: number;
  serverId: string;
  /** True when the process ignored the graceful request and a forced stop followed. */
  forced: boolean;
  /** True when the recorded process no longer holds its start identity. */
  exited: boolean;
};

export function serverDirectoryPath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), "server");
}

export function serverLockPath(databasePath: string): string {
  return path.join(serverDirectoryPath(databasePath), "server.lock.json");
}

export function isServerLockRecord(value: unknown): value is ServerLockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    schema?: unknown;
    pid?: unknown;
    startIdentity?: unknown;
    serverId?: unknown;
  };
  return (
    record.schema === SERVER_LOCK_SCHEMA &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startIdentity === "string" &&
    record.startIdentity.length > 0 &&
    typeof record.serverId === "string"
  );
}

/** Read the recorded server, or return undefined for a missing or unusable lock file. */
export function readServerLock(lockPath: string): ServerLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isServerLockRecord(parsed)) return undefined;
  const { pid, startIdentity, serverId } = parsed;
  return { pid, startIdentity, serverId };
}

export function writeServerLock(lockPath: string, record: ServerLockRecord): void {
  fs.writeFileSync(lockPath, `${JSON.stringify({ schema: SERVER_LOCK_SCHEMA, ...record })}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

/**
 * Stop the server named by the lock file when the recorded process still has its start
 * identity. A client whose package version differs from the running server cannot send a
 * stop request, so the lock file is the only path to that stale process. A record whose
 * process is gone, or whose process ID now belongs to another process, stops nothing.
 */
export async function stopRecordedServer(
  lockPath: string,
  options: { graceMs?: number } = {},
): Promise<RecordedServerStop | undefined> {
  const record = readServerLock(lockPath);
  if (record === undefined) return undefined;
  if (!matchesProcessIdentity(record)) return undefined;
  const graceMs = options.graceMs ?? SERVER_STOP_GRACE_MS;
  killProcessGroup(record.pid, "SIGTERM");
  const graceful = await waitForExit(record, graceMs);
  if (graceful) return { pid: record.pid, serverId: record.serverId, forced: false, exited: true };
  killProcessGroup(record.pid, "SIGKILL");
  const forced = await waitForExit(record, graceMs);
  return { pid: record.pid, serverId: record.serverId, forced: true, exited: forced };
}

async function waitForExit(record: ServerLockRecord, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(graceMs, STOP_POLL_MS);
  while (Date.now() < deadline) {
    if (!matchesProcessIdentity(record)) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return !matchesProcessIdentity(record);
}
