import type {
  ChildWorkflowRecord,
  ResourceManagerEvent,
  ResourceManagerQueueClaim,
  ManagedResource,
  ManagedResourceRef,
  ManagedResourceStatus,
  EffectRecord,
  JsonObject,
} from "./types.js";

export type QueueRequeueOptions = {
  availableAt: string;
  error?: string;
};

export type QueueItem = {
  resourceManager: string;
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

export interface ResourceManagerStore {
  close(): void;

  putResource<TSpec, TStatus>(options: {
    resourceManager: string;
    key: string;
    spec: TSpec;
    initialStatus: TStatus;
    now?: string;
  }): ManagedResource<TSpec, TStatus>;
  getResource<TSpec = unknown, TStatus = unknown>(
    ref: ManagedResourceRef,
  ): ManagedResource<TSpec, TStatus> | undefined;
  getResourceByUid(uid: string): ManagedResource | undefined;
  listResources<TSpec = unknown, TStatus = unknown>(options?: {
    resourceManager?: string;
  }): ManagedResource<TSpec, TStatus>[];
  updateStatus<TStatus>(options: {
    ref: ManagedResourceRef;
    expectedResourceVersion: number;
    claim: ResourceManagerQueueClaim;
    status: ManagedResourceStatus<TStatus>;
    finalizers?: string[];
    now?: string;
  }): ManagedResource<unknown, TStatus>;
  requestDeletion(ref: ManagedResourceRef, now?: string): ManagedResource;
  updateFinalizers(options: {
    ref: ManagedResourceRef;
    expectedResourceVersion: number;
    finalizers: string[];
    now?: string;
  }): ManagedResource;
  deleteResource(
    ref: ManagedResourceRef,
    expectedResourceVersion: number,
    claim: ResourceManagerQueueClaim,
  ): boolean;

  enqueue(ref: ManagedResourceRef, availableAt?: string): void;
  claimNext(options: {
    resourceManagers: string[];
    ownerId: string;
    leaseMs: number;
    now?: string;
    exclude?: ManagedResourceRef[];
  }): ResourceManagerQueueClaim | undefined;
  renewClaim(claim: ResourceManagerQueueClaim, leaseMs: number, now?: string): boolean;
  settleClaim(claim: ResourceManagerQueueClaim, now?: string): boolean;
  requeueClaim(
    claim: ResourceManagerQueueClaim,
    options: QueueRequeueOptions,
    now?: string,
  ): boolean;
  listQueue(): QueueItem[];

  reserveEffect(options: {
    key: string;
    resourceUid: string;
    claim: ResourceManagerQueueClaim;
    generation: number;
    kind: string;
    requestFingerprint: string;
    now?: string;
  }): EffectReservation;
  getEffect(resourceUid: string, key: string): EffectRecord | undefined;
  updateEffect(options: {
    resourceUid: string;
    key: string;
    claim: ResourceManagerQueueClaim;
    state: EffectRecord["state"];
    externalRef?: string;
    error?: string;
    now?: string;
  }): EffectRecord;
  listEffects(resourceUid: string): EffectRecord[];

  reserveWorkflow(options: {
    resourceUid: string;
    claim: ResourceManagerQueueClaim;
    requestKey: string;
    workflow: string;
    inputFingerprint: string;
  }): WorkflowReservation;
  getWorkflow(resourceUid: string, requestKey: string): ChildWorkflowRecord | undefined;
  getWorkflowByRequestId(requestId: string): ChildWorkflowRecord | undefined;
  updateWorkflow(
    requestId: string,
    update: WorkflowRecordUpdate,
    claim: ResourceManagerQueueClaim,
  ): ChildWorkflowRecord;
  completeWorkflow(requestId: string, update: WorkflowRecordUpdate): ChildWorkflowRecord;
  listWorkflows(resourceUid: string): ChildWorkflowRecord[];

  recordEvent(options: {
    resourceManager: string;
    key: string;
    claim?: ResourceManagerQueueClaim;
    type: string;
    payload?: JsonObject;
    now?: string;
  }): ResourceManagerEvent;
  listEvents(options?: {
    resourceManager?: string;
    key?: string;
    limit?: number;
  }): ResourceManagerEvent[];
}
