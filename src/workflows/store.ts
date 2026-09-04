import { createHash, randomUUID } from "node:crypto";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  StateMutationStore,
  StaleResourceError,
  resourceIdFor,
  tokenHash,
  type ActorType,
  type MutationActor,
  type OwnerType,
} from "../state/mutation.js";
import {
  initializeViewerRun,
  recordViewerDeltas,
  viewerTailPatch,
  VIEWER_PAGE_SIZE,
  type ViewerDeltaDraft,
} from "../state/viewer.js";
import { WorkflowMessageStore, workflowMessageIdFor } from "../state/workflow-messages.js";
import { compositionMetadata } from "./composition.js";
import { ClaimLostError } from "./errors.js";
import { HumanDecisionStore } from "./human-decision.js";
import { applyJsonPatch, validateJsonPatch } from "./json-patch.js";
import {
  reduceSessionEvents,
  reduceSessionEventsFromCheckpoint,
  type TemporalSessionState,
} from "./session-reducer.js";
import {
  applyWorkflowSettingsPatch,
  workflowSettingsScopeId,
  type InitialWorkflowSettingsScope,
  type WorkflowFollowUpQueueRecord,
  type WorkflowFollowUpRecord,
  type WorkflowFollowUpState,
  type WorkflowQueueFollowUpRequest,
  type WorkflowRemoveFollowUpRequest,
  type WorkflowSettingsChangeRecord,
  type WorkflowSettingsChangeRequest,
  type WorkflowSettingsChangeResult,
  type WorkflowSettingsDefinition,
  type WorkflowSettingsScopeRecord,
} from "./settings.js";
import type {
  WorkflowDefinition,
  WorkflowDefinitionSnapshot,
  WorkflowEffectRecovery,
  WorkflowEffectReservation,
  HumanDecisionReceipt,
  HumanDecisionRequest,
  ResolvedHumanDecision,
  WorkflowNodeDefinition,
  WorkflowNodeResult,
  WorkflowNodeSnapshot,
  WorkflowRunState,
  WorkflowSource,
  WorkflowMountedSource,
  WorkflowStepRecord,
  WorkflowSessionBinding,
  WorkflowSessionCapture,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
  WorkflowSessionEventType,
  WorkflowSettingsSnapshot,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "./types.js";
import { MAX_CURRENT_UPDATES, createUpdateId, updateProjection } from "./updates.js";
import { followUpWorkflowMessageContent } from "./workflow-message-content.js";

export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;
export const SESSION_EVENT_SCHEMA = "pi-workflows.session-event.v1" as const;
export const SESSION_CAPTURE_SCHEMA = "pi-workflows.session-capture.v1" as const;
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;

const STEP_ROW_SELECT = `
  SELECT s.step_index AS stepIndex, a.attempt_id AS attemptId, a.node_id AS nodeId,
         a.node_type AS nodeType, a.status,
         a.prompt_hash AS promptHash, a.output_hash AS outputHash,
         s.output_override_hash AS outputOverrideHash,
         a.receipt_hash AS receiptHash, a.error_hash AS errorHash,
         prompt_entry.entry_hash AS promptEntryHash,
         response_entry.entry_hash AS responseEntryHash,
         first_link.entry_id AS firstEntryId, last_link.entry_id AS lastEntryId,
         a.settings_scope_id AS settingsScopeId,
         a.settings_change_number AS settingsChangeNumber,
         a.settings_hash AS settingsHash,
         a.started_at AS startedAt, a.finished_at AS finishedAt
  FROM run_steps s
  JOIN node_attempts a ON a.attempt_id = s.attempt_id
  LEFT JOIN attempt_entries prompt_link
    ON prompt_link.attempt_id = a.attempt_id AND prompt_link.role = 'prompt'
  LEFT JOIN session_entries prompt_entry
    ON prompt_entry.segment_id = prompt_link.segment_id
   AND prompt_entry.entry_id = prompt_link.entry_id
  LEFT JOIN attempt_entries response_link
    ON response_link.attempt_id = a.attempt_id AND response_link.role = 'response'
  LEFT JOIN session_entries response_entry
    ON response_entry.segment_id = response_link.segment_id
   AND response_entry.entry_id = response_link.entry_id
  LEFT JOIN attempt_entries first_link
    ON first_link.attempt_id = a.attempt_id AND first_link.role = 'first'
  LEFT JOIN attempt_entries last_link
    ON last_link.attempt_id = a.attempt_id AND last_link.role = 'last'`;

const FOLLOW_UP_ROW_SELECT = `
  SELECT f.follow_up_id AS followUpId, f.resource_id AS resourceId,
         f.run_id AS runId, f.request_id AS requestId, f.order_number AS orderNumber,
         f.target_session_id AS targetSessionId, f.actor_type AS actorType,
         f.actor_id AS actorId, f.source_type AS sourceType,
         f.prompt_hash AS promptHash, f.status, f.reason_hash AS reasonHash,
         f.created_at AS createdAt, f.updated_at AS updatedAt, r.revision
  FROM workflow_follow_ups f
  JOIN resources r ON r.resource_id = f.resource_id`;

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
  /** Duration used when a protected write renews this exact live claim. */
  leaseMs?: number;
};

export type WorkflowRunDisplayState = {
  status: WorkflowRunState["status"];
  paused: boolean;
  error: string | null;
};

export type WorkflowRunTerminalData = {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  statusDetail: string | null;
  input: JsonValue;
  finalOutput: JsonValue | null;
  error: string | null;
  presentationInstructions: string;
  restartNumber: number;
};

export type WorkflowRunStoreOptions = {
  authorityProvider?: (runId: string) => RunWriteAuthority | undefined;
  /** Server-owned projection updates that must commit with each run snapshot. */
  snapshotLifecycle?: (context: {
    runId: string;
    state: WorkflowRunState;
    event: WorkflowTraceEvent;
    database: StateDatabase;
    now: number;
  }) => void;
  /** The global server may record an attested Pi session after the runner lease ends. */
  allowServerSessionRecording?: boolean;
  state?: StateDatabase;
  readOnly?: boolean;
};

/** The state boundary used by workflow code, including out-of-process runners. */
export interface WorkflowExecutionStore {
  readonly databasePath: string;
  initializeRun(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    options?: InitializeWorkflowRunOptions,
  ): Promise<string>;
  prepareRunResume(runId: string): Promise<WorkflowRunState>;
  readRunState(runId: string): WorkflowRunState | null | Promise<WorkflowRunState | null>;
  writeSnapshot(
    runId: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent>;
  publishUpdate(
    runId: string,
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }>;
  findSettingsScope(
    runId: string,
    mountPath: string,
    invocation: number,
  ): WorkflowSettingsScopeRecord | undefined | Promise<WorkflowSettingsScopeRecord | undefined>;
  ensureSettingsScope(options: {
    runId: string;
    mountPath: string;
    invocation: number;
    settings: JsonValue;
  }): WorkflowSettingsScopeRecord | Promise<WorkflowSettingsScopeRecord>;
  getSettingsScopeAtChange(
    scopeId: string,
    changeNumber: number,
  ): WorkflowSettingsScopeRecord | undefined | Promise<WorkflowSettingsScopeRecord | undefined>;
  createHumanDecisionRequest(request: HumanDecisionRequest): Promise<"created" | "adopted">;
  readResolvedHumanDecision(decisionId: string): Promise<ResolvedHumanDecision | null>;
  reserveEffect(options: {
    runId: string;
    attemptId: string;
    effectType: string;
    idempotencyKey: string;
    request: JsonValue;
    recovery: WorkflowEffectRecovery;
  }): Promise<WorkflowEffectReservation>;
  settleEffect(options: {
    runId: string;
    effectId: string;
    attemptNumber: number;
    outcome: "applied" | "rejected" | "ambiguous" | "cancelled";
    result?: JsonValue;
    error?: string;
  }): Promise<void>;
}

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
  parentRunId: string | null;
  title: string | null;
  status: string;
  paused: number;
  statusDetail: string | null;
  inputHash: Buffer;
  finalOutputHash: Buffer | null;
  errorHash: Buffer | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

type RunSourceRow = {
  mountPath: string;
  sourceType: "builtin" | "file";
  sourceRef: string;
  sourceRevision: string;
};

type StoredAttemptReceipt = Pick<WorkflowStepRecord, "action" | "assistantMessage">;

type StepRow = {
  stepIndex: number;
  attemptId: string;
  nodeId: string;
  nodeType: WorkflowStepRecord["nodeType"];
  status: string;
  promptHash: Buffer | null;
  outputHash: Buffer | null;
  outputOverrideHash: Buffer | null;
  receiptHash: Buffer | null;
  promptEntryHash: Buffer | null;
  responseEntryHash: Buffer | null;
  firstEntryId: string | null;
  lastEntryId: string | null;
  errorHash: Buffer | null;
  settingsScopeId: string | null;
  settingsChangeNumber: number | null;
  settingsHash: Buffer | null;
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

type ViewerSessionCheckpointRow = {
  eventSeq: number;
  stateHash: Buffer;
};

type ViewerSessionEventRow = {
  runSeq: number;
  eventType: string;
  nodeId: string;
  attemptId: string;
  turnId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  payloadHash: Buffer;
  recordedAt: number;
};

type SettingsScopeRow = {
  scopeId: string;
  resourceId: string;
  originRunId: string;
  activeRunId: string;
  mountPath: string;
  invocation: number;
  currentHash: Buffer;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type SettingsProjectionRow = {
  scopeId: string;
  initialHash: Buffer;
  currentHash: Buffer;
  revision: number;
};

type SettingsProjectionChangeRow = {
  changeNumber: number;
  patchHash: Buffer;
  beforeHash: Buffer;
  afterHash: Buffer;
};

type SettingsChangeRow = {
  changeId: string;
  scopeId: string;
  requestId: string;
  changeNumber: number;
  actorType: string;
  actorId: string | null;
  sourceType: string;
  patchHash: Buffer;
  beforeHash: Buffer;
  afterHash: Buffer;
  acceptedAt: number;
};

type FollowUpRow = {
  followUpId: string;
  resourceId: string;
  runId: string;
  requestId: string;
  orderNumber: number;
  targetSessionId: string;
  actorType: string;
  actorId: string | null;
  sourceType: string;
  promptHash: Buffer;
  status: string;
  reasonHash: Buffer | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
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
  settingsScopes?: WorkflowSettingsScopeRecord[];
  followUpQueue?: WorkflowFollowUpQueueRecord | null;
};

export type WorkflowRunViewCounts = {
  steps: number;
  trace: number;
  sessionEntries: number;
  sessionEvents: number;
  settings: number;
  followUps: number;
  updates: number;
};

export type WorkflowRunViewRange = {
  start: number;
  limit: number;
};

export type WorkflowRunViewRead = {
  runId: string;
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot;
  traceEvents: WorkflowTraceEvent[];
  sessionBinding: WorkflowSessionBinding | null;
  sessionEntries: WorkflowSessionEntryRecord[];
  sessionEvents: WorkflowSessionEventRecord[];
  sessionCapture: WorkflowSessionCapture | null;
  sessionIntegrity: SessionCaptureIntegrity;
  settingsScopes: WorkflowSettingsScopeRecord[];
  followUpQueue: WorkflowFollowUpQueueRecord | null;
  graphSteps: WorkflowStepRecord[];
  takenTransitions: string[];
};

export type WorkflowRunViewReadOptions = {
  steps: WorkflowRunViewRange;
  trace: WorkflowRunViewRange;
  sessionEntries: WorkflowRunViewRange;
  sessionEvents: WorkflowRunViewRange;
  settings: WorkflowRunViewRange;
  followUps: WorkflowRunViewRange;
  updates: WorkflowRunViewRange;
  graphCursor: number;
};

export type ReadWorkflowRunOptions = {
  includeTrace?: boolean;
};

export type InitializeWorkflowRunOptions = {
  initialSettings?: InitialWorkflowSettingsScope[];
};

export class WorkflowRunStore {
  readonly databasePath: string;
  readonly state: StateDatabase;
  private readonly authorityProvider:
    | ((runId: string) => RunWriteAuthority | undefined)
    | undefined;
  private readonly snapshotLifecycle: WorkflowRunStoreOptions["snapshotLifecycle"];
  private readonly allowServerSessionRecording: boolean;
  private readonly contexts = new Map<string, RunContext>();
  private readonly ownsState: boolean;
  private readonly mutations: StateMutationStore;
  private readonly workflowMessages: WorkflowMessageStore;

  constructor(databasePath: string = workflowStatePath(), options: WorkflowRunStoreOptions = {}) {
    this.authorityProvider = options.authorityProvider;
    this.snapshotLifecycle = options.snapshotLifecycle;
    this.allowServerSessionRecording = options.allowServerSessionRecording === true;
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath: databasePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
        checkLegacyState: databasePath === workflowStatePath(),
      });
    this.databasePath = this.state.filePath;
    this.mutations = new StateMutationStore(this.state);
    this.workflowMessages = new WorkflowMessageStore(this.state);
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  /** Server-only synchronization after a queue lifecycle mutation on the run resource. */
  synchronizeRevision(runId: string): number {
    const revision = this.resourceRevision(runId);
    const context = this.contexts.get(runId);
    if (context === undefined) {
      this.contexts.set(runId, { revision, lock: Promise.resolve() });
    } else {
      context.revision = revision;
    }
    return revision;
  }

  async createHumanDecisionRequest(request: HumanDecisionRequest): Promise<"created" | "adopted"> {
    return await new HumanDecisionStore(this.databasePath, { state: this.state }).createRequest(
      request,
    );
  }

  async readResolvedHumanDecision(decisionId: string): Promise<ResolvedHumanDecision | null> {
    return await new HumanDecisionStore(this.databasePath, { state: this.state }).readResolved(
      decisionId,
    );
  }

  async reserveEffect(options: {
    runId: string;
    attemptId: string;
    effectType: string;
    idempotencyKey: string;
    request: JsonValue;
    recovery: WorkflowEffectRecovery;
  }): Promise<WorkflowEffectReservation> {
    return await this.withRunLock(options.runId, async () =>
      this.state.transaction(() => {
        requireBoundedEffectText(options.effectType, "type");
        requireBoundedEffectText(options.idempotencyKey, "idempotency key");
        const context = this.contextFor(options.runId);
        const run = this.requireRunRow(options.runId);
        this.assertWriteAuthority(run, context.revision);
        const authority = this.authorityProvider?.(options.runId);
        const payloadHash = this.state.putJson(
          { recovery: options.recovery, request: options.request },
          Date.now(),
        );
        const effectId = workflowEffectId(
          run.resourceId,
          options.effectType,
          options.idempotencyKey,
        );
        const existing = this.state.connection
          .prepare(
            `SELECT status, payload_hash AS payloadHash, result_hash AS resultHash,
                    attempt_count AS attemptCount
             FROM effects WHERE effect_id = ?`,
          )
          .get(effectId);
        if (isWorkflowEffectRow(existing)) {
          if (!existing.payloadHash.equals(payloadHash)) {
            throw new Error("Managed effect key was reused with another request");
          }
          if (existing.status === "applied") {
            return {
              effectId,
              attemptNumber: existing.attemptCount,
              disposition: "adopted",
              ...(existing.resultHash === null
                ? {}
                : { result: this.state.readJson(existing.resultHash) }),
            };
          }
          if (existing.status !== "pending") {
            return {
              effectId,
              attemptNumber: existing.attemptCount,
              disposition: "ambiguous",
            };
          }
          return this.beginEffectAttempt(run, effectId, existing.attemptCount + 1, authority);
        }
        const now = Date.now();
        const effectResourceId = this.mutations.ensureResource("effect", effectId, now);
        this.mutations.mutate(
          {
            resourceId: effectResourceId,
            operation: "effect.reserve",
            actor: authority?.actor ?? { type: "system" },
            expectedRevision: 0,
          },
          "effect.reserved",
          () => {
            this.state.connection
              .prepare(
                `INSERT INTO effects(
                   effect_id, resource_id, source_resource_id, source_revision,
                   effect_type, idempotency_key, payload_hash, owner_scope, status,
                   attempt_count, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'run', 'applying', 1, ?, ?)`,
              )
              .run(
                effectId,
                effectResourceId,
                run.resourceId,
                context.revision,
                options.effectType,
                options.idempotencyKey,
                payloadHash,
                now,
                now,
              );
            this.insertEffectAttempt(effectId, 1, authority, now);
          },
          { now, payload: { runId: options.runId, attemptId: options.attemptId } },
        );
        return { effectId, attemptNumber: 1, disposition: "execute" };
      }),
    );
  }

  async settleEffect(options: {
    runId: string;
    effectId: string;
    attemptNumber: number;
    outcome: "applied" | "rejected" | "ambiguous" | "cancelled";
    result?: JsonValue;
    error?: string;
  }): Promise<void> {
    await this.withRunLock(options.runId, async () =>
      this.state.transaction(() => {
        const context = this.contextFor(options.runId);
        const run = this.requireRunRow(options.runId);
        this.assertWriteAuthority(run, context.revision);
        const row = this.state.connection
          .prepare(
            `SELECT e.resource_id AS resourceId, e.status
             FROM effects e WHERE e.effect_id = ? AND e.source_resource_id = ?`,
          )
          .get(options.effectId, run.resourceId);
        if (!isWorkflowEffectIdentityRow(row) || row.status !== "applying") {
          throw new Error("Managed effect is not applying");
        }
        const now = Date.now();
        const revision = this.requireResourceRevision(row.resourceId);
        const resultHash =
          options.result === undefined ? null : this.state.putJson(options.result, now);
        const errorHash =
          options.error === undefined ? null : this.state.putText(options.error, now);
        this.mutations.mutate(
          {
            resourceId: row.resourceId,
            operation: "effect.settle",
            actor: this.authorityProvider?.(options.runId)?.actor ?? { type: "system" },
            expectedRevision: revision,
          },
          `effect.${options.outcome}`,
          () => {
            const changed = this.state.connection
              .prepare(
                `UPDATE effects
                 SET status = ?, result_hash = ?, error_hash = ?, updated_at = ?, settled_at = ?
                 WHERE effect_id = ? AND status = 'applying' AND attempt_count = ?`,
              )
              .run(
                options.outcome,
                resultHash,
                errorHash,
                now,
                now,
                options.effectId,
                options.attemptNumber,
              );
            /* istanbul ignore if -- serialized effect mutation keeps this attempt current */
            if (changed.changes !== 1) throw new Error("Managed effect attempt changed");
            this.state.connection
              .prepare(
                `UPDATE effect_attempts
                 SET finished_at = ?, outcome = ?, result_hash = ?, error_hash = ?
                 WHERE effect_id = ? AND attempt_number = ? AND finished_at IS NULL`,
              )
              .run(
                now,
                options.outcome === "cancelled" ? "interrupted" : options.outcome,
                resultHash,
                errorHash,
                options.effectId,
                options.attemptNumber,
              );
          },
          { now, payload: { runId: options.runId, outcome: options.outcome } },
        );
      }),
    );
  }

  async recoverApplyingEffects(runId: string): Promise<"safe" | "ambiguous"> {
    return await this.withRunLock(runId, async () =>
      this.state.transaction(() => {
        const context = this.contextFor(runId);
        const run = this.requireRunRow(runId);
        this.assertWriteAuthority(run, context.revision);
        const authority = this.authorityProvider?.(runId);
        const rows = this.state.connection
          .prepare(
            `SELECT effect_id AS effectId, resource_id AS resourceId,
                    payload_hash AS payloadHash, attempt_count AS attemptCount
             FROM effects WHERE source_resource_id = ? AND status = 'applying'`,
          )
          .all(run.resourceId)
          .filter(isApplyingEffectRow);
        let ambiguous = false;
        for (const row of rows) {
          const payload = this.state.readJson(row.payloadHash);
          const recovery = effectRecoveryFromPayload(payload);
          const status = recovery === "idempotent" ? "pending" : "ambiguous";
          if (status === "ambiguous") ambiguous = true;
          const now = Date.now();
          const revision = this.requireResourceRevision(row.resourceId);
          this.mutations.mutate(
            {
              resourceId: row.resourceId,
              operation: "effect.recover",
              actor: authority?.actor ?? { type: "system" },
              expectedRevision: revision,
            },
            status === "pending" ? "effect.retry_ready" : "effect.ambiguous",
            () => {
              this.state.connection
                .prepare(
                  `UPDATE effects SET status = ?, updated_at = ?, settled_at = ?
                   WHERE effect_id = ? AND status = 'applying'`,
                )
                .run(status, now, status === "ambiguous" ? now : null, row.effectId);
              this.state.connection
                .prepare(
                  `UPDATE effect_attempts SET finished_at = ?, outcome = 'interrupted'
                   WHERE effect_id = ? AND attempt_number = ? AND finished_at IS NULL`,
                )
                .run(now, row.effectId, row.attemptCount);
            },
            { now, payload: { runId, recovery } },
          );
        }
        return ambiguous ? "ambiguous" : "safe";
      }),
    );
  }

  private beginEffectAttempt(
    run: RunRow,
    effectId: string,
    attemptNumber: number,
    authority: RunWriteAuthority | undefined,
  ): WorkflowEffectReservation {
    const now = Date.now();
    const row = this.state.connection
      .prepare("SELECT resource_id AS resourceId FROM effects WHERE effect_id = ?")
      .get(effectId);
    /* istanbul ignore if -- beginEffectAttempt is called only for a persisted effect */
    if (!isResourceIdRow(row)) throw new Error("Managed effect resource is missing");
    const revision = this.requireResourceRevision(row.resourceId);
    this.mutations.mutate(
      {
        resourceId: row.resourceId,
        operation: "effect.retry",
        actor: authority?.actor ?? { type: "system" },
        expectedRevision: revision,
      },
      "effect.retry_started",
      () => {
        this.state.connection
          .prepare(
            `UPDATE effects SET status = 'applying', attempt_count = ?, updated_at = ?,
                    settled_at = NULL, error_hash = NULL
             WHERE effect_id = ? AND status = 'pending'`,
          )
          .run(attemptNumber, now, effectId);
        this.insertEffectAttempt(effectId, attemptNumber, authority, now);
      },
      { now, payload: { runId: run.runId, attemptNumber } },
    );
    return { effectId, attemptNumber, disposition: "execute" };
  }

  private insertEffectAttempt(
    effectId: string,
    attemptNumber: number,
    authority: RunWriteAuthority | undefined,
    now: number,
  ): void {
    this.state.connection
      .prepare(
        `INSERT INTO effect_attempts(
           effect_id, attempt_number, owner_id, lease_generation, started_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        effectId,
        attemptNumber,
        authority?.ownerId ?? "system",
        authority?.generation ?? 1,
        now,
      );
  }

  async initializeRun(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    options: InitializeWorkflowRunOptions = {},
  ): Promise<string> {
    return await this.initializeRunFromSnapshot(
      createDefinitionSnapshot(workflow),
      workflow.name,
      state,
      options,
    );
  }

  async initializeRunFromSnapshot(
    snapshot: WorkflowDefinitionSnapshot,
    workflowName: string,
    state: WorkflowRunState,
    options: InitializeWorkflowRunOptions = {},
  ): Promise<string> {
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
          const traceEvent: WorkflowTraceEvent = {
            seq: revision,
            at,
            runId: state.runId,
            scope: "run",
            type: "run_initialized",
            payload: { workflowName },
          };
          insertRunEvent(this.state, reserved.resourceId, revision, at, traceEvent);
          this.persistRunState(reserved, state, revision, now);
          initializeViewerRun(this.state, state.runId, now);
          this.initializeRunSettingsAndFollowUps(state, options.initialSettings ?? [], now);
          if (state.parentRunId !== undefined) {
            recordViewerDeltas(
              this.state,
              state.parentRunId,
              this.viewerInspectorTargets(state.parentRunId),
              now,
            );
          }
          this.syncNodeAttempts(state, snapshot, now);
          recordViewerDeltas(
            this.state,
            state.runId,
            [...runViewerTargets(state, traceEvent), ...this.viewerInspectorTargets(state.runId)],
            now,
          );
          this.syncContinuationIdentity(state);
          context.revision = revision;
          return;
        }
        const definitionHash = this.state.putJson(snapshot, now);
        const parentLineage =
          state.parentRunId === undefined
            ? undefined
            : this.state.connection
                .prepare(
                  `SELECT root_run_id AS rootRunId, restart_number AS restartNumber
                   FROM runs WHERE run_id = ?`,
                )
                .get(state.parentRunId);
        if (state.parentRunId !== undefined && !isRunLineageRow(parentLineage)) {
          throw new Error(`Workflow parent run is missing: ${state.parentRunId}`);
        }
        this.state.connection
          .prepare(
            `INSERT INTO workflow_definitions(
               definition_digest, workflow_name, definition_hash, created_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(definition_digest) DO NOTHING`,
          )
          .run(definitionDigest, workflowName, definitionHash, now);
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
        const launchOptionsHash = this.state.putJson({}, now);
        const finalOutputHash =
          state.finalOutput === undefined ? null : this.state.putJson(state.finalOutput, now);
        const errorHash = state.error === undefined ? null : this.state.putText(state.error, now);
        this.state.connection
          .prepare(
            `INSERT INTO runs(
               run_id, resource_id, project_id, parent_run_id, root_run_id, lineage_kind,
               restart_number, parent_terminal_fingerprint, definition_digest,
               workflow_ref, launch_options_hash, title, status, paused,
               status_detail, input_hash, final_output_hash, error_hash,
               created_at, updated_at, finished_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            state.runId,
            resourceId,
            state.parentRunId ?? null,
            isRunLineageRow(parentLineage) ? parentLineage.rootRunId : state.runId,
            state.parentRunId === undefined ? null : "continuation",
            isRunLineageRow(parentLineage) ? parentLineage.restartNumber : 0,
            definitionDigest,
            state.workflowName,
            launchOptionsHash,
            state.runTitle ?? null,
            state.status,
            state.paused === true ? 1 : 0,
            state.statusDetail ?? null,
            inputHash,
            finalOutputHash,
            errorHash,
            Date.parse(state.startedAt),
            now,
            state.finishedAt === undefined ? null : Date.parse(state.finishedAt),
          );
        initializeViewerRun(this.state, state.runId, now);
        this.insertRunSources(state.runId, source, state.workflowSources ?? []);
        this.syncContinuationIdentity(state);
        insertRunEvent(this.state, resourceId, 1, at, {
          scope: "run",
          type: "run_created",
          payload: { workflowName },
        });
        this.initializeRunSettingsAndFollowUps(state, options.initialSettings ?? [], now);
        if (state.parentRunId !== undefined) {
          recordViewerDeltas(
            this.state,
            state.parentRunId,
            this.viewerInspectorTargets(state.parentRunId),
            now,
          );
        }
        this.syncNodeAttempts(state, snapshot, now);
      });
      this.contexts.set(state.runId, { revision: acceptedRevision, lock: Promise.resolve() });
      return state.runId;
    });
  }

  ensureSettingsScope(options: {
    runId: string;
    mountPath: string;
    invocation: number;
    settings: JsonValue;
  }): WorkflowSettingsScopeRecord {
    const now = Date.now();
    return this.state.transaction(() => {
      this.requireRunAcceptsSettings(options.runId, false);
      const originRunId = this.logicalOriginRunId(options.runId);
      const scopeId = workflowSettingsScopeId(originRunId, options.mountPath, options.invocation);
      const existing = this.settingsScopeRow(scopeId);
      if (existing !== undefined) {
        if (existing.activeRunId !== options.runId) {
          throw new Error(`Workflow settings scope belongs to another active run: ${scopeId}`);
        }
        return this.settingsScopeRecord(existing);
      }
      const resourceId = this.mutations.ensureResource("settings", scopeId, now);
      const settingsHash = this.state.putJson(options.settings, now);
      this.state.connection
        .prepare(
          `INSERT INTO workflow_settings(
             scope_id, resource_id, origin_run_id, active_run_id, mount_path, invocation,
             initial_hash, current_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scopeId,
          resourceId,
          originRunId,
          options.runId,
          options.mountPath,
          options.invocation,
          settingsHash,
          settingsHash,
          now,
          now,
        );
      recordViewerDeltas(
        this.state,
        options.runId,
        this.viewerInspectorTargets(options.runId),
        now,
      );
      return this.settingsScopeRecord(this.requireSettingsScopeRow(scopeId));
    });
  }

  getSettingsScope(scopeId: string): WorkflowSettingsScopeRecord | undefined {
    const row = this.settingsScopeRow(scopeId);
    return row === undefined ? undefined : this.settingsScopeRecord(row);
  }

  getSettingsScopeAtChange(
    scopeId: string,
    changeNumber: number,
  ): WorkflowSettingsScopeRecord | undefined {
    if (!Number.isInteger(changeNumber) || changeNumber < 0) {
      throw new Error("Workflow settings change number must be a non-negative integer");
    }
    const row = this.settingsScopeRow(scopeId);
    if (row === undefined) return undefined;
    if (changeNumber > row.revision) {
      throw new Error(`Workflow settings change ${changeNumber} does not exist for ${scopeId}`);
    }
    if (changeNumber === row.revision) return this.settingsScopeRecord(row);
    const saved =
      changeNumber === 0
        ? this.state.connection
            .prepare(
              "SELECT initial_hash AS settingsHash FROM workflow_settings WHERE scope_id = ?",
            )
            .get(scopeId)
        : this.state.connection
            .prepare(
              `SELECT after_hash AS settingsHash FROM workflow_setting_changes
               WHERE scope_id = ? AND change_number = ?`,
            )
            .get(scopeId, changeNumber);
    if (!isRecord(saved) || !Buffer.isBuffer(saved.settingsHash)) {
      throw new Error(`Workflow settings change ${changeNumber} is missing for ${scopeId}`);
    }
    return this.settingsScopeRecord(row, changeNumber, saved.settingsHash);
  }

  listSettingsScopes(runId: string): WorkflowSettingsScopeRecord[] {
    return this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ?
         ORDER BY s.mount_path, s.invocation`,
      )
      .all(runId)
      .filter(isSettingsScopeRow)
      .map((row) => this.settingsScopeRecord(row));
  }

  private settingsScopesForRunView(runId: string): WorkflowSettingsScopeRecord[] {
    const originRunId = this.logicalOriginRunId(runId);
    return this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.origin_run_id = ? OR s.active_run_id = ?
         ORDER BY s.mount_path, s.invocation`,
      )
      .all(originRunId, runId)
      .filter(isSettingsScopeRow)
      .map((row) => this.settingsScopeRecord(row));
  }

  private readSettingsScopeRange(
    runId: string,
    range: WorkflowRunViewRange,
  ): WorkflowSettingsScopeRecord[] {
    const originRunId = this.logicalOriginRunId(runId);
    return this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.origin_run_id = ? OR s.active_run_id = ?
         ORDER BY s.mount_path, s.invocation LIMIT ? OFFSET ?`,
      )
      .all(originRunId, runId, range.limit, range.start)
      .filter(isSettingsScopeRow)
      .map((row) => this.settingsScopeRecord(row));
  }

  findSettingsScope(
    runId: string,
    mountPath: string,
    invocation: number,
  ): WorkflowSettingsScopeRecord | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ? AND s.mount_path = ? AND s.invocation = ?`,
      )
      .get(runId, mountPath, invocation);
    return isSettingsScopeRow(row) ? this.settingsScopeRecord(row) : undefined;
  }

  async changeSettings<TSettings, TInput = unknown>(
    definition: WorkflowSettingsDefinition<TSettings, TInput>,
    request: WorkflowSettingsChangeRequest,
  ): Promise<WorkflowSettingsChangeResult> {
    assertRequestId(request.requestId);
    assertSourceType(request.source);
    const patch = validateJsonPatch(request.patch);
    const patchJson = canonicalJson(patch);
    const patchDigest = createHash("sha256").update(patchJson).digest();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const prior = this.settingsChangeRow(request.scopeId, request.requestId);
      if (prior !== undefined) {
        this.assertSameSettingsChange(prior, request, patchDigest);
        return {
          scope: this.settingsScopeRecord(this.requireSettingsScopeRow(request.scopeId)),
          change: this.settingsChangeRecord(prior),
          adopted: true,
        };
      }
      const scope = this.requireSettingsScopeRow(request.scopeId);
      if (scope.activeRunId !== request.runId) {
        throw new Error(`Workflow settings scope is not active for run ${request.runId}`);
      }
      this.requireRunAcceptsSettings(request.runId, true);
      if (
        request.expectedChangeNumber !== undefined &&
        request.expectedChangeNumber !== scope.revision
      ) {
        throw new StaleResourceError(
          `Workflow settings changed: expected ${request.expectedChangeNumber}, current ${scope.revision}`,
        );
      }
      const before = this.state.readJson(scope.currentHash);
      const applied = await applyWorkflowSettingsPatch(
        definition,
        before,
        patch,
        request.actor,
        request.source,
      );
      const beforeHash = scope.currentHash;
      const afterHash = createHash("sha256").update(canonicalJson(applied.json)).digest();
      try {
        const mutation = this.mutations.mutate(
          {
            resourceId: scope.resourceId,
            operation: "settings.change",
            actor: request.actor,
            expectedRevision: scope.revision,
          },
          "settings.changed",
          ({ database, nextRevision, now }) => {
            this.requireRunAcceptsSettings(request.runId, true);
            const current = this.requireSettingsScopeRow(request.scopeId);
            if (current.activeRunId !== request.runId || !current.currentHash.equals(beforeHash)) {
              throw new StaleResourceError("Workflow settings changed before the patch committed");
            }
            const patchHash = database.putJson(applied.patch, now);
            const savedAfterHash = database.putJson(applied.json, now);
            const changeId = `setting-change-${randomUUID()}`;
            database.connection
              .prepare(
                `INSERT INTO workflow_setting_changes(
                   change_id, scope_id, request_id, change_number,
                   actor_type, actor_id, source_type, patch_hash,
                   before_hash, after_hash, accepted_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                changeId,
                request.scopeId,
                request.requestId,
                nextRevision,
                request.actor.type,
                request.actor.id ?? null,
                request.source,
                patchHash,
                beforeHash,
                savedAfterHash,
                now,
              );
            database.connection
              .prepare(
                `UPDATE workflow_settings SET current_hash = ?, updated_at = ? WHERE scope_id = ?`,
              )
              .run(savedAfterHash, now, request.scopeId);
            recordViewerDeltas(
              this.state,
              request.runId,
              this.viewerInspectorTargets(request.runId),
              now,
            );
            return changeId;
          },
          {
            payload: {
              scopeId: request.scopeId,
              requestId: request.requestId,
              source: request.source,
              beforeHash: beforeHash.toString("hex"),
              afterHash: afterHash.toString("hex"),
            },
          },
        );
        const row = this.settingsChangeRow(request.scopeId, request.requestId);
        if (row === undefined || row.changeId !== mutation.value) {
          throw new Error("Accepted workflow settings change is missing");
        }
        return {
          scope: this.settingsScopeRecord(this.requireSettingsScopeRow(request.scopeId)),
          change: this.settingsChangeRecord(row),
          adopted: false,
        };
      } catch (error) {
        if (!(error instanceof StaleResourceError) || request.expectedChangeNumber !== undefined) {
          throw error;
        }
      }
    }
    throw new StaleResourceError("Workflow settings kept changing; retry with an expected number");
  }

  queueFollowUp(request: WorkflowQueueFollowUpRequest): {
    followUp: WorkflowFollowUpRecord;
    adopted: boolean;
  } {
    assertRequestId(request.requestId);
    assertSourceType(request.source);
    if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
      throw new Error("Workflow follow-up prompt must be a non-empty string");
    }
    if (Buffer.byteLength(request.prompt, "utf8") > 64 * 1024) {
      throw new Error("Workflow follow-up prompt cannot exceed 65536 bytes");
    }
    return this.state.transaction(() => {
      const prior = this.followUpRowByRequest(request.runId, request.requestId);
      if (prior !== undefined) {
        this.assertSameFollowUp(prior, request);
        return { followUp: this.followUpRecord(prior), adopted: true };
      }
      this.requireRunAcceptsSettings(request.runId, true);
      if (this.originSessionId(request.runId) !== request.targetSessionId) {
        throw new Error("Workflow follow-ups must target the run's origin Pi session");
      }
      const now = Date.now();
      const order = this.nextFollowUpOrder(request.runId);
      const followUpId = followUpIdFor(request.runId, request.requestId);
      const resourceId = this.mutations.ensureResource("follow_up", followUpId, now);
      const promptHash = this.state.putText(request.prompt, now);
      this.state.connection
        .prepare(
          `INSERT INTO workflow_follow_ups(
             follow_up_id, resource_id, run_id, request_id, order_number,
             target_session_id, actor_type, actor_id, source_type, prompt_hash,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          followUpId,
          resourceId,
          request.runId,
          request.requestId,
          order,
          request.targetSessionId,
          request.actor.type,
          request.actor.id ?? null,
          request.source,
          promptHash,
          now,
          now,
        );
      const workflowMessageId = workflowMessageIdFor("followUp", followUpId, "initial");
      this.workflowMessages.create({
        workflowMessageId,
        runId: request.runId,
        targetSessionId: request.targetSessionId,
        kind: "followUp",
        sourceId: followUpId,
        idempotencyKey: "initial",
        content: followUpWorkflowMessageContent({
          workflowMessageId,
          followUpId,
          runId: request.runId,
          prompt: request.prompt,
        }),
        now,
      });
      this.bumpResource(resourceId, 0, now);
      insertGenericEvent(
        this.state,
        resourceId,
        1,
        "follow-up.queued",
        request.actor.type,
        request.actor.id ?? null,
        this.state.putJson({ runId: request.runId, requestId: request.requestId }, now),
        now,
      );
      recordViewerDeltas(
        this.state,
        request.runId,
        this.viewerInspectorTargets(request.runId),
        now,
      );
      return { followUp: this.followUpRecord(this.requireFollowUpRow(followUpId)), adopted: false };
    });
  }

  removeFollowUp(request: WorkflowRemoveFollowUpRequest): WorkflowFollowUpRecord {
    assertSourceType(request.source);
    const row = this.requireFollowUpRow(request.followUpId);
    if (row.runId !== request.runId) {
      throw new Error(`Workflow follow-up is not part of run ${request.runId}`);
    }
    if (row.status === "removed") return this.followUpRecord(row);
    if (row.status === "cancelled") {
      throw new Error("A cancelled workflow follow-up cannot be removed");
    }
    this.assertFollowUpRemovalAuthority(row, request.actor, request.source);
    const message = this.workflowMessages.latestForSource("followUp", request.followUpId);
    if (message?.status === "sent") {
      throw new Error("A sent workflow follow-up cannot be removed");
    }
    const reason = "Removed before delivery";
    this.mutations.mutate(
      {
        resourceId: row.resourceId,
        operation: "follow-up.remove",
        actor: request.actor,
        expectedRevision: row.revision,
      },
      "follow-up.removed",
      ({ database, now }) => {
        const reasonHash = database.putText(reason, now);
        const update = database.connection
          .prepare(
            `UPDATE workflow_follow_ups
             SET status = 'removed', reason_hash = ?, updated_at = ?
             WHERE follow_up_id = ? AND status = 'queued'`,
          )
          .run(reasonHash, now, request.followUpId);
        if (update.changes !== 1) {
          throw new StaleResourceError("Workflow follow-up changed before removal");
        }
        this.workflowMessages.cancelPendingForSource(request.followUpId, "followUp", now);
        recordViewerDeltas(
          this.state,
          request.runId,
          this.viewerInspectorTargets(request.runId),
          now,
        );
      },
      { payload: { followUpId: request.followUpId, source: request.source } },
    );
    return this.followUpRecord(this.requireFollowUpRow(request.followUpId));
  }

  originSessionId(runId: string): string | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT b.origin_session_id AS originSessionId
         FROM runs r LEFT JOIN run_bindings b ON b.run_id = r.run_id
         WHERE r.run_id = ?`,
      )
      .get(runId);
    return isRecord(row) && typeof row.originSessionId === "string"
      ? row.originSessionId
      : undefined;
  }

  readFollowUpQueue(runId: string): WorkflowFollowUpQueueRecord | undefined {
    const originSessionId = this.originSessionId(runId);
    if (originSessionId === undefined) return undefined;
    const followUps = this.state.connection
      .prepare(`${FOLLOW_UP_ROW_SELECT} WHERE f.run_id = ? ORDER BY f.order_number`)
      .all(runId)
      .filter(isFollowUpRow)
      .map((row) => this.followUpRecord(row));
    return { runId, originSessionId, followUps };
  }

  private readFollowUpQueueRange(
    runId: string,
    range: WorkflowRunViewRange,
  ): WorkflowFollowUpQueueRecord | null {
    const originSessionId = this.originSessionId(runId);
    if (originSessionId === undefined) return null;
    const followUps = this.state.connection
      .prepare(
        `${FOLLOW_UP_ROW_SELECT} WHERE f.run_id = ? ORDER BY f.order_number LIMIT ? OFFSET ?`,
      )
      .all(runId, range.limit, range.start)
      .filter(isFollowUpRow)
      .map((row) => this.followUpRecord(row));
    return { runId, originSessionId, followUps };
  }

  async prepareRunResume(runId: string): Promise<WorkflowRunState> {
    const state = this.readRunState(runId);
    if (state === null) throw new Error(`Cannot resume unreadable workflow run: ${runId}`);
    if (state.status !== "running") {
      throw new Error(`Cannot resume workflow run ${runId} with status ${state.status}`);
    }
    this.verifySettingsProjections(runId);
    const revision = this.resourceRevision(runId);
    this.contexts.set(runId, { revision, lock: Promise.resolve() });
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
           SET status = 'interrupted', updated_at = ?
           WHERE run_id = ? AND status IN ('pending', 'running', 'waiting')`,
        )
        .run(now, runId);
      const traceEvent: WorkflowTraceEvent = {
        seq: nextRevision,
        at,
        runId,
        scope: "run",
        type: "run_resume_prepared",
        payload: {},
      };
      insertRunEvent(this.state, row.resourceId, nextRevision, at, traceEvent);
      state.traceSeq = nextRevision;
      state.updatedAt = at;
      this.persistRunState(row, state, nextRevision, now);
      recordViewerDeltas(this.state, runId, runViewerTargets(state, traceEvent), now);
      context.revision = nextRevision;
    });
    const prepared = this.readRunState(runId);
    if (prepared === null) throw new Error(`Workflow run became unreadable: ${runId}`);
    return prepared;
  }

  async markRunInterrupted(
    runId: string,
    reason = "Workflow server stopped before the run finished",
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
    delete loaded.state.currentNodeDeadlineAt;
    delete loaded.state.currentSettingsScopeId;
    delete loaded.state.currentSettingsChangeNumber;
    delete loaded.state.currentSettingsHash;
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
    return await this.withRunLock(runId, async () =>
      this.publishUpdateSynchronous(runId, state, nodeId, attemptId, update, options),
    );
  }

  /** Server-only synchronous form for an already serialized command transaction. */
  publishUpdateSynchronous(
    runId: string,
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
    options: { signal?: AbortSignal } = {},
  ): { event: WorkflowTraceEvent; record: WorkflowUpdateRecord } {
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
      const committedAt = Date.now();
      this.persistRunState(run, state, revision, committedAt);
      recordViewerDeltas(this.state, runId, runViewerTargets(state, event), committedAt);
      context.revision = revision;
      acceptedEvent = event;
      acceptedRecord = record;
    });
    if (acceptedEvent === undefined || acceptedRecord === undefined) {
      throw new Error("Workflow update transaction did not produce a result");
    }
    return { event: acceptedEvent, record: acceptedRecord };
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
        const snapshot = this.readDefinition(run.definitionHash);
        this.assertSettingsRouteCurrent(event, snapshot);
        const traceEvent: WorkflowTraceEvent = { seq: revision, at, runId, ...event };
        state.traceSeq = revision;
        state.updatedAt = at;
        insertRunEvent(this.state, run.resourceId, revision, at, traceEvent);
        this.persistRunState(run, state, revision, now);
        this.transitionFollowUpsForRunState(state, event, now);
        this.syncNodeAttempts(state, snapshot, now);
        recordViewerDeltas(this.state, runId, runViewerTargets(state, traceEvent), now);
        this.snapshotLifecycle?.({
          runId,
          state,
          event: traceEvent,
          database: this.state,
          now,
        });
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
      const hasExistingSession = this.segmentRows(runId).length > 0;
      this.state.transaction(() => {
        const run = this.requireRunRow(runId);
        const context = this.contextFor(runId);
        this.assertSessionWriteAuthority(runId);
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
        const traceEvent: WorkflowTraceEvent = {
          seq: revision,
          at,
          runId,
          scope: "session",
          type: "session_bound",
          payload: {
            piSessionId: binding.piSessionId,
            ...(attemptId !== undefined ? { captureAttemptId: attemptId } : {}),
          },
        };
        insertRunEvent(this.state, run.resourceId, revision, at, traceEvent);
        const current = this.materializeRunState(run, this.readDefinition(run.definitionHash));
        current.traceSeq = revision;
        current.updatedAt = at;
        this.persistRunState(run, current, revision, now);
        const targets = runViewerTargets(current, traceEvent);
        targets[0]?.patch?.push(
          hasExistingSession
            ? {
                op: "add",
                path: "/session/binding",
                value: parseJson(canonicalJson(binding)),
              }
            : {
                op: "add",
                path: "/session",
                value: parseJson(
                  canonicalJson({
                    binding,
                    presentationRevision: 0,
                    entryPage: { presentationRevision: 0, start: 0, total: 0, items: [] },
                    eventPage: { presentationRevision: 0, start: 0, total: 0, items: [] },
                    eventsMalformed: false,
                    eventsTornTail: false,
                    capture: null,
                    replayCheckpoint: null,
                  }),
                ),
              },
        );
        recordViewerDeltas(this.state, runId, targets, now);
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
      const runSequenceRow = this.state.connection
        .prepare(
          `SELECT COALESCE(MAX(run_seq), 0) + 1 AS count
           FROM session_entries WHERE run_id = ?`,
        )
        .get(runId);
      if (!isCountRow(runSequenceRow)) {
        throw new Error("Workflow session entry sequence is unavailable");
      }
      const runSequence = runSequenceRow.count;
      const now = Date.now();
      const entryHash = this.state.putJson(entry, now);
      const entryId = typeof entry.id === "string" ? entry.id : `entry-${sequence}`;
      this.state.connection
        .prepare(
          `INSERT INTO session_entries(
             segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(segment.segmentId, runId, sequence, runSequence, entryId, entryHash, now);
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
        null,
        now,
      );
      recordViewerDeltas(
        this.state,
        runId,
        [
          {
            targetType: "conversation",
            targetKey: "entries:tail",
            patch: viewerTailPatch(runSequence - 1, [
              parseJson(
                canonicalJson({
                  seq: runSequence,
                  at: new Date(now).toISOString(),
                  entry,
                }),
              ),
            ]),
          },
          {
            targetType: "conversation",
            targetKey: "capture",
            patch: [
              {
                op: "replace",
                path: "/capture/entryCount",
                value: runSequence,
              },
            ],
          },
        ],
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
      const runSequenceRow = this.state.connection
        .prepare(
          `SELECT COALESCE(MAX(run_seq), 0) + 1 AS count
           FROM session_events WHERE run_id = ?`,
        )
        .get(runId);
      if (!isCountRow(runSequenceRow)) {
        throw new Error("Workflow session event sequence is unavailable");
      }
      let runSequence = runSequenceRow.count;
      const firstRunSequence = runSequence;
      const projectedRecords: Array<WorkflowSessionEventRecord & { stepIndex?: number }> = [];
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
               segment_id, run_id, event_seq, run_seq, event_type, node_id, attempt_id,
               turn_id, message_id, tool_call_id, payload_hash, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            current.segmentId,
            runId,
            record.seq,
            runSequence,
            record.type,
            record.nodeId,
            record.attemptId,
            record.turnId ?? null,
            record.messageId ?? null,
            record.toolCallId ?? null,
            payloadHash,
            Date.parse(record.at),
          );
        const stepIndex = this.state.connection
          .prepare(
            `SELECT step_index AS stepIndex
             FROM run_steps WHERE run_id = ? AND attempt_id = ?`,
          )
          .get(runId, record.attemptId);
        projectedRecords.push({
          ...record,
          seq: runSequence,
          ...(isStepIndexRow(stepIndex) ? { stepIndex: stepIndex.stepIndex } : {}),
        });
        expected += 1;
        runSequence += 1;
      }
      this.state.connection
        .prepare("UPDATE session_segments SET event_count = ? WHERE segment_id = ?")
        .run(expected - 1, current.segmentId);
      const recordedAt = Date.now();
      this.recordSessionReplayCheckpoints(runId, firstRunSequence, projectedRecords, recordedAt);
      const projectedValues = projectedRecords.map((record) => parseJson(canonicalJson(record)));
      const nextEventTotal = firstRunSequence - 1 + projectedValues.length;
      const previousBlock = Math.floor(Math.max(0, firstRunSequence - 2) / VIEWER_PAGE_SIZE);
      const nextBlock = Math.floor(Math.max(0, nextEventTotal - 1) / VIEWER_PAGE_SIZE);
      const crossesPageBoundary = previousBlock !== nextBlock;
      recordViewerDeltas(
        this.state,
        runId,
        [
          {
            targetType: "timeline",
            targetKey: crossesPageBoundary ? "session:reload" : "session:tail",
            patch: crossesPageBoundary
              ? [{ op: "replace", path: "/total", value: nextEventTotal }]
              : [
                  { op: "append", path: "/items", value: projectedValues },
                  { op: "replace", path: "/total", value: nextEventTotal },
                ],
          },
          {
            targetType: "conversation",
            targetKey: "capture",
            patch: [
              {
                op: "replace",
                path: "/capture/eventCount",
                value: nextEventTotal,
              },
              {
                op: "replace",
                path: "/capture/lastEventSeq",
                value: nextEventTotal,
              },
            ],
          },
        ],
        recordedAt,
      );
    });
  }

  private recordSessionReplayCheckpoints(
    runId: string,
    firstRunSequence: number,
    newRecords: WorkflowSessionEventRecord[],
    now: number,
  ): void {
    const row = this.state.connection
      .prepare(
        `SELECT event_seq AS eventSeq, state_hash AS stateHash
         FROM viewer_session_checkpoints
         WHERE run_id = ? ORDER BY event_seq DESC LIMIT 1`,
      )
      .get(runId);
    let checkpoint = reduceSessionEvents([], [], 0);
    if (isViewerSessionCheckpointRow(row)) {
      const saved = this.state.readJson(row.stateHash);
      if (!isTemporalSessionState(saved) || saved.throughSeq !== row.eventSeq) {
        throw new Error(`Viewer session checkpoint is invalid for ${runId}`);
      }
      checkpoint = saved;
    }
    let pending = [
      ...this.sessionEventRecords(runId, checkpoint.throughSeq, firstRunSequence),
      ...newRecords,
    ];
    const lastSequence = pending.at(-1)?.seq ?? checkpoint.throughSeq;
    let boundary = (Math.floor(checkpoint.throughSeq / VIEWER_PAGE_SIZE) + 1) * VIEWER_PAGE_SIZE;
    while (boundary <= lastSequence) {
      const page = pending.filter((event) => event.seq <= boundary);
      checkpoint = reduceSessionEventsFromCheckpoint([], page, boundary, checkpoint);
      checkpoint = boundedTemporalCheckpoint(checkpoint);
      const stateHash = this.state.putJson(checkpoint, now);
      this.state.connection
        .prepare(
          `INSERT INTO viewer_session_checkpoints(run_id, event_seq, state_hash, recorded_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(runId, boundary, stateHash, now);
      pending = pending.filter((event) => event.seq > boundary);
      boundary += VIEWER_PAGE_SIZE;
    }
  }

  private sessionEventRecords(
    runId: string,
    afterSequence: number,
    beforeSequence: number,
  ): WorkflowSessionEventRecord[] {
    return this.state.connection
      .prepare(
        `SELECT run_seq AS runSeq, event_type AS eventType, node_id AS nodeId,
                attempt_id AS attemptId, turn_id AS turnId, message_id AS messageId,
                tool_call_id AS toolCallId, payload_hash AS payloadHash,
                recorded_at AS recordedAt
         FROM session_events
         WHERE run_id = ? AND run_seq > ? AND run_seq < ?
         ORDER BY run_seq`,
      )
      .all(runId, afterSequence, beforeSequence)
      .map((value) => {
        if (!isViewerSessionEventRow(value)) {
          throw new Error(`Viewer session event row is invalid for ${runId}`);
        }
        const payload = this.state.readJson(value.payloadHash);
        if (!isRecord(payload)) {
          throw new Error(`Viewer session event payload is invalid for ${runId}`);
        }
        return {
          seq: value.runSeq,
          at: new Date(value.recordedAt).toISOString(),
          nodeId: value.nodeId,
          attemptId: value.attemptId,
          type: assertSessionEventType(value.eventType),
          payload,
          ...(value.turnId === null ? {} : { turnId: value.turnId }),
          ...(value.messageId === null ? {} : { messageId: value.messageId }),
          ...(value.toolCallId === null ? {} : { toolCallId: value.toolCallId }),
        };
      });
  }

  private viewerSessionCapture(runId: string): WorkflowSessionCapture {
    const segments = this.segmentRows(runId);
    let status: WorkflowSessionCapture["status"] = "complete";
    let failure: WorkflowSessionCapture["failure"];
    let entryCount = 0;
    let eventCount = 0;
    for (const segment of segments) {
      entryCount += segment.entryCount;
      eventCount += segment.eventCount;
      if (segment.status === "failed") {
        status = "failed";
        if (failure === undefined && segment.failureHash !== null) {
          const value = this.state.readJson(segment.failureHash);
          if (
            !isRecord(value) ||
            typeof value.failedAt !== "string" ||
            typeof value.code !== "string" ||
            typeof value.message !== "string"
          ) {
            throw new Error(`Session capture failure is invalid for ${runId}`);
          }
          failure = {
            failedAt: value.failedAt,
            code: value.code,
            message: value.message,
          };
        }
      } else if (segment.status === "recording" && status !== "failed") {
        status = "recording";
      }
    }
    return {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status,
      eventCount,
      entryCount,
      lastEventSeq: eventCount,
      ...(failure === undefined ? {} : { failure }),
    };
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
      const viewerCapture = this.viewerSessionCapture(runId);
      recordViewerDeltas(
        this.state,
        runId,
        [
          {
            targetType: "conversation",
            targetKey: "capture",
            patch: [
              {
                op: "add",
                path: "/capture",
                value: parseJson(canonicalJson(viewerCapture)),
              },
            ],
          },
        ],
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

  readRunInput(runId: string): JsonValue | null {
    const row = this.readRunRow(runId);
    return row === undefined ? null : this.state.readJson(row.inputHash);
  }

  readRunFinalOutput(runId: string): JsonValue | null {
    const row = this.readRunRow(runId);
    return row?.finalOutputHash == null ? null : this.state.readJson(row.finalOutputHash);
  }

  readRunError(runId: string): string | null {
    const row = this.readRunRow(runId);
    return row?.errorHash == null ? null : this.readText(row.errorHash);
  }

  readPresentationInstructions(runId: string): string {
    const row = this.state.connection
      .prepare("SELECT presentation_prompt_hash AS hash FROM runs WHERE run_id = ?")
      .get(runId) as { hash?: Buffer | null } | undefined;
    if (row?.hash == null) {
      return "Explain the final workflow result to the user in a normal response.";
    }
    return this.readText(row.hash);
  }

  readTerminalData(runId: string): WorkflowRunTerminalData | null {
    const row = this.state.connection
      .prepare(
        `SELECT status, status_detail AS statusDetail, restart_number AS restartNumber
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | { status?: unknown; statusDetail?: unknown; restartNumber?: unknown }
      | undefined;
    if (
      row === undefined ||
      !["completed", "failed", "timed_out", "cancelled"].includes(String(row.status)) ||
      typeof row.restartNumber !== "number"
    ) {
      return null;
    }
    return {
      runId,
      status: row.status as WorkflowRunTerminalData["status"],
      statusDetail: typeof row.statusDetail === "string" ? row.statusDetail : null,
      input: this.readRunInput(runId) as JsonValue,
      finalOutput: this.readRunFinalOutput(runId),
      error: this.readRunError(runId),
      presentationInstructions: this.readPresentationInstructions(runId),
      restartNumber: row.restartNumber,
    };
  }

  readRunState(runId: string): WorkflowRunState | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    return this.materializeRunState(row, this.readDefinition(row.definitionHash));
  }

  readRun(runId: string, options: ReadWorkflowRunOptions = {}): LoadedWorkflowRun | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    const snapshot = this.readDefinition(row.definitionHash);
    const state = this.materializeRunState(row, snapshot);
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
      settingsScopes: this.settingsScopesForRunView(runId),
      followUpQueue: this.readFollowUpQueue(runId) ?? null,
    };
  }

  readRunViewCounts(runId: string): WorkflowRunViewCounts | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    const segment = this.segmentRow(segmentIdFor(runId));
    const settingsOrigin = this.logicalOriginRunId(runId);
    const scalar = (sql: string, ...params: unknown[]): number => {
      const count = this.state.connection.prepare(sql).get(...params);
      return isCountRow(count) ? count.count : 0;
    };
    return {
      steps: scalar("SELECT count(*) AS count FROM run_steps WHERE run_id = ?", runId),
      trace: scalar("SELECT count(*) AS count FROM events WHERE resource_id = ?", row.resourceId),
      sessionEntries: segment?.entryCount ?? 0,
      sessionEvents: segment?.eventCount ?? 0,
      settings: scalar(
        `SELECT count(*) AS count FROM workflow_settings
         WHERE origin_run_id = ? OR active_run_id = ?`,
        settingsOrigin,
        runId,
      ),
      followUps: scalar(
        "SELECT count(*) AS count FROM workflow_follow_ups WHERE run_id = ?",
        runId,
      ),
      updates: scalar(
        `SELECT count(*) AS count FROM (
           SELECT 1 FROM workflow_updates u
           JOIN node_attempts a ON a.attempt_id = u.attempt_id
           WHERE a.run_id = ? GROUP BY u.update_type, u.update_key
         )`,
        runId,
      ),
    };
  }

  readRunView(runId: string, options: WorkflowRunViewReadOptions): WorkflowRunViewRead | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    const snapshot = this.readDefinition(row.definitionHash);
    const steps = this.readStepRange(runId, options.steps);
    const visibleUpdates = this.readCurrentUpdates(runId, options.updates);
    const state = this.buildRunState(
      row,
      snapshot,
      this.readLatestSteps(runId),
      steps,
      visibleUpdates,
    );
    const segment = this.segmentRow(segmentIdFor(runId));
    const loadedSegment =
      segment === undefined
        ? emptySegment()
        : this.loadSegment(segment, state, {
            entries: options.sessionEntries,
            events: options.sessionEvents,
          });
    return {
      runId,
      state,
      snapshot,
      traceEvents: this.traceEvents(row, options.trace),
      sessionBinding: loadedSegment.binding,
      sessionEntries: loadedSegment.entries,
      sessionEvents: loadedSegment.events,
      sessionCapture: loadedSegment.capture,
      sessionIntegrity: loadedSegment.integrity,
      settingsScopes: this.readSettingsScopeRange(runId, options.settings),
      followUpQueue: this.readFollowUpQueueRange(runId, options.followUps),
      graphSteps: this.readLatestSteps(runId, options.graphCursor),
      takenTransitions: this.readTakenTransitions(runId, options.graphCursor),
    };
  }

  traceCursorForStep(runId: string, stepCursor: number, traceTotal: number): number {
    const step = this.state.connection
      .prepare(
        `SELECT a.attempt_id AS attemptId, a.node_id AS nodeId
         FROM run_steps s JOIN node_attempts a ON a.attempt_id = s.attempt_id
         WHERE s.run_id = ? AND s.step_index = ?`,
      )
      .get(runId, stepCursor);
    if (!isRecord(step) || typeof step.attemptId !== "string" || typeof step.nodeId !== "string") {
      return Math.min(stepCursor, Math.max(0, traceTotal - 1));
    }
    const run = this.readRunRow(runId);
    if (run === undefined) return 0;
    const exactAttempt = this.state.connection
      .prepare(
        `SELECT e.resource_revision AS revision FROM events e
         JOIN blobs b ON b.blob_hash = e.payload_hash
         WHERE e.resource_id = ?
           AND json_extract(CAST(b.content AS TEXT), '$.attemptId') = ?
         ORDER BY e.resource_revision DESC LIMIT 1`,
      )
      .get(run.resourceId, step.attemptId);
    const matched = isRevisionRow(exactAttempt)
      ? exactAttempt
      : this.state.connection
          .prepare(
            `SELECT e.resource_revision AS revision FROM events e
             JOIN blobs b ON b.blob_hash = e.payload_hash
             WHERE e.resource_id = ?
               AND json_extract(CAST(b.content AS TEXT), '$.nodeId') = ?
             ORDER BY e.resource_revision DESC LIMIT 1`,
          )
          .get(run.resourceId, step.nodeId);
    if (!isRevisionRow(matched)) return Math.min(stepCursor, Math.max(0, traceTotal - 1));
    const index = this.state.connection
      .prepare(
        `SELECT count(*) - 1 AS count FROM events
         WHERE resource_id = ? AND resource_revision <= ?`,
      )
      .get(run.resourceId, matched.revision);
    return isCountRow(index) ? Math.max(0, index.count) : 0;
  }

  persistViewContent(runId: string, content: Buffer, mediaType: string): string {
    if (this.readRunRow(runId) === undefined) throw new Error(`Workflow run not found: ${runId}`);
    return this.state.transaction(() => {
      const hash = createHash("sha256").update(content).digest();
      this.state.connection
        .prepare(
          `INSERT INTO run_view_content(
             run_id, content_hash, media_type, byte_length, content, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, content_hash, media_type) DO NOTHING`,
        )
        .run(runId, hash, mediaType, content.byteLength, content, Date.now());
      const stored = this.state.connection
        .prepare(
          `SELECT media_type AS mediaType, byte_length AS byteLength, content
           FROM run_view_content
           WHERE run_id = ? AND content_hash = ? AND media_type = ?`,
        )
        .get(runId, hash, mediaType);
      if (
        !isRecord(stored) ||
        stored.mediaType !== mediaType ||
        stored.byteLength !== content.byteLength ||
        !Buffer.isBuffer(stored.content) ||
        !stored.content.equals(content)
      ) {
        throw new Error("Run-scoped view content conflict");
      }
      return hash.toString("hex");
    });
  }

  readContentBlob(
    runId: string,
    digest: string,
    mediaType: string,
  ): { mediaType: string; content: Buffer } | undefined {
    if (!/^[0-9a-f]{64}$/u.test(digest)) return undefined;
    const stored = this.state.connection
      .prepare(
        `SELECT media_type AS mediaType, byte_length AS byteLength, content
         FROM run_view_content
         WHERE run_id = ? AND content_hash = ? AND media_type = ?`,
      )
      .get(runId, Buffer.from(digest, "hex"), mediaType);
    if (
      !isRecord(stored) ||
      stored.mediaType !== mediaType ||
      typeof stored.byteLength !== "number" ||
      !Buffer.isBuffer(stored.content) ||
      stored.content.byteLength !== stored.byteLength
    ) {
      return undefined;
    }
    return { mediaType, content: stored.content };
  }

  readDisplayState(runId: string): WorkflowRunDisplayState | null {
    const row = this.readRunRow(runId);
    if (row === undefined) return null;
    return {
      status: row.status as WorkflowRunState["status"],
      paused: row.paused === 1,
      error: row.errorHash === null ? null : this.readText(row.errorHash),
    };
  }

  readSessionReplayCheckpoint(runId: string, throughSequence: number): JsonValue | null {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Session replay checkpoint sequence must be a non-negative integer");
    }
    if (throughSequence === 0) return null;
    const row = this.state.connection
      .prepare(
        `SELECT event_seq AS eventSeq, state_hash AS stateHash
         FROM viewer_session_checkpoints
         WHERE run_id = ? AND event_seq <= ? ORDER BY event_seq DESC LIMIT 1`,
      )
      .get(runId, throughSequence);
    let checkpoint = reduceSessionEvents([], [], 0);
    if (isViewerSessionCheckpointRow(row)) {
      const saved = this.state.readJson(row.stateHash);
      if (!isTemporalSessionState(saved) || saved.throughSeq !== row.eventSeq) {
        throw new Error(`Viewer session checkpoint is invalid for ${runId}`);
      }
      checkpoint = saved;
    }
    if (checkpoint.throughSeq < throughSequence) {
      const events = this.sessionEventRecords(runId, checkpoint.throughSeq, throughSequence + 1);
      checkpoint = reduceSessionEventsFromCheckpoint([], events, throughSequence, checkpoint);
      checkpoint = boundedTemporalCheckpoint(checkpoint);
    }
    return parseJson(canonicalJson(checkpoint));
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
    if (this.allowServerSessionRecording) return;
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
    const lease = this.state.connection
      .prepare(
        `SELECT generation, owner_type AS ownerType, owner_id AS ownerId,
                token_hash AS tokenHash, expires_at AS expiresAt
         FROM leases WHERE resource_id = ?`,
      )
      .get(run.resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    if (!isLeaseAuthorityRow(lease)) throw new Error("Workflow run lease is missing");

    if (lease.ownerId !== null || this.authorityProvider !== undefined) {
      const authority = this.authorityProvider?.(run.runId);
      if (authority === undefined) {
        throw new ClaimLostError(run.runId, "missingAuthority");
      }
      const now = Date.now();
      if (lease.expiresAt === null || lease.expiresAt <= now) {
        throw new ClaimLostError(run.runId, "expired");
      }
      if (authority.ownerType !== lease.ownerType || authority.ownerId !== lease.ownerId) {
        throw new ClaimLostError(run.runId, "ownerChanged");
      }
      if (lease.tokenHash === null || !lease.tokenHash.equals(tokenHash(authority.token))) {
        throw new ClaimLostError(run.runId, "tokenChanged");
      }
      if (authority.generation !== lease.generation) {
        throw new ClaimLostError(run.runId, "generationChanged");
      }
      const leaseMs = authority.leaseMs ?? 30_000;
      if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
        throw new Error("Workflow run authority lease duration must be a positive integer");
      }
      const renewal = this.state.connection
        .prepare(
          `UPDATE leases SET heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND owner_type = ? AND owner_id = ?
             AND token_hash = ? AND generation = ? AND expires_at > ?`,
        )
        .run(
          now,
          now + leaseMs,
          run.resourceId,
          authority.ownerType,
          authority.ownerId,
          tokenHash(authority.token),
          authority.generation,
          now,
        );
      /* istanbul ignore if -- BEGIN IMMEDIATE keeps the checked lease stable */
      if (renewal.changes !== 1) {
        throw new ClaimLostError(run.runId, "expired");
      }
    }

    const actualRevision = this.requireResourceRevision(run.resourceId);
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `Workflow run revision conflict: expected ${expectedRevision}, got ${actualRevision}`,
      );
    }
  }

  private persistRunState(
    run: RunRow,
    state: WorkflowRunState,
    expectedRevision: number,
    now: number,
  ): void {
    this.bumpResource(run.resourceId, expectedRevision - 1, now);
    const finalOutputHash =
      state.finalOutput === undefined ? null : this.state.putJson(state.finalOutput, now);
    const errorHash = state.error === undefined ? null : this.state.putText(state.error, now);
    const update = this.state.connection
      .prepare(
        `UPDATE runs
         SET title = ?, status = ?, paused = ?, status_detail = ?,
             final_output_hash = ?, error_hash = ?, updated_at = ?, finished_at = ?
         WHERE run_id = ?`,
      )
      .run(
        state.runTitle ?? null,
        state.status,
        state.paused === true ? 1 : 0,
        state.statusDetail ?? null,
        finalOutputHash,
        errorHash,
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

  private viewerInspectorTargets(runId: string): ViewerDeltaDraft[] {
    const settings = this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ?
         ORDER BY s.mount_path, s.invocation`,
      )
      .all(runId)
      .filter(isSettingsScopeRow)
      .map((row) => ({
        scopeId: row.scopeId,
        mountPath: row.mountPath,
        invocation: row.invocation,
        changeNumber: row.revision,
        settingsHash: row.currentHash.toString("hex"),
      }));
    const settingsStart = Math.max(0, settings.length - VIEWER_PAGE_SIZE);
    const followUps = this.state.connection
      .prepare(`${FOLLOW_UP_ROW_SELECT} WHERE f.run_id = ? ORDER BY f.order_number`)
      .all(runId)
      .filter(isFollowUpRow)
      .map((row) => ({
        followUpId: row.followUpId,
        order: row.orderNumber,
        state: row.status,
        source: row.sourceType,
      }));
    const followUpStart = Math.max(0, followUps.length - VIEWER_PAGE_SIZE);
    return [
      {
        targetType: "inspector",
        targetKey: "settings",
        patch: [
          {
            op: "replace",
            path: "/settingsScopes",
            value: parseJson(canonicalJson(settings.slice(settingsStart))),
          },
          { op: "replace", path: "/settingsStart", value: settingsStart },
          { op: "replace", path: "/settingsTotal", value: settings.length },
        ],
      },
      {
        targetType: "inspector",
        targetKey: "follow-ups",
        patch: [
          {
            op: "replace",
            path: "/followUpQueue",
            value: parseJson(canonicalJson({ items: followUps.slice(followUpStart) })),
          },
          { op: "replace", path: "/followUpStart", value: followUpStart },
          { op: "replace", path: "/followUpTotal", value: followUps.length },
        ],
      },
    ];
  }

  private initializeRunSettingsAndFollowUps(
    state: WorkflowRunState,
    initialSettings: InitialWorkflowSettingsScope[],
    now: number,
  ): void {
    if (state.parentRunId !== undefined) {
      this.state.connection
        .prepare(
          `UPDATE workflow_settings SET active_run_id = ?, updated_at = ? WHERE active_run_id = ?`,
        )
        .run(state.runId, now, state.parentRunId);
    }
    const existing = this.state.connection
      .prepare("SELECT COUNT(*) AS count FROM workflow_settings WHERE active_run_id = ?")
      .get(state.runId);
    const hasSettings = isCountRow(existing) && existing.count > 0;
    if (hasSettings) return;
    for (const scope of initialSettings) {
      const originRunId = this.logicalOriginRunId(state.runId);
      const scopeId = workflowSettingsScopeId(originRunId, scope.mountPath, scope.invocation);
      const resourceId = this.mutations.ensureResource("settings", scopeId, now);
      const settingsHash = this.state.putJson(scope.settings, now);
      this.state.connection
        .prepare(
          `INSERT INTO workflow_settings(
             scope_id, resource_id, origin_run_id, active_run_id, mount_path, invocation,
             initial_hash, current_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_id) DO NOTHING`,
        )
        .run(
          scopeId,
          resourceId,
          originRunId,
          state.runId,
          scope.mountPath,
          scope.invocation,
          settingsHash,
          settingsHash,
          now,
          now,
        );
    }
  }

  private logicalOriginRunId(runId: string): string {
    let current = runId;
    for (let depth = 0; depth < 100; depth += 1) {
      const row = this.state.connection
        .prepare("SELECT parent_run_id AS parentRunId FROM runs WHERE run_id = ?")
        .get(current);
      if (!isParentRunRow(row)) return current;
      if (row.parentRunId === null) return current;
      current = row.parentRunId;
    }
    throw new Error(`Workflow continuation chain is too deep for run ${runId}`);
  }

  private requireRunAcceptsSettings(runId: string, allowWaiting: boolean): void {
    const row = this.state.connection
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(runId);
    if (!isStatusRow(row)) throw new Error(`Workflow run is missing: ${runId}`);
    if (row.status !== "running" && !(allowWaiting && row.status === "waiting")) {
      throw new Error(`Workflow run ${runId} does not accept changes with status ${row.status}`);
    }
  }

  private verifySettingsProjections(runId: string): void {
    const scopes = this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.initial_hash AS initialHash,
                s.current_hash AS currentHash, r.revision
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ?`,
      )
      .all(runId);
    for (const value of scopes) {
      if (!isSettingsProjectionRow(value)) {
        throw new Error("Workflow settings projection row is invalid");
      }
      let current = this.state.readJson(value.initialHash);
      let currentHash = value.initialHash;
      const changes = this.state.connection
        .prepare(
          `SELECT change_number AS changeNumber, patch_hash AS patchHash,
                  before_hash AS beforeHash, after_hash AS afterHash
           FROM workflow_setting_changes WHERE scope_id = ? ORDER BY change_number`,
        )
        .all(value.scopeId);
      let expected = 1;
      for (const change of changes) {
        if (!isSettingsProjectionChangeRow(change) || change.changeNumber !== expected) {
          throw new Error(`Workflow settings changes are not contiguous for ${value.scopeId}`);
        }
        if (!change.beforeHash.equals(currentHash)) {
          throw new Error(`Workflow settings change has a wrong old value for ${value.scopeId}`);
        }
        current = applyJsonPatch(current, this.state.readJson(change.patchHash));
        currentHash = createHash("sha256").update(canonicalJson(current)).digest();
        if (!currentHash.equals(change.afterHash)) {
          throw new Error(`Workflow settings change has a wrong new value for ${value.scopeId}`);
        }
        expected += 1;
      }
      if (value.revision !== expected - 1 || !value.currentHash.equals(currentHash)) {
        throw new Error(
          `Workflow settings projection does not match saved changes for ${value.scopeId}`,
        );
      }
    }
  }

  private settingsScopeRow(scopeId: string): SettingsScopeRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT s.scope_id AS scopeId, s.resource_id AS resourceId,
                s.origin_run_id AS originRunId, s.active_run_id AS activeRunId,
                s.mount_path AS mountPath, s.invocation,
                s.current_hash AS currentHash, r.revision,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.scope_id = ?`,
      )
      .get(scopeId);
    return isSettingsScopeRow(row) ? row : undefined;
  }

  private requireSettingsScopeRow(scopeId: string): SettingsScopeRow {
    const row = this.settingsScopeRow(scopeId);
    if (row === undefined) throw new Error(`Workflow settings scope not found: ${scopeId}`);
    return row;
  }

  private settingsScopeRecord(
    row: SettingsScopeRow,
    changeNumber = row.revision,
    settingsHash = row.currentHash,
  ): WorkflowSettingsScopeRecord {
    return {
      scopeId: row.scopeId,
      originRunId: row.originRunId,
      activeRunId: row.activeRunId,
      mountPath: row.mountPath,
      invocation: row.invocation,
      changeNumber,
      settings: this.state.readJson(settingsHash),
      settingsHash: settingsHash.toString("hex"),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private settingsChangeRow(scopeId: string, requestId: string): SettingsChangeRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT change_id AS changeId, scope_id AS scopeId, request_id AS requestId,
                change_number AS changeNumber, actor_type AS actorType, actor_id AS actorId,
                source_type AS sourceType, patch_hash AS patchHash,
                before_hash AS beforeHash, after_hash AS afterHash,
                accepted_at AS acceptedAt
         FROM workflow_setting_changes WHERE scope_id = ? AND request_id = ?`,
      )
      .get(scopeId, requestId);
    return isSettingsChangeRow(row) ? row : undefined;
  }

  private settingsChangeRecord(row: SettingsChangeRow): WorkflowSettingsChangeRecord {
    return {
      changeId: row.changeId,
      scopeId: row.scopeId,
      requestId: row.requestId,
      changeNumber: row.changeNumber,
      actor: {
        type: assertActorType(row.actorType),
        ...(row.actorId !== null ? { id: row.actorId } : {}),
      },
      source: row.sourceType,
      patch: validateJsonPatch(this.state.readJson(row.patchHash)),
      beforeHash: row.beforeHash.toString("hex"),
      afterHash: row.afterHash.toString("hex"),
      acceptedAt: new Date(row.acceptedAt).toISOString(),
    };
  }

  private assertSameSettingsChange(
    row: SettingsChangeRow,
    request: WorkflowSettingsChangeRequest,
    patchDigest: Buffer,
  ): void {
    if (
      !row.patchHash.equals(patchDigest) ||
      row.actorType !== request.actor.type ||
      row.actorId !== (request.actor.id ?? null) ||
      row.sourceType !== request.source
    ) {
      throw new Error(`Workflow settings request ID was reused with different content`);
    }
  }

  private followUpRowByRequest(runId: string, requestId: string): FollowUpRow | undefined {
    const row = this.state.connection
      .prepare(`${FOLLOW_UP_ROW_SELECT} WHERE f.run_id = ? AND f.request_id = ?`)
      .get(runId, requestId);
    return isFollowUpRow(row) ? row : undefined;
  }

  private followUpRow(followUpId: string): FollowUpRow | undefined {
    const row = this.state.connection
      .prepare(`${FOLLOW_UP_ROW_SELECT} WHERE f.follow_up_id = ?`)
      .get(followUpId);
    return isFollowUpRow(row) ? row : undefined;
  }

  private requireFollowUpRow(followUpId: string): FollowUpRow {
    const row = this.followUpRow(followUpId);
    if (row === undefined) throw new Error(`Workflow follow-up not found: ${followUpId}`);
    return row;
  }

  private followUpRecord(row: FollowUpRow): WorkflowFollowUpRecord {
    return {
      followUpId: row.followUpId,
      runId: row.runId,
      requestId: row.requestId,
      order: row.orderNumber,
      targetSessionId: row.targetSessionId,
      actor: {
        type: assertActorType(row.actorType),
        ...(row.actorId !== null ? { id: row.actorId } : {}),
      },
      source: row.sourceType,
      prompt: this.readText(row.promptHash),
      state: assertFollowUpState(row.status),
      ...(row.reasonHash !== null ? { reason: this.readText(row.reasonHash) } : {}),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private assertSameFollowUp(row: FollowUpRow, request: WorkflowQueueFollowUpRequest): void {
    const promptHash = createHash("sha256").update(request.prompt).digest();
    if (
      !row.promptHash.equals(promptHash) ||
      row.targetSessionId !== request.targetSessionId ||
      row.actorType !== request.actor.type ||
      row.actorId !== (request.actor.id ?? null) ||
      row.sourceType !== request.source
    ) {
      throw new Error("Workflow follow-up request ID was reused with different content");
    }
  }

  private assertFollowUpRemovalAuthority(
    row: FollowUpRow,
    actor: MutationActor,
    source: string,
  ): void {
    if (actor.type === "human") return;
    if (
      (actor.type === "session" || actor.type === "controller") &&
      row.actorType === actor.type &&
      row.actorId === (actor.id ?? null) &&
      row.sourceType === source
    ) {
      return;
    }
    throw new Error("Workflow follow-up can be removed only by its source or a verified human");
  }

  private nextFollowUpOrder(runId: string): number {
    const row = this.state.connection
      .prepare(
        `SELECT COALESCE(MAX(order_number), 0) + 1 AS nextOrder
         FROM workflow_follow_ups WHERE run_id = ?`,
      )
      .get(runId);
    if (!isNextOrderRow(row)) throw new Error("Could not allocate workflow follow-up order");
    return row.nextOrder;
  }

  private assertSettingsRouteCurrent(
    event: WorkflowTraceEventDraft,
    snapshot: WorkflowDefinitionSnapshot,
  ): void {
    if (event.type !== "node_finished" || event.nodeId === undefined) return;
    if (snapshot.nodes[event.nodeId]?.settingsRoute !== true) return;
    const scopeId = event.payload.settingsScopeId;
    const changeNumber = event.payload.settingsChangeNumber;
    if (typeof scopeId !== "string" || typeof changeNumber !== "number") {
      throw new Error(`Settings route ${event.nodeId} has no saved settings binding`);
    }
    const scope = this.requireSettingsScopeRow(scopeId);
    if (scope.revision !== changeNumber) {
      throw new StaleResourceError(
        `Settings route ${event.nodeId} used change ${changeNumber}, current change is ${scope.revision}`,
      );
    }
  }

  private transitionFollowUpsForRunState(
    state: WorkflowRunState,
    _event: WorkflowTraceEventDraft,
    now: number,
  ): void {
    if (state.status === "running" || state.status === "waiting" || state.status === "completed") {
      return;
    }
    const rows = this.state.connection
      .prepare(
        `${FOLLOW_UP_ROW_SELECT}
         WHERE f.run_id IN (
           WITH RECURSIVE ancestors(run_id, parent_run_id) AS (
             SELECT run_id, parent_run_id FROM runs WHERE run_id = ?
             UNION ALL
             SELECT parent.run_id, parent.parent_run_id
             FROM runs parent JOIN ancestors ON ancestors.parent_run_id = parent.run_id
           )
           SELECT run_id FROM ancestors
         ) AND f.status = 'queued'`,
      )
      .all(state.runId)
      .filter(isFollowUpRow);
    for (const row of rows) {
      const reason = state.error ?? `Workflow ended with status ${state.status}`;
      const reasonHash = this.state.putText(reason, now);
      const update = this.state.connection
        .prepare(
          `UPDATE workflow_follow_ups
           SET status = 'cancelled', reason_hash = ?, updated_at = ?
           WHERE follow_up_id = ? AND status = 'queued'`,
        )
        .run(reasonHash, now, row.followUpId);
      if (update.changes !== 1) continue;
      this.workflowMessages.cancelPendingForSource(row.followUpId, "followUp", now);
      this.bumpResource(row.resourceId, row.revision, now);
      insertGenericEvent(
        this.state,
        row.resourceId,
        row.revision + 1,
        "follow-up.cancelled",
        "system",
        null,
        this.state.putJson({ runId: state.runId, status: state.status, reason }, now),
        now,
      );
    }
  }

  private syncNodeAttempts(
    state: WorkflowRunState,
    snapshot: WorkflowDefinitionSnapshot,
    now: number,
  ): void {
    for (const step of state.steps.slice(state.carriedStepCount ?? 0)) {
      const promptEntryId = this.findAttemptPromptEntry(state.runId, step.attemptId);
      const promptHash =
        promptEntryId === undefined && step.prompt !== null
          ? this.state.putText(step.prompt, now)
          : null;
      const receipt = attemptReceipt(step);
      const receiptHash =
        Object.keys(receipt).length === 0 ? null : this.state.putJson(receipt, now);
      const outputHash = step.output === undefined ? null : this.state.putJson(step.output, now);
      const errorHash = step.error === undefined ? null : this.state.putText(step.error, now);
      const existing = this.state.connection
        .prepare("SELECT attempt_id AS attemptId FROM node_attempts WHERE attempt_id = ?")
        .get(step.attemptId);
      if (existing === undefined) {
        const attemptNumber = this.nextAttemptNumber(state.runId, step.nodeId);
        this.state.connection
          .prepare(
            `INSERT INTO node_attempts(
               attempt_id, run_id, node_id, attempt_number, node_type, status,
               prompt_hash, output_hash, receipt_hash, error_hash,
               settings_scope_id, settings_change_number, settings_hash,
               started_at, finished_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            receiptHash,
            errorHash,
            step.settingsScopeId ?? null,
            step.settingsChangeNumber ?? null,
            step.settingsHash === undefined ? null : Buffer.from(step.settingsHash, "hex"),
            Date.parse(step.startedAt),
            Date.parse(step.finishedAt),
            Date.parse(step.startedAt),
            now,
          );
      } else {
        this.state.connection
          .prepare(
            `UPDATE node_attempts
             SET status = ?, prompt_hash = ?, output_hash = ?, receipt_hash = ?, error_hash = ?,
                 settings_scope_id = ?, settings_change_number = ?,
                 settings_hash = ?, finished_at = ?, updated_at = ?
             WHERE attempt_id = ?`,
          )
          .run(
            outcomeStatus(step.outcome),
            promptHash,
            outputHash,
            receiptHash,
            errorHash,
            step.settingsScopeId ?? null,
            step.settingsChangeNumber ?? null,
            step.settingsHash === undefined ? null : Buffer.from(step.settingsHash, "hex"),
            Date.parse(step.finishedAt),
            now,
            step.attemptId,
          );
      }
      if (this.syncAttemptEntries(state.runId, step, promptEntryId)) {
        this.state.connection
          .prepare("UPDATE node_attempts SET output_hash = NULL WHERE attempt_id = ?")
          .run(step.attemptId);
      }
    }
    if (state.currentAttemptId !== undefined && state.currentNode !== undefined) {
      this.ensureAttempt(state, state.currentNode, state.currentAttemptId, now, snapshot);
      if (state.currentNodeDeadlineAt !== undefined) {
        const deadlineAt =
          state.currentNodeDeadlineAt === null ? null : Date.parse(state.currentNodeDeadlineAt);
        if (deadlineAt !== null && !Number.isFinite(deadlineAt)) {
          throw new Error("Workflow node deadline is invalid");
        }
        this.state.connection
          .prepare(
            `UPDATE node_attempts SET deadline_at = ?, updated_at = ?
             WHERE attempt_id = ? AND run_id = ?
               AND status IN ('pending', 'running', 'waiting', 'interrupted')`,
          )
          .run(deadlineAt, now, state.currentAttemptId, state.runId);
      }
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
      const attemptOutput = this.readAttemptOutput(step.attemptId);
      const carried = stepIndex < (state.carriedStepCount ?? 0);
      const outputOverrideHash =
        carried && canonicalJson(attemptOutput) !== canonicalJson(step.output)
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

  private syncAttemptEntries(
    runId: string,
    step: WorkflowStepRecord,
    promptEntryId: string | undefined,
  ): boolean {
    const links: Array<["prompt" | "response" | "first" | "last", string]> = [];
    if (promptEntryId !== undefined) links.push(["prompt", promptEntryId]);
    if (step.conversation !== undefined) {
      links.push(
        ["first", step.conversation.firstEntryId],
        ["last", step.conversation.lastEntryId],
      );
    }
    if (step.assistantMessage?.entryId !== undefined) {
      links.push(["response", step.assistantMessage.entryId]);
    }
    let responseLinked = false;
    for (const [role, entryId] of links) {
      const row = this.state.connection
        .prepare(
          `SELECT e.segment_id AS segmentId, e.entry_hash AS entryHash
           FROM session_entries e
           JOIN session_segments s ON s.segment_id = e.segment_id
           WHERE s.run_id = ? AND e.entry_id = ?
           ORDER BY e.recorded_at DESC LIMIT 1`,
        )
        .get(runId, entryId);
      if (!isSegmentIdentityRow(row)) continue;
      if (role === "response") {
        const output = assistantOutputFromEntry(
          this.state.readJson(row.entryHash),
          step.assistantMessage?.maxChars,
        );
        if (
          canonicalJson(output) !== canonicalJson(step.output) ||
          createHash("sha256").update(output).digest("hex") !== step.assistantMessage?.sha256
        ) {
          throw new Error(`Assistant response entry conflicts with attempt ${step.attemptId}`);
        }
      }
      this.state.connection
        .prepare(
          `INSERT INTO attempt_entries(attempt_id, role, segment_id, entry_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attempt_id, role) DO UPDATE SET
             segment_id = excluded.segment_id, entry_id = excluded.entry_id`,
        )
        .run(step.attemptId, role, row.segmentId, entryId);
      if (role === "response") responseLinked = true;
    }
    return responseLinked;
  }

  private findAttemptPromptEntry(runId: string, attemptId: string): string | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT e.entry_id AS entryId
         FROM session_entries e
         JOIN session_segments s ON s.segment_id = e.segment_id
         JOIN blobs b ON b.blob_hash = e.entry_hash
         WHERE s.run_id = ?
           AND json_extract(CAST(b.content AS TEXT), '$.customType') = 'pi-workflows-step'
           AND json_extract(CAST(b.content AS TEXT), '$.details.contract.attemptId') = ?
         ORDER BY e.recorded_at DESC LIMIT 1`,
      )
      .get(runId, attemptId);
    return isEntryIdentityRow(row) ? row.entryId : undefined;
  }

  private readAttemptOutput(attemptId: string): unknown {
    const row = this.state.connection
      .prepare(
        `SELECT a.output_hash AS outputHash, a.receipt_hash AS receiptHash,
                e.entry_hash AS responseEntryHash
         FROM node_attempts a
         LEFT JOIN attempt_entries l ON l.attempt_id = a.attempt_id AND l.role = 'response'
         LEFT JOIN session_entries e
           ON e.segment_id = l.segment_id AND e.entry_id = l.entry_id
         WHERE a.attempt_id = ?`,
      )
      .get(attemptId);
    if (!isAttemptValueRow(row)) {
      throw new Error(`Workflow node attempt is missing: ${attemptId}`);
    }
    if (row.outputHash !== null) return this.state.readJson(row.outputHash);
    if (row.responseEntryHash === null) return null;
    const receipt =
      row.receiptHash === null ? {} : this.readJsonAs<StoredAttemptReceipt>(row.receiptHash);
    return assistantOutputFromEntry(
      this.state.readJson(row.responseEntryHash),
      receipt.assistantMessage?.maxChars,
    );
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
        .prepare(
          `UPDATE node_attempts
           SET status = ?, settings_scope_id = ?, settings_change_number = ?,
               settings_hash = ?, updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(
          status,
          state.currentSettingsScopeId ?? null,
          state.currentSettingsChangeNumber ?? null,
          state.currentSettingsHash === undefined
            ? null
            : Buffer.from(state.currentSettingsHash, "hex"),
          now,
          attemptId,
        );
      return;
    }
    const definition =
      snapshot ?? this.readDefinition(this.requireRunRow(state.runId).definitionHash);
    const nodeType = definition.nodes[nodeId]?.nodeType ?? "agent";
    this.state.connection
      .prepare(
        `UPDATE node_attempts
         SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE run_id = ? AND status = 'interrupted'`,
      )
      .run(now, now, state.runId);
    this.state.connection
      .prepare(
        `INSERT INTO node_attempts(
           attempt_id, run_id, node_id, attempt_number, node_type, status,
           settings_scope_id, settings_change_number, settings_hash,
           started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        state.runId,
        nodeId,
        this.nextAttemptNumber(state.runId, nodeId),
        nodeType,
        status,
        state.currentSettingsScopeId ?? null,
        state.currentSettingsChangeNumber ?? null,
        state.currentSettingsHash === undefined
          ? null
          : Buffer.from(state.currentSettingsHash, "hex"),
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

  private insertRunSources(
    runId: string,
    root: { type: "builtin" | "file"; ref: string; revision: string },
    mounted: WorkflowMountedSource[],
  ): void {
    const insert = this.state.connection.prepare(
      `INSERT INTO run_sources(run_id, mount_path, source_type, source_ref, source_revision)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(runId, "", root.type, root.ref, root.revision);
    for (const item of mounted) {
      const source = sourceParts(item.source);
      insert.run(runId, item.mountPath.join("/"), source.type, source.ref, source.revision);
    }
  }

  private syncContinuationIdentity(state: WorkflowRunState): void {
    if (state.parentRunId === undefined || state.humanDecision === undefined) return;
    const createdAt = Date.parse(state.humanDecision.acceptedAt);
    this.state.connection
      .prepare(
        `INSERT INTO continuations(
           decision_id, parent_run_id, continuation_run_id, created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(decision_id) DO NOTHING`,
      )
      .run(state.humanDecision.decisionId, state.parentRunId, state.runId, createdAt);
    const row = this.state.connection
      .prepare(
        `SELECT parent_run_id AS parentRunId, continuation_run_id AS continuationRunId,
                created_at AS createdAt
         FROM continuations WHERE decision_id = ?`,
      )
      .get(state.humanDecision.decisionId);
    if (
      !isContinuationIdentityRow(row) ||
      row.parentRunId !== state.parentRunId ||
      row.continuationRunId !== state.runId ||
      row.createdAt !== createdAt
    ) {
      throw new Error("Immutable human decision continuation conflicts");
    }
  }

  private readRunRow(runId: string): RunRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT r.run_id AS runId, r.resource_id AS resourceId,
                d.definition_hash AS definitionHash, r.definition_digest AS definitionDigest,
                d.workflow_name AS workflowRef, r.parent_run_id AS parentRunId,
                r.title, r.status, r.paused, r.status_detail AS statusDetail,
                r.input_hash AS inputHash, r.final_output_hash AS finalOutputHash,
                r.error_hash AS errorHash,
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

  private materializeRunState(row: RunRow, snapshot: WorkflowDefinitionSnapshot): WorkflowRunState {
    const steps = this.readSteps(row.runId);
    return this.buildRunState(
      row,
      snapshot,
      steps,
      steps,
      this.readUpdates(row.runId).updates ?? [],
    );
  }

  private buildRunState(
    row: RunRow,
    snapshot: WorkflowDefinitionSnapshot,
    projectionSteps: WorkflowStepRecord[],
    visibleSteps: WorkflowStepRecord[],
    visibleUpdates: WorkflowUpdateRecord[],
  ): WorkflowRunState {
    const sources = this.readRunSources(row.runId, snapshot);
    const carriedStepCount = this.carriedStepCount(row.runId);
    const activeAttempt =
      row.status === "running" || row.status === "waiting"
        ? this.readActiveAttempt(row.runId)
        : undefined;
    const runningAttempt = row.status === "running" ? activeAttempt : undefined;
    const waitingNode =
      row.status === "waiting"
        ? (activeAttempt?.nodeId ?? projectionSteps.at(-1)?.nodeId)
        : undefined;
    const humanDecision = this.readHumanDecisionReceipt(row.runId);
    const outputs: Record<string, unknown> = {};
    const results: Record<string, WorkflowNodeResult> = {};
    for (const step of projectionSteps) {
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
      ...(carriedStepCount === 0 ? {} : { carriedStepCount }),
      ...(row.title === null ? {} : { runTitle: row.title }),
      ...(sources.root === undefined ? {} : { workflowSource: sources.root }),
      ...(sources.mounted.length === 0 ? {} : { workflowSources: sources.mounted }),
      ...(sources.mounted.length !== 0 || snapshot.composition?.mounts.length
        ? { definitionDigest: `sha256:${row.definitionDigest.toString("hex")}` }
        : {}),
      startedAt: new Date(row.createdAt).toISOString(),
      ...(row.finishedAt === null ? {} : { finishedAt: new Date(row.finishedAt).toISOString() }),
      updatedAt: new Date(row.updatedAt).toISOString(),
      status: row.status as WorkflowRunState["status"],
      input: this.state.readJson(row.inputHash),
      outputs,
      results,
      steps: visibleSteps,
      ...(visibleUpdates.length === 0 ? {} : { updates: visibleUpdates }),
      ...(runningAttempt === undefined ? {} : { currentNode: runningAttempt.nodeId }),
      ...(activeAttempt === undefined ? {} : { currentAttemptId: activeAttempt.attemptId }),
      ...(activeAttempt?.startedAt === null || activeAttempt === undefined
        ? {}
        : { currentNodeStartedAt: new Date(activeAttempt.startedAt).toISOString() }),
      ...(activeAttempt === undefined
        ? {}
        : {
            currentNodeDeadlineAt:
              activeAttempt.deadlineAt === null
                ? null
                : new Date(activeAttempt.deadlineAt).toISOString(),
          }),
      ...savedCurrentSettingsBinding(
        activeAttempt?.settingsScopeId ?? null,
        activeAttempt?.settingsChangeNumber ?? null,
        activeAttempt?.settingsHash ?? null,
      ),
      ...(row.statusDetail === null ? {} : { statusDetail: row.statusDetail }),
      ...(humanDecision === undefined ? {} : { humanDecision }),
      ...(row.paused === 0 ? {} : { paused: true }),
      ...(waitingNode === undefined ? {} : { waitingOn: waitingNode }),
      ...(row.finalOutputHash === null
        ? {}
        : { finalOutput: this.state.readJson(row.finalOutputHash) }),
      ...(row.errorHash === null ? {} : { error: this.readText(row.errorHash) }),
    };
  }

  private readSteps(runId: string): WorkflowStepRecord[] {
    const rows = this.state.connection
      .prepare(`${STEP_ROW_SELECT} WHERE s.run_id = ? ORDER BY s.step_index`)
      .all(runId)
      .filter(isStepRow);
    return this.mapStepRows(runId, rows, 0);
  }

  private readStepRange(runId: string, range: WorkflowRunViewRange): WorkflowStepRecord[] {
    const rows = this.state.connection
      .prepare(`${STEP_ROW_SELECT} WHERE s.run_id = ? ORDER BY s.step_index LIMIT ? OFFSET ?`)
      .all(runId, range.limit, range.start)
      .filter(isStepRow);
    return this.mapStepRows(runId, rows, range.start);
  }

  private readLatestSteps(runId: string, through?: number): WorkflowStepRecord[] {
    const throughClause = through === undefined ? "" : " AND s2.step_index <= ?";
    const params = through === undefined ? [runId, runId] : [runId, runId, through];
    const rows = this.state.connection
      .prepare(
        `${STEP_ROW_SELECT}
         WHERE s.run_id = ? AND s.step_index IN (
           SELECT max(s2.step_index) FROM run_steps s2
           JOIN node_attempts a2 ON a2.attempt_id = s2.attempt_id
           WHERE s2.run_id = ?${throughClause} GROUP BY a2.node_id
         ) ORDER BY s.step_index`,
      )
      .all(...params)
      .filter(isStepRow);
    return this.mapStepRows(runId, rows);
  }

  private readTakenTransitions(runId: string, through: number): string[] {
    const rows = this.state.connection
      .prepare(
        `WITH ordered AS (
           SELECT s.step_index, a.node_id AS nodeId,
                  lag(a.node_id) OVER (ORDER BY s.step_index) AS previousNodeId
           FROM run_steps s JOIN node_attempts a ON a.attempt_id = s.attempt_id
           WHERE s.run_id = ? AND s.step_index <= ?
         )
         SELECT DISTINCT previousNodeId, nodeId FROM ordered
         WHERE previousNodeId IS NOT NULL ORDER BY previousNodeId, nodeId`,
      )
      .all(runId, through);
    return rows.flatMap((row) =>
      isRecord(row) && typeof row.previousNodeId === "string" && typeof row.nodeId === "string"
        ? [`${row.previousNodeId}->${row.nodeId}`]
        : [],
    );
  }

  private mapStepRows(
    runId: string,
    rows: StepRow[],
    expectedStart?: number,
  ): WorkflowStepRecord[] {
    return rows.map((row, index) => {
      if (expectedStart !== undefined && row.stepIndex !== expectedStart + index)
        throw new Error(`Workflow run step sequence has a gap: ${runId}`);
      const receipt =
        row.receiptHash === null ? {} : this.readJsonAs<StoredAttemptReceipt>(row.receiptHash);
      const prompt =
        row.promptEntryHash !== null
          ? promptFromEntry(this.state.readJson(row.promptEntryHash))
          : row.promptHash === null
            ? null
            : this.readText(row.promptHash);
      const outputHash = row.outputOverrideHash ?? row.outputHash;
      const output =
        outputHash !== null
          ? this.state.readJson(outputHash)
          : row.responseEntryHash === null
            ? null
            : assistantOutputFromEntry(
                this.state.readJson(row.responseEntryHash),
                receipt.assistantMessage?.maxChars,
              );
      const error = row.errorHash === null ? undefined : this.readText(row.errorHash);
      const conversation =
        row.firstEntryId === null || row.lastEntryId === null
          ? undefined
          : { firstEntryId: row.firstEntryId, lastEntryId: row.lastEntryId };
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
        ...savedStepSettingsBinding(
          row.settingsScopeId,
          row.settingsChangeNumber,
          row.settingsHash,
        ),
        ...receipt,
        ...(conversation === undefined ? {} : { conversation }),
      };
    });
  }

  private readRunSources(
    runId: string,
    snapshot: WorkflowDefinitionSnapshot,
  ): { root?: WorkflowSource; mounted: WorkflowMountedSource[] } {
    const rows = this.state.connection
      .prepare(
        `SELECT mount_path AS mountPath, source_type AS sourceType,
                source_ref AS sourceRef, source_revision AS sourceRevision
         FROM run_sources WHERE run_id = ? ORDER BY mount_path`,
      )
      .all(runId)
      .filter(isRunSourceRow);
    const rootRow = rows.find((row) => row.mountPath === "");
    const root =
      rootRow === undefined ||
      (rootRow.sourceType === "file" && rootRow.sourceRef.startsWith("inline:"))
        ? undefined
        : workflowSourceFromRow(rootRow);
    const mountNames = new Map(
      (snapshot.composition?.mounts ?? []).map((mount) => [
        mount.mountPath.join("/"),
        mount.workflowName,
      ]),
    );
    const mounted = rows
      .filter((row) => row.mountPath !== "")
      .map((row) => ({
        mountPath: row.mountPath.split("/"),
        workflowName: mountNames.get(row.mountPath) ?? row.mountPath,
        source: workflowSourceFromRow(row),
      }));
    return { ...(root === undefined ? {} : { root }), mounted };
  }

  private carriedStepCount(runId: string): number {
    const row = this.state.connection
      .prepare(
        `SELECT count(*) AS count
         FROM run_steps s JOIN node_attempts a ON a.attempt_id = s.attempt_id
         WHERE s.run_id = ? AND a.run_id <> s.run_id`,
      )
      .get(runId);
    return isCountRow(row) ? row.count : 0;
  }

  private readActiveAttempt(runId: string):
    | {
        attemptId: string;
        nodeId: string;
        startedAt: number | null;
        deadlineAt: number | null;
        settingsScopeId: string | null;
        settingsChangeNumber: number | null;
        settingsHash: Buffer | null;
      }
    | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT attempt_id AS attemptId, node_id AS nodeId, started_at AS startedAt,
                deadline_at AS deadlineAt, settings_scope_id AS settingsScopeId,
                settings_change_number AS settingsChangeNumber,
                settings_hash AS settingsHash
         FROM node_attempts
         WHERE run_id = ? AND status IN ('pending', 'running', 'waiting', 'interrupted')`,
      )
      .get(runId);
    return isActiveAttemptRow(row) ? row : undefined;
  }

  private readHumanDecisionReceipt(runId: string): HumanDecisionReceipt | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT d.request_hash AS requestHash, r.response_hash AS responseHash
         FROM continuations c
         JOIN human_decisions d ON d.decision_id = c.decision_id
         JOIN human_decision_resolutions r ON r.decision_id = c.decision_id
         WHERE c.continuation_run_id = ? AND r.outcome = 'accepted'`,
      )
      .get(runId);
    if (!isDecisionReceiptRow(row)) return undefined;
    const request = this.readJsonAs<Record<string, unknown>>(row.requestHash);
    const decision = this.readJsonAs<Record<string, unknown>>(row.responseHash);
    if (
      typeof request.decisionId !== "string" ||
      typeof request.requestDigest !== "string" ||
      typeof request.nodeId !== "string" ||
      typeof decision.provenance !== "string" ||
      typeof decision.acceptedAt !== "string" ||
      typeof decision.answerDigest !== "string" ||
      typeof decision.subjectDigest !== "string" ||
      typeof decision.presentationDigest !== "string" ||
      typeof decision.revision !== "number" ||
      decision.response === undefined
    ) {
      throw new Error(`Human decision receipt is invalid for run ${runId}`);
    }
    return {
      schema: "pi-workflows.human-decision-receipt.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      nodeId: request.nodeId,
      response: decision.response as HumanDecisionReceipt["response"],
      provenance: decision.provenance === "timeout" ? "timeout" : "human",
      acceptedAt: decision.acceptedAt,
      answerDigest: decision.answerDigest,
      subjectDigest: decision.subjectDigest,
      presentationDigest: decision.presentationDigest,
      revision: decision.revision,
    };
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

  private readCurrentUpdates(runId: string, range?: WorkflowRunViewRange): WorkflowUpdateRecord[] {
    const rangeClause = range === undefined ? "" : " LIMIT ? OFFSET ?";
    const params = range === undefined ? [runId] : [runId, range.limit, range.start];
    const rows = this.state.connection
      .prepare(
        `WITH ranked AS (
           SELECT u.update_id AS updateId, u.run_revision AS runRevision,
                  a.node_id AS nodeId, u.attempt_id AS attemptId,
                  u.update_type AS updateType, u.update_key AS updateKey,
                  u.data_hash AS dataHash, u.recorded_at AS recordedAt,
                  row_number() OVER (
                    PARTITION BY u.update_type, u.update_key ORDER BY u.run_revision DESC
                  ) AS rank
           FROM workflow_updates u
           JOIN node_attempts a ON a.attempt_id = u.attempt_id
           WHERE a.run_id = ?
         )
         SELECT updateId, runRevision, nodeId, attemptId, updateType, updateKey, dataHash, recordedAt
         FROM ranked WHERE rank = 1 ORDER BY runRevision${rangeClause}`,
      )
      .all(...params)
      .filter(isUpdateRow);
    return rows.map((row) => ({
      updateId: row.updateId,
      seq: row.runRevision,
      at: new Date(row.recordedAt).toISOString(),
      runId,
      nodeId: row.nodeId,
      attemptId: row.attemptId,
      type: row.updateType,
      key: row.updateKey,
      data: this.readJsonAs<Record<string, unknown>>(row.dataHash),
    }));
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

  private traceEvents(run: RunRow, range?: WorkflowRunViewRange): WorkflowTraceEvent[] {
    const rangeClause = range === undefined ? "" : " LIMIT ? OFFSET ?";
    const params =
      range === undefined ? [run.resourceId] : [run.resourceId, range.limit, range.start];
    const rows = this.state.connection
      .prepare(
        `SELECT resource_revision AS resourceRevision, event_type AS eventType,
                payload_hash AS payloadHash, recorded_at AS recordedAt
         FROM events WHERE resource_id = ? ORDER BY resource_revision${rangeClause}`,
      )
      .all(...params);
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

  private loadSegment(
    segment: SegmentRow,
    runState: WorkflowRunState,
    ranges?: { entries: WorkflowRunViewRange; events: WorkflowRunViewRange },
  ): SessionCaptureSegment {
    const binding =
      segment.bindingHash === null
        ? null
        : (this.state.readJson(segment.bindingHash) as WorkflowSessionBinding);
    const entries = this.state.connection
      .prepare(
        `SELECT entry_seq AS entrySeq, entry_hash AS entryHash, recorded_at AS recordedAt
         FROM session_entries WHERE segment_id = ? ORDER BY entry_seq${
           ranges === undefined ? "" : " LIMIT ? OFFSET ?"
         }`,
      )
      .all(
        ...(ranges === undefined
          ? [segment.segmentId]
          : [segment.segmentId, ranges.entries.limit, ranges.entries.start]),
      )
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
         FROM session_events WHERE segment_id = ? ORDER BY event_seq${
           ranges === undefined ? "" : " LIMIT ? OFFSET ?"
         }`,
      )
      .all(
        ...(ranges === undefined
          ? [segment.segmentId]
          : [segment.segmentId, ranges.events.limit, ranges.events.start]),
      )
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
    const durableCounts =
      ranges === undefined
        ? { entries: entries.length, events: events.length }
        : {
            entries: sessionRecordCount(this.state, "session_entries", segment.segmentId),
            events: sessionRecordCount(this.state, "session_events", segment.segmentId),
          };
    if (
      durableCounts.entries !== segment.entryCount ||
      durableCounts.events !== segment.eventCount
    ) {
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
        const viewerCapture = this.viewerSessionCapture(runId);
        recordViewerDeltas(
          this.state,
          runId,
          [
            {
              targetType: "conversation",
              targetKey: "capture",
              patch: [
                {
                  op: "add",
                  path: "/capture",
                  value: parseJson(canonicalJson(viewerCapture)),
                },
              ],
            },
          ],
          now,
        );
      });
    }
  }
}

function runViewerTargets(
  state: WorkflowRunState,
  traceEvent: WorkflowTraceEvent,
): ViewerDeltaDraft[] {
  const stepTotal = state.steps.length;
  const stepStart = Math.max(0, stepTotal - VIEWER_PAGE_SIZE);
  const updateTotal = state.updates?.length ?? 0;
  const updateStart = Math.max(0, updateTotal - VIEWER_PAGE_SIZE);
  const compactStep = (step: WorkflowStepRecord) => ({
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
  const latestStepByNode = new Map<string, WorkflowStepRecord>();
  for (const step of state.steps) latestStepByNode.set(step.nodeId, step);
  const graphSteps = state.steps
    .filter((step) => latestStepByNode.get(step.nodeId) === step)
    .map(compactStep);
  const transitions = new Set<string>();
  for (let index = 1; index < state.steps.length; index += 1) {
    const previous = state.steps[index - 1];
    const current = state.steps[index];
    if (previous !== undefined && current !== undefined) {
      transitions.add(`${previous.nodeId}->${current.nodeId}`);
    }
  }
  const graphPatch: NonNullable<ViewerDeltaDraft["patch"]> = [
    { op: "replace", path: "/state/traceSeq", value: state.traceSeq },
    { op: "replace", path: "/state/updatedAt", value: state.updatedAt },
    { op: "replace", path: "/state/status", value: state.status },
    {
      op: "add",
      path: "/state/updates",
      value: parseJson(canonicalJson(state.updates?.slice(updateStart) ?? [])),
    },
    { op: "add", path: "/state/finishedAt", value: state.finishedAt ?? null },
    { op: "add", path: "/state/currentNode", value: state.currentNode ?? null },
    { op: "add", path: "/state/currentAttemptId", value: state.currentAttemptId ?? null },
    {
      op: "add",
      path: "/state/currentNodeStartedAt",
      value: state.currentNodeStartedAt ?? null,
    },
    {
      op: "add",
      path: "/state/currentNodeDeadlineAt",
      value: state.currentNodeDeadlineAt ?? null,
    },
    {
      op: "add",
      path: "/state/currentSettingsScopeId",
      value: state.currentSettingsScopeId ?? null,
    },
    {
      op: "add",
      path: "/state/currentSettingsChangeNumber",
      value: state.currentSettingsChangeNumber ?? null,
    },
    {
      op: "add",
      path: "/state/currentSettingsHash",
      value: state.currentSettingsHash ?? null,
    },
    { op: "add", path: "/state/statusDetail", value: state.statusDetail ?? null },
    { op: "add", path: "/state/paused", value: state.paused ?? false },
    { op: "add", path: "/state/waitingOn", value: state.waitingOn ?? null },
    {
      op: "add",
      path: "/state/humanDecision",
      value: parseJson(canonicalJson(state.humanDecision ?? null)),
    },
    {
      op: "replace",
      path: "/graphSteps",
      value: parseJson(canonicalJson(graphSteps)),
    },
    {
      op: "replace",
      path: "/takenTransitions",
      value: [...transitions].sort(),
    },
    { op: "replace", path: "/graphCursor", value: Math.max(0, stepTotal - 1) },
    { op: "replace", path: "/stepStart", value: stepStart },
    { op: "replace", path: "/stepTotal", value: stepTotal },
    { op: "replace", path: "/updateStart", value: updateStart },
    { op: "replace", path: "/updateTotal", value: updateTotal },
    { op: "replace", path: "/manifest/status", value: state.status },
    { op: "add", path: "/manifest/finishedAt", value: state.finishedAt ?? null },
    {
      op: "replace",
      path: "/live",
      value: state.status === "running" || state.status === "waiting",
    },
  ];
  const targets: ViewerDeltaDraft[] = [
    { targetType: "graph", patch: graphPatch },
    {
      targetType: "timeline",
      targetKey: "trace:tail",
      patch: viewerTailPatch(traceEvent.seq - 1, [
        parseJson(
          canonicalJson({
            ...traceEvent,
            payload: compactTracePayload(traceEvent.type, traceEvent.payload),
          }),
        ),
      ]),
    },
  ];
  if (traceEvent.type === "node_finished" || traceEvent.type === "node_failed") {
    targets.push({
      targetType: "replay",
      targetKey: "steps:reload",
      patch: [{ op: "replace", path: "/stepTotal", value: stepTotal }],
    });
  }
  return targets;
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
  if (eventType === "agent_prompt_sent" && Object.hasOwn(payload, "prompt")) {
    const { prompt: _prompt, ...rest } = payload;
    return { ...rest, promptStored: true };
  }
  if (eventType === "node_finished" || eventType === "node_failed") {
    const {
      output: _output,
      action: _action,
      assistantMessage: _assistantMessage,
      conversation: _conversation,
      error: _error,
      ...rest
    } = payload;
    return { ...rest, ...(Object.hasOwn(payload, "output") ? { outputStored: true } : {}) };
  }
  if (eventType === "include_exited" && Object.hasOwn(payload, "output")) {
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

function sourceParts(source: WorkflowSource): {
  type: "builtin" | "file";
  ref: string;
  revision: string;
} {
  return source.kind === "builtin"
    ? { type: "builtin", ref: source.id, revision: source.revision }
    : { type: "file", ref: source.path, revision: source.hash };
}

function workflowSourceFromRow(row: RunSourceRow): WorkflowSource {
  return row.sourceType === "builtin"
    ? { kind: "builtin", id: row.sourceRef, revision: row.sourceRevision }
    : { kind: "file", path: row.sourceRef, hash: row.sourceRevision };
}

function sessionRecordCount(
  state: StateDatabase,
  table: "session_entries" | "session_events",
  segmentId: string,
): number {
  const row = state.connection
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE segment_id = ?`)
    .get(segmentId);
  return isCountRow(row) ? row.count : 0;
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

function attemptReceipt(step: WorkflowStepRecord): StoredAttemptReceipt {
  return {
    ...(step.action === undefined ? {} : { action: step.action }),
    ...(step.assistantMessage === undefined ? {} : { assistantMessage: step.assistantMessage }),
  };
}

function promptFromEntry(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const content = value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length !== 0)
    .join("\n");
}

function assistantOutputFromEntry(value: unknown, maxChars?: number): string {
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error("Assistant response entry is invalid");
  }
  const message = value.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    throw new Error("Assistant response entry does not contain an assistant message");
  }
  const text = message.content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  if (text.trim().length === 0) throw new Error("Assistant response entry has no visible text");
  if (maxChars !== undefined && text.length > maxChars) {
    throw new Error(`Assistant response exceeds its stored limit of ${maxChars} characters`);
  }
  return text;
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

function assertSessionEventType(value: string): WorkflowSessionEventType {
  switch (value) {
    case "turn_started":
    case "turn_finished":
    case "message_started":
    case "assistant_event":
    case "message_finished":
    case "tool_execution_started":
    case "tool_execution_finished":
      return value;
    default:
      throw new Error(`Unknown session event type: ${value}`);
  }
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

function followUpIdFor(runId: string, requestId: string): string {
  const digest = createHash("sha256").update(`${runId}\0${requestId}`).digest("hex").slice(0, 40);
  return `follow-up-${digest}`;
}

function assertRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(requestId)) {
    throw new Error("Workflow request ID must be a stable identifier of at most 512 characters");
  }
}

function assertSourceType(source: string): void {
  if (typeof source !== "string" || source.trim().length === 0 || source.length > 128) {
    throw new Error("Workflow change source must be a non-empty string of at most 128 characters");
  }
}

function assertActorType(value: string): ActorType {
  if (
    value !== "session" &&
    value !== "host" &&
    value !== "controller" &&
    value !== "channel" &&
    value !== "human" &&
    value !== "policy" &&
    value !== "control" &&
    value !== "system"
  ) {
    throw new Error(`Unknown saved actor type: ${value}`);
  }
  return value;
}

function assertFollowUpState(value: string): WorkflowFollowUpState {
  if (value !== "queued" && value !== "removed" && value !== "cancelled") {
    throw new Error(`Unknown workflow follow-up state: ${value}`);
  }
  return value;
}

function isSettingsScopeRow(value: unknown): value is SettingsScopeRow {
  return (
    isRecord(value) &&
    typeof value.scopeId === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.originRunId === "string" &&
    typeof value.activeRunId === "string" &&
    typeof value.mountPath === "string" &&
    typeof value.invocation === "number" &&
    Buffer.isBuffer(value.currentHash) &&
    typeof value.revision === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isSettingsProjectionRow(value: unknown): value is SettingsProjectionRow {
  return (
    isRecord(value) &&
    typeof value.scopeId === "string" &&
    Buffer.isBuffer(value.initialHash) &&
    Buffer.isBuffer(value.currentHash) &&
    typeof value.revision === "number"
  );
}

function isSettingsProjectionChangeRow(value: unknown): value is SettingsProjectionChangeRow {
  return (
    isRecord(value) &&
    typeof value.changeNumber === "number" &&
    Buffer.isBuffer(value.patchHash) &&
    Buffer.isBuffer(value.beforeHash) &&
    Buffer.isBuffer(value.afterHash)
  );
}

function isSettingsChangeRow(value: unknown): value is SettingsChangeRow {
  return (
    isRecord(value) &&
    typeof value.changeId === "string" &&
    typeof value.scopeId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.changeNumber === "number" &&
    typeof value.actorType === "string" &&
    (typeof value.actorId === "string" || value.actorId === null) &&
    typeof value.sourceType === "string" &&
    Buffer.isBuffer(value.patchHash) &&
    Buffer.isBuffer(value.beforeHash) &&
    Buffer.isBuffer(value.afterHash) &&
    typeof value.acceptedAt === "number"
  );
}

function isFollowUpRow(value: unknown): value is FollowUpRow {
  return (
    isRecord(value) &&
    typeof value.followUpId === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.orderNumber === "number" &&
    typeof value.targetSessionId === "string" &&
    typeof value.actorType === "string" &&
    (typeof value.actorId === "string" || value.actorId === null) &&
    typeof value.sourceType === "string" &&
    Buffer.isBuffer(value.promptHash) &&
    typeof value.status === "string" &&
    (Buffer.isBuffer(value.reasonHash) || value.reasonHash === null) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.revision === "number"
  );
}

function isParentRunRow(value: unknown): value is { parentRunId: string | null } {
  return isRecord(value) && (typeof value.parentRunId === "string" || value.parentRunId === null);
}

function isRunLineageRow(value: unknown): value is { rootRunId: string; restartNumber: number } {
  return (
    isRecord(value) &&
    typeof value.rootRunId === "string" &&
    typeof value.restartNumber === "number"
  );
}

function isStatusRow(value: unknown): value is { status: string } {
  return isRecord(value) && typeof value.status === "string";
}

function isCountRow(value: unknown): value is { count: number } {
  return isRecord(value) && typeof value.count === "number";
}

function isStepIndexRow(value: unknown): value is { stepIndex: number } {
  return isRecord(value) && typeof value.stepIndex === "number";
}

function isNextOrderRow(value: unknown): value is { nextOrder: number } {
  return isRecord(value) && typeof value.nextOrder === "number";
}

function isViewerSessionCheckpointRow(value: unknown): value is ViewerSessionCheckpointRow {
  return isRecord(value) && typeof value.eventSeq === "number" && Buffer.isBuffer(value.stateHash);
}

function isViewerSessionEventRow(value: unknown): value is ViewerSessionEventRow {
  return (
    isRecord(value) &&
    typeof value.runSeq === "number" &&
    typeof value.eventType === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.attemptId === "string" &&
    (typeof value.turnId === "string" || value.turnId === null) &&
    (typeof value.messageId === "string" || value.messageId === null) &&
    (typeof value.toolCallId === "string" || value.toolCallId === null) &&
    Buffer.isBuffer(value.payloadHash) &&
    typeof value.recordedAt === "number"
  );
}

function isTemporalSessionState(value: unknown): value is TemporalSessionState {
  return (
    isRecord(value) &&
    typeof value.throughSeq === "number" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.tools) &&
    Array.isArray(value.settledEntryIds) &&
    value.settledEntryIds.every((item) => typeof item === "string") &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((item) => typeof item === "string")
  );
}

function boundedTemporalCheckpoint(state: TemporalSessionState): TemporalSessionState {
  const messages = state.messages.filter((message) => message.status === "streaming");
  const activeMessages = new Set(messages.map((message) => message.messageId));
  return {
    ...state,
    messages,
    tools: state.tools.filter(
      (tool) => tool.status === "running" && activeMessages.has(tool.messageId),
    ),
    settledEntryIds: [],
    diagnostics: ["earlier session messages are outside this page"],
  };
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

function savedCurrentSettingsBinding(
  scopeId: string | null,
  changeNumber: number | null,
  settingsHash: Buffer | null,
): Pick<
  WorkflowRunState,
  "currentSettingsScopeId" | "currentSettingsChangeNumber" | "currentSettingsHash"
> {
  if (scopeId === null && changeNumber === null && settingsHash === null) return {};
  if (scopeId === null || changeNumber === null || settingsHash === null) {
    throw new Error("Saved current workflow settings binding is incomplete");
  }
  return {
    currentSettingsScopeId: scopeId,
    currentSettingsChangeNumber: changeNumber,
    currentSettingsHash: settingsHash.toString("hex"),
  };
}

function savedStepSettingsBinding(
  scopeId: string | null,
  changeNumber: number | null,
  settingsHash: Buffer | null,
): Pick<WorkflowStepRecord, "settingsScopeId" | "settingsChangeNumber" | "settingsHash"> {
  if (scopeId === null && changeNumber === null && settingsHash === null) return {};
  if (scopeId === null || changeNumber === null || settingsHash === null) {
    throw new Error("Saved workflow step settings binding is incomplete");
  }
  return {
    settingsScopeId: scopeId,
    settingsChangeNumber: changeNumber,
    settingsHash: settingsHash.toString("hex"),
  };
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

function isStepRow(value: unknown): value is StepRow {
  return isRecord(value);
}

function isRunSourceRow(value: unknown): value is RunSourceRow {
  return isRecord(value);
}

function isSegmentIdentityRow(value: unknown): value is { segmentId: string; entryHash: Buffer } {
  return isRecord(value) && typeof value.segmentId === "string" && Buffer.isBuffer(value.entryHash);
}

function isEntryIdentityRow(value: unknown): value is { entryId: string } {
  return isRecord(value) && typeof value.entryId === "string";
}

function isAttemptValueRow(value: unknown): value is {
  outputHash: Buffer | null;
  receiptHash: Buffer | null;
  responseEntryHash: Buffer | null;
} {
  return isRecord(value);
}

function isActiveAttemptRow(value: unknown): value is {
  attemptId: string;
  nodeId: string;
  startedAt: number | null;
  deadlineAt: number | null;
  settingsScopeId: string | null;
  settingsChangeNumber: number | null;
  settingsHash: Buffer | null;
} {
  return isRecord(value);
}

function isDecisionReceiptRow(value: unknown): value is {
  requestHash: Buffer;
  responseHash: Buffer;
} {
  return (
    isRecord(value) && Buffer.isBuffer(value.requestHash) && Buffer.isBuffer(value.responseHash)
  );
}

function isContinuationIdentityRow(value: unknown): value is {
  parentRunId: string;
  continuationRunId: string;
  createdAt: number;
} {
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

type ApplyingEffectRow = {
  effectId: string;
  resourceId: string;
  payloadHash: Buffer;
  attemptCount: number;
};

type WorkflowEffectRow = {
  status: "pending" | "applying" | "applied" | "rejected" | "ambiguous" | "cancelled";
  payloadHash: Buffer;
  resultHash: Buffer | null;
  attemptCount: number;
};

function isApplyingEffectRow(value: unknown): value is ApplyingEffectRow {
  return (
    isRecord(value) &&
    typeof value.effectId === "string" &&
    typeof value.resourceId === "string" &&
    Buffer.isBuffer(value.payloadHash) &&
    typeof value.attemptCount === "number"
  );
}

function effectRecoveryFromPayload(value: JsonValue): WorkflowEffectRecovery {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.recovery === "idempotent"
    ? "idempotent"
    : "manual";
}

function isWorkflowEffectRow(value: unknown): value is WorkflowEffectRow {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    Buffer.isBuffer(value.payloadHash) &&
    (value.resultHash === null || Buffer.isBuffer(value.resultHash)) &&
    typeof value.attemptCount === "number"
  );
}

function isWorkflowEffectIdentityRow(
  value: unknown,
): value is { resourceId: string; status: string } {
  return (
    isRecord(value) && typeof value.resourceId === "string" && typeof value.status === "string"
  );
}

function isResourceIdRow(value: unknown): value is { resourceId: string } {
  return isRecord(value) && typeof value.resourceId === "string";
}

function workflowEffectId(
  sourceResourceId: string,
  effectType: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${sourceResourceId}\0${effectType}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 40);
  return `effect-${digest}`;
}

function requireBoundedEffectText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Managed effect ${label} must be nonempty text of at most 256 characters`);
  }
}

export function createDefinitionSnapshot(workflow: WorkflowDefinition): WorkflowDefinitionSnapshot {
  const metadata = compositionMetadata(workflow);
  const composition = metadata?.snapshot;
  const settingsScopes = Object.values(metadata?.scopes ?? {})
    .filter((scope) => scope.path !== "" && scope.settings !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((scope) => ({
      mountPath: scope.path.split("/"),
      settings: snapshotSettings(scope.settings!),
    }));
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
    ...(workflow.settings !== undefined ? { settings: snapshotSettings(workflow.settings) } : {}),
    ...(settingsScopes.length > 0 ? { settingsScopes } : {}),
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
  if (node.nodeType === "compute" && node.settingsRoute === true) {
    common.settingsRoute = true;
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
  if (node.nodeType === "action") {
    common.actionExecution = "exec" in node ? "shell" : "function";
    /* istanbul ignore else -- validated action nodes always declare a managed effect */
    if (node.effect !== undefined) {
      common.effect = { type: node.effect.type, recovery: node.effect.recovery };
    }
  }
  return common;
}

function snapshotSettings(
  settings: NonNullable<WorkflowDefinition["settings"]>,
): WorkflowSettingsSnapshot {
  return {
    ...(settings.description !== undefined ? { description: settings.description } : {}),
    paths: settings.paths.map((rule) => ({
      path: rule.path,
      permissions: Object.fromEntries(
        Object.entries(rule.permissions).map(([permission, actors]) => [
          permission,
          actors === undefined ? [] : [...actors],
        ]),
      ),
    })),
  };
}
