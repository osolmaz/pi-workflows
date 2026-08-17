# Durable job progress

`@osolmaz/pi-workflows/job-progress` lets a remote job publish progress that a Pi Workflows monitor can validate and measure. It uses the existing `pi-workflows.progress.v1` track contract and ETA estimator.

## Report progress

Create one reporter for one physical job. Inject the storage write so the package remains independent of a cloud provider.

```ts
import { createJobProgressReporter } from "@osolmaz/pi-workflows/job-progress";

const reporter = createJobProgressReporter({
  application: "example",
  component: "batch-worker",
  jobId: process.env.JOB_ID ?? "local",
  sourceRevision: "abc123",
  contractHash: "def456",
  startedAt: new Date().toISOString(),
  minimumIntervalMs: 30_000,
  publishTimeoutMs: 15_000,
  publish: async (snapshot, signal) => {
    await bucket.writeText(progressPath, JSON.stringify(snapshot), { signal });
  },
});

await reporter.report({
  phase: "processing",
  tracks: [
    {
      key: "records",
      data: {
        schema: "pi-workflows.progress.v1",
        status: "running",
        phase: "processing",
        completed: 400,
        total: 1_000,
        unit: "records",
      },
    },
  ],
});
```

The first update, each phase change, and each terminal update publishes immediately. Other updates are coalesced until `minimumIntervalMs` has passed. Call `flush()` at a durable checkpoint or before exit when the current snapshot has not been published.

The reporter keeps the latest snapshot after a write failure. The application decides when to log and retry that failure. A progress failure must not replace receipt or checkpoint validation.

## Finish a job

A terminal update gets a finish timestamp and publishes immediately:

```ts
await reporter.report({
  state: "completed",
  phase: "complete",
  tracks: [
    {
      key: "records",
      data: {
        schema: "pi-workflows.progress.v1",
        status: "completed",
        phase: "complete",
        completed: 1_000,
        total: 1_000,
        unit: "records",
      },
    },
  ],
});
```

A terminal snapshot is not a receipt. Receipts, manifests, hashes, and durable application outputs remain authoritative.

## Store and discover snapshots

Write one mutable snapshot per physical job:

```text
<existing-bucket>/<application-prefix>/runs/<job-id>/progress.json
```

Add these immutable labels to the job or schedule:

```text
progress_schema=pi-workflows.job-progress.v1
progress_bucket=<existing-bucket>
progress_prefix=<application-prefix>/runs
```

A monitor reads the labels, forms `<progress_prefix>/<job-id>/progress.json`, validates the snapshot with `validateJobProgressSnapshot`, and publishes its tracks with stable keys. It should retain consecutive snapshots so Pi Workflows can estimate a conservative ETA from measured rates.

## Estimate from snapshots

```ts
import { estimateJobProgress } from "@osolmaz/pi-workflows/job-progress";

const result = estimateJobProgress(previousSnapshots);
for (const estimate of result.estimates) {
  console.log(estimate.key, estimate.remainingMedianMs);
}
```

The estimator returns no measured ETA until a track has a known total and enough positive progress samples. A source-provided `sourceEstimatedFinishAt` remains available through the normal progress contract.

## Data boundary

Snapshots may contain identifiers, phases, counters, totals, timestamps, and cost totals. Do not put credentials, environment values, input records, model responses, logs, or private content in a snapshot. The strict validator rejects unknown fields and limits the encoded snapshot to 64 KiB.
