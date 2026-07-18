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

export function isAbortLikeError(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
