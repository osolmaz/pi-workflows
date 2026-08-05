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
 * Thrown when a runner writes to a run bundle after losing its queue claim.
 * The current claim holder owns the run from that point on, so the fenced
 * writer must stop touching the bundle immediately.
 */
export class ClaimLostError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow run claim lost: ${runId}`);
    this.name = "ClaimLostError";
    this.runId = runId;
  }
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
