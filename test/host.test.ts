import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { makeTempDir } from "./helpers.js";

describe("WorkflowHost SQLite", () => {
  it("opens the canonical database and shuts down cleanly", async () => {
    const cwd = await makeTempDir("host-project");
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const host = new WorkflowHost({ cwd, databasePath, claimPollMs: 10 });
    await host.start();
    await host.stop();
  });

  it("uses the database directory for its local process registry", async () => {
    const cwd = await makeTempDir("host-project");
    const stateDir = await makeTempDir("host-state");
    const databasePath = path.join(stateDir, "state.sqlite");
    const registry = new HostProcessRegistry(stateDir);
    const host = new WorkflowHost({ cwd, databasePath, registry, claimPollMs: 10 });
    await host.start();
    await host.stop();
  });

  it("allows concurrent hosts for different projects in one database", async () => {
    const firstCwd = await makeTempDir("host-project-a");
    const secondCwd = await makeTempDir("host-project-b");
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const first = new WorkflowHost({
      cwd: firstCwd,
      databasePath,
      runnerId: "host-project-a",
      claimPollMs: 10,
    });
    const second = new WorkflowHost({
      cwd: secondCwd,
      databasePath,
      runnerId: "host-project-b",
      claimPollMs: 10,
    });
    await first.start();
    await second.start();
    await second.stop();
    await first.stop();
  });

  it("refuses a second active host for the same state directory", async () => {
    const cwd = await makeTempDir("host-project");
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const first = new WorkflowHost({ cwd, databasePath, runnerId: "host-one", claimPollMs: 10 });
    const second = new WorkflowHost({ cwd, databasePath, runnerId: "host-two", claimPollMs: 10 });
    await first.start();
    await expect(second.start()).rejects.toThrow(/host/i);
    await first.stop();
  });
});
