import fs from "node:fs";
import net from "node:net";
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

/** One bounded socket probe: does a server accept connections here and answer? */
export type ServerLockProbe = (socketPath: string, timeoutMs: number) => Promise<boolean>;

/**
 * Ask the socket whether a server is really serving. Serving means the connect
 * succeeds and the server's hello arrives within the timeout; a connect error or
 * a silent window means the holder is alive but not serving, as during shutdown
 * or while frozen. The probe socket is always destroyed.
 */
export async function probeServerServing(socketPath: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(serving);
    };
    socket.once("data", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/**
 * Take the exclusive server lock for a starting server. A lock whose recorded
 * process is gone, or whose process is alive but provably not serving, is stale
 * and is removed. A holder that answers on the socket keeps the lock, and the
 * caller must not start. Fencing against a second live server stays with the
 * epoch claim, not with this file: a probe misfire costs one wasted start, and
 * the loser exits when its claim fails.
 *
 * The probe awaits, so the lock record can change while it runs. After a
 * not-serving verdict the record is re-read, and the lock is only removed when
 * it still names the same silent holder; a record another starter already
 * replaced makes this starter re-read and converge instead of clobbering the
 * newer takeover. Creation stays exclusive (`wx`), so a racing creator loses
 * and re-reads. Concurrent starters can therefore only displace a holder that
 * is provably not serving, and the epoch claim fences whichever of them wins.
 */
export async function acquireServerLock(
  lockPath: string,
  record: { pid: number; startIdentity: string; serverId: string },
  options: { socketPath: string; probeTimeoutMs?: number; probe?: ServerLockProbe },
): Promise<void> {
  const probe = options.probe ?? probeServerServing;
  const timeoutMs = options.probeTimeoutMs ?? 500;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = readServerLock(lockPath);
    if (existing !== undefined && matchesProcessIdentity(existing)) {
      if (await probe(options.socketPath, timeoutMs)) {
        throw new Error(`A workflow server is already running with PID ${existing.pid}`);
      }
      const current = readServerLock(lockPath);
      if (
        current !== undefined &&
        matchesProcessIdentity(current) &&
        (current.pid !== existing.pid ||
          current.startIdentity !== existing.startIdentity ||
          current.serverId !== existing.serverId)
      ) {
        continue;
      }
    }
    fs.rmSync(lockPath, { force: true });
    try {
      writeServerLock(lockPath, record);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      // Another starter created the lock first; re-read and converge.
    }
  }
  throw new Error(`Could not acquire the workflow server lock at ${lockPath}`);
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
