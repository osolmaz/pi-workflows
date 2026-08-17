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
    expect(() => validateJobProgressSnapshot({ ...snapshot(), tracks: [] })).toThrow(
      "tracks must contain at least one entry",
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

  it("rejects normalized and partial timestamp values", () => {
    expect(() =>
      validateJobProgressSnapshot({ ...snapshot(), updatedAt: "2026-02-31T10:00:00Z" }),
    ).toThrow("must be an RFC 3339 timestamp");
    expect(() => validateJobProgressSnapshot({ ...snapshot(), updatedAt: "not-a-date-Z" })).toThrow(
      "must be an RFC 3339 timestamp",
    );
  });

  it("requires terminal timestamps and rejects timestamps on active states", () => {
    expect(() => validateJobProgressSnapshot({ ...snapshot(), state: "completed" })).toThrow(
      "finishedAt is required",
    );
    expect(() =>
      validateJobProgressSnapshot({ ...snapshot(), finishedAt: "2026-08-17T10:02:00.000Z" }),
    ).toThrow("allowed only for a terminal state");
    expect(() =>
      validateJobProgressSnapshot({
        ...snapshot(),
        state: "completed",
        finishedAt: "2026-08-17T10:02:00.000Z",
      }),
    ).toThrow("tracks must be terminal");
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

  it("returns the exact snapshot written by an in-flight report", async () => {
    let release: (() => void) | undefined;
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        () => new Date("2026-08-17T10:00:01.000Z"),
      ),
      minimumIntervalMs: 30_000,
    });

    const first = reporter.report({ tracks: [track(1)] });
    const second = await reporter.report({ tracks: [track(2)] });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();
    const firstResult = await first;
    expect(firstResult.snapshot.sequence).toBe(1);
    expect(firstResult.snapshot.tracks[0]?.data.completed).toBe(1);
    expect(second.snapshot.sequence).toBe(2);
    expect(second.published).toBe(false);
  });

  it("joins an in-flight publication when flush sees the same sequence", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        () => new Date("2026-08-17T10:00:01.000Z"),
      ),
      minimumIntervalMs: 30_000,
    });

    const report = reporter.report({ tracks: [track(1)] });
    const flush = reporter.flush();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();
    await Promise.all([report, flush]);
    expect(calls).toBe(1);
  });

  it("keeps an aborted write serialized until its storage operation settles", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      let releaseFirst: (() => void) | undefined;
      const reporter = createJobProgressReporter({
        ...reporterOptions(
          async (value) => {
            calls.push(value.sequence);
            if (value.sequence === 1) {
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
          },
          () => new Date("2026-08-17T10:00:01.000Z"),
        ),
        minimumIntervalMs: 0,
        publishTimeoutMs: 50,
      });

      const first = reporter.report({ tracks: [track(1)] });
      const firstRejection = expect(first).rejects.toThrow("publication timed out after 50 ms");
      await vi.advanceTimersByTimeAsync(50);
      await firstRejection;
      const second = reporter.report({ phase: "next", tracks: [track(0, 10, "next")] });
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([1]);
      releaseFirst?.();
      await second;
      expect(calls).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes sequence numbers from a prior snapshot", async () => {
    const published: JobProgressSnapshot[] = [];
    const prior = snapshot({ sequence: 7, tracks: [track(50)] });
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async (value) => void published.push(value),
        () => new Date("2026-08-17T10:02:00.000Z"),
      ),
      previousSnapshot: prior,
      minimumIntervalMs: 0,
    });
    const result = await reporter.report({ tracks: [track(51)] });
    expect(result.snapshot.sequence).toBe(8);
    expect(published[0]?.sequence).toBe(8);
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
    await expect(reporter.report({ phase: "late" })).rejects.toThrow(
      "cannot change after a terminal state",
    );
  });

  it("makes carried tracks terminal when the job completes", async () => {
    const reporter = createJobProgressReporter({
      ...reporterOptions(
        async () => undefined,
        () => new Date("2026-08-17T10:01:00.000Z"),
      ),
      previousSnapshot: snapshot({ sequence: 2, tracks: [track(50)] }),
    });
    const result = await reporter.report({ state: "completed", phase: "complete" });
    expect(result.snapshot.tracks[0]?.data.status).toBe("completed");
    expect(result.snapshot.finishedAt).toBe("2026-08-17T10:01:00.000Z");
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

  it("does not estimate a track removed from the latest snapshot", () => {
    const oldTrack: JobProgressTrack = {
      key: "old-phase",
      data: {
        schema: "pi-workflows.progress.v1",
        status: "running",
        completed: 1,
        total: 2,
        unit: "items",
      },
    };
    const result = estimateJobProgress([
      snapshot({ sequence: 1, tracks: [track(10), oldTrack] }),
      snapshot({ sequence: 2, updatedAt: "2026-08-17T10:02:00.000Z", tracks: [track(20)] }),
    ]);
    expect(result.estimates.map((estimate) => estimate.key)).toEqual(["records"]);
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
