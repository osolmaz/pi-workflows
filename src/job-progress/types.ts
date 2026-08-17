import type {
  ProgressEstimate,
  ProgressTrackState,
  WorkflowProgressData,
} from "../workflows/index.js";

export const JOB_PROGRESS_SCHEMA = "pi-workflows.job-progress.v1" as const;

export type JobProgressState =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type JobProgressTrack = {
  key: string;
  data: WorkflowProgressData;
};

export type JobProgressCost = {
  settledUsd: number;
  reservedUsd: number;
};

export type JobProgressSnapshot = {
  schema: typeof JOB_PROGRESS_SCHEMA;
  application: string;
  component: string;
  jobId: string;
  sourceRevision: string;
  contractHash: string;
  sequence: number;
  state: JobProgressState;
  phase: string;
  startedAt: string;
  updatedAt: string;
  deadlineAt?: string;
  finishedAt?: string;
  tracks: JobProgressTrack[];
  cost?: JobProgressCost;
};

export type JobProgressIdentity = Pick<
  JobProgressSnapshot,
  "application" | "component" | "jobId" | "sourceRevision" | "contractHash" | "startedAt"
> & {
  deadlineAt?: string;
};

export type JobProgressUpdate = {
  state?: JobProgressState;
  phase?: string;
  tracks?: JobProgressTrack[];
  cost?: JobProgressCost;
  finishedAt?: string;
  force?: boolean;
};

export type JobProgressPublish = (
  snapshot: JobProgressSnapshot,
  signal: AbortSignal,
) => Promise<void>;

type JobProgressReporterBaseOptions = JobProgressIdentity & {
  initialState?: Exclude<JobProgressState, "completed" | "failed" | "cancelled">;
  initialPhase?: string;
  publish: JobProgressPublish;
  minimumIntervalMs?: number;
  publishTimeoutMs?: number;
  now?: () => Date;
};

export type JobProgressReporterOptions = JobProgressReporterBaseOptions &
  (
    | { initialTracks: JobProgressTrack[]; previousSnapshot?: never }
    | { initialTracks?: JobProgressTrack[]; previousSnapshot: JobProgressSnapshot }
  );

export type JobProgressPublishResult = {
  snapshot: JobProgressSnapshot;
  published: boolean;
};

export type JobProgressEstimate = {
  snapshot: JobProgressSnapshot;
  tracks: ProgressTrackState[];
  estimates: ProgressEstimate[];
};
