import {
  estimateProgress,
  type ProgressSample,
  type ProgressTrackState,
} from "../workflows/index.js";
import {
  JOB_PROGRESS_SCHEMA,
  type JobProgressEstimate,
  type JobProgressPublishResult,
  type JobProgressReporterOptions,
  type JobProgressSnapshot,
  type JobProgressTrack,
  type JobProgressUpdate,
} from "./types.js";
import { isTerminalJobProgressState, validateJobProgressSnapshot } from "./validation.js";

const DEFAULT_MINIMUM_INTERVAL_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

export type JobProgressReporter = {
  report(update: JobProgressUpdate): Promise<JobProgressPublishResult>;
  flush(): Promise<JobProgressPublishResult>;
  snapshot(): JobProgressSnapshot;
};

export function createJobProgressReporter(
  options: JobProgressReporterOptions,
): JobProgressReporter {
  const now = options.now ?? (() => new Date());
  const minimumIntervalMs = nonNegativeInteger(
    options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS,
    "minimumIntervalMs",
  );
  const publishTimeoutMs = positiveInteger(
    options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    "publishTimeoutMs",
  );
  let current = validateJobProgressSnapshot({
    schema: JOB_PROGRESS_SCHEMA,
    application: options.application,
    component: options.component,
    jobId: options.jobId,
    sourceRevision: options.sourceRevision,
    contractHash: options.contractHash,
    sequence: 0,
    state: options.initialState ?? "running",
    phase: options.initialPhase ?? "starting",
    startedAt: options.startedAt,
    updatedAt: options.startedAt,
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    tracks: options.initialTracks ?? [],
  });
  let lastQueuedAtMs = Number.NEGATIVE_INFINITY;
  let lastQueuedSequence = -1;
  let lastPublishedSequence = -1;
  let queuedOperation: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (snapshot: JobProgressSnapshot): Promise<void> => {
    if (lastQueuedSequence === snapshot.sequence && queuedOperation !== undefined) {
      return queuedOperation;
    }
    lastQueuedAtMs = Date.parse(snapshot.updatedAt);
    lastQueuedSequence = snapshot.sequence;
    const operation = tail.then(async () => {
      await publishWithDeadline(options.publish, cloneSnapshot(snapshot), publishTimeoutMs);
      lastPublishedSequence = Math.max(lastPublishedSequence, snapshot.sequence);
    });
    queuedOperation = operation;
    tail = operation.catch(() => undefined);
    void operation
      .finally(() => {
        if (lastQueuedSequence === snapshot.sequence) {
          lastQueuedSequence = -1;
          queuedOperation = undefined;
        }
      })
      .catch(() => undefined);
    return operation;
  };

  return {
    async report(update) {
      if (isTerminalJobProgressState(current.state)) {
        throw new Error("job progress cannot change after a terminal state");
      }
      if (current.sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("job progress sequence is exhausted");
      }
      const timestamp = now().toISOString();
      const state = update.state ?? current.state;
      const phase = update.phase ?? current.phase;
      const finishedAt = isTerminalJobProgressState(state)
        ? (update.finishedAt ?? timestamp)
        : update.finishedAt;
      const next = validateJobProgressSnapshot({
        ...current,
        sequence: current.sequence + 1,
        state,
        phase,
        updatedAt: timestamp,
        tracks: update.tracks ?? current.tracks,
        ...(update.cost === undefined ? {} : { cost: update.cost }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
      });
      assertMonotonicTracks(current, next);
      const publishNow =
        update.force === true ||
        phase !== current.phase ||
        isTerminalJobProgressState(state) ||
        Date.parse(timestamp) - lastQueuedAtMs >= minimumIntervalMs;
      current = next;
      if (!publishNow) return { snapshot: cloneSnapshot(current), published: false };
      await enqueue(current);
      return { snapshot: cloneSnapshot(current), published: true };
    },

    async flush() {
      if (lastPublishedSequence >= current.sequence) {
        await tail;
        return { snapshot: cloneSnapshot(current), published: false };
      }
      await enqueue(current);
      return { snapshot: cloneSnapshot(current), published: true };
    },

    snapshot() {
      return cloneSnapshot(current);
    },
  };
}

export function estimateJobProgress(
  snapshots: JobProgressSnapshot[],
  now = new Date(),
): JobProgressEstimate {
  if (snapshots.length === 0)
    throw new Error("job progress estimation requires at least one snapshot");
  const validated = snapshots.map(validateJobProgressSnapshot);
  const latest = validated.at(-1) as JobProgressSnapshot;
  for (const snapshot of validated) assertSameIdentity(latest, snapshot);
  const keys = latest.tracks.map((track) => track.key);
  const tracks: ProgressTrackState[] = keys.map((key) => {
    const samples: ProgressSample[] = validated.flatMap((snapshot) => {
      const track = snapshot.tracks.find((candidate) => candidate.key === key);
      return track === undefined ? [] : [{ at: snapshot.updatedAt, data: track.data }];
    });
    return { key, samples, estimate: estimateProgress(key, samples, now) };
  });
  return {
    snapshot: cloneSnapshot(latest),
    tracks,
    estimates: tracks.map((track) => track.estimate),
  };
}

function assertMonotonicTracks(previous: JobProgressSnapshot, next: JobProgressSnapshot): void {
  if (previous.phase !== next.phase) return;
  for (const track of next.tracks) {
    const prior = previous.tracks.find((candidate) => candidate.key === track.key);
    if (prior === undefined || resetsTrack(prior, track)) continue;
    if (
      prior.data.completed !== undefined &&
      track.data.completed !== undefined &&
      track.data.completed < prior.data.completed
    ) {
      throw new Error(`job progress track ${track.key} completed value must not decrease`);
    }
  }
}

function resetsTrack(previous: JobProgressTrack, next: JobProgressTrack): boolean {
  return (
    previous.data.phase !== next.data.phase ||
    previous.data.unit !== next.data.unit ||
    previous.data.total !== next.data.total
  );
}

function assertSameIdentity(expected: JobProgressSnapshot, actual: JobProgressSnapshot): void {
  for (const field of [
    "application",
    "component",
    "jobId",
    "sourceRevision",
    "contractHash",
    "startedAt",
  ] as const) {
    if (expected[field] !== actual[field]) {
      throw new Error(`job progress sample ${field} does not match`);
    }
  }
}

async function publishWithDeadline(
  publish: JobProgressReporterOptions["publish"],
  snapshot: JobProgressSnapshot,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`job progress publication timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([publish(snapshot, controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function cloneSnapshot(snapshot: JobProgressSnapshot): JobProgressSnapshot {
  return structuredClone(snapshot);
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
