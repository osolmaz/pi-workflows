# Run bundle format

Every workflow run persists to its own directory, called a run bundle. The
bundle is the contract between the engine and anything that observes runs: the
bundled terminal viewer, the Rust TUI, and any external tool. A bundle is
**self-contained for replay**: a reader never needs access to Pi's global
session store or any other file outside the bundle directory.

This document is the authoritative specification. There is exactly one format
version; older layouts are not read and no compatibility paths exist.

## Location and layout

Bundles live under `~/.pi/agent/workflows/runs/` by default. The
`PI_WORKFLOWS_RUNS_DIR` environment variable overrides the location for both
the engine and all viewers, which is how the test suite keeps runs inside
temporary directories.

```
~/.pi/agent/workflows/runs/
  20260729T023912Z-autoimplement-3f2a9c1b/
    manifest.json     # pi-workflows.run-bundle.v1
    workflow.json     # pi-workflows.definition-snapshot.v1
    state.json        # pi-workflows.run-state.v1, derived projection
    trace.ndjson      # pi-workflows.trace-event.v1, append-only source of truth
    session/          # present when the run executed inside a Pi conversation
      binding.json    # pi-workflows.session-binding.v1
      entries.ndjson  # pi-workflows.session-entry.v1, append-only
    artifacts/        # present when any persisted value was externalized
      sha256-<64 hex>.txt
```

Run ids are `<UTC timestamp>-<workflow slug>-<8 hex chars>`, so lexical order
is chronological order.

Bundle directories are created with mode `0700` and files with mode `0600`.
Bundles can contain prompts, model output, shell commands, environment
details, and absolute paths; treat them as private data and review before
exporting.

## Source of truth and write discipline

`trace.ndjson` is the source of truth. Every other file is either immutable
after run start (`workflow.json`, `session/binding.json`, artifacts) or a
derived projection (`state.json`, `manifest.json`).

Write order for every transition:

1. Append the trace event (one JSON object per line, appends serialized per
   file, `seq` starting at 1 and increasing by exactly 1).
2. Atomically replace `state.json`, carrying `traceSeq` = the `seq` of the
   trace event it reflects (write to a temp file in the same directory, then
   rename).
3. Atomically replace `manifest.json`.

Consequences for readers:

- A reader never sees a partial JSON document; a torn final trace line must be
  ignored.
- `state.json` with `traceSeq` older than the last trace line is a stale
  projection: either re-read after the writer catches up or fold the trace
  tail on top of it.
- After a run reaches a terminal status (`completed`, `failed`, `timed_out`,
  `cancelled`, or `waiting`), the bundle no longer changes, and
  `state.traceSeq` equals the final trace `seq`.
- A bundle whose state is `running` but whose files have stopped growing may
  be an interrupted run (crash, reboot); viewers should label it as possibly
  interrupted rather than live.

## Externalized values and artifacts

Large payloads are stored once, content-addressed, under `artifacts/` and
referenced from the documents that use them. This applies uniformly to every
**persisted value position**: `input`, `outputs.*`, `results.*.output`,
`steps[*].prompt`, `steps[*].output`, `finalOutput`, and trace event payload
values.

Encoding rule, applied recursively to a persisted value:

- A string leaf whose UTF-8 encoding is larger than 4096 bytes is written to
  `artifacts/sha256-<digest>.txt` (UTF-8, digest over the exact bytes) and
  replaced by an artifact reference:

```json
{
  "$artifact": {
    "path": "artifacts/sha256-2b1f….txt",
    "mediaType": "text/plain",
    "bytes": 18342,
    "sha256": "2b1f…"
  }
}
```

- Any user object that has an own key `$artifact` or `$escaped` is wrapped as
  `{ "$escaped": <object> }` so the sentinel stays unambiguous. Decoders
  unwrap `$escaped` one level and resolve `$artifact` refs.
- Everything else is stored inline. Small values are never externalized.

Artifact rules:

- `path` is bundle-relative; a reference never points outside the bundle.
- Artifacts are immutable once written and deduplicate by content hash.
- Readers must tolerate unknown `mediaType` values.

Because the same output can legitimately appear in `outputs`, `results`,
`steps`, and the trace, externalization makes that duplication cheap: each
copy is the same small reference.

## manifest.json

Identity and pointers, kept in sync with the state on every snapshot:

```json
{
  "schema": "pi-workflows.run-bundle.v1",
  "runId": "20260729T023912Z-autoimplement-3f2a9c1b",
  "workflowName": "autoimplement",
  "runTitle": "autoimplement: fix the flaky test",
  "workflowPath": "/repo/.pi/workflows/autoimplement.workflow.ts",
  "startedAt": "2026-07-29T02:39:12.412Z",
  "finishedAt": "2026-07-29T02:41:03.977Z",
  "status": "completed",
  "traceSchema": "pi-workflows.trace-event.v1",
  "paths": {
    "workflow": "workflow.json",
    "state": "state.json",
    "trace": "trace.ndjson",
    "session": "session",
    "artifacts": "artifacts"
  }
}
```

`paths.session` and `paths.artifacts` are present only when those directories
exist. Readers must start from `manifest.json`, check `schema`, skip bundles
they do not understand, resolve files through `paths`, and reject any path
that escapes the bundle directory.

## workflow.json

A serializable snapshot of the graph taken at run start
(`pi-workflows.definition-snapshot.v1`). Functions such as prompts and
validators are not serialized. Each node keeps only its metadata (`nodeType`,
`timeoutMs`, `statusDetail`, `expectedOutput`, `summary`, `actionExecution`),
and edges are copied verbatim. The snapshot is what lets viewers draw all
nodes, including ones that have not run yet. It is immutable after run start.

## state.json

The full run projection (`WorkflowRunState` in
[`src/workflows/types.ts`](../src/workflows/types.ts)), schema
`pi-workflows.run-state.v1`:

```json
{
  "schema": "pi-workflows.run-state.v1",
  "traceSeq": 17,
  "runId": "20260729T023912Z-autoimplement-3f2a9c1b",
  "workflowName": "autoimplement",
  "startedAt": "…",
  "updatedAt": "…",
  "status": "running",
  "input": { "task": "fix the flaky test" },
  "outputs": {},
  "results": {},
  "steps": []
}
```

- `status` is one of `running`, `waiting`, `completed`, `failed`, `timed_out`,
  or `cancelled`.
- While a node is executing, `currentNode`, `currentAttemptId`,
  `currentNodeType`, `currentNodeStartedAt`, and `statusDetail` describe it;
  they disappear when the node finishes.
- While a pause request holds the run at a step boundary, `paused` is `true`
  (with matching `run_paused`/`run_resumed` trace events); it disappears when
  the run resumes or ends.
- Per-node data lives in `outputs` (the accepted output of each finished node,
  latest attempt wins on loops) and `results` (the full result record of the
  latest attempt, including outcome and timing).
- `steps` is the ordered history, one record per node attempt:

```json
{
  "attemptId": "d81f…",
  "nodeId": "implement",
  "nodeType": "agent",
  "outcome": "ok",
  "startedAt": "…",
  "finishedAt": "…",
  "prompt": {
    "$artifact": {
      "path": "artifacts/sha256-….txt",
      "mediaType": "text/plain",
      "bytes": 9120,
      "sha256": "…"
    }
  },
  "output": { "summary": "…" },
  "conversation": { "firstEntryId": "a1b2c3d4", "lastEntryId": "c3d4e5f6" }
}
```

- `prompt` is the full prompt text for agent steps (`null` for other node
  types), subject to value externalization.
- `conversation` is present on agent steps recorded inside a Pi conversation:
  the inclusive range of Pi session entry ids in `session/entries.ndjson`
  produced by this attempt, from prompt delivery through accepted submission.
  Viewers must use this explicit linkage and never infer it heuristically.
- Action steps carry an `action` receipt with `actionType`
  (`shell`/`function`) and, for shell actions, `command`, `args`, `cwd`,
  `exitCode`, `signal`, and `durationMs`. Shell stdout/stderr live in the
  step output (the parsed or raw shell result) and are externalized when
  large.
- When a run pauses at a checkpoint, `waitingOn` names the checkpoint node.
  Terminal runs carry `finalOutput` on success and `error` on failure.

## trace.ndjson

One event per line, monotonically sequenced per run, schema
`pi-workflows.trace-event.v1`:

```json
{
  "seq": 3,
  "at": "2026-07-29T02:39:14.101Z",
  "scope": "agent",
  "type": "agent_prompt_sent",
  "runId": "20260729T023912Z-autoimplement-3f2a9c1b",
  "nodeId": "implement",
  "attemptId": "d81f…",
  "payload": { "prompt": "…" }
}
```

`scope` is one of `run`, `node`, `agent`, `action`, or `session`. `nodeId` and
`attemptId` are present on node-scoped and agent-scoped events. Consumers must
ignore unknown event types and unknown payload fields so new ones can be added
within the same schema version.

The trace alone is sufficient to reconstruct the run: outputs and receipts are
part of the terminal node events, not only of `state.json`.

Event catalog and payload contracts:

| type                | scope   | payload                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `run_started`       | run     | `workflowName`, `runTitle?`, `input`                                |
| `session_bound`     | session | `piSessionId`                                                       |
| `node_started`      | node    | `nodeType`, `statusDetail?`                                         |
| `agent_prompt_sent` | agent   | `prompt`                                                            |
| `node_finished`     | node    | `outcome: "ok"`, `durationMs`, `output`, `conversation?`, `action?` |
| `node_failed`       | node    | `outcome`, `durationMs`, `error`, `conversation?`, `action?`        |
| `run_paused`        | run     | _(empty)_                                                           |
| `run_resumed`       | run     | _(empty)_                                                           |
| `run_completed`     | run     | `status`, `finalOutput`                                             |
| `run_waiting`       | run     | `status`, `waitingOn`, `finalOutput`                                |
| `run_failed`        | run     | `status`, `error`                                                   |
| `run_timed_out`     | run     | `status`, `error`                                                   |
| `run_cancelled`     | run     | `status`, `error?`                                                  |

Invariants:

- every node attempt has exactly one `node_started` and exactly one terminal
  `node_finished`/`node_failed` with the same `attemptId`;
- `attemptId` values are unique within a run;
- a terminal `run_*` event is the last event of the run;
- events are never rewritten or deleted.

## session/

Present when the run executed inside a Pi conversation. The extension records
the conversation into the bundle so replay never depends on Pi's global
session store.

### binding.json

Written once when the run binds to the conversation
(`pi-workflows.session-binding.v1`):

```json
{
  "schema": "pi-workflows.session-binding.v1",
  "runId": "20260729T023912Z-autoimplement-3f2a9c1b",
  "piSessionId": "019fad89-…",
  "piSessionFile": "/home/user/.pi/agent/sessions/--repo--/2026-07-29….jsonl",
  "cwd": "/repo",
  "boundAt": "2026-07-29T02:39:12.412Z"
}
```

`piSessionFile` is provenance only and absent for in-memory sessions; replay
readers must not read it.

### entries.ndjson

Append-only copies of the Pi session entries produced on the current branch
while the run was active, schema `pi-workflows.session-entry.v1`:

```json
{
  "seq": 1,
  "at": "2026-07-29T02:39:12.902Z",
  "entry": {
    "type": "message",
    "id": "a1b2c3d4",
    "parentId": "9f8e7d6c",
    "timestamp": "…",
    "message": { "role": "user", "content": "…" }
  }
}
```

- `seq` is strictly increasing within the file, starting at 1.
- `entry` is the verbatim Pi session entry (Pi's own versioned format),
  including user messages, assistant messages, tool results, model changes,
  and compaction entries. Nothing is normalized or rewritten.
- Entries include everything that happened in the conversation during the run:
  workflow prompts, nudges, and user interruptions are all part of the record.
- `conversation` ranges in step records and `node_finished` events address
  entries by Pi entry id (`entry.id`).

## Versioning

Each file carries a versioned schema identifier, and the identifier changes
only on breaking shape changes. Readers check `manifest.json`'s `schema` field
and skip bundles they do not understand. Within a version, additions of new
fields and new trace event types are allowed; readers must ignore what they do
not know.
