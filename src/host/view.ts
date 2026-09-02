import { createHash } from "node:crypto";
import {
  RUN_VIEW_SCHEMA,
  SESSION_VIEW_SCHEMA,
  type WorkflowDisplay,
  type WorkflowDisplayStatus,
  type WorkflowRunListPage,
  type WorkflowRunQueueView,
  type WorkflowRunSummary,
  type WorkflowRunView,
  type WorkflowSessionView,
} from "../client/view.js";
import type {
  SqliteControllerStore,
  WorkflowRunQueueRecord,
  WorkflowRunQueueViewRecord,
} from "../controllers/sqlite.js";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import { WorkflowMessageStore, type WorkflowMessage } from "../state/workflow-messages.js";
import type { WorkflowRunDisplayState, WorkflowRunStore } from "../workflows/store.js";
import type {
  WorkflowRunState,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowStepRecord,
  WorkflowTraceEvent,
  WorkflowUpdateRecord,
} from "../workflows/types.js";
import type { HostStateStore } from "./state.js";

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
const VIEW_CACHE_ITEMS = 64;
const TERMINAL_VIEW_RETENTION_MS = 60_000;

export class HostViewStore {
  private readonly contentRecords = new Map<string, ContentRecord>();
  private readonly listCache = new Map<string, { revision: string; page: WorkflowRunListPage }>();
  private readonly runCache = new Map<string, { version: string; view: WorkflowRunView | null }>();
  private readonly sessionCache = new Map<string, { version: string; view: WorkflowSessionView }>();
  private contentBytes = 0;
  private readonly workflowMessages: WorkflowMessageStore;

  constructor(
    private readonly state: StateDatabase,
    private readonly queue: SqliteControllerStore,
    private readonly hostState: HostStateStore,
    private readonly runs: WorkflowRunStore,
    private readonly hasLiveWorker: (runId: string) => boolean,
  ) {
    this.workflowMessages = hostState.workflowMessages;
  }

  list(cursor = 0, limit?: number): WorkflowRunListPage {
    return this.state.readTransaction(() => {
      const pageSize = Math.min(limit ?? VIEW_PAGE_ITEMS, VIEW_PAGE_ITEMS);
      const current = this.queue.workflowRunListRevision();
      const revision = `${current.revision}:${this.workflowActivityRevision()}`;
      const cacheKey = `${cursor}:${pageSize}`;
      const cached = this.listCache.get(cacheKey);
      if (cached?.revision === revision) {
        refreshCacheEntry(this.listCache, cacheKey, cached);
        return cached.page;
      }
      const loaded = this.queue.listWorkflowRunViews({ offset: cursor, limit: pageSize });
      const summaries = loaded.runs.map((run) => {
        const display = this.projectDisplay(
          run.runId,
          this.display(run, {
            status: run.runStateStatus as WorkflowRunState["status"],
            paused: run.paused,
            error: run.errorMessage,
          }),
        );
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
        } satisfies WorkflowRunSummary;
      });
      const items = byteBoundedForwardPage(summaries, (summary) => toJson(summary)).map(
        (item) => item as WorkflowRunSummary,
      );
      const page: WorkflowRunListPage = {
        schema: "pi-workflows.run-list-page.v1",
        revision,
        start: cursor,
        total: loaded.total,
        items,
      };
      rememberCacheEntry(this.listCache, cacheKey, { revision, page });
      return page;
    });
  }

  run(runId: string): WorkflowRunView | null {
    return this.state.readTransaction(() => {
      const version = this.runVersion(runId);
      const cached = this.runCache.get(runId);
      if (cached?.version === version) {
        refreshCacheEntry(this.runCache, runId, cached);
        return cached.view;
      }
      const view = this.readRun(runId);
      rememberCacheEntry(this.runCache, runId, { version, view });
      return view;
    });
  }

  page(runId: string, request: RunPageRequest): WorkflowRunView | null {
    return this.state.readTransaction(() => this.readRun(runId, request));
  }

  private readRun(runId: string, page?: RunPageRequest): WorkflowRunView | null {
    const queue = this.queue.getWorkflowRunView(runId);
    const counts = this.runs.readRunViewCounts(runId);
    if (queue === undefined || counts === null) return null;
    const graphCursor =
      page?.kind === "steps"
        ? clampCursor(page.cursor, counts.steps)
        : Math.max(0, counts.steps - 1);
    const traceCursor =
      page?.kind === "trace_at_step"
        ? this.runs.traceCursorForStep(runId, page.cursor, counts.trace)
        : page?.kind === "trace"
          ? page.cursor
          : undefined;
    const stepRange = viewRange(counts.steps, page?.kind === "steps" ? page.cursor : undefined);
    const traceRange = viewRange(counts.trace, traceCursor);
    const entryRange = viewRange(
      counts.sessionEntries,
      page?.kind === "session_entries" ? page.cursor : undefined,
    );
    const eventRange = viewRange(
      counts.sessionEvents,
      page?.kind === "session_events" ? page.cursor : undefined,
    );
    const settingsRange = viewRange(
      counts.settings,
      page?.kind === "settings" ? page.cursor : undefined,
    );
    const followUpRange = viewRange(
      counts.followUps,
      page?.kind === "follow_ups" ? page.cursor : undefined,
    );
    const updateRange = viewRange(
      counts.updates,
      page?.kind === "updates" ? page.cursor : undefined,
    );
    const loaded = this.runs.readRunView(runId, {
      steps: stepRange,
      trace: traceRange,
      sessionEntries: entryRange,
      sessionEvents: eventRange,
      settings: settingsRange,
      followUps: followUpRange,
      updates: updateRange,
      graphCursor,
    });
    if (loaded === null) return null;
    const stepPage = byteBoundedCandidatePage(
      loaded.state.steps,
      stepRange.start,
      counts.steps,
      page?.kind === "steps" ? page.cursor : undefined,
      (step) => this.projectStep(runId, step),
    );
    const tracePage = byteBoundedCandidatePage(
      loaded.traceEvents,
      traceRange.start,
      counts.trace,
      traceCursor,
      (event) => this.projectTraceEvent(runId, event),
    );
    const entryPage = byteBoundedCandidatePage(
      loaded.sessionEntries,
      entryRange.start,
      counts.sessionEntries,
      page?.kind === "session_entries" ? page.cursor : undefined,
      (entry) => this.projectSessionEntry(runId, entry),
    );
    const eventPage = byteBoundedCandidatePage(
      loaded.sessionEvents,
      eventRange.start,
      counts.sessionEvents,
      page?.kind === "session_events" ? page.cursor : undefined,
      (event) => this.projectSessionEvent(runId, event),
    );
    const settingsPage = byteBoundedCandidatePage(
      loaded.settingsScopes,
      settingsRange.start,
      counts.settings,
      page?.kind === "settings" ? page.cursor : undefined,
      (scope) => this.projectRecordField(runId, scope, "settings"),
    );
    const followUps = loaded.followUpQueue?.followUps ?? [];
    const followUpPage = byteBoundedCandidatePage(
      followUps,
      followUpRange.start,
      counts.followUps,
      page?.kind === "follow_ups" ? page.cursor : undefined,
      (followUp) => this.projectRecordField(runId, followUp, "prompt"),
    );
    const updates = loaded.state.updates ?? [];
    const updatePage = byteBoundedCandidatePage(
      updates,
      updateRange.start,
      counts.updates,
      page?.kind === "updates" ? page.cursor : undefined,
      (update) => this.projectUpdate(runId, update),
    );
    const followUpQueue =
      loaded.followUpQueue === null
        ? null
        : projectFollowUpQueue(loaded.followUpQueue, followUpPage.items);
    const completeGraphSteps = loaded.graphSteps.map((step) => toCompactStepJson(step));
    const completeTakenTransitions = loaded.takenTransitions.map((transition) =>
      toJson(transition),
    );
    const graphSteps = byteBoundedForwardPage(completeGraphSteps, (step) => step);
    const takenTransitions = byteBoundedForwardPage(
      completeTakenTransitions,
      (transition) => transition,
    ).filter((transition): transition is string => typeof transition === "string");
    const graphHistory = this.projectValue(runId, {
      steps: completeGraphSteps,
      transitions: completeTakenTransitions,
    });
    const revision = this.presentationRevision(runId);
    const display = this.projectDisplay(runId, this.display(queue, loaded.state));
    return {
      schema: RUN_VIEW_SCHEMA,
      runId,
      revision,
      display,
      manifest: manifest(queue, display.status),
      state: this.projectState(runId, loaded.state, stepPage.items, updatePage.items),
      workflow: this.projectWorkflow(runId, loaded.snapshot),
      queue: projectQueue(queue),
      updates: updatePage.items,
      graphSteps,
      graphStepStart: 0,
      graphStepTotal: loaded.graphSteps.length,
      takenTransitions,
      graphHistory,
      takenTransitionStart: 0,
      takenTransitionTotal: loaded.takenTransitions.length,
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
        replayCheckpoint: this.projectReplayCheckpoint(
          runId,
          this.runs.readSessionReplayCheckpoint(runId, eventPage.start),
        ),
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

  session(
    sessionId: string,
    coordinator: { epoch: string; active: boolean; branchReportRequired: boolean } | null = null,
  ): WorkflowSessionView {
    return this.state.readTransaction(() => {
      const activeQueue = this.queue.findSessionReservationView(sessionId);
      const retainedRunId =
        activeQueue === undefined ? this.retainedTerminalRunId(sessionId) : undefined;
      const runId = activeQueue?.runId ?? retainedRunId;
      const pending = this.hostState.listPendingInteractions(sessionId);
      const pendingInteractions = byteBoundedForwardPage(pending, (request) =>
        this.projectRecordField(request.runId, request, "contract"),
      );
      const workflowMessages = this.workflowMessages.listSession(sessionId);
      const eligible = workflowMessages.find((message) => this.isMessageEligible(message));
      const next =
        coordinator === null || (coordinator.active && !coordinator.branchReportRequired)
          ? eligible
          : undefined;
      const open = this.openWorkflowMessage(workflowMessages);
      const openTurn = open === undefined ? undefined : this.workflowMessages.openTurnForMessage(open.workflowMessageId);
      return {
        schema: SESSION_VIEW_SCHEMA,
        sessionId,
        run: runId === undefined ? null : this.run(runId),
        pendingInteractions,
        pendingInteractionStart: 0,
        pendingInteractionTotal: pending.length,
        workflowMessages,
        workflowMessageStart: 0,
        workflowMessageTotal: workflowMessages.length,
        workflowMessageWindowComplete: true,
        nextWorkflowMessageId: next?.workflowMessageId ?? null,
        openWorkflowMessageId: open?.workflowMessageId ?? null,
        openWorkflowTurn: openTurn ?? null,
        coordinatorEpoch: coordinator?.epoch ?? null,
        coordinatorActive: coordinator?.active ?? false,
        branchReportRequired: coordinator?.branchReportRequired ?? false,
      };
    });
  }

  clearTerminal(sessionId: string, runId?: string, now: number = Date.now()): string | null {
    return this.state.transaction(() => {
      const retained = this.retainedTerminalRunId(sessionId, now);
      if (retained === undefined) return null;
      if (runId !== undefined && retained !== runId) {
        throw new Error(`Retained terminal workflow does not match run ${runId}`);
      }
      this.state.connection
        .prepare(
          `INSERT INTO session_terminal_views(target_session_id, cleared_run_id, cleared_at)
           VALUES (?, ?, ?)
           ON CONFLICT(target_session_id) DO UPDATE SET
             cleared_run_id = excluded.cleared_run_id, cleared_at = excluded.cleared_at`,
        )
        .run(sessionId, retained, now);
      this.sessionCache.delete(sessionId);
      return retained;
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

  private projectReplayCheckpoint(runId: string, value: JsonValue | null): JsonValue {
    return value === null ? null : this.projectValue(runId, value);
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
    const original = toJson(value);
    const workflow = escapeArtifactSentinels(original);
    if (Buffer.byteLength(canonicalJson(workflow)) <= VIEW_PAGE_BYTES * 2) return workflow;
    if (
      !isJsonObject(workflow) ||
      !isJsonObject(workflow.nodes) ||
      typeof workflow.schema !== "string" ||
      typeof workflow.name !== "string" ||
      typeof workflow.startAt !== "string" ||
      !Array.isArray(workflow.edges)
    ) {
      return this.registerContent(runId, original, "application/json");
    }
    const nodeEntries = Object.entries(workflow.nodes);
    const boundedNodeEntries = byteBoundedForwardPage(nodeEntries, ([nodeId, node]) => [
      nodeId,
      this.projectWorkflowNode(runId, node),
    ]);
    const nodes = Object.fromEntries(
      boundedNodeEntries.flatMap((entry) =>
        Array.isArray(entry) && typeof entry[0] === "string" && entry[1] !== undefined
          ? [[entry[0], entry[1]]]
          : [],
      ),
    );
    const edges = byteBoundedForwardPage(workflow.edges, (edge) => this.projectValue(runId, edge));
    return {
      schema: workflow.schema,
      name: workflow.name,
      startAt: workflow.startAt,
      nodes,
      nodeStart: 0,
      nodeTotal: nodeEntries.length,
      edges,
      edgeStart: 0,
      edgeTotal: workflow.edges.length,
      content: this.registerContent(runId, original, "application/json"),
    };
  }

  private projectWorkflowNode(runId: string, value: JsonValue): JsonValue {
    if (!isJsonObject(value)) return this.projectValue(runId, value);
    const projected: Record<string, JsonValue> = {};
    for (const field of [
      "nodeType",
      "timeoutMs",
      "statusDetail",
      "actionExecution",
      "settingsRoute",
      "effect",
      "mountPath",
      "localNodeId",
      "includeTransition",
    ]) {
      const fieldValue = value[field];
      if (fieldValue !== undefined) projected[field] = this.projectValue(runId, fieldValue);
    }
    return projected;
  }

  private projectDisplay(runId: string, display: WorkflowDisplay): WorkflowDisplay {
    if (
      display.reason === null ||
      Buffer.byteLength(display.reason, "utf8") <= INLINE_CONTENT_BYTES
    ) {
      return display;
    }
    return {
      ...display,
      reason: "Complete workflow failure details are available.",
      reasonContent: this.registerContent(runId, display.reason, "text/plain"),
    };
  }

  private projectValue(runId: string, value: JsonValue): JsonValue {
    const safeValue = escapeArtifactSentinels(value);
    const mediaType = typeof value === "string" ? "text/plain" : "application/json";
    const bytes =
      mediaType === "text/plain"
        ? Buffer.from(value as string, "utf8")
        : Buffer.from(canonicalJson(value), "utf8");
    return bytes.byteLength <= INLINE_CONTENT_BYTES
      ? safeValue
      : this.registerContent(runId, value, mediaType);
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
    const persistedDigest = this.runs.persistViewContent(runId, bytes, mediaType);
    if (persistedDigest !== sha256) throw new Error("Workflow view content digest changed");
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
        opaque: true,
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
    const mediaType = match[2] === "txt" ? "text/plain" : "application/json";
    const blob = this.runs.readContentBlob(runId, match[1] as string, mediaType);
    if (blob === undefined) return undefined;
    return this.rememberContent({
      runId,
      path: contentPath,
      mediaType,
      bytes: blob.content,
      sha256: match[1] as string,
    });
  }

  clearConnection(_connectionId: string): void {
    // Coordinator fencing is process-local in the host. Durable turn state is
    // reconciled from the Pi branch after the next coordinator connects.
  }

  private retainedTerminalRunId(sessionId: string, now: number = Date.now()): string | undefined {
    const messages = this.workflowMessages
      .listSession(sessionId)
      .filter((message) => message.kind === "terminal")
      .reverse();
    for (const message of messages) {
      const run = this.state.connection
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(message.runId);
      if (!isObjectRecord(run) || !isTerminalStatus(run.status)) continue;
      const clear = this.state.connection
        .prepare(
          `SELECT cleared_run_id AS clearedRunId, cleared_at AS clearedAt
           FROM session_terminal_views WHERE target_session_id = ?`,
        )
        .get(sessionId);
      if (
        isObjectRecord(clear) &&
        clear.clearedRunId === message.runId &&
        typeof clear.clearedAt === "number" &&
        clear.clearedAt >= Date.parse(message.createdAt)
      ) {
        continue;
      }
      if (message.status === "pending") return message.runId;
      if (message.status !== "sent") continue;
      const turn = this.workflowMessages.latestTurnForMessage(message.workflowMessageId);
      if (turn === undefined || turn.state === "started") return message.runId;
      if (turn.endedAt !== null && Date.parse(turn.endedAt) + TERMINAL_VIEW_RETENTION_MS > now) {
        return message.runId;
      }
    }
    return undefined;
  }

  private isMessageEligible(message: WorkflowMessage): boolean {
    if (message.status !== "pending") return false;
    if (message.kind === "step" || message.kind === "decision") {
      const request = this.state.connection
        .prepare(
          `SELECT i.status, r.paused FROM interactive_requests i
           JOIN runs r ON r.run_id = i.run_id
           WHERE i.request_id = ? AND i.run_id = ?`,
        )
        .get(message.sourceId, message.runId);
      if (!isObjectRecord(request) || request.status !== "pending") return false;
      return message.kind === "decision" || request.paused === 0;
    }
    if (message.kind === "notification") return true;
    if (message.kind === "terminal") {
      const run = this.state.connection
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(message.runId);
      return isObjectRecord(run) && isTerminalStatus(run.status);
    }
    const source = this.state.connection
      .prepare(
        `SELECT f.run_id AS runId, f.order_number AS orderNumber, f.status
         FROM workflow_follow_ups f WHERE f.follow_up_id = ?`,
      )
      .get(message.sourceId);
    if (
      !isObjectRecord(source) ||
      source.status !== "queued" ||
      typeof source.orderNumber !== "number" ||
      typeof source.runId !== "string"
    ) {
      return false;
    }
    const leaf = this.terminalChainLeaf(source.runId);
    if (leaf === undefined || leaf.status !== "completed") return false;
    const terminal = this.workflowMessages
      .listRun(leaf.runId)
      .filter((candidate) => candidate.kind === "terminal" && candidate.status === "sent")
      .at(-1);
    if (terminal === undefined) return false;
    const terminalTurn = this.workflowMessages.latestTurnForMessage(terminal.workflowMessageId);
    if (terminalTurn?.state !== "ended") return false;
    const prior = this.state.connection
      .prepare(
        `SELECT follow_up_id AS followUpId, status FROM workflow_follow_ups
         WHERE run_id = ? AND order_number < ? ORDER BY order_number`,
      )
      .all(source.runId, source.orderNumber);
    for (const item of prior) {
      if (
        !isObjectRecord(item) ||
        typeof item.followUpId !== "string" ||
        typeof item.status !== "string"
      ) {
        return false;
      }
      if (item.status === "removed" || item.status === "cancelled") continue;
      const priorMessage = this.workflowMessages.latestForSource("followUp", item.followUpId);
      if (
        priorMessage === undefined ||
        this.workflowMessages.latestTurnForMessage(priorMessage.workflowMessageId)?.state !== "ended"
      ) {
        return false;
      }
    }
    const reservation = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM run_bindings b JOIN runs r ON r.run_id = b.run_id
         WHERE b.origin_session_id = ? AND r.run_id <> ?
           AND r.status IN ('queued', 'running', 'waiting') LIMIT 1`,
      )
      .get(message.targetSessionId, message.runId);
    return reservation === undefined;
  }

  private terminalChainLeaf(runId: string): { runId: string; status: string } | undefined {
    const row = this.state.connection
      .prepare(
        `WITH RECURSIVE chain(run_id, status, depth, created_at) AS (
           SELECT run_id, status, 0, created_at FROM runs WHERE run_id = ?
           UNION ALL
           SELECT child.run_id, child.status, chain.depth + 1, child.created_at
           FROM runs child JOIN chain ON child.parent_run_id = chain.run_id
         )
         SELECT run_id AS runId, status FROM chain
         ORDER BY depth DESC, created_at DESC LIMIT 1`,
      )
      .get(runId);
    return isObjectRecord(row) && typeof row.runId === "string" && typeof row.status === "string"
      ? { runId: row.runId, status: row.status }
      : undefined;
  }

  private openWorkflowMessage(messages: readonly WorkflowMessage[]): WorkflowMessage | undefined {
    for (const message of [...messages].reverse()) {
      if (message.status !== "sent") continue;
      if (message.kind === "step") {
        const request = this.state.connection
          .prepare(
            `SELECT i.status, r.paused FROM interactive_requests i
             JOIN runs r ON r.run_id = i.run_id WHERE i.request_id = ?`,
          )
          .get(message.sourceId);
        if (isObjectRecord(request) && request.status === "pending" && request.paused === 0) {
          return message;
        }
      } else if (message.kind === "terminal" || message.kind === "followUp") {
        const turn = this.workflowMessages.latestTurnForMessage(message.workflowMessageId);
        if (turn === undefined || turn.state === "started") return message;
      }
    }
    return undefined;
  }

  private workflowActivityRevision(): string {
    const row = this.state.connection
      .prepare(
        `SELECT
           COALESCE((SELECT max(updated_at) FROM workflow_messages), 0) AS messageUpdatedAt,
           COALESCE((SELECT max(COALESCE(ended_at, started_at)) FROM workflow_turns), 0) AS turnUpdatedAt`,
      )
      .get();
    return isObjectRecord(row) &&
      typeof row.messageUpdatedAt === "number" &&
      typeof row.turnUpdatedAt === "number"
      ? `${row.messageUpdatedAt}:${row.turnUpdatedAt}`
      : "0:0";
  }

  private display(
    queue: WorkflowRunQueueRecord | WorkflowRunQueueViewRecord,
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
    const row = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM workflow_turns t
         JOIN workflow_messages m ON m.workflow_message_id = t.workflow_message_id
         WHERE t.run_id = ? AND t.state = 'started' AND m.kind IN ('step', 'terminal') LIMIT 1`,
      )
      .get(runId);
    return row !== undefined;
  }

  private hasPendingInteraction(runId: string): boolean {
    const row = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM interactive_requests
         WHERE run_id = ? AND status = 'pending' LIMIT 1`,
      )
      .get(runId);
    return row !== undefined;
  }

  private hasAmbiguousEffect(runId: string): boolean {
    const row = this.state.connection
      .prepare(
        `SELECT 1 AS present FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
         WHERE r.run_id = ? AND e.status = 'ambiguous' LIMIT 1`,
      )
      .get(runId);
    return row !== undefined;
  }

  private runVersion(runId: string): string {
    const row = this.state.connection
      .prepare(
        `SELECT res.revision, r.status AS runStatus, r.paused,
                q.updated_at AS updatedAt,
                COALESCE(v.presentation_revision, 0) AS presentationRevision
         FROM runs r JOIN resources res ON res.resource_id = r.resource_id
         JOIN run_queue q ON q.run_id = r.run_id
         LEFT JOIN viewer_runs v ON v.run_id = r.run_id
         WHERE r.run_id = ?`,
      )
      .get(runId);
    if (!isRunVersionRow(row)) return "missing";
    return [
      row.revision,
      row.updatedAt,
      row.presentationRevision,
      row.runStatus,
      row.paused,
      this.workflowActivityRevision(),
      this.hasLiveWorker(runId),
      this.hasActivity(runId),
      this.hasPendingInteraction(runId),
      this.hasAmbiguousEffect(runId),
    ].join(":");
  }

  private pendingSessionRevision(sessionId: string): string {
    const row = this.state.connection
      .prepare(
        `SELECT count(*) AS count, COALESCE(sum(revision), 0) AS revisionSum,
                COALESCE(max(updated_at), 0) AS updatedAt
         FROM interactive_requests
         WHERE target_session_id = ? AND status = 'pending'`,
      )
      .get(sessionId);
    if (!isSessionRevisionRow(row)) throw new Error("Session view revision is invalid");
    return `${row.count}:${row.revisionSum}:${row.updatedAt}`;
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
  } else if (facts.workerActive || facts.originTurnActive) {
    status = "running";
    activity = facts.workerActive ? "supervised_worker" : "origin_turn";
  } else if (
    facts.durableStatus === "completed" ||
    facts.durableStatus === "failed" ||
    facts.durableStatus === "timed_out" ||
    facts.durableStatus === "cancelled"
  ) {
    status = facts.durableStatus;
    reason = facts.errorMessage;
  } else if (facts.paused) {
    status = "paused";
    reason = "The workflow is durably paused.";
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
    reason = facts.errorMessage;
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

function manifest(
  run: WorkflowRunQueueRecord | WorkflowRunQueueViewRecord,
  status: WorkflowDisplayStatus,
): JsonValue {
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

function projectQueue(
  run: WorkflowRunQueueRecord | WorkflowRunQueueViewRecord,
): WorkflowRunQueueView {
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
    rootRunId: run.rootRunId,
    lineageKind: run.lineageKind,
    restartNumber: run.restartNumber,
    parentTerminalFingerprint: run.parentTerminalFingerprint,
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalStatus(value: unknown): value is "completed" | "failed" | "timed_out" | "cancelled" {
  return value === "completed" || value === "failed" || value === "timed_out" || value === "cancelled";
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

function refreshCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

function rememberCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
  refreshCacheEntry(cache, key, value);
  while (cache.size > VIEW_CACHE_ITEMS) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function viewRange(total: number, cursor?: number): { start: number; limit: number } {
  const start = workflowPageStart(total, cursor);
  return { start, limit: Math.min(VIEW_PAGE_ITEMS, Math.max(0, total - start)) };
}

function byteBoundedForwardPage<T>(
  values: readonly T[],
  project: (value: T) => JsonValue,
): JsonValue[] {
  const items: JsonValue[] = [];
  let bytes = 0;
  for (const value of values) {
    if (items.length >= VIEW_PAGE_ITEMS) break;
    const item = project(value);
    const itemBytes = Buffer.byteLength(canonicalJson(item)) + (items.length === 0 ? 0 : 1);
    if (items.length > 0 && bytes + itemBytes > VIEW_PAGE_BYTES) break;
    items.push(item);
    bytes += itemBytes;
  }
  return items;
}

function byteBoundedCandidatePage<T>(
  values: readonly T[],
  candidateStart: number,
  total: number,
  requestedCursor: number | undefined,
  project: (value: T) => JsonValue,
): { start: number; total: number; items: JsonValue[] } {
  if (values.length === 0) return { start: candidateStart, total, items: [] };
  const globalCursor = clampCursor(requestedCursor ?? Math.max(0, total - 1), total);
  const localCursor = Math.min(Math.max(0, globalCursor - candidateStart), values.length - 1);
  const page = byteBoundedPage(values, localCursor, project);
  return { start: candidateStart + page.start, total, items: page.items };
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

function toJson(value: unknown): JsonValue {
  return parseJson(canonicalJson(value));
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunVersionRow(value: unknown): value is {
  revision: number;
  updatedAt: number;
  presentationRevision: number;
  runStatus: string;
  paused: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === "number" &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "number" &&
    typeof (value as { presentationRevision?: unknown }).presentationRevision === "number" &&
    typeof (value as { runStatus?: unknown }).runStatus === "string" &&
    typeof (value as { paused?: unknown }).paused === "number"
  );
}

function isSessionRevisionRow(value: unknown): value is {
  count: number;
  revisionSum: number;
  updatedAt: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { count?: unknown }).count === "number" &&
    typeof (value as { revisionSum?: unknown }).revisionSum === "number" &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "number"
  );
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}
