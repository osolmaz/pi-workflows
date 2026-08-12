import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { BuiltinWorkflowCatalog } from "../src/workflows/catalog.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { migrateLegacyBuiltinRuns } from "../src/workflows/migrate-builtins.js";
import { WorkflowRunStore, readRunBundle } from "../src/workflows/store.js";
import type { WorkflowRunState } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

const workflow = defineWorkflow({
  name: "fixture",
  startAt: "done",
  nodes: { done: compute({ run: () => true }) },
  edges: [],
});

function catalog(revision = "r1") {
  return new BuiltinWorkflowCatalog([
    {
      id: "fixture",
      revision,
      definition: workflow,
      legacySources: [
        {
          workflowHash: "old-hash",
          revision: "r1",
          pathSuffixes: ["/builtins/fixture.workflow.js", "/workflows/fixture.workflow.js"],
        },
      ],
    },
  ]);
}

function legacyState(runId: string): WorkflowRunState {
  const now = new Date().toISOString();
  return {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 0,
    runId,
    workflowName: "fixture",
    workflowPath: "/package/dist/builtins/fixture.workflow.js",
    workflowHash: "old-hash",
    startedAt: now,
    updatedAt: now,
    status: "running",
    input: null,
    outputs: {},
    results: {},
    steps: [],
  };
}

describe("migrateLegacyBuiltinRuns", () => {
  it("rewrites a proved nonterminal bundle and its queue identity", async () => {
    const root = await makeTempDir("pi-workflows-migrate-builtins");
    const store = new WorkflowRunStore(root);
    const state = legacyState("legacy-run");
    const runDir = await store.initializeRunBundle(workflow, state);
    const queue = new SqliteControllerStore(path.join(root, "controller.sqlite"));
    queue.enqueueWorkflowRun({
      runId: "legacy-run",
      workflowName: "fixture",
      workflowSourceRef: state.workflowPath as string,
      input: null,
      runnerId: "old-runner",
      claimToken: "old-claim",
      leaseMs: 30_000,
    });
    queue.parkWorkflowRun({ runId: "legacy-run", claimToken: "old-claim" });

    const result = await migrateLegacyBuiltinRuns({ catalog: catalog(), store, queue });

    expect(result).toEqual({ migratedRunIds: ["legacy-run"], blocked: [] });
    expect(queue.getWorkflowRun("legacy-run")).toMatchObject({
      workflowName: "fixture",
      workflowSourceRef: "builtin:fixture",
      status: "parked",
    });
    queue.close();
    const bundle = await readRunBundle(runDir);
    const migrated = bundle?.state;
    expect(migrated?.workflowSource).toEqual({ kind: "builtin", id: "fixture", revision: "r1" });
    expect(migrated?.workflowPath).toBeUndefined();
    expect(migrated?.workflowHash).toBeUndefined();
    expect(bundle?.manifest.workflowSource).toEqual({
      kind: "builtin",
      id: "fixture",
      revision: "r1",
    });
    expect("workflowPath" in (bundle?.manifest ?? {})).toBe(false);
  });

  it("matches the old workflow directory used before the catalog", async () => {
    const root = await makeTempDir("pi-workflows-migrate-old-dir");
    const store = new WorkflowRunStore(root);
    const state = legacyState("old-dir-run");
    state.workflowPath = "/package/dist/workflows/fixture.workflow.js";
    const runDir = await store.initializeRunBundle(workflow, state);

    const result = await migrateLegacyBuiltinRuns({ catalog: catalog(), store });

    expect(result.migratedRunIds).toEqual(["old-dir-run"]);
    expect((await readRunBundle(runDir))?.state.workflowSource).toEqual({
      kind: "builtin",
      id: "fixture",
      revision: "r1",
    });
  });

  it("preserves the registered legacy revision across a direct upgrade", async () => {
    const root = await makeTempDir("pi-workflows-migrate-old-revision");
    const store = new WorkflowRunStore(root);
    const state = legacyState("old-revision-run");
    const runDir = await store.initializeRunBundle(workflow, state);

    const result = await migrateLegacyBuiltinRuns({ catalog: catalog("r2"), store });

    expect(result.migratedRunIds).toEqual(["old-revision-run"]);
    expect((await readRunBundle(runDir))?.state.workflowSource).toEqual({
      kind: "builtin",
      id: "fixture",
      revision: "r1",
    });
  });

  it("does not migrate an unknown hash or a terminal run", async () => {
    const root = await makeTempDir("pi-workflows-migrate-builtins-skip");
    const store = new WorkflowRunStore(root);
    const unknown = legacyState("unknown-run");
    unknown.workflowHash = "unknown";
    await store.initializeRunBundle(workflow, unknown);
    const terminal = legacyState("terminal-run");
    terminal.status = "completed";
    const terminalDir = await store.initializeRunBundle(workflow, terminal);

    const result = await migrateLegacyBuiltinRuns({ catalog: catalog(), store });

    expect(result).toEqual({
      migratedRunIds: [],
      blocked: [
        { runId: "unknown-run", reason: "legacy built-in fixture has an unknown source revision" },
      ],
    });
    expect((await readRunBundle(terminalDir))?.state.workflowPath).toBeDefined();
  });

  it("does not rewrite the bundle when its queue row cannot migrate", async () => {
    const root = await makeTempDir("pi-workflows-migrate-builtins-blocked");
    const store = new WorkflowRunStore(root);
    const state = legacyState("blocked-run");
    const runDir = await store.initializeRunBundle(workflow, state);

    const result = await migrateLegacyBuiltinRuns({
      catalog: catalog(),
      store,
      queue: {
        claimLegacyBuiltinWorkflowRun: () => false,
        parkWorkflowRun: () => false,
      },
    });

    expect(result.blocked).toHaveLength(1);
    expect((await readRunBundle(runDir))?.state.workflowPath).toBe(state.workflowPath);
    await expect(fs.stat(path.join(runDir, "state.json"))).resolves.toBeDefined();
  });
});
