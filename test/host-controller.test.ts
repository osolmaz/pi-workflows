import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { WorkflowHost } from "../src/host/runner.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function writeController(projectPath: string): Promise<void> {
  const directory = path.join(projectPath, ".pi", "controllers");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "hosted.controller.ts"),
    `import { defineController } from ${JSON.stringify(path.resolve("src/controllers/index.ts"))};
export default defineController({
  name: "hosted",
  initialStatus: () => ({
    workerPid: null,
    effectState: null,
    childState: null,
    settingsChanged: false,
  }),
  async reconcile(ctx) {
    const effect = await ctx.effects.ensure({
      key: "hosted-effect",
      kind: "test",
      request: { value: 1 },
      observe: () => ({ state: "not_applied" }),
      apply: () => ({ state: "applied", externalRef: String(process.pid) }),
    });
    const child = await ctx.workflows.ensure({
      requestKey: "hosted-child",
      workflow: "hosted-child",
      input: { value: 1 },
    });
    const controllerStatus = {
      workerPid: process.pid,
      effectState: effect.state,
      childState: child.state,
      settingsChanged: false,
    };
    if (child.state !== "succeeded") return ctx.requeueAfter(10, { controllerStatus });
    const controlled = await ctx.workflows.ensure({
      requestKey: "hosted-controlled",
      workflow: "hosted-controlled",
      input: {},
    });
    if (controlled.state !== "waiting" || controlled.runId === undefined) {
      return ctx.requeueAfter(10, { controllerStatus });
    }
    await ctx.workflows.changeSettings({
      requestKey: "set-mode",
      runId: controlled.runId,
      patch: [{ op: "replace", path: "/mode", value: "new" }],
    });
    return ctx.settled({ controllerStatus: { ...controllerStatus, settingsChanged: true } });
  },
});\n`,
  );
  const workflows = path.join(projectPath, ".pi", "workflows");
  await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(
    path.join(workflows, "hosted-child.workflow.ts"),
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "hosted-child",
  startAt: "work",
  nodes: { work: compute({ run: () => ({ workerPid: process.pid }) }) },
  edges: [],
});\n`,
  );
  await fs.writeFile(
    path.join(workflows, "hosted-controlled.workflow.ts"),
    `import {
  allowSettingsPath,
  checkpoint,
  defineWorkflow,
  workflowSettings,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "hosted-controlled",
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

describe("hosted controller execution", () => {
  it("runs controller code in a supervised child and commits through the host", async () => {
    const projectPath = await makeTempDir("host-controller-project");
    const databasePath = path.join(await makeTempDir("host-controller-state"), "state.sqlite");
    await writeController(projectPath);
    const store = new SqliteControllerStore(databasePath, { projectPath });
    store.putResource({
      controller: "hosted",
      key: "one",
      spec: {},
      initialStatus: {
        workerPid: null,
        effectState: null,
        childState: null,
        settingsChanged: false,
      },
    });
    store.close();

    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    try {
      await waitUntil(() => {
        const reader = new SqliteControllerStore(databasePath, {
          projectPath,
          readOnly: true,
        });
        try {
          const resource = reader.getResource<
            unknown,
            {
              workerPid: number | null;
              effectState: string | null;
              childState: string | null;
              settingsChanged: boolean;
            }
          >({ controller: "hosted", key: "one" });
          return resource?.status.controllerStatus?.settingsChanged === true;
        } finally {
          reader.close();
        }
      }, 75_000);
      const reader = new SqliteControllerStore(databasePath, { projectPath, readOnly: true });
      try {
        const resource = reader.getResource<
          unknown,
          {
            workerPid: number | null;
            effectState: string | null;
            childState: string | null;
            settingsChanged: boolean;
          }
        >({ controller: "hosted", key: "one" });
        expect(resource?.status.controllerStatus).toMatchObject({
          effectState: "applied",
          childState: "succeeded",
          settingsChanged: true,
        });
        expect(resource?.status.controllerStatus?.workerPid).not.toBe(process.pid);
        expect(resource?.status.observedGeneration).toBe(1);
        expect(reader.listEffects(resource?.metadata.uid ?? "")).toEqual(
          expect.arrayContaining([expect.objectContaining({ state: "applied" })]),
        );
        expect(reader.listWorkflowRuns()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ workflowName: "hosted-child", status: "done" }),
            expect.objectContaining({ workflowName: "hosted-controlled", status: "parked" }),
          ]),
        );
        const controlled = reader
          .listWorkflowRuns()
          .find((run) => run.workflowName === "hosted-controlled");
        if (controlled === undefined) throw new Error("controlled child missing");
        const settings = reader.state.connection
          .prepare(
            `SELECT b.content
             FROM workflow_settings s JOIN blobs b ON b.blob_hash = s.current_hash
             WHERE s.active_run_id = ?`,
          )
          .get(controlled.runId) as { content?: Buffer } | undefined;
        expect(JSON.parse(settings?.content?.toString("utf8") ?? "null")).toEqual({ mode: "new" });
        expect(reader.listEvents({ controller: "hosted", key: "one" })).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "reconcile_finished" })]),
        );
      } finally {
        reader.close();
      }
    } finally {
      await host.stop();
    }
  }, 90_000);
});
