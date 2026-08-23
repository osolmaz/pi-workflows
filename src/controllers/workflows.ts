import { createRunId } from "../workflows/store.js";
import { jsonFingerprint } from "./json.js";
import type { ControllerStore } from "./store.js";
import type {
  ChildWorkflowRecord,
  ChildWorkflowRequest,
  ChildWorkflowState,
  ControllerQueueClaim,
  ControllerResource,
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

export interface ControllerWorkflowScheduler {
  ensure(
    request: WorkflowSchedulerRequest,
    signal: AbortSignal,
    onComplete: (result: WorkflowSchedulerResult) => void,
  ): Promise<WorkflowSchedulerResult>;
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
    };
  }

  complete(
    requestId: string,
    result: WorkflowSchedulerResult,
    claim: ControllerQueueClaim,
  ): ChildWorkflowRecord {
    const previous = this.store.getWorkflowByRequestId(requestId);
    if (previous === undefined) {
      throw new Error(`Workflow request not found: ${requestId}`);
    }
    const record = this.store.updateWorkflow(
      requestId,
      {
        state: result.state,
        ...(result.runId !== undefined ? { runId: result.runId } : {}),
        ...(result.error !== undefined ? { error: result.error } : { error: null }),
      },
      claim,
    );
    this.enqueueParent(record.resourceUid);
    this.recordEvent(record, "workflow_state_changed", claim);
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
        this.complete(record.requestId, completed, claim);
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
