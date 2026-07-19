import type { WorkflowRunState } from "../workflows/types.js";

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.max(durationMs, 0)}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

export function runElapsedMs(state: WorkflowRunState, now: Date = new Date()): number {
  const end = state.finishedAt ? Date.parse(state.finishedAt) : now.getTime();
  return Math.max(0, end - Date.parse(state.startedAt));
}
