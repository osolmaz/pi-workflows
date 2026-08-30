import { randomUUID } from "node:crypto";
import type { JsonValue } from "../state/json.js";
import type { WorkflowSettingsScopeRecord } from "../workflows/settings.js";
import {
  createDefinitionSnapshot,
  type InitializeWorkflowRunOptions,
  type LoadedWorkflowRun,
  type ReadWorkflowRunOptions,
  type WorkflowExecutionStore,
} from "../workflows/store.js";
import type {
  HumanDecisionRequest,
  ResolvedHumanDecision,
  WorkflowDefinition,
  WorkflowEffectRecovery,
  WorkflowEffectReservation,
  WorkflowNotificationReceipt,
  WorkflowNotificationRequest,
  WorkflowRunState,
  WorkflowTraceEvent,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "../workflows/types.js";
import type { WorkerMessageKind, WorkerStoreOperation } from "./worker-protocol.js";
import { workerKindForOperation } from "./worker-protocol.js";

export interface WorkerStoreTransport {
  request(options: {
    messageId: string;
    operation: WorkerStoreOperation;
    kind: WorkerMessageKind;
    expectedRevision: number;
    attemptId?: string;
    payload: JsonValue;
  }): Promise<{ result?: JsonValue; revision?: number }>;
}

/** A worker-side store that can only propose state changes to its host. */
export class HostBackedWorkflowStore implements WorkflowExecutionStore {
  readonly databasePath = "host://pi-workflows-state";
  private revision: number;

  constructor(
    private readonly runId: string,
    private readonly transport: WorkerStoreTransport,
    initialRevision = 0,
  ) {
    this.revision = initialRevision;
  }

  async initializeRun(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    options: InitializeWorkflowRunOptions = {},
  ): Promise<string> {
    return await this.call<string>("store.initializeRun", {
      snapshot: createDefinitionSnapshot(workflow),
      workflowName: workflow.name,
      state,
      options,
    });
  }

  async prepareRunResume(runId: string): Promise<LoadedWorkflowRun> {
    return await this.call<LoadedWorkflowRun>("store.prepareRunResume", { runId });
  }

  async readRun(
    runId: string,
    options: ReadWorkflowRunOptions = {},
  ): Promise<LoadedWorkflowRun | null> {
    return await this.call<LoadedWorkflowRun | null>("store.readRun", { runId, options });
  }

  async writeSnapshot(
    runId: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<WorkflowTraceEvent> {
    return await this.call<WorkflowTraceEvent>(
      "store.writeSnapshot",
      { runId, state, event },
      event.attemptId,
    );
  }

  async publishUpdate(
    runId: string,
    state: WorkflowRunState,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
  ): Promise<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }> {
    return await this.call<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }>(
      "store.publishUpdate",
      { runId, state, nodeId, attemptId, update },
      attemptId,
    );
  }

  async findSettingsScope(
    runId: string,
    mountPath: string,
    invocation: number,
  ): Promise<WorkflowSettingsScopeRecord | undefined> {
    return await this.call<WorkflowSettingsScopeRecord | undefined>("store.findSettingsScope", {
      runId,
      mountPath,
      invocation,
    });
  }

  async ensureSettingsScope(options: {
    runId: string;
    mountPath: string;
    invocation: number;
    settings: JsonValue;
  }): Promise<WorkflowSettingsScopeRecord> {
    return await this.call<WorkflowSettingsScopeRecord>("store.ensureSettingsScope", { options });
  }

  async getSettingsScopeAtChange(
    scopeId: string,
    changeNumber: number,
  ): Promise<WorkflowSettingsScopeRecord | undefined> {
    return await this.call<WorkflowSettingsScopeRecord | undefined>(
      "store.getSettingsScopeAtChange",
      { scopeId, changeNumber },
    );
  }

  async createHumanDecisionRequest(request: HumanDecisionRequest): Promise<"created" | "adopted"> {
    return await this.call<"created" | "adopted">(
      "store.createHumanDecisionRequest",
      { request },
      request.attemptId,
    );
  }

  async readResolvedHumanDecision(decisionId: string): Promise<ResolvedHumanDecision | null> {
    return await this.call<ResolvedHumanDecision | null>("store.readResolvedHumanDecision", {
      decisionId,
    });
  }

  async reserveEffect(options: {
    runId: string;
    attemptId: string;
    effectType: string;
    idempotencyKey: string;
    request: JsonValue;
    recovery: WorkflowEffectRecovery;
  }): Promise<WorkflowEffectReservation> {
    return await this.call<WorkflowEffectReservation>(
      "store.reserveEffect",
      { options },
      options.attemptId,
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
    await this.call("store.settleEffect", { options });
  }

  async requestInteraction(options: {
    attemptId: string;
    kind: "agent" | "assistant" | "decision";
    contract: JsonValue;
  }): Promise<void> {
    await this.call("interaction.request", { runId: this.runId, ...options }, options.attemptId);
  }

  async requestNotification(
    request: WorkflowNotificationRequest,
  ): Promise<WorkflowNotificationReceipt> {
    return await this.call<WorkflowNotificationReceipt>(
      "notification.request",
      { request },
      request.attemptId,
    );
  }

  async requestPresentation(instructions: string): Promise<void> {
    await this.call("presentation.request", { instructions });
  }

  private async call<T>(
    operation: WorkerStoreOperation,
    payload: Record<string, unknown>,
    attemptId?: string,
  ): Promise<T> {
    const response = await this.transport.request({
      messageId: randomUUID(),
      operation,
      kind: workerKindForOperation(operation, payload),
      expectedRevision: this.revision,
      ...(attemptId === undefined ? {} : { attemptId }),
      payload: payload as JsonValue,
    });
    if (response.revision !== undefined) this.revision = response.revision;
    return response.result as T;
  }
}
