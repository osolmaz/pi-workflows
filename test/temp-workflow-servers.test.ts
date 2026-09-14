import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { processStartIdentity } from "../src/server/processes.js";
import { makeTempDir } from "./helpers.js";
import { stopTempWorkflowServers } from "./temp-workflow-servers.js";

async function writeLockFile(root: string, record: Record<string, unknown>): Promise<void> {
  const storeDirectory = path.join(root, "server");
  await fs.mkdir(storeDirectory, { recursive: true });
  await fs.writeFile(path.join(storeDirectory, "server.lock.json"), `${JSON.stringify(record)}\n`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("stopTempWorkflowServers", () => {
  it("stops a recorded process whose start identity still matches", async () => {
    const root = await makeTempDir("temp-server-stop");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("the probe process did not start");
    const startIdentity = processStartIdentity(child.pid);
    if (startIdentity === undefined) throw new Error("the probe process has no start identity");
    await writeLockFile(root, {
      schema: "pi-workflows.server-lock.v1",
      pid: child.pid,
      startIdentity,
      serverId: "server-probe",
    });

    expect(await stopTempWorkflowServers(root)).toBe(1);
    expect(processIsAlive(child.pid)).toBe(false);
  });

  it("leaves a live process alone when the recorded start identity is stale", async () => {
    const root = await makeTempDir("temp-server-skip");
    await writeLockFile(root, {
      schema: "pi-workflows.server-lock.v1",
      pid: process.pid,
      startIdentity: "stale-start-identity",
      serverId: "server-probe",
    });

    expect(await stopTempWorkflowServers(root)).toBe(0);
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("ignores a record for a process that already exited", async () => {
    const root = await makeTempDir("temp-server-gone");
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("the probe process did not start");
    const startIdentity = processStartIdentity(child.pid);
    if (startIdentity === undefined) throw new Error("the probe process has no start identity");
    await new Promise((resolve) => child.once("exit", resolve));
    await writeLockFile(root, {
      schema: "pi-workflows.server-lock.v1",
      pid: child.pid,
      startIdentity,
      serverId: "server-probe",
    });

    expect(await stopTempWorkflowServers(root)).toBe(0);
  });

  it("reports nothing to stop for a root without a server store", async () => {
    const root = await makeTempDir("temp-server-empty");
    expect(await stopTempWorkflowServers(root)).toBe(0);
    expect(await stopTempWorkflowServers(path.join(root, "missing"))).toBe(0);
  });
});
