import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function writeResourceManager(projectPath: string): Promise<void> {
  const directory = path.join(projectPath, ".pi", "resource-managers");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "server.resource-manager.ts"),
    `import { defineResourceManager } from ${JSON.stringify(path.resolve("src/resource-managers/index.ts"))};
export default defineResourceManager({
  name: "server",
  initialStatus: () => ({
    runnerPid: null,
    effectState: null,
    childState: null,
    settingsChanged: false,
  }),
  async reconcile(ctx) {
    const effect = await ctx.effects.ensure({
      key: "server-effect",
      kind: "test",
      request: { value: 1 },
      observe: () => ({ state: "not_applied" }),
      apply: () => ({ state: "applied", externalRef: String(process.pid) }),
    });
    const child = await ctx.workflows.ensure({
      requestKey: "server-child",
      workflow: "server-child",
      input: { value: 1 },
    });
    const resourceManagerStatus = {
      runnerPid: process.pid,
      effectState: effect.state,
      childState: child.state,
      settingsChanged: false,
    };
    if (child.state !== "succeeded") return ctx.requeueAfter(10, { resourceManagerStatus });
    const controlled = await ctx.workflows.ensure({
      requestKey: "server-controlled",
      workflow: "server-controlled",
      input: {},
    });
    if (controlled.state !== "waiting" || controlled.runId === undefined) {
      return ctx.requeueAfter(10, { resourceManagerStatus });
    }
    await ctx.workflows.changeSettings({
      requestKey: "set-mode",
      runId: controlled.runId,
      patch: [{ op: "replace", path: "/mode", value: "new" }],
    });
    return ctx.settled({ resourceManagerStatus: { ...resourceManagerStatus, settingsChanged: true } });
  },
});\n`,
  );
  const workflows = path.join(projectPath, ".pi", "workflows");
  await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(
    path.join(workflows, "server-child.workflow.ts"),
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "server-child",
  startAt: "work",
  nodes: { work: compute({ run: () => ({ runnerPid: process.pid }) }) },
  edges: [],
});\n`,
  );
  await fs.writeFile(
    path.join(workflows, "server-controlled.workflow.ts"),
    `import {
  allowSettingsPath,
  checkpoint,
  defineWorkflow,
  workflowSettings,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "server-controlled",
  settings: workflowSettings({
    initial: { mode: "old" },
    parse: (value) => value,
    paths: [allowSettingsPath("/mode", { replace: ["controller"] })],
  }),
  startAt: "wait",
  nodes: { wait: checkpoint({ summary: "wait" }) },
  edges: [],
});\n`,
  );
}

describe("resource manager execution", () => {
  it("routes managed resource commands through the workflow server", async () => {
    const projectPath = await makeTempDir("server-resource-manager-admin-project");
    const databasePath = path.join(
      await makeTempDir("server-resource-manager-admin-state"),
      "state.sqlite",
    );
    const directory = path.join(projectPath, ".pi", "resource-managers");
    await fs.mkdir(directory, { recursive: true });
    const resourceManagerPath = path.join(directory, "admin.resource-manager.ts");
    await fs.writeFile(
      resourceManagerPath,
      `import { defineResourceManager } from ${JSON.stringify(path.resolve("src/resource-managers/index.ts"))};
export default defineResourceManager({
  name: "admin",
  initialStatus: (spec) => spec,
  reconcile: (ctx) => ctx.settled(),
});\n`,
    );
    const server = new WorkflowServer({ databasePath, claimPollMs: 1_000_000 });
    await server.start();
    try {
      const client = new WorkflowClient({ databasePath });
      const resolved = await client.resolveResourceManagerInitialization({
        cwd: projectPath,
        resourceManagerName: "admin",
        spec: 7,
      });
      expect(resolved.initialStatus).toBe(7);
      const applied = await client.request({
        operation: "resourceManager.apply",
        payload: {
          projectPath,
          resourceManager: "admin",
          key: "one",
          spec: 7,
          initialStatus: resolved.initialStatus,
          resourceManagerPath: resolved.resourceManagerPath,
          sourceHash: resolved.sourceHash,
        },
      });
      expect(applied.outcome).toBe("accepted");

      const listed = await client.request({
        operation: "resourceManager.list",
        payload: { projectPath },
      });
      expect(listed.receipt).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ resourceManager: "admin", key: "one" }),
          spec: 7,
        }),
      ]);
      const fetched = await client.request({
        operation: "resourceManager.get",
        payload: { projectPath, resourceManager: "admin", key: "one" },
      });
      expect(fetched.outcome).toBe("accepted");
      expect(fetched.receipt).toEqual(
        expect.objectContaining({ status: expect.objectContaining({ resourceManagerStatus: 7 }) }),
      );
      expect(
        (
          await client.request({
            operation: "resourceManager.reconcile",
            payload: { projectPath, resourceManager: "admin", key: "one" },
          })
        ).outcome,
      ).toBe("accepted");
      expect(
        (
          await client.request({
            operation: "resourceManager.delete",
            payload: { projectPath, resourceManager: "admin", key: "one" },
          })
        ).outcome,
      ).toBe("accepted");

      const changed = await client.resolveResourceManagerInitialization({
        cwd: projectPath,
        resourceManagerName: "admin",
        spec: 8,
      });
      await fs.appendFile(resourceManagerPath, "\n// changed after resolution\n");
      const rejected = await client.request({
        operation: "resourceManager.apply",
        payload: {
          projectPath,
          resourceManager: "admin",
          key: "two",
          spec: 8,
          initialStatus: changed.initialStatus,
          resourceManagerPath: changed.resourceManagerPath,
          sourceHash: changed.sourceHash,
        },
      });
      expect(rejected).toMatchObject({
        outcome: "conflict",
        error: "ResourceManager source changed before apply committed",
      });
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("runs resource manager code in a supervised child and commits through the server", async () => {
    const projectPath = await makeTempDir("server-resource-manager-project");
    const databasePath = path.join(
      await makeTempDir("server-resource-manager-state"),
      "state.sqlite",
    );
    await writeResourceManager(projectPath);
    const store = new SqliteResourceManagerStore(databasePath, { projectPath });
    store.putResource({
      resourceManager: "server",
      key: "one",
      spec: {},
      initialStatus: {
        runnerPid: null,
        effectState: null,
        childState: null,
        settingsChanged: false,
      },
    });
    store.close();

    // Reconciles and their child workflows share this one execution slot.
    const server = new WorkflowServer({ databasePath, claimPollMs: 10, maxRunners: 1 });
    await server.start();
    try {
      await waitUntil(() => {
        const reader = new SqliteResourceManagerStore(databasePath, {
          projectPath,
          readOnly: true,
        });
        try {
          const resource = reader.getResource<
            unknown,
            {
              runnerPid: number | null;
              effectState: string | null;
              childState: string | null;
              settingsChanged: boolean;
            }
          >({ resourceManager: "server", key: "one" });
          return resource?.status.resourceManagerStatus?.settingsChanged === true;
        } finally {
          reader.close();
        }
      }, 75_000);
      const reader = new SqliteResourceManagerStore(databasePath, { projectPath, readOnly: true });
      const queue = new WorkflowRunQueueStore(databasePath, { state: reader.state, projectPath });
      try {
        const resource = reader.getResource<
          unknown,
          {
            runnerPid: number | null;
            effectState: string | null;
            childState: string | null;
            settingsChanged: boolean;
          }
        >({ resourceManager: "server", key: "one" });
        expect(resource?.status.resourceManagerStatus).toMatchObject({
          effectState: "applied",
          childState: "succeeded",
          settingsChanged: true,
        });
        expect(resource?.status.resourceManagerStatus?.runnerPid).not.toBe(process.pid);
        expect(resource?.status.observedGeneration).toBe(1);
        expect(reader.listEffects(resource?.metadata.uid ?? "")).toEqual(
          expect.arrayContaining([expect.objectContaining({ state: "applied" })]),
        );
        expect(queue.listWorkflowRuns()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ workflowName: "server-child", status: "done" }),
            expect.objectContaining({ workflowName: "server-controlled", status: "parked" }),
          ]),
        );
        const controlled = queue
          .listWorkflowRuns()
          .find((run) => run.workflowName === "server-controlled");
        if (controlled === undefined) throw new Error("controlled child missing");
        const settings = reader.state.connection
          .prepare(
            `SELECT b.content
             FROM workflow_settings s JOIN blobs b ON b.blob_hash = s.current_hash
             WHERE s.active_run_id = ?`,
          )
          .get(controlled.runId) as { content?: Buffer } | undefined;
        expect(JSON.parse(settings?.content?.toString("utf8") ?? "null")).toEqual({ mode: "new" });
        expect(reader.listEvents({ resourceManager: "server", key: "one" })).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "reconcile_finished" })]),
        );
      } finally {
        reader.close();
      }
    } finally {
      await server.stop();
    }
  }, 90_000);
});
