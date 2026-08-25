import { createRunId } from "../workflows/store.js";
import { jsonFingerprint } from "./json.js";
import type { ControllerStore } from "./store.js";
import type {
  ChildWorkflowRecord,
  ChildWorkflowRequest,
  ChildWorkflowState,
  ControllerFollowUpResult,
  ControllerQueueClaim,
  ControllerQueueFollowUpRequest,
  ControllerRemoveFollowUpRequest,
  ControllerResource,
  ControllerSettingsChangeRequest,
  ControllerSettingsChangeResult,
  ControllerWorkflows,
} from "./types.js";

export type WorkflowSchedulerRequest = {
  requestId: string;
  attempt: number;
  workflow: string;
  input: unknown;
  runId: string;
};

export type WorkflowSchedulerResult = {
  state: ChildWorkflowState;
  runId?: string;
  error?: string;
};

export type ControllerWorkflowControlRequest<TRequest> = TRequest & {
  controllerResourceUid: string;
  actorRequestKey: string;
};

export interface ControllerWorkflowScheduler {
  ensure(
    request: WorkflowSchedulerRequest,
    signal: AbortSignal,
    onComplete: (result: WorkflowSchedulerResult) => void,
  ): Promise<WorkflowSchedulerResult>;
  changeSettings?(
    request: ControllerWorkflowControlRequest<ControllerSettingsChangeRequest>,
    signal: AbortSignal,
  ): Promise<ControllerSettingsChangeResult>;
  queueFollowUp?(
    request: ControllerWorkflowControlRequest<ControllerQueueFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ControllerFollowUpResult>;
  removeFollowUp?(
    request: ControllerWorkflowControlRequest<ControllerRemoveFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ControllerFollowUpResult>;
}

function controllerRequestKey(resource: ControllerResource, requestKey: string): string {
  if (requestKey.trim().length === 0) {
    throw new Error("Controller workflow requestKey must not be empty");
  }
  return `controller:${resource.metadata.uid}:${requestKey}`;
}

export class ControllerWorkflowCoordinator {
  constructor(
    private readonly store: ControllerStore,
    private readonly scheduler?: ControllerWorkflowScheduler,
  ) {}

  forResource(
    resource: ControllerResource,
    claim: ControllerQueueClaim,
    signal: AbortSignal,
  ): ControllerWorkflows {
    return {
      ensure: async (request) => await this.ensure(resource, claim, request, signal),
      changeSettings: async (request) => {
        if (this.scheduler?.changeSettings === undefined) {
          throw new Error("This controller host does not support workflow settings changes");
        }
        return await this.scheduler.changeSettings(
          {
            ...request,
            controllerResourceUid: resource.metadata.uid,
            actorRequestKey: controllerRequestKey(resource, request.requestKey),
          },
          signal,
        );
      },
      queueFollowUp: async (request) => {
        if (this.scheduler?.queueFollowUp === undefined) {
          throw new Error("This controller host does not support workflow follow-ups");
        }
        return await this.scheduler.queueFollowUp(
          {
            ...request,
            controllerResourceUid: resource.metadata.uid,
            actorRequestKey: controllerRequestKey(resource, request.requestKey),
          },
          signal,
        );
      },
      removeFollowUp: async (request) => {
        if (this.scheduler?.removeFollowUp === undefined) {
          throw new Error("This controller host does not support workflow follow-ups");
        }
        return await this.scheduler.removeFollowUp(
          {
            ...request,
            controllerResourceUid: resource.metadata.uid,
            actorRequestKey: controllerRequestKey(resource, request.requestKey),
          },
          signal,
        );
      },
    };
  }

  complete(requestId: string, result: WorkflowSchedulerResult): ChildWorkflowRecord {
    const previous = this.store.getWorkflowByRequestId(requestId);
    if (previous === undefined) {
      throw new Error(`Workflow request not found: ${requestId}`);
    }
    const record = this.store.completeWorkflow(requestId, {
      state: result.state,
      ...(result.runId !== undefined ? { runId: result.runId } : {}),
      ...(result.error !== undefined ? { error: result.error } : { error: null }),
    });
    this.enqueueParent(record.resourceUid);
    return record;
  }

  private async ensure(
    resource: ControllerResource,
    claim: ControllerQueueClaim,
    request: ChildWorkflowRequest,
    signal: AbortSignal,
  ): Promise<ChildWorkflowRecord> {
    const inputFingerprint = jsonFingerprint(request.input);
    const reservation = this.store.reserveWorkflow({
      resourceUid: resource.metadata.uid,
      claim,
      requestKey: request.requestKey,
      workflow: request.workflow,
      inputFingerprint,
    });
    let record = reservation.record;
    if (record.state === "succeeded" || record.state === "failed" || record.state === "waiting") {
      return record;
    }
    if (this.scheduler === undefined) {
      return record;
    }
    if (record.state === "interrupted" || record.attempt === 0) {
      record = this.store.updateWorkflow(
        record.requestId,
        {
          state: "pending",
          attempt: record.attempt + 1,
          runId: createRunId(record.workflow),
          error: null,
        },
        claim,
      );
    } else if (record.runId === undefined) {
      record = this.store.updateWorkflow(
        record.requestId,
        {
          state: "pending",
          runId: createRunId(record.workflow),
          error: null,
        },
        claim,
      );
    }
    if (record.runId === undefined) {
      throw new Error(`Workflow request has no reserved run ID: ${record.requestId}`);
    }
    const result = await this.scheduler.ensure(
      {
        requestId: record.requestId,
        attempt: record.attempt,
        workflow: record.workflow,
        input: request.input,
        runId: record.runId,
      },
      signal,
      (completed) => {
        this.complete(record.requestId, completed);
      },
    );
    record = this.store.updateWorkflow(
      record.requestId,
      {
        state: result.state,
        ...(result.runId !== undefined ? { runId: result.runId } : {}),
        ...(result.error !== undefined ? { error: result.error } : { error: null }),
      },
      claim,
    );
    if (reservation.created || result.state !== "running") {
      this.recordEvent(
        record,
        reservation.created ? "workflow_requested" : "workflow_state_changed",
        claim,
      );
    }
    return record;
  }

  private enqueueParent(resourceUid: string): void {
    const resource = this.store.getResourceByUid(resourceUid);
    if (resource !== undefined) {
      this.store.enqueue({
        controller: resource.metadata.controller,
        key: resource.metadata.key,
      });
    }
  }

  private recordEvent(
    record: ChildWorkflowRecord,
    type: string,
    claim: ControllerQueueClaim,
  ): void {
    const resource = this.store.getResourceByUid(record.resourceUid);
    if (resource === undefined) {
      return;
    }
    this.store.recordEvent({
      controller: resource.metadata.controller,
      key: resource.metadata.key,
      claim,
      type,
      payload: {
        requestId: record.requestId,
        requestKey: record.requestKey,
        state: record.state,
        attempt: record.attempt,
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
      },
    });
  }
}
