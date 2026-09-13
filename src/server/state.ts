import { createHash, randomBytes } from "node:crypto";
import {
  CLIENT_PROTOCOL_SCHEMA,
  clientRequestFingerprint,
  type ClientRequest,
  type ClientResponse,
} from "../client/protocol.js";
import { AttemptTime, type AttemptClock } from "../state/attempt-time.js";
import { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { tokenHash } from "../state/mutation.js";
import {
  WorkflowMessageStore,
  workflowMessageIdFor,
  type WorkflowStepReason,
} from "../state/workflow-messages.js";
import {
  ensureWorkflowRequest,
  readWorkflowRequest,
  recordWorkflowSubmission,
  type InteractiveRequestRecord,
} from "../workflows/requests.js";
import {
  decisionWorkflowMessageContent,
  checkpointWorkflowMessageContent,
  stepWorkflowMessageContent,
} from "../workflows/workflow-message-content.js";
import type { WorkflowRunnerMessage, WorkflowRunnerResponse } from "./workflow-runner-protocol.js";

export type ServerClaim = {
  serverId: string;
  token: string;
  epoch: number;
  pid: number;
  processStartIdentity: string;
  expiresAt: number;
};

export type WorkflowServerStatusRecord = {
  epoch: number;
  serverId: string | null;
  pid: number | null;
  processStartIdentity: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  live: boolean;
};

export type WorkflowRunnerLaunchEnvelope = {
  schema: "pi-workflows.runner-launch.v1";
  runId: string;
  generation: number;
  runnerEpoch: string;
  projectPath: string;
  workflowSource: JsonValue;
  definitionDigest: string;
  inputHash: string;
  protocolVersion: 1;
};

export type RunnerOutcome =
  | "exited"
  | "cancelled"
  | "timedOut"
  | "crashed"
  | "claimLost"
  | "orphaned";

export type InteractiveSubmissionRecord = {
  requestId: string;
  submissionId: string;
  idempotencyKey: string;
  outcome: "validating" | "accepted" | "rejected" | "adopted";
  payload: JsonValue;
  receipt: JsonValue | null;
  submittedAt: string;
};

export class ServerStateStore {
  readonly state: StateDatabase;
  private readonly ownsState: boolean;
  readonly workflowMessages: WorkflowMessageStore;
  private readonly attemptTime: AttemptTime;

  constructor(
    databasePath: string,
    options: { state?: StateDatabase; readOnly?: boolean; clock?: AttemptClock } = {},
  ) {
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath: databasePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
      });
    this.workflowMessages = new WorkflowMessageStore(this.state);
    this.attemptTime = new AttemptTime(this.state, options.clock);
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  acquireServer(options: {
    serverId: string;
    pid: number;
    processStartIdentity: string;
    leaseMs: number;
    now?: number;
  }): ServerClaim {
    const now = options.now ?? Date.now();
    requireLeaseMs(options.leaseMs);
    return this.state.transaction(() => {
      const current = this.serverRow();
      if (current.serverId !== null && current.expiresAt !== null && current.expiresAt > now) {
        throw new Error(`A live Pi Workflows server already owns epoch ${current.epoch}`);
      }
      const token = randomBytes(32).toString("base64url");
      const epoch = current.epoch + 1;
      const expiresAt = now + options.leaseMs;
      const changed = this.state.connection
        .prepare(
          `UPDATE workflow_server_state
           SET epoch = ?, server_id = ?, token_hash = ?, pid = ?, process_start_identity = ?,
               started_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE id = 1 AND epoch = ? AND (server_id IS NULL OR expires_at IS NULL OR expires_at <= ?)`,
        )
        .run(
          epoch,
          options.serverId,
          tokenHash(token),
          options.pid,
          options.processStartIdentity,
          now,
          now,
          expiresAt,
          current.epoch,
          now,
        );
      if (changed.changes !== 1)
        throw new Error("Pi Workflows server claim changed during startup");
      return {
        serverId: options.serverId,
        token,
        epoch,
        pid: options.pid,
        processStartIdentity: options.processStartIdentity,
        expiresAt,
      };
    });
  }

  renewServer(claim: ServerClaim, leaseMs: number, now: number = Date.now()): ServerClaim {
    requireLeaseMs(leaseMs);
    return this.state.transaction(() => {
      const expiresAt = now + leaseMs;
      const changed = this.state.connection
        .prepare(
          `UPDATE workflow_server_state SET heartbeat_at = ?, expires_at = ?
           WHERE id = 1 AND epoch = ? AND server_id = ? AND token_hash = ?
             AND pid = ? AND process_start_identity = ? AND expires_at > ?`,
        )
        .run(
          now,
          expiresAt,
          claim.epoch,
          claim.serverId,
          tokenHash(claim.token),
          claim.pid,
          claim.processStartIdentity,
          now,
        );
      if (changed.changes !== 1) throw new Error("Pi Workflows server claim lost");
      return { ...claim, expiresAt };
    });
  }

  releaseServer(claim: ServerClaim, _now: number = Date.now()): boolean {
    return this.state.transaction(
      () =>
        this.state.connection
          .prepare(
            `UPDATE workflow_server_state
             SET server_id = NULL, token_hash = NULL, pid = NULL, process_start_identity = NULL,
                 started_at = NULL, heartbeat_at = NULL, expires_at = NULL
             WHERE id = 1 AND epoch = ? AND server_id = ? AND token_hash = ?
               AND pid = ? AND process_start_identity = ?`,
          )
          .run(
            claim.epoch,
            claim.serverId,
            tokenHash(claim.token),
            claim.pid,
            claim.processStartIdentity,
          ).changes === 1,
    );
  }

  serverStatus(now: number = Date.now()): WorkflowServerStatusRecord {
    const row = this.serverRow();
    return {
      epoch: row.epoch,
      serverId: row.serverId,
      pid: row.pid,
      processStartIdentity: row.processStartIdentity,
      startedAt: iso(row.startedAt),
      heartbeatAt: iso(row.heartbeatAt),
      expiresAt: iso(row.expiresAt),
      live: row.serverId !== null && row.expiresAt !== null && row.expiresAt > now,
    };
  }

  readCommand(request: ClientRequest): ClientResponse | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_fingerprint AS clientRequestFingerprint, outcome, accepted_revision AS revision,
                receipt_hash AS receiptHash, error_hash AS errorHash
         FROM server_commands WHERE request_id = ?`,
      )
      .get(request.requestId);
    if (!isCommandRow(row)) return undefined;
    if (!row.clientRequestFingerprint.equals(clientRequestFingerprint(request))) {
      return conflictResponse(request.requestId, "Request ID was reused with another payload");
    }
    return this.commandResponse(request.requestId, row);
  }

  adoptCommand(request: ClientRequest): ClientResponse | undefined {
    const existing = this.readCommand(request);
    if (existing !== undefined) {
      return existing.outcome === "accepted" || existing.outcome === "adopted"
        ? { ...existing, outcome: "adopted" }
        : existing;
    }
    const idempotent = this.state.connection
      .prepare(
        `SELECT request_id AS requestId, request_fingerprint AS clientRequestFingerprint,
                outcome, accepted_revision AS revision, receipt_hash AS receiptHash,
                error_hash AS errorHash
         FROM server_commands WHERE client_id = ? AND idempotency_key = ?`,
      )
      .get(request.clientId, request.idempotencyKey);
    if (!isIdempotentCommandRow(idempotent)) return undefined;
    if (!idempotent.clientRequestFingerprint.equals(clientRequestFingerprint(request))) {
      return conflictResponse(request.requestId, "Idempotency key was reused with another payload");
    }
    const adopted = this.commandResponse(idempotent.requestId, idempotent);
    return {
      ...adopted,
      requestId: request.requestId,
      ...(adopted.outcome === "accepted" || adopted.outcome === "adopted"
        ? { outcome: "adopted" as const }
        : {}),
    };
  }

  executeCommand(
    request: ClientRequest,
    serverEpoch: number,
    operation: () => Omit<ClientResponse, "schema" | "type" | "requestId">,
  ): ClientResponse {
    const existing = this.adoptCommand(request);
    if (existing !== undefined) return existing;
    return this.state.transaction(() => {
      const idempotent = this.adoptCommand(request);
      if (idempotent !== undefined) return idempotent;

      const result = operation();
      const response: ClientResponse = {
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "response",
        requestId: request.requestId,
        ...result,
      };
      const now = Date.now();
      const receiptHash =
        response.receipt === undefined ? null : this.state.putJson(response.receipt, now);
      const errorHash =
        response.error === undefined ? null : this.state.putText(response.error, now);
      this.state.connection
        .prepare(
          `INSERT INTO server_commands(
             request_id, client_id, operation, idempotency_key, request_fingerprint,
             run_id, accepted_revision, outcome, receipt_hash, error_hash,
             server_epoch, created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          request.clientId,
          request.operation,
          request.idempotencyKey,
          clientRequestFingerprint(request),
          request.runId ?? null,
          response.revision ?? null,
          response.outcome,
          receiptHash,
          errorHash,
          serverEpoch,
          now,
          now,
        );
      return response;
    });
  }

  recordRunnerStart(envelope: WorkflowRunnerLaunchEnvelope, serverEpoch: number): void {
    const now = Date.now();
    this.state.transaction(() => {
      const launchHash = this.state.putJson(envelope, now);
      this.state.connection
        .prepare(
          `INSERT INTO run_runners(
             runner_epoch, run_id, generation, server_epoch, launch_envelope_hash,
             status, started_at
           ) VALUES (?, ?, ?, ?, ?, 'starting', ?)`,
        )
        .run(
          envelope.runnerEpoch,
          envelope.runId,
          envelope.generation,
          serverEpoch,
          launchHash,
          now,
        );
    });
  }

  attachRunnerProcess(runnerEpoch: string, pid: number, processStartIdentity: string): void {
    const changed = this.state.connection
      .prepare(
        `UPDATE run_runners SET pid = ?, process_start_identity = ?
         WHERE runner_epoch = ? AND status = 'starting' AND pid IS NULL`,
      )
      .run(pid, processStartIdentity, runnerEpoch);
    if (changed.changes !== 1) throw new Error(`Runner epoch is not starting: ${runnerEpoch}`);
  }

  markRunnerReady(runnerEpoch: string): void {
    const now = Date.now();
    const changed = this.state.connection
      .prepare(
        `UPDATE run_runners SET status = 'running', ready_at = ?
         WHERE runner_epoch = ? AND status = 'starting'`,
      )
      .run(now, runnerEpoch);
    if (changed.changes !== 1) throw new Error(`Runner epoch cannot become ready: ${runnerEpoch}`);
  }

  finishRunner(options: {
    runnerEpoch: string;
    outcome: RunnerOutcome;
    exitCode?: number | null;
    signal?: string | null;
    diagnostic?: string;
  }): void {
    const now = Date.now();
    this.state.transaction(() => {
      const diagnosticHash =
        options.diagnostic === undefined ? null : this.state.putText(options.diagnostic, now);
      const changed = this.state.connection
        .prepare(
          `UPDATE run_runners
           SET status = ?, finished_at = ?, exit_code = ?, signal = ?, diagnostic_hash = ?
           WHERE runner_epoch = ? AND status IN ('starting', 'ready', 'running')`,
        )
        .run(
          options.outcome,
          now,
          options.exitCode ?? null,
          options.signal ?? null,
          diagnosticHash,
          options.runnerEpoch,
        );
      if (changed.changes !== 1)
        throw new Error(`Runner epoch is not active: ${options.runnerEpoch}`);
    });
  }

  readRunnerMessage(message: WorkflowRunnerMessage): WorkflowRunnerResponse | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_fingerprint AS clientRequestFingerprint, outcome,
                accepted_revision AS revision, result_hash AS resultHash, error_hash AS errorHash
         FROM runner_messages WHERE runner_epoch = ? AND message_id = ?`,
      )
      .get(message.runnerEpoch, message.messageId);
    if (!isRunnerMessageRow(row)) return undefined;
    if (!row.clientRequestFingerprint.equals(runnerMessageFingerprint(message))) {
      return {
        schema: "pi-workflows.runner-response.v1",
        messageId: message.messageId,
        outcome: "rejected",
        error: "Runner message ID was reused with another payload",
      };
    }
    return runnerMessageResponse(this.state, message.messageId, row);
  }

  recordRunnerMessage(
    message: WorkflowRunnerMessage,
    response: WorkflowRunnerResponse,
  ): WorkflowRunnerResponse {
    return this.state.transaction(() => {
      const existing = this.readRunnerMessage(message);
      if (existing !== undefined) return existing;
      const now = Date.now();
      const resultHash =
        response.result === undefined ? null : this.state.putJson(response.result, now);
      const errorHash =
        response.error === undefined ? null : this.state.putText(response.error, now);
      this.state.connection
        .prepare(
          `INSERT INTO runner_messages(
             runner_epoch, message_id, request_fingerprint, outcome, accepted_revision,
             result_hash, error_hash, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.runnerEpoch,
          message.messageId,
          runnerMessageFingerprint(message),
          response.outcome,
          response.revision ?? null,
          resultHash,
          errorHash,
          now,
        );
      return response;
    });
  }

  createInteractiveRequest(options: {
    requestId: string;
    runId: string;
    attemptId: string;
    targetSessionId: string;
    kind: InteractiveRequestRecord["kind"];
    contract: JsonValue;
  }): InteractiveRequestRecord {
    return this.state.transaction(() => {
      const request = ensureWorkflowRequest(this.state, options);
      if (request.status === "pending") this.ensureInteractionMessage(request, "initial");
      return request;
    });
  }

  ensureInteractionMessage(
    request: InteractiveRequestRecord,
    reason: WorkflowStepReason,
    now: number = Date.now(),
    reminderTurnId?: string,
  ) {
    const kind = request.kind === "decision" || request.kind === "checkpoint" ? "decision" : "step";
    const idempotencyKey = `${request.revision}:${reason}${reminderTurnId === undefined ? "" : `:${reminderTurnId}`}`;
    const workflowMessageId = workflowMessageIdFor(kind, request.requestId, idempotencyKey);
    const content =
      kind === "decision"
        ? (request.kind === "checkpoint"
            ? checkpointWorkflowMessageContent
            : decisionWorkflowMessageContent)({
            workflowMessageId,
            requestId: request.requestId,
            runId: request.runId,
            contract: request.contract,
          })
        : stepWorkflowMessageContent({
            workflowMessageId,
            requestId: request.requestId,
            contract: request.contract,
            reason,
          });
    return this.workflowMessages.create({
      workflowMessageId,
      runId: request.runId,
      targetSessionId: request.targetSessionId,
      kind,
      sourceId: request.requestId,
      idempotencyKey,
      content,
      now,
    });
  }

  resumePendingInteraction(runId: string, now: number = Date.now()): InteractiveRequestRecord {
    return this.state.transaction(() => {
      const row = this.state.connection
        .prepare(
          `SELECT request_id AS requestId FROM interactive_requests
           WHERE run_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1`,
        )
        .get(runId);
      if (!isRequestIdRow(row)) throw new Error("Pending workflow interaction is missing");
      const current = this.requireInteractiveRequest(row.requestId);
      if (current.kind === "decision" || current.kind === "checkpoint") return current;
      this.workflowMessages.cancelPendingForSource(current.requestId, "step", now);
      const changed = this.state.connection
        .prepare(
          `UPDATE interactive_requests SET revision = revision + 1, updated_at = ?
           WHERE request_id = ? AND status = 'pending'`,
        )
        .run(now, row.requestId);
      if (changed.changes !== 1) throw new Error("Pending workflow interaction resume is stale");
      const request = this.requireInteractiveRequest(row.requestId);
      this.ensureInteractionMessage(request, "resumed", now);
      return request;
    });
  }

  syncActiveTime(): void {
    this.attemptTime.sample();
  }

  /** Whether the run is durably paused, so it can act on nothing yet. */
  isRunPaused(runId: string): boolean {
    const row = this.state.connection
      .prepare("SELECT paused FROM runs WHERE run_id = ?")
      .get(runId) as { paused: number } | undefined;
    return (row?.paused ?? 0) !== 0;
  }

  beginInteractionModelTurn(requestId: string): void {
    const request = this.requireInteractiveRequest(requestId);
    if (request.status !== "pending" || !["agent", "assistant"].includes(request.kind)) {
      throw new Error("Only a pending agent request can start active model time");
    }
    const run = this.state.connection
      .prepare("SELECT paused FROM runs WHERE run_id = ?")
      .get(request.runId) as { paused: number };
    if (run.paused !== 0) throw new Error("Paused workflow cannot start active model time");
    this.attemptTime.start(request.attemptId);
  }

  endInteractionModelTurn(requestId: string): void {
    this.attemptTime.stop(this.requireInteractiveRequest(requestId).attemptId);
  }

  resumeInteractionModelTurn(runId: string): void {
    const rows = this.state.connection
      .prepare(
        `SELECT DISTINCT i.attempt_id AS attemptId FROM interactive_requests i
       JOIN runs r ON r.run_id = i.run_id
       JOIN workflow_messages m ON m.source_id = i.request_id AND m.kind = 'step'
       JOIN workflow_turns t ON t.workflow_message_id = m.workflow_message_id AND t.state = 'started'
       WHERE i.run_id = ? AND i.status = 'pending' AND r.paused = 0`,
      )
      .all(runId) as { attemptId: string }[];
    for (const row of rows) {
      this.attemptTime.start(row.attemptId);
      this.state.connection
        .prepare("UPDATE node_attempts SET status = 'waiting' WHERE attempt_id = ?")
        .run(row.attemptId);
    }
  }

  markSessionModelTurnsInactive(targetSessionId: string, now: number = Date.now()): void {
    const rows = this.state.connection
      .prepare(
        `SELECT DISTINCT i.attempt_id AS attemptId FROM interactive_requests i
       JOIN workflow_messages m ON m.source_id = i.request_id AND m.kind = 'step'
       JOIN workflow_turns t ON t.workflow_message_id = m.workflow_message_id AND t.state = 'started'
       WHERE i.target_session_id = ? AND i.status = 'pending'`,
      )
      .all(targetSessionId) as { attemptId: string }[];
    for (const row of rows) {
      this.attemptTime.stop(row.attemptId);
      this.state.connection
        .prepare(
          "UPDATE node_attempts SET status = 'interrupted', updated_at = ? WHERE attempt_id = ?",
        )
        .run(now, row.attemptId);
    }
  }

  recoverInactiveModelTurns(now: number = Date.now()): void {
    this.attemptTime.recover();
    this.state.connection
      .prepare(
        `UPDATE node_attempts SET status = 'interrupted', updated_at = ? WHERE attempt_id IN (
         SELECT i.attempt_id FROM interactive_requests i
         JOIN workflow_messages m ON m.source_id = i.request_id AND m.kind = 'step'
         JOIN workflow_turns t ON t.workflow_message_id = m.workflow_message_id AND t.state = 'started'
         WHERE i.status = 'pending'
       )`,
      )
      .run(now);
  }

  resumeSessionModelTurns(targetSessionId: string, now: number = Date.now()): void {
    const rows = this.state.connection
      .prepare(
        `SELECT DISTINCT i.attempt_id AS attemptId FROM interactive_requests i
       JOIN runs r ON r.run_id = i.run_id
       JOIN node_attempts a ON a.attempt_id = i.attempt_id
       JOIN workflow_messages m ON m.source_id = i.request_id AND m.kind = 'step'
       JOIN workflow_turns t ON t.workflow_message_id = m.workflow_message_id AND t.state = 'started'
       WHERE i.target_session_id = ? AND i.status = 'pending' AND r.paused = 0 AND a.status = 'interrupted'`,
      )
      .all(targetSessionId) as { attemptId: string }[];
    for (const row of rows) {
      this.attemptTime.start(row.attemptId);
      this.state.connection
        .prepare("UPDATE node_attempts SET status = 'waiting', updated_at = ? WHERE attempt_id = ?")
        .run(now, row.attemptId);
    }
  }

  getInteraction(requestId: string): InteractiveRequestRecord | undefined {
    return this.interactiveRequest(requestId);
  }

  acceptedInteraction(runId: string):
    | {
        requestId: string;
        attemptId: string;
        nodeId: string;
        submissionId: string;
        payload: JsonValue;
      }
    | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT i.request_id AS requestId, i.attempt_id AS attemptId, a.node_id AS nodeId,
                s.submission_id AS submissionId, s.payload_hash AS payloadHash
         FROM interactive_requests i
         JOIN node_attempts a ON a.attempt_id = i.attempt_id
         JOIN interactive_submissions s ON s.submission_id = i.accepted_submission_id
         WHERE i.run_id = ? AND i.status = 'settled' AND i.consumed_at IS NULL
         ORDER BY i.settled_at DESC LIMIT 1`,
      )
      .get(runId);
    if (!isAcceptedInteractionRow(row)) return undefined;
    return {
      requestId: row.requestId,
      attemptId: row.attemptId,
      nodeId: row.nodeId,
      submissionId: row.submissionId,
      payload: this.state.readJson(row.payloadHash),
    };
  }

  validatingInteraction(runId: string):
    | {
        requestId: string;
        attemptId: string;
        nodeId: string;
        submissionId: string;
        payload: JsonValue;
      }
    | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT i.request_id AS requestId, i.attempt_id AS attemptId, a.node_id AS nodeId,
                s.submission_id AS submissionId, s.payload_hash AS payloadHash
         FROM interactive_requests i
         JOIN node_attempts a ON a.attempt_id = i.attempt_id
         JOIN interactive_submissions s ON s.request_id = i.request_id
         WHERE i.run_id = ? AND i.status = 'pending'
           AND s.outcome = 'validating'
         ORDER BY s.submitted_at DESC LIMIT 1`,
      )
      .get(runId);
    if (!isAcceptedInteractionRow(row)) return undefined;
    return {
      requestId: row.requestId,
      attemptId: row.attemptId,
      nodeId: row.nodeId,
      submissionId: row.submissionId,
      payload: this.state.readJson(row.payloadHash),
    };
  }

  readyInteractionRunIds(): string[] {
    return this.state.connection
      .prepare(
        `SELECT i.run_id AS runId
         FROM interactive_requests i
         JOIN interactive_submissions s ON s.request_id = i.request_id
         JOIN run_queue q ON q.run_id = i.run_id
         JOIN node_attempts a ON a.attempt_id = i.attempt_id
         WHERE ((i.status = 'pending' AND s.outcome = 'validating')
             OR (i.status = 'settled' AND i.accepted_submission_id = s.submission_id
                 AND s.outcome = 'accepted' AND i.consumed_at IS NULL))
           AND a.status IN ('pending', 'running', 'waiting', 'interrupted')
           AND q.status NOT IN ('done', 'failed', 'cancelled')
         GROUP BY i.run_id
         ORDER BY MIN(s.submitted_at), i.run_id`,
      )
      .all()
      .flatMap((row) => (isRunIdRow(row) ? [row.runId] : []));
  }

  expiredInteractionRuns(): ExpiredInteractionRunRow[] {
    return this.state.connection
      .prepare(
        `SELECT i.run_id AS runId, i.target_session_id AS targetSessionId
       FROM interactive_requests i
       JOIN node_attempts a ON a.attempt_id = i.attempt_id
       JOIN runs r ON r.run_id = i.run_id
       JOIN run_queue q ON q.run_id = i.run_id
       WHERE i.status = 'pending' AND r.paused = 0 AND a.timeout_ms > 0
         AND (SELECT COALESCE(SUM(elapsed_ms), 0) FROM attempt_active_intervals t
              WHERE t.attempt_id = a.attempt_id) >= a.timeout_ms
         AND q.status NOT IN ('done', 'failed', 'cancelled')
       GROUP BY i.run_id, i.target_session_id ORDER BY MIN(a.started_at), i.run_id`,
      )
      .all()
      .filter(isExpiredInteractionRunRow);
  }

  timedOutInteraction(runId: string): TimedOutInteractionRow | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT i.request_id AS requestId, i.attempt_id AS attemptId, a.node_id AS nodeId
       FROM interactive_requests i
       JOIN node_attempts a ON a.attempt_id = i.attempt_id
       JOIN runs r ON r.run_id = i.run_id
       WHERE i.run_id = ? AND i.status = 'cancelled' AND r.status = 'running'
         AND r.paused = 0 AND a.timeout_ms > 0
         AND (SELECT COALESCE(SUM(elapsed_ms), 0) FROM attempt_active_intervals t
              WHERE t.attempt_id = a.attempt_id) >= a.timeout_ms
         AND a.status IN ('pending', 'running', 'waiting', 'interrupted', 'timed_out')
       ORDER BY a.started_at, i.request_id LIMIT 1`,
      )
      .get(runId);
    return isTimedOutInteractionRow(row) ? row : undefined;
  }

  interactionSubmission(
    requestId: string,
    submissionId: string,
  ): InteractiveSubmissionRecord | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_id AS requestId, submission_id AS submissionId,
                idempotency_key AS idempotencyKey, outcome, payload_hash AS payloadHash,
                receipt_hash AS receiptHash, submitted_at AS submittedAt
         FROM interactive_submissions WHERE request_id = ? AND submission_id = ?`,
      )
      .get(requestId, submissionId);
    if (!isSubmissionDetailRow(row)) return undefined;
    return {
      requestId: row.requestId,
      submissionId: row.submissionId,
      idempotencyKey: row.idempotencyKey,
      outcome: row.outcome,
      payload: this.state.readJson(row.payloadHash),
      receipt: row.receiptHash === null ? null : this.state.readJson(row.receiptHash),
      submittedAt: new Date(row.submittedAt).toISOString(),
    };
  }

  finishInteractionValidation(options: {
    requestId: string;
    submissionId: string;
    accepted: boolean;
    receipt: JsonValue;
  }): InteractiveSubmissionRecord {
    const now = Date.now();
    return this.state.transaction(() => {
      const submission = this.interactionSubmission(options.requestId, options.submissionId);
      const expectedOutcome = options.accepted ? "accepted" : "rejected";
      if (submission?.outcome === expectedOutcome) return submission;
      if (submission === undefined || submission.outcome !== "validating") {
        throw new Error("Interactive submission is not awaiting validation");
      }
      const request = this.requireInteractiveRequest(options.requestId);
      const receiptHash = this.state.putJson(options.receipt, now);
      this.state.connection
        .prepare(
          `UPDATE interactive_submissions SET outcome = ?, receipt_hash = ?
           WHERE request_id = ? AND submission_id = ? AND outcome = 'validating'`,
        )
        .run(
          options.accepted ? "accepted" : "rejected",
          receiptHash,
          options.requestId,
          options.submissionId,
        );
      if (options.accepted) {
        const changed = this.state.connection
          .prepare(
            `UPDATE interactive_requests
             SET status = 'settled', accepted_submission_id = ?,
                 revision = revision + 1, updated_at = ?, settled_at = ?
             WHERE request_id = ? AND revision = ? AND status = 'pending'`,
          )
          .run(options.submissionId, now, now, options.requestId, request.revision);
        if (changed.changes !== 1) throw new Error("Interactive request validation is stale");
        this.workflowMessages.cancelPendingForSource(options.requestId, "step", now);
        this.workflowMessages.cancelPendingForSource(options.requestId, "decision", now);
      }
      const settled = this.interactionSubmission(options.requestId, options.submissionId);
      if (settled === undefined) throw new Error("Interactive submission result is missing");
      return settled;
    });
  }

  listPendingInteractions(sessionId: string): InteractiveRequestRecord[] {
    return this.state.connection
      .prepare(
        `SELECT request_id AS requestId FROM interactive_requests
         WHERE target_session_id = ? AND status = 'pending'
         ORDER BY created_at, request_id`,
      )
      .all(sessionId)
      .flatMap((row) =>
        isRequestIdRow(row) ? [this.requireInteractiveRequest(row.requestId)] : [],
      );
  }

  listPendingDecisionInteractions(): InteractiveRequestRecord[] {
    return this.state.connection
      .prepare(
        `SELECT request_id AS requestId FROM interactive_requests
         WHERE kind = 'decision' AND status = 'pending'
         ORDER BY created_at, request_id`,
      )
      .all()
      .flatMap((row) =>
        isRequestIdRow(row) ? [this.requireInteractiveRequest(row.requestId)] : [],
      );
  }

  submitInteraction(options: {
    requestId: string;
    submissionId: string;
    idempotencyKey: string;
    expectedRevision: number;
    payload: JsonValue;
    accepted: boolean;
    receipt?: JsonValue;
  }): {
    interaction: InteractiveRequestRecord;
    submissionId: string;
    outcome: "accepted" | "adopted";
    receipt: JsonValue;
  } {
    return recordWorkflowSubmission(this.state, {
      ...options,
      outcome: options.accepted ? "accepted" : "rejected",
      settle: options.accepted,
    });
  }

  hasInteractionSubmission(requestId: string, idempotencyKey: string): boolean {
    return (
      this.state.connection
        .prepare(
          "SELECT 1 FROM interactive_submissions WHERE request_id = ? AND idempotency_key = ?",
        )
        .get(requestId, idempotencyKey) !== undefined
    );
  }

  interactionTimedOut(requestId: string): boolean {
    const rows = this.state.connection
      .prepare(
        `SELECT e.payload_hash AS payloadHash
         FROM interactive_requests i
         JOIN runs r ON r.run_id = i.run_id
         JOIN events e ON e.resource_id = r.resource_id
         WHERE i.request_id = ? AND e.event_type = 'run.interaction_timeout_started'
         ORDER BY e.event_seq DESC`,
      )
      .all(requestId) as Array<{ payloadHash: Buffer | null }>;
    return rows.some((row) => {
      if (row.payloadHash === null) return false;
      const payload = this.state.readJson(row.payloadHash);
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.requestId === requestId
      );
    });
  }

  beginInteractionValidation(options: {
    requestId: string;
    submissionId: string;
    idempotencyKey: string;
    expectedRevision: number;
    payload: JsonValue;
    receipt?: JsonValue;
  }): {
    interaction: InteractiveRequestRecord;
    submissionId: string;
    outcome: "accepted" | "adopted";
    receipt: JsonValue;
  } {
    return recordWorkflowSubmission(this.state, {
      ...options,
      outcome: "validating",
      settle: false,
    });
  }

  private serverRow(): ServerRow {
    const row = this.state.connection
      .prepare(
        `SELECT epoch, server_id AS serverId, token_hash AS tokenHash, pid,
                process_start_identity AS processStartIdentity, started_at AS startedAt,
                heartbeat_at AS heartbeatAt, expires_at AS expiresAt
         FROM workflow_server_state WHERE id = 1`,
      )
      .get();
    if (!isServerRow(row)) throw new Error("Pi Workflows server state is missing");
    return row;
  }

  private commandResponse(requestId: string, row: CommandRow): ClientResponse {
    const receipt = row.receiptHash === null ? undefined : this.state.readJson(row.receiptHash);
    const error =
      row.errorHash === null
        ? undefined
        : this.state.readBlob(row.errorHash)?.content.toString("utf8");
    return {
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId,
      outcome: row.outcome,
      ...(row.revision === null ? {} : { revision: row.revision }),
      ...(receipt === undefined ? {} : { receipt }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private interactiveRequest(requestId: string): InteractiveRequestRecord | undefined {
    return readWorkflowRequest(this.state, requestId);
  }

  private requireInteractiveRequest(requestId: string): InteractiveRequestRecord {
    const request = this.interactiveRequest(requestId);
    if (request === undefined) throw new Error(`Interactive request not found: ${requestId}`);
    return request;
  }
}

function conflictResponse(requestId: string, error: string): ClientResponse {
  return {
    schema: CLIENT_PROTOCOL_SCHEMA,
    type: "response",
    requestId,
    outcome: "conflict",
    error,
  };
}

function requireLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Server lease duration must be positive");
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

type ServerRow = {
  epoch: number;
  serverId: string | null;
  tokenHash: Buffer | null;
  pid: number | null;
  processStartIdentity: string | null;
  startedAt: number | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
};

type CommandRow = {
  clientRequestFingerprint: Buffer;
  outcome: ClientResponse["outcome"];
  revision: number | null;
  receiptHash: Buffer | null;
  errorHash: Buffer | null;
};

type IdempotentCommandRow = CommandRow & { requestId: string };
type RequestIdRow = { requestId: string };
type RunIdRow = { runId: string };
type SubmissionDetailRow = {
  requestId: string;
  submissionId: string;
  idempotencyKey: string;
  outcome: InteractiveSubmissionRecord["outcome"];
  payloadHash: Buffer;
  receiptHash: Buffer | null;
  submittedAt: number;
};
type WorkflowRunnerMessageRow = {
  clientRequestFingerprint: Buffer;
  outcome: WorkflowRunnerResponse["outcome"];
  revision: number | null;
  resultHash: Buffer | null;
  errorHash: Buffer | null;
};
type AcceptedInteractionRow = {
  requestId: string;
  attemptId: string;
  nodeId: string;
  submissionId: string;
  payloadHash: Buffer;
};
type ExpiredInteractionRunRow = { runId: string; targetSessionId: string };
type TimedOutInteractionRow = {
  requestId: string;
  attemptId: string;
  nodeId: string;
};

function isServerRow(value: unknown): value is ServerRow {
  return (
    isRecord(value) &&
    typeof value.epoch === "number" &&
    nullableString(value.serverId) &&
    (value.tokenHash === null || Buffer.isBuffer(value.tokenHash)) &&
    (value.pid === null || typeof value.pid === "number") &&
    nullableString(value.processStartIdentity) &&
    nullableNumber(value.startedAt) &&
    nullableNumber(value.heartbeatAt) &&
    nullableNumber(value.expiresAt)
  );
}

function isCommandRow(value: unknown): value is CommandRow {
  return (
    isRecord(value) &&
    Buffer.isBuffer(value.clientRequestFingerprint) &&
    typeof value.outcome === "string" &&
    nullableNumber(value.revision) &&
    (value.receiptHash === null || Buffer.isBuffer(value.receiptHash)) &&
    (value.errorHash === null || Buffer.isBuffer(value.errorHash))
  );
}

function isIdempotentCommandRow(value: unknown): value is IdempotentCommandRow {
  return (
    isRecord(value) &&
    isCommandRow(value) &&
    typeof (value as Record<string, unknown>).requestId === "string"
  );
}

function isRequestIdRow(value: unknown): value is RequestIdRow {
  return isRecord(value) && typeof value.requestId === "string";
}

function isRunIdRow(value: unknown): value is RunIdRow {
  return isRecord(value) && typeof value.runId === "string";
}

function isRunnerMessageRow(value: unknown): value is WorkflowRunnerMessageRow {
  return (
    isRecord(value) &&
    Buffer.isBuffer(value.clientRequestFingerprint) &&
    ["accepted", "adopted", "rejected", "claimLost"].includes(value.outcome as string) &&
    nullableNumber(value.revision) &&
    (value.resultHash === null || Buffer.isBuffer(value.resultHash)) &&
    (value.errorHash === null || Buffer.isBuffer(value.errorHash))
  );
}

function isAcceptedInteractionRow(value: unknown): value is AcceptedInteractionRow {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.submissionId === "string" &&
    Buffer.isBuffer(value.payloadHash)
  );
}

function isTimedOutInteractionRow(value: unknown): value is TimedOutInteractionRow {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.nodeId === "string"
  );
}

function isExpiredInteractionRunRow(value: unknown): value is ExpiredInteractionRunRow {
  return (
    isRecord(value) && typeof value.runId === "string" && typeof value.targetSessionId === "string"
  );
}

function isSubmissionDetailRow(value: unknown): value is SubmissionDetailRow {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.submissionId === "string" &&
    typeof value.idempotencyKey === "string" &&
    ["validating", "accepted", "rejected", "adopted"].includes(value.outcome as string) &&
    Buffer.isBuffer(value.payloadHash) &&
    (value.receiptHash === null || Buffer.isBuffer(value.receiptHash)) &&
    typeof value.submittedAt === "number"
  );
}

function runnerMessageFingerprint(message: WorkflowRunnerMessage): Buffer {
  return createHash("sha256").update(canonicalJson(message)).digest();
}

function runnerMessageResponse(
  state: StateDatabase,
  messageId: string,
  row: WorkflowRunnerMessageRow,
): WorkflowRunnerResponse {
  const result = row.resultHash === null ? undefined : state.readJson(row.resultHash);
  const error =
    row.errorHash === null ? undefined : state.readBlob(row.errorHash)?.content.toString("utf8");
  return {
    schema: "pi-workflows.runner-response.v1",
    messageId,
    outcome: row.outcome,
    ...(row.revision === null ? {} : { revision: row.revision }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
