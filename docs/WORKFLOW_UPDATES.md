# Workflow updates

This specification defines durable, non-terminal updates from running Pi Workflows nodes. An update reports current state without finishing a node or choosing a graph route.

## Minimal examples

A function action publishes current state while it runs:

```ts
const processRows = action({
  run: async (context) => {
    await context.publishUpdate({
      type: "progress",
      key: "worker-a",
      data: {
        schema: "pi-workflows.progress.v1",
        label: "Worker A",
        status: "running",
        phase: "processing",
        completed: 420,
        total: 1_000,
        unit: "rows",
      },
    });

    return { processed: 420 };
  },
});
```

An agent publishes the same update through the existing `workflow` tool:

```json
{
  "action": "update",
  "step": "process",
  "attempt": "017f5d57-83f1-4d2d-88e6-3dbf878fed17",
  "update": {
    "type": "progress",
    "key": "worker-a",
    "data": {
      "schema": "pi-workflows.progress.v1",
      "label": "Worker A",
      "status": "running",
      "completed": 420,
      "total": 1000,
      "unit": "rows"
    }
  }
}
```

The `update` tool action does not complete the agent step. The agent still calls `submit` once with the final step output.

## Place in the workflow model

Pi Workflows keeps its current node primitives:

- `agent` for model judgment and language work
- `compute` for pure local calculation
- `action` for external reads and effects
- `notify` for durable user messages
- `checkpoint` for human or external input

`shell` remains the command form of `action`. Updates are a capability available while an agent or action runs. They are not a node type.

Updates do not:

- finish a node
- write to `outputs` or `results`
- choose an edge
- change workflow input
- execute commands
- notify the user by themselves
- trigger a model turn

A node's final result remains the only value that completes the node and controls routing.

## Model-mediated observation

For monitoring, the regular Pi model running the workflow step observes the external target and publishes progress with the existing `workflow` tool. This is the intended adapter boundary. Deterministic runtime code validates, persists, estimates, and renders the submitted data.

External Jobs and applications do not need a Pi Workflows dependency or reporting protocol. Provider-specific observation stays in the agent task and its authorized tools. If the target does not expose enough facts, the model publishes only what is known and leaves ETA unavailable.

Do not add a transport, endpoint, store, schema, or provider integration when the regular Pi model can observe the target and use `workflow update` or `submit`.

## Public types

The workflow layer adds these public types:

```ts
export type WorkflowUpdateInput = {
  type: string;
  key: string;
  data: Record<string, unknown>;
};

export type WorkflowUpdateRecord = {
  updateId: string;
  seq: number;
  at: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  type: string;
  key: string;
  data: Record<string, unknown>;
};

export type WorkflowUpdateReceipt = Pick<
  WorkflowUpdateRecord,
  "updateId" | "seq" | "at" | "type" | "key"
>;

export type WorkflowActionContext<TInput = unknown> = WorkflowNodeContext<TInput> & {
  publishUpdate(update: WorkflowUpdateInput): Promise<WorkflowUpdateReceipt>;
};
```

Function actions receive `WorkflowActionContext`. Compute and notify callbacks retain the read-only `WorkflowNodeContext`. Prompt builders and validators have the same restriction, as do checkpoint callbacks.

## Update envelope

### `type`

`type` names the update contract.

Rules:

- 1 to 64 characters
- lowercase ASCII letters, numbers, dots, and hyphens
- starts with a letter
- matches `[a-z][a-z0-9.-]{0,63}`

`progress` is the first package-defined type. Other update types may define their own data contracts.

### `key`

`key` identifies one current item within an update type. The pair `(type, key)` is unique within a run.

Rules:

- 1 to 128 characters
- ASCII letters, numbers, dots, underscores, colons, slashes, and hyphens
- starts with a letter or number
- matches `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`

Keys are case-sensitive. A publisher must reuse the same key for the same item throughout a run.

### `data`

`data` contains the full current state for the key. It is a non-null JSON object. A new update replaces the current projection for the same `(type, key)` pair. It does not merge with the previous object.

The generic update layer allows fields it does not understand inside `data`. A package-defined update type may reject unknown fields.

The encoded object must not exceed 64 KiB. Large logs and binary data do not belong in updates. Nodes should return large final values through normal outputs, where the run-bundle artifact rules apply.

### Runtime-owned fields

The runtime adds `updateId`, `seq`, `at`, `runId`, `nodeId`, and `attemptId`. Publishers cannot set or override them.

`seq` is the sequence of the matching trace event. `at` is the runtime receipt time in RFC 3339 UTC form. `updateId` is unique within the run.

## Agent tool action

The `workflow` tool adds this input variant:

```ts
{
  action: "update";
  step: string;
  attempt: string;
  update: WorkflowUpdateInput;
}
```

The engine accepts it only when:

- an agent step is active
- `step` matches the active node id
- `attempt` matches the active attempt id
- the attempt has not timed out, failed, completed, or been cancelled
- the caller still owns the run claim
- the update passes envelope and type-specific validation

A successful call returns `WorkflowUpdateReceipt`. It leaves the agent step open. Invalid calls return a tool error and do not write a trace event.

The Pi tool call id is the idempotency key for an agent update. Re-delivery of the same tool call returns the first receipt instead of appending a duplicate update.

The existing `status` action remains read-only. It reports what the engine knows and includes the current update projection. It does not publish an update or inspect an external target.

## Function actions

Function actions call `await context.publishUpdate(update)`. The promise resolves only after the trace event and state projection are durable.

An uncaught validation, fencing, storage, or rate error fails the action. An action may catch a rejected publication when losing a display update should not fail its main work. Cancellation and claim loss still apply.

Retries run under a new attempt id. Their updates form a new attempt history even when they reuse the same `(type, key)` pair.

## Shell actions

Shell actions may define a line parser:

```ts
shell({
  exec: () => ({ command: "worker", args: ["--progress=ndjson"] }),
  updates: {
    streams: ["stdout"],
    parseLine: ({ stream, text }, context) => {
      const value = JSON.parse(text);
      if (value.kind !== "progress") return undefined;
      return {
        type: "progress",
        key: value.worker,
        data: value.data,
      };
    },
  },
});
```

`streams` may contain `stdout`, `stderr`, or both. It defaults to `stdout`. `parseLine` receives complete UTF-8 lines and may return one update, an array of updates, or `undefined`.

The runtime keeps normal stdout and stderr capture. It applies backpressure while parsing and publishing updates. A line longer than 64 KiB, invalid UTF-8, a parser error, or a publication error terminates the command and fails the node. A final line without a newline is parsed when the stream closes.

The parser is workflow-author code. Update data never selects or changes the command, arguments, working directory, environment, or privileges.

## Controllers and hosts

The engine exposes the same publication operation through its runner interface. A controller or standalone host may publish only for a workflow run and attempt whose claim it owns.

Controller resource events remain controller events. They become workflow updates only when a controller deliberately publishes them to a linked workflow run.

## Persistence

Each accepted update appends one `update_published` event to `trace.ndjson`:

```json
{
  "seq": 18,
  "at": "2026-08-16T10:15:30.000Z",
  "scope": "node",
  "type": "update_published",
  "runId": "20260816T100000Z-import-2f81a9c3",
  "nodeId": "process",
  "attemptId": "017f5d57-83f1-4d2d-88e6-3dbf878fed17",
  "payload": {
    "updateId": "upd_01K2GZVY3A4D7X8J9M0N",
    "type": "progress",
    "key": "worker-a",
    "data": {
      "schema": "pi-workflows.progress.v1",
      "status": "running",
      "completed": 420,
      "total": 1000,
      "unit": "rows"
    }
  }
}
```

`state.json` adds an optional `updates` array containing only the latest record for each `(type, key)` pair. The array is sorted by `seq`. Omission means that the run has never published an update. New runs write an empty array from their first state projection. The trace remains the full history and source of truth.

A resumed run keeps its latest projection and appends new update events. A checkpoint continuation starts a new run with an empty update projection. Updates are scoped to one run and are not carried into continuation bundles.

The state projection supports at most 1,024 current `(type, key)` pairs. A publication that would exceed the limit is rejected. Trace history remains append-only.

The update envelope is an additive part of `pi-workflows.trace-event.v1` and `pi-workflows.run-state.v1`. Existing bundles without `updates` remain valid under the omission rule. The implementation uses one current schema and does not add migration files, fallback formats, or dual writes. New bundles that contain updates are not required to work with older package releases.

## Ordering and limits

Updates use the run store's existing serialized write chain and claim fence. Their trace sequence defines their total order.

Default safety limits per run are:

| Limit                       |                 Value |
| --------------------------- | --------------------: |
| Encoded `data` size         |                64 KiB |
| Current `(type, key)` pairs |                 1,024 |
| Sustained publication rate  | 20 updates per second |
| Publication burst           |           100 updates |

The rate limiter uses a token bucket. A rejected update is not queued silently. Agent callers receive a tool error; code publishers receive a rejected promise.

The standalone host and Pi extension apply the same limits.

## Progress update type

`progress` is the standard optional profile for measurable work. Each key represents one process, worker, phase owner, or explicit overall total.

Minimal progress data:

```json
{
  "schema": "pi-workflows.progress.v1",
  "status": "running"
}
```

Measured progress:

```json
{
  "schema": "pi-workflows.progress.v1",
  "label": "Worker A",
  "status": "running",
  "phase": "processing",
  "completed": 420,
  "total": 1000,
  "unit": "rows",
  "sourceUpdatedAt": "2026-08-16T10:15:27.000Z",
  "sourceEstimatedFinishAt": "2026-08-16T10:34:00.000Z"
}
```

Fields:

| Field                     | Required    | Type   | Meaning                                          |
| ------------------------- | ----------- | ------ | ------------------------------------------------ |
| `schema`                  | Yes         | string | Must equal `pi-workflows.progress.v1`.           |
| `status`                  | Yes         | string | Current state of the track.                      |
| `label`                   | No          | string | User-facing name, at most 200 characters.        |
| `phase`                   | No          | string | Stable phase name, at most 128 characters.       |
| `completed`               | No          | number | Work completed in `unit`.                        |
| `total`                   | No          | number | Known total work in `unit`.                      |
| `unit`                    | Conditional | string | Required when `completed` or `total` is present. |
| `sourceUpdatedAt`         | No          | string | Time when the target produced the facts.         |
| `sourceEstimatedFinishAt` | No          | string | Finish estimate supplied by the target.          |

`status` is one of `pending`, `running`, `waiting`, `blocked`, `completed`, `failed`, `cancelled`, or `unknown`.

`completed` must be finite and at least zero. `total` must be finite, greater than zero, and at least `completed`. `unit` is 1 to 32 printable characters after trimming. Time fields use RFC 3339 with an offset.

A progress object is a full snapshot for its key. Omitted optional fields clear their previous values. Publishers mark finished tracks with a terminal status instead of deleting them.

The reserved key `overall` represents an explicit aggregate supplied by the workflow. Pi Workflows never combines unrelated tracks automatically. Without `overall`, displays list independent tracks.

Unknown fields in `pi-workflows.progress.v1` are validation errors.

## Progress estimation

The workflows layer exports pure validation and estimation helpers. Reduction and formatting use the same module. The helpers import no Pi, extension, controller, or viewer code.

The estimator groups records by run and key. A new estimation epoch starts when:

- `phase` changes
- `unit` changes
- `total` changes
- `completed` decreases
- a terminal track returns to a non-terminal state

It derives elapsed time from runtime update timestamps. `sourceUpdatedAt` reports staleness. Trace sequence orders records.

A measured ETA requires a known total and at least two usable samples in the current epoch. The estimator calculates consecutive wall-clock rates over the latest eight usable intervals. Zero-progress intervals remain in the window. Intervals with non-positive elapsed time are ignored.

The median interval rate is the central estimate. The 25th and 75th percentile rates form the ETA range. The faster rate gives the lower remaining-time bound and the slower rate gives the upper bound. One usable interval has low confidence. With two through four intervals, a ratio of interquartile range to median no greater than 0.5 gives medium confidence; a wider spread gives low confidence. With five or more intervals, a ratio no greater than 0.25 gives high confidence, a ratio through 0.5 gives medium confidence, and a wider spread gives low confidence. A non-positive median makes ETA unavailable. A non-positive lower rate removes the upper time bound, so the formatter shows the central ETA with low confidence instead of a closed range.

A fresh `sourceEstimatedFinishAt` takes priority over a measured ETA and is labelled as a source estimate. It is fresh when it comes from the latest track update, is later than the matching `sourceUpdatedAt` or runtime receipt time, and has not passed. When `sourceUpdatedAt` is absent, the runtime receipt time is the source time. A passed source estimate is expired and does not override a measured estimate. Pi Workflows does not ask a model to invent an ETA. When the target supplies no usable estimate and the samples cannot support one, the formatter says `ETA unavailable` and states the reason.

For `waiting` or `blocked` tracks, measured ETA is paused and the display reports the current state. A source estimate may still be shown when the target reports one. For terminal tracks, remaining work and ETA are omitted.

The estimator never advances `completed` between samples. Live displays may update elapsed time, sample age, the next scheduled check, and the remaining duration to an estimated finish time.

## Presentation

The compact Pi widget and `piw` recognize `progress` updates. Other update types remain visible in trace and step inspection without receiving a special renderer.

The compact widget:

- behaves as it does today when no progress update exists
- shows the `overall` track first when present
- prioritizes failed, blocked, and waiting tracks
- uses remaining lines for active tracks
- stays within Pi's 10-line widget limit
- supports the existing manual scroll controls
- updates clocks from the existing widget ticker without model calls or state writes

A typical line is:

```text
Worker A  420/1,000 rows  ETA 18–20m
```

A footer line may show:

```text
Last update 7m ago  next check 23m
```

`piw` shows every track, estimate basis, sample count, confidence, update history, and source timestamps.

## Notifications and model context

Publishing an update does not notify the user. A workflow uses the existing `notify` node when it wants a durable report.

The extension delivers workflow notifications with a custom Pi message and explicit `triggerTurn: false`. The message remains in session history and later model context, but its arrival does not start an assistant response. Workflow reports do not use `sendUserMessage`.

Agent-step instructions use a separate message contract because they must start a model turn. See [WORKFLOW_STEP_MESSAGES.md](WORKFLOW_STEP_MESSAGES.md).

## Validation and errors

The implementation must test and reject:

- invalid type or key names
- non-object or non-JSON data
- oversized data
- too many current keys
- rate-limit violations
- updates for inactive or mismatched attempts
- updates after timeout or cancellation
- writes without the current claim
- malformed shell update lines
- invalid progress fields
- duplicate agent tool delivery

Validation errors must identify the field and rule. They must not include unrelated update data, private run contents, or command environment values.

## Security and boundaries

Updates are data. They do not grant permission to execute a command, retry work, change a target, publish an artifact, or increase spending.

Run bundles are private and may contain update data from external systems. Existing bundle permissions and export warnings apply.

This feature does not add remote transports, a metrics database, global aggregation, automatic polling, or a new Pi core API. Workflow authors remain responsible for the trust and cost of their agent, action, shell, and controller code.
