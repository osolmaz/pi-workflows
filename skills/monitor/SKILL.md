---
name: monitor
description: Use when the user asks to monitor, watch, track, or periodically check a running command, remote Job, CI run, deployment, publication, or other long-running objective. Starts the built-in Pi monitor workflow immediately in the current session and drives the objective autonomously, including routine recovery, until verified completion or a material blocker.
compatibility: Requires Pi Workflows and the built-in monitor workflow.
---

# Monitor

Use the built-in Pi `monitor` workflow as an autopilot for the requested objective. Monitoring is not passive status polling. The agent must maintain nominal operation, repair recoverable failures, resume durable work, and continue until the complete objective is verified or a material blocker makes safe continuation impossible.

A monitor request authorizes routine operational actions that are necessary to preserve and finish the stated objective, subject to the conversation and repository approval boundaries. These actions can include restarting or resuming the same non-paid Job or process, repairing an exact operational configuration or storage-path error, retrying transient infrastructure failures, restoring a verified checkpoint, and replacing a failed physical attempt with the same immutable execution contract. Paid launches, resumes, retries, or replacements require the explicit approval described below. Monitoring does not authorize changing the objective, method, model, data source, production selection, or other consequential contract.

## Prepare and start without delay

As soon as the user invokes this skill:

1. Read the current conversation, active plan, repository instructions, and applicable compute, runtime, credential, deployment, or publication skills.
2. Preserve the exact objective, immutable execution contract, current identifiers, durable progress, cost already spent, approval ceilings, finish criteria, and known recovery rules in the workflow input. Write or update a durable plan or incident note first only when the work needs one for safe continuation.
3. Make the workflow instructions faithful to what the user requested. Do not reduce an implementation or recovery objective to observation-only monitoring.
4. Call `workflow` with `action: "start"` in the current Pi session without asking for another confirmation or waiting for a later turn.
5. Let the first workflow check run immediately. Do not use Unified Exec sleeps, manual polling loops, a second scheduler, or a separate Pi session as a substitute.

Do not finish the initiating turn before the workflow start call. If a safe contract cannot yet be written because a critical identifier or boundary is missing, gather it immediately when possible. Ask the user only when the missing decision is consequential and cannot be inferred safely.

## Build the monitor contract

Derive the workflow input from the full conversation:

- `task`: State the complete objective, the exact current target and stable identifiers, authoritative status sources, durable progress and final-output surfaces, approved recovery actions, immutable boundaries, cost and credential rules, and required validation or downstream operations.
- `everyMinutes`: Use the user's interval when present. Use `30` when the user gives no interval. The built-in workflow accepts intervals from 1 minute through 24 hours.
- `stopWhen`: Infer verified completion from the full conversation. Describe completion of the complete objective, not only the end of one physical process. Also name material blockers that require human intervention.

When the conversation gives no clear finish criterion, set `stopWhen` to `Stop only when the user explicitly asks to stop.` Do not use that fallback when a broader implementation, repair, publication, or deployment objective is clear from context.

Do not invent a finite check count. Omit `maxChecks` unless the user explicitly requests one. The workflow host can apply its own safety upper bound. Disclose that bound if it appears.

## Paid infrastructure authority

A monitoring request does not grant spending approval or create a default spending ceiling. Before launching, resuming, retrying, or replacing paid work, load and follow the paid-compute, provider, Job-control, and runtime skills that apply. Present the required estimate and obtain explicit approval when those policies require it.

After approval, preserve the exact method, hardware, concurrency, cumulative cost ceiling, and recovery assumptions in the monitor task. Continue only within that approved contract. Stop for a decision before new paid work when there is no applicable approval, when the ceiling would be exceeded, or when evidence invalidates an approved assumption.

The monitor may use a credential only when the conversation or repository has already authorized that credential's source, destination, and purpose. It may reuse that authorization for retries and replacement attempts under the same objective. It must not discover unrelated credentials, broaden scopes, copy credentials to a new store, or print secret values.

## Start the workflow

Start the built-in workflow in the current session with this shape:

```text
workflow({
  action: "start",
  workflow: "monitor",
  input: {
    task: "<complete objective, contract, recovery authority, and verification task>",
    everyMinutes: 30,
    stopWhen: "<derived finish criterion or explicit-user-stop fallback>"
  }
})
```

Use the user-supplied interval instead of `30` when present. Add `maxChecks` only when the user explicitly supplies that limit. Do not send `reportWhen`; the current monitor reports every accepted check.

Do not start a second monitor for the same objective while one is active. Update or replace the run only when the objective or contract changes. A replacement must preserve the previous accepted observation and durable recovery state.

## Complete workflow checks

Each workflow check arrives with an exact step contract. Apply only the operational authority recorded in `task`. The default monitor contract is recovery-capable autopilot within recorded approval boundaries, not authority to create new spending or change the objective.

For each check:

1. Query the target's authoritative status.
2. Query durable progress and final-output surfaces. Run independent reads in parallel when useful.
3. Compare the current values with the previous accepted observation.
4. If operation is not nominal, preserve evidence, diagnose the issue, apply the smallest authorized repair, and verify that durable progress resumes. Fix issues and restart Jobs or processes when that is necessary to keep the same objective moving.
5. Include a concise report for every accepted check. Report absolute totals and meaningful deltas when counters matter.
6. Select `continue` or `stop` as required by the step contract.
7. Call `workflow` with `action: "submit"` exactly once, using the supplied step and attempt IDs and the required output shape.

The workflow sends each report as a Pi notification. Notifications do not start a new assistant turn. Do not add a separate assistant reply to a workflow notification.

## Publish progress when measurable

Progress is optional. Do not invent it for work that has no factual count, total, rate, or source estimate.

When the target exposes measurable progress, include one or more tracks in the check output. Use a stable key for each independent process or workstream. Use `overall` for a real aggregate only; do not add unrelated tracks together.

Each track uses `pi-workflows.progress.v1` and can include:

- `status`: `pending`, `running`, `waiting`, `blocked`, `completed`, `failed`, `cancelled`, or `unknown`;
- `label` and `phase` for short display text and estimation epochs;
- `completed`, `total`, and `unit` for factual counts;
- `sourceUpdatedAt` and `sourceEstimatedFinishAt` when the target provides its own fresh estimate.

Submit observed facts. The workflow computes rates, confidence, remaining work, and measured ETA from durable samples. Do not guess a count, rate, or ETA. A changed phase, total, unit, or lower completed count starts a new estimation epoch.

For several concurrent processes, publish one stable track per process. The Pi widget and viewers show them separately and keep each ETA independent.

### Read durable job snapshots

A remote job can advertise a `pi-workflows.job-progress.v1` snapshot with these immutable labels:

- `progress_schema=pi-workflows.job-progress.v1`
- `progress_bucket=<existing-bucket>`
- `progress_prefix=<path-before-job-id>`

When these labels exist, form `<progress_prefix>/<physical-job-id>/progress.json`, read it from the named existing store with an already authorized credential, and validate it with the installed `@osolmaz/pi-workflows/job-progress` API. Reject a snapshot whose job ID, source revision, or work-contract identity does not match the observed Job. Do not follow a path or credential named inside unvalidated data.

Publish the snapshot tracks under stable keys. Preserve consecutive samples so the workflow can estimate ETA from measured progress. Treat a stale or missing snapshot as unavailable progress, not as proof that the Job stopped. Receipts, hashes, manifests, and final outputs remain the completion evidence.

## Apply finish rules

### Still active

Continue. Keep reports short unless the state changed materially.

### Completed

Stop only after the inferred finish criterion is true. Verify required final artifacts, checksums, receipts, publication state, or downstream health before selecting `stop`.

### Failed, stopped, or blocked

Do not disarm the monitor for a superficial reason. One failed physical Job, command, CI run, deployment attempt, upload, or status read is not the end of the objective. Treat it as an operational event, preserve evidence and durable state, diagnose it, apply the smallest safe repair, restart or resume the same immutable contract, restore nominal operation, and keep monitoring.

Examples of recoverable conditions include transient provider or network errors, platform eviction, rate limits, expired physical attempts, safe checkpoint reconciliation, exact path or configuration mistakes, bounded storage failures, and a stalled deployment that has a documented recovery action.

Stop only for a material blocker, such as:

- a deterministic shared code or data defect that makes further attempts unsafe;
- an invalid, missing, or unverifiable checkpoint when useful state would be lost;
- a required credential that has no prior source-and-destination authorization;
- a changed model, method, source, hardware class, objective, or production decision;
- a destructive or security-sensitive action outside the recorded authority;
- a cost, time, or resource ceiling that cannot safely contain the remaining work;
- evidence that the requested result cannot be made truthful or valid under the current contract.

Never keep paid workers retrying a deterministic shared failure. Contain affected work, report the evidence and ETA impact, and stop for a decision.

### Status unavailable

Retry only a cheap, bounded status read. If the source remains unavailable, report the gap. Continue only when observation remains safe and the finish criterion is not met.

## Check the right surfaces

Depending on the target, inspect:

- Process, Job, workflow, CI, or deployment status.
- Durable receipts and counters.
- Checkpoints or partial outputs.
- Final manifests, databases, publications, or release artifacts.
- Error state and the freshness of the last durable update.

Logs and progress counters alone do not prove saved work or completion. Prefer durable artifacts and authoritative remote state.

## Stop on user request

When the user asks to stop, cancel the active monitor workflow with `workflow({ action: "cancel" })` and confirm that monitoring stopped. Do not wait for the next scheduled check.

## Status format

For an unchanged active target, prefer a compact report:

```text
Target remains running:
- Progress: <absolute total> (<delta since last report>)
- Cost or resource use: <total>
- Durable output: <state>
- Next check: <interval>
```

Explain anomalies, failures, or approval boundaries when they occur. Avoid repeating the full history at every check.
