import { describe, expect, it } from "vitest";
import { checkpoint, compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowSourceChangedError } from "../src/workflows/errors.js";
import { readRunBundle, WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

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
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
    const first = makeEngine(store);
    const parent = await first.run(waitWorkflow, { change: "big" }, { runId: "parent-1" });
    expect(parent.state.status).toBe("waiting");
    expect(parent.state.waitingOn).toBe("approval");

    const second = makeEngine(store);
    const continued = await second.continueRun(waitWorkflow, "parent-1", { approved: true });

    expect(continued.state.status).toBe("completed");
    expect(continued.state.parentRunId).toBe("parent-1");
    expect(continued.state.input).toEqual({ approved: true });
    // The carried checkpoint output reached the downstream node.
    expect(continued.state.finalOutput).toMatchObject({ approved: true });
    expect(continued.state.steps.length).toBeGreaterThanOrEqual(2);
    expect(continued.state.steps[0]?.nodeId).toBe("approval");

    const bundle = await readRunBundle(continued.runDir);
    const lastOutputs = bundle?.state.outputs ?? {};
    expect(lastOutputs.approval).toBeDefined();
  });

  it("completes immediately when the checkpoint is the final node", async () => {
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
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
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
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
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
    const first = makeEngine(store);
    const parent = await first.run(waitWorkflow, {}, { runId: "parent-3" });
    // Simulate an edited workflow file after the checkpoint.
    const runDir = parent.runDir;
    const bundle = await readRunBundle(runDir);
    expect(bundle?.state.workflowHash).toBeUndefined();
    const state = bundle?.state;
    if (state === undefined) {
      throw new Error("missing state");
    }
    state.workflowSource = { kind: "file", path: "/demo.ts", hash: "old-hash" };
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(runDir, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
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

  it("refuses a changed legacy parent file hash", async () => {
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
    const parent = await makeEngine(store).run(waitWorkflow, {}, { runId: "legacy-parent" });
    const bundle = await readRunBundle(parent.runDir);
    if (bundle === null) throw new Error("missing parent bundle");
    bundle.state.workflowHash = "old-hash";
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(parent.runDir, "state.json"),
      `${JSON.stringify(bundle.state, null, 2)}\n`,
      "utf8",
    );

    await expect(
      makeEngine(store).continueRun(
        waitWorkflow,
        "legacy-parent",
        {},
        {
          workflowSource: { kind: "file", path: "/demo.ts", hash: "new-hash" },
        },
      ),
    ).rejects.toThrow(WorkflowSourceChangedError);
  });

  it("counts carried steps against maxSteps", async () => {
    const outputRoot = await makeTempDir("pi-continuation-runs");
    const store = new WorkflowRunStore(outputRoot);
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
