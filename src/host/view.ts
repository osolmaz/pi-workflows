import { createHash } from "node:crypto";
import { ORIGIN_ACTIVITY_LEASE_MS } from "../client/activity.js";
import {
  RUN_VIEW_SCHEMA,
  SESSION_VIEW_SCHEMA,
  type OriginActivityReport,
  type WorkflowDisplay,
  type WorkflowDisplayStatus,
  type WorkflowRunQueueView,
  type WorkflowRunSummary,
  type WorkflowRunView,
  type WorkflowSessionView,
} from "../client/view.js";
import type { SqliteControllerStore, WorkflowRunQueueRecord } from "../controllers/sqlite.js";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import type { WorkflowRunDisplayState, WorkflowRunStore } from "../workflows/store.js";
import type {
  WorkflowRunState,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowStepRecord,
  WorkflowTraceEvent,
  WorkflowUpdateRecord,
} from "../workflows/types.js";
import type { HostStateStore, InteractiveRequestRecord } from "./state.js";

export type { OriginActivityReport } from "../client/view.js";

type OriginActivity = OriginActivityReport & {
  connectionId: string;
  expiresAt: number;
};

export const WORKFLOW_PAGE_KINDS = [
  "steps",
  "trace",
  "trace_at_step",
  "session_entries",
  "session_events",
  "settings",
  "follow_ups",
  "updates",
] as const;

export type WorkflowPageKind = (typeof WORKFLOW_PAGE_KINDS)[number];

type RunPageRequest = {
  kind: WorkflowPageKind;
  cursor: number;
};

type ContentRecord = {
  runId: string;
  path: string;
  mediaType: "application/json" | "text/plain";
  bytes: Buffer;
  sha256: string;
};

const INLINE_CONTENT_BYTES = 16 * 1024;
const VIEW_PAGE_BYTES = 64 * 1024;
const VIEW_PAGE_ITEMS = 256;
const CONTENT_CHUNK_BYTES = 192 * 1024;
const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;

export class HostViewStore {
  private readonly activity = new Map<string, OriginActivity>();
  private readonly contentRecords = new Map<string, ContentRecord>();
  private contentBytes = 0;

  constructor(
    private readonly state: StateDatabase,
    private readonly queue: SqliteControllerStore,
    private readonly hostState: HostStateStore,
    private readonly runs: WorkflowRunStore,
    private readonly hasLiveWorker: (runId: string) => boolean,
  ) {}

  list(limit?: number): WorkflowRunSummary[] {
    this.expireActivity();
    return this.state.readTransaction(() =>
      this.queue.listWorkflowRuns(limit === undefined ? {} : { limit }).map((run) => {
        const display = this.display(run, this.runs.readDisplayState(run.runId));
        return {
          runId: run.runId,
          workflowName: run.workflowName,
          originSessionId: run.originSessionId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          display,
          manifest: manifest(run, display.status),
          live: display.status === "running" || display.status === "waiting",
          possiblyInterrupted: run.status === "parked" && display.status !== "paused",
        };
      }),
    );
  }

  run(runId: string): WorkflowRunView | null {
    this.expireActivity();
    return this.state.readTransaction(() => this.readRun(runId));
  }

  page(runId: string, request: RunPageRequest): WorkflowRunView | null {
    this.expireActivity();
    return this.state.readTransaction(() => this.readRun(runId, request));
  }

  private readRun(runId: string, page?: RunPageRequest): WorkflowRunView | null {
    const queue = this.queue.getWorkflowRun(runId);
    const loaded = this.runs.readRun(runId, { includeTrace: true });
    if (queue === undefined || loaded === null) return null;
    const revision = this.presentationRevision(runId);
    const display = this.display(queue, loaded.state);
    const steps = loaded.state.steps;
    const updates = loaded.state.updates ?? [];
    const trace = loaded.traceEvents ?? [];
    const settings = loaded.settingsScopes ?? [];
    const followUps = loaded.followUpQueue?.followUps ?? [];
    const graphCursor =
      page?.kind === "steps"
        ? clampCursor(page.cursor, steps.length)
        : Math.max(0, steps.length - 1);
    const traceCursor =
      page?.kind === "trace_at_step"
        ? traceCursorForStep(trace, steps, page.cursor)
        : page?.kind === "trace"
          ? page.cursor
          : undefined;
    const stepPage = byteBoundedPage(
      steps,
      page?.kind === "steps" ? page.cursor : undefined,
      (step) => this.projectStep(runId, step),
    );
    const tracePage = byteBoundedPage(trace, traceCursor, (event) =>
      this.projectTraceEvent(runId, event),
    );
    const entryPage = byteBoundedPage(
      loaded.sessionEntries,
      page?.kind === "session_entries" ? page.cursor : undefined,
      (entry) => this.projectSessionEntry(runId, entry),
    );
    const eventPage = byteBoundedPage(
      loaded.sessionEvents,
      page?.kind === "session_events" ? page.cursor : undefined,
      (event) => this.projectSessionEvent(runId, event),
    );
    const settingsPage = byteBoundedPage(
      settings,
      page?.kind === "settings" ? page.cursor : undefined,
      (scope) => this.projectRecordField(runId, scope, "settings"),
    );
    const followUpPage = byteBoundedPage(
      followUps,
      page?.kind === "follow_ups" ? page.cursor : undefined,
      (followUp) => this.projectRecordField(runId, followUp, "prompt"),
    );
    const updatePage = byteBoundedPage(
      updates,
      page?.kind === "updates" ? page.cursor : undefined,
      (update) => this.projectUpdate(runId, update),
    );
    const stepsThroughCursor = steps.slice(0, steps.length === 0 ? 0 : graphCursor + 1);
    const latestStepByNode = new Map(
      stepsThroughCursor.map((step) => [step.nodeId, step] as const),
    );
    const graphSteps = stepsThroughCursor
      .filter((step) => latestStepByNode.get(step.nodeId) === step)
      .map(toCompactStepJson);
    const takenTransitions = [
      ...new Set(
        stepsThroughCursor.slice(1).map((step, index) => {
          const previous = stepsThroughCursor[index] as (typeof stepsThroughCursor)[number];
          return `${previous.nodeId}->${step.nodeId}`;
        }),
      ),
    ].sort();
    const followUpQueue =
      loaded.followUpQueue === null || loaded.followUpQueue === undefined
        ? null
        : projectFollowUpQueue(loaded.followUpQueue, followUpPage.items);
    const state = this.projectState(runId, loaded.state, stepPage.items, updatePage.items);
    return {
      schema: RUN_VIEW_SCHEMA,
      runId,
      revision,
      display,
      manifest: manifest(queue, display.status),
      state,
      workflow: this.projectWorkflow(runId, loaded.snapshot),
      queue: projectQueue(queue),
      updates: updatePage.items,
      graphSteps,
      takenTransitions,
      graphCursor,
      stepStart: stepPage.start,
      stepTotal: stepPage.total,
      tracePage,
      session: {
        binding: toJson(loaded.sessionBinding),
        entryPage,
        eventPage,
        capture: toJson(loaded.sessionCapture),
        integrity: toJson(loaded.sessionIntegrity),
        replayCheckpoint: this.runs.readSessionReplayCheckpoint(runId, eventPage.start),
      },
      settingsScopes: settingsPage.items,
      settingsStart: settingsPage.start,
      settingsTotal: settingsPage.total,
      followUpQueue: toJson(followUpQueue),
      followUpStart: followUpPage.start,
      followUpTotal: followUpPage.total,
      updateStart: updatePage.start,
      updateTotal: updatePage.total,
      live: display.status === "running" || display.status === "waiting",
      possiblyInterrupted: queue.status === "parked" && display.status !== "paused",
    };
  }

  session(sessionId: string): WorkflowSessionView {
    this.expireActivity();
    return this.state.readTransaction(() => {
      const queue =
        this.queue.findSessionReservation(sessionId) ?? this.latestSessionRun(sessionId);
      const pending = this.hostState.listPendingInteractions(sessionId);
      return {
        schema: SESSION_VIEW_SCHEMA,
        sessionId,
        run: queue === undefined ? null : this.readRun(queue.runId),
        pendingInteractions: pending.map((request) =>
          this.projectRecordField(request.runId, request, "contract"),
        ),
        deliveries: {
          notification: this.queue.hasClaimableWorkflowNotification({
            targetSessionId: sessionId,
          }),
          turn: this.queue.hasClaimableWorkflowTurnIntent({ targetSessionId: sessionId }),
        },
      };
    });
  }

  content(runId: string, contentPath: string, offset: number): JsonValue | null {
    const key = contentKey(runId, contentPath);
    const record = this.contentRecords.get(key) ?? this.recoverContent(runId, contentPath);
    if (record === undefined) return null;
    this.contentRecords.delete(key);
    this.contentRecords.set(key, record);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.bytes.byteLength) {
      throw new Error("Workflow content offset is outside the content range");
    }
    const nextOffset = Math.min(record.bytes.byteLength, offset + CONTENT_CHUNK_BYTES);
    return {
      schema: "pi-workflows.content-chunk.v1",
      runId,
      path: record.path,
      mediaType: record.mediaType,
      bytes: record.bytes.byteLength,
      sha256: record.sha256,
      offset,
      nextOffset,
      complete: nextOffset === record.bytes.byteLength,
      data: record.bytes.subarray(offset, nextOffset).toString("base64"),
    };
  }

  private projectStep(runId: string, step: WorkflowStepRecord): JsonValue {
    const projected = toJson(step);
    if (!isJsonObject(projected)) return projected;
    for (const field of ["prompt", "output", "assistantMessage"] as const) {
      const value = projected[field];
      if (value !== undefined) projected[field] = this.projectValue(runId, value);
    }
    return projected;
  }

  private projectTraceEvent(runId: string, event: WorkflowTraceEvent): JsonValue {
    return this.projectRecordField(runId, event, "payload");
  }

  private projectSessionEntry(runId: string, entry: WorkflowSessionEntryRecord): JsonValue {
    return this.projectRecordField(runId, entry, "entry");
  }

  private projectSessionEvent(runId: string, event: WorkflowSessionEventRecord): JsonValue {
    return this.projectRecordField(runId, event, "payload");
  }

  private projectUpdate(runId: string, update: WorkflowUpdateRecord): JsonValue {
    return this.projectRecordField(runId, update, "data");
  }

  private projectRecordField(runId: string, value: unknown, field: string): JsonValue {
    const projected = toJson(value);
    if (isJsonObject(projected)) {
      const fieldValue = projected[field];
      if (fieldValue !== undefined) projected[field] = this.projectValue(runId, fieldValue);
    }
    return projected;
  }

  private projectState(
    runId: string,
    stateValue: WorkflowRunState,
    steps: JsonValue[],
    updates: JsonValue[],
  ): JsonValue {
    const state = toJson(stateValue);
    if (!isJsonObject(state)) return state;
    for (const field of ["input", "outputs", "results", "humanDecision", "finalOutput"] as const) {
      const value = state[field];
      if (value !== undefined) state[field] = this.projectValue(runId, value);
    }
    state.steps = steps;
    state.updates = updates;
    return state;
  }

  private projectWorkflow(runId: string, value: unknown): JsonValue {
    const workflow = escapeArtifactSentinels(toJson(value));
    if (Buffer.byteLength(canonicalJson(workflow)) <= VIEW_PAGE_BYTES * 2) return workflow;
    if (
      !isJsonObject(workflow) ||
      !isJsonObject(workflow.nodes) ||
      typeof workflow.schema !== "string" ||
      typeof workflow.name !== "string" ||
      typeof workflow.startAt !== "string" ||
      !Array.isArray(workflow.edges)
    ) {
      return this.registerContent(runId, workflow, "application/json");
    }
    const nodes = Object.fromEntries(
      Object.entries(workflow.nodes).map(([nodeId, node]) => {
        if (!isJsonObject(node)) return [nodeId, node];
        const projected = Object.fromEntries(
          [
            "nodeType",
            "timeoutMs",
            "statusDetail",
            "actionExecution",
            "settingsRoute",
            "effect",
            "mountPath",
            "localNodeId",
            "includeTransition",
          ].flatMap((field) => (node[field] === undefined ? [] : [[field, node[field]]])),
        );
        return [nodeId, projected];
      }),
    );
    return {
      schema: workflow.schema,
      name: workflow.name,
      startAt: workflow.startAt,
      nodes,
      edges: workflow.edges,
      content: this.registerContent(runId, workflow, "application/json"),
    };
  }

  private projectValue(runId: string, value: JsonValue): JsonValue {
    const safeValue = escapeArtifactSentinels(value);
    const mediaType = typeof safeValue === "string" ? "text/plain" : "application/json";
    const bytes =
      mediaType === "text/plain"
        ? Buffer.from(safeValue as string, "utf8")
        : Buffer.from(canonicalJson(safeValue), "utf8");
    return bytes.byteLength <= INLINE_CONTENT_BYTES
      ? safeValue
      : this.registerContent(runId, safeValue, mediaType);
  }

  private registerContent(
    runId: string,
    value: JsonValue,
    mediaType: ContentRecord["mediaType"],
  ): JsonValue {
    const bytes = Buffer.from(
      mediaType === "text/plain" ? (value as string) : canonicalJson(value),
      "utf8",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = mediaType === "text/plain" ? "txt" : "json";
    const contentPath = `artifacts/sha256/${sha256}.${extension}`;
    this.rememberContent({
      runId,
      path: contentPath,
      mediaType,
      bytes,
      sha256,
    });
    return {
      $artifact: {
        path: contentPath,
        mediaType,
        bytes: bytes.byteLength,
        sha256,
      },
    };
  }

  private rememberContent(record: ContentRecord): ContentRecord {
    const key = contentKey(record.runId, record.path);
    const previous = this.contentRecords.get(key);
    if (previous !== undefined) this.contentBytes -= previous.bytes.byteLength;
    this.contentRecords.delete(key);
    this.contentRecords.set(key, record);
    this.contentBytes += record.bytes.byteLength;
    while (this.contentBytes > CONTENT_CACHE_BYTES && this.contentRecords.size > 1) {
      const oldest = this.contentRecords.entries().next().value as
        | [string, ContentRecord]
        | undefined;
      if (oldest === undefined) break;
      this.contentRecords.delete(oldest[0]);
      this.contentBytes -= oldest[1].bytes.byteLength;
    }
    return record;
  }

  private recoverContent(runId: string, contentPath: string): ContentRecord | undefined {
    const match = /^artifacts\/sha256\/([0-9a-f]{64})\.(json|txt)$/u.exec(contentPath);
    if (match === null) return undefined;
    const loaded = this.runs.readRun(runId, { includeTrace: true });
    if (loaded === null) return undefined;
    const candidates: JsonValue[] = [toJson(loaded.snapshot)];
    for (const field of ["input", "outputs", "results", "humanDecision", "finalOutput"] as const) {
      const value = loaded.state[field];
      if (value !== undefined) candidates.push(toJson(value));
    }
    for (const step of loaded.state.steps) {
      for (const value of [step.prompt, step.output, step.assistantMessage]) {
        if (value !== undefined) candidates.push(toJson(value));
      }
    }
    for (const update of loaded.state.updates ?? []) candidates.push(toJson(update.data));
    for (const event of loaded.traceEvents ?? []) candidates.push(toJson(event.payload));
    for (const entry of loaded.sessionEntries) candidates.push(toJson(entry.entry));
    for (const event of loaded.sessionEvents) candidates.push(toJson(event.payload));
    for (const scope of loaded.settingsScopes ?? []) candidates.push(toJson(scope.settings));
    for (const followUp of loaded.followUpQueue?.followUps ?? []) {
      candidates.push(toJson(followUp.prompt));
    }
    const mediaType = match[2] === "txt" ? "text/plain" : "application/json";
    for (const candidate of candidates) {
      const safeCandidate = escapeArtifactSentinels(candidate);
      if (mediaType === "text/plain" && typeof safeCandidate !== "string") continue;
      const bytes = Buffer.from(
        mediaType === "text/plain" ? (safeCandidate as string) : canonicalJson(safeCandidate),
        "utf8",
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 === match[1]) {
        return this.rememberContent({
          runId,
          path: contentPath,
          mediaType,
          bytes,
          sha256,
        });
      }
    }
    return undefined;
  }

  reportActivity(connectionId: string, report: OriginActivityReport): void {
    const key = activityKey(connectionId, report.deliveryId);
    const previous = this.activity.get(key);
    if (report.state === "settled") {
      if (previous === undefined) return;
      if (
        previous.sessionId !== report.sessionId ||
        previous.runId !== report.runId ||
        previous.requestId !== report.requestId ||
        previous.sessionEntryId !== report.sessionEntryId
      ) {
        throw new Error("Origin activity identity changed");
      }
      if (report.sequence <= previous.sequence) {
        throw new Error("Origin activity sequence must increase");
      }
      this.activity.delete(key);
      return;
    }
    const request = this.hostState
      .listPendingInteractions(report.sessionId)
      .find((candidate) => candidate.requestId === report.requestId);
    validateActivityRequest(request, report);
    if (previous !== undefined) {
      if (
        previous.sessionId !== report.sessionId ||
        previous.runId !== report.runId ||
        previous.requestId !== report.requestId ||
        previous.sessionEntryId !== report.sessionEntryId
      ) {
        throw new Error("Origin activity identity changed");
      }
      if (report.sequence <= previous.sequence) {
        throw new Error("Origin activity sequence must increase");
      }
    } else if (report.state !== "started") {
      throw new Error("Origin activity must start before refresh");
    }
    this.activity.set(key, {
      ...report,
      connectionId,
      expiresAt: Date.now() + ORIGIN_ACTIVITY_LEASE_MS,
    });
  }

  clearConnection(connectionId: string): void {
    for (const [key, value] of this.activity) {
      if (value.connectionId === connectionId) this.activity.delete(key);
    }
  }

  expireActivity(now = Date.now()): void {
    for (const [key, value] of this.activity) {
      if (value.expiresAt <= now) this.activity.delete(key);
    }
  }

  private display(
    queue: WorkflowRunQueueRecord,
    state?: WorkflowRunDisplayState | WorkflowRunState | null,
  ): WorkflowDisplay {
    return reduceWorkflowDisplay({
      queueStatus: queue.status,
      durableStatus: state?.status,
      paused: state?.paused === true,
      ambiguous: this.hasAmbiguousEffect(queue.runId),
      workerActive: this.hasLiveWorker(queue.runId),
      originTurnActive: this.hasActivity(queue.runId),
      pendingInteraction: this.hasPendingInteraction(queue.runId),
      errorMessage: state?.error ?? queue.errorMessage,
    });
  }

  private hasActivity(runId: string): boolean {
    for (const activity of this.activity.values()) {
      if (activity.runId === runId) return true;
    }
    return false;
  }

  private hasPendingInteraction(runId: string): boolean {
    const row = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM interactive_requests
         WHERE run_id = ? AND status IN ('pending', 'presenting') LIMIT 1`,
      )
      .get(runId);
    return row !== undefined;
  }

  private hasAmbiguousEffect(runId: string): boolean {
    const row = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
         WHERE r.run_id = ? AND e.status IN ('applying', 'ambiguous') LIMIT 1`,
      )
      .get(runId);
    return row !== undefined;
  }

  private latestSessionRun(sessionId: string): WorkflowRunQueueRecord | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT b.run_id AS runId FROM run_bindings b
         JOIN run_queue q ON q.run_id = b.run_id
         WHERE b.origin_session_id = ?
         ORDER BY b.created_at DESC, b.run_id DESC LIMIT 1`,
      )
      .get(sessionId);
    if (!isRunIdRow(row)) return undefined;
    return this.queue.getWorkflowRun(row.runId);
  }

  private presentationRevision(runId: string): number {
    const row = this.state.connection
      .prepare(`SELECT presentation_revision AS revision FROM viewer_runs WHERE run_id = ?`)
      .get(runId);
    return isRevisionRow(row) ? row.revision : 0;
  }
}

export type WorkflowDisplayFacts = {
  queueStatus: WorkflowRunQueueRecord["status"];
  durableStatus: WorkflowRunState["status"] | undefined;
  paused: boolean;
  ambiguous: boolean;
  workerActive: boolean;
  originTurnActive: boolean;
  pendingInteraction: boolean;
  errorMessage: string | null;
};

export function reduceWorkflowDisplay(facts: WorkflowDisplayFacts): WorkflowDisplay {
  let status: WorkflowDisplayStatus;
  let activity: WorkflowDisplay["activity"] = null;
  let reason: string | null = null;

  if (facts.ambiguous) {
    status = "ambiguous";
    reason = "An external effect needs explicit recovery.";
  } else if (
    facts.durableStatus === "completed" ||
    facts.durableStatus === "failed" ||
    facts.durableStatus === "timed_out" ||
    facts.durableStatus === "cancelled"
  ) {
    status = facts.durableStatus;
    reason = boundedReason(facts.errorMessage);
  } else if (facts.paused) {
    status = "paused";
    reason = "The workflow is durably paused.";
  } else if (facts.workerActive || facts.originTurnActive) {
    status = "running";
    activity = facts.workerActive ? "supervised_worker" : "origin_turn";
  } else if (facts.pendingInteraction || facts.durableStatus === "waiting") {
    status = "waiting";
    reason = "The workflow is waiting for origin-session input.";
  } else if (facts.queueStatus === "parked" || facts.queueStatus === "queued") {
    status = "queued";
    reason = facts.queueStatus === "parked" ? "The workflow is ready to resume." : null;
  } else if (facts.queueStatus === "done") {
    status = "completed";
  } else if (facts.queueStatus === "failed" || facts.queueStatus === "cancelled") {
    status = facts.queueStatus;
    reason = boundedReason(facts.errorMessage);
  } else {
    status = "running";
  }

  const controls: WorkflowDisplay["controls"] = [];
  if (status === "running" || status === "waiting") controls.push("pause", "cancel");
  else if (status === "paused") controls.push("resume", "cancel");
  else if (status === "queued") {
    if (facts.queueStatus === "parked") controls.push("resume");
    controls.push("cancel");
  }
  if (status === "waiting") controls.push("answer");
  if (status === "ambiguous") controls.push("review");
  return { status, activity, controls, reason };
}

function manifest(run: WorkflowRunQueueRecord, status: WorkflowDisplayStatus): JsonValue {
  return {
    schema: "pi-workflows.run-manifest.v1",
    runId: run.runId,
    workflowName: run.workflowName,
    workflowSource: workflowRootSource(run.workflowSource),
    startedAt: run.startedAt ?? run.createdAt,
    ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
    status,
    traceSchema: "pi-workflows.trace-event.v1",
    paths: {
      workflow: "host",
      state: "host",
      trace: "host",
    },
  };
}

function projectQueue(run: WorkflowRunQueueRecord): WorkflowRunQueueView {
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    workflowSourceRef: run.workflowSourceRef,
    initialized: run.initialized,
    definitionDigest: run.definitionDigest,
    status: run.status,
    originSessionId: run.originSessionId,
    executionMode: run.executionMode,
    parentRunId: run.parentRunId,
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function workflowRootSource(value: unknown): JsonValue {
  const sourceSet = toJson(value);
  if (!isJsonObject(sourceSet)) throw new Error("Workflow queue source set is invalid");
  const root = sourceSet.root;
  if (root === undefined || !isJsonObject(root)) {
    throw new Error("Workflow queue source set is invalid");
  }
  return root;
}

function validateActivityRequest(
  request: InteractiveRequestRecord | undefined,
  report: OriginActivityReport,
): asserts request is InteractiveRequestRecord {
  if (request === undefined) throw new Error("Origin activity request is not pending");
  if (request.runId !== report.runId || request.targetSessionId !== report.sessionId) {
    throw new Error("Origin activity target does not match the interactive request");
  }
  if (request.presentationSessionEntryId !== report.sessionEntryId) {
    throw new Error("Origin activity session entry was not durably presented");
  }
  if (!Number.isSafeInteger(report.sequence) || report.sequence < 0) {
    throw new Error("Origin activity sequence must be a non-negative integer");
  }
}

function activityKey(connectionId: string, deliveryId: string): string {
  return `${connectionId}\u0000${deliveryId}`;
}

function contentKey(runId: string, contentPath: string): string {
  return `${runId}\u0000${contentPath}`;
}

function escapeArtifactSentinels(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(escapeArtifactSentinels);
  if (!isJsonObject(value)) return value;
  const escaped = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, escapeArtifactSentinels(item)]),
  ) as JsonValue;
  return Object.keys(value).length === 1 &&
    (Object.hasOwn(value, "$artifact") || Object.hasOwn(value, "$escaped"))
    ? { $escaped: escaped }
    : escaped;
}

function projectFollowUpQueue(value: unknown, items: JsonValue[]): JsonValue {
  const queue = toJson(value);
  if (!isJsonObject(queue)) return queue;
  delete queue.followUps;
  queue.items = items;
  return queue;
}

function byteBoundedPage<T>(
  values: readonly T[],
  requestedCursor: number | undefined,
  project: (value: T) => JsonValue,
): { start: number; total: number; items: JsonValue[] } {
  const total = values.length;
  if (total === 0) return { start: 0, total: 0, items: [] };
  const cursor = clampCursor(requestedCursor ?? total - 1, total);
  const selected = project(values[cursor] as T);
  const selectedBytes = Buffer.byteLength(canonicalJson(selected));
  const indexed = new Map<number, JsonValue>([[cursor, selected]]);
  let pageBytes = selectedBytes;
  let left = cursor - 1;
  let right = cursor + 1;
  let leftBlocked = false;
  let rightBlocked = false;
  let preferLeft = true;

  while (indexed.size < VIEW_PAGE_ITEMS && (!leftBlocked || !rightBlocked)) {
    const index = preferLeft ? left : right;
    const inRange = index >= 0 && index < total;
    if (!inRange) {
      if (preferLeft) leftBlocked = true;
      else rightBlocked = true;
    } else {
      const item = project(values[index] as T);
      const itemBytes = Buffer.byteLength(canonicalJson(item)) + 1;
      if (pageBytes + itemBytes > VIEW_PAGE_BYTES) {
        if (preferLeft) leftBlocked = true;
        else rightBlocked = true;
      } else {
        indexed.set(index, item);
        pageBytes += itemBytes;
        if (preferLeft) left -= 1;
        else right += 1;
      }
    }
    preferLeft = !preferLeft;
  }

  const ordered = [...indexed.entries()].sort(
    ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
  );
  return {
    start: ordered[0]?.[0] ?? cursor,
    total,
    items: ordered.map(([, item]) => item),
  };
}

export function toCompactStepJson(step: WorkflowStepRecord): JsonValue {
  return toJson({
    attemptId: step.attemptId,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    outcome: step.outcome,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    prompt: null,
    output: null,
    ...(step.settingsScopeId === undefined ? {} : { settingsScopeId: step.settingsScopeId }),
    ...(step.settingsChangeNumber === undefined
      ? {}
      : { settingsChangeNumber: step.settingsChangeNumber }),
    ...(step.settingsHash === undefined ? {} : { settingsHash: step.settingsHash }),
  });
}

export function workflowPageStart(total: number, cursor?: number): number {
  if (total <= 256) return 0;
  if (cursor === undefined) return total - 256;
  const center = clampCursor(cursor, total);
  return Math.min(Math.max(0, center - 128), total - 256);
}

function clampCursor(cursor: number, total: number): number {
  return total === 0 ? 0 : Math.min(cursor, total - 1);
}

function traceCursorForStep(
  trace: readonly { attemptId?: string; nodeId?: string }[],
  steps: readonly { attemptId: string; nodeId: string }[],
  cursor: number,
): number {
  const step = steps[clampCursor(cursor, steps.length)];
  if (step === undefined) return 0;
  const traceIndex = trace.findLastIndex(
    (event) => event.attemptId === step.attemptId || event.nodeId === step.nodeId,
  );
  return traceIndex === -1 ? clampCursor(cursor, trace.length) : traceIndex;
}

function boundedReason(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function toJson(value: unknown): JsonValue {
  return parseJson(canonicalJson(value));
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunIdRow(value: unknown): value is { runId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === "string"
  );
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}
