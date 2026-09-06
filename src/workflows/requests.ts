import { createHash } from "node:crypto";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";

export type WorkflowRequestKind = "agent" | "assistant" | "checkpoint" | "decision";

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
