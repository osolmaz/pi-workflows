import { createHash, randomBytes } from "node:crypto";
import { StateDatabase } from "../state/database.js";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { tokenHash } from "../state/mutation.js";
import type { HostRequest, HostResponse } from "./protocol.js";
import { requestFingerprint } from "./protocol.js";
import type { WorkerMessage, WorkerResponse } from "./worker-protocol.js";

export type HostClaim = {
  hostId: string;
  token: string;
  epoch: number;
  pid: number;
  processStartIdentity: string;
  expiresAt: number;
};

export type HostStatusRecord = {
  epoch: number;
  hostId: string | null;
  pid: number | null;
  processStartIdentity: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  live: boolean;
};

export type WorkerLaunchEnvelope = {
  schema: "pi-workflows.worker-launch.v1";
  runId: string;
  generation: number;
  workerEpoch: string;
  projectPath: string;
  workflowSource: JsonValue;
  definitionDigest: string;
  inputHash: string;
  protocolVersion: 1;
};

export type WorkerOutcome =
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

export type InteractiveRequestRecord = {
  requestId: string;
  runId: string;
  attemptId: string;
  targetSessionId: string;
  kind: "agent" | "assistant" | "decision";
  contract: JsonValue;
  revision: number;
  status: "pending" | "presenting" | "settled" | "cancelled";
  presentationSessionEntryId: string | null;
  acceptedSubmissionId: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  consumedAt: string | null;
};

export class HostStateStore {
  readonly state: StateDatabase;
  private readonly ownsState: boolean;

  constructor(databasePath: string, options: { state?: StateDatabase; readOnly?: boolean } = {}) {
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath: databasePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
      });
  }

  close(): void {
    if (this.ownsState) this.state.close();
  }

  acquireHost(options: {
    hostId: string;
    pid: number;
    processStartIdentity: string;
    leaseMs: number;
    now?: number;
  }): HostClaim {
    const now = options.now ?? Date.now();
    requireLeaseMs(options.leaseMs);
    return this.state.transaction(() => {
      const current = this.hostRow();
      if (current.hostId !== null && current.expiresAt !== null && current.expiresAt > now) {
        throw new Error(`A live Pi Workflows host already owns epoch ${current.epoch}`);
      }
      const token = randomBytes(32).toString("base64url");
      const epoch = current.epoch + 1;
      const expiresAt = now + options.leaseMs;
      const changed = this.state.connection
        .prepare(
          `UPDATE workflow_host_state
           SET epoch = ?, host_id = ?, token_hash = ?, pid = ?, process_start_identity = ?,
               started_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE id = 1 AND epoch = ? AND (host_id IS NULL OR expires_at IS NULL OR expires_at <= ?)`,
        )
        .run(
          epoch,
          options.hostId,
          tokenHash(token),
          options.pid,
          options.processStartIdentity,
          now,
          now,
          expiresAt,
          current.epoch,
          now,
        );
      if (changed.changes !== 1) throw new Error("Pi Workflows host claim changed during startup");
      return {
        hostId: options.hostId,
        token,
        epoch,
        pid: options.pid,
        processStartIdentity: options.processStartIdentity,
        expiresAt,
      };
    });
  }

  renewHost(claim: HostClaim, leaseMs: number, now: number = Date.now()): HostClaim {
    requireLeaseMs(leaseMs);
    return this.state.transaction(() => {
      const expiresAt = now + leaseMs;
      const changed = this.state.connection
        .prepare(
          `UPDATE workflow_host_state SET heartbeat_at = ?, expires_at = ?
           WHERE id = 1 AND epoch = ? AND host_id = ? AND token_hash = ?
             AND pid = ? AND process_start_identity = ? AND expires_at > ?`,
        )
        .run(
          now,
          expiresAt,
          claim.epoch,
          claim.hostId,
          tokenHash(claim.token),
          claim.pid,
          claim.processStartIdentity,
          now,
        );
      if (changed.changes !== 1) throw new Error("Pi Workflows host claim lost");
      return { ...claim, expiresAt };
    });
  }

  releaseHost(claim: HostClaim, _now: number = Date.now()): boolean {
    return this.state.transaction(
      () =>
        this.state.connection
          .prepare(
            `UPDATE workflow_host_state
             SET host_id = NULL, token_hash = NULL, pid = NULL, process_start_identity = NULL,
                 started_at = NULL, heartbeat_at = NULL, expires_at = NULL
             WHERE id = 1 AND epoch = ? AND host_id = ? AND token_hash = ?
               AND pid = ? AND process_start_identity = ?`,
          )
          .run(
            claim.epoch,
            claim.hostId,
            tokenHash(claim.token),
            claim.pid,
            claim.processStartIdentity,
          ).changes === 1,
    );
  }

  hostStatus(now: number = Date.now()): HostStatusRecord {
    const row = this.hostRow();
    return {
      epoch: row.epoch,
      hostId: row.hostId,
      pid: row.pid,
      processStartIdentity: row.processStartIdentity,
      startedAt: iso(row.startedAt),
      heartbeatAt: iso(row.heartbeatAt),
      expiresAt: iso(row.expiresAt),
      live: row.hostId !== null && row.expiresAt !== null && row.expiresAt > now,
    };
  }

  readCommand(request: HostRequest): HostResponse | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_fingerprint AS requestFingerprint, outcome, accepted_revision AS revision,
                receipt_hash AS receiptHash, error_hash AS errorHash
         FROM host_commands WHERE request_id = ?`,
      )
      .get(request.requestId);
    if (!isCommandRow(row)) return undefined;
    if (!row.requestFingerprint.equals(requestFingerprint(request))) {
      return conflictResponse(request.requestId, "Request ID was reused with another payload");
    }
    return this.commandResponse(request.requestId, row);
  }

  executeCommand(
    request: HostRequest,
    hostEpoch: number,
    operation: () => Omit<HostResponse, "schema" | "requestId">,
  ): HostResponse {
    const existing = this.readCommand(request);
    if (existing !== undefined) {
      return existing.outcome === "conflict" ? existing : { ...existing, outcome: "adopted" };
    }
    return this.state.transaction(() => {
      const idempotent = this.state.connection
        .prepare(
          `SELECT request_id AS requestId, request_fingerprint AS requestFingerprint,
                  outcome, accepted_revision AS revision, receipt_hash AS receiptHash,
                  error_hash AS errorHash
           FROM host_commands WHERE client_id = ? AND idempotency_key = ?`,
        )
        .get(request.clientId, request.idempotencyKey);
      if (isIdempotentCommandRow(idempotent)) {
        if (!idempotent.requestFingerprint.equals(requestFingerprint(request))) {
          return conflictResponse(
            request.requestId,
            "Idempotency key was reused with another payload",
          );
        }
        const adopted = this.commandResponse(idempotent.requestId, idempotent);
        return { ...adopted, requestId: request.requestId, outcome: "adopted" };
      }

      const result = operation();
      const response: HostResponse = {
        schema: "pi-workflows.host-response.v1",
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
          `INSERT INTO host_commands(
             request_id, client_id, operation, idempotency_key, request_fingerprint,
             run_id, accepted_revision, outcome, receipt_hash, error_hash,
             host_epoch, created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          request.clientId,
          request.operation,
          request.idempotencyKey,
          requestFingerprint(request),
          request.runId ?? null,
          response.revision ?? null,
          response.outcome,
          receiptHash,
          errorHash,
          hostEpoch,
          now,
          now,
        );
      return response;
    });
  }

  recordWorkerStart(envelope: WorkerLaunchEnvelope, hostEpoch: number): void {
    const now = Date.now();
    this.state.transaction(() => {
      const launchHash = this.state.putJson(envelope, now);
      this.state.connection
        .prepare(
          `INSERT INTO run_workers(
             worker_epoch, run_id, generation, host_epoch, launch_envelope_hash,
             status, started_at
           ) VALUES (?, ?, ?, ?, ?, 'starting', ?)`,
        )
        .run(envelope.workerEpoch, envelope.runId, envelope.generation, hostEpoch, launchHash, now);
    });
  }

  attachWorkerProcess(workerEpoch: string, pid: number, processStartIdentity: string): void {
    const changed = this.state.connection
      .prepare(
        `UPDATE run_workers SET pid = ?, process_start_identity = ?
         WHERE worker_epoch = ? AND status = 'starting' AND pid IS NULL`,
      )
      .run(pid, processStartIdentity, workerEpoch);
    if (changed.changes !== 1) throw new Error(`Worker epoch is not starting: ${workerEpoch}`);
  }

  markWorkerReady(workerEpoch: string): void {
    const now = Date.now();
    const changed = this.state.connection
      .prepare(
        `UPDATE run_workers SET status = 'running', ready_at = ?
         WHERE worker_epoch = ? AND status = 'starting'`,
      )
      .run(now, workerEpoch);
    if (changed.changes !== 1) throw new Error(`Worker epoch cannot become ready: ${workerEpoch}`);
  }

  finishWorker(options: {
    workerEpoch: string;
    outcome: WorkerOutcome;
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
          `UPDATE run_workers
           SET status = ?, finished_at = ?, exit_code = ?, signal = ?, diagnostic_hash = ?
           WHERE worker_epoch = ? AND status IN ('starting', 'ready', 'running')`,
        )
        .run(
          options.outcome,
          now,
          options.exitCode ?? null,
          options.signal ?? null,
          diagnosticHash,
          options.workerEpoch,
        );
      if (changed.changes !== 1)
        throw new Error(`Worker epoch is not active: ${options.workerEpoch}`);
    });
  }

  readWorkerMessage(message: WorkerMessage): WorkerResponse | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_fingerprint AS requestFingerprint, outcome,
                accepted_revision AS revision, result_hash AS resultHash, error_hash AS errorHash
         FROM worker_messages WHERE worker_epoch = ? AND message_id = ?`,
      )
      .get(message.workerEpoch, message.messageId);
    if (!isWorkerMessageRow(row)) return undefined;
    if (!row.requestFingerprint.equals(workerMessageFingerprint(message))) {
      return {
        schema: "pi-workflows.worker-response.v1",
        messageId: message.messageId,
        outcome: "rejected",
        error: "Worker message ID was reused with another payload",
      };
    }
    return workerMessageResponse(this.state, message.messageId, row);
  }

  recordWorkerMessage(message: WorkerMessage, response: WorkerResponse): WorkerResponse {
    return this.state.transaction(() => {
      const existing = this.readWorkerMessage(message);
      if (existing !== undefined) return existing;
      const now = Date.now();
      const resultHash =
        response.result === undefined ? null : this.state.putJson(response.result, now);
      const errorHash =
        response.error === undefined ? null : this.state.putText(response.error, now);
      this.state.connection
        .prepare(
          `INSERT INTO worker_messages(
             worker_epoch, message_id, request_fingerprint, outcome, accepted_revision,
             result_hash, error_hash, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.workerEpoch,
          message.messageId,
          workerMessageFingerprint(message),
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
    const now = Date.now();
    return this.state.transaction(() => {
      const existing = this.interactiveRequest(options.requestId);
      if (existing !== undefined) {
        if (
          existing.runId !== options.runId ||
          existing.attemptId !== options.attemptId ||
          canonicalJson(existing.contract) !== canonicalJson(options.contract)
        ) {
          throw new Error(`Interactive request conflicts: ${options.requestId}`);
        }
        if (existing.status === "settled" && existing.consumedAt === null) {
          this.state.connection
            .prepare(
              `UPDATE interactive_requests
               SET status = 'pending', presenter_id = NULL,
                   presentation_claim_expires_at = NULL, presentation_session_entry_id = NULL,
                   accepted_submission_id = NULL, settled_at = NULL, consumed_at = NULL,
                   revision = revision + 1, updated_at = ?
               WHERE request_id = ? AND status = 'settled' AND consumed_at IS NULL`,
            )
            .run(now, options.requestId);
          return this.requireInteractiveRequest(options.requestId);
        }
        return existing;
      }
      const contractHash = this.state.putJson(options.contract, now);
      this.state.connection
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
          contractHash,
          now,
          now,
        );
      return this.requireInteractiveRequest(options.requestId);
    });
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
         WHERE i.run_id = ? AND i.status IN ('pending', 'presenting')
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
             SET status = 'settled', presenter_id = NULL,
                 presentation_claim_expires_at = NULL, accepted_submission_id = ?,
                 revision = revision + 1, updated_at = ?, settled_at = ?
             WHERE request_id = ? AND revision = ? AND status IN ('pending', 'presenting')`,
          )
          .run(options.submissionId, now, now, options.requestId, request.revision);
        if (changed.changes !== 1) throw new Error("Interactive request validation is stale");
      }
      const settled = this.interactionSubmission(options.requestId, options.submissionId);
      if (settled === undefined) throw new Error("Interactive submission result is missing");
      return settled;
    });
  }

  consumeAcceptedInteraction(runId: string, attemptId: string, now: number = Date.now()): boolean {
    const changed = this.state.connection
      .prepare(
        `UPDATE interactive_requests SET consumed_at = ?, updated_at = ?
         WHERE run_id = ? AND attempt_id = ? AND status = 'settled'
           AND accepted_submission_id IS NOT NULL AND consumed_at IS NULL`,
      )
      .run(now, now, runId, attemptId);
    return changed.changes === 1;
  }

  listPendingInteractions(sessionId: string): InteractiveRequestRecord[] {
    return this.state.connection
      .prepare(
        `SELECT request_id AS requestId FROM interactive_requests
         WHERE target_session_id = ? AND status IN ('pending', 'presenting')
         ORDER BY created_at, request_id`,
      )
      .all(sessionId)
      .flatMap((row) =>
        isRequestIdRow(row) ? [this.requireInteractiveRequest(row.requestId)] : [],
      );
  }

  claimInteractionPresentation(options: {
    requestId: string;
    expectedRevision: number;
    presenterId: string;
    leaseMs: number;
  }): InteractiveRequestRecord {
    requireLeaseMs(options.leaseMs);
    const now = Date.now();
    const changed = this.state.connection
      .prepare(
        `UPDATE interactive_requests
         SET status = 'presenting', presenter_id = ?, presentation_claim_expires_at = ?,
             revision = revision + 1, updated_at = ?
         WHERE request_id = ? AND revision = ? AND presentation_session_entry_id IS NULL
           AND (
             status = 'pending'
             OR (status = 'presenting' AND (presenter_id = ? OR presentation_claim_expires_at <= ?))
           )`,
      )
      .run(
        options.presenterId,
        now + options.leaseMs,
        now,
        options.requestId,
        options.expectedRevision,
        options.presenterId,
        now,
      );
    if (changed.changes !== 1) throw new Error("Interactive request presentation claim conflict");
    return this.requireInteractiveRequest(options.requestId);
  }

  markInteractionPresented(options: {
    requestId: string;
    expectedRevision: number;
    sessionEntryId: string;
  }): InteractiveRequestRecord {
    const now = Date.now();
    const changed = this.state.connection
      .prepare(
        `UPDATE interactive_requests
         SET status = 'presenting', presenter_id = NULL, presentation_claim_expires_at = NULL,
             presentation_session_entry_id = ?, revision = revision + 1, updated_at = ?
         WHERE request_id = ? AND revision = ? AND status IN ('pending', 'presenting')
           AND (presentation_session_entry_id IS NULL OR presentation_session_entry_id = ?)`,
      )
      .run(
        options.sessionEntryId,
        now,
        options.requestId,
        options.expectedRevision,
        options.sessionEntryId,
      );
    if (changed.changes !== 1) throw new Error("Interactive request presentation conflict");
    return this.requireInteractiveRequest(options.requestId);
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
    outcome: "accepted" | "adopted";
    receipt: JsonValue;
  } {
    return this.recordInteractionSubmission({
      ...options,
      outcome: options.accepted ? "accepted" : "rejected",
      settle: options.accepted,
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
    outcome: "accepted" | "adopted";
    receipt: JsonValue;
  } {
    return this.recordInteractionSubmission({
      ...options,
      outcome: "validating",
      settle: false,
    });
  }

  private recordInteractionSubmission(options: {
    requestId: string;
    submissionId: string;
    idempotencyKey: string;
    expectedRevision: number;
    payload: JsonValue;
    outcome: InteractiveSubmissionRecord["outcome"];
    settle: boolean;
    receipt?: JsonValue;
  }): {
    interaction: InteractiveRequestRecord;
    outcome: "accepted" | "adopted";
    receipt: JsonValue;
  } {
    const now = Date.now();
    return this.state.transaction(() => {
      const existing = this.state.connection
        .prepare(
          `SELECT submission_id AS submissionId, payload_hash AS payloadHash,
                  outcome, receipt_hash AS receiptHash
           FROM interactive_submissions WHERE request_id = ? AND idempotency_key = ?`,
        )
        .get(options.requestId, options.idempotencyKey);
      const payloadHash = createHash("sha256").update(canonicalJson(options.payload)).digest();
      if (isSubmissionRow(existing)) {
        if (!existing.payloadHash.equals(payloadHash)) {
          throw new Error("Interactive submission idempotency key conflicts");
        }
        return {
          interaction: this.requireInteractiveRequest(options.requestId),
          outcome: "adopted",
          receipt:
            existing.receiptHash === null
              ? { requestId: options.requestId, submissionId: existing.submissionId }
              : this.state.readJson(existing.receiptHash),
        };
      }
      if (options.outcome === "validating") {
        const active = this.state.connection
          .prepare(
            `SELECT submission_id AS submissionId FROM interactive_submissions
             WHERE request_id = ? AND outcome = 'validating' LIMIT 1`,
          )
          .get(options.requestId);
        if (isSubmissionIdRow(active)) {
          throw new Error("Interactive submission validation is already active");
        }
      }
      const request = this.requireInteractiveRequest(options.requestId);
      if (
        request.revision !== options.expectedRevision ||
        !["pending", "presenting"].includes(request.status)
      ) {
        throw new Error("Interactive request revision conflict");
      }
      const savedPayloadHash = this.state.putJson(options.payload, now);
      const receiptHash =
        options.receipt === undefined ? null : this.state.putJson(options.receipt, now);
      this.state.connection
        .prepare(
          `INSERT INTO interactive_submissions(
             submission_id, request_id, idempotency_key, request_revision,
             payload_hash, outcome, receipt_hash, submitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.submissionId,
          options.requestId,
          options.idempotencyKey,
          options.expectedRevision,
          savedPayloadHash,
          options.outcome,
          receiptHash,
          now,
        );
      if (options.settle) {
        this.state.connection
          .prepare(
            `UPDATE interactive_requests
             SET status = 'settled', presenter_id = NULL, presentation_claim_expires_at = NULL,
                 accepted_submission_id = ?, revision = revision + 1,
                 updated_at = ?, settled_at = ?
             WHERE request_id = ? AND revision = ? AND status IN ('pending', 'presenting')`,
          )
          .run(options.submissionId, now, now, options.requestId, options.expectedRevision);
      }
      return {
        interaction: this.requireInteractiveRequest(options.requestId),
        outcome: "accepted",
        receipt: options.receipt ?? {
          requestId: options.requestId,
          submissionId: options.submissionId,
        },
      };
    });
  }

  private hostRow(): HostRow {
    const row = this.state.connection
      .prepare(
        `SELECT epoch, host_id AS hostId, token_hash AS tokenHash, pid,
                process_start_identity AS processStartIdentity, started_at AS startedAt,
                heartbeat_at AS heartbeatAt, expires_at AS expiresAt
         FROM workflow_host_state WHERE id = 1`,
      )
      .get();
    if (!isHostRow(row)) throw new Error("Pi Workflows host state is missing");
    return row;
  }

  private commandResponse(requestId: string, row: CommandRow): HostResponse {
    const receipt = row.receiptHash === null ? undefined : this.state.readJson(row.receiptHash);
    const error =
      row.errorHash === null
        ? undefined
        : this.state.readBlob(row.errorHash)?.content.toString("utf8");
    return {
      schema: "pi-workflows.host-response.v1",
      requestId,
      outcome: row.outcome,
      ...(row.revision === null ? {} : { revision: row.revision }),
      ...(receipt === undefined ? {} : { receipt }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private interactiveRequest(requestId: string): InteractiveRequestRecord | undefined {
    const row = this.state.connection
      .prepare(
        `SELECT request_id AS requestId, run_id AS runId, attempt_id AS attemptId,
                target_session_id AS targetSessionId, kind, contract_hash AS contractHash,
                revision, status, presentation_session_entry_id AS presentationSessionEntryId,
                accepted_submission_id AS acceptedSubmissionId, created_at AS createdAt,
                updated_at AS updatedAt, settled_at AS settledAt, consumed_at AS consumedAt
         FROM interactive_requests WHERE request_id = ?`,
      )
      .get(requestId);
    if (!isInteractiveRequestRow(row)) return undefined;
    return {
      requestId: row.requestId,
      runId: row.runId,
      attemptId: row.attemptId,
      targetSessionId: row.targetSessionId,
      kind: row.kind,
      contract: this.state.readJson(row.contractHash),
      revision: row.revision,
      status: row.status,
      presentationSessionEntryId: row.presentationSessionEntryId,
      acceptedSubmissionId: row.acceptedSubmissionId,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      settledAt: iso(row.settledAt),
      consumedAt: iso(row.consumedAt),
    };
  }

  private requireInteractiveRequest(requestId: string): InteractiveRequestRecord {
    const request = this.interactiveRequest(requestId);
    if (request === undefined) throw new Error(`Interactive request not found: ${requestId}`);
    return request;
  }
}

function conflictResponse(requestId: string, error: string): HostResponse {
  return { schema: "pi-workflows.host-response.v1", requestId, outcome: "conflict", error };
}

function requireLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Host lease duration must be positive");
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

type HostRow = {
  epoch: number;
  hostId: string | null;
  tokenHash: Buffer | null;
  pid: number | null;
  processStartIdentity: string | null;
  startedAt: number | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
};

type CommandRow = {
  requestFingerprint: Buffer;
  outcome: HostResponse["outcome"];
  revision: number | null;
  receiptHash: Buffer | null;
  errorHash: Buffer | null;
};

type IdempotentCommandRow = CommandRow & { requestId: string };
type RequestIdRow = { requestId: string };
type SubmissionRow = {
  submissionId: string;
  payloadHash: Buffer;
  outcome: string;
  receiptHash: Buffer | null;
};
type SubmissionIdRow = { submissionId: string };
type SubmissionDetailRow = {
  requestId: string;
  submissionId: string;
  idempotencyKey: string;
  outcome: InteractiveSubmissionRecord["outcome"];
  payloadHash: Buffer;
  receiptHash: Buffer | null;
  submittedAt: number;
};
type WorkerMessageRow = {
  requestFingerprint: Buffer;
  outcome: WorkerResponse["outcome"];
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
type InteractiveRequestRow = {
  requestId: string;
  runId: string;
  attemptId: string;
  targetSessionId: string;
  kind: InteractiveRequestRecord["kind"];
  contractHash: Buffer;
  revision: number;
  status: InteractiveRequestRecord["status"];
  presentationSessionEntryId: string | null;
  acceptedSubmissionId: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
  consumedAt: number | null;
};

function isHostRow(value: unknown): value is HostRow {
  return (
    isRecord(value) &&
    typeof value.epoch === "number" &&
    nullableString(value.hostId) &&
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
    Buffer.isBuffer(value.requestFingerprint) &&
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

function isWorkerMessageRow(value: unknown): value is WorkerMessageRow {
  return (
    isRecord(value) &&
    Buffer.isBuffer(value.requestFingerprint) &&
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

function isSubmissionRow(value: unknown): value is SubmissionRow {
  return (
    isRecord(value) &&
    typeof value.submissionId === "string" &&
    Buffer.isBuffer(value.payloadHash) &&
    typeof value.outcome === "string" &&
    (value.receiptHash === null || Buffer.isBuffer(value.receiptHash))
  );
}

function isSubmissionIdRow(value: unknown): value is SubmissionIdRow {
  return isRecord(value) && typeof value.submissionId === "string";
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

function isInteractiveRequestRow(value: unknown): value is InteractiveRequestRow {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.runId === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.targetSessionId === "string" &&
    ["agent", "assistant", "decision"].includes(value.kind as string) &&
    Buffer.isBuffer(value.contractHash) &&
    typeof value.revision === "number" &&
    ["pending", "presenting", "settled", "cancelled"].includes(value.status as string) &&
    nullableString(value.presentationSessionEntryId) &&
    nullableString(value.acceptedSubmissionId) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    nullableNumber(value.settledAt) &&
    nullableNumber(value.consumedAt)
  );
}

function workerMessageFingerprint(message: WorkerMessage): Buffer {
  return createHash("sha256").update(canonicalJson(message)).digest();
}

function workerMessageResponse(
  state: StateDatabase,
  messageId: string,
  row: WorkerMessageRow,
): WorkerResponse {
  const result = row.resultHash === null ? undefined : state.readJson(row.resultHash);
  const error =
    row.errorHash === null ? undefined : state.readBlob(row.errorHash)?.content.toString("utf8");
  return {
    schema: "pi-workflows.worker-response.v1",
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
