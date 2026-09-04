import { createRunId } from "../workflows/store.js";
import { jsonFingerprint } from "./json.js";
import type { ResourceManagerStore } from "./store.js";
import type {
  ChildWorkflowRecord,
  ChildWorkflowRequest,
  ChildWorkflowState,
  ResourceManagerFollowUpResult,
  ResourceManagerQueueClaim,
  ResourceManagerQueueFollowUpRequest,
  ResourceManagerRemoveFollowUpRequest,
  ManagedResource,
  ResourceManagerSettingsChangeRequest,
  ResourceManagerSettingsChangeResult,
  ResourceManagerWorkflows,
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

export type ResourceManagerWorkflowControlRequest<TRequest> = TRequest & {
  managedResourceUid: string;
  actorRequestKey: string;
};

export interface ResourceManagerWorkflowScheduler {
  ensure(
    request: WorkflowSchedulerRequest,
    signal: AbortSignal,
    onComplete: (result: WorkflowSchedulerResult) => void,
  ): Promise<WorkflowSchedulerResult>;
  changeSettings?(
    request: ResourceManagerWorkflowControlRequest<ResourceManagerSettingsChangeRequest>,
    signal: AbortSignal,
  ): Promise<ResourceManagerSettingsChangeResult>;
  queueFollowUp?(
    request: ResourceManagerWorkflowControlRequest<ResourceManagerQueueFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ResourceManagerFollowUpResult>;
  removeFollowUp?(
    request: ResourceManagerWorkflowControlRequest<ResourceManagerRemoveFollowUpRequest>,
    signal: AbortSignal,
  ): Promise<ResourceManagerFollowUpResult>;
}

function resourceManagerRequestKey(resource: ManagedResource, requestKey: string): string {
  if (requestKey.trim().length === 0) {
    throw new Error("ResourceManager workflow requestKey must not be empty");
  }
  return `resourceManager:${resource.metadata.uid}:${requestKey}`;
}

export class ResourceManagerWorkflowCoordinator {
  constructor(
    private readonly store: ResourceManagerStore,
    private readonly scheduler?: ResourceManagerWorkflowScheduler,
  ) {}

  forResource(
    resource: ManagedResource,
    claim: ResourceManagerQueueClaim,
    signal: AbortSignal,
  ): ResourceManagerWorkflows {
    return {
      ensure: async (request) => await this.ensure(resource, claim, request, signal),
      changeSettings: async (request) => {
        if (this.scheduler?.changeSettings === undefined) {
          throw new Error(
            "This resource manager runtime does not support workflow settings changes",
          );
        }
        return await this.scheduler.changeSettings(
          {
            ...request,
            managedResourceUid: resource.metadata.uid,
            actorRequestKey: resourceManagerRequestKey(resource, request.requestKey),
          },
          signal,
        );
      },
      queueFollowUp: async (request) => {
        if (this.scheduler?.queueFollowUp === undefined) {
          throw new Error("This resource manager runtime does not support workflow follow-ups");
        }
        return await this.scheduler.queueFollowUp(
          {
            ...request,
            managedResourceUid: resource.metadata.uid,
            actorRequestKey: resourceManagerRequestKey(resource, request.requestKey),
          },
          signal,
        );
      },
      removeFollowUp: async (request) => {
        if (this.scheduler?.removeFollowUp === undefined) {
          throw new Error("This resource manager runtime does not support workflow follow-ups");
        }
        return await this.scheduler.removeFollowUp(
          {
            ...request,
            managedResourceUid: resource.metadata.uid,
            actorRequestKey: resourceManagerRequestKey(resource, request.requestKey),
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
    resource: ManagedResource,
    claim: ResourceManagerQueueClaim,
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
        resourceManager: resource.metadata.resourceManager,
        key: resource.metadata.key,
      });
    }
  }

  private recordEvent(
    record: ChildWorkflowRecord,
    type: string,
    claim: ResourceManagerQueueClaim,
  ): void {
    const resource = this.store.getResourceByUid(record.resourceUid);
    if (resource === undefined) {
      return;
    }
    this.store.recordEvent({
      resourceManager: resource.metadata.resourceManager,
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
