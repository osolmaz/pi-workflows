import { createHash, randomUUID } from "node:crypto";
import { StateDatabase, workflowStatePath } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  StateMutationStore,
  StaleResourceError,
  resourceIdFor,
  tokenHash,
  type ActorType,
  type LeaseClaim,
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
import { compositionMetadata } from "./composition.js";
import { applyJsonPatch, validateJsonPatch } from "./json-patch.js";
import {
  boundedTemporalCheckpoint,
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
  type WorkflowPresentationState,
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
  HumanDecisionReceipt,
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

export const RUN_STATE_SCHEMA = "pi-workflows.run-state.v1" as const;
export const DEFINITION_SNAPSHOT_SCHEMA = "pi-workflows.definition-snapshot.v1" as const;
export const SESSION_BINDING_SCHEMA = "pi-workflows.session-binding.v1" as const;
export const SESSION_EVENT_SCHEMA = "pi-workflows.session-event.v1" as const;
export const SESSION_CAPTURE_SCHEMA = "pi-workflows.session-capture.v1" as const;
export const SESSION_EVENT_MAX_BYTES = 1024 * 1024;

const FOLLOW_UP_ROW_SELECT = `
  SELECT f.follow_up_id AS followUpId, f.resource_id AS resourceId,
         f.queue_resource_id AS queueResourceId, f.run_id AS runId,
         f.request_id AS requestId, f.order_number AS orderNumber,
         f.target_session_id AS targetSessionId, f.actor_type AS actorType,
         f.actor_id AS actorId, f.source_type AS sourceType,
         f.prompt_hash AS promptHash, f.status,
         f.session_entry_id AS sessionEntryId, f.reason_hash AS reasonHash,
         f.created_at AS createdAt, f.updated_at AS updatedAt, f.sent_at AS sentAt,
         r.revision
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

type FollowUpQueueRow = {
  runId: string;
  resourceId: string;
  originSessionId: string | null;
  presentationState: string;
  presentationEntryId: string | null;
  presentationAssistantEntryId: string | null;
  presentationReasonHash: Buffer | null;
  revision: number;
};

type FollowUpRow = {
  followUpId: string;
  resourceId: string;
  queueResourceId: string;
  runId: string;
  requestId: string;
  orderNumber: number;
  targetSessionId: string;
  actorType: string;
  actorId: string | null;
  sourceType: string;
  promptHash: Buffer;
  status: string;
  sessionEntryId: string | null;
  reasonHash: Buffer | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
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
  private readonly contexts = new Map<string, RunContext>();
  private readonly ownsState: boolean;
  private readonly mutations: StateMutationStore;

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
    this.mutations = new StateMutationStore(this.state);
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  async initializeRun(
    workflow: WorkflowDefinition,
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
          const traceEvent: WorkflowTraceEvent = {
            seq: revision,
            at,
            runId: state.runId,
            scope: "run",
            type: "run_initialized",
            payload: { workflowName: workflow.name },
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
        const launchOptionsHash = this.state.putJson({}, now);
        const finalOutputHash =
          state.finalOutput === undefined ? null : this.state.putJson(state.finalOutput, now);
        const errorHash = state.error === undefined ? null : this.state.putText(state.error, now);
        this.state.connection
          .prepare(
            `INSERT INTO runs(
               run_id, resource_id, project_id, parent_run_id, definition_digest,
               workflow_ref, launch_options_hash, title, status, paused,
               status_detail, input_hash, final_output_hash, error_hash,
               created_at, updated_at, finished_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            state.runId,
            resourceId,
            state.parentRunId ?? null,
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
          payload: { workflowName: workflow.name },
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
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const prior = this.followUpRowByRequest(request.runId, request.requestId);
      if (prior !== undefined) {
        this.assertSameFollowUp(prior, request);
        return { followUp: this.followUpRecord(prior), adopted: true };
      }
      this.requireRunAcceptsSettings(request.runId, true);
      const queue = this.requireFollowUpQueueRow(request.runId);
      try {
        const result = this.mutations.mutate(
          {
            resourceId: queue.resourceId,
            operation: "follow-up.queue",
            actor: request.actor,
            expectedRevision: queue.revision,
          },
          "follow-up.queued",
          ({ database, now }) => {
            this.requireRunAcceptsSettings(request.runId, true);
            const currentQueue = this.requireFollowUpQueueRow(request.runId);
            if (
              currentQueue.originSessionId !== null &&
              currentQueue.originSessionId !== request.targetSessionId
            ) {
              throw new Error("Workflow follow-ups must target the run's origin Pi session");
            }
            if (currentQueue.originSessionId === null) {
              database.connection
                .prepare(
                  `UPDATE workflow_follow_up_queues
                   SET origin_session_id = ?, updated_at = ? WHERE run_id = ?`,
                )
                .run(request.targetSessionId, now, request.runId);
            }
            const order = this.nextFollowUpOrder(request.runId);
            const followUpId = followUpIdFor(request.runId, request.requestId);
            const resourceId = this.mutations.ensureResource("follow_up", followUpId, now);
            const promptHash = database.putText(request.prompt, now);
            database.connection
              .prepare(
                `INSERT INTO workflow_follow_ups(
                   follow_up_id, resource_id, queue_resource_id, run_id,
                   request_id, order_number, target_session_id,
                   actor_type, actor_id, source_type, prompt_hash, status,
                   created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
              )
              .run(
                followUpId,
                resourceId,
                queue.resourceId,
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
            recordViewerDeltas(
              this.state,
              request.runId,
              this.viewerInspectorTargets(request.runId),
              now,
            );
            return followUpId;
          },
          { payload: { runId: request.runId, requestId: request.requestId } },
        );
        return {
          followUp: this.followUpRecord(this.requireFollowUpRow(result.value)),
          adopted: false,
        };
      } catch (error) {
        if (!(error instanceof StaleResourceError)) throw error;
      }
    }
    throw new StaleResourceError("Workflow follow-up queue kept changing; retry the request");
  }

  removeFollowUp(request: WorkflowRemoveFollowUpRequest): WorkflowFollowUpRecord {
    assertSourceType(request.source);
    const row = this.requireFollowUpRow(request.followUpId);
    if (row.runId !== request.runId) {
      throw new Error(`Workflow follow-up is not part of run ${request.runId}`);
    }
    if (row.status === "removed") return this.followUpRecord(row);
    if (row.status === "sent" || row.status === "cancelled") {
      throw new Error(`Workflow follow-up cannot be removed after it is ${row.status}`);
    }
    this.assertFollowUpRemovalAuthority(row, request.actor, request.source);
    if (this.hasLiveLease(row.resourceId)) {
      throw new Error("Workflow follow-up is being delivered and cannot be removed");
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
             WHERE follow_up_id = ? AND status IN ('queued', 'pending_presentation', 'ready')`,
          )
          .run(reasonHash, now, request.followUpId);
        if (update.changes !== 1) {
          throw new StaleResourceError("Workflow follow-up changed before removal");
        }
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
        `SELECT COALESCE(q.origin_session_id, b.origin_session_id) AS originSessionId
         FROM runs r
         LEFT JOIN workflow_follow_up_queues q ON q.run_id = r.run_id
         LEFT JOIN run_bindings b ON b.run_id = r.run_id
         WHERE r.run_id = ?`,
      )
      .get(runId);
    return isRecord(row) && typeof row.originSessionId === "string"
      ? row.originSessionId
      : undefined;
  }

  readFollowUpQueue(runId: string): WorkflowFollowUpQueueRecord | undefined {
    const queue = this.followUpQueueRow(runId);
    if (queue === undefined) return undefined;
    const followUps = this.state.connection
      .prepare(`${FOLLOW_UP_ROW_SELECT} WHERE f.run_id = ? ORDER BY f.order_number`)
      .all(runId)
      .filter(isFollowUpRow)
      .map((row) => this.followUpRecord(row));
    return {
      runId,
      ...(queue.originSessionId !== null ? { originSessionId: queue.originSessionId } : {}),
      presentationState: assertPresentationState(queue.presentationState),
      ...(queue.presentationEntryId !== null
        ? { presentationEntryId: queue.presentationEntryId }
        : {}),
      ...(queue.presentationAssistantEntryId !== null
        ? { presentationAssistantEntryId: queue.presentationAssistantEntryId }
        : {}),
      ...(queue.presentationReasonHash !== null
        ? { presentationReason: this.readText(queue.presentationReasonHash) }
        : {}),
      followUps,
    };
  }

  listPendingPresentations(targetSessionId: string): string[] {
    return this.state.connection
      .prepare(
        `SELECT run_id AS runId FROM workflow_follow_up_queues
         WHERE origin_session_id = ? AND presentation_state = 'pending'
         ORDER BY created_at`,
      )
      .all(targetSessionId)
      .flatMap((row) => (isRecord(row) && typeof row.runId === "string" ? [row.runId] : []));
  }

  settleFollowUpPresentation(options: {
    runId: string;
    state: "settled" | "unavailable";
    presentationEntryId?: string;
    assistantEntryId?: string;
    reason?: string;
  }): WorkflowFollowUpQueueRecord {
    const queue = this.requireFollowUpQueueRow(options.runId);
    if (queue.presentationState === options.state) {
      return this.readFollowUpQueue(options.runId) as WorkflowFollowUpQueueRecord;
    }
    if (queue.presentationState !== "pending") {
      throw new Error(
        `Workflow presentation is ${queue.presentationState}, not pending for ${options.runId}`,
      );
    }
    if (
      options.state === "settled" &&
      (options.presentationEntryId === undefined || options.assistantEntryId === undefined)
    ) {
      throw new Error("Settled workflow presentation requires both session entry IDs");
    }
    if (options.state === "unavailable" && !options.reason?.trim()) {
      throw new Error("Unavailable workflow presentation requires a reason");
    }
    try {
      this.mutations.mutate(
        {
          resourceId: queue.resourceId,
          operation: "follow-up.presentation",
          actor: {
            type: "session",
            ...(queue.originSessionId !== null ? { id: queue.originSessionId } : {}),
          },
          expectedRevision: queue.revision,
        },
        `follow-up.presentation-${options.state}`,
        ({ database, now }) => {
          const reasonHash =
            options.state === "unavailable"
              ? database.putText(options.reason as string, now)
              : null;
          database.connection
            .prepare(
              `UPDATE workflow_follow_up_queues
             SET presentation_state = ?, presentation_entry_id = ?,
                 presentation_assistant_entry_id = ?, presentation_reason_hash = ?,
                 presentation_updated_at = ?, updated_at = ?
             WHERE run_id = ? AND presentation_state = 'pending'`,
            )
            .run(
              options.state,
              options.presentationEntryId ?? null,
              options.assistantEntryId ?? null,
              reasonHash,
              now,
              now,
              options.runId,
            );
          database.connection
            .prepare(
              `UPDATE workflow_follow_ups SET status = 'ready', updated_at = ?
             WHERE run_id = ? AND status = 'pending_presentation'`,
            )
            .run(now, options.runId);
          recordViewerDeltas(
            this.state,
            options.runId,
            this.viewerInspectorTargets(options.runId),
            now,
          );
        },
        { payload: { runId: options.runId, state: options.state } },
      );
    } catch (error) {
      if (error instanceof StaleResourceError) {
        const current = this.requireFollowUpQueueRow(options.runId);
        if (current.presentationState === options.state) {
          return this.readFollowUpQueue(options.runId) as WorkflowFollowUpQueueRecord;
        }
      }
      throw error;
    }
    return this.readFollowUpQueue(options.runId) as WorkflowFollowUpQueueRecord;
  }

  claimNextFollowUp(
    targetSessionId: string,
    ownerId: string,
    leaseMs = 30_000,
  ): { followUp: WorkflowFollowUpRecord; claim: LeaseClaim } | undefined {
    const rows = this.state.connection
      .prepare(
        `${FOLLOW_UP_ROW_SELECT}
         WHERE f.target_session_id = ? AND f.status = 'ready'
         ORDER BY f.created_at, f.order_number LIMIT 16`,
      )
      .all(targetSessionId)
      .filter(isFollowUpRow);
    for (const row of rows) {
      let claim: LeaseClaim | undefined;
      try {
        claim = this.mutations.claim({
          resourceId: row.resourceId,
          ownerType: "session",
          ownerId,
          expectedRevision: row.revision,
          leaseMs,
        });
      } catch (error) {
        if (error instanceof StaleResourceError) continue;
        throw error;
      }
      if (claim === undefined) continue;
      const current = this.requireFollowUpRow(row.followUpId);
      if (current.status !== "ready") {
        this.mutations.release(claim, claim.resourceRevision);
        continue;
      }
      return { followUp: this.followUpRecord(current), claim };
    }
    return undefined;
  }

  markFollowUpSent(
    followUpId: string,
    claim: LeaseClaim,
    sessionEntryId: string,
  ): WorkflowFollowUpRecord {
    const row = this.requireFollowUpRow(followUpId);
    if (row.status === "sent") return this.followUpRecord(row);
    this.mutations.mutate(
      {
        resourceId: row.resourceId,
        operation: "follow-up.sent",
        actor: { type: "session", id: claim.ownerId },
        expectedRevision: claim.resourceRevision,
        lease: claim,
      },
      "follow-up.sent",
      ({ database, now }) => {
        const update = database.connection
          .prepare(
            `UPDATE workflow_follow_ups
             SET status = 'sent', session_entry_id = ?, sent_at = ?, updated_at = ?
             WHERE follow_up_id = ? AND status = 'ready'`,
          )
          .run(sessionEntryId, now, now, followUpId);
        if (update.changes !== 1) {
          throw new StaleResourceError("Workflow follow-up changed before delivery completed");
        }
        recordViewerDeltas(this.state, row.runId, this.viewerInspectorTargets(row.runId), now);
      },
      { payload: { followUpId, sessionEntryId } },
    );
    return this.followUpRecord(this.requireFollowUpRow(followUpId));
  }

  releaseFollowUpClaim(claim: LeaseClaim): void {
    const revision = this.requireResourceRevision(claim.resourceId);
    this.mutations.release(claim, revision);
  }

  async prepareRunResume(runId: string): Promise<LoadedWorkflowRun> {
    const loaded = this.readRun(runId, { includeTrace: true });
    if (loaded === null) throw new Error(`Cannot resume unreadable workflow run: ${runId}`);
    if (loaded.state.status !== "running") {
      throw new Error(`Cannot resume workflow run ${runId} with status ${loaded.state.status}`);
    }
    this.verifySettingsProjections(runId);
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
      loaded.state.traceSeq = nextRevision;
      loaded.state.updatedAt = at;
      this.persistRunState(row, loaded.state, nextRevision, now);
      recordViewerDeltas(this.state, runId, runViewerTargets(loaded.state, traceEvent), now);
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
        this.state.connection
          .prepare(
            `UPDATE workflow_follow_up_queues
             SET origin_session_id = COALESCE(origin_session_id, ?), updated_at = ?
             WHERE run_id = ?`,
          )
          .run(binding.piSessionId, now, runId);
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
        const current = this.readRunState(run, this.readDefinition(run.definitionHash));
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
      settingsScopes: this.settingsScopesForRunView(runId),
      followUpQueue: this.readFollowUpQueue(runId) ?? null,
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
        sessionEntryId: row.sessionEntryId,
      }));
    const followUpStart = Math.max(0, followUps.length - VIEWER_PAGE_SIZE);
    const queue = this.requireFollowUpQueueRow(runId);
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
            value: parseJson(
              canonicalJson({
                presentationState: queue.presentationState,
                items: followUps.slice(followUpStart),
              }),
            ),
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
    const childQueueResourceId = this.ensureFollowUpQueue(state.runId, now);
    if (state.parentRunId !== undefined) {
      const parentQueue = this.followUpQueueRow(state.parentRunId);
      if (parentQueue !== undefined) {
        this.state.connection
          .prepare(
            `UPDATE workflow_follow_up_queues
             SET origin_session_id = COALESCE(origin_session_id, ?), updated_at = ?
             WHERE run_id = ?`,
          )
          .run(parentQueue.originSessionId, now, state.runId);
        this.state.connection
          .prepare(
            `UPDATE workflow_follow_ups
             SET run_id = ?, queue_resource_id = ?, updated_at = ?
             WHERE run_id = ? AND status = 'queued'`,
          )
          .run(state.runId, childQueueResourceId, now, state.parentRunId);
      }
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

  private ensureFollowUpQueue(runId: string, now: number): string {
    const resourceId = this.mutations.ensureResource("follow_up_queue", runId, now);
    this.state.connection
      .prepare(
        `INSERT INTO workflow_follow_up_queues(
           run_id, resource_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(runId, resourceId, now, now);
    return resourceId;
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

  private followUpQueueRow(runId: string): FollowUpQueueRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT q.run_id AS runId, q.resource_id AS resourceId,
                q.origin_session_id AS originSessionId,
                q.presentation_state AS presentationState,
                q.presentation_entry_id AS presentationEntryId,
                q.presentation_assistant_entry_id AS presentationAssistantEntryId,
                q.presentation_reason_hash AS presentationReasonHash,
                r.revision
         FROM workflow_follow_up_queues q
         JOIN resources r ON r.resource_id = q.resource_id
         WHERE q.run_id = ?`,
      )
      .get(runId);
    return isFollowUpQueueRow(row) ? row : undefined;
  }

  private requireFollowUpQueueRow(runId: string): FollowUpQueueRow {
    const row = this.followUpQueueRow(runId);
    if (row === undefined) throw new Error(`Workflow follow-up queue not found: ${runId}`);
    return row;
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
      ...(row.sessionEntryId !== null ? { sessionEntryId: row.sessionEntryId } : {}),
      ...(row.reasonHash !== null ? { reason: this.readText(row.reasonHash) } : {}),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      ...(row.sentAt !== null ? { sentAt: new Date(row.sentAt).toISOString() } : {}),
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

  private hasLiveLease(resourceId: string): boolean {
    const row = this.state.connection
      .prepare("SELECT expires_at AS expiresAt FROM leases WHERE resource_id = ?")
      .get(resourceId);
    return isLeaseExpiryRow(row) && row.expiresAt !== null && row.expiresAt > Date.now();
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
    event: WorkflowTraceEventDraft,
    now: number,
  ): void {
    if (state.status === "running" || state.status === "waiting") return;
    const queue = this.followUpQueueRow(state.runId);
    if (queue === undefined || queue.presentationState !== "none") return;
    let presentationState: WorkflowPresentationState = "not-needed";
    let followUpState: WorkflowFollowUpState = "cancelled";
    let reasonHash: Buffer | null = null;
    if (state.status === "completed") {
      const required = event.payload.presentationRequired === true;
      presentationState = required ? "pending" : "not-needed";
      followUpState = required ? "pending_presentation" : "ready";
    } else {
      reasonHash = this.state.putText(
        state.error ?? `Workflow ended with status ${state.status}`,
        now,
      );
    }
    this.state.connection
      .prepare(
        `UPDATE workflow_follow_up_queues
         SET presentation_state = ?, presentation_updated_at = ?, updated_at = ?
         WHERE run_id = ? AND presentation_state = 'none'`,
      )
      .run(presentationState, now, now, state.runId);
    this.state.connection
      .prepare(
        `UPDATE workflow_follow_ups
         SET status = ?, reason_hash = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('queued', 'pending_presentation', 'ready')`,
      )
      .run(followUpState, reasonHash, now, state.runId);
    const revision = this.requireResourceRevision(queue.resourceId);
    this.bumpResource(queue.resourceId, revision, now);
    const payloadHash = this.state.putJson(
      { runId: state.runId, state: presentationState, followUps: followUpState },
      now,
    );
    insertGenericEvent(
      this.state,
      queue.resourceId,
      revision + 1,
      "follow-up.run-finished",
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
           AND json_extract(CAST(b.content AS TEXT), '$.customType') = 'pi-workflows-agent-step'
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

  private readRunState(row: RunRow, snapshot: WorkflowDefinitionSnapshot): WorkflowRunState {
    const steps = this.readSteps(row.runId);
    const sources = this.readRunSources(row.runId, snapshot);
    const carriedStepCount = this.carriedStepCount(row.runId);
    const activeAttempt = row.status === "running" ? this.readActiveAttempt(row.runId) : undefined;
    const humanDecision = this.readHumanDecisionReceipt(row.runId);
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
      steps,
      ...this.readUpdates(row.runId),
      ...(activeAttempt === undefined ? {} : { currentNode: activeAttempt.nodeId }),
      ...(activeAttempt === undefined ? {} : { currentAttemptId: activeAttempt.attemptId }),
      ...(activeAttempt?.startedAt === null || activeAttempt === undefined
        ? {}
        : { currentNodeStartedAt: new Date(activeAttempt.startedAt).toISOString() }),
      ...savedCurrentSettingsBinding(
        activeAttempt?.settingsScopeId ?? null,
        activeAttempt?.settingsChangeNumber ?? null,
        activeAttempt?.settingsHash ?? null,
      ),
      ...(row.statusDetail === null ? {} : { statusDetail: row.statusDetail }),
      ...(humanDecision === undefined ? {} : { humanDecision }),
      ...(row.paused === 0 ? {} : { paused: true }),
      ...(row.status === "waiting" && steps.at(-1) !== undefined
        ? { waitingOn: steps.at(-1)?.nodeId as string }
        : {}),
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
           ON last_link.attempt_id = a.attempt_id AND last_link.role = 'last'
         WHERE s.run_id = ? ORDER BY s.step_index`,
      )
      .all(runId)
      .filter(isStepRow);
    return rows.map((row, index) => {
      if (row.stepIndex !== index)
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
        settingsScopeId: string | null;
        settingsChangeNumber: number | null;
        settingsHash: Buffer | null;
      }
    | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT attempt_id AS attemptId, node_id AS nodeId, started_at AS startedAt,
                settings_scope_id AS settingsScopeId,
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
  if (
    value !== "queued" &&
    value !== "pending_presentation" &&
    value !== "ready" &&
    value !== "sent" &&
    value !== "removed" &&
    value !== "cancelled"
  ) {
    throw new Error(`Unknown workflow follow-up state: ${value}`);
  }
  return value;
}

function assertPresentationState(value: string): WorkflowPresentationState {
  if (
    value !== "none" &&
    value !== "not-needed" &&
    value !== "pending" &&
    value !== "settled" &&
    value !== "unavailable"
  ) {
    throw new Error(`Unknown workflow presentation state: ${value}`);
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

function isFollowUpQueueRow(value: unknown): value is FollowUpQueueRow {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.resourceId === "string" &&
    (typeof value.originSessionId === "string" || value.originSessionId === null) &&
    typeof value.presentationState === "string" &&
    (typeof value.presentationEntryId === "string" || value.presentationEntryId === null) &&
    (typeof value.presentationAssistantEntryId === "string" ||
      value.presentationAssistantEntryId === null) &&
    (Buffer.isBuffer(value.presentationReasonHash) || value.presentationReasonHash === null) &&
    typeof value.revision === "number"
  );
}

function isFollowUpRow(value: unknown): value is FollowUpRow {
  return (
    isRecord(value) &&
    typeof value.followUpId === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.queueResourceId === "string" &&
    typeof value.runId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.orderNumber === "number" &&
    typeof value.targetSessionId === "string" &&
    typeof value.actorType === "string" &&
    (typeof value.actorId === "string" || value.actorId === null) &&
    typeof value.sourceType === "string" &&
    Buffer.isBuffer(value.promptHash) &&
    typeof value.status === "string" &&
    (typeof value.sessionEntryId === "string" || value.sessionEntryId === null) &&
    (Buffer.isBuffer(value.reasonHash) || value.reasonHash === null) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (typeof value.sentAt === "number" || value.sentAt === null) &&
    typeof value.revision === "number"
  );
}

function isParentRunRow(value: unknown): value is { parentRunId: string | null } {
  return isRecord(value) && (typeof value.parentRunId === "string" || value.parentRunId === null);
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

function isLeaseExpiryRow(value: unknown): value is { expiresAt: number | null } {
  return isRecord(value) && (typeof value.expiresAt === "number" || value.expiresAt === null);
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
  if (node.nodeType === "action") common.actionExecution = "exec" in node ? "shell" : "function";
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
