import { performance } from "node:perf_hooks";
import type { StateDatabase } from "../state/database.js";
import { WorkflowMessageStore, type WorkflowMessage } from "../state/workflow-messages.js";
import { notificationWorkflowMessageContent } from "../workflows/workflow-message-content.js";

export const MAX_SUBMISSION_REMINDERS = 2;
export const MAX_RECOVERY_LAUNCHES = 2;
export const RECOVERY_ACTIVE_TIMEOUT_MS = 15 * 60_000;

type RecoverySource = { rootRunId: string; messageId: string; runId: string };
type Clock = { monotonic(): number; now(): number };

/** Session recovery uses the existing run, message, and turn records. */
export class WorkflowRecovery {
  private readonly messages: WorkflowMessageStore;
  private readonly active = new Map<string, { elapsed: number; anchor: number }>();

  constructor(
    private readonly state: StateDatabase,
    private readonly clock: Clock = { monotonic: () => performance.now(), now: () => Date.now() },
    private readonly timeoutMs = RECOVERY_ACTIVE_TIMEOUT_MS,
  ) {
    this.messages = new WorkflowMessageStore(state);
  }

  root(runId: string): string {
    const row = this.state.connection
      .prepare("SELECT recovery_root_run_id AS root FROM runs WHERE run_id = ?")
      .get(runId) as { root: string | null } | undefined;
    return row?.root ?? runId;
  }

  stopped(messageId: string): boolean {
    return recoveryStopped(this.state, messageId);
  }

  sourceForLaunch(sessionId: string): RecoverySource | undefined {
    const turn = this.messages
      .openTurnsForSession(sessionId)
      .find((candidate) => this.messages.require(candidate.workflowMessageId).kind === "terminal");
    if (turn === undefined) return undefined;
    if (this.stopped(turn.workflowMessageId)) throw new Error("Workflow recovery is stopped");
    const consumed = this.state.connection
      .prepare("SELECT run_id AS runId FROM runs WHERE recovery_source_message_id = ?")
      .get(turn.workflowMessageId) as { runId: string } | undefined;
    if (consumed !== undefined) {
      throw new Error(
        `This terminal handoff already started recovery run ${consumed.runId}. Inspect or adopt that run; do not repeat work.`,
      );
    }
    const rootRunId = this.root(turn.runId);
    const count = this.launchCount(rootRunId);
    if (count >= MAX_RECOVERY_LAUNCHES) {
      throw new Error(
        `Automatic workflow recovery reached its ${MAX_RECOVERY_LAUNCHES}-launch limit. Report a blocker; do not start repeated work.`,
      );
    }
    const unresolved = this.state.connection
      .prepare(
        `SELECT 1 FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
       WHERE r.run_id IN (?, ?) AND e.status IN ('pending', 'applying', 'ambiguous') LIMIT 1`,
      )
      .get(turn.runId, rootRunId);
    if (unresolved !== undefined)
      throw new Error("Recovery requires observation of unsettled effects before another launch");
    return { rootRunId, runId: turn.runId, messageId: turn.workflowMessageId };
  }

  attach(runId: string, source: RecoverySource | undefined): void {
    if (source === undefined) return;
    this.state.connection
      .prepare(
        "UPDATE runs SET recovery_root_run_id = ?, recovery_source_message_id = ? WHERE run_id = ?",
      )
      .run(source.rootRunId, source.messageId, runId);
  }

  launchCount(rootRunId: string): number {
    return (
      this.state.connection
        .prepare("SELECT count(*) AS count FROM runs WHERE recovery_root_run_id = ?")
        .get(rootRunId) as { count: number }
    ).count;
  }

  cancel(runId: string): void {
    const root = this.root(runId);
    this.state.connection
      .prepare(
        `UPDATE workflow_messages SET recovery_stop = 'cancelled'
       WHERE kind = 'terminal' AND run_id IN
         (SELECT run_id FROM runs WHERE run_id = ? OR recovery_root_run_id = ?)`,
      )
      .run(root, root);
    this.notice(
      runId,
      "cancelled",
      "Workflow recovery cancelled. No automatic continuation will start.",
    );
  }

  begin(turnId: string): void {
    if (this.active.has(turnId)) return;
    const row = this.state.connection
      .prepare(
        `SELECT t.active_elapsed_ms AS elapsed FROM workflow_turns t
       JOIN workflow_messages m ON m.workflow_message_id = t.workflow_message_id
       WHERE t.workflow_turn_id = ? AND t.state = 'started' AND m.kind = 'terminal'
       AND m.recovery_stop IS NULL`,
      )
      .get(turnId) as { elapsed: number } | undefined;
    if (row !== undefined)
      this.active.set(turnId, { elapsed: row.elapsed, anchor: this.clock.monotonic() });
  }

  sample(): void {
    for (const [turnId, sample] of this.active) {
      const turn = this.messages.requireTurn(turnId);
      if (turn.state !== "started") {
        this.active.delete(turnId);
        continue;
      }
      const elapsed = sample.elapsed + Math.max(0, this.clock.monotonic() - sample.anchor);
      this.state.connection
        .prepare("UPDATE workflow_turns SET active_elapsed_ms = ? WHERE workflow_turn_id = ?")
        .run(elapsed, turnId);
      if (elapsed >= this.timeoutMs && !this.stopped(turn.workflowMessageId)) {
        this.state.connection
          .prepare(
            "UPDATE workflow_messages SET recovery_stop = 'timed_out' WHERE workflow_message_id = ?",
          )
          .run(turn.workflowMessageId);
        this.notice(
          turn.runId,
          "timed-out",
          "Workflow recovery reached its active-time limit. Accepted work is saved. Inspect the result before requesting further work.",
        );
      }
    }
  }

  suspendSession(sessionId: string): void {
    this.sample();
    for (const turn of this.messages.openTurnsForSession(sessionId))
      this.active.delete(turn.workflowTurnId);
  }

  resumeSession(sessionId: string): void {
    for (const turn of this.messages.openTurnsForSession(sessionId))
      this.begin(turn.workflowTurnId);
  }

  end(message: WorkflowMessage, stopReason: string): void {
    const turn = this.messages.latestTurnForMessage(message.workflowMessageId);
    if (turn !== undefined) this.active.delete(turn.workflowTurnId);
    if (
      message.kind !== "terminal" ||
      stopReason === "completed" ||
      this.stopped(message.workflowMessageId)
    )
      return;
    this.state.connection
      .prepare(
        "UPDATE workflow_messages SET recovery_stop = 'interrupted' WHERE workflow_message_id = ?",
      )
      .run(message.workflowMessageId);
    this.notice(
      message.runId,
      "interrupted",
      "Workflow recovery was interrupted. Accepted work is saved. Inspect command outcomes before explicitly requesting continuation.",
    );
  }

  private notice(runId: string, reason: string, content: string): void {
    const terminal = this.messages.listRun(runId).find((message) => message.kind === "terminal");
    if (terminal === undefined) return;
    const id = `recovery-${reason}-${runId}`;
    this.messages.create({
      workflowMessageId: id,
      runId,
      targetSessionId: terminal.targetSessionId,
      kind: "notification",
      sourceId: id,
      idempotencyKey: id,
      content: notificationWorkflowMessageContent({
        workflowMessageId: id,
        notificationId: id,
        runId,
        kind: "final",
        content,
      }),
      now: this.clock.now(),
    });
  }
}

export function recoveryStopped(state: StateDatabase, messageId: string): boolean {
  const row = state.connection
    .prepare(
      `SELECT m.recovery_stop AS stop, r.status, root.status AS rootStatus,
       EXISTS (SELECT 1 FROM workflow_messages root_message
         WHERE root_message.run_id = r.recovery_root_run_id
           AND root_message.kind = 'terminal'
           AND root_message.recovery_stop = 'cancelled') AS rootCancelled
     FROM workflow_messages m JOIN runs r ON r.run_id = m.run_id
     LEFT JOIN runs root ON root.run_id = r.recovery_root_run_id
     WHERE m.workflow_message_id = ?`,
    )
    .get(messageId) as
    | { stop: string | null; status: string; rootStatus: string | null; rootCancelled: number }
    | undefined;
  return (
    row !== undefined &&
    (row.stop !== null ||
      row.status === "cancelled" ||
      row.rootStatus === "cancelled" ||
      row.rootCancelled === 1)
  );
}
