import type { StateDatabase } from "../state/database.js";

export type WorkflowStateViolation = {
  code:
    | "queueState"
    | "waitingRequest"
    | "pendingRequest"
    | "acceptedRequest"
    | "activeClock"
    | "sessionTurns";
  runId: string;
  detail: string;
};

/** Inspect domain facts without repairing or reinterpreting durable state. */
export function workflowStateViolations(state: StateDatabase): WorkflowStateViolation[] {
  const checks: Array<{ code: WorkflowStateViolation["code"]; detail: string; sql: string }> = [
    {
      code: "queueState",
      detail: "Execution and queue terminal states disagree.",
      sql: `SELECT r.run_id AS runId FROM runs r JOIN run_queue q ON q.run_id = r.run_id
        WHERE ((q.status IN ('done', 'failed', 'cancelled')) OR
          (r.status IN ('completed', 'failed', 'timed_out', 'cancelled') AND NOT EXISTS (
            SELECT 1 FROM effects e WHERE e.source_resource_id = r.resource_id
              AND e.effect_type = 'run.settle_queue' AND e.status = 'pending')))
        AND NOT ((r.status = 'completed' AND q.status = 'done')
          OR (r.status IN ('failed', 'timed_out') AND q.status = 'failed')
          OR (r.status = 'cancelled' AND q.status = 'cancelled'))`,
    },
    {
      code: "waitingRequest",
      detail: "A waiting run has no pending request or unconsumed accepted response.",
      sql: `SELECT r.run_id AS runId FROM runs r WHERE r.status = 'waiting' AND NOT EXISTS (
        SELECT 1 FROM interactive_requests i WHERE i.run_id = r.run_id
          AND (i.status = 'pending' OR (i.status = 'settled' AND i.consumed_at IS NULL)))`,
    },
    {
      code: "pendingRequest",
      detail: "A pending request has no matching active attempt and live run.",
      sql: `SELECT i.run_id AS runId FROM interactive_requests i
        JOIN runs r ON r.run_id = i.run_id JOIN node_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.status = 'pending' AND (a.run_id <> i.run_id
          OR a.status NOT IN ('pending', 'running', 'waiting', 'interrupted')
          OR r.status NOT IN ('running', 'waiting'))`,
    },
    {
      code: "acceptedRequest",
      detail: "A settled request has no matching accepted submission.",
      sql: `SELECT i.run_id AS runId FROM interactive_requests i
        LEFT JOIN interactive_submissions s ON s.submission_id = i.accepted_submission_id
        WHERE i.status = 'settled' AND (s.submission_id IS NULL OR s.request_id <> i.request_id OR s.outcome <> 'accepted')`,
    },
    {
      code: "activeClock",
      detail: "An active interval belongs to paused, terminal, or unconfigured work.",
      sql: `SELECT DISTINCT a.run_id AS runId FROM attempt_active_intervals t
        JOIN node_attempts a ON a.attempt_id = t.attempt_id JOIN runs r ON r.run_id = a.run_id
        WHERE t.ended_at IS NULL AND (r.paused = 1 OR r.status NOT IN ('running', 'waiting')
          OR a.status NOT IN ('pending', 'running', 'waiting') OR a.timeout_ms IS NULL)`,
    },
    {
      code: "sessionTurns",
      detail: "A Pi session has more than one open workflow turn.",
      sql: `SELECT DISTINCT t.run_id AS runId FROM workflow_turns t WHERE t.state = 'started'
        AND t.target_session_id IN (SELECT target_session_id FROM workflow_turns
          WHERE state = 'started' GROUP BY target_session_id HAVING COUNT(*) > 1)`,
    },
  ];
  return state.readTransaction(() =>
    checks.flatMap(({ code, detail, sql }) =>
      (state.connection.prepare(sql).all() as { runId: string }[]).map(({ runId }) => ({
        code,
        runId,
        detail,
      })),
    ),
  );
}
