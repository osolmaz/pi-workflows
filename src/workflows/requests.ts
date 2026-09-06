import { createHash } from "node:crypto";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { WorkflowMessageStore } from "../state/workflow-messages.js";
import type { HumanDecisionReceipt } from "./types.js";

export type WorkflowRequestKind = "agent" | "assistant" | "checkpoint" | "decision";

export type WorkflowCheckpointState = {
  request: InteractiveRequestRecord;
  output?: JsonValue;
  humanDecision?: HumanDecisionReceipt;
};

export type InteractiveRequestRecord = {
  requestId: string;
  runId: string;
  attemptId: string;
  targetSessionId: string;
  kind: WorkflowRequestKind;
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

export function workflowRequestId(runId: string, attemptId: string): string {
  return `request-${createHash("sha256")
    .update(JSON.stringify([runId, attemptId]))
    .digest("hex")}`;
}

/** Immutable identity and payload; an accepted request is never reopened. */
export function ensureWorkflowRequest(
  state: StateDatabase,
  options: Pick<
    InteractiveRequestRecord,
    "requestId" | "runId" | "attemptId" | "targetSessionId" | "kind" | "contract"
  >,
  now = Date.now(),
): InteractiveRequestRecord {
  return state.transaction(() => {
    const existing = readWorkflowRequest(state, options.requestId);
    if (existing !== undefined) {
      if (
        existing.runId !== options.runId ||
        existing.attemptId !== options.attemptId ||
        existing.targetSessionId !== options.targetSessionId ||
        existing.kind !== options.kind ||
        canonicalJson(existing.contract) !== canonicalJson(options.contract)
      )
        throw new Error(`Interactive request conflicts: ${options.requestId}`);
      return existing;
    }
    const attempt = state.connection
      .prepare("SELECT run_id AS runId FROM node_attempts WHERE attempt_id = ?")
      .get(options.attemptId) as { runId: string } | undefined;
    if (attempt?.runId !== options.runId)
      throw new Error("Request does not match its run and attempt");
    state.connection
      .prepare(
        `INSERT INTO interactive_requests(
         request_id, run_id, attempt_id, target_session_id, kind, contract_hash,
         revision, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
      )
      .run(
        options.requestId,
        options.runId,
        options.attemptId,
        options.targetSessionId,
        options.kind,
        state.putJson(options.contract, now),
        now,
        now,
      );
    const created = readWorkflowRequest(state, options.requestId);
    if (created === undefined) throw new Error("Workflow request was not saved");
    return created;
  });
}

type RequestRow = {
  requestId: string;
  runId: string;
  attemptId: string;
  targetSessionId: string;
  kind: WorkflowRequestKind;
  contractHash: Buffer;
  revision: number;
  status: InteractiveRequestRecord["status"];
  unproductiveTurnEnds: number;
  acceptedSubmissionId: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
  consumedAt: number | null;
};

export function readWorkflowRequest(
  state: StateDatabase,
  requestId: string,
): InteractiveRequestRecord | undefined {
  const row = state.connection
    .prepare(
      `SELECT request_id AS requestId, run_id AS runId, attempt_id AS attemptId,
            target_session_id AS targetSessionId, kind, contract_hash AS contractHash,
            revision, status, unproductive_turn_ends AS unproductiveTurnEnds,
            accepted_submission_id AS acceptedSubmissionId, created_at AS createdAt,
            updated_at AS updatedAt, settled_at AS settledAt, consumed_at AS consumedAt
     FROM interactive_requests WHERE request_id = ?`,
    )
    .get(requestId) as RequestRow | undefined;
  if (row === undefined) return undefined;
  const { contractHash, createdAt, updatedAt, settledAt, consumedAt, ...request } = row;
  return {
    ...request,
    contract: state.readJson(contractHash),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    settledAt: settledAt === null ? null : new Date(settledAt).toISOString(),
    consumedAt: consumedAt === null ? null : new Date(consumedAt).toISOString(),
  };
}

export function requestForAttempt(
  state: StateDatabase,
  runId: string,
  attemptId: string,
): InteractiveRequestRecord | undefined {
  const row = state.connection
    .prepare(
      "SELECT request_id AS requestId FROM interactive_requests WHERE run_id = ? AND attempt_id = ?",
    )
    .get(runId, attemptId) as { requestId: string } | undefined;
  return row === undefined ? undefined : readWorkflowRequest(state, row.requestId);
}

export function acceptedRequestOutput(
  state: StateDatabase,
  request: InteractiveRequestRecord,
): JsonValue {
  if (request.status !== "settled" || request.acceptedSubmissionId === null) {
    throw new Error("Workflow request has no accepted output");
  }
  const row = state.connection
    .prepare(
      `SELECT payload_hash AS payloadHash FROM interactive_submissions
     WHERE request_id = ? AND submission_id = ? AND outcome = 'accepted'`,
    )
    .get(request.requestId, request.acceptedSubmissionId) as { payloadHash: Buffer } | undefined;
  if (row === undefined) throw new Error("Accepted workflow response is missing");
  return state.readJson(row.payloadHash);
}

export type WorkflowSubmissionOptions = {
  requestId: string;
  submissionId: string;
  idempotencyKey: string;
  expectedRevision: number;
  payload: JsonValue;
  outcome: "validating" | "accepted" | "rejected" | "adopted";
  settle: boolean;
  receipt?: JsonValue;
};

/** Record one exact response candidate or winner under the request revision. */
export function recordWorkflowSubmission(
  state: StateDatabase,
  options: WorkflowSubmissionOptions,
): {
  interaction: InteractiveRequestRecord;
  submissionId: string;
  outcome: "accepted" | "adopted";
  receipt: JsonValue;
} {
  return state.transaction(() => {
    const request = readWorkflowRequest(state, options.requestId);
    if (request === undefined) throw new Error("Workflow request is missing");
    const payloadHash = createHash("sha256").update(canonicalJson(options.payload)).digest();
    const existing = state.connection
      .prepare(
        `SELECT submission_id AS submissionId, payload_hash AS payloadHash, receipt_hash AS receiptHash
       FROM interactive_submissions WHERE request_id = ? AND idempotency_key = ?`,
      )
      .get(options.requestId, options.idempotencyKey) as
      | { submissionId: string; payloadHash: Buffer; receiptHash: Buffer | null }
      | undefined;
    if (existing !== undefined) {
      if (!existing.payloadHash.equals(payloadHash))
        throw new Error("Interactive submission idempotency key conflicts");
      return {
        interaction: request,
        submissionId: existing.submissionId,
        outcome: "adopted",
        receipt:
          existing.receiptHash === null
            ? { requestId: request.requestId, submissionId: existing.submissionId }
            : state.readJson(existing.receiptHash),
      };
    }
    if (request.revision !== options.expectedRevision || request.status !== "pending") {
      throw new Error("Interactive request revision conflict");
    }
    if (
      options.outcome === "validating" &&
      state.connection
        .prepare(
          "SELECT 1 FROM interactive_submissions WHERE request_id = ? AND outcome = 'validating'",
        )
        .get(options.requestId) !== undefined
    )
      throw new Error("Interactive submission validation is already active");
    if (options.settle && options.outcome !== "accepted")
      throw new Error("Only accepted output can settle a request");
    if (request.kind === "decision" && options.settle) {
      const resolution = state.connection
        .prepare(
          `SELECT r.response_hash AS responseHash FROM human_decision_resolutions r
         JOIN human_decisions d ON d.decision_id = r.decision_id
         WHERE d.decision_id = ? AND d.run_id = ? AND d.attempt_id = ? AND r.outcome = 'accepted'`,
        )
        .get(request.requestId, request.runId, request.attemptId) as
        | { responseHash: Buffer }
        | undefined;
      const decision =
        resolution === undefined
          ? undefined
          : (state.readJson(resolution.responseHash) as { response?: JsonValue });
      if (
        decision?.response === undefined ||
        canonicalJson(decision.response) !== canonicalJson(options.payload)
      ) {
        throw new Error("Checkpoint response does not match a verified human decision");
      }
    }
    const now = Date.now();
    state.connection
      .prepare(
        `INSERT INTO interactive_submissions(
         submission_id, request_id, idempotency_key, request_revision,
         payload_hash, outcome, receipt_hash, submitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.submissionId,
        request.requestId,
        options.idempotencyKey,
        options.expectedRevision,
        state.putJson(options.payload, now),
        options.outcome,
        options.receipt === undefined ? null : state.putJson(options.receipt, now),
        now,
      );
    if (options.settle) {
      const changed = state.connection
        .prepare(
          `UPDATE interactive_requests SET status = 'settled', accepted_submission_id = ?,
           revision = revision + 1, updated_at = ?, settled_at = ?
         WHERE request_id = ? AND revision = ? AND status = 'pending'`,
        )
        .run(options.submissionId, now, now, request.requestId, options.expectedRevision);
      if (changed.changes !== 1) throw new Error("Workflow response lost its request revision");
      const messages = new WorkflowMessageStore(state);
      messages.cancelPendingForSource(request.requestId, "step", now);
      messages.cancelPendingForSource(request.requestId, "decision", now);
    }
    const interaction = readWorkflowRequest(state, request.requestId);
    if (interaction === undefined) throw new Error("Workflow request disappeared after acceptance");
    return {
      interaction,
      submissionId: options.submissionId,
      outcome: "accepted",
      receipt: options.receipt ?? {
        requestId: request.requestId,
        submissionId: options.submissionId,
      },
    };
  });
}
