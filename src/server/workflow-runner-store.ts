import { randomUUID } from "node:crypto";
import type { JsonValue } from "../state/json.js";
import type { WorkflowSettingsScopeRecord } from "../workflows/settings.js";
import {
  createDefinitionSnapshot,
  type InitializeWorkflowRunOptions,
  type WorkflowExecutionStore,
} from "../workflows/store.js";
import type { WorkflowTransition } from "../workflows/transitions.js";
import type {
  WorkflowDefinition,
  WorkflowEffectRecovery,
  WorkflowEffectReservation,
  WorkflowNotificationReceipt,
  WorkflowNotificationRequest,
  WorkflowRunState,
  WorkflowTraceEvent,
  WorkflowUpdateInput,
  WorkflowUpdateRecord,
} from "../workflows/types.js";
import type {
  WorkflowRunnerMessageKind,
  WorkflowRunnerStoreOperation,
} from "./workflow-runner-protocol.js";
import { runnerKindForOperation } from "./workflow-runner-protocol.js";

export interface WorkflowRunnerStoreTransport {
  request(options: {
    messageId: string;
    operation: WorkflowRunnerStoreOperation;
    kind: WorkflowRunnerMessageKind;
    expectedRevision: number;
    attemptId?: string;
    payload: JsonValue;
  }): Promise<{ result?: JsonValue; revision?: number }>;
}

/** A runner-side store that can only propose state changes to its server. */
export class ServerBackedWorkflowStore implements WorkflowExecutionStore {
  readonly databasePath = "server://pi-workflows-state";
  private revision: number;

  constructor(
    private readonly runId: string,
    private readonly transport: WorkflowRunnerStoreTransport,
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

  async prepareRunResume(runId: string): Promise<WorkflowRunState> {
    return await this.call<WorkflowRunState>("store.prepareRunResume", { runId });
  }

  async readRunState(runId: string): Promise<WorkflowRunState | null> {
    return await this.call<WorkflowRunState | null>("store.readRunState", { runId });
  }

  async commitTransition(
    runId: string,
    transition: WorkflowTransition,
  ): Promise<WorkflowTraceEvent> {
    return await this.call<WorkflowTraceEvent>(
      "store.commitTransition",
      { runId, transition },
      transition.event.attemptId,
    );
  }

  async publishUpdate(
    runId: string,
    nodeId: string,
    attemptId: string,
    update: WorkflowUpdateInput,
  ): Promise<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }> {
    return await this.call<{ event: WorkflowTraceEvent; record: WorkflowUpdateRecord }>(
      "store.publishUpdate",
      { runId, nodeId, attemptId, update },
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

  async readCheckpoint(runId: string, attemptId: string) {
    const value = await this.call<
      import("../workflows/requests.js").WorkflowCheckpointState | null
    >("store.readCheckpoint", { runId, attemptId }, attemptId);
    return value ?? undefined;
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

  async acceptInteraction(options: {
    requestId: string;
    submissionId: string;
    attemptId: string;
    value: JsonValue;
  }): Promise<void> {
    await this.call("interaction.accept", options, options.attemptId);
  }

  async rejectInteraction(options: {
    requestId: string;
    submissionId: string;
    attemptId: string;
    error: string;
  }): Promise<void> {
    await this.call("interaction.reject", options, options.attemptId);
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

  private async call<T>(
    operation: WorkflowRunnerStoreOperation,
    payload: Record<string, unknown>,
    attemptId?: string,
  ): Promise<T> {
    const response = await this.transport.request({
      messageId: randomUUID(),
      operation,
      kind: runnerKindForOperation(operation, payload),
      expectedRevision: this.revision,
      ...(attemptId === undefined ? {} : { attemptId }),
      payload: payload as JsonValue,
    });
    if (response.revision !== undefined) this.revision = response.revision;
    return response.result as T;
  }
}
