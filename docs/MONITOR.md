# Built-in monitor

This specification defines the built-in `monitor` workflow and its use of [workflow updates](WORKFLOW_UPDATES.md).

The monitor checks a target, sends one status notification after every accepted check, publishes optional progress tracks, waits, and repeats until its stop rule or safety limit is reached.

## Minimal input

```json
{
  "task": "Check pull request 123 in osolmaz/example. Read state and checks with gh. Observe only.",
  "stopWhen": "Stop when the pull request is merged or closed."
}
```

`everyMinutes` defaults to 30. The first check starts immediately.

## Input fields

| Field                 | Required | Type    | Default            | Meaning                          |
| --------------------- | -------- | ------- | ------------------ | -------------------------------- |
| `task`                | Yes      | string  | None               | Self-contained observation task. |
| `everyMinutes`        | No       | integer | `30`               | Minutes between accepted checks. |
| `stopWhen`            | No       | string  | Explicit user stop | Condition that ends monitoring.  |
| `maxChecks`           | No       | integer | `1000`             | Run safety limit.                |
| `checkTimeoutMinutes` | No       | integer | Derived            | Timeout for one agent check.     |

`task` is 1 to 8,000 characters after trimming. It should name the target, stable identifier, source of truth, durable outputs, and observation boundary. It must state any authorized mutations. Monitoring is read-only when the task does not authorize a mutation.

`everyMinutes` is from 1 through 1,440. The interval begins after a check report is durably queued. It does not delay the first check.

`stopWhen` is 1 to 4,000 characters when supplied. When the conversation gives no clear finish condition, the caller omits it and the workflow uses `Stop only when the user explicitly asks to stop.`

`maxChecks` is from 1 through 1,000. Agents must omit it unless the user explicitly asks for a fixed check count. The workflow's default of 1,000 is a disclosed runtime safety limit. The agent does not infer it as a finish condition.

`checkTimeoutMinutes` is from 5 through 1,440. When omitted, the workflow uses the larger of 60 minutes and `everyMinutes`. The node timeout includes the existing two-minute runtime margin.

`reportWhen` is removed. The monitor always reports after every accepted check.

## Check output

The check agent submits:

```json
{
  "route": "continue",
  "observation": "The pull request is open and 8 of 10 checks passed.",
  "report": "PR 123 remains open. Eight of ten checks passed; two are running.",
  "progress": {
    "tracks": [
      {
        "key": "checks",
        "data": {
          "schema": "pi-workflows.progress.v1",
          "label": "Checks",
          "status": "running",
          "completed": 8,
          "total": 10,
          "unit": "checks"
        }
      }
    ]
  },
  "reason": "The stop condition is not met."
}
```

Fields:

| Field         | Required | Type   | Meaning                        |
| ------------- | -------- | ------ | ------------------------------ |
| `route`       | Yes      | string | `continue` or `stop`.          |
| `observation` | Yes      | string | Current factual state.         |
| `report`      | Yes      | string | Concise user-facing update.    |
| `progress`    | No       | object | Current progress tracks.       |
| `reason`      | Yes      | string | Reason for the selected route. |

`observation` is at most 8,000 characters. `report` is at most 4,000 characters. `reason` is at most 2,000 characters. All three must be non-empty after trimming.

`progress.tracks` contains from 1 through 256 entries. Each entry has a unique `key` and one valid `pi-workflows.progress.v1` data object. The progress update rules, reserved `overall` key, and validation behavior come from [WORKFLOW_UPDATES.md](WORKFLOW_UPDATES.md).

Unknown check fields are validation errors. A missing report is a validation error for both routes.

## Graph

The built-in graph uses existing nodes:

```text
prepare
  → check
  → estimate
  → publish_progress
  → report
  → decide
      ├─ stop → finish
      └─ continue → schedule → sleep → check
```

- `prepare` is a `compute` node that validates and applies input defaults.
- `check` is an `agent` node that inspects the target and submits the check output.
- `estimate` is a `compute` node that updates per-track rate and ETA state with the pure progress helpers.
- `publish_progress` is a function `action` that publishes each validated observed track.
- `report` is a `notify` node that queues exactly one report.
- `decide` is a `compute` node that applies the route and check safety limit.
- `schedule` is a function `action` that publishes the next-check time.
- `sleep` is the existing runtime-owned shell wait.
- `finish` is a `compute` node that returns the final observation and reason.

The workflow has no quiet route, report acknowledgement agent, or `presentationPrompt`.

## Check prompt

The check prompt includes:

- check number and safety limit
- task
- stop condition
- previous accepted observation
- previous progress and estimate summary when present
- read-only boundary unless the task authorizes a mutation
- required output shape

It tells the model that every accepted check must include a concise report. It tells the model to submit observed progress facts and target-provided ETA values only. The model does not calculate the official rate, confidence, or measured ETA.

A check may use available tools to read current state. It must use the target's authoritative source instead of treating a prior report or workflow update as current truth.

## Progress publication

`estimate` keeps the last eight usable intervals for each track in its normal node output. The output is durable and becomes the prior estimator state on the next loop visit.

`publish_progress` calls `context.publishUpdate()` once for each track with:

```ts
{
  type: "progress",
  key: track.key,
  data: track.data,
}
```

The published data remains the observed progress snapshot. Derived estimates stay in the estimator output and presentation view. The widget and viewer combine the observed update history with the pure estimator so they do not misrepresent estimates as target facts.

When a check contains no progress object, `estimate` and `publish_progress` return an empty result. The report still runs.

## Schedule publication

Before sleeping, `schedule` publishes:

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

All fields are required. Times use RFC 3339 UTC form. `everyMinutes` must match the prepared monitor configuration.

The schedule update lets the widget and viewer show time since the last check and time until the next check without calling a model or writing state on each clock tick.

## Report formatting

The notification begins with the submitted `report`. When progress is present, a model-free formatter appends a bounded structured summary.

Example:

```text
Import remains healthy.
Progress: 420/1,000 rows (42%, +60)
Rate: 29–33 rows/min
ETA: 18–20 min (medium confidence, 4 samples)
Next check: 30 min
```

Rules:

- Show absolute values before deltas.
- Label source ETA as `source ETA`.
- Show `ETA unavailable` with a short reason when no valid estimate exists.
- Do not display a negative countdown after an ETA passes.
- Use `ETA passed; awaiting next check` until a new sample arrives.
- Keep failed, blocked, or stale state ahead of rate details.
- Show every track when the formatted report remains within 4,000 characters.
- When it does not fit, show `overall`, failed or blocked tracks, then as many active tracks as fit, followed by the omitted count.

Unrelated tracks are never combined. The monitor uses an explicit `overall` track when the target supplies meaningful aggregate progress.

## Notification delivery

Each accepted check reaches `report`, including a check that selects `stop`. The `notify` node writes one durable message through the existing session-addressed outbox.

The extension delivers the custom Pi message with `triggerTurn: false`. The notification stays in session history and later model context. Its arrival does not start an assistant response.

The monitor does not use `sendUserMessage`. It does not ask an agent to repeat or acknowledge the notification. After the workflow tool accepts the check, the extension removes any extra assistant tail text from that agent run, so only the notification reports the check.

A check that times out or fails before producing accepted output is not an accepted check. The run enters its normal terminal error state and the extension shows the workflow lifecycle notification. It does not invent a successful check report.

## Routing and stopping

`route: "stop"` queues the report and then completes the workflow.

`route: "continue"` queues the report and then checks the safety limit. If the limit remains available, the workflow schedules and waits for the next check. If the accepted check reaches `maxChecks`, the workflow finishes after that check's report and records `Reached the <n>-check safety limit.`

A user cancellation stops the active check or wait immediately. It does not queue another report. The existing workflow lifecycle notification reports cancellation.

Failures, blocked states, and unavailable status follow the user's `stopWhen` rule. The check may continue after reporting an unavailable source when observation remains safe and the stop condition is not met. It must stop when the requested terminal state is verified.

## Widget

Progress display is optional. A monitor without progress uses the normal workflow graph widget.

With progress, the widget uses the existing 10-line budget. It keeps the active graph row and uses remaining lines for a compact progress panel. It shows `overall` first, then failed or blocked tracks, then active tracks. Existing widget scrolling exposes omitted tracks.

The widget may show:

```text
Overall   420/1,000 rows  ETA 18–20m
Worker A  running         7m elapsed
Worker B  waiting
Last check 7m ago  next check 23m
```

Between checks, the existing one-second widget ticker may update:

- workflow and phase elapsed time
- time since the last progress sample
- ETA countdown derived from the last estimate
- time until the next check

It does not advance observed `completed`, publish updates, write bundle state, or call a model.

When an ETA expires, the widget shows that the estimate passed and waits for the next sample. `piw` shows the complete track list, update history, estimate basis, confidence, and source timestamps.

## Several monitored processes

One monitor can track several processes. Each uses a stable progress key. A missing key in a later check does not mean completion; the check should publish an explicit terminal or `unknown` state before it stops reporting that process.

The progress estimator treats each key independently. A phase, unit, total, or counter reset in one track does not reset another track.

## Interval and lifetime

The normal workflow engine remains finite. The built-in monitor therefore retains the 1,000-check safety ceiling and must not claim to be mathematically unbounded.

At the default 30-minute interval, the ceiling allows about 20 days and 20 hours after the immediate first check. A caller that needs longer unattended reconciliation should use the controller runtime. A controller-backed indefinite monitor is a separate resource lifecycle. The workflow engine keeps its finite-step guard.

The monitor skill must disclose a surfaced host limit and must never invent a smaller limit such as two checks. When no finish condition is clear, it sets the stop rule to explicit user stop and omits `maxChecks` so the workflow uses its documented safety ceiling.

## Safety boundaries

Monitoring authorizes observation and scheduled checks. It does not authorize retries, restarts, scaling, deployment, publication, cancellation of the target, or higher spending.

A progress object is data. It cannot contain a command or grant execution authority. Fixed probes belong in workflow-authored `action` or `shell` nodes.

Paid compute, inference runtime, and other domain policies continue to apply to every check.

## Validation and acceptance

The implementation must test:

- input defaults and bounds
- removal of `reportWhen`
- rejection of old quiet routes
- required reports on both routes
- exactly one notification per accepted check
- no assistant turn from a notification
- progress omission and multiple tracks
- invalid and duplicate track keys
- progress resets and stale samples
- measured, source, unavailable, paused, and expired ETA display
- schedule timestamps and countdown rendering
- final report before stop
- safety-limit report before completion
- immediate cancellation during a check or wait
- resume after host interruption
- widget behavior with zero, one, and many tracks

The real-Pi end-to-end test must start a short monitor, observe its custom notification without a new assistant turn, inspect the widget, and stop the run without mutating an external target.
