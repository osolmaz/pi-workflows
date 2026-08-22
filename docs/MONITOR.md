# Built-in monitor

This specification defines the built-in `monitor` workflow and its use of [workflow updates](WORKFLOW_UPDATES.md).

Monitor finishes an authorized goal. It observes the real target, performs a safe action when work is incomplete and idle, confirms the result, and checks again on schedule until the goal is complete or cannot continue safely.

## Input

```json
{
  "task": "Resume the six missing modules and monitor the full 27-module build. Use the saved outputs. Keep total paid work below the recorded limit.",
  "stopWhen": "Stop when all 27 modules have verified outputs or when safe continuation is blocked.",
  "everyMinutes": 15
}
```

The public input has four fields:

| Field          | Required | Type    | Default            | Meaning                           |
| -------------- | -------- | ------- | ------------------ | --------------------------------- |
| `task`         | Yes      | string  | None               | Goal, authority, and constraints. |
| `stopWhen`     | No       | string  | Explicit user stop | Condition that ends monitoring.   |
| `everyMinutes` | No       | integer | `30`               | Minutes between timed checks.     |
| `maxChecks`    | No       | integer | `1000`             | Observation safety limit.         |

`task` is 1 to 8,000 characters after trimming. It must preserve the user's goal and the authority already present in the conversation and repository instructions. This includes:

- allowed files, systems, providers, runtimes, and resources
- forbidden changes
- cost and resource limits
- required checks
- stop conditions
- allowed recovery actions
- durable progress, checkpoints, and known target identifiers

`stopWhen` is 1 to 4,000 characters when supplied. When the conversation gives no finish condition, the workflow uses `Stop only when the user explicitly asks to stop.`

`everyMinutes` is an integer from 1 through 1,440. The first observation starts immediately. The interval applies only after an observation proves that work is moving or waiting for an external event.

`maxChecks` is an integer from 1 through 1,000. Callers omit it unless the user asks for a fixed limit. The default is a runtime safety limit.

The input parser rejects every unknown field before a run is created. Inputs such as `audience`, `repair`, and `checkTimeoutMinutes` fail with a direct unsupported-field error. There are no compatibility aliases for removed fields.

## Authority

Monitor uses only authority that already exists in `task`, `stopWhen`, the conversation, and repository instructions. It does not infer permission from an idle target or from the existence of a possible action.

The first observation extracts the applicable contract:

- the complete goal
- allowed files and systems
- forbidden changes
- cost ceiling
- provider and runtime contract
- required checks
- stop conditions
- allowed recovery actions

An action can run only when its full effect is inside that contract. Monitor stops and reports the missing decision when an action would exceed the contract.

A monitoring request does not create spending approval. Before paid work starts or resumes, the action must verify an applicable approval and prove that the next action stays inside its cumulative cost limit. It must not launch when the cost limit is missing, cannot be verified, or would be exceeded.

## Read-only observation

Every cycle begins with the `observe` agent step. The first observation and all observations after actions are read-only. The model uses normal tools to inspect authoritative target state and durable outputs.

The observation answers these questions:

- Is the goal complete?
- Is useful work active?
- Is the goal incomplete and idle?
- Did work fail?
- Is there a material blocker?
- Which safe actions are already authorized?

The result uses one of three routes:

- `wait`: Work is moving, or an external event must finish.
- `act`: The goal is incomplete and a safe authorized action is available.
- `stop`: The goal is complete or cannot continue safely.

The observation records the goal state and target work state separately. It also lists the safe actions that the user has already authorized, even when no action is needed now. Monitor state is never evidence that target work is running.

## Action request

An `act` result contains one action request with:

- `kind`: `advance`, `recover`, or `repair`
- what is incomplete
- evidence that proves it
- the exact next action
- why existing authority covers the action
- files, systems, or resources that may change
- how to verify the action
- a stable failure ID
- a stable target-state ID

The failure ID identifies the same failure across checks. The target-state ID identifies the relevant target state. Both values come from observed facts and remain stable while those facts remain unchanged.

The action request cannot grant authority. It can only describe authority found during observation.

## Direct actions

`advance` starts or continues normal requested work. `recover` restarts or resumes work after an operational stop.

Both routes use one mutation-capable `act` agent step with normal Pi tools. The step performs only the stated action. Its prompt includes the exact action, authority basis, allowed mutation set, and verification rule from the read-only observation.

Direct actions can include:

- starting work
- resuming saved work
- restarting stopped work
- running the next command
- updating a stale launch file
- retrying a safe external operation
- continuing from a verified checkpoint

A normal start, resume, or restart does not run Autoplan, Autodoc, or Autoimplement.

The action step returns whether the action succeeded, failed, or was blocked, with factual evidence. Monitor then runs `observe` again immediately. A failed direct action can lead to a new authorized recovery action, but it cannot cause an unbounded retry loop.

## Repair actions

`repair` changes code or configuration to fix a defect. It uses the existing shared plan-change workflow and Autoimplement workflow. Monitor does not copy their design, documentation, implementation, test, review, or delivery steps.

The repair input preserves the action request, target evidence, authority, constraints, repository, and delivery limits. Existing plan approval rules still apply when the recorded contract requires them.

Paid workers affected by a shared code or data defect must stop at safe boundaries before repair starts. Monitor preserves their durable outputs and failure evidence.

After a completed repair, Monitor runs `observe` immediately. If the same failure ID and target-state ID return, Monitor stops. It does not run the same repair cycle again.

## Workflow graph

```text
observe
  ├─ stop → finish
  ├─ wait → report → schedule → sleep → observe
  └─ act
       ├─ advance → direct action → observe immediately
       ├─ recover → direct action → observe immediately
       └─ repair → plan change → Autoimplement → observe immediately
```

The timer exists only on the `wait` route. No schedule or sleep step can occur between an action and its verification observation.

`maxChecks` counts accepted observations. Reaching the limit reports the real goal and work state before the workflow stops.

## Progress

Progress is optional. The regular Pi model reads the target through normal tools and converts observed facts into `pi-workflows.progress.v1` tracks. The existing workflow update channel stores and displays those tracks.

The target stays independent of Pi Workflows. Monitor must not require a target process, Job, application, provider, or repository to:

- import Pi Workflows
- expose a Pi-specific API or endpoint
- write a Pi-specific progress file
- create a Pi-specific store or schema
- add a Pi-specific command or dependency

When the target does not expose a factual completed value, total, rate, or source estimate, Monitor reports that the value or ETA is unavailable. It does not invent one.

Progress data cannot contain a command or grant mutation authority.

## Schedule publication

On the `wait` route, `schedule` publishes:

```json
{
  "type": "monitor.schedule",
  "key": "next-check",
  "data": {
    "schema": "pi-workflows.monitor-schedule.v1",
    "lastCheckAt": "2026-08-16T10:15:30.000Z",
    "nextCheckAt": "2026-08-16T10:45:30.000Z",
    "everyMinutes": 30
  }
}
```

All fields are required. Times use RFC 3339 UTC form. `everyMinutes` must match the prepared Monitor configuration.

No schedule update is published on `act` or `stop` routes.

## Reports

Every accepted observation sends one notification. Reports show Monitor state, goal state, and target work state as separate facts.

A moving target report uses this form:

```text
Monitor: active
Goal: incomplete
Work: running
Progress: 21/27 modules
Last action: resumed six missing modules
Next check: 15 minutes
```

An idle target that has an authorized action uses this form before the action runs:

```text
Monitor: active
Goal: incomplete
Work: idle
Next action: refreshing launch files and resuming work now
```

A report must not say `Work: running` because Monitor itself is active. It may say running only when target evidence proves useful work is active.

Progress formatting follows these rules:

- Show absolute values before deltas.
- Label a target-provided ETA as `source ETA`.
- Show `ETA unavailable` with a short reason when no valid estimate exists.
- Keep failed, blocked, or idle state ahead of rate details.
- Keep independent progress tracks separate.

Notifications use the existing session-addressed outbox with `triggerTurn: false`. They do not start an extra assistant response.

## Stop conditions

Monitor stops when:

- the goal is complete
- a material blocker prevents safe continuation
- the next action is outside recorded authority
- a paid action lacks approval or would exceed its limit
- a provider, runtime, method, data source, or other protected contract would change
- a required credential lacks prior source-and-destination authority
- a checkpoint is invalid or cannot preserve useful work
- the same failure and target state return after one completed repair
- the observation safety limit is reached
- the user cancels the run

Monitor reports the current goal and target work state before a normal `stop` route completes.

## Acceptance tests

The implementation must test at least these cases:

1. The goal is already complete.
2. Work is active, so Monitor waits.
3. Work is idle, so Monitor starts it.
4. Saved work exists, so Monitor resumes it.
5. An action succeeds, so Monitor observes again immediately.
6. An action fails once, then recovery succeeds.
7. The same repaired failure returns, so Monitor stops.
8. An action is outside authority, so Monitor stops.
9. A paid action exceeds the limit, so Monitor does not launch it.
10. Monitor is active while the target is idle.
11. The target completes between timed observations.
12. Unknown input fields fail before run creation.
13. A normal restart does not trigger planning or documentation.
14. A real code defect uses the existing repair path.
15. No target-specific monitoring API is required.

Existing progress, notification, cancellation, interruption, resume, widget, schedule, and safety-limit tests must continue to pass where they apply to the new graph.

The real-Pi end-to-end test must start a short Monitor run, observe its notification without an extra assistant turn, inspect the widget, and stop the run without mutating an external target.
