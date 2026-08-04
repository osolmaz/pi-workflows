import os from "node:os";
import path from "node:path";
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

export const CONTROLLER_STORE_SCHEMA = "pi-workflows.controller-store.v1" as const;

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
  deleteResource(ref: ControllerResourceRef, expectedResourceVersion: number): boolean;

  enqueue(ref: ControllerResourceRef, availableAt?: string): void;
  claimNext(options: {
    controllers: string[];
    leaseMs: number;
    now?: string;
  }): ControllerQueueClaim | undefined;
  renewClaim(claim: ControllerQueueClaim, leaseMs: number, now?: string): boolean;
  settleClaim(claim: ControllerQueueClaim, now?: string): boolean;
  requeueClaim(claim: ControllerQueueClaim, options: QueueRequeueOptions, now?: string): boolean;
  listQueue(): QueueItem[];

  reserveEffect(options: {
    key: string;
    resourceUid: string;
    generation: number;
    kind: string;
    requestFingerprint: string;
    now?: string;
  }): EffectReservation;
  getEffect(resourceUid: string, key: string): EffectRecord | undefined;
  updateEffect(options: {
    resourceUid: string;
    key: string;
    state: EffectRecord["state"];
    externalRef?: string;
    error?: string;
    now?: string;
  }): EffectRecord;
  listEffects(resourceUid: string): EffectRecord[];

  reserveWorkflow(options: {
    resourceUid: string;
    requestKey: string;
    workflow: string;
    inputFingerprint: string;
  }): WorkflowReservation;
  getWorkflow(resourceUid: string, requestKey: string): ChildWorkflowRecord | undefined;
  getWorkflowByRequestId(requestId: string): ChildWorkflowRecord | undefined;
  updateWorkflow(requestId: string, update: WorkflowRecordUpdate): ChildWorkflowRecord;
  listWorkflows(resourceUid: string): ChildWorkflowRecord[];

  recordEvent(options: {
    controller: string;
    key: string;
    type: string;
    payload?: JsonObject;
    now?: string;
  }): ControllerEvent;
  listEvents(options?: { controller?: string; key?: string; limit?: number }): ControllerEvent[];
}

export function controllerStoreBaseDir(homeDir: string = os.homedir()): string {
  const override = process.env.PI_WORKFLOWS_CONTROLLER_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return path.join(homeDir, ".pi", "agent", "workflows", "controllers");
}

export function controllerStorePath(homeDir: string = os.homedir()): string {
  return path.join(controllerStoreBaseDir(homeDir), "controller.sqlite");
}
