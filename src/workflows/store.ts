import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeSnapshot,
  WorkflowRunManifest,
  WorkflowRunState,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
} from "./types.js";

export const RUN_BUNDLE_SCHEMA = "pi-workflows.run-bundle.v1" as const;
export const TRACE_EVENT_SCHEMA = "pi-workflows.trace-event.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;

const MANIFEST_PATH = "manifest.json";
const WORKFLOW_SNAPSHOT_PATH = "workflow.json";
const STATE_PATH = "state.json";
const TRACE_PATH = "trace.ndjson";

/** Runs directory: `$PI_WORKFLOWS_RUNS_DIR` or `~/.pi/agent/workflows/runs`. */
export function workflowRunsBaseDir(homeDir: string = os.homedir()): string {
  const override = process.env.PI_WORKFLOWS_RUNS_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(homeDir, ".pi", "agent", "workflows", "runs");
}

export function createRunId(workflowName: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const slug = workflowName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${stamp}-${slug || "workflow"}-${randomUUID().slice(0, 8)}`;
}

/**
 * Persists run bundles. A bundle directory contains `manifest.json`,
 * `workflow.json` (definition snapshot), `state.json` (full run projection,
 * atomically replaced), and `trace.ndjson` (append-only event log).
 */
export class WorkflowRunStore {
  readonly outputRoot: string;
  private readonly traceSeqByRun = new Map<string, number>();
  private readonly appendChainByPath = new Map<string, Promise<void>>();

  constructor(outputRoot: string = workflowRunsBaseDir()) {
    this.outputRoot = outputRoot;
  }

  runDirFor(runId: string): string {
    return path.join(this.outputRoot, runId);
  }

  async initializeRunBundle(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
  ): Promise<string> {
    const runDir = this.runDirFor(state.runId);
    await fs.mkdir(runDir, { recursive: true });
    this.traceSeqByRun.set(runDir, 0);

    await writeJsonAtomic(
      path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
      createDefinitionSnapshot(workflow),
    );
    await writeJsonAtomic(path.join(runDir, MANIFEST_PATH), createManifest(state));
    await writeJsonAtomic(path.join(runDir, STATE_PATH), state);
    await this.appendJsonLine(path.join(runDir, TRACE_PATH), null);

    return runDir;
  }

  async writeSnapshot(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(runDir, STATE_PATH), state);
    await writeJsonAtomic(path.join(runDir, MANIFEST_PATH), createManifest(state));
    return await this.appendTrace(runDir, state, event);
  }

  async appendTrace(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    const traceEvent: WorkflowTraceEvent = {
      seq: this.nextTraceSeq(runDir),
      at: new Date().toISOString(),
      runId: state.runId,
      ...event,
    };
    await this.appendJsonLine(path.join(runDir, TRACE_PATH), traceEvent);
    return traceEvent;
  }

  private nextTraceSeq(runDir: string): number {
    const next = (this.traceSeqByRun.get(runDir) ?? 0) + 1;
    this.traceSeqByRun.set(runDir, next);
    return next;
  }

  private async appendJsonLine(filePath: string, value: unknown): Promise<void> {
    const prior = this.appendChainByPath.get(filePath) ?? Promise.resolve();
    const nextWrite = prior.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, value === null ? "" : `${JSON.stringify(value)}\n`, "utf8");
    });
    const tracked = nextWrite.finally(() => {
      if (this.appendChainByPath.get(filePath) === tracked) {
        this.appendChainByPath.delete(filePath);
      }
    });
    this.appendChainByPath.set(filePath, tracked);
    await tracked;
  }
}

export type LoadedRunBundle = {
  runDir: string;
  manifest: WorkflowRunManifest;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot | null;
};

/** Read a run bundle from disk. Returns null when the bundle is unreadable. */
export async function readRunBundle(runDir: string): Promise<LoadedRunBundle | null> {
  const manifest = await readJsonFile<WorkflowRunManifest>(path.join(runDir, MANIFEST_PATH));
  const state = await readJsonFile<WorkflowRunState>(path.join(runDir, STATE_PATH));
  if (!manifest || !state || manifest.schema !== RUN_BUNDLE_SCHEMA) {
    return null;
  }
  const snapshot = await readJsonFile<WorkflowDefinitionSnapshot>(
    path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
  );
  return { runDir, manifest, state, snapshot };
}

/** List run bundles under `outputRoot`, most recently started first. */
export async function listRunBundles(outputRoot: string): Promise<LoadedRunBundle[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputRoot);
  } catch {
    return [];
  }
  const bundles: LoadedRunBundle[] = [];
  for (const entry of entries) {
    const bundle = await readRunBundle(path.join(outputRoot, entry));
    if (bundle) {
      bundles.push(bundle);
    }
  }
  bundles.sort((a, b) => b.state.startedAt.localeCompare(a.state.startedAt));
  return bundles;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function createManifest(state: WorkflowRunState): WorkflowRunManifest {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: state.runId,
    workflowName: state.workflowName,
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(state.workflowPath !== undefined ? { workflowPath: state.workflowPath } : {}),
    startedAt: state.startedAt,
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    status: state.status,
    traceSchema: TRACE_EVENT_SCHEMA,
    paths: {
      workflow: WORKFLOW_SNAPSHOT_PATH,
      state: STATE_PATH,
      trace: TRACE_PATH,
    },
  };
}

export function createDefinitionSnapshot(workflow: WorkflowDefinition): WorkflowDefinitionSnapshot {
  return {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    name: workflow.name,
    startAt: workflow.startAt,
    nodes: Object.fromEntries(
      Object.entries(workflow.nodes).map(([nodeId, node]) => [nodeId, snapshotNode(node)]),
    ),
    edges: structuredClone(workflow.edges),
  };
}

function snapshotNode(node: WorkflowNodeDefinition): WorkflowNodeSnapshot {
  const common: WorkflowNodeSnapshot = {
    nodeType: node.nodeType,
    ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  if (node.nodeType === "agent" && node.expectedOutput !== undefined) {
    common.expectedOutput = node.expectedOutput;
  }
  if (node.nodeType === "checkpoint" && node.summary !== undefined) {
    common.summary = node.summary;
  }
  if (node.nodeType === "action") {
    common.actionExecution = "exec" in node ? "shell" : "function";
  }
  return common;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
