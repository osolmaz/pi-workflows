import { describe, expect, it, vi } from "vitest";
import {
  createJobProgressReporter,
  estimateJobProgress,
  JOB_PROGRESS_SCHEMA,
  validateJobProgressSnapshot,
  type JobProgressSnapshot,
  type JobProgressTrack,
} from "../src/job-progress/index.js";

const STARTED_AT = "2026-08-17T10:00:00.000Z";

function track(completed: number, total = 100, phase = "processing"): JobProgressTrack {
  return {
    key: "records",
    data: {
      schema: "pi-workflows.progress.v1",
      status: "running",
      phase,
      completed,
      total,
      unit: "records",
    },
  };
}

function snapshot(overrides: Partial<JobProgressSnapshot> = {}): JobProgressSnapshot {
  return {
    schema: JOB_PROGRESS_SCHEMA,
    application: "example",
    component: "worker",
    jobId: "job-123",
    sourceRevision: "abc123",
    contractHash: "def456",
    sequence: 1,
    state: "running",
    phase: "processing",
    startedAt: STARTED_AT,
    updatedAt: "2026-08-17T10:01:00.000Z",
    tracks: [track(10)],
    ...overrides,
  };
}

function reporterOptions(
  publish: (value: JobProgressSnapshot, signal: AbortSignal) => Promise<void>,
  now: () => Date,
) {
  return {
    application: "example",
    component: "worker",
    jobId: "job-123",
    sourceRevision: "abc123",
    contractHash: "def456",
    startedAt: STARTED_AT,
    initialTracks: [track(0)],
    publish,
    now,
  };
}

describe("durable job progress", () => {
  it("strictly validates and normalizes a snapshot", () => {
    expect(validateJobProgressSnapshot(snapshot())).toEqual(snapshot());
    expect(() => validateJobProgressSnapshot({ ...snapshot(), token: "secret" })).toThrow(
      "job progress.token is not supported",
    );
    expect(() =>
      validateJobProgressSnapshot({ ...snapshot(), tracks: [track(1), track(2)] }),
    ).toThrow("job progress track key records is duplicated");
  });

  it("snapshots mutable track input", () => {
    const input = snapshot();
    const validated = validateJobProgressSnapshot(input);
    const data = input.tracks[0]?.data;
    if (data !== undefined) data.completed = 99;
    expect(validated.tracks[0]?.data.completed).toBe(10);
  });

  it("requires terminal timestamps and rejects timestamps on active states", () => {
    expect(() => validateJobProgressSnapshot({ ...snapshot(), state: "completed" })).toThrow(
      "finishedAt is required",
    );
    expect(() =>
      validateJobProgressSnapshot({ ...snapshot(), finishedAt: "2026-08-17T10:02:00.000Z" }),
    ).toThrow("allowed only for a terminal state");
  });

  it("publishes the first update, coalesces frequent updates, and flushes the latest one", async () => {
    const published: JobProgressSnapshot[] = [];
    let nowMs = Date.parse("2026-08-17T10:00:01.000Z");
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async (value) => void published.push(value),
        () => new Date(nowMs),
      ),
      minimumIntervalMs: 30_000,
    });

    expect((await reporter.report({ tracks: [track(1)] })).published).toBe(true);
    nowMs += 10_000;
    expect((await reporter.report({ tracks: [track(2)] })).published).toBe(false);
    expect(published.map((value) => value.tracks[0]?.data.completed)).toEqual([1]);
    expect((await reporter.flush()).published).toBe(true);
    expect(published.map((value) => value.tracks[0]?.data.completed)).toEqual([1, 2]);
    expect(published.map((value) => value.sequence)).toEqual([1, 2]);
  });

  it("publishes phase changes and terminal states immediately", async () => {
    const published: JobProgressSnapshot[] = [];
    let nowMs = Date.parse("2026-08-17T10:00:01.000Z");
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async (value) => void published.push(value),
        () => new Date(nowMs),
      ),
      minimumIntervalMs: 60_000,
    });

    await reporter.report({ tracks: [track(1)] });
    nowMs += 1_000;
    await reporter.report({ phase: "publishing", tracks: [track(0, 10, "publishing")] });
    nowMs += 1_000;
    const result = await reporter.report({
      state: "completed",
      phase: "complete",
      tracks: [
        {
          ...track(10, 10, "complete"),
          data: { ...track(10, 10, "complete").data, status: "completed" },
        },
      ],
    });

    expect(published).toHaveLength(3);
    expect(result.snapshot.finishedAt).toBe("2026-08-17T10:00:03.000Z");
    expect(() => reporter.report({ phase: "late" })).rejects.toThrow(
      "cannot change after a terminal state",
    );
  });

  it("rejects counter regressions but permits a new phase epoch", async () => {
    let nowMs = Date.parse("2026-08-17T10:00:01.000Z");
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async () => undefined,
        () => new Date(nowMs),
      ),
      minimumIntervalMs: 0,
    });
    await reporter.report({ tracks: [track(20)] });
    nowMs += 1_000;
    await expect(reporter.report({ tracks: [track(19)] })).rejects.toThrow(
      "completed value must not decrease",
    );
    await reporter.report({ phase: "next", tracks: [track(0, 50, "next")] });
    expect(reporter.snapshot().tracks[0]?.data.completed).toBe(0);
  });

  it("keeps the latest snapshot after a transient publication failure", async () => {
    let calls = 0;
    let nowMs = Date.parse("2026-08-17T10:00:01.000Z");
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("temporary Bucket failure");
        },
        () => new Date(nowMs),
      ),
      minimumIntervalMs: 30_000,
    });

    await expect(reporter.report({ tracks: [track(1)] })).rejects.toThrow(
      "temporary Bucket failure",
    );
    nowMs += 1_000;
    expect((await reporter.report({ tracks: [track(2)] })).published).toBe(false);
    expect((await reporter.flush()).published).toBe(true);
    expect(calls).toBe(2);
    expect(reporter.snapshot().tracks[0]?.data.completed).toBe(2);
  });

  it("aborts a publication that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const reporter = createJobProgressReporter({
        ...reporterOptions(
          async (_value, signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
          () => new Date(STARTED_AT),
        ),
        publishTimeoutMs: 50,
      });
      const pending = reporter.report({ tracks: [track(1)] });
      const rejection = expect(pending).rejects.toThrow(
        "job progress publication timed out after 50 ms",
      );
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("estimates remaining time from repeated durable snapshots", () => {
    const result = estimateJobProgress(
      [
        snapshot({ sequence: 1, updatedAt: "2026-08-17T10:00:00.000Z", tracks: [track(0)] }),
        snapshot({ sequence: 2, updatedAt: "2026-08-17T10:01:00.000Z", tracks: [track(20)] }),
        snapshot({ sequence: 3, updatedAt: "2026-08-17T10:02:00.000Z", tracks: [track(40)] }),
      ],
      new Date("2026-08-17T10:02:00.000Z"),
    );
    expect(result.estimates[0]?.remainingMedianMs).toBe(180_000);
    expect(result.tracks[0]?.samples).toHaveLength(3);
  });
});
