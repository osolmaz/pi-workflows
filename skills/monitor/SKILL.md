---
name: monitor
description: Use when the user asks to monitor, watch, track, or periodically check a running command, remote Job, CI run, deployment, publication, or other long-running goal. Starts the built-in Pi monitor workflow immediately and finishes the authorized goal through direct advance, recovery, or composed repair work until completion or a material blocker.
compatibility: Requires pi-workflows and the built-in monitor workflow.
---

# Monitor

Use the built-in Pi `monitor` workflow to finish the user's authorized goal. It observes the real target first, acts when safe authorized work is available, verifies every action immediately, and waits only while useful work is moving or an external event is pending.

Monitoring does not grant new authority. Preserve the exact objective, allowed and forbidden changes, cost ceiling, provider and runtime contract, required checks, stop conditions, and recovery rules from the conversation and repository instructions.

## Start the workflow

When no workflow is active, list workflows only when you must confirm that `monitor` is available. Build the complete input before starting, then call `workflow` with `action: "start"` exactly once in the same turn as the user's request.

The public input has four fields:

- `task`: Required. Put the complete goal, stable target identifiers, current durable progress, sources of truth, allowed files and systems, forbidden changes, cost limits, provider/runtime contract, required checks, allowed recovery actions, and stop boundaries here.
- `stopWhen`: Optional. Use the user's complete finish rule. Omit it only when the user gave no finish rule, which means explicit user stop.
- `everyMinutes`: Optional. Use the user's interval. The default is 30 minutes.
- `maxChecks`: Optional. Include it only when the user supplied a check limit.

Do not send any other field. Inputs such as `repair`, `checkTimeoutMinutes`, `reportWhen`, and `audience` are invalid.

When the task can change code or remote state, make `task` state the absolute repository path, concrete edit and test scope, base branch, commit and push authority, pull-request and merge authority, release and deployment authority, and inherited constraints. A repository path alone is not a scope. Derive a narrow scope when one repository and task are clear instead of asking the user to repeat it.

Replace the example values with facts from the conversation:

```json
{
  "action": "start",
  "workflow": "monitor",
  "input": {
    "task": "Finish the six missing modules in /absolute/path/to/repository. Resume only from verified saved outputs. May edit launch manifests and module outputs, run the named checks, and restart the existing pinned workers. Keep the current provider and runtime. Stay below the recorded cumulative cost ceiling. Do not change unrelated files, credentials, model selection, data source, base branch main, or production state. Commit and push are not authorized. Pull requests, merge, release, and deployment are not authorized. Stop before any action outside these limits.",
    "stopWhen": "All 27 modules have verified durable outputs, or safe continuation is blocked.",
    "everyMinutes": 15
  }
}
```

Do not start a second Monitor for the same goal while one is active. When this skill is loaded inside a workflow step, complete that step. Do not start a nested workflow.

## Observation steps

Every Monitor cycle starts with a read-only `observe` step. Use normal read-only tools to inspect the target's authoritative state, active work, durable outputs, checkpoints, failures, and applicable authority.

Answer these questions:

- Is the goal complete?
- Is useful target work active?
- Is the goal incomplete and idle?
- Did work fail?
- Is there a material blocker?
- Which safe actions are already authorized?

Select one route:

- `wait`: Useful target work is moving, or an external event must finish.
- `act`: The goal is incomplete and one safe authorized action is available.
- `stop`: The goal is complete or cannot continue safely.

Keep Monitor state, goal state, and target work state separate. Never call the target running because Monitor itself is active.

For `act`, provide one exact action with:

- `kind`: `advance`, `recover`, or `repair`
- incomplete work and factual evidence
- the exact next action
- the existing authorization and its source
- allowed and forbidden mutation targets
- cost and provider/runtime limits
- required checks and stop conditions
- verification method
- stable failure and target-state IDs

An action description records authority. It does not create authority.

## Direct action steps

`advance` starts or continues normal requested work. `recover` restarts or resumes work after an operational stop.

The separate `act` step uses normal tools and performs only the stated action. Do not plan, document, redesign, broaden scope, or add related work. A routine start, resume, retry, launch-file refresh, or checkpoint continuation stays direct and small.

Submit the real result with the unchanged failure and target-state IDs. Monitor observes again immediately. Do not wait for the next interval first.

## Repair steps

Use `repair` only for a code or configuration defect. Monitor composes the existing plan-change and Autoimplement workflows for repair. Do not start those workflows manually or copy their planning, documentation, implementation, review, or delivery steps.

Preserve the repair approval rule in `task`. `required` mode waits for an explicit operator choice. `skip` mode starts the selected repair without a gate. Default `auto` mode asks and then continues with the exact presented plan after 10 minutes when no answer arrives. These become the internal repair action's `"mode": "required"` or `"mode": "skip"`; they are not public Monitor input fields.

Stop affected paid workers at safe boundaries before repairing a shared code or data defect. Preserve durable outputs and failure evidence.

If the same failure and target-state IDs return after one completed repair, stop. Do not run the same repair cycle again.

## Authority and paid work

Monitor may perform an action only when the full action is inside existing authority. Stop when authority is absent, unclear, or too narrow.

A monitoring request does not grant spending approval. Before paid work starts or resumes, verify the applicable approval, method, hardware, concurrency, cumulative cost, and remaining ceiling. When the next action remains inside those limits, continue without asking again. Stop when the next action would exceed the limit or when the limit cannot be verified.

Pinned task code, images, packages, and dependencies that are already part of the authorized goal do not need a new decision for each normal use. Do not ask once per image, package, or task. New unpinned code, broader privileges, or a changed method remain outside authority.

Do not change protected model, method, data source, hardware class, provider/runtime contract, credential destination, production selection, or objective without new authority.

## Progress

The regular Pi model is the observation adapter. Read measurable facts with normal tools and publish useful progress through `workflow` action `update` while the step is active. Include the latest tracks in the final observation output.

Use stable keys. Report factual completed and total values, rates, and source ETA values only when the target exposes them. Otherwise report that progress or ETA is unavailable.

Do not require the monitored process, Job, application, provider, or repository to implement a Pi-specific API, file, endpoint, store, schema, command, service, transport, or dependency.

## Reports

Every accepted observation produces one status notification. Use this form when target work is active:

```text
Monitor: active
Goal: incomplete
Work: running
Progress: 21/27 modules
Last action: resumed six missing modules
Next check: 15 minutes
```

Use this form when the target is idle and an action will run:

```text
Monitor: active
Goal: incomplete
Work: idle
Next action: refreshing launch files and resuming work now
```

Show absolute progress before deltas. Do not invent an ETA.

## Stop conditions

Stop when:

- the goal is complete
- a material blocker prevents safe continuation
- the next action is outside authority
- a paid action lacks approval or would exceed its ceiling
- a protected contract would change
- a required credential lacks prior source-and-destination authority
- a useful checkpoint is invalid or cannot be preserved
- the same failure and target state return after one completed repair
- the safety limit is reached
- the user asks to stop

When the user asks to stop, cancel the active Monitor immediately with `workflow({ action: "cancel" })` and confirm that monitoring stopped.
