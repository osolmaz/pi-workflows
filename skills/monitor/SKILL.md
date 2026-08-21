---
name: monitor
description: Use when the user asks to monitor, watch, track, or periodically check a running command, remote Job, CI run, deployment, publication, or other long-running objective. Starts the built-in Pi monitor workflow immediately in the current session and drives the objective autonomously, including routine recovery, until verified completion or a material blocker.
compatibility: Requires pi-workflows and the built-in monitor workflow.
---

# Monitor

Use the built-in Pi `monitor` workflow as an autopilot for the requested objective. Monitoring is not passive status polling. The agent must maintain nominal operation, repair recoverable failures, resume durable work, and continue until the complete objective is verified or a material blocker makes safe continuation impossible.

A monitor request authorizes routine, bounded work needed to preserve and finish the stated objective, subject to the conversation and repository approval boundaries. Apply other skills as safety and operating instructions. Do not turn their normal checks into new approval requests when the monitored objective and an existing approval already cover the action. Monitoring does not authorize changing the objective, method, model, data source, production selection, or other consequential contract.

## Start the workflow without delay

Build the complete input and start the workflow in the same turn. As soon as the user invokes this skill:

1. Read the current conversation, active plan, repository instructions, and applicable compute, runtime, credential, deployment, or publication skills.
2. Preserve the exact objective, immutable execution contract, current identifiers, durable progress, cost already spent, approval ceilings, finish criteria, and known recovery rules in the workflow input. Write or update a durable plan or incident note first only when the work needs one for safe continuation.
3. Make the workflow instructions faithful to what the user requested. Do not reduce an implementation or recovery objective to observation-only monitoring.
4. Call `workflow` with `action: "start"` in the current Pi session without asking for another confirmation or waiting for a later turn.
5. Let the first workflow check run immediately. Do not use Unified Exec sleeps, manual polling loops, a second scheduler, or a separate Pi session as a substitute.

Do not finish the initiating turn before the workflow start call. If a safe contract cannot yet be written because a critical identifier or boundary is missing, gather it immediately when possible. Ask the user only when the missing decision is consequential and cannot be inferred safely.

## Build the monitor contract

Derive the workflow input from the full conversation:

- `task`: State the complete objective, the exact current target and stable identifiers, authoritative status sources, durable progress and final-output surfaces, routine actions authorized by the monitor request, other recorded approvals, immutable boundaries, cost and credential rules, and required validation or downstream operations.
- `everyMinutes`: Use the user's interval when present. Use `30` when the user gives no interval. The built-in workflow accepts intervals from 1 minute through 24 hours.
- `stopWhen`: Infer verified completion from the full conversation. Describe completion of the complete objective, not only the end of one physical process. Also name material blockers that require human intervention.
- `repair`: Include this object only when the request or an existing approval authorizes mutation. Set `authorized: true` and record the repository, scope, base branch, merge policy, and constraints that apply. Omit it for observation-only work. Omit `repair.approval` for the default behavior: ask on each new repair plan and continue after 10 minutes without an answer. Use `{ "mode": "required" }` to block on plan changes or `{ "mode": "skip" }` to continue without asking.

Replace the example values below with facts from the conversation, then make one start call:

```json
{
  "action": "start",
  "workflow": "monitor",
  "input": {
    "task": "Monitor GitHub Actions run 123456 in owner/repository. Inspect the run and its artifacts, retry only transient status reads, and report each check. Do not change code or repository state.",
    "everyMinutes": 5,
    "stopWhen": "Stop when run 123456 completes and its required artifacts are verified, or when a material external blocker prevents truthful verification.",
    "checkTimeoutMinutes": 10
  }
}
```

For authorized repair, add a complete `repair` object instead of leaving mutation authority implicit:

```json
{
  "repair": {
    "authorized": true,
    "repository": "/absolute/path/to/repository",
    "scope": "Only /absolute/path/to/repository. May diagnose and fix failures related to the monitored objective, test, commit, push, and update its pull request. Must not modify other repositories, merge, release, deploy, change credentials, or change repository policy.",
    "constraints": ["Keep the monitored objective and method unchanged."],
    "baseBranch": "main",
    "merge": false
  }
}
```

When the conversation gives no clear finish criterion, set `stopWhen` to `Stop only when the user explicitly asks to stop.` Do not use that fallback when a broader implementation, repair, publication, or deployment objective is clear from context.

Do not invent a finite check count. Omit `maxChecks` unless the user explicitly requests one. The workflow host can apply its own safety upper bound. Disclose that bound if it appears.

When repair is authorized, route a concrete code or design defect through the monitor's shared plan-change path. Supply the problem, observed evidence, and a stable fingerprint of the issue plus target state. The path runs Autoplan, Autodoc, the configured plan decision, and Autoimplement, then checks the target again. Autoimplement does not ask again for the plan selected by Monitor. It uses the same shared path if later evidence requires another plan. Do not copy their prompts into the monitor task.

### Repair plan decisions

Omit `repair.approval` for autonomous mode. It asks the `operator` audience and continues with the exact presented plan after 10 minutes without an accepted answer.

Block until the operator answers:

```json
{
  "repair": {
    "approval": {
      "mode": "required"
    }
  }
}
```

Continue without asking:

```json
{
  "repair": {
    "approval": {
      "mode": "skip"
    }
  }
}
```

`continue` starts implementation. `stop` ends the repair truthfully. `replan` preserves the exact operator text, sends it through the shared plan-change workflow, records the revised plan, and asks again. The model-facing workflow answer tool cannot answer this gate.

## Keep routine work moving

While the workflow is active, do routine, bounded work required by the exact objective without asking for another confirmation. This includes:

- downloading, building, and running code pinned by the monitored objective;
- building and running task containers from a pinned benchmark or repository revision;
- installing pinned dependencies in the planned isolated environment;
- running canaries, tests, retries, restarts, and temporary cleanup;
- repairing configuration or storage-path errors without changing the method; and
- continuing paid work that already has applicable approval.

Pinned third-party code is part of the objective when the task names its exact repository, revision, lock file, image digest, or benchmark release. Resolve mutable references to immutable revisions when the applicable safety rules require it. Do not ask once per image, package, or task. New unpinned code, unrelated code, or broader privileges remain outside the monitor's authority.

## Paid infrastructure authority

A monitoring request does not grant spending approval or create a default spending ceiling. Before launching, resuming, retrying, or replacing paid work, load and follow the paid-compute, provider, Job-control, and runtime skills that apply. Use any applicable approval already recorded in the conversation or repository instructions.

When the paid action remains within the approved method, hardware, concurrency, cumulative cost ceiling, and recovery assumptions, continue without asking again. Stop for a decision before new paid work only when there is no applicable approval, the ceiling would be exceeded, or evidence invalidates an approved assumption.

The monitor may use a credential only when the conversation or repository has already authorized that credential's source, destination, and purpose. It may reuse that authorization for retries and replacement attempts under the same objective. It must not discover unrelated credentials, broaden scopes, copy credentials to a new store, or print secret values.

Use the user-supplied interval instead of the example value when present. Add `maxChecks` only when the user explicitly supplies that limit. Do not send `reportWhen`; the current monitor reports every accepted check.

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

The regular Pi model that runs the check is the observation adapter. It reads the target through the tools and sources named in the task, maps observed facts to progress tracks, and publishes them through the existing `workflow` tool. There is no separate monitor model.

Progress is optional. Do not invent it for work that has no factual count, total, rate, or source estimate.

When the target exposes measurable progress, publish one or more tracks with `workflow` action `update` while the check is active when that gives the user useful current state. Include the latest tracks in the final check output, then call `submit` exactly once. Use a stable key for each independent process or workstream. Use `overall` for a real aggregate only; do not add unrelated tracks together.

Each track uses `pi-workflows.progress.v1` and can include:

- `status`: `pending`, `running`, `waiting`, `blocked`, `completed`, `failed`, `cancelled`, or `unknown`;
- `label` and `phase` for short display text and estimation epochs;
- `completed`, `total`, and `unit` for factual counts;
- `sourceUpdatedAt` and `sourceEstimatedFinishAt` when the target provides its own fresh estimate.

Submit observed facts. The workflow computes rates, confidence, remaining work, and measured ETA from durable samples. Do not guess a count, rate, or ETA. A changed phase, total, unit, or lower completed count starts a new estimation epoch.

For several concurrent processes, publish one stable track per process. The Pi widget and viewers show them separately and keep each ETA independent.

Keep the monitored target independent of pi-workflows. Do not require a target Job or application to import pi-workflows, emit a Pi schema, write a Pi progress file, expose a Pi endpoint, create a progress store, or add a progress reader command solely for monitoring. Do not add provider-specific clients or credentials to pi-workflows. Target-specific observation belongs in the check task and is performed by the regular Pi model with already authorized tools.

Before proposing a new progress API, transport, schema, or persistence layer, prove that the model cannot observe the needed facts and publish them through the existing `workflow update` and `submit` path. If the target does not expose enough facts for ETA, report `ETA unavailable`. Application telemetry changes require separate scope and should expose normal operational facts rather than a Pi-specific protocol.

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

Never keep paid workers retrying a deterministic shared failure. When repair is authorized and the defect is inside scope, stop affected work, preserve the evidence, and use the composed repair path. Stop for a decision when repair is outside scope or would change a protected contract.

If the same issue and target-state fingerprint return after a completed repair, report the no-progress result and stop. Do not start the same repair again.

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
