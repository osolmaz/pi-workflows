# Durable job progress

## Problem

Long-running remote jobs can expose state only through logs and final receipts. A monitor can confirm that a job is running, but it cannot give a reliable progress value or remaining time when the job does not publish a completed count, a total, and source timestamps.

xTap Pool and OurModels need the same durable progress contract. The contract must work with their existing Hugging Face Buckets, survive worker restarts, and use the ETA estimator that Pi Workflows already uses for `pi-workflows.progress.v1` tracks.

## Requirements

The implementation must:

- add one storage-neutral job progress API to `@osolmaz/pi-workflows`
- reuse `pi-workflows.progress.v1` for progress tracks
- write one mutable snapshot for each physical job in the application's existing Bucket
- let monitors discover the snapshot from immutable job labels
- let Pi Workflows validate the snapshot and estimate remaining time from repeated samples
- let xTap Pool report restore, review, recovery, and publication progress
- let OurModels report discovery, processing, cache, and publication progress
- keep receipts, content hashes, manifests, and databases authoritative
- avoid secrets, post text, model output, and other private content in progress snapshots
- preserve one physical enrichment job at a time during the xTap Pool change
- leave the OurModels replacement schedule suspended until a paid run is separately approved

## Non-goals

This work does not add:

- a new remote store
- a metrics database
- a second ETA protocol
- a Pi core change
- a service or daemon
- a compatibility path for an older snapshot schema
- automatic authority to retry, deploy, publish, or spend money

## Public contract

The npm package exports a new subpath:

```ts
import {
  createJobProgressReporter,
  estimateJobProgress,
  validateJobProgressSnapshot,
  type JobProgressSnapshot,
} from "@osolmaz/pi-workflows/job-progress";
```

A snapshot has schema `pi-workflows.job-progress.v1` and contains:

- stable application and component names
- the physical job identifier
- source and work-contract identifiers
- a monotonic sequence number
- job state and current phase
- start, update, optional deadline, and optional finish timestamps
- one or more keyed `pi-workflows.progress.v1` tracks
- optional settled cost and active reservation facts

The validator is strict. It rejects unknown fields, duplicate track keys, invalid timestamps, non-finite values, invalid progress tracks, and oversized snapshots.

The reporter accepts an injected asynchronous `publish(snapshot)` callback. Pi Workflows does not import a Hugging Face client. The reporter:

- keeps sequence numbers monotonic within the process
- rejects regressions within one phase and epoch
- coalesces frequent updates with a configurable minimum interval
- flushes phase changes and terminal states immediately
- bounds publication time with an abort deadline
- preserves the most recent unsent snapshot after a transient publication failure
- never includes arbitrary metadata or environment values

A terminal snapshot is operational evidence only. The application's receipt and durable output validation still decide whether work succeeded.

## Storage and discovery

Each application writes snapshots to its existing Bucket.

xTap Pool uses:

```text
osolmaz/xtap-pool-bucket/operations/enrichment/runs/<job-id>/progress.json
```

OurModels uses:

```text
osolmaz/ourmodels-data/<prefix>/operations/community-posts/runs/<job-id>/progress.json
```

Each schedule supplies these immutable labels:

```text
progress_schema=pi-workflows.job-progress.v1
progress_bucket=<bucket>
progress_prefix=<path-before-job-id>
```

A monitor reads the labels, appends the physical job identifier and `progress.json`, reads the snapshot with existing local Hugging Face authentication, validates it, and publishes each track under a stable workflow progress key. The monitor does not trust an ETA string from logs. It uses source finish time when the snapshot provides one, or the existing conservative estimator after enough measured samples.

## xTap Pool tracks

The enrichment worker reports these stable tracks when facts are measurable:

| Key                | Unit       | Source                                             |
| ------------------ | ---------- | -------------------------------------------------- |
| `database-restore` | bytes      | downloaded database bytes and expected object size |
| `registry-replay`  | events     | replayed registry events and discovered total      |
| `registry-scan`    | candidates | durable scan cursor and fixed candidate total      |
| `queue`            | records    | terminal records and durable queue total           |
| `publication`      | bytes      | uploaded and verified database bytes               |
| `overall`          | phases     | completed phases and fixed phase count             |

Phase-only states remain valid when a total is not yet known. The worker must not invent totals.

The existing three unresolved records must receive durable outcomes under the fixed full-response deadline or become exactly validated blocked records. The worker then publishes and verifies the index before its final receipt is accepted.

## OurModels tracks

The community-posts worker reports these stable tracks when facts are measurable:

| Key               | Unit    | Source                                          |
| ----------------- | ------- | ----------------------------------------------- |
| `model-discovery` | models  | discovered and inspected model count            |
| `community-posts` | models  | processed models and fixed discovered total     |
| `cache`           | records | durable cached model results and expected total |
| `publication`     | bytes   | uploaded and verified artifact bytes            |
| `overall`         | phases  | completed phases and fixed phase count          |

The worker continues to use its existing receipt and manifest rules. A progress write failure must not corrupt a useful checkpoint or published result.

## Delivery sequence

1. Add and release `@osolmaz/pi-workflows/job-progress` as version `0.8.0`.
2. Add snapshot discovery guidance to the bundled monitor skill.
3. Update xTap Pool to use `0.8.0`, add measured callbacks, and add schedule labels.
4. Merge and deploy xTap Pool, then replace the old suspended schedule.
5. End the old physical job only when the replacement source is ready and the one-job rule can be preserved.
6. Start one instrumented xTap Pool recovery job under the existing restoration budget.
7. Update OurModels to use `0.8.0`, add measured callbacks, and replace old schedules with one suspended instrumented schedule.
8. Do not start a paid OurModels run until its measured cost range and ceiling receive the required approval.
9. Start a Pi monitor that reads both progress surfaces and displays current progress and ETA.

## Acceptance checks

Pi Workflows must pass:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Tests must cover strict validation, unknown fields, duplicate keys, monotonic updates, phase resets, coalescing, transient publication failure, deadline abort, terminal flush, and ETA estimation from snapshots.

xTap Pool must pass its repository checks, including mutation testing. A live recovery must show a valid snapshot in the existing index Bucket, and repeated monitor samples must produce a measured ETA when a track has a known total and positive progress.

OurModels must pass:

```bash
npm run check
npm run coverage
npm run dry
npm run mutate
node scripts/test-bounds-engine.mjs
node scripts/validate-model-data.mjs
```

Its replacement schedule must remain suspended with only the approved two secrets until a paid run is authorized.

## Recovery

If a progress publication fails, the worker keeps useful work and retries only the latest snapshot at the next bounded update. If the job ends before that succeeds, the receipt and durable outputs remain authoritative and the monitor marks progress stale.

If a repeated deterministic worker defect appears, stop the affected job and schedule. Preserve all existing Bucket objects and return the exact failing phase, source revision, snapshot, receipt state, and last valid durable outputs.
