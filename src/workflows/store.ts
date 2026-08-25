import { createHash, randomUUID } from "node:crypto";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { canonicalJson } from "../state/json.js";
import { resourceIdFor, tokenHash, type MutationActor, type OwnerType } from "../state/mutation.js";
import { compositionMetadata } from "./composition.js";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeResult,
  WorkflowNodeSnapshot,
  WorkflowRunState,
  WorkflowStepRecord,
  WorkflowSessionBinding,
  WorkflowSessionCapture,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "./types.js";
import { MAX_CURRENT_UPDATES, createUpdateId, updateProjection } from "./updates.js";

export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;
export const SESSION_EVENT_SCHEMA = "pi-workflows.session-event.v1" as const;
export const SESSION_CAPTURE_SCHEMA = "pi-workflows.session-capture.v1" as const;
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;

export function workflowStateDatabasePath(homeDir?: string): string {
  return workflowStatePath(homeDir);
}

export function createRunId(workflowName: string, now: Date = new Date()): string {
  const safeName = workflowName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "workflow";
  return `${now.toISOString().replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z")}-${safeName}-${randomUUID().slice(0, 8)}`;
}

export type RunWriteAuthority = {
  actor: MutationActor;
  ownerType: OwnerType;
  ownerId: string;
  token: string;
  generation: number;
};

export type WorkflowRunStoreOptions = {
  authorityProvider?: (runId: string) => RunWriteAuthority | undefined;
  state?: StateDatabase;
  readOnly?: boolean;
};

type RunContext = {
  revision: number;
  lock: Promise<void>;
};

type RunRow = {
  runId: string;
  resourceId: string;
  definitionHash: Buffer;
  definitionDigest: Buffer;
  workflowRef: string;
  sourceRef: string;
  workflowSourceHash: Buffer;
  workflowSourcesHash: Buffer | null;
  parentRunId: string | null;
  title: string | null;
  status: string;
  paused: number;
  statusDetail: string | null;
  inputHash: Buffer;
  humanDecisionHash: Buffer | null;
  finalOutputHash: Buffer | null;
  errorHash: Buffer | null;
  carriedStepCount: number;
  currentNode: string | null;
  currentAttemptId: string | null;
  currentNodeStartedAt: number | null;
  waitingOn: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

type StoredStepMetadata = Pick<WorkflowStepRecord, "action" | "assistantMessage" | "conversation">;

type StepRow = {
  stepIndex: number;
  attemptId: string;
  nodeId: string;
  nodeType: WorkflowStepRecord["nodeType"];
  status: string;
  promptHash: Buffer | null;
  outputHash: Buffer | null;
  outputOverrideHash: Buffer | null;
  stepMetadataHash: Buffer | null;
  errorHash: Buffer | null;
  startedAt: number;
  finishedAt: number;
};

type UpdateRow = {
  updateId: string;
  runRevision: number;
  nodeId: string;
  attemptId: string;
  updateType: string;
  updateKey: string;
  dataHash: Buffer;
  recordedAt: number;
};

type EventRow = {
  resourceRevision: number;
  eventType: string;
  payloadHash: Buffer | null;
  recordedAt: number;
};

type SegmentRow = {
  segmentId: string;
  runId: string;
  attemptId: string | null;
  captureKey: string | null;
  sessionId: string;
  bindingHash: Buffer | null;
  status: WorkflowSessionCapture["status"];
  entryCount: number;
  eventCount: number;
  failureHash: Buffer | null;
  createdAt: number;
  finishedAt: number | null;
};

type SessionEntryRow = {
  entrySeq: number;
  entryHash: Buffer;
  recordedAt: number;
};

type SessionEventRow = {
  eventSeq: number;
  eventType: WorkflowSessionEventRecord["type"];
  nodeId: string;
  attemptId: string;
  turnId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  payloadHash: Buffer;
  recordedAt: number;
};

export type SessionCaptureIntegrity = {
  status: "unavailable" | "recording" | "complete" | "failed" | "invalid";
  diagnostics: string[];
};

export type SessionCaptureSegment = {
  attemptId: string;
  binding: WorkflowSessionBinding | null;
  entries: WorkflowSessionEntryRecord[];
  events: WorkflowSessionEventRecord[];
  capture: WorkflowSessionCapture | null;
  integrity: SessionCaptureIntegrity;
};

export type LoadedWorkflowRun = {
  runId: string;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot;
  traceEvents?: WorkflowTraceEvent[];
  sessionBinding: WorkflowSessionBinding | null;
  sessionEntries: WorkflowSessionEntryRecord[];
  sessionEvents: WorkflowSessionEventRecord[];
  sessionCapture: WorkflowSessionCapture | null;
  sessionIntegrity: SessionCaptureIntegrity;
  sessionSegments: SessionCaptureSegment[];
};

export type ReadWorkflowRunOptions = {
  includeTrace?: boolean;
};

export class WorkflowRunStore {
  readonly databasePath: string;
  readonly state: StateDatabase;
  private readonly authorityProvider:
    | ((runId: string) => RunWriteAuthority | undefined)
    | undefined;
  private readonly contexts = new Map<string, RunContext>();
  private readonly ownsState: boolean;

  constructor(databasePath: string = workflowStatePath(), options: WorkflowRunStoreOptions = {}) {
    this.authorityProvider = options.authorityProvider;
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath: databasePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
        checkLegacyState: databasePath === workflowStatePath(),
      });
    this.databasePath = this.state.filePath;
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  async initializeRun(workflow: WorkflowDefinition, state: WorkflowRunState): Promise<string> {
    assertValidRunId(state.runId);
    if (!this.contexts.has(state.runId)) {
      const reserved = this.readRunRow(state.runId);
      this.contexts.set(state.runId, {
        revision: reserved === undefined ? 0 : this.requireResourceRevision(reserved.resourceId),
        lock: Promise.resolve(),
      });
    }
    return await this.withRunLock(state.runId, async () => {
      let acceptedRevision = 1;
      const now = Date.now();
      const at = new Date(now).toISOString();
      const snapshot = createDefinitionSnapshot(workflow);
      const definitionJson = canonicalJson(snapshot);
      const definitionDigest = createHash("sha256").update(definitionJson).digest();
      const source = sourceForState(state, definitionDigest);
      const resourceId = resourceIdFor("run", state.runId);
      this.state.transaction(() => {
        const reserved = this.readRunRow(state.runId);
        if (reserved !== undefined) {
          if (reserved.status !== "queued") {
            throw new Error(`Workflow run already exists: ${state.runId}`);
          }
          const context = this.contextFor(state.runId);
          this.assertWriteAuthority(reserved, context.revision);
          const storedSnapshot = this.readDefinition(reserved.definitionHash);
          if (canonicalJson(storedSnapshot) !== definitionJson) {
            throw new Error(`Reserved workflow definition conflicts: ${state.runId}`);
          }
          const revision = context.revision + 1;
          acceptedRevision = revision;
          state.traceSeq = revision;
          state.updatedAt = at;
          insertRunEvent(this.state, reserved.resourceId, revision, at, {
            scope: "run",
            type: "run_initialized",
            payload: { workflowName: workflow.name },
          });
          this.persistRunState(reserved, state, revision, now);
          this.syncNodeAttempts(state, snapshot, now);
          context.revision = revision;
          return;
        }
        const definitionHash = this.state.putJson(snapshot, now);
        this.state.connection
          .prepare(
            `INSERT INTO workflow_definitions(
               definition_digest, workflow_name, definition_hash, created_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(definition_digest) DO NOTHING`,
          )
          .run(definitionDigest, workflow.name, definitionHash, now);
        this.state.connection
          .prepare(
            `INSERT INTO resources(
               resource_id, resource_type, aggregate_key, revision, created_at, updated_at
             ) VALUES (?, 'run', ?, 1, ?, ?)`,
          )
          .run(resourceId, state.runId, now, now);
        this.state.connection
          .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
          .run(resourceId);
        state.traceSeq = 1;
        state.updatedAt = at;
        const inputHash = this.state.putJson(state.input, now);
        const workflowSourceHash = this.state.putJson(state.workflowSource ?? source, now);
        const launchOptionsHash = this.state.putJson({}, now);
        const workflowSourcesHash =
          state.workflowSources === undefined
            ? null
            : this.state.putJson(state.workflowSources, now);
        const humanDecisionHash =
          state.humanDecision === undefined ? null : this.state.putJson(state.humanDecision, now);
        const finalOutputHash =
          state.finalOutput === undefined ? null : this.state.putJson(state.finalOutput, now);
        const errorHash = state.error === undefined ? null : this.state.putText(state.error, now);
        this.state.connection
          .prepare(
            `INSERT INTO runs(
               run_id, resource_id, project_id, parent_run_id, definition_digest,
               workflow_ref, workflow_source_hash, launch_options_hash,
               source_type, source_ref, source_revision, title, status, paused,
               status_detail, input_hash, workflow_sources_hash, human_decision_hash,
               final_output_hash, error_hash, carried_step_count, current_node,
               current_attempt_id, current_node_started_at, waiting_on,
               created_at, updated_at, finished_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            state.runId,
            resourceId,
            state.parentRunId ?? null,
            definitionDigest,
            state.workflowName,
            workflowSourceHash,
            launchOptionsHash,
            source.type,
            source.ref,
            source.revision,
            state.runTitle ?? null,
            state.status,
            state.paused === true ? 1 : 0,
            state.statusDetail ?? null,
            inputHash,
            workflowSourcesHash,
            humanDecisionHash,
            finalOutputHash,
            errorHash,
            state.carriedStepCount ?? 0,
            state.currentNode ?? null,
            state.currentAttemptId ?? null,
            state.currentNodeStartedAt === undefined
              ? null
              : Date.parse(state.currentNodeStartedAt),
            state.waitingOn ?? null,
            Date.parse(state.startedAt),
            now,
            state.finishedAt === undefined ? null : Date.parse(state.finishedAt),
          );
        insertRunEvent(this.state, resourceId, 1, at, {
          scope: "run",
          type: "run_created",
          payload: { workflowName: workflow.name },
        });
        this.syncNodeAttempts(state, snapshot, now);
      });
      this.contexts.set(state.runId, { revision: acceptedRevision, lock: Promise.resolve() });
      return state.runId;
    });
  }

  async prepareRunResume(runId: string): Promise<LoadedWorkflowRun> {
    const loaded = this.readRun(runId, { includeTrace: true });
    if (loaded === null) throw new Error(`Cannot resume unreadable workflow run: ${runId}`);
    if (loaded.state.status !== "running") {
      throw new Error(`Cannot resume workflow run ${runId} with status ${loaded.state.status}`);
    }
    const revision = this.resourceRevision(runId);
    this.contexts.set(runId, { revision, lock: Promise.resolve() });
    this.finalizeRecordingCaptures(runId, "Workflow host stopped before the run finished");
    this.state.transaction(() => {
      const row = this.requireRunRow(runId);
      const context = this.contextFor(runId);
      this.assertWriteAuthority(row, context.revision);
      const nextRevision = context.revision + 1;
      const now = Date.now();
      const at = new Date(now).toISOString();
      this.state.connection
        .prepare(
          `UPDATE node_attempts
           SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'running', 'waiting')`,
        )
        .run(now, now, runId);
      insertRunEvent(this.state, row.resourceId, nextRevision, at, {
        scope: "run",
        type: "run_resume_prepared",
        payload: {},
      });
      loaded.state.traceSeq = nextRevision;
      loaded.state.updatedAt = at;
      this.persistRunState(row, loaded.state, nextRevision, now);
      context.revision = nextRevision;
    });
    const prepared = this.readRun(runId, { includeTrace: true });
    if (prepared === null) throw new Error(`Workflow run became unreadable: ${runId}`);
    return prepared;
  }

  async markRunInterrupted(
    runId: string,
    reason = "Workflow host stopped before the run finished",
  ): Promise<LoadedWorkflowRun | null> {
    const loaded = this.readRun(runId);
    if (loaded === null || loaded.state.status !== "running") return loaded;
    this.finalizeRecordingCaptures(runId, reason);
    loaded.state.status = "failed";
    loaded.state.finishedAt = new Date().toISOString();
    loaded.state.error = reason;
    delete loaded.state.currentNode;
    delete loaded.state.currentAttemptId;
    delete loaded.state.currentNodeStartedAt;
    delete loaded.state.statusDetail;
    delete loaded.state.paused;
    await this.writeSnapshot(runId, loaded.state, {
      scope: "run",
      type: "run_interrupted",
      payload: { error: reason },
    });
    return this.readRun(runId, { includeTrace: true });
  }

  async publishUpdate(
    runId: string,
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }> {
    return await this.withRunLock(runId, async () => {
      if (options.signal?.aborted === true) {
        throw options.signal.reason ?? new Error("workflow update attempt is no longer active");
      }
      const exists = (state.updates ?? []).some(
        (record) => record.type === update.type && record.key === update.key,
      );
      if (!exists && (state.updates?.length ?? 0) >= MAX_CURRENT_UPDATES) {
        throw new Error(`workflow run supports at most ${MAX_CURRENT_UPDATES} current updates`);
      }
      const data = structuredClone(update.data) as Record<string, unknown>;
      const updateId = createUpdateId();
      let acceptedEvent: WorkflowTraceEvent | undefined;
      let acceptedRecord: WorkflowUpdateRecord | undefined;
      this.state.transaction(() => {
        const context = this.contextFor(runId);
        const run = this.requireRunRow(runId);
        this.assertWriteAuthority(run, context.revision);
        const revision = context.revision + 1;
        const at = new Date().toISOString();
        const event: WorkflowTraceEvent = {
          seq: revision,
          at,
          runId,
          scope: "node",
          type: "update_published",
          nodeId,
          attemptId,
          payload: { updateId, type: update.type, key: update.key, data },
        };
        const record: WorkflowUpdateRecord = {
          updateId,
          seq: revision,
          at,
          runId,
          nodeId,
          attemptId,
          type: update.type,
          key: update.key,
          data,
        };
        state.updates = updateProjection(state.updates, record);
        state.traceSeq = revision;
        state.updatedAt = at;
        this.ensureAttempt(state, nodeId, attemptId, Date.now());
        const dataHash = this.state.putJson(data);
        const nextUpdateSeq = this.nextUpdateSequence(attemptId);
        this.state.connection
          .prepare(
            `INSERT INTO workflow_updates(
               update_id, attempt_id, update_seq, run_revision,
               update_type, update_key, data_hash, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            updateId,
            attemptId,
            nextUpdateSeq,
            revision,
            update.type,
            update.key,
            dataHash,
            Date.now(),
          );
        insertRunEvent(this.state, run.resourceId, revision, at, event);
        this.persistRunState(run, state, revision, Date.now());
        context.revision = revision;
        acceptedEvent = event;
        acceptedRecord = record;
      });
      if (acceptedEvent === undefined || acceptedRecord === undefined) {
        throw new Error("Workflow update transaction did not produce a result");
      }
      return { event: acceptedEvent, record: acceptedRecord };
    });
  }

  async writeSnapshot(
    runId: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return await this.withRunLock(runId, async () => {
      let accepted: WorkflowTraceEvent | undefined;
      this.state.transaction(() => {
        const context = this.contextFor(runId);
        const run = this.requireRunRow(runId);
        this.assertWriteAuthority(run, context.revision);
        const revision = context.revision + 1;
        const now = Date.now();
        const at = new Date(now).toISOString();
        const traceEvent: WorkflowTraceEvent = { seq: revision, at, runId, ...event };
        state.traceSeq = revision;
        state.updatedAt = at;
        insertRunEvent(this.state, run.resourceId, revision, at, traceEvent);
        this.persistRunState(run, state, revision, now);
        const snapshot = this.readDefinition(run.definitionHash);
        this.syncNodeAttempts(state, snapshot, now);
        context.revision = revision;
        accepted = traceEvent;
      });
      if (accepted === undefined) throw new Error("Workflow snapshot transaction did not commit");
      return accepted;
    });
  }

  async hasSessionBinding(runId: string): Promise<boolean> {
    return (
      this.state.connection
        .prepare("SELECT 1 AS present FROM session_segments WHERE run_id = ? LIMIT 1")
        .get(runId) !== undefined
    );
  }

  async listSessionSegments(runId: string): Promise<string[]> {
    return this.segmentRows(runId)
      .flatMap((row) => (row.captureKey === null ? [] : [row.captureKey]))
      .sort();
  }

  async writeSessionBinding(
    runId: string,
    binding: WorkflowSessionBinding,
    attemptId?: string,
  ): Promise<void> {
    assertValidRunId(runId);
    if (binding.runId !== runId || binding.schema !== SESSION_BINDING_SCHEMA) {
      throw new Error("Session binding does not match the workflow run");
    }
    await this.withRunLock(runId, async () => {
      const segmentId = segmentIdFor(runId, attemptId);
      if (this.segmentRow(segmentId) !== undefined) return;
      this.state.transaction(() => {
        const run = this.requireRunRow(runId);
        const context = this.contextFor(runId);
        this.assertWriteAuthority(run, context.revision);
        const now = Date.parse(binding.boundAt);
        const resourceId = resourceIdFor("session", segmentId);
        const bindingHash = this.state.putJson(binding, now);
        this.state.connection
          .prepare(
            `INSERT INTO resources(
               resource_id, resource_type, aggregate_key, revision, created_at, updated_at
             ) VALUES (?, 'session', ?, 1, ?, ?)`,
          )
          .run(resourceId, segmentId, now, now);
        this.state.connection
          .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
          .run(resourceId);
        this.state.connection
          .prepare(
            `INSERT INTO session_segments(
               segment_id, run_id, attempt_id, capture_key, session_id, resource_id, binding_hash,
               status, entry_count, event_count, created_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'recording', 0, 0, ?)`,
          )
          .run(
            segmentId,
            runId,
            attemptId ?? null,
            binding.piSessionId,
            resourceId,
            bindingHash,
            now,
          );
        insertGenericEvent(
          this.state,
          resourceId,
          1,
          "session.created",
          "session",
          binding.piSessionId,
          bindingHash,
          now,
        );
        this.state.connection
          .prepare(
            `INSERT INTO run_bindings(run_id, origin_session_id, execution_mode, created_at)
             VALUES (?, ?, 'interactive', ?)
             ON CONFLICT(run_id) DO NOTHING`,
          )
          .run(runId, binding.piSessionId, now);
        const revision = context.revision + 1;
        const at = new Date(now).toISOString();
        insertRunEvent(this.state, run.resourceId, revision, at, {
          seq: revision,
          at,
          runId,
          scope: "session",
          type: "session_bound",
          payload: {
            piSessionId: binding.piSessionId,
            ...(attemptId !== undefined ? { captureAttemptId: attemptId } : {}),
          },
        });
        const current = this.readRunState(run, this.readDefinition(run.definitionHash));
        current.traceSeq = revision;
        current.updatedAt = at;
        this.persistRunState(run, current, revision, now);
        context.revision = revision;
      });
    });
  }

  async appendSessionEntry(
    runId: string,
    entry: Record<string, unknown>,
    attemptId?: string,
  ): Promise<number> {
    const segment = this.requireSegment(segmentIdFor(runId, attemptId));
    return this.state.transaction(() => {
      this.assertSessionWriteAuthority(runId);
      const revision = this.requireResourceRevision(segmentResourceId(segment));
      const sequence = segment.entryCount + 1;
      const now = Date.now();
      const entryHash = this.state.putJson(entry, now);
      const entryId = typeof entry.id === "string" ? entry.id : `entry-${sequence}`;
      this.state.connection
        .prepare(
          `INSERT INTO session_entries(segment_id, entry_seq, entry_id, entry_hash, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(segment.segmentId, sequence, entryId, entryHash, now);
      this.state.connection
        .prepare("UPDATE session_segments SET entry_count = ? WHERE segment_id = ?")
        .run(sequence, segment.segmentId);
      this.bumpResource(segmentResourceId(segment), revision, now);
      insertGenericEvent(
        this.state,
        segmentResourceId(segment),
        revision + 1,
        "session.entry_appended",
        "session",
        segment.sessionId,
        entryHash,
        now,
      );
      return sequence;
    });
  }

  async appendSessionEventBatch(
    runId: string,
    records: WorkflowSessionEventRecord[],
    attemptId?: string,
  ): Promise<void> {
    if (records.length === 0) return;
    const segment = this.requireSegment(segmentIdFor(runId, attemptId));
    this.state.transaction(() => {
      this.assertSessionWriteAuthority(runId);
      const current = this.requireSegment(segment.segmentId);
      if (current.status !== "recording") throw new Error("Session event capture has stopped");
      let expected = current.eventCount + 1;
      for (const record of records) {
        validateSessionEventRecord(record);
        if (record.seq !== expected) {
          throw new Error(`Expected session event seq ${expected}, got ${record.seq}`);
        }
        if (Buffer.byteLength(canonicalJson(record), "utf8") > SESSION_EVENT_MAX_BYTES) {
          throw new Error(`session event exceeded ${SESSION_EVENT_MAX_BYTES} bytes`);
        }
        const payloadHash = this.state.putJson(record.payload, Date.parse(record.at));
        this.state.connection
          .prepare(
            `INSERT INTO session_events(
               segment_id, event_seq, event_type, node_id, attempt_id,
               turn_id, message_id, tool_call_id, payload_hash, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            current.segmentId,
            record.seq,
            record.type,
            record.nodeId,
            record.attemptId,
            record.turnId ?? null,
            record.messageId ?? null,
            record.toolCallId ?? null,
            payloadHash,
            Date.parse(record.at),
          );
        expected += 1;
      }
      this.state.connection
        .prepare("UPDATE session_segments SET event_count = ? WHERE segment_id = ?")
        .run(expected - 1, current.segmentId);
    });
  }

  async writeSessionCapture(
    runId: string,
    capture: WorkflowSessionCapture,
    attemptId?: string,
  ): Promise<void> {
    validateSessionCapture(capture);
    const segment = this.requireSegment(segmentIdFor(runId, attemptId));
    this.state.transaction(() => {
      this.assertSessionWriteAuthority(runId);
      const current = this.requireSegment(segment.segmentId);
      if (current.status === "failed" && capture.status !== "failed") return;
      if (current.status === "complete" && capture.status !== "complete") return;
      const now = Date.now();
      const failureHash =
        capture.failure === undefined ? null : this.state.putJson(capture.failure, now);
      this.state.connection
        .prepare(
          `UPDATE session_segments
           SET status = ?, entry_count = ?, event_count = ?, failure_hash = ?, finished_at = ?
           WHERE segment_id = ?`,
        )
        .run(
          capture.status,
          capture.entryCount,
          capture.eventCount,
          failureHash,
          capture.status === "recording" ? null : now,
          segment.segmentId,
        );
      const resourceId = segmentResourceId(segment);
      const revision = this.requireResourceRevision(resourceId);
      this.bumpResource(resourceId, revision, now);
      const payloadHash = this.state.putJson(capture, now);
      insertGenericEvent(
        this.state,
        resourceId,
        revision + 1,
        "session.capture_updated",
        "session",
        segment.sessionId,
        payloadHash,
        now,
      );
    });
  }

  async sessionCounts(
    runId: string,
    attemptId?: string,
  ): Promise<{ eventCount: number; entryCount: number; lastEventSeq: number }> {
    const segment = this.segmentRow(segmentIdFor(runId, attemptId));
    return {
      eventCount: segment?.eventCount ?? 0,
      entryCount: segment?.entryCount ?? 0,
      lastEventSeq: segment?.eventCount ?? 0,
    };
  }

  readRun(runId: string, options: ReadWorkflowRunOptions = {}): LoadedWorkflowRun | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    const snapshot = this.readDefinition(row.definitionHash);
    const state = this.readRunState(row, snapshot);
    const segments = this.segmentRows(runId).map((segment) => this.loadSegment(segment, state));
    const flat = segments.find((segment) => segment.attemptId === "") ?? emptySegment();
    return {
      runId,
      state,
      snapshot,
      ...(options.includeTrace === true ? { traceEvents: this.traceEvents(row) } : {}),
      sessionBinding: flat.binding,
      sessionEntries: flat.entries,
      sessionEvents: flat.events,
      sessionCapture: flat.capture,
      sessionIntegrity: flat.integrity,
      sessionSegments: segments.filter((segment) => segment.attemptId !== ""),
    };
  }

  listRuns(options: ReadWorkflowRunOptions = {}): LoadedWorkflowRun[] {
    const rows = this.state.connection
      .prepare("SELECT run_id AS runId FROM runs ORDER BY created_at DESC, run_id DESC")
      .all();
    const loaded: LoadedWorkflowRun[] = [];
    for (const row of rows) {
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isRunIdRow(row)) continue;
      const run = this.readRun(row.runId, options);
      if (run !== null) loaded.push(run);
    }
    return loaded;
  }

  readLastTraceEvent(runId: string): WorkflowTraceEvent | null {
    const run = this.readRunRow(runId);
    if (run === undefined) return null;
    const last = this.traceEvents(run).at(-1);
    /* istanbul ignore if -- every durable run has a creation event */
    if (last === undefined) throw new Error("Workflow run has no creation event");
    return last;
  }

  private contextFor(runId: string): RunContext {
    let context = this.contexts.get(runId);
    if (context === undefined) {
      context = { revision: this.resourceRevision(runId), lock: Promise.resolve() };
      this.contexts.set(runId, context);
    }
    return context;
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const context = this.contextFor(runId);
    const prior = context.lock;
    let release: (() => void) | undefined;
    context.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private assertSessionWriteAuthority(runId: string): void {
    const run = this.requireRunRow(runId);
    this.assertWriteAuthority(run, this.contextFor(runId).revision);
  }

  private resourceRevision(runId: string): number {
    const run = this.requireRunRow(runId);
    return this.requireResourceRevision(run.resourceId);
  }

  private requireResourceRevision(resourceId: string): number {
    const row = this.state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    if (!isRevisionRow(row)) throw new Error(`Resource is missing: ${resourceId}`);
    return row.revision;
  }

  private bumpResource(resourceId: string, expectedRevision: number, now: number): void {
    const result = this.state.connection
      .prepare(
        `UPDATE resources SET revision = revision + 1, updated_at = ?
         WHERE resource_id = ? AND revision = ?`,
      )
      .run(now, resourceId, expectedRevision);
    if (result.changes !== 1) throw new Error("Resource revision conflict");
  }

  private assertWriteAuthority(run: RunRow, expectedRevision: number): void {
    const actualRevision = this.requireResourceRevision(run.resourceId);
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `Workflow run revision conflict: expected ${expectedRevision}, got ${actualRevision}`,
      );
    }
    const lease = this.state.connection
      .prepare(
        `SELECT generation, owner_type AS ownerType, owner_id AS ownerId,
                token_hash AS tokenHash, expires_at AS expiresAt
         FROM leases WHERE resource_id = ?`,
      )
      .get(run.resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    if (!isLeaseAuthorityRow(lease)) throw new Error("Workflow run lease is missing");
    if (lease.ownerId === null) return;
    const authority = this.authorityProvider?.(run.runId);
    if (
      authority === undefined ||
      authority.ownerType !== lease.ownerType ||
      authority.ownerId !== lease.ownerId ||
      authority.generation !== lease.generation ||
      lease.tokenHash === null ||
      !lease.tokenHash.equals(tokenHash(authority.token)) ||
      lease.expiresAt === null ||
      lease.expiresAt <= Date.now()
    ) {
      throw new Error("Workflow run write rejected because ownership changed");
    }
  }

  private persistRunState(
    run: RunRow,
    state: WorkflowRunState,
    expectedRevision: number,
    now: number,
  ): void {
    this.bumpResource(run.resourceId, expectedRevision - 1, now);
    const workflowSourcesHash =
      state.workflowSources === undefined ? null : this.state.putJson(state.workflowSources, now);
    const humanDecisionHash =
      state.humanDecision === undefined ? null : this.state.putJson(state.humanDecision, now);
    const finalOutputHash =
      state.finalOutput === undefined ? null : this.state.putJson(state.finalOutput, now);
    const errorHash = state.error === undefined ? null : this.state.putText(state.error, now);
    const update = this.state.connection
      .prepare(
        `UPDATE runs
         SET title = ?, status = ?, paused = ?, status_detail = ?,
             workflow_sources_hash = ?, human_decision_hash = ?, final_output_hash = ?,
             error_hash = ?, carried_step_count = ?, current_node = ?, current_attempt_id = ?,
             current_node_started_at = ?, waiting_on = ?, updated_at = ?, finished_at = ?
         WHERE run_id = ?`,
      )
      .run(
        state.runTitle ?? null,
        state.status,
        state.paused === true ? 1 : 0,
        state.statusDetail ?? null,
        workflowSourcesHash,
        humanDecisionHash,
        finalOutputHash,
        errorHash,
        state.carriedStepCount ?? 0,
        state.currentNode ?? null,
        state.currentAttemptId ?? null,
        state.currentNodeStartedAt === undefined ? null : Date.parse(state.currentNodeStartedAt),
        state.waitingOn ?? null,
        now,
        state.finishedAt === undefined ? null : Date.parse(state.finishedAt),
        state.runId,
      );
    if (update.changes !== 1) throw new Error(`Workflow run is missing: ${state.runId}`);
    if (state.status !== "running") {
      this.enqueueRunSettlementEffect(run.resourceId, expectedRevision, state, now);
    }
  }

  private enqueueRunSettlementEffect(
    runResourceId: string,
    sourceRevision: number,
    state: WorkflowRunState,
    now: number,
  ): void {
    if (
      this.state.connection.prepare("SELECT 1 FROM run_queue WHERE run_id = ?").get(state.runId) ===
      undefined
    ) {
      return;
    }
    const effectType = state.status === "waiting" ? "run.park_queue" : "run.settle_queue";
    const idempotencyKey = `${state.runId}:${state.status}`;
    const effectId = `effect-${createHash("sha256")
      .update(`${runResourceId}\0${effectType}\0${idempotencyKey}`)
      .digest("hex")
      .slice(0, 40)}`;
    if (
      this.state.connection.prepare("SELECT 1 FROM effects WHERE effect_id = ?").get(effectId) !==
      undefined
    ) {
      return;
    }
    const effectResourceId = resourceIdFor("effect", effectId);
    const payloadHash = this.state.putJson({ runId: state.runId, status: state.status }, now);
    this.state.connection
      .prepare(
        `INSERT INTO resources(
           resource_id, resource_type, aggregate_key, revision, created_at, updated_at
         ) VALUES (?, 'effect', ?, 1, ?, ?)`,
      )
      .run(effectResourceId, effectId, now, now);
    this.state.connection
      .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
      .run(effectResourceId);
    this.state.connection
      .prepare(
        `INSERT INTO effects(
           effect_id, resource_id, source_resource_id, source_revision,
           effect_type, idempotency_key, payload_hash, owner_scope,
           status, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'run', 'pending', 0, ?, ?)`,
      )
      .run(
        effectId,
        effectResourceId,
        runResourceId,
        sourceRevision,
        effectType,
        idempotencyKey,
        payloadHash,
        now,
        now,
      );
    insertGenericEvent(
      this.state,
      effectResourceId,
      1,
      "effect.created",
      "system",
      null,
      payloadHash,
      now,
    );
  }

  private syncNodeAttempts(
    state: WorkflowRunState,
    snapshot: WorkflowDefinitionSnapshot,
    now: number,
  ): void {
    for (const step of state.steps.slice(state.carriedStepCount ?? 0)) {
      const metadata = stepMetadata(step);
      const stepMetadataHash =
        Object.keys(metadata).length === 0 ? null : this.state.putJson(metadata, now);
      const outputHash = step.output === undefined ? null : this.state.putJson(step.output, now);
      const errorHash = step.error === undefined ? null : this.state.putText(step.error, now);
      const promptHash = step.prompt === null ? null : this.state.putJson(step.prompt, now);
      const existing = this.state.connection
        .prepare("SELECT attempt_id AS attemptId FROM node_attempts WHERE attempt_id = ?")
        .get(step.attemptId);
      if (existing === undefined) {
        const attemptNumber = this.nextAttemptNumber(state.runId, step.nodeId);
        this.state.connection
          .prepare(
            `INSERT INTO node_attempts(
               attempt_id, run_id, node_id, attempt_number, node_type, status,
               prompt_hash, output_hash, step_metadata_hash, error_hash,
               started_at, finished_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            step.attemptId,
            state.runId,
            step.nodeId,
            attemptNumber,
            step.nodeType,
            outcomeStatus(step.outcome),
            promptHash,
            outputHash,
            stepMetadataHash,
            errorHash,
            Date.parse(step.startedAt),
            Date.parse(step.finishedAt),
            Date.parse(step.startedAt),
            now,
          );
      } else {
        this.state.connection
          .prepare(
            `UPDATE node_attempts
             SET status = ?, prompt_hash = ?, output_hash = ?, step_metadata_hash = ?,
                 error_hash = ?, finished_at = ?, updated_at = ?
             WHERE attempt_id = ?`,
          )
          .run(
            outcomeStatus(step.outcome),
            promptHash,
            outputHash,
            stepMetadataHash,
            errorHash,
            Date.parse(step.finishedAt),
            now,
            step.attemptId,
          );
      }
    }
    if (state.currentAttemptId !== undefined && state.currentNode !== undefined) {
      this.ensureAttempt(state, state.currentNode, state.currentAttemptId, now, snapshot);
    }
    this.syncRunSteps(state, now);
  }

  private syncRunSteps(state: WorkflowRunState, now: number): void {
    const existingRows = this.state.connection
      .prepare(
        `SELECT step_index AS stepIndex, attempt_id AS attemptId
         FROM run_steps WHERE run_id = ? ORDER BY step_index`,
      )
      .all(state.runId)
      .filter(isRunStepIdentityRow);
    if (existingRows.length > state.steps.length) {
      throw new Error(`Workflow run steps cannot shrink: ${state.runId}`);
    }
    for (const existing of existingRows) {
      if (state.steps[existing.stepIndex]?.attemptId !== existing.attemptId) {
        throw new Error(`Workflow run step history changed at index ${existing.stepIndex}`);
      }
    }
    for (let stepIndex = existingRows.length; stepIndex < state.steps.length; stepIndex += 1) {
      const step = state.steps[stepIndex];
      /* istanbul ignore if -- array index follows a checked bound */
      if (step === undefined) throw new Error("Workflow run step became unavailable");
      const attempt = this.state.connection
        .prepare("SELECT output_hash AS outputHash FROM node_attempts WHERE attempt_id = ?")
        .get(step.attemptId);
      if (!isAttemptOutputRow(attempt)) {
        throw new Error(`Workflow node attempt is missing: ${step.attemptId}`);
      }
      const carried = stepIndex < (state.carriedStepCount ?? 0);
      const outputOverrideHash =
        carried &&
        (attempt.outputHash === null ||
          canonicalJson(this.state.readJson(attempt.outputHash)) !== canonicalJson(step.output))
          ? this.state.putJson(step.output, now)
          : null;
      this.state.connection
        .prepare(
          `INSERT INTO run_steps(run_id, step_index, attempt_id, output_override_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .run(state.runId, stepIndex, step.attemptId, outputOverrideHash);
    }
  }

  private ensureAttempt(
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    now: number,
    snapshot?: WorkflowDefinitionSnapshot,
  ): void {
    const existing = this.state.connection
      .prepare("SELECT attempt_id AS attemptId FROM node_attempts WHERE attempt_id = ?")
      .get(attemptId);
    const status = state.status === "waiting" ? "waiting" : "running";
    if (existing !== undefined) {
      this.state.connection
        .prepare("UPDATE node_attempts SET status = ?, updated_at = ? WHERE attempt_id = ?")
        .run(status, now, attemptId);
      return;
    }
    const definition =
      snapshot ?? this.readDefinition(this.requireRunRow(state.runId).definitionHash);
    const nodeType = definition.nodes[nodeId]?.nodeType ?? "agent";
    this.state.connection
      .prepare(
        `INSERT INTO node_attempts(
           attempt_id, run_id, node_id, attempt_number, node_type, status,
           started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        state.runId,
        nodeId,
        this.nextAttemptNumber(state.runId, nodeId),
        nodeType,
        status,
        state.currentNodeStartedAt === undefined ? now : Date.parse(state.currentNodeStartedAt),
        now,
        now,
      );
  }

  private nextAttemptNumber(runId: string, nodeId: string): number {
    const row = this.state.connection
      .prepare(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attemptNumber
         FROM node_attempts WHERE run_id = ? AND node_id = ?`,
      )
      .get(runId, nodeId);
    /* istanbul ignore if -- exact schema and internal query shape */
    if (!isAttemptNumberRow(row)) throw new Error("Could not allocate node attempt number");
    return row.attemptNumber;
  }

  private nextUpdateSequence(attemptId: string): number {
    const row = this.state.connection
      .prepare(
        `SELECT COALESCE(MAX(update_seq), 0) + 1 AS updateSeq
         FROM workflow_updates WHERE attempt_id = ?`,
      )
      .get(attemptId);
    /* istanbul ignore if -- exact schema and internal query shape */
    if (!isUpdateSequenceRow(row)) throw new Error("Could not allocate workflow update sequence");
    return row.updateSeq;
  }

  private readRunRow(runId: string): RunRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT r.run_id AS runId, r.resource_id AS resourceId,
                d.definition_hash AS definitionHash, r.definition_digest AS definitionDigest,
                d.workflow_name AS workflowRef, r.source_ref AS sourceRef,
                r.workflow_source_hash AS workflowSourceHash,
                r.workflow_sources_hash AS workflowSourcesHash, r.parent_run_id AS parentRunId,
                r.title, r.status, r.paused, r.status_detail AS statusDetail,
                r.input_hash AS inputHash, r.human_decision_hash AS humanDecisionHash,
                r.final_output_hash AS finalOutputHash, r.error_hash AS errorHash,
                r.carried_step_count AS carriedStepCount, r.current_node AS currentNode,
                r.current_attempt_id AS currentAttemptId,
                r.current_node_started_at AS currentNodeStartedAt, r.waiting_on AS waitingOn,
                r.created_at AS createdAt, r.updated_at AS updatedAt, r.finished_at AS finishedAt
         FROM runs r
         JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
         WHERE r.run_id = ?`,
      )
      .get(runId);
    return isRunRow(row) ? row : undefined;
  }

  private requireRunRow(runId: string): RunRow {
    const row = this.readRunRow(runId);
    if (row === undefined) throw new Error(`Workflow run is missing: ${runId}`);
    return row;
  }

  private readRunState(row: RunRow, snapshot: WorkflowDefinitionSnapshot): WorkflowRunState {
    const steps = this.readSteps(row.runId);
    const outputs: Record<string, unknown> = {};
    const results: Record<string, WorkflowNodeResult> = {};
    for (const step of steps) {
      const result = resultForStep(step);
      results[step.nodeId] = result;
      if (step.outcome === "ok") outputs[step.nodeId] = step.output;
      else delete outputs[step.nodeId];
      const node = snapshot.nodes[step.nodeId];
      const mountPath =
        node?.includeTransition === "exit" && node.mountPath !== undefined
          ? node.mountPath.join("/")
          : undefined;
      if (mountPath !== undefined && step.outcome === "ok") {
        outputs[mountPath] = step.output;
        results[mountPath] = { ...result, nodeId: mountPath };
      }
    }
    const revision = this.requireResourceRevision(row.resourceId);
    return {
      schema: RUN_STATE_SCHEMA,
      traceSeq: revision,
      runId: row.runId,
      workflowName: row.workflowRef,
      ...(row.parentRunId === null ? {} : { parentRunId: row.parentRunId }),
      ...(row.carriedStepCount === 0 ? {} : { carriedStepCount: row.carriedStepCount }),
      ...(row.title === null ? {} : { runTitle: row.title }),
      ...(row.sourceRef.startsWith("inline:")
        ? {}
        : { workflowSource: this.readJsonAs(row.workflowSourceHash) }),
      ...(row.workflowSourcesHash === null
        ? {}
        : { workflowSources: this.readJsonAs(row.workflowSourcesHash) }),
      ...(row.workflowSourcesHash !== null || snapshot.composition?.mounts.length
        ? { definitionDigest: `sha256:${row.definitionDigest.toString("hex")}` }
        : {}),
      startedAt: new Date(row.createdAt).toISOString(),
      ...(row.finishedAt === null ? {} : { finishedAt: new Date(row.finishedAt).toISOString() }),
      updatedAt: new Date(row.updatedAt).toISOString(),
      status: row.status as WorkflowRunState["status"],
      input: this.state.readJson(row.inputHash),
      outputs,
      results,
      steps,
      ...this.readUpdates(row.runId),
      ...(row.currentNode === null ? {} : { currentNode: row.currentNode }),
      ...(row.currentAttemptId === null ? {} : { currentAttemptId: row.currentAttemptId }),
      ...(row.currentNodeStartedAt === null
        ? {}
        : { currentNodeStartedAt: new Date(row.currentNodeStartedAt).toISOString() }),
      ...(row.statusDetail === null ? {} : { statusDetail: row.statusDetail }),
      ...(row.humanDecisionHash === null
        ? {}
        : { humanDecision: this.readJsonAs(row.humanDecisionHash) }),
      ...(row.paused === 0 ? {} : { paused: true }),
      ...(row.waitingOn === null ? {} : { waitingOn: row.waitingOn }),
      ...(row.finalOutputHash === null
        ? {}
        : { finalOutput: this.state.readJson(row.finalOutputHash) }),
      ...(row.errorHash === null ? {} : { error: this.readText(row.errorHash) }),
    };
  }

  private readSteps(runId: string): WorkflowStepRecord[] {
    const rows = this.state.connection
      .prepare(
        `SELECT s.step_index AS stepIndex, a.attempt_id AS attemptId, a.node_id AS nodeId,
                a.node_type AS nodeType, a.status, a.prompt_hash AS promptHash,
                a.output_hash AS outputHash, s.output_override_hash AS outputOverrideHash,
                a.step_metadata_hash AS stepMetadataHash, a.error_hash AS errorHash,
                a.started_at AS startedAt, a.finished_at AS finishedAt
         FROM run_steps s
         JOIN node_attempts a ON a.attempt_id = s.attempt_id
         WHERE s.run_id = ? ORDER BY s.step_index`,
      )
      .all(runId)
      .filter(isStepRow);
    return rows.map((row, index) => {
      if (row.stepIndex !== index)
        throw new Error(`Workflow run step sequence has a gap: ${runId}`);
      const metadata =
        row.stepMetadataHash === null
          ? {}
          : this.readJsonAs<StoredStepMetadata>(row.stepMetadataHash);
      const prompt = row.promptHash === null ? null : this.readJsonAs<string>(row.promptHash);
      const outputHash = row.outputOverrideHash ?? row.outputHash;
      const output = outputHash === null ? null : this.state.readJson(outputHash);
      const error = row.errorHash === null ? undefined : this.readText(row.errorHash);
      return {
        attemptId: row.attemptId,
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        outcome: outcomeForStatus(row.status),
        startedAt: new Date(row.startedAt).toISOString(),
        finishedAt: new Date(row.finishedAt).toISOString(),
        prompt,
        output,
        ...(error === undefined ? {} : { error }),
        ...metadata,
      };
    });
  }

  private readUpdates(runId: string): Pick<WorkflowRunState, "updates"> {
    const rows = this.state.connection
      .prepare(
        `SELECT u.update_id AS updateId, u.run_revision AS runRevision,
                a.node_id AS nodeId, u.attempt_id AS attemptId,
                u.update_type AS updateType, u.update_key AS updateKey,
                u.data_hash AS dataHash, u.recorded_at AS recordedAt
         FROM workflow_updates u
         JOIN node_attempts a ON a.attempt_id = u.attempt_id
         WHERE a.run_id = ? ORDER BY u.run_revision`,
      )
      .all(runId)
      .filter(isUpdateRow);
    if (rows.length === 0) return {};
    let updates: WorkflowUpdateRecord[] | undefined;
    for (const row of rows) {
      updates = updateProjection(updates, {
        updateId: row.updateId,
        seq: row.runRevision,
        at: new Date(row.recordedAt).toISOString(),
        runId,
        nodeId: row.nodeId,
        attemptId: row.attemptId,
        type: row.updateType,
        key: row.updateKey,
        data: this.readJsonAs<Record<string, unknown>>(row.dataHash),
      });
    }
    return updates === undefined ? {} : { updates };
  }

  private readJsonAs<T>(hash: Buffer): T {
    return this.state.readJson(hash) as T;
  }

  private readText(hash: Buffer): string {
    const blob = this.state.readBlob(hash);
    if (blob === undefined || blob.mediaType !== "text/plain") {
      throw new Error("Text blob is missing or has the wrong media type");
    }
    return blob.content.toString("utf8");
  }

  private readDefinition(hash: Buffer): WorkflowDefinitionSnapshot {
    const value = this.state.readJson(hash);
    if (!isRecord(value) || value.schema !== DEFINITION_SNAPSHOT_SCHEMA) {
      throw new Error("Workflow definition snapshot has an incompatible schema");
    }
    return value as WorkflowDefinitionSnapshot;
  }

  private traceEvents(run: RunRow): WorkflowTraceEvent[] {
    const rows = this.state.connection
      .prepare(
        `SELECT resource_revision AS resourceRevision, event_type AS eventType,
                payload_hash AS payloadHash, recorded_at AS recordedAt
         FROM events WHERE resource_id = ? ORDER BY resource_revision`,
      )
      .all(run.resourceId);
    const events: WorkflowTraceEvent[] = [];
    for (const row of rows) {
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isEventRow(row)) continue;
      const payload = row.payloadHash === null ? {} : this.state.readJson(row.payloadHash);
      /* istanbul ignore if -- exact schema and internal query shape */
      if (!isRecord(payload)) throw new Error("Workflow trace payload is not an object");
      events.push({
        seq: row.resourceRevision,
        at: new Date(row.recordedAt).toISOString(),
        runId: run.runId,
        scope: traceScope(payload.scope),
        type: row.eventType,
        ...(typeof payload.nodeId === "string" ? { nodeId: payload.nodeId } : {}),
        ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
        payload: isRecord(payload.payload) ? payload.payload : {},
      });
    }
    return events;
  }

  private segmentRows(runId: string): SegmentRow[] {
    const rows = this.state.connection
      .prepare(
        `SELECT segment_id AS segmentId, run_id AS runId, attempt_id AS attemptId,
                capture_key AS captureKey, session_id AS sessionId, binding_hash AS bindingHash, status,
                entry_count AS entryCount, event_count AS eventCount,
                failure_hash AS failureHash, created_at AS createdAt, finished_at AS finishedAt
         FROM session_segments WHERE run_id = ? ORDER BY created_at, segment_id`,
      )
      .all(runId);
    return rows.filter(isSegmentRow);
  }

  private segmentRow(segmentId: string): SegmentRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT segment_id AS segmentId, run_id AS runId, attempt_id AS attemptId,
                capture_key AS captureKey, session_id AS sessionId, binding_hash AS bindingHash, status,
                entry_count AS entryCount, event_count AS eventCount,
                failure_hash AS failureHash, created_at AS createdAt, finished_at AS finishedAt
         FROM session_segments WHERE segment_id = ?`,
      )
      .get(segmentId);
    return isSegmentRow(row) ? row : undefined;
  }

  private requireSegment(segmentId: string): SegmentRow {
    const row = this.segmentRow(segmentId);
    if (row === undefined) throw new Error(`Session capture segment is missing: ${segmentId}`);
    return row;
  }

  private loadSegment(segment: SegmentRow, runState: WorkflowRunState): SessionCaptureSegment {
    const binding =
      segment.bindingHash === null
        ? null
        : (this.state.readJson(segment.bindingHash) as WorkflowSessionBinding);
    const entries = this.state.connection
      .prepare(
        `SELECT entry_seq AS entrySeq, entry_hash AS entryHash, recorded_at AS recordedAt
         FROM session_entries WHERE segment_id = ? ORDER BY entry_seq`,
      )
      .all(segment.segmentId)
      .filter(isSessionEntryRow)
      .map((row) => ({
        seq: row.entrySeq,
        at: new Date(row.recordedAt).toISOString(),
        entry: this.state.readJson(row.entryHash) as Record<string, unknown>,
      }));
    const events = this.state.connection
      .prepare(
        `SELECT event_seq AS eventSeq, event_type AS eventType, node_id AS nodeId,
                attempt_id AS attemptId, turn_id AS turnId, message_id AS messageId,
                tool_call_id AS toolCallId, payload_hash AS payloadHash,
                recorded_at AS recordedAt
         FROM session_events WHERE segment_id = ? ORDER BY event_seq`,
      )
      .all(segment.segmentId)
      .filter(isSessionEventRow)
      .map((row) => ({
        seq: row.eventSeq,
        at: new Date(row.recordedAt).toISOString(),
        nodeId: row.nodeId,
        attemptId: row.attemptId,
        ...(row.turnId === null ? {} : { turnId: row.turnId }),
        ...(row.messageId === null ? {} : { messageId: row.messageId }),
        ...(row.toolCallId === null ? {} : { toolCallId: row.toolCallId }),
        type: row.eventType,
        payload: this.state.readJson(row.payloadHash) as Record<string, unknown>,
      }));
    const failure =
      segment.failureHash === null
        ? undefined
        : (this.state.readJson(segment.failureHash) as WorkflowSessionCapture["failure"]);
    const capture: WorkflowSessionCapture = {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: segment.status,
      eventCount: segment.eventCount,
      entryCount: segment.entryCount,
      lastEventSeq: segment.eventCount,
      ...(failure === undefined ? {} : { failure }),
    };
    const diagnostics: string[] = [];
    if (entries.length !== segment.entryCount || events.length !== segment.eventCount) {
      diagnostics.push("session capture counts do not match durable rows");
    }
    if (runState.status !== "running" && segment.status === "recording") {
      diagnostics.push("terminal run still reports recording capture");
    }
    const integrity: SessionCaptureIntegrity =
      diagnostics.length > 0
        ? { status: "invalid", diagnostics }
        : segment.status === "failed"
          ? { status: "failed", diagnostics: [failure?.message ?? "session capture failed"] }
          : { status: segment.status, diagnostics: [] };
    return {
      attemptId: segment.captureKey ?? "",
      binding,
      entries,
      events,
      capture,
      integrity,
    };
  }

  private finalizeRecordingCaptures(runId: string, reason: string): void {
    for (const segment of this.segmentRows(runId)) {
      if (segment.status !== "recording") continue;
      const capture: WorkflowSessionCapture = {
        schema: SESSION_CAPTURE_SCHEMA,
        eventSchema: SESSION_EVENT_SCHEMA,
        status: "failed",
        eventCount: segment.eventCount,
        entryCount: segment.entryCount,
        lastEventSeq: segment.eventCount,
        failure: {
          failedAt: new Date().toISOString(),
          code: "host_interrupted",
          message: reason,
        },
      };
      const now = Date.now();
      this.state.transaction(() => {
        this.assertSessionWriteAuthority(runId);
        const failureHash = this.state.putJson(capture.failure, now);
        this.state.connection
          .prepare(
            `UPDATE session_segments
             SET status = 'failed', failure_hash = ?, finished_at = ?
             WHERE segment_id = ? AND status = 'recording'`,
          )
          .run(failureHash, now, segment.segmentId);
        const resourceId = segmentResourceId(segment);
        const revision = this.requireResourceRevision(resourceId);
        this.bumpResource(resourceId, revision, now);
        const payloadHash = this.state.putJson(capture, now);
        insertGenericEvent(
          this.state,
          resourceId,
          revision + 1,
          "session.capture_failed",
          "system",
          null,
          payloadHash,
          now,
        );
      });
    }
  }
}

export function readWorkflowRun(
  runId: string,
  options: ReadWorkflowRunOptions & { databasePath?: string } = {},
): LoadedWorkflowRun | null {
  const store = new WorkflowRunStore(options.databasePath ?? workflowStatePath(), {
    readOnly: true,
  });
  try {
    return store.readRun(runId, options);
  } finally {
    store.close();
  }
}

export function listWorkflowRuns(
  options: ReadWorkflowRunOptions & { databasePath?: string } = {},
): LoadedWorkflowRun[] {
  const store = new WorkflowRunStore(options.databasePath ?? workflowStatePath(), {
    readOnly: true,
  });
  try {
    return store.listRuns(options);
  } finally {
    store.close();
  }
}

export function readLastTraceEvent(
  runId: string,
  options: { databasePath?: string } = {},
): WorkflowTraceEvent | null {
  const store = new WorkflowRunStore(options.databasePath ?? workflowStatePath(), {
    readOnly: true,
  });
  try {
    return store.readLastTraceEvent(runId);
  } finally {
    store.close();
  }
}

function insertRunEvent(
  state: StateDatabase,
  resourceId: string,
  revision: number,
  at: string,
  event: WorkflowTraceEventDraft | WorkflowTraceEvent,
): void {
  const payload = compactTracePayload(event.type, event.payload);
  const payloadHash = state.putJson(
    {
      scope: event.scope,
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      payload,
    },
    Date.parse(at),
  );
  insertGenericEvent(
    state,
    resourceId,
    revision,
    event.type,
    "system",
    null,
    payloadHash,
    Date.parse(at),
  );
}

function compactTracePayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType === "node_finished" && Object.hasOwn(payload, "output")) {
    const { output: _output, ...rest } = payload;
    return { ...rest, outputStored: true };
  }
  if (eventType === "run_started" && Object.hasOwn(payload, "input")) {
    const { input: _input, ...rest } = payload;
    return { ...rest, inputStored: true };
  }
  if (Object.hasOwn(payload, "finalOutput")) {
    const { finalOutput: _finalOutput, ...rest } = payload;
    return { ...rest, finalOutputStored: true };
  }
  return payload;
}

function insertGenericEvent(
  state: StateDatabase,
  resourceId: string,
  revision: number,
  eventType: string,
  actorType: string,
  actorId: string | null,
  payloadHash: Buffer | null,
  now: number,
): void {
  state.connection
    .prepare(
      `INSERT INTO events(
         event_id, resource_id, resource_revision, event_type,
         actor_type, actor_id, payload_hash, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `event-${randomUUID()}`,
      resourceId,
      revision,
      eventType,
      actorType,
      actorId,
      payloadHash,
      now,
    );
}

function sourceForState(
  state: WorkflowRunState,
  definitionDigest: Buffer,
): { type: "builtin" | "file"; ref: string; revision: string } {
  const source = state.workflowSource;
  if (source?.kind === "builtin")
    return { type: "builtin", ref: source.id, revision: source.revision };
  if (source?.kind === "file") return { type: "file", ref: source.path, revision: source.hash };
  return {
    type: "file",
    ref: `inline:${state.workflowName}`,
    revision: definitionDigest.toString("hex"),
  };
}

function segmentIdFor(runId: string, attemptId?: string): string {
  return `segment-${createHash("sha256")
    .update(`${runId}\0${attemptId ?? ""}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function segmentResourceId(segment: SegmentRow): string {
  return resourceIdFor("session", segment.segmentId);
}

function outcomeStatus(outcome: string): string {
  switch (outcome) {
    case "ok":
      return "completed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function outcomeForStatus(status: string): WorkflowStepRecord["outcome"] {
  switch (status) {
    case "completed":
      return "ok";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      throw new Error(`Workflow step has nonterminal status: ${status}`);
  }
}

function stepMetadata(step: WorkflowStepRecord): StoredStepMetadata {
  return {
    ...(step.action === undefined ? {} : { action: step.action }),
    ...(step.assistantMessage === undefined ? {} : { assistantMessage: step.assistantMessage }),
    ...(step.conversation === undefined ? {} : { conversation: step.conversation }),
  };
}

function resultForStep(step: WorkflowStepRecord): WorkflowNodeResult {
  return {
    attemptId: step.attemptId,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    outcome: step.outcome,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    durationMs: Date.parse(step.finishedAt) - Date.parse(step.startedAt),
    ...(step.outcome === "ok" ? { output: step.output } : {}),
    ...(step.error === undefined ? {} : { error: step.error }),
  };
}

function traceScope(value: unknown): WorkflowTraceEvent["scope"] {
  return value === "node" || value === "agent" || value === "action" || value === "session"
    ? value
    : "run";
}

function emptySegment(): SessionCaptureSegment {
  return {
    attemptId: "",
    binding: null,
    entries: [],
    events: [],
    capture: null,
    integrity: { status: "unavailable", diagnostics: [] },
  };
}

function validateSessionEventRecord(record: WorkflowSessionEventRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error("Session event seq must be a positive safe integer");
  }
  if (
    record.at.length === 0 ||
    record.nodeId.length === 0 ||
    record.attemptId.length === 0 ||
    typeof record.payload !== "object" ||
    record.payload === null ||
    Array.isArray(record.payload)
  ) {
    throw new Error("Session event is missing required envelope fields");
  }
  if (
    record.type === "assistant_event" &&
    ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(record.payload.type))
  ) {
    throw new Error("Incremental assistant events are not durable session facts");
  }
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

function assertValidRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
    throw new Error(`Invalid workflow run id: ${JSON.stringify(runId)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunRow(value: unknown): value is RunRow {
  return isRecord(value);
}

function isRunIdRow(value: unknown): value is { runId: string } {
  return isRecord(value);
}

function isRunStepIdentityRow(value: unknown): value is {
  stepIndex: number;
  attemptId: string;
} {
  return isRecord(value);
}

function isAttemptOutputRow(value: unknown): value is { outputHash: Buffer | null } {
  return isRecord(value) && (value.outputHash === null || Buffer.isBuffer(value.outputHash));
}

function isStepRow(value: unknown): value is StepRow {
  return isRecord(value);
}

function isUpdateRow(value: unknown): value is UpdateRow {
  return isRecord(value);
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return isRecord(value);
}

function isAttemptNumberRow(value: unknown): value is { attemptNumber: number } {
  return isRecord(value);
}

function isUpdateSequenceRow(value: unknown): value is { updateSeq: number } {
  return isRecord(value);
}

function isEventRow(value: unknown): value is EventRow {
  return isRecord(value);
}

function isSegmentRow(value: unknown): value is SegmentRow {
  return isRecord(value);
}

function isSessionEntryRow(value: unknown): value is SessionEntryRow {
  return isRecord(value);
}

function isSessionEventRow(value: unknown): value is SessionEventRow {
  return isRecord(value);
}

function isLeaseAuthorityRow(value: unknown): value is {
  generation: number;
  ownerType: OwnerType | null;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
} {
  return isRecord(value);
}

export function createDefinitionSnapshot(workflow: WorkflowDefinition): WorkflowDefinitionSnapshot {
  const composition = compositionMetadata(workflow)?.snapshot;
  return {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    name: workflow.name,
    ...(workflow.contractId !== undefined ? { contractId: workflow.contractId } : {}),
    startAt: workflow.startAt,
    nodes: Object.fromEntries(
      Object.entries(workflow.nodes).map(([nodeId, node]) => [
        nodeId,
        snapshotNode(workflow, nodeId, node),
      ]),
    ),
    edges: structuredClone(workflow.edges),
    ...(composition !== undefined ? { composition: structuredClone(composition) } : {}),
  };
}

function snapshotNode(
  workflow: WorkflowDefinition,
  nodeId: string,
  node: WorkflowNodeDefinition,
): WorkflowNodeSnapshot {
  const composition = compositionMetadata(workflow);
  const entry = composition?.entries[nodeId];
  const exit = composition?.exits[nodeId];
  const scope = Object.values(composition?.scopes ?? {})
    .filter((candidate) => candidate.path !== "" && nodeId.startsWith(`${candidate.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const mountPath = entry?.mountPath ?? exit?.mountPath ?? scope?.path;
  const localNodeId =
    entry !== undefined
      ? entry.mountName
      : exit !== undefined
        ? exit.exitName
        : scope !== undefined
          ? nodeId.slice(scope.path.length + 1)
          : undefined;
  const common: WorkflowNodeSnapshot = {
    nodeType: node.nodeType,
    ...(mountPath !== undefined ? { mountPath: mountPath.split("/") } : {}),
    ...(localNodeId !== undefined ? { localNodeId } : {}),
    ...(entry !== undefined
      ? { includeTransition: "entry" as const }
      : exit !== undefined
        ? { includeTransition: "exit" as const }
        : {}),
    ...(typeof node.timeoutMs === "number" || node.timeoutMs === null
      ? { timeoutMs: node.timeoutMs }
      : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  if (node.nodeType === "agent" && node.expectedOutput !== undefined) {
    common.expectedOutput = node.expectedOutput;
  }
  if (node.nodeType === "notify") common.summary = node.kind ?? "progress";
  if (node.nodeType === "checkpoint" && node.summary !== undefined) common.summary = node.summary;
  if (node.nodeType === "checkpoint" && node.humanDecision !== undefined) {
    common.humanDecision = {
      audience:
        typeof node.humanDecision.audience === "string" ? node.humanDecision.audience : "<dynamic>",
      ...(typeof node.humanDecision.audience === "function" ? { dynamicAudience: true } : {}),
      choices: structuredClone(node.humanDecision.choices),
      ...(node.humanDecision.onTimeout !== undefined &&
      typeof node.humanDecision.onTimeout !== "function"
        ? { onTimeout: structuredClone(node.humanDecision.onTimeout) }
        : {}),
      ...(typeof node.humanDecision.onTimeout === "function" ? { dynamicTimeout: true } : {}),
    };
  }
  if (node.nodeType === "action") common.actionExecution = "exec" in node ? "shell" : "function";
  return common;
}
