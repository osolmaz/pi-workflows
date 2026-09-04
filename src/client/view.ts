import type { JsonValue } from "../state/json.js";
import type { WorkflowMessage, WorkflowTurn } from "../state/workflow-messages.js";

export const RUN_VIEW_SCHEMA = "pi-workflows.run-view.v1" as const;
export const SESSION_VIEW_SCHEMA = "pi-workflows.session-view.v1" as const;
export const WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA =
  "pi-workflows.workflow-turn-report-receipt.v1" as const;

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
  activity: "supervised_runner" | "origin_turn" | null;
  controls: Array<"pause" | "resume" | "cancel" | "answer" | "review">;
  reason: string | null;
  reasonContent?: JsonValue;
};

export type WorkflowRunQueueView = {
  runId: string;
  workflowName: string;
  workflowSourceRef: string;
  initialized: boolean;
  definitionDigest: string;
  status: "queued" | "starting" | "running" | "parked" | "done" | "failed" | "cancelled";
  originSessionId: string | null;
  executionMode: "interactive" | "headless";
  parentRunId: string | null;
  rootRunId: string;
  lineageKind: "continuation" | "restart" | null;
  restartNumber: number;
  parentTerminalFingerprint: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunView = {
  schema: typeof RUN_VIEW_SCHEMA;
  runId: string;
  revision: number;
  display: WorkflowDisplay;
  manifest: JsonValue;
  state: JsonValue;
  workflow: JsonValue;
  queue: WorkflowRunQueueView;
  updates: JsonValue[];
  graphSteps: JsonValue[];
  graphStepStart: number;
  graphStepTotal: number;
  takenTransitions: string[];
  graphHistory: JsonValue;
  takenTransitionStart: number;
  takenTransitionTotal: number;
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

export type WorkflowRunListPage = {
  schema: "pi-workflows.run-list-page.v1";
  revision: string;
  start: number;
  total: number;
  items: WorkflowRunSummary[];
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
  status: "pending" | "settled" | "cancelled";
  unproductiveTurnEnds: number;
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
  pendingInteractionStart: number;
  pendingInteractionTotal: number;
  workflowMessages: WorkflowMessage[];
  workflowMessageStart: number;
  workflowMessageTotal: number;
  workflowMessageWindowComplete: boolean;
  nextWorkflowMessageId: string | null;
  openWorkflowMessageId: string | null;
  openWorkflowTurn: WorkflowTurn | null;
  coordinatorEpoch: string | null;
  coordinatorActive: boolean;
  branchReportRequired: boolean;
};

export type WorkflowBranchReport = {
  targetSessionId: string;
  coordinatorEpoch: string;
  entries: Array<{ workflowMessageId: string; piSessionEntryId: string }>;
  isIdle: boolean;
  hasPendingMessages: boolean;
};

export type WorkflowTurnReportReceipt = {
  schema: typeof WORKFLOW_TURN_REPORT_RECEIPT_SCHEMA;
  ownership: "active" | "settled" | "absent";
  turn: WorkflowTurn | null;
};

export type WorkflowTurnReport =
  | {
      state: "started";
      workflowMessageId: string;
      workflowTurnId: string;
      runId: string;
      targetSessionId: string;
      coordinatorEpoch: string;
    }
  | {
      state: "ended";
      workflowMessageId: string;
      workflowTurnId: string;
      runId: string;
      targetSessionId: string;
      coordinatorEpoch: string;
      stopReason: "completed" | "aborted" | "error" | "lost";
      responseSessionEntryId: string | null;
    };
