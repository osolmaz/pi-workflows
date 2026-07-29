import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactWriter, encodeValue } from "./artifacts.js";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeSnapshot,
  WorkflowRunManifest,
  WorkflowRunState,
  WorkflowSessionBinding,
  WorkflowSessionEntryRecord,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
} from "./types.js";

export const RUN_BUNDLE_SCHEMA = "pi-workflows.run-bundle.v1" as const;
export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const TRACE_EVENT_SCHEMA = "pi-workflows.trace-event.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;

const MANIFEST_PATH = "manifest.json";
const WORKFLOW_SNAPSHOT_PATH = "workflow.json";
const STATE_PATH = "state.json";
const TRACE_PATH = "trace.ndjson";
const SESSION_DIR = "session";
const SESSION_BINDING_PATH = `${SESSION_DIR}/binding.json`;
const SESSION_ENTRIES_PATH = `${SESSION_DIR}/entries.ndjson`;

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

type RunBundleContext = {
  traceSeq: number;
  sessionSeq: number;
  sessionBound: boolean;
  artifacts: ArtifactWriter;
  /**
   * Serializes complete transitions (encode, trace append, projections) so
   * concurrent writers cannot interleave sequence assignment with physical
   * append order.
   */
  lock: Promise<unknown>;
};

/**
 * Persists run bundles (see docs/run-bundles.md). `trace.ndjson` is the
 * append-only source of truth; every transition appends the trace event
 * first, then atomically replaces `state.json` (carrying `traceSeq`) and
 * `manifest.json`. Large string leaves in persisted values are externalized
 * into content-addressed `artifacts/`. Bundles are private: directories are
 * 0700 and files 0600.
 */
export class WorkflowRunStore {
  readonly outputRoot: string;
  private readonly contexts = new Map<string, RunBundleContext>();

  constructor(outputRoot: string = workflowRunsBaseDir()) {
    this.outputRoot = outputRoot;
  }

  runDirFor(runId: string): string {
    return path.join(this.outputRoot, runId);
  }

  private contextFor(runDir: string): RunBundleContext {
    let context = this.contexts.get(runDir);
    if (!context) {
      context = {
        traceSeq: 0,
        sessionSeq: 0,
        sessionBound: false,
        artifacts: new ArtifactWriter(runDir),
        lock: Promise.resolve(),
      };
      this.contexts.set(runDir, context);
    }
    return context;
  }

  /**
   * Run `task` exclusively for this bundle. Sequence numbers are assigned
   * inside the lock, so physical file order always matches logical order.
   */
  private withRunLock<T>(runDir: string, task: () => Promise<T>): Promise<T> {
    const context = this.contextFor(runDir);
    const result = context.lock.then(task);
    context.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initializeRunBundle(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
  ): Promise<string> {
    const runDir = this.runDirFor(state.runId);
    this.contexts.delete(runDir);
    return await this.withRunLock(runDir, async () => {
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(
        path.join(runDir, WORKFLOW_SNAPSHOT_PATH),
        createDefinitionSnapshot(workflow),
      );
      await appendLine(path.join(runDir, TRACE_PATH), null);
      await this.writeProjections(runDir, state);
      return runDir;
    });
  }

  /**
   * Persist one transition: append the trace event, then rewrite the
   * projections reflecting it.
   */
  async writeSnapshot(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return await this.withRunLock(runDir, async () => {
      const traceEvent = await this.appendTraceEvent(runDir, state.runId, event);
      state.traceSeq = traceEvent.seq;
      state.updatedAt = new Date().toISOString();
      await this.writeProjections(runDir, state);
      return traceEvent;
    });
  }

  /**
   * Bind the run to a Pi conversation: write `session/binding.json` once and
   * append a `session_bound` trace event. Projections catch up on the next
   * snapshot.
   */
  async writeSessionBinding(runDir: string, binding: WorkflowSessionBinding): Promise<void> {
    await this.withRunLock(runDir, async () => {
      const context = this.contextFor(runDir);
      if (context.sessionBound) {
        return;
      }
      context.sessionBound = true;
      await fs.mkdir(path.join(runDir, SESSION_DIR), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path.join(runDir, SESSION_BINDING_PATH), binding);
      await this.appendTraceEvent(runDir, binding.runId, {
        scope: "session",
        type: "session_bound",
        payload: { piSessionId: binding.piSessionId },
      });
    });
  }

  /** Append one verbatim Pi session entry to `session/entries.ndjson`. */
  async appendSessionEntry(runDir: string, entry: Record<string, unknown>): Promise<number> {
    return await this.withRunLock(runDir, async () => {
      const context = this.contextFor(runDir);
      context.sessionSeq += 1;
      const record: WorkflowSessionEntryRecord = {
        seq: context.sessionSeq,
        at: new Date().toISOString(),
        entry,
      };
      await appendLine(path.join(runDir, SESSION_ENTRIES_PATH), record);
      return record.seq;
    });
  }

  private async appendTraceEvent(
    runDir: string,
    runId: string,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    const context = this.contextFor(runDir);
    const traceEvent: WorkflowTraceEvent = {
      seq: context.traceSeq + 1,
      at: new Date().toISOString(),
      runId,
      ...event,
      payload: (await encodeValue(event.payload, context.artifacts)) as Record<string, unknown>,
    };
    await appendLine(path.join(runDir, TRACE_PATH), traceEvent);
    context.traceSeq = traceEvent.seq;
    return traceEvent;
  }

  private async writeProjections(runDir: string, state: WorkflowRunState): Promise<void> {
    const context = this.contextFor(runDir);
    const encoded = await encodeRunState(state, context.artifacts);
    await writeJsonAtomic(path.join(runDir, STATE_PATH), encoded);
    await writeJsonAtomic(
      path.join(runDir, MANIFEST_PATH),
      createManifest(state, {
        session: context.sessionBound,
        artifacts: context.artifacts.hasArtifacts,
      }),
    );
  }
}

async function appendLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, value === null ? "" : `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Encode the externalizable value positions of the state document. The
 * in-memory state always holds raw values; the persisted copy may carry
 * `$artifact` references instead of large strings.
 */
async function encodeRunState(
  state: WorkflowRunState,
  artifacts: ArtifactWriter,
): Promise<WorkflowRunState> {
  const results = Object.fromEntries(
    await Promise.all(
      Object.entries(state.results).map(async ([nodeId, result]) => [
        nodeId,
        "output" in result
          ? { ...result, output: await encodeValue(result.output, artifacts) }
          : result,
      ]),
    ),
  ) as WorkflowRunState["results"];
  return {
    ...state,
    input: await encodeValue(state.input, artifacts),
    outputs: Object.fromEntries(
      await Promise.all(
        Object.entries(state.outputs).map(async ([nodeId, output]) => [
          nodeId,
          await encodeValue(output, artifacts),
        ]),
      ),
    ),
    results,
    steps: await Promise.all(
      state.steps.map(async (step) => ({
        ...step,
        prompt: (await encodeValue(
          step.prompt,
          artifacts,
        )) as WorkflowRunState["steps"][number]["prompt"],
        output: await encodeValue(step.output, artifacts),
      })),
    ),
    ...(state.finalOutput !== undefined
      ? { finalOutput: await encodeValue(state.finalOutput, artifacts) }
      : {}),
  };
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
  if (!manifest || manifest.schema !== RUN_BUNDLE_SCHEMA) {
    return null;
  }
  // A schema-tagged manifest may still be malformed (e.g. hand-edited);
  // treat anything unexpected as an unreadable bundle rather than throwing.
  const paths: Partial<WorkflowRunManifest["paths"]> =
    typeof manifest.paths === "object" && manifest.paths !== null ? manifest.paths : {};
  const state = await readJsonFile<WorkflowRunState>(
    resolveBundlePath(runDir, paths.state, STATE_PATH),
  );
  if (!state || state.schema !== RUN_STATE_SCHEMA) {
    return null;
  }
  const snapshot = await readJsonFile<WorkflowDefinitionSnapshot>(
    resolveBundlePath(runDir, paths.workflow, WORKFLOW_SNAPSHOT_PATH),
  );
  return { runDir, manifest, state, snapshot };
}

/**
 * Resolve a manifest-relative path, rejecting anything that is not a string
 * or escapes the bundle directory. Malformed manifests must degrade to an
 * unreadable bundle, never to a thrown error that aborts a listing.
 */
function resolveBundlePath(runDir: string, relative: unknown, fallback: string): string {
  const candidate = path.resolve(
    runDir,
    typeof relative === "string" && relative ? relative : fallback,
  );
  if (
    candidate !== path.resolve(runDir) &&
    !candidate.startsWith(path.resolve(runDir) + path.sep)
  ) {
    return path.join(runDir, fallback);
  }
  return candidate;
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

function createManifest(
  state: WorkflowRunState,
  present: { session: boolean; artifacts: boolean },
): WorkflowRunManifest {
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
      ...(present.session ? { session: SESSION_DIR } : {}),
      ...(present.artifacts ? { artifacts: "artifacts" } : {}),
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
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}
