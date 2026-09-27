import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireServerLock,
  probeServerServing,
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

/** The test process itself: always alive, so its lock record always matches. */
function selfRecord(serverId: string): {
  pid: number;
  startIdentity: string;
  serverId: string;
} {
  const startIdentity = processStartIdentity(process.pid);
  if (startIdentity === undefined)
    throw new Error(`The test process has no start identity: ${process.pid}`);
  return { pid: process.pid, startIdentity, serverId };
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

describe("server lock acquisition", () => {
  it("takes over a missing lock or a dead holder without probing", async () => {
    const { lockPath } = await lockDirectory("pw-lock-acquire-missing");
    const probe = vi.fn();
    const record = { pid: 1, startIdentity: "platform-start:0", serverId: "server-new" };
    await acquireServerLock(lockPath, record, {
      socketPath: path.join("/tmp", "unused.sock"),
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(readServerLock(lockPath)).toEqual(record);

    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => exited.once("exit", resolve));
    fs.rmSync(lockPath, { force: true });
    writeServerLock(lockPath, {
      pid: exited.pid as number,
      startIdentity: "platform-start:0",
      serverId: "server-gone",
    });
    await acquireServerLock(lockPath, record, {
      socketPath: path.join("/tmp", "unused.sock"),
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(readServerLock(lockPath)).toEqual(record);
  });

  it("keeps the already-running error for a holder that answers on the socket", async () => {
    const { lockPath } = await lockDirectory("pw-lock-acquire-serving");
    const child = await startIdleProcess();
    try {
      writeServerLock(lockPath, recordFor(child, "server-serving"));
      await expect(
        acquireServerLock(lockPath, recordFor(child, "server-next"), {
          socketPath: path.join("/tmp", "unused.sock"),
          probe: async () => true,
        }),
      ).rejects.toThrow(/already running with PID/);
      expect(readServerLock(lockPath)?.serverId).toBe("server-serving");
    } finally {
      killIfAlive(child);
    }
  });

  it("takes over a live holder that is provably not serving", async () => {
    const { lockPath } = await lockDirectory("pw-lock-acquire-deaf");
    const child = await startIdleProcess();
    try {
      writeServerLock(lockPath, recordFor(child, "server-shutdown-bound"));
      const probe = vi.fn(async () => false);
      const record = recordFor(child, "server-next");
      await acquireServerLock(lockPath, record, {
        socketPath: path.join("/tmp", "unused.sock"),
        probe,
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(readServerLock(lockPath)).toEqual(record);
    } finally {
      killIfAlive(child);
    }
  });

  it("revalidates the holder after the probe and keeps a newer serving starter", async () => {
    const { lockPath } = await lockDirectory("pw-lock-revalidate");
    const holder = await startIdleProcess();
    try {
      const holderRecord = recordFor(holder, "server-holder");
      const starterRecord = selfRecord("server-starter");
      writeServerLock(lockPath, holderRecord);
      // A competing starter takes over the silent holder while this probe
      // awaits, and answers on the socket before the caller re-reads.
      const probe = vi.fn(async () => {
        fs.rmSync(lockPath, { force: true });
        writeServerLock(lockPath, starterRecord);
        return probe.mock.calls.length > 1;
      });
      await expect(
        acquireServerLock(lockPath, selfRecord("server-next"), {
          socketPath: path.join("/tmp", "unused.sock"),
          probe,
        }),
      ).rejects.toThrow(new RegExp(`already running with PID ${process.pid}`));
      expect(probe).toHaveBeenCalledTimes(2);
      expect(readServerLock(lockPath)?.serverId).toBe("server-starter");
    } finally {
      killIfAlive(holder);
    }
  });

  it("converges when another starter replaces the holder during the probe", async () => {
    const { lockPath } = await lockDirectory("pw-lock-converge");
    const holder = await startIdleProcess();
    try {
      const holderRecord = recordFor(holder, "server-holder");
      const starterRecord = selfRecord("server-starter");
      writeServerLock(lockPath, holderRecord);
      // The first probe sees the silent holder while a competing starter takes
      // over; the second probe sees the new holder still silent, so the caller
      // converges on the newest silent holder instead of clobbering blindly.
      const probe = vi.fn(async () => {
        if (readServerLock(lockPath)?.serverId === "server-holder") {
          fs.rmSync(lockPath, { force: true });
          writeServerLock(lockPath, starterRecord);
        }
        return false;
      });
      await acquireServerLock(lockPath, selfRecord("server-next"), {
        socketPath: path.join("/tmp", "unused.sock"),
        probe,
      });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(readServerLock(lockPath)?.serverId).toBe("server-next");
    } finally {
      killIfAlive(holder);
    }
  });
});

describe("server serving probe", () => {
  it("reports a hello-writing server as serving", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-hello"), "s.sock");
    const server = net.createServer((socket) => {
      socket.end('{"type":"hello"}\n');
    });
    server.listen(socketPath);
    await once(server, "listening");
    try {
      expect(await probeServerServing(socketPath, 1_000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("reports a silent bound socket as not serving", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-silent"), "s.sock");
    const server = net.createServer(() => undefined);
    server.listen(socketPath);
    await once(server, "listening");
    try {
      expect(await probeServerServing(socketPath, 300)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("reports a missing socket path as not serving without connecting", async () => {
    const socketPath = path.join(await makeTempDir("pw-probe-missing"), "gone.sock");
    expect(await probeServerServing(socketPath, 300)).toBe(false);
  });

  it("takes over a real deaf holder that still owns the lock file", async () => {
    const directory = await makeTempDir("pw-probe-takeover");
    const lockPath = path.join(directory, "server.lock.json");
    const socketPath = path.join(directory, "s.sock");
    // The test process itself is the live holder: its start identity matches,
    // and its bound socket accepts connections but never answers.
    const holder = selfRecord("server-deaf");
    writeServerLock(lockPath, holder);
    const server = net.createServer(() => undefined);
    server.listen(socketPath);
    await once(server, "listening");
    try {
      const record = { ...holder, serverId: "server-next" };
      await acquireServerLock(lockPath, record, { socketPath, probeTimeoutMs: 300 });
      expect(readServerLock(lockPath)).toEqual(record);
    } finally {
      server.close();
    }
  });

  it("keeps the lock error against a real hello-writing holder", async () => {
    const directory = await makeTempDir("pw-probe-serving");
    const lockPath = path.join(directory, "server.lock.json");
    const socketPath = path.join(directory, "s.sock");
    const holder = selfRecord("server-real");
    writeServerLock(lockPath, holder);
    const server = net.createServer((socket) => {
      socket.end('{"type":"hello"}\n');
    });
    server.listen(socketPath);
    await once(server, "listening");
    try {
      await expect(
        acquireServerLock(
          lockPath,
          { ...holder, serverId: "server-next" },
          {
            socketPath,
            probeTimeoutMs: 1_000,
          },
        ),
      ).rejects.toThrow(/already running with PID/);
      expect(readServerLock(lockPath)?.serverId).toBe("server-real");
    } finally {
      server.close();
    }
  });
});
