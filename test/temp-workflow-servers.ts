import fs from "node:fs/promises";
import path from "node:path";
import { matchesProcessIdentity, type ProcessIdentity } from "../src/server/processes.js";

const SERVER_STORE_DIRECTORY = "server";
const SERVER_LOCK_FILE_NAME = "server.lock.json";
const SERVER_STOP_GRACE_MS = 5_000;
const SERVER_STOP_POLL_MS = 25;

/**
 * Stops every workflow server that a test run started under one temporary root.
 *
 * The server records its process identity in `<state directory>/server/server.lock.json`.
 * A test that starts a server through the extension cannot stop it again in every case, and
 * a server that outlives its test holds about 80 MB for the life of the machine. The recorded
 * start identity fences process identifier reuse, so the harness never stops a stranger.
 */
export async function stopTempWorkflowServers(root: string): Promise<number> {
  const identities = await recordedServerIdentities(root);
  const stopped: number[] = [];
  for (const identity of identities) {
    if (!matchesProcessIdentity(identity)) continue;
    try {
      process.kill(identity.pid, "SIGTERM");
      stopped.push(identity.pid);
    } catch {
      // The server exited between the identity check and the signal.
    }
  }
  const deadline = Date.now() + SERVER_STOP_GRACE_MS;
  while (Date.now() < deadline && stopped.some((pid) => processIsAlive(pid))) {
    await delay(SERVER_STOP_POLL_MS);
  }
  for (const pid of stopped) {
    if (!processIsAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The server exited while the harness waited for the grace period.
    }
  }
  return stopped.length;
}

async function recordedServerIdentities(root: string): Promise<ProcessIdentity[]> {
  const identities: ProcessIdentity[] = [];
  for (const filePath of await serverLockFiles(root)) {
    const record = await readJsonRecord(filePath);
    if (record === undefined || record.schema !== "pi-workflows.server-lock.v1") continue;
    const { pid, startIdentity } = record;
    if (typeof pid !== "number" || typeof startIdentity !== "string") continue;
    identities.push({ pid, startIdentity });
  }
  return identities;
}

async function serverLockFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(directory, entry.name);
    if (entry.name === SERVER_STORE_DIRECTORY) {
      files.push(path.join(childPath, SERVER_LOCK_FILE_NAME));
      continue;
    }
    files.push(...(await serverLockFiles(childPath)));
  }
  return files;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
