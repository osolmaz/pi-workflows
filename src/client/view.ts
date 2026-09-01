import type { JsonValue } from "../state/json.js";

export const RUN_VIEW_SCHEMA = "pi-workflows.run-view.v1" as const;
export const SESSION_VIEW_SCHEMA = "pi-workflows.session-view.v1" as const;

export type WorkflowDisplayStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "ambiguous";

export type WorkflowDisplay = {
  status: WorkflowDisplayStatus;
  activity: "supervised_worker" | "origin_turn" | null;
  controls: Array<"pause" | "resume" | "cancel" | "answer" | "review">;
  reason: string | null;
};

export type WorkflowRunView = {
  schema: typeof RUN_VIEW_SCHEMA;
  runId: string;
  revision: number;
  display: WorkflowDisplay;
  manifest: JsonValue;
  state: JsonValue;
  snapshot: JsonValue;
  workflow: JsonValue;
  queue: JsonValue;
  updates: JsonValue[];
  graphSteps: JsonValue[];
  takenTransitions: string[];
  graphCursor: number;
  stepStart: number;
  stepTotal: number;
  tracePage: JsonValue;
  session: JsonValue;
  settingsScopes: JsonValue[];
  settingsStart: number;
  settingsTotal: number;
  followUpQueue: JsonValue;
  followUpStart: number;
  followUpTotal: number;
  updateStart: number;
  updateTotal: number;
  live: boolean;
  possiblyInterrupted: boolean;
};

export type WorkflowRunSummary = {
  runId: string;
  workflowName: string;
  originSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  display: WorkflowDisplay;
  manifest: JsonValue;
  live: boolean;
  possiblyInterrupted: boolean;
};

export type ClientInteractiveRequest = {
  requestId: string;
  runId: string;
  attemptId: string;
  targetSessionId: string;
  kind: "agent" | "assistant" | "decision";
  contract: JsonValue;
  revision: number;
  status: "pending" | "presenting" | "settled" | "cancelled";
  presenterId: string | null;
  presentationClaimExpiresAt: string | null;
  presentationSessionEntryId: string | null;
  acceptedSubmissionId: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  consumedAt: string | null;
};

export type WorkflowSessionView = {
  schema: typeof SESSION_VIEW_SCHEMA;
  sessionId: string;
  run: WorkflowRunView | null;
  pendingInteractions: JsonValue[];
};

export type OriginActivityReport = {
  sessionId: string;
  runId: string;
  requestId: string;
  deliveryId: string;
  sessionEntryId: string;
  sequence: number;
  state: "started" | "refresh" | "settled";
};
