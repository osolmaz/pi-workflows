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
  WorkflowSessionCapture,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
} from "./types.js";

export const RUN_BUNDLE_SCHEMA = "pi-workflows.run-bundle.v1" as const;
export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const TRACE_EVENT_SCHEMA = "pi-workflows.trace-event.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;
export const SESSION_EVENT_SCHEMA = "pi-workflows.session-event.v1" as const;
export const SESSION_CAPTURE_SCHEMA = "pi-workflows.session-capture.v1" as const;
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;

const MANIFEST_PATH = "manifest.json";
const WORKFLOW_SNAPSHOT_PATH = "workflow.json";
const STATE_PATH = "state.json";
const TRACE_PATH = "trace.ndjson";
const SESSION_DIR = "session";
const SESSION_BINDING_PATH = `${SESSION_DIR}/binding.json`;
const SESSION_ENTRIES_PATH = `${SESSION_DIR}/entries.ndjson`;
const SESSION_EVENTS_PATH = `${SESSION_DIR}/events.ndjson`;
const SESSION_CAPTURE_PATH = `${SESSION_DIR}/capture.json`;
const SESSION_SEGMENTS_DIR = `${SESSION_DIR}/segments`;

/** Capture file layout for one recorder attempt; "" is the legacy flat stream. */
function sessionStreamPaths(attemptId?: string): {
  dir: string;
  binding: string;
  entries: string;
  events: string;
  capture: string;
} {
  if (attemptId === undefined) {
    return {
      dir: SESSION_DIR,
      binding: SESSION_BINDING_PATH,
      entries: SESSION_ENTRIES_PATH,
      events: SESSION_EVENTS_PATH,
      capture: SESSION_CAPTURE_PATH,
    };
  }
  assertValidRunId(attemptId);
  const dir = `${SESSION_SEGMENTS_DIR}/${attemptId}`;
  return {
    dir,
    binding: `${dir}/binding.json`,
    entries: `${dir}/entries.ndjson`,
    events: `${dir}/events.ndjson`,
    capture: `${dir}/capture.json`,
  };
}

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

/** Per-attempt capture stream state; the "" key is the legacy flat stream. */
type SessionStreamState = {
  sessionSeq: number;
  sessionEventSeq: number;
  sessionBound: boolean;
  sessionEventsStopped: boolean;
  /** Session events have a separate append chain so token traffic cannot
   * queue ahead of workflow transitions. */
  lock: Promise<unknown>;
};

type RunBundleContext = {
  traceSeq: number;
  artifacts: ArtifactWriter;
  /**
   * Serializes complete transitions (encode, trace append, projections) so
   * concurrent writers cannot interleave sequence assignment with physical
   * append order.
   */
  lock: Promise<unknown>;
  streams: Map<string, SessionStreamState>;
};

/**
 * Persists run bundles (see docs/run-bundles.md). `trace.ndjson` is the
 * append-only source of truth; every transition appends the trace event
 * first, then atomically replaces `state.json` (carrying `traceSeq`) and
 * `manifest.json`. Large string leaves in persisted values are externalized
 * into content-addressed `artifacts/`. Bundles are private: directories are
 * 0700 and files 0600.
 */
/**
 * A fence proves the writer still owns the run. It is checked before every
 * locked write; it throws (ClaimLostError) when the queue claim was lost, so
 * a stalled runner can never interleave writes with the new claim holder.
 */
export type RunFence = () => void;

export type WorkflowRunStoreOptions = {
  fenceProvider?: (runDir: string) => RunFence | undefined;
};

export class WorkflowRunStore {
  readonly outputRoot: string;
  private readonly fenceProvider: ((runDir: string) => RunFence | undefined) | undefined;
  private readonly contexts = new Map<string, RunBundleContext>();

  constructor(outputRoot: string = workflowRunsBaseDir(), options: WorkflowRunStoreOptions = {}) {
    this.outputRoot = outputRoot;
    this.fenceProvider = options.fenceProvider;
  }

  runDirFor(runId: string): string {
    assertValidRunId(runId);
    return path.join(this.outputRoot, runId);
  }

  async quarantineIncompleteRun(runId: string): Promise<string | undefined> {
    const runDir = this.runDirFor(runId);
    let runStat;
    try {
      runStat = await fs.lstat(runDir);
    } catch (error) {
      if (isMissingPath(error)) {
        return undefined;
      }
      throw error;
    }
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      throw new Error(`Reserved workflow run path is not a directory: ${runDir}`);
    }
    try {
      await fs.lstat(path.join(runDir, MANIFEST_PATH));
      throw new Error(`Reserved workflow run has an unreadable manifest: ${runId}`);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    const quarantineDir = path.join(
      this.outputRoot,
      `.${runId}.incomplete-${randomUUID().slice(0, 8)}`,
    );
    await fs.rename(runDir, quarantineDir);
    this.contexts.delete(runDir);
    return quarantineDir;
  }

  private contextFor(runDir: string): RunBundleContext {
    let context = this.contexts.get(runDir);
    if (!context) {
      context = {
        traceSeq: 0,
        artifacts: new ArtifactWriter(runDir),
        lock: Promise.resolve(),
        streams: new Map(),
      };
      this.contexts.set(runDir, context);
    }
    return context;
  }

  private streamFor(runDir: string, attemptId?: string): SessionStreamState {
    const context = this.contextFor(runDir);
    const key = attemptId ?? "";
    let stream = context.streams.get(key);
    if (!stream) {
      stream = {
        sessionSeq: 0,
        sessionEventSeq: 0,
        sessionBound: false,
        sessionEventsStopped: false,
        lock: Promise.resolve(),
      };
      context.streams.set(key, stream);
    }
    return stream;
  }

  /**
   * Run `task` exclusively for this bundle. Sequence numbers are assigned
   * inside the lock, so physical file order always matches logical order.
   */
  private withRunLock<T>(runDir: string, task: () => Promise<T>): Promise<T> {
    const context = this.contextFor(runDir);
    const result = context.lock.then(async () => {
      this.fenceProvider?.(runDir)?.();
      return await task();
    });
    context.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withSessionEventLock<T>(
    runDir: string,
    attemptId: string | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const stream = this.streamFor(runDir, attemptId);
    const result = stream.lock.then(async () => {
      this.fenceProvider?.(runDir)?.();
      return await task();
    });
    stream.lock = result.then(
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
    return await this.withRunLock(runDir, async () => {
      await fs.mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(runDir, { recursive: false, mode: 0o700 });
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
   * Prepare an interrupted bundle for resume. Repairs a torn trace tail,
   * drops trace events the state projection never recorded, and seeds the
   * in-process context so new events continue the sequence. The caller must
   * hold the run's queue claim; the fence is verified before any write.
   */
  async prepareRunResume(runId: string): Promise<LoadedRunBundle> {
    const runDir = this.runDirFor(runId);
    this.fenceProvider?.(runDir)?.();
    const bundle = await readRunBundle(runDir);
    if (bundle === null) {
      throw new Error(`Cannot resume unreadable workflow run: ${runId}`);
    }
    if (bundle.state.status !== "running") {
      throw new Error(`Cannot resume workflow run ${runId} with status ${bundle.state.status}`);
    }
    const tracePath = resolveBundlePath(runDir, bundle.manifest.paths.trace, TRACE_PATH);
    await repairTraceFile(tracePath, bundle.state.traceSeq, () => {
      // The repair rewrites the trace; re-verify ownership immediately
      // before the rename so a stalled runner cannot truncate a new claim
      // holder's appended events.
      this.fenceProvider?.(runDir)?.();
    });

    // A crashed session never finalizes its capture, and resuming recorders
    // always write new segments — so dangling "recording" captures end here
    // instead of reporting the run capture-corrupt forever.
    await this.finalizeRecordingCaptures(runDir, "Workflow host stopped before the run finished");

    const counts = await this.sessionCounts(runDir);
    const captureFinished =
      bundle.sessionCapture?.status === "complete" || bundle.sessionCapture?.status === "failed";
    this.contexts.set(runDir, {
      traceSeq: bundle.state.traceSeq,
      artifacts: new ArtifactWriter(runDir),
      lock: Promise.resolve(),
      streams: seededStreams({
        sessionSeq: counts.entryCount,
        sessionEventSeq: counts.lastEventSeq,
        sessionBound: bundle.manifest.paths.session !== undefined,
        sessionEventsStopped: captureFinished,
      }),
    });
    const prepared = await readRunBundle(runDir);
    if (prepared === null) {
      throw new Error(`Workflow run ${runId} became unreadable during resume preparation`);
    }
    return prepared;
  }

  /**
   * Finalize captures left "recording" by a session that is gone, so they
   * report failed with the reason instead of dangling forever.
   */
  private async finalizeRecordingCaptures(
    runDir: string,
    reason: string,
    options: { skipFlat?: boolean } = {},
  ): Promise<void> {
    if (options.skipFlat !== true) {
      const flatCapture = await readJsonFile<WorkflowSessionCapture>(
        path.join(runDir, SESSION_CAPTURE_PATH),
      );
      if (flatCapture?.status === "recording") {
        const counts = await this.sessionCounts(runDir);
        await this.writeSessionCapture(runDir, {
          schema: SESSION_CAPTURE_SCHEMA,
          eventSchema: SESSION_EVENT_SCHEMA,
          status: "failed",
          ...counts,
          failure: {
            failedAt: new Date().toISOString(),
            code: "host_interrupted",
            message: reason,
          },
        });
      }
    }
    for (const segmentId of await this.listSessionSegments(runDir)) {
      const segmentCapture = await readJsonFile<WorkflowSessionCapture>(
        path.join(runDir, sessionStreamPaths(segmentId).capture),
      );
      if (segmentCapture?.status !== "recording") {
        continue;
      }
      const segmentCounts = await this.sessionCounts(runDir, segmentId);
      await this.writeSessionCapture(
        runDir,
        {
          schema: SESSION_CAPTURE_SCHEMA,
          eventSchema: SESSION_EVENT_SCHEMA,
          status: "failed",
          ...segmentCounts,
          failure: {
            failedAt: new Date().toISOString(),
            code: "host_interrupted",
            message: reason,
          },
        },
        segmentId,
      );
    }
  }

  /** Mark a nonterminal bundle failed and append an interruption event. */
  async markRunInterrupted(
    runId: string,
    reason = "Workflow host stopped before the run finished",
  ): Promise<LoadedRunBundle | null> {
    const runDir = this.runDirFor(runId);
    const bundle = await readRunBundle(runDir);
    if (bundle === null || bundle.state.status !== "running") {
      return bundle;
    }
    const lastTraceEvent = await readLastTraceEvent(runDir, bundle.manifest.paths.trace);
    const counts = await this.sessionCounts(runDir);
    const sessionBound = bundle.manifest.paths.session !== undefined;
    const captureFinished =
      bundle.sessionCapture?.status === "complete" || bundle.sessionCapture?.status === "failed";
    this.contexts.set(runDir, {
      traceSeq: Math.max(bundle.state.traceSeq, lastTraceEvent?.seq ?? 0),
      artifacts: new ArtifactWriter(runDir),
      lock: Promise.resolve(),
      streams: seededStreams({
        sessionSeq: counts.entryCount,
        sessionEventSeq: counts.lastEventSeq,
        sessionBound,
        sessionEventsStopped: captureFinished,
      }),
    });
    const state = bundle.state;
    if (lastTraceEvent !== null && recoverTerminalProjection(state, lastTraceEvent)) {
      await this.writeLoadedProjections(runDir, state);
      return await readRunBundle(runDir);
    }
    if (sessionBound && !captureFinished) {
      await this.writeSessionCapture(runDir, {
        schema: SESSION_CAPTURE_SCHEMA,
        eventSchema: SESSION_EVENT_SCHEMA,
        status: "failed",
        ...counts,
        failure: {
          failedAt: new Date().toISOString(),
          code: "host_interrupted",
          message: reason,
        },
      });
    }
    await this.finalizeRecordingCaptures(runDir, reason, { skipFlat: true });
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    state.error = reason;
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeStartedAt;
    delete state.statusDetail;
    delete state.paused;
    await this.withRunLock(runDir, async () => {
      const traceEvent = await this.appendTraceEvent(runDir, state.runId, {
        scope: "run",
        type: "run_interrupted",
        payload: { error: reason },
      });
      state.traceSeq = traceEvent.seq;
      state.updatedAt = traceEvent.at;
      await this.writeLoadedProjections(runDir, state);
    });
    return await readRunBundle(runDir);
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
  /** True when a session binding already exists for this bundle. */
  async hasSessionBinding(runDir: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(runDir, SESSION_BINDING_PATH));
      return true;
    } catch {
      return false;
    }
  }

  /** List capture segment attempt ids under `session/segments/`. */
  async listSessionSegments(runDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(runDir, SESSION_SEGMENTS_DIR), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async writeSessionBinding(
    runDir: string,
    binding: WorkflowSessionBinding,
    attemptId?: string,
  ): Promise<void> {
    await this.withRunLock(runDir, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (stream.sessionBound) {
        return;
      }
      stream.sessionBound = true;
      const paths = sessionStreamPaths(attemptId);
      await fs.mkdir(path.join(runDir, paths.dir), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(path.join(runDir, paths.binding), binding);
      await this.appendTraceEvent(runDir, binding.runId, {
        scope: "session",
        type: "session_bound",
        payload: {
          piSessionId: binding.piSessionId,
          ...(attemptId !== undefined ? { captureAttemptId: attemptId } : {}),
        },
      });
    });
  }

  /** Append one verbatim Pi session entry to `session/entries.ndjson`. */
  async appendSessionEntry(
    runDir: string,
    entry: Record<string, unknown>,
    attemptId?: string,
  ): Promise<number> {
    return await this.withRunLock(runDir, async () => {
      const stream = this.streamFor(runDir, attemptId);
      stream.sessionSeq += 1;
      const record: WorkflowSessionEntryRecord = {
        seq: stream.sessionSeq,
        at: new Date().toISOString(),
        entry,
      };
      await appendLine(path.join(runDir, sessionStreamPaths(attemptId).entries), record);
      return record.seq;
    });
  }

  /** Append a fully stamped ordered batch to `session/events.ndjson`. */
  async appendSessionEventBatch(
    runDir: string,
    records: WorkflowSessionEventRecord[],
    attemptId?: string,
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await this.withSessionEventLock(runDir, attemptId, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (stream.sessionEventsStopped) {
        throw new Error("Session event capture has stopped");
      }
      try {
        let expected = stream.sessionEventSeq + 1;
        for (const record of records) {
          validateSessionEventRecord(record);
          if (record.seq !== expected) {
            throw new Error(`Expected session event seq ${expected}, got ${record.seq}`);
          }
          expected += 1;
        }
        const encoded = await Promise.all(
          records.map(async (record) => ({
            ...record,
            payload:
              record.type === "tool_execution_started" ||
              record.type === "tool_execution_finished" ||
              (record.type === "assistant_event" && record.payload.type === "toolcall_end")
                ? ((await encodeValue(record.payload, this.contextFor(runDir).artifacts)) as Record<
                    string,
                    unknown
                  >)
                : record.payload,
          })),
        );
        for (const record of encoded) {
          if (Buffer.byteLength(JSON.stringify(record), "utf8") + 1 > SESSION_EVENT_MAX_BYTES) {
            throw new Error(`session event exceeded ${SESSION_EVENT_MAX_BYTES} bytes`);
          }
        }
        await appendLines(path.join(runDir, sessionStreamPaths(attemptId).events), encoded);
        stream.sessionEventSeq = records.at(-1)?.seq ?? stream.sessionEventSeq;
      } catch (error) {
        stream.sessionEventsStopped = true;
        throw error;
      }
    });
  }

  /** Atomically replace the temporal capture integrity projection. */
  async writeSessionCapture(
    runDir: string,
    capture: WorkflowSessionCapture,
    attemptId?: string,
  ): Promise<void> {
    validateSessionCapture(capture);
    await this.withSessionEventLock(runDir, attemptId, async () => {
      const stream = this.streamFor(runDir, attemptId);
      if (capture.status !== "recording") {
        stream.sessionEventsStopped = true;
      }
      await writeJsonAtomic(path.join(runDir, sessionStreamPaths(attemptId).capture), capture);
    });
  }

  /** Count complete durable session records after both writers have drained. */
  async sessionCounts(
    runDir: string,
    attemptId?: string,
  ): Promise<{ eventCount: number; entryCount: number; lastEventSeq: number }> {
    const paths = sessionStreamPaths(attemptId);
    const events = await readCompleteNdjson(path.join(runDir, paths.events));
    const entries = await readCompleteNdjson(path.join(runDir, paths.entries));
    return {
      eventCount: events.length,
      entryCount: entries.length,
      lastEventSeq: events.at(-1)?.seq ?? 0,
    };
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
        session: [...context.streams.values()].some((stream) => stream.sessionBound),
      }),
    );
  }

  private async writeLoadedProjections(runDir: string, state: WorkflowRunState): Promise<void> {
    const context = this.contextFor(runDir);
    await writeJsonAtomic(path.join(runDir, STATE_PATH), state);
    await writeJsonAtomic(
      path.join(runDir, MANIFEST_PATH),
      createManifest(state, {
        session: [...context.streams.values()].some((stream) => stream.sessionBound),
      }),
    );
  }
}

/**
 * Truncate a trace file to the longest contiguous valid prefix, then to the
 * event count the state projection recorded. A crash can leave a partial
 * final line or one event appended before its projection write; the repair
 * keeps state and trace consistent so resume can continue the sequence. The
 * rewrite is atomic: a stale writer appending to the old inode cannot
 * interleave with the repaired file.
 */
async function repairTraceFile(
  tracePath: string,
  keepSeq: number,
  beforeWrite?: () => void,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(tracePath, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const good: string[] = [];
  let expectedSeq = 1;
  for (const line of lines) {
    if (line.trim().length === 0) {
      break;
    }
    try {
      const event = JSON.parse(line) as { seq?: unknown };
      if (event.seq !== expectedSeq) {
        break;
      }
      good.push(line);
      expectedSeq += 1;
    } catch {
      break;
    }
  }
  const kept = good.slice(0, keepSeq);
  if (kept.length === lines.length) {
    return;
  }
  beforeWrite?.();
  const tempPath = `${tracePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, kept.length === 0 ? "" : `${kept.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, tracePath);
}

function seededStreams(flat: Omit<SessionStreamState, "lock">): Map<string, SessionStreamState> {
  return new Map([["", { ...flat, lock: Promise.resolve() }]]);
}

function recoverTerminalProjection(state: WorkflowRunState, event: WorkflowTraceEvent): boolean {
  const status = terminalStatusForEvent(event.type);
  if (status === undefined) {
    return false;
  }
  state.traceSeq = event.seq;
  state.status = status;
  state.updatedAt = event.at;
  state.finishedAt = event.at;
  if (typeof event.payload.error === "string") {
    state.error = event.payload.error;
  }
  if (typeof event.payload.waitingOn === "string") {
    state.waitingOn = event.payload.waitingOn;
  }
  if (Object.hasOwn(event.payload, "finalOutput")) {
    state.finalOutput = event.payload.finalOutput;
  }
  delete state.currentNode;
  delete state.currentAttemptId;
  delete state.currentNodeStartedAt;
  return true;
}

function terminalStatusForEvent(type: string): WorkflowRunState["status"] | undefined {
  switch (type) {
    case "run_waiting":
      return "waiting";
    case "run_completed":
      return "completed";
    case "run_failed":
    case "run_interrupted":
      return "failed";
    case "run_timed_out":
      return "timed_out";
    case "run_cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function assertValidRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
    throw new Error(`Invalid workflow run id: ${JSON.stringify(runId)}`);
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function appendLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, value === null ? "" : `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function appendLines(filePath: string, values: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = values.map((value) => `${JSON.stringify(value)}\n`).join("");
  await fs.appendFile(filePath, text, { encoding: "utf8", mode: 0o600 });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateSessionEventRecord(record: WorkflowSessionEventRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error("Session event seq must be a positive safe integer");
  }
  if (
    !isNonEmptyString(record.at) ||
    !isNonEmptyString(record.nodeId) ||
    !isNonEmptyString(record.attemptId) ||
    !isNonEmptyString(record.type) ||
    typeof record.payload !== "object" ||
    record.payload === null ||
    Array.isArray(record.payload)
  ) {
    throw new Error("Session event is missing required envelope fields");
  }
  const knownType = [
    "turn_started",
    "turn_finished",
    "message_started",
    "assistant_event",
    "message_finished",
    "tool_execution_started",
    "tool_execution_updated",
    "tool_execution_finished",
  ].includes(record.type);
  if (!knownType) {
    return;
  }
  if (!isNonEmptyString(record.turnId)) {
    throw new Error(`${record.type} requires turnId`);
  }
  if (
    !["turn_started", "turn_finished"].includes(record.type) &&
    !isNonEmptyString(record.messageId)
  ) {
    throw new Error(`${record.type} requires messageId`);
  }
  if (record.type.startsWith("tool_execution_") && !isNonEmptyString(record.toolCallId)) {
    throw new Error(`${record.type} requires toolCallId`);
  }
}

function sessionRelationshipDiagnostics(
  entries: WorkflowSessionEntryRecord[],
  events: WorkflowSessionEventRecord[],
): string[] {
  const entryIds = new Set(
    entries.flatMap((record) => (isNonEmptyString(record.entry.id) ? [record.entry.id] : [])),
  );
  const turns = new Set<string>();
  const messages = new Set<string>();
  const tools = new Set<string>();
  const diagnostics: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case "turn_started":
        if (event.turnId) turns.add(event.turnId);
        break;
      case "turn_finished":
        if (!event.turnId || !turns.has(event.turnId)) {
          diagnostics.push(`turn_finished ${event.seq} precedes turn_started`);
        }
        break;
      case "message_started":
        if (!event.turnId || !turns.has(event.turnId)) {
          diagnostics.push(`message_started ${event.seq} precedes turn_started`);
        }
        if (event.messageId) messages.add(event.messageId);
        break;
      case "assistant_event":
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`assistant_event ${event.seq} precedes message_started`);
        }
        break;
      case "message_finished": {
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`message_finished ${event.seq} precedes message_started`);
        }
        const settled = event.payload.settled;
        const entryId = event.payload.entryId;
        if (settled === true && (!isNonEmptyString(entryId) || !entryIds.has(entryId))) {
          diagnostics.push(`message_finished ${event.seq} references a missing entry`);
        } else if (settled !== true && entryId !== undefined) {
          diagnostics.push(`message_finished ${event.seq} has entryId while unsettled`);
        }
        break;
      }
      case "tool_execution_started":
        if (!event.messageId || !messages.has(event.messageId)) {
          diagnostics.push(`tool_execution_started ${event.seq} precedes message_started`);
        }
        if (event.toolCallId) tools.add(event.toolCallId);
        break;
      case "tool_execution_updated":
      case "tool_execution_finished":
        if (!event.toolCallId || !tools.has(event.toolCallId)) {
          diagnostics.push(`${event.type} ${event.seq} precedes tool_execution_started`);
        }
        break;
      default:
        break;
    }
  }
  return diagnostics;
}

function validateSessionCapture(capture: WorkflowSessionCapture): void {
  if (
    capture.schema !== SESSION_CAPTURE_SCHEMA ||
    capture.eventSchema !== SESSION_EVENT_SCHEMA ||
    !["recording", "complete", "failed"].includes(capture.status) ||
    !Number.isSafeInteger(capture.eventCount) ||
    capture.eventCount < 0 ||
    !Number.isSafeInteger(capture.entryCount) ||
    capture.entryCount < 0 ||
    !Number.isSafeInteger(capture.lastEventSeq) ||
    capture.lastEventSeq < 0
  ) {
    throw new Error("Invalid session capture projection");
  }
  if (capture.status === "failed" && capture.failure === undefined) {
    throw new Error("Failed session capture requires failure details");
  }
  if (capture.status !== "failed" && capture.failure !== undefined) {
    throw new Error("Only failed session capture may contain failure details");
  }
}

async function readCompleteNdjson(filePath: string): Promise<Array<{ seq: number }>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) {
    lines.pop();
  }
  const records: Array<{ seq: number }> = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value = JSON.parse(line) as { seq?: unknown };
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
        break;
      }
      records.push({ seq: value.seq as number });
    } catch {
      break;
    }
  }
  return records;
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

export type SessionCaptureIntegrity = {
  status: "unavailable" | "recording" | "complete" | "failed" | "invalid";
  diagnostics: string[];
};

/** One capture attempt: the session data a single recorder wrote. */
export type SessionCaptureSegment = {
  attemptId: string;
  binding: WorkflowSessionBinding | null;
  entries: WorkflowSessionEntryRecord[];
  events: WorkflowSessionEventRecord[];
  capture: WorkflowSessionCapture | null;
  integrity: SessionCaptureIntegrity;
};

export type LoadedRunBundle = {
  runDir: string;
  manifest: WorkflowRunManifest;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot | null;
  sessionBinding: WorkflowSessionBinding | null;
  sessionEntries: WorkflowSessionEntryRecord[];
  sessionEvents: WorkflowSessionEventRecord[];
  sessionCapture: WorkflowSessionCapture | null;
  sessionIntegrity: SessionCaptureIntegrity;
  /** Per-attempt captures written after a handoff or resume. */
  sessionSegments: SessionCaptureSegment[];
};

/** Read the final trace record without loading the rest of a run bundle. */
export async function readLastTraceEvent(
  runDir: string,
  tracePath?: string,
): Promise<WorkflowTraceEvent | null> {
  const events = await readNdjsonFile<WorkflowTraceEvent>(
    resolveBundlePath(runDir, tracePath, TRACE_PATH),
  );
  return events.records.at(-1) ?? null;
}

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
  const sessionDir = resolveBundlePath(runDir, paths.session, SESSION_DIR);
  const sessionBinding = await readJsonFile<WorkflowSessionBinding>(
    path.join(sessionDir, "binding.json"),
  );
  const entries = await readNdjsonFile<WorkflowSessionEntryRecord>(
    path.join(sessionDir, "entries.ndjson"),
  );
  const events = await readNdjsonFile<WorkflowSessionEventRecord>(
    path.join(sessionDir, "events.ndjson"),
  );
  const sessionCapture = await readJsonFile<WorkflowSessionCapture>(
    path.join(sessionDir, "capture.json"),
  );
  const flatIntegrity = assessSessionIntegrity({
    binding: sessionBinding,
    entries,
    events,
    capture: sessionCapture,
    runTerminal: state.status !== "running",
  });
  const sessionSegments: SessionCaptureSegment[] = [];
  let segmentIds: string[] = [];
  try {
    segmentIds = (await fs.readdir(path.join(sessionDir, "segments"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No segments directory means only the flat stream can exist.
  }
  for (const attemptId of segmentIds) {
    const segmentDir = path.join(sessionDir, "segments", attemptId);
    const binding = await readJsonFile<WorkflowSessionBinding>(
      path.join(segmentDir, "binding.json"),
    );
    const segmentEntries = await readNdjsonFile<WorkflowSessionEntryRecord>(
      path.join(segmentDir, "entries.ndjson"),
    );
    const segmentEvents = await readNdjsonFile<WorkflowSessionEventRecord>(
      path.join(segmentDir, "events.ndjson"),
    );
    const capture = await readJsonFile<WorkflowSessionCapture>(
      path.join(segmentDir, "capture.json"),
    );
    sessionSegments.push({
      attemptId,
      binding,
      entries: segmentEntries.records,
      events: segmentEvents.records,
      capture,
      integrity: assessSessionIntegrity({
        binding,
        entries: segmentEntries,
        events: segmentEvents,
        capture,
        runTerminal: state.status !== "running",
      }),
    });
  }
  // The headline integrity is the flat stream's when present; otherwise the
  // chronologically latest capture segment speaks for the run (segment ids
  // are random, so directory order says nothing about time).
  sessionSegments.sort((a, b) =>
    (a.binding?.boundAt ?? "").localeCompare(b.binding?.boundAt ?? ""),
  );
  const sessionIntegrity =
    flatIntegrity.status !== "unavailable" || sessionSegments.length === 0
      ? flatIntegrity
      : (sessionSegments.at(-1)?.integrity ?? flatIntegrity);
  return {
    runDir,
    manifest,
    state,
    snapshot,
    sessionBinding,
    sessionEntries: entries.records,
    sessionEvents: events.records,
    sessionCapture,
    sessionIntegrity,
    sessionSegments,
  };
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

type NdjsonRead<T> = {
  records: T[];
  exists: boolean;
  tornTail: boolean;
  malformed: boolean;
};

async function readNdjsonFile<T>(filePath: string): Promise<NdjsonRead<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { records: [], exists: false, tornTail: false, malformed: false };
  }
  const tornTail = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  if (tornTail) {
    lines.pop();
  }
  const records: T[] = [];
  let malformed = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      malformed = true;
    }
  }
  return { records, exists: true, tornTail, malformed };
}

function assessSessionIntegrity(input: {
  binding: WorkflowSessionBinding | null;
  entries: NdjsonRead<WorkflowSessionEntryRecord>;
  events: NdjsonRead<WorkflowSessionEventRecord>;
  capture: WorkflowSessionCapture | null;
  runTerminal: boolean;
}): SessionCaptureIntegrity {
  const anySessionFile =
    input.binding !== null || input.entries.exists || input.events.exists || input.capture !== null;
  if (!anySessionFile) {
    return { status: "unavailable", diagnostics: [] };
  }
  const diagnostics: string[] = [];
  if (!input.binding || input.binding.schema !== SESSION_BINDING_SCHEMA) {
    diagnostics.push("missing or invalid session binding");
  }
  if (!input.capture) {
    diagnostics.push("missing session capture status");
    return { status: "invalid", diagnostics };
  }
  try {
    validateSessionCapture(input.capture);
  } catch (error) {
    diagnostics.push(failureMessageForDiagnostic(error));
    return { status: "invalid", diagnostics };
  }
  if (input.entries.malformed || input.events.malformed) {
    diagnostics.push("malformed NDJSON line before the journal tail");
  }
  if (input.events.tornTail && input.capture.status !== "recording") {
    diagnostics.push("terminal session event journal has a torn tail");
  }
  if (input.runTerminal && input.capture.status === "recording") {
    diagnostics.push("terminal run still reports recording capture");
  }
  let expected = 1;
  for (const event of input.events.records) {
    try {
      validateSessionEventRecord(event);
    } catch (error) {
      diagnostics.push(failureMessageForDiagnostic(error));
      break;
    }
    if (event.seq !== expected) {
      diagnostics.push(`session event sequence gap at ${expected}`);
      break;
    }
    expected += 1;
  }
  diagnostics.push(...sessionRelationshipDiagnostics(input.entries.records, input.events.records));
  if (input.capture.status !== "recording") {
    const lastEventSeq = input.events.records.at(-1)?.seq ?? 0;
    if (
      input.capture.eventCount !== input.events.records.length ||
      input.capture.entryCount !== input.entries.records.length ||
      input.capture.lastEventSeq !== lastEventSeq
    ) {
      diagnostics.push("session capture counts do not match durable files");
    }
  }
  if (diagnostics.length > 0) {
    return { status: "invalid", diagnostics };
  }
  if (input.capture.status === "failed") {
    return {
      status: "failed",
      diagnostics: [input.capture.failure?.message ?? "session capture failed"],
    };
  }
  return { status: input.capture.status, diagnostics: [] };
}

function failureMessageForDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createManifest(
  state: WorkflowRunState,
  present: { session: boolean },
): WorkflowRunManifest {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: state.runId,
    workflowName: state.workflowName,
    ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
    ...(state.workflowSource !== undefined ? { workflowSource: state.workflowSource } : {}),
    startedAt: state.startedAt,
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    status: state.status,
    traceSchema: TRACE_EVENT_SCHEMA,
    paths: {
      workflow: WORKFLOW_SNAPSHOT_PATH,
      state: STATE_PATH,
      trace: TRACE_PATH,
      ...(present.session ? { session: SESSION_DIR } : {}),
      // Declare this before any payload can externalize a string. Live
      // session-event patches may reference a newly written artifact before
      // the next workflow state projection refreshes the manifest.
      artifacts: "artifacts",
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
    ...(typeof node.timeoutMs === "number" ? { timeoutMs: node.timeoutMs } : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  if (node.nodeType === "agent" && node.expectedOutput !== undefined) {
    common.expectedOutput = node.expectedOutput;
  }
  if (node.nodeType === "notify") {
    common.summary = node.kind ?? "progress";
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
