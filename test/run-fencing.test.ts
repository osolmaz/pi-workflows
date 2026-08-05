import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ClaimLostError, isClaimLostError } from "../src/workflows/errors.js";
import { readLastTraceEvent, readRunBundle, WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

const stores: SqliteControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function makeQueueStore(): Promise<SqliteControllerStore> {
  const dir = await makeTempDir("pi-run-fence");
  const store = new SqliteControllerStore(path.join(dir, "state", "controller.sqlite"));
  stores.push(store);
  return store;
}

describe("run bundle fencing", () => {
  it("lets the claim holder write and fences out a stale writer", async () => {
    const queue = await makeQueueStore();
    const outputRoot = await makeTempDir("pi-run-fence-runs");
    queue.enqueueWorkflowRun({
      runId: "fenced-run",
      workflowRef: "demo",
      workflowPath: "/demo.ts",
      input: {},
      runnerId: "runner-a",
      claimToken: "token-a",
      leaseMs: 60_000,
    });

    let live = true;
    const fence = () => {
      if (!live || !queue.verifyWorkflowRunClaim({ runId: "fenced-run", claimToken: "token-a" })) {
        throw new ClaimLostError("fenced-run");
      }
    };
    const fencedStore = new WorkflowRunStore(outputRoot, { fenceProvider: () => fence });
    const workflow = defineWorkflow({
      name: "demo",
      startAt: "one",
      nodes: {
        one: compute({
          run: () => {
            // The claim is lost while this node executes: the next persist
            // must be refused.
            live = false;
            return { done: true };
          },
        }),
      },
      edges: [],
    });
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), store: fencedStore });
    const failure = await engine.run(workflow, {}, { runId: "fenced-run" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isClaimLostError(failure)).toBe(true);

    // The bundle has no terminal event; recovery owns its future now.
    const runDir = fencedStore.runDirFor("fenced-run");
    const last = await readLastTraceEvent(runDir);
    expect(last?.type).not.toBe("run_finished");
    expect(last?.type).not.toBe("run_failed");

    // A new claim holder (different token) can write through its own fence.
    queue.parkWorkflowRun({ runId: "fenced-run", claimToken: "token-a" });
    const claimed = queue.claimNextWorkflowRun({
      runnerId: "runner-b",
      claimToken: "token-b",
      leaseMs: 60_000,
    });
    expect(claimed?.runId).toBe("fenced-run");
    const recoveredStore = new WorkflowRunStore(outputRoot, {
      fenceProvider: () => () => {
        if (!queue.verifyWorkflowRunClaim({ runId: "fenced-run", claimToken: "token-b" })) {
          throw new ClaimLostError("fenced-run");
        }
      },
    });
    const interrupted = await recoveredStore.markRunInterrupted("fenced-run");
    expect(interrupted?.state.status).toBe("failed");
    const trace = (await readRunBundle(runDir))?.state.traceSeq ?? 0;
    expect(trace).toBeGreaterThan(0);
  });

  it("keeps unfenced stores working exactly as before", async () => {
    const outputRoot = await makeTempDir("pi-run-fence-runs");
    const store = new WorkflowRunStore(outputRoot);
    const workflow = defineWorkflow({
      name: "plain",
      startAt: "work",
      nodes: { work: compute({ run: () => 1 }) },
      edges: [],
    });
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), store });
    const result = await engine.run(workflow, {});
    expect(result.state.status).toBe("completed");
  });
});
