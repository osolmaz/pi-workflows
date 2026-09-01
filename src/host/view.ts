import { ORIGIN_ACTIVITY_LEASE_MS } from "../client/activity.js";
import {
  RUN_VIEW_SCHEMA,
  SESSION_VIEW_SCHEMA,
  type OriginActivityReport,
  type WorkflowDisplay,
  type WorkflowDisplayStatus,
  type WorkflowRunSummary,
  type WorkflowRunView,
  type WorkflowSessionView,
} from "../client/view.js";
import type { SqliteControllerStore, WorkflowRunQueueRecord } from "../controllers/sqlite.js";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import type { WorkflowRunStore } from "../workflows/store.js";
import type { WorkflowRunState, WorkflowStepRecord } from "../workflows/types.js";
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

export class HostViewStore {
  private readonly activity = new Map<string, OriginActivity>();

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
        const loaded = this.runs.readRun(run.runId);
        const display = this.display(run, loaded?.state);
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
    const stepStart = workflowPageStart(
      steps.length,
      page?.kind === "steps" ? page.cursor : undefined,
    );
    const traceCursor =
      page?.kind === "trace_at_step"
        ? traceCursorForStep(trace, steps, page.cursor)
        : page?.kind === "trace"
          ? page.cursor
          : undefined;
    const traceStart = workflowPageStart(trace.length, traceCursor);
    const entriesStart = workflowPageStart(
      loaded.sessionEntries.length,
      page?.kind === "session_entries" ? page.cursor : undefined,
    );
    const eventsStart = workflowPageStart(
      loaded.sessionEvents.length,
      page?.kind === "session_events" ? page.cursor : undefined,
    );
    const settingsStart = workflowPageStart(
      settings.length,
      page?.kind === "settings" ? page.cursor : undefined,
    );
    const followUpStart = workflowPageStart(
      followUps.length,
      page?.kind === "follow_ups" ? page.cursor : undefined,
    );
    const updateStart = workflowPageStart(
      updates.length,
      page?.kind === "updates" ? page.cursor : undefined,
    );
    const graphCursor =
      page?.kind === "steps"
        ? clampCursor(page.cursor, steps.length)
        : Math.max(0, steps.length - 1);
    const stepPage = steps.slice(stepStart, stepStart + 256).map(toJson);
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
    const updatePage = updates.slice(updateStart, updateStart + 256).map(toJson);
    const followUpQueue =
      loaded.followUpQueue === null || loaded.followUpQueue === undefined
        ? null
        : {
            ...loaded.followUpQueue,
            followUps: followUps.slice(followUpStart, followUpStart + 256),
          };
    const state = toJson(loaded.state);
    if (isJsonObject(state)) {
      state.steps = stepPage;
      state.updates = updatePage;
    }
    return {
      schema: RUN_VIEW_SCHEMA,
      runId,
      revision,
      display,
      manifest: manifest(queue, display.status),
      state,
      snapshot: toJson(loaded.snapshot),
      workflow: toJson(loaded.snapshot),
      queue: toJson(queue),
      updates: updatePage,
      graphSteps,
      takenTransitions,
      graphCursor,
      stepStart,
      stepTotal: steps.length,
      tracePage: {
        start: traceStart,
        total: trace.length,
        items: trace.slice(traceStart, traceStart + 256).map(toJson),
      },
      session: {
        binding: toJson(loaded.sessionBinding),
        entryPage: {
          start: entriesStart,
          total: loaded.sessionEntries.length,
          items: loaded.sessionEntries.slice(entriesStart, entriesStart + 256).map(toJson),
        },
        eventPage: {
          start: eventsStart,
          total: loaded.sessionEvents.length,
          items: loaded.sessionEvents.slice(eventsStart, eventsStart + 256).map(toJson),
        },
        capture: toJson(loaded.sessionCapture),
        integrity: toJson(loaded.sessionIntegrity),
      },
      settingsScopes: settings.slice(settingsStart, settingsStart + 256).map(toJson),
      settingsStart,
      settingsTotal: settings.length,
      followUpQueue: toJson(followUpQueue),
      followUpStart,
      followUpTotal: followUps.length,
      updateStart,
      updateTotal: updates.length,
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
        pendingInteractions: pending.map(toJson),
      };
    });
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

  private display(queue: WorkflowRunQueueRecord, state?: WorkflowRunState): WorkflowDisplay {
    return reduceWorkflowDisplay({
      queueStatus: queue.status,
      durableStatus: state?.status,
      paused: state?.paused === true,
      ambiguous: this.hasAmbiguousEffect(queue.runId),
      workerActive: this.hasLiveWorker(queue.runId),
      originTurnActive: this.hasActivity(queue.runId),
      pendingInteraction: this.hasPendingInteraction(queue.runId),
      errorMessage: queue.errorMessage,
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

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
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
