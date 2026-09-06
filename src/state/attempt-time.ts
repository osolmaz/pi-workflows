import { performance } from "node:perf_hooks";
import type { StateDatabase } from "./database.js";

export type AttemptClock = { now(): number; monotonic(): number };
const realClock: AttemptClock = { now: () => Date.now(), monotonic: () => performance.now() };

type Interval = { attemptId: string; intervalNumber: number; elapsedMs: number };

/** Records active execution in the existing database. Wall time never determines the budget. */
export class AttemptTime {
  private readonly anchors = new Map<string, number>();

  constructor(
    private readonly state: StateDatabase,
    private readonly clock: AttemptClock = realClock,
  ) {}

  start(attemptId: string): void {
    this.state.transaction(() => {
      const open = this.openIntervals().find((interval) => interval.attemptId === attemptId);
      if (open !== undefined) {
        if (!this.anchors.has(intervalKey(open))) {
          throw new Error(
            "Recover the previous host's active intervals before starting model work",
          );
        }
        return;
      }
      const row = this.state.connection
        .prepare(
          "SELECT COALESCE(MAX(interval_number), 0) + 1 AS next FROM attempt_active_intervals WHERE attempt_id = ?",
        )
        .get(attemptId) as { next: number };
      const now = this.clock.now();
      this.state.connection
        .prepare(
          "INSERT INTO attempt_active_intervals(attempt_id, interval_number, started_at, observed_at) VALUES (?, ?, ?, ?)",
        )
        .run(attemptId, row.next, now, now);
      this.anchors.set(
        intervalKey({ attemptId, intervalNumber: row.next }),
        this.clock.monotonic(),
      );
    });
  }

  sample(): void {
    const nested = this.state.connection.inTransaction;
    const open = this.openIntervals();
    this.state.transaction(() => {
      for (const interval of open) this.sampleInterval(interval);
    });
    if (!nested) {
      const active = new Set(open.map(intervalKey));
      for (const key of this.anchors.keys()) {
        if (!active.has(key)) this.anchors.delete(key);
      }
    }
  }

  stop(attemptId: string): void {
    this.state.transaction(() => {
      const interval = this.openIntervals().find((candidate) => candidate.attemptId === attemptId);
      if (interval === undefined) return;
      this.sampleInterval(interval);
      closeAttemptTime(this.state, attemptId);
    });
  }

  recover(): void {
    // A crashed host can prove only the last saved sample, not time spent while offline.
    this.state.connection
      .prepare("UPDATE attempt_active_intervals SET ended_at = observed_at WHERE ended_at IS NULL")
      .run();
    this.anchors.clear();
  }

  private sampleInterval(interval: Interval): void {
    const anchor = this.anchors.get(intervalKey(interval));
    if (anchor === undefined) {
      throw new Error("Active interval belongs to a previous host; recover it before sampling");
    }
    const elapsedMs = Math.max(interval.elapsedMs, this.clock.monotonic() - anchor, 0);
    this.state.connection
      .prepare(
        `UPDATE attempt_active_intervals SET elapsed_ms = ?, observed_at = ?
       WHERE attempt_id = ? AND interval_number = ? AND ended_at IS NULL`,
      )
      .run(elapsedMs, this.clock.now(), interval.attemptId, interval.intervalNumber);
  }

  private openIntervals(): Interval[] {
    return this.state.connection
      .prepare(
        `SELECT attempt_id AS attemptId, interval_number AS intervalNumber, elapsed_ms AS elapsedMs
       FROM attempt_active_intervals WHERE ended_at IS NULL`,
      )
      .all() as Interval[];
  }
}

function intervalKey(interval: Pick<Interval, "attemptId" | "intervalNumber">): string {
  return JSON.stringify([interval.attemptId, interval.intervalNumber]);
}

export function closeRunTime(state: StateDatabase, runId: string): void {
  state.connection
    .prepare(
      `UPDATE attempt_active_intervals SET ended_at = observed_at
     WHERE ended_at IS NULL AND attempt_id IN (SELECT attempt_id FROM node_attempts WHERE run_id = ?)`,
    )
    .run(runId);
}

/** Freeze the last host sample when an attempt settles outside its model turn. */
export function closeAttemptTime(state: StateDatabase, attemptId: string): void {
  state.connection
    .prepare(
      "UPDATE attempt_active_intervals SET ended_at = observed_at WHERE attempt_id = ? AND ended_at IS NULL",
    )
    .run(attemptId);
}
