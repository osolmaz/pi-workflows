import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_PROTOCOL_SCHEMA, clientSocketPath } from "../src/client/protocol.js";
import { readServerLock, serverLockPath, writeServerLock } from "../src/server/lock.js";
import { processStartIdentity } from "../src/server/processes.js";
import { canonicalJson } from "../src/state/json.js";
import { main, parseCliArgs } from "../src/viewer/cli.js";
import { makeTempDir, waitUntil } from "./helpers.js";

describe("pi-workflows CLI", () => {
  it("parses the fixed-database viewer contract", () => {
    expect(parseCliArgs(["view", "run-1", "--once"])).toEqual({
      command: "view",
      runId: "run-1",
      once: true,
      json: false,
    });
    expect(parseCliArgs(["runs"])).toEqual({ command: "runs", once: false, json: false });
  });

  it("does not accept old storage path options", () => {
    expect(() => parseCliArgs(["runs", "--dir", "/tmp/runs"])).toThrow(/Unknown argument/);
    expect(() =>
      parseCliArgs(["resource-managers", "--resource-manager-dir", "/tmp/resource-managers"]),
    ).toThrow(/Unknown argument/);
  });

  it("parses state maintenance commands", () => {
    expect(parseCliArgs(["state", "verify"])).toEqual({
      command: "state",
      stateAction: "verify",
      once: false,
      json: false,
    });
    expect(parseCliArgs(["state", "backup", "/tmp/state-backup.sqlite"])).toMatchObject({
      command: "state",
      stateAction: "backup",
      backupDestination: "/tmp/state-backup.sqlite",
    });
    expect(
      parseCliArgs([
        "state",
        "prune",
        "--before",
        "2026-08-01T00:00:00Z",
        "--backup",
        "/tmp/state.sqlite",
        "--apply",
      ]),
    ).toMatchObject({
      stateAction: "prune",
      pruneBefore: "2026-08-01T00:00:00Z",
      backupDestination: "/tmp/state.sqlite",
      pruneApply: true,
    });
    expect(() => parseCliArgs(["state", "prune", "--before", "2026-08-01T00:00:00Z"])).toThrow(
      /exactly one/,
    );
  });

  it("parses resource manager and server commands", () => {
    expect(parseCliArgs(["resource-manager", "jobs", "one"])).toMatchObject({
      command: "resource-manager",
      resourceManagerName: "jobs",
      resourceKey: "one",
    });
    expect(parseCliArgs(["server", "run", "--", "--model", "test"])).toEqual({
      command: "server",
      serverAction: "run",
      once: false,
      json: false,
      piArgs: ["--model", "test"],
    });
    expect(() => parseCliArgs(["server", "run", "--project", "/tmp/project"])).toThrow(
      /global server/,
    );
  });

  it("rejects a relative prune backup path", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await main([
          "state",
          "prune",
          "--before",
          "2026-08-01T00:00:00Z",
          "--backup",
          "relative.sqlite",
          "--apply",
        ]),
      ).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/absolute/));
    } finally {
      stderr.mockRestore();
    }
  });

  it("prints help", async () => {
    expect(await main(["--help"])).toBe(0);
  });

  it("rejects unknown commands", async () => {
    expect(await main(["unknown"])).toBe(2);
  });
});

/**
 * A server from another package version answers every request with its own version, so
 * no client request reaches it. These tests use a stub server that reports a different
 * version and a lock file that names it, which is the state an upgrade creates.
 */
const STUB_HELLO = canonicalJson({
  schema: CLIENT_PROTOCOL_SCHEMA,
  type: "hello",
  connectionId: "stub",
  packageVersion: "0.0.0-stub",
});

const STUB_SERVER = `
const net = require("node:net");
const frame = ${JSON.stringify(STUB_HELLO)};
const server = net.createServer((socket) => {
  socket.write(frame + "\\n");
});
server.listen(process.env.PIW_STUB_SOCKET, () => process.stdout.write("ready\\n"));
`;

describe("pi-workflows CLI server recovery", () => {
  async function startMismatchedServer(
    home: string,
  ): Promise<{ child: ChildProcess; databasePath: string }> {
    const databasePath = path.join(home, ".pi", "agent", "workflows", "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const child = spawn(process.execPath, ["-e", STUB_SERVER], {
      env: { ...process.env, PIW_STUB_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve, reject) => {
      child.stdout?.once("data", resolve);
      child.once("error", reject);
    });
    const startIdentity = processStartIdentity(child.pid as number);
    writeServerLock(serverLockPath(databasePath), {
      pid: child.pid as number,
      startIdentity: startIdentity as string,
      serverId: "server-stub",
    });
    return { child, databasePath };
  }

  async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  }

  it(
    "stops the recorded server when the running server is from another version",
    { timeout: 30_000 },
    async () => {
      const home = await makeTempDir("pw-cli-mismatch");
      const { child } = await startMismatchedServer(home);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await withHome(home, () => main(["server", "stop"]))).toBe(0);
        expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"stoppedPid"'));
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`PID ${child.pid}`));
        await waitUntil(() => processStartIdentity(child.pid as number) === undefined);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        child.kill("SIGKILL");
      }
    },
  );

  it(
    "reports a server from another version on status and leaves it running",
    { timeout: 30_000 },
    async () => {
      const home = await makeTempDir("pw-cli-status");
      const { child } = await startMismatchedServer(home);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await withHome(home, () => main(["server", "status"]))).toBe(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("version mismatch"));
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('Run "pi-workflows server stop" and retry'),
        );
        expect(processStartIdentity(child.pid as number)).toBeDefined();
      } finally {
        stderr.mockRestore();
        child.kill("SIGKILL");
      }
    },
  );

  it(
    "starts a matching server after stopping one from another version",
    { timeout: 60_000 },
    async () => {
      const home = await makeTempDir("pw-cli-restart");
      const { child, databasePath } = await startMismatchedServer(home);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await withHome(home, () => main(["server", "start"]))).toBe(0);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`PID ${child.pid}`));
        const record = readServerLock(serverLockPath(databasePath));
        expect(record).toBeDefined();
        expect(record?.pid).not.toBe(child.pid);
        expect(await withHome(home, () => main(["server", "stop"]))).toBe(0);
        await waitUntil(() => processStartIdentity(record?.pid as number) === undefined);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        child.kill("SIGKILL");
      }
    },
  );
});
