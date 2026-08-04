export type MaybePromise<T> = T | Promise<T>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ControllerConditionStatus = true | false | "unknown";

export type ControllerCondition = {
  type: string;
  status: ControllerConditionStatus;
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

export type ControllerResourceStatus<TStatus> = {
  observedGeneration: number;
  conditions: ControllerCondition[];
  controllerStatus: TStatus;
  workflowRun?: ChildWorkflowReference;
};

export type ControllerResource<TSpec = unknown, TStatus = unknown> = {
  metadata: {
    uid: string;
    controller: string;
    key: string;
    resourceVersion: number;
    generation: number;
    deletionTimestamp?: string;
    finalizers: string[];
  };
  spec: TSpec;
  status: ControllerResourceStatus<TStatus>;
};

export type ControllerResourceRef = {
  controller: string;
  key: string;
};

export type ControllerConditionInput = {
  type: string;
  status: ControllerConditionStatus;
  reason: string;
  message?: string;
};

export type ControllerStatusPatch<TStatus> = {
  controllerStatus?: TStatus;
  conditions?: ControllerConditionInput[];
  workflowRun?: ChildWorkflowReference | null;
  finalizers?: string[];
};

export type ReconcileResult<TStatus> =
  | {
      kind: "settled";
      status?: ControllerStatusPatch<TStatus>;
    }
  | {
      kind: "requeue";
      afterMs?: number;
      status?: ControllerStatusPatch<TStatus>;
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

export interface ControllerEffects {
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

export interface ControllerWorkflows {
  ensure(request: ChildWorkflowRequest): Promise<ChildWorkflowRecord>;
}

export type ReconcileContext<TStatus> = {
  signal: AbortSignal;
  effects: ControllerEffects;
  workflows: ControllerWorkflows;
  settled(status?: ControllerStatusPatch<TStatus>): ReconcileResult<TStatus>;
  requeue(status?: ControllerStatusPatch<TStatus>): ReconcileResult<TStatus>;
  requeueAfter(afterMs: number, status?: ControllerStatusPatch<TStatus>): ReconcileResult<TStatus>;
};

export type ControllerDefinition<TSpec = unknown, TStatus = unknown> = {
  name: string;
  initialStatus: (spec: TSpec) => TStatus;
  reconcile: (
    context: ReconcileContext<TStatus>,
    resource: ControllerResource<TSpec, TStatus>,
  ) => MaybePromise<ReconcileResult<TStatus>>;
  timeoutMs?: number;
};

export type AnyControllerDefinition = {
  name: string;
  initialStatus(spec: unknown): unknown;
  reconcile(
    context: ReconcileContext<unknown>,
    resource: ControllerResource,
  ): MaybePromise<ReconcileResult<unknown>>;
  timeoutMs?: number;
};

export type ControllerQueueClaim = {
  controller: string;
  key: string;
  token: string;
  queueVersion: number;
  consecutiveErrors: number;
  expiresAt: string;
};

export type ControllerEvent = {
  seq: number;
  recordedAt: string;
  controller: string;
  key: string;
  type: string;
  payload: JsonObject;
};
