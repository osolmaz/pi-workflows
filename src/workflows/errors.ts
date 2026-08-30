export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CancelledError extends Error {
  constructor(message = "Workflow run was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * Thrown when a runner writes to a SQLite run state after losing its queue claim.
 * The current claim holder owns the run from that point on, so the fenced
 * writer must stop changing the run immediately.
 */
export type ClaimLostReason =
  | "missingAuthority"
  | "expired"
  | "ownerChanged"
  | "tokenChanged"
  | "generationChanged";

export class ClaimLostError extends Error {
  readonly runId: string;
  readonly reason: ClaimLostReason;

  constructor(runId: string, reason: ClaimLostReason = "missingAuthority") {
    super(`Workflow run claim lost (${reason}): ${runId}`);
    this.name = "ClaimLostError";
    this.runId = runId;
    this.reason = reason;
  }
}

/**
 * Internal stop signal for close-to-park: the engine halts without writing
 * a terminal event, leaving resumable state for the next claim holder.
 */
export class RunParkedError extends Error {
  constructor() {
    super("Workflow run was parked");
    this.name = "RunParkedError";
  }
}

export function isRunParkedError(error: unknown): error is RunParkedError {
  return error instanceof RunParkedError;
}

/** The workflow source changed after the run started; resume needs force. */
export class WorkflowSourceChangedError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow source changed since run ${runId} started; pass force to resume anyway`);
    this.name = "WorkflowSourceChangedError";
    this.runId = runId;
  }
}

/** A built-in revision is unavailable, so its incompatible run must restart. */
export class BuiltinWorkflowRevisionChangedError extends Error {
  readonly runId: string;
  readonly workflowId: string;
  readonly previousRevision: string;
  readonly currentRevision: string;

  constructor(options: {
    runId: string;
    workflowId: string;
    previousRevision: string;
    currentRevision: string;
  }) {
    super(
      `Built-in workflow ${options.workflowId} revision ${options.previousRevision} cannot resume run ${options.runId} with installed revision ${options.currentRevision}; cancel run ${options.runId}, then start ${options.workflowId} again`,
    );
    this.name = "BuiltinWorkflowRevisionChangedError";
    this.runId = options.runId;
    this.workflowId = options.workflowId;
    this.previousRevision = options.previousRevision;
    this.currentRevision = options.currentRevision;
  }
}

export function isClaimLostError(error: unknown): error is ClaimLostError {
  return error instanceof ClaimLostError;
}

export function isAbortLikeError(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
