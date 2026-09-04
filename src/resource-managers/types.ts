import type { JsonPatch } from "../workflows/json-patch.js";

export type MaybePromise<T> = T | Promise<T>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ManagedResourceConditionStatus = true | false | "unknown";

export type ManagedResourceCondition = {
  type: string;
  status: ManagedResourceConditionStatus;
  reason: string;
  message?: string;
  observedGeneration: number;
  lastTransitionTime: string;
};

export type ChildWorkflowState =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "interrupted";

export type ChildWorkflowReference = {
  requestId: string;
  runId?: string;
  state: ChildWorkflowState;
  attempt: number;
};

export type ManagedResourceStatus<TStatus> = {
  observedGeneration: number;
  conditions: ManagedResourceCondition[];
  resourceManagerStatus: TStatus;
  workflowRun?: ChildWorkflowReference;
};

export type ManagedResource<TSpec = unknown, TStatus = unknown> = {
  metadata: {
    uid: string;
    resourceManager: string;
    key: string;
    resourceVersion: number;
    generation: number;
    deletionTimestamp?: string;
    finalizers: string[];
  };
  spec: TSpec;
  status: ManagedResourceStatus<TStatus>;
};

export type ManagedResourceRef = {
  resourceManager: string;
  key: string;
};

export type ManagedResourceConditionInput = {
  type: string;
  status: ManagedResourceConditionStatus;
  reason: string;
  message?: string;
};

export type ResourceManagerStatusPatch<TStatus> = {
  resourceManagerStatus?: TStatus;
  conditions?: ManagedResourceConditionInput[];
  workflowRun?: ChildWorkflowReference | null;
  finalizers?: string[];
};

export type ReconcileResult<TStatus> =
  | {
      kind: "settled";
      status?: ResourceManagerStatusPatch<TStatus>;
    }
  | {
      kind: "requeue";
      afterMs?: number;
      status?: ResourceManagerStatusPatch<TStatus>;
    };

export type EffectState = "pending" | "applied" | "rejected" | "indeterminate";

export type EffectRecord = {
  key: string;
  resourceUid: string;
  generation: number;
  kind: string;
  state: EffectState;
  requestFingerprint: string;
  startedAt: string;
  completedAt?: string;
  externalRef?: string;
  error?: string;
};

export type EffectObservation =
  | { state: "applied"; externalRef?: string }
  | { state: "not_applied" }
  | { state: "indeterminate" };

export type EffectApplication =
  | { state: "applied"; externalRef?: string }
  | { state: "rejected"; error: string }
  | { state: "indeterminate"; error?: string };

export type EffectDefinition<TRequest> = {
  key: string;
  kind: string;
  request: TRequest;
  observe: (signal: AbortSignal) => MaybePromise<EffectObservation>;
  apply: (signal: AbortSignal) => MaybePromise<EffectApplication>;
};

export interface ResourceManagerEffects {
  ensure<TRequest>(definition: EffectDefinition<TRequest>): Promise<EffectRecord>;
}

export type ChildWorkflowRequest = {
  requestKey: string;
  workflow: string;
  input: unknown;
};

export type ChildWorkflowRecord = ChildWorkflowReference & {
  resourceUid: string;
  requestKey: string;
  inputFingerprint: string;
  workflow: string;
  error?: string;
};

export type ResourceManagerSettingsChangeRequest = {
  requestKey: string;
  runId: string;
  scopeId?: string;
  expectedChangeNumber?: number;
  patch: JsonPatch;
};

export type ResourceManagerSettingsChangeResult = {
  runId: string;
  scopeId: string;
  changeNumber: number;
  adopted: boolean;
};

export type ResourceManagerQueueFollowUpRequest = {
  requestKey: string;
  runId: string;
  prompt: string;
};

export type ResourceManagerFollowUpResult = {
  runId: string;
  followUpId: string;
  order: number;
  state: string;
  adopted: boolean;
};

export type ResourceManagerRemoveFollowUpRequest = {
  requestKey: string;
  runId: string;
  followUpId: string;
};

export interface ResourceManagerWorkflows {
  ensure(request: ChildWorkflowRequest): Promise<ChildWorkflowRecord>;
  changeSettings(
    request: ResourceManagerSettingsChangeRequest,
  ): Promise<ResourceManagerSettingsChangeResult>;
  queueFollowUp(
    request: ResourceManagerQueueFollowUpRequest,
  ): Promise<ResourceManagerFollowUpResult>;
  removeFollowUp(
    request: ResourceManagerRemoveFollowUpRequest,
  ): Promise<ResourceManagerFollowUpResult>;
}

export type ReconcileContext<TStatus> = {
  signal: AbortSignal;
  effects: ResourceManagerEffects;
  workflows: ResourceManagerWorkflows;
  settled(status?: ResourceManagerStatusPatch<TStatus>): ReconcileResult<TStatus>;
  requeue(status?: ResourceManagerStatusPatch<TStatus>): ReconcileResult<TStatus>;
  requeueAfter(
    afterMs: number,
    status?: ResourceManagerStatusPatch<TStatus>,
  ): ReconcileResult<TStatus>;
};

export type ResourceManagerDefinition<TSpec = unknown, TStatus = unknown> = {
  name: string;
  initialStatus: (spec: TSpec) => TStatus;
  reconcile: (
    context: ReconcileContext<TStatus>,
    resource: ManagedResource<TSpec, TStatus>,
  ) => MaybePromise<ReconcileResult<TStatus>>;
  timeoutMs?: number;
};

export type AnyResourceManagerDefinition = {
  name: string;
  initialStatus(spec: unknown): unknown;
  reconcile(
    context: ReconcileContext<unknown>,
    resource: ManagedResource,
  ): MaybePromise<ReconcileResult<unknown>>;
  timeoutMs?: number;
};

export type ResourceManagerQueueClaim = {
  resourceManager: string;
  key: string;
  ownerId: string;
  token: string;
  generation: number;
  queueVersion: number;
  resourceVersion: number;
  consecutiveErrors: number;
  expiresAt: string;
};

export type ResourceManagerEvent = {
  seq: number;
  recordedAt: string;
  resourceManager: string;
  key: string;
  type: string;
  payload: JsonObject;
};
