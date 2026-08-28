import { describe, expect, it } from "vitest";
import { StateDatabase } from "../src/state/database.js";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowSourceChangedError } from "../src/workflows/errors.js";
import { readWorkflowRun, WorkflowRunStore } from "../src/workflows/store.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

function makeEngine(store: WorkflowRunStore) {
  return new WorkflowEngine({ executor: new ScriptedExecutor(), store });
}

const waitWorkflow = defineWorkflow({
  name: "approval-flow",
  startAt: "approval",
  nodes: {
    approval: checkpoint({ summary: "approve the change" }),
    apply: compute({
      run: ({ outputs }: { outputs: Record<string, unknown> }) => ({
        approved: true,
        checkpointOutput: outputs.approval ?? null,
      }),
    }),
  },
  edges: [{ from: "approval", to: "apply" }],
});

describe("WorkflowEngine.continueRun", () => {
  it("continues a checkpointed run with carried outputs and step accounting", async () => {
    const databasePath = await makeStateDatabasePath("pi-continuation-runs");
    const store = new WorkflowRunStore(databasePath);
    const first = makeEngine(store);
    const parent = await first.run(waitWorkflow, { change: "big" }, { runId: "parent-1" });
    expect(parent.state.status).toBe("waiting");
    expect(parent.state.waitingOn).toBe("approval");
    const parentAttemptId = parent.state.steps[0]?.attemptId;
    if (parentAttemptId === undefined) throw new Error("parent attempt missing");
    const parentStep = parent.state.steps[0];
    const observer = new StateDatabase({ filePath: databasePath });
    const revisionOf = (runId: string): number => {
      const row = observer.connection
        .prepare("SELECT presentation_revision AS revision FROM viewer_runs WHERE run_id = ?")
        .get(runId);
      if (
        typeof row !== "object" ||
        row === null ||
        !("revision" in row) ||
        typeof row.revision !== "number"
      ) {
        throw new Error("Viewer revision row is invalid");
      }
      return row.revision;
    };
    const parentViewerRevision = revisionOf("parent-1");

    const second = makeEngine(store);
    const continued = await second.continueRun(waitWorkflow, "parent-1", { approved: true });

    expect(continued.state.status).toBe("completed");
    expect(continued.state.parentRunId).toBe("parent-1");
    expect(continued.state.input).toEqual({ approved: true });
    // The carried checkpoint output reached the downstream node.
    expect(continued.state.finalOutput).toMatchObject({ approved: true });
    expect(continued.state.steps.length).toBeGreaterThanOrEqual(2);
    expect(continued.state.steps[0]?.nodeId).toBe("approval");
    expect(revisionOf("parent-1")).toBeGreaterThan(parentViewerRevision);
    observer.close();

    const bundle = readWorkflowRun(continued.runId, { databasePath });
    const lastOutputs = bundle?.state.outputs ?? {};
    expect(lastOutputs.approval).toBeDefined();
    expect(readWorkflowRun("parent-1", { databasePath })?.state.steps[0]).toEqual(parentStep);
    expect(
      store.state.connection
        .prepare("SELECT run_id AS runId FROM node_attempts WHERE attempt_id = ?")
        .get(parentAttemptId),
    ).toEqual({ runId: "parent-1" });
    expect(
      store.state.connection
        .prepare("SELECT node_id AS nodeId FROM node_attempts WHERE run_id = ? ORDER BY node_id")
        .all(continued.runId),
    ).toEqual([{ nodeId: "apply" }]);
  });

  it("completes immediately when the checkpoint is the final node", async () => {
    const databasePath = await makeStateDatabasePath("pi-continuation-runs");
    const store = new WorkflowRunStore(databasePath);
    const terminalCheckpoint = defineWorkflow({
      name: "terminal-approval",
      startAt: "approval",
      nodes: { approval: checkpoint({ summary: "approve" }) },
      edges: [],
    });
    const first = makeEngine(store);
    await first.run(terminalCheckpoint, {}, { runId: "parent-2" });
    const second = makeEngine(store);
    const continued = await second.continueRun(terminalCheckpoint, "parent-2", "yes");
    expect(continued.state.status).toBe("completed");
  });

  it("rejects continuation from runs that are not waiting", async () => {
    const databasePath = await makeStateDatabasePath("pi-continuation-runs");
    const store = new WorkflowRunStore(databasePath);
    const plain = defineWorkflow({
      name: "plain",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const engine = makeEngine(store);
    await engine.run(plain, {}, { runId: "not-waiting" });
    await expect(engine.continueRun(plain, "not-waiting", {})).rejects.toThrow(/status/);
    await expect(engine.continueRun(plain, "missing-run", {})).rejects.toThrow(/unreadable/);
  });

  it("refuses to continue against changed source unless forced", async () => {
    const databasePath = await makeStateDatabasePath("pi-continuation-runs");
    const store = new WorkflowRunStore(databasePath);
    const first = makeEngine(store);
    await first.run(
      waitWorkflow,
      {},
      {
        runId: "parent-3",
        workflowSource: { kind: "file", path: "/demo.ts", hash: "old-hash" },
      },
    );

    const second = makeEngine(store);
    await expect(
      second.continueRun(
        waitWorkflow,
        "parent-3",
        {},
        {
          workflowSource: { kind: "file", path: "/demo.ts", hash: "new-hash" },
        },
      ),
    ).rejects.toThrow(WorkflowSourceChangedError);
    const forced = await second.continueRun(
      waitWorkflow,
      "parent-3",
      {},
      {
        workflowSource: { kind: "file", path: "/demo.ts", hash: "new-hash" },
        force: true,
      },
    );
    expect(forced.state.status).toBe("completed");
  });

  it("counts carried steps against maxSteps", async () => {
    const databasePath = await makeStateDatabasePath("pi-continuation-runs");
    const store = new WorkflowRunStore(databasePath);
    const capped = defineWorkflow({
      name: "capped",
      maxSteps: 1,
      startAt: "approval",
      nodes: {
        approval: checkpoint({ summary: "approve" }),
        apply: compute({ run: () => "done" }),
      },
      edges: [{ from: "approval", to: "apply" }],
    });
    const first = makeEngine(store);
    // maxSteps=1 covers the checkpoint itself.
    await first.run(capped, {}, { runId: "parent-4" });
    const second = makeEngine(store);
    const continued = await second.continueRun(capped, "parent-4", {});
    // The carried checkpoint step already consumes the whole budget.
    expect(continued.state.status).toBe("failed");
    expect(continued.state.error).toMatch(/maxSteps/);
  });
});
