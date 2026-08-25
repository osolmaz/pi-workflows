import { compositionMetadata } from "../workflows/composition.js";
import { WorkflowEngine, workflowIdentityMismatch } from "../workflows/engine.js";
import type { WorkflowRunStore } from "../workflows/store.js";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowSource,
} from "../workflows/types.js";
import type {
  ControllerFollowUpResult,
  ControllerQueueFollowUpRequest,
  ControllerRemoveFollowUpRequest,
  ControllerSettingsChangeRequest,
  ControllerSettingsChangeResult,
} from "./types.js";
import type {
  ControllerWorkflowControlRequest,
  ControllerWorkflowScheduler,
  WorkflowSchedulerRequest,
  WorkflowSchedulerResult,
} from "./workflows.js";

export type ResolvedChildWorkflow = {
  workflow: WorkflowDefinition;
  workflowSource?: WorkflowSource;
};

export type WorkflowEngineSchedulerOptions = {
  store: WorkflowRunStore;
  resolveWorkflow: (name: string) => Promise<ResolvedChildWorkflow>;
  createEngine: (request: WorkflowSchedulerRequest) => WorkflowEngine;
  /**
   * Release resources the engine held after its run settles, for example a
   * headless child process. Called once per finished run.
   */
  disposeEngine?: (engine: WorkflowEngine) => Promise<void>;
};

export class WorkflowEngineScheduler implements ControllerWorkflowScheduler {
  private readonly active = new Map<string, { runId: string; promise: Promise<void> }>();

  constructor(private readonly options: WorkflowEngineSchedulerOptions) {}

  async ensure(
    request: WorkflowSchedulerRequest,
    signal: AbortSignal,
    onComplete: (result: WorkflowSchedulerResult) => void,
  ): Promise<WorkflowSchedulerResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Workflow scheduling aborted");
    }
    const activeKey = requestKey(request);
    const active = this.active.get(activeKey);
    if (active !== undefined) {
      return { state: "running", runId: active.runId };
    }

    const bundle = this.options.store.readRun(request.runId, { includeTrace: true });
    if (bundle !== null) {
      const recovered =
        bundle.state.status === "running"
          ? await this.options.store.markRunInterrupted(request.runId)
          : bundle;
      if (recovered !== null) {
        const lastTraceEvent = recovered.traceEvents?.at(-1) ?? null;
        return resultFromStatus(
          recovered.state.status,
          request.runId,
          recovered.state.error,
          lastTraceEvent?.type === "run_interrupted",
        );
      }
      return { state: "pending" };
    }

    const resolved = await this.options.resolveWorkflow(request.workflow);
    if (signal.aborted) {
      throw signal.reason ?? new Error("Workflow scheduling aborted");
    }
    const runId = request.runId;
    const engine = this.options.createEngine(request);
    const promise = engine
      .run(resolved.workflow, request.input, {
        runId,
        ...(resolved.workflowSource !== undefined
          ? { workflowSource: resolved.workflowSource }
          : {}),
      })
      .then((result) => {
        callCompletion(onComplete, resultFromRun(result));
      })
      .catch((error: unknown) => {
        callCompletion(onComplete, {
          state: "failed",
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.active.delete(activeKey);
        void this.options.disposeEngine?.(engine).catch(() => undefined);
      });
    this.active.set(activeKey, { runId, promise });
    return { state: "running", runId };
  }

  async changeSettings(
    request: ControllerWorkflowControlRequest<ControllerSettingsChangeRequest>,
    signal: AbortSignal,
  ): Promise<ControllerSettingsChangeResult> {
    signal.throwIfAborted();
    const bundle = this.options.store.readRun(request.runId);
    if (bundle === null) throw new Error(`Workflow run not found: ${request.runId}`);
    const resolved = await this.options.resolveWorkflow(bundle.state.workflowName);
    signal.throwIfAborted();
    if (workflowIdentityMismatch(bundle.state, resolved.workflow, resolved.workflowSource)) {
      throw new Error(`Workflow source changed since run ${request.runId} started`);
    }
    const scopes = this.options.store.listSettingsScopes(request.runId);
    const scopeId = request.scopeId ?? (scopes.length === 1 ? scopes[0]?.scopeId : undefined);
    if (scopeId === undefined) {
      throw new Error("Controller settings changes require scopeId when several scopes exist");
    }
    const scope = this.options.store.getSettingsScope(scopeId);
    if (scope === undefined || scope.activeRunId !== request.runId) {
      throw new Error(`Workflow settings scope not found: ${scopeId}`);
    }
    const definition =
      scope.mountPath === ""
        ? resolved.workflow.settings
        : compositionMetadata(resolved.workflow)?.scopes[scope.mountPath]?.settings;
    if (definition === undefined) {
      throw new Error(`Workflow scope ${scopeId} does not declare editable settings`);
    }
    const result = await this.options.store.changeSettings(definition, {
      runId: request.runId,
      scopeId,
      requestId: request.actorRequestKey,
      ...(request.expectedChangeNumber !== undefined
        ? { expectedChangeNumber: request.expectedChangeNumber }
        : {}),
      actor: { type: "controller", id: request.controllerResourceUid },
      source: "controller-request",
      patch: request.patch,
    });
    return {
      runId: request.runId,
      scopeId,
      changeNumber: result.scope.changeNumber,
      adopted: result.adopted,
    };
  }

  async queueFollowUp(
    request: ControllerWorkflowControlRequest<ControllerQueueFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ControllerFollowUpResult> {
    signal.throwIfAborted();
    const targetSessionId = this.options.store.originSessionId(request.runId);
    if (targetSessionId === undefined) {
      throw new Error("Controller follow-up requires a workflow run with an origin Pi session");
    }
    const result = this.options.store.queueFollowUp({
      runId: request.runId,
      requestId: request.actorRequestKey,
      targetSessionId,
      actor: { type: "controller", id: request.controllerResourceUid },
      source: "controller-request",
      prompt: request.prompt,
    });
    return {
      runId: request.runId,
      followUpId: result.followUp.followUpId,
      order: result.followUp.order,
      state: result.followUp.state,
      adopted: result.adopted,
    };
  }

  async removeFollowUp(
    request: ControllerWorkflowControlRequest<ControllerRemoveFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ControllerFollowUpResult> {
    signal.throwIfAborted();
    const result = this.options.store.removeFollowUp({
      runId: request.runId,
      followUpId: request.followUpId,
      actor: { type: "controller", id: request.controllerResourceUid },
      source: "controller-request",
    });
    return {
      runId: request.runId,
      followUpId: result.followUpId,
      order: result.order,
      state: result.state,
      adopted: false,
    };
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.promise));
  }
}

function callCompletion(
  callback: (result: WorkflowSchedulerResult) => void,
  result: WorkflowSchedulerResult,
): void {
  try {
    callback(result);
  } catch {
    // A later reconciliation recovers completion from the immutable run event.
  }
}

function requestKey(request: WorkflowSchedulerRequest): string {
  return `${request.requestId}:${request.attempt}`;
}

function resultFromRun(result: WorkflowRunResult): WorkflowSchedulerResult {
  return resultFromStatus(result.state.status, result.state.runId, result.state.error);
}

function resultFromStatus(
  status: WorkflowRunStatus,
  runId: string,
  error?: string,
  interrupted = false,
): WorkflowSchedulerResult {
  if (interrupted) {
    return { state: "interrupted", runId, ...(error !== undefined ? { error } : {}) };
  }
  switch (status) {
    case "running":
      return { state: "running", runId };
    case "waiting":
      return { state: "waiting", runId };
    case "completed":
      return { state: "succeeded", runId };
    case "failed":
    case "timed_out":
    case "cancelled":
      return { state: "failed", runId, ...(error !== undefined ? { error } : {}) };
  }
}
