import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { HostProcessRegistry } from "../src/host/processes.js";
import { WorkflowHost } from "../src/host/runner.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { resolveWorkflowRef } from "../src/workflows/loader.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, ScriptedExecutor, waitUntil } from "./helpers.js";

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

  it("leaves a parked human-decision run available to its session owner", async () => {
    const cwd = await makeTempDir("host-waiting-project");
    const databasePath = path.join(await makeTempDir("host-waiting-state"), "state.sqlite");
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "host-waiting",
        startAt: "approval",
        nodes: { approval: checkpoint({ summary: "approve" }) },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
    const queue = new SqliteControllerStore(databasePath, { projectPath: cwd });
    queue.enqueueWorkflowRun({
      runId: "waiting-run",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:host-waiting",
      workflowSource: { kind: "builtin", id: "host-waiting", revision: "test" },
      definitionDigest: digest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-owner",
      claimToken: "session-token",
      leaseMs: 60_000,
      originSessionId: "session-owner",
    });
    const runStore = new WorkflowRunStore(databasePath, {
      state: queue.state,
      authorityProvider: () => queue.workflowRunAuthority("waiting-run", "session-token"),
    });
    const result = await new WorkflowEngine({
      store: runStore,
      executor: new ScriptedExecutor(),
    }).run(
      workflow,
      {},
      {
        runId: "waiting-run",
        workflowSource: { kind: "builtin", id: "host-waiting", revision: "test" },
      },
    );
    expect(result.state.status).toBe("waiting");
    expect(queue.parkWorkflowRun({ runId: "waiting-run", claimToken: "session-token" })).toBe(true);
    queue.close();

    const logs: string[] = [];
    const host = new WorkflowHost({
      cwd,
      databasePath,
      runnerId: "host-waiting",
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    await host.start();
    await waitUntil(() =>
      logs.some((message) => message.includes("waiting for its decision owner")),
    );
    await host.stop();

    const inspection = new SqliteControllerStore(databasePath, { projectPath: cwd });
    expect(inspection.getWorkflowRun("waiting-run")?.status).toBe("parked");
    expect(
      new WorkflowRunStore(databasePath, { state: inspection.state }).readRun("waiting-run")?.state
        .status,
    ).toBe("waiting");
    inspection.close();
  });

  it("parks a run that reaches a human decision while hosted", async () => {
    const cwd = await makeTempDir("host-new-waiting-project");
    const databasePath = path.join(await makeTempDir("host-new-waiting-state"), "state.sqlite");
    const workflowPath = path.join(cwd, "host-new-waiting.workflow.ts");
    await fs.writeFile(
      workflowPath,
      `import { checkpoint, compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "host-new-waiting",
  startAt: "prepare",
  nodes: {
    prepare: compute({ run: () => 1 }),
    approval: checkpoint({ summary: "approve" }),
  },
  edges: [{ from: "prepare", to: "approval" }],
});\n`,
    );
    const resolved = await resolveWorkflowRef(workflowPath, { cwd });
    let engine: WorkflowEngine | undefined;
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "host-new-waiting",
        startAt: "prepare",
        nodes: {
          prepare: compute({
            run: () => {
              engine?.pause();
              return 1;
            },
          }),
          approval: checkpoint({ summary: "approve" }),
        },
        edges: [{ from: "prepare", to: "approval" }],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const digest = `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
    const queue = new SqliteControllerStore(databasePath, { projectPath: cwd });
    queue.enqueueWorkflowRun({
      runId: "new-waiting-run",
      workflowName: workflow.name,
      workflowSourceRef: workflowPath,
      workflowSource: resolved.source,
      definitionDigest: digest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-owner",
      claimToken: "session-token",
      leaseMs: 60_000,
      originSessionId: "session-owner",
    });
    const runStore = new WorkflowRunStore(databasePath, {
      state: queue.state,
      authorityProvider: () => queue.workflowRunAuthority("new-waiting-run", "session-token"),
    });
    engine = new WorkflowEngine({ store: runStore, executor: new ScriptedExecutor() });
    const running = engine.run(
      workflow,
      {},
      {
        runId: "new-waiting-run",
        workflowSource: resolved.source,
      },
    );
    await waitUntil(() => runStore.readRun("new-waiting-run")?.state.paused === true);
    engine.park();
    const parked = await running;
    expect(parked.state).toMatchObject({ status: "running", paused: true });
    expect(queue.parkWorkflowRun({ runId: "new-waiting-run", claimToken: "session-token" })).toBe(
      true,
    );
    queue.close();

    const logs: string[] = [];
    const host = new WorkflowHost({
      cwd,
      databasePath,
      runnerId: "host-new-waiting",
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    await host.start();
    await waitUntil(() => logs.some((message) => message.includes("parked host-new-waiting")));
    await host.stop();

    const inspection = new SqliteControllerStore(databasePath, { projectPath: cwd });
    expect(inspection.getWorkflowRun("new-waiting-run")?.status).toBe("parked");
    expect(
      new WorkflowRunStore(databasePath, { state: inspection.state }).readRun("new-waiting-run")
        ?.state.status,
    ).toBe("waiting");
    inspection.close();
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
