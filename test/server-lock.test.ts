import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readServerLock,
  serverLockPath,
  stopRecordedServer,
  writeServerLock,
} from "../src/server/lock.js";
import { processStartIdentity } from "../src/server/processes.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const IDLE = "setInterval(() => {}, 1000);";

function childCode(ignoreSigterm: boolean): string {
  const handler = ignoreSigterm ? 'process.on("SIGTERM", () => {});' : "";
  return `${handler}process.stdout.write("ready\\n");${IDLE}`;
}

/** Start an idle process and wait until it reports that its handlers are installed. */
async function startIdleProcess(ignoreSigterm = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", childCode(ignoreSigterm)], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.stdout?.once("data", resolve);
    child.once("error", reject);
  });
  return child;
}

async function lockDirectory(prefix: string): Promise<{ directory: string; lockPath: string }> {
  const directory = await makeTempDir(prefix);
  return { directory, lockPath: path.join(directory, "server.lock.json") };
}

function recordFor(
  child: ChildProcess,
  serverId = "server-test",
): {
  pid: number;
  startIdentity: string;
  serverId: string;
} {
  const pid = child.pid as number;
  const startIdentity = processStartIdentity(pid);
  if (startIdentity === undefined)
    throw new Error(`The test process has no start identity: ${pid}`);
  return { pid, startIdentity, serverId };
}

function killIfAlive(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The test process has already exited.
    }
  }
}

describe("workflow server lock file", () => {
  it("reads no record from a missing, unparsable, or unusable lock file", async () => {
    const { lockPath } = await lockDirectory("pw-lock-empty");
    expect(readServerLock(lockPath)).toBeUndefined();

    fs.writeFileSync(lockPath, "not json\n");
    expect(readServerLock(lockPath)).toBeUndefined();

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ schema: "pi-workflows.server-lock.v1", pid: "1", startIdentity: "x" }),
    );
    expect(readServerLock(lockPath)).toBeUndefined();
  });

  it("names the lock file beside the state database", async () => {
    const directory = await makeTempDir("pw-lock-path");
    expect(serverLockPath(path.join(directory, "state.sqlite"))).toBe(
      path.join(directory, "server", "server.lock.json"),
    );
  });

  it("does not overwrite an existing lock file", async () => {
    const { lockPath } = await lockDirectory("pw-lock-exclusive");
    const child = await startIdleProcess();
    try {
      writeServerLock(lockPath, recordFor(child));
      expect(() => writeServerLock(lockPath, recordFor(child))).toThrow();
    } finally {
      killIfAlive(child);
    }
  });

  it("stops the recorded process", async () => {
    const { lockPath } = await lockDirectory("pw-lock-stop");
    const child = await startIdleProcess();
    try {
      const record = recordFor(child);
      writeServerLock(lockPath, record);
      expect(readServerLock(lockPath)).toEqual(record);
      expect(await stopRecordedServer(lockPath)).toEqual({
        pid: record.pid,
        serverId: record.serverId,
        forced: false,
        exited: true,
      });
      await waitUntil(() => processStartIdentity(record.pid) === undefined);
    } finally {
      killIfAlive(child);
    }
  });

  it("leaves a process alone when its start identity does not match", async () => {
    const { lockPath } = await lockDirectory("pw-lock-identity");
    const child = await startIdleProcess();
    try {
      writeServerLock(lockPath, {
        pid: child.pid as number,
        startIdentity: "platform-start:0",
        serverId: "server-other",
      });
      expect(await stopRecordedServer(lockPath)).toBeUndefined();
      expect(processStartIdentity(child.pid as number)).toBeDefined();
    } finally {
      killIfAlive(child);
    }
  });

  it("stops nothing when the recorded process has exited", async () => {
    const { lockPath } = await lockDirectory("pw-lock-gone");
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.once("exit", resolve));
    writeServerLock(lockPath, {
      pid: exited.pid as number,
      startIdentity: "platform-start:0",
      serverId: "server-gone",
    });
    expect(await stopRecordedServer(lockPath)).toBeUndefined();
  });

  it("forces a stop when the recorded process ignores the request", async () => {
    const { lockPath } = await lockDirectory("pw-lock-force");
    const child = await startIdleProcess(true);
    try {
      const record = recordFor(child, "server-stubborn");
      writeServerLock(lockPath, record);
      expect(await stopRecordedServer(lockPath, { graceMs: 200 })).toEqual({
        pid: record.pid,
        serverId: "server-stubborn",
        forced: true,
        exited: true,
      });
      await waitUntil(() => processStartIdentity(record.pid) === undefined);
    } finally {
      killIfAlive(child);
    }
  });
});
