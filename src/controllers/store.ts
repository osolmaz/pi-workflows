import type {
  ChildWorkflowRecord,
  ControllerEvent,
  ControllerQueueClaim,
  ControllerResource,
  ControllerResourceRef,
  ControllerResourceStatus,
  EffectRecord,
  JsonObject,
} from "./types.js";

export type QueueRequeueOptions = {
  availableAt: string;
  error?: string;
};

export type QueueItem = {
  controller: string;
  key: string;
  availableAt: string;
  consecutiveErrors: number;
  claimExpiresAt?: string;
};

export type EffectReservation = {
  record: EffectRecord;
  created: boolean;
};

export type WorkflowReservation = {
  record: ChildWorkflowRecord;
  created: boolean;
};

export type WorkflowRecordUpdate = {
  runId?: string | null;
  state: ChildWorkflowRecord["state"];
  attempt?: number;
  error?: string | null;
};

export interface ControllerStore {
  close(): void;

  putResource<TSpec, TStatus>(options: {
    controller: string;
    key: string;
    spec: TSpec;
    initialStatus: TStatus;
    now?: string;
  }): ControllerResource<TSpec, TStatus>;
  getResource<TSpec = unknown, TStatus = unknown>(
    ref: ControllerResourceRef,
  ): ControllerResource<TSpec, TStatus> | undefined;
  getResourceByUid(uid: string): ControllerResource | undefined;
  listResources<TSpec = unknown, TStatus = unknown>(options?: {
    controller?: string;
  }): ControllerResource<TSpec, TStatus>[];
  updateStatus<TStatus>(options: {
    ref: ControllerResourceRef;
    expectedResourceVersion: number;
    claim: ControllerQueueClaim;
    status: ControllerResourceStatus<TStatus>;
    finalizers?: string[];
    now?: string;
  }): ControllerResource<unknown, TStatus>;
  requestDeletion(ref: ControllerResourceRef, now?: string): ControllerResource;
  updateFinalizers(options: {
    ref: ControllerResourceRef;
    expectedResourceVersion: number;
    finalizers: string[];
    now?: string;
  }): ControllerResource;
  deleteResource(
    ref: ControllerResourceRef,
    expectedResourceVersion: number,
    claim: ControllerQueueClaim,
  ): boolean;

  enqueue(ref: ControllerResourceRef, availableAt?: string): void;
  claimNext(options: {
    controllers: string[];
    ownerId: string;
    leaseMs: number;
    now?: string;
    exclude?: ControllerResourceRef[];
  }): ControllerQueueClaim | undefined;
  renewClaim(claim: ControllerQueueClaim, leaseMs: number, now?: string): boolean;
  settleClaim(claim: ControllerQueueClaim, now?: string): boolean;
  requeueClaim(claim: ControllerQueueClaim, options: QueueRequeueOptions, now?: string): boolean;
  listQueue(): QueueItem[];

  reserveEffect(options: {
    key: string;
    resourceUid: string;
    claim: ControllerQueueClaim;
    generation: number;
    kind: string;
    requestFingerprint: string;
    now?: string;
  }): EffectReservation;
  getEffect(resourceUid: string, key: string): EffectRecord | undefined;
  updateEffect(options: {
    resourceUid: string;
    key: string;
    claim: ControllerQueueClaim;
    state: EffectRecord["state"];
    externalRef?: string;
    error?: string;
    now?: string;
  }): EffectRecord;
  listEffects(resourceUid: string): EffectRecord[];

  reserveWorkflow(options: {
    resourceUid: string;
    claim: ControllerQueueClaim;
    requestKey: string;
    workflow: string;
    inputFingerprint: string;
  }): WorkflowReservation;
  getWorkflow(resourceUid: string, requestKey: string): ChildWorkflowRecord | undefined;
  getWorkflowByRequestId(requestId: string): ChildWorkflowRecord | undefined;
  updateWorkflow(
    requestId: string,
    update: WorkflowRecordUpdate,
    claim: ControllerQueueClaim,
  ): ChildWorkflowRecord;
  completeWorkflow(requestId: string, update: WorkflowRecordUpdate): ChildWorkflowRecord;
  listWorkflows(resourceUid: string): ChildWorkflowRecord[];

  recordEvent(options: {
    controller: string;
    key: string;
    claim?: ControllerQueueClaim;
    type: string;
    payload?: JsonObject;
    now?: string;
  }): ControllerEvent;
  listEvents(options?: { controller?: string; key?: string; limit?: number }): ControllerEvent[];
}
