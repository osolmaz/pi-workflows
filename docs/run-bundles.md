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
      events.ndjson   # pi-workflows.session-event.v1, append-only
      capture.json    # pi-workflows.session-capture.v1, atomic projection
    artifacts/        # present when any persisted value was externalized
      sha256-<64 hex>.txt
```

Human decision records use a separate additive directory next to `runs/` so a waiting run bundle remains immutable:

```text
~/.pi/agent/workflows/decisions/
  <decision-id>/
    request.json
    deliveries/<channel>/<attempt-id>.json
    answers/<attempt-id>.json
    resolution.json # atomic resolved-or-cancelled fence
    accepted.json    # human or timeout response with explicit provenance
    cancelled.json   # terminal cancellation tombstone
    settlements/<channel>/<attempt-id>.json
    continuation.json
```

The request links to the waiting run, node, attempt, workflow source, and canonical request digest. A v2 request stores the canonical subject and a separate normalized operator presentation. Its subject, presentation, revision, choices, input prompts, optional deadline, and optional automatic response are bound to the request digest. Accepted records and redacted continuation receipts preserve the subject and presentation digests and state `human` or `timeout` provenance. A timeout record has no human source. Final records use no-replace creation and adopt only identical retries. `resolution.json` is the first resolved-or-cancelled fence. It materializes either `accepted.json` or `cancelled.json`; a crash can rebuild that detail from the resolution. A cancellation tombstone prevents later automatic continuation. `continuation.json` binds one resolved response and its provenance to one deterministic continuation run. Delivery and settlement records cannot change the result.

Telegram multipart delivery uses additive v2 delivery records for the overall intent, each part, and completion. Part records contain only recipient indexes, part indexes, counts, and content digests. Telegram chat and message IDs remain in the private disposable channel projection and never enter run or decision bundles. An ambiguous part remains unknown and is not retried blindly.

A human-decision continuation preserves the parent's original workflow input and replaces the carried checkpoint output with the resolved typed response for routing. Its `humanDecision` state is a redacted receipt with `human` or `timeout` provenance. A v2 receipt includes the subject digest, presentation digest, and revision, but not the subject itself. Verified human actor, channel, event, and idempotency details remain in the private sibling decision records and are not copied into the run bundle. Ordinary checkpoint continuations keep using the answer as the continuation input. This alpha contract changes current v1 and v2 field sets in place; old active definitions refuse resume instead of using a compatibility path.

Run ids are `<UTC timestamp>-<workflow slug>-<8 hex chars>`, so lexical order
is chronological order.

Bundle directories are created with mode `0700` and files with mode `0600`.
Bundles can contain prompts, model output, shell commands, environment
details, and absolute paths; treat them as private data and review before
exporting.

## Source of truth and write discipline

`trace.ndjson` is the source of truth for workflow execution. Final Pi
conversation entries and temporal session history have separate authority in
`session/entries.ndjson` and `session/events.ndjson`. `session/capture.json`
reports whether temporal capture is complete. These sequence spaces are
independent and must not be compared.

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
- Before the engine writes a terminal workflow event, session recording stops,
  drains accepted entries and events, and atomically writes `capture.json`.
- After a run reaches a terminal status (`completed`, `failed`, `timed_out`,
  `cancelled`, or `waiting`), the bundle no longer changes, and
  `state.traceSeq` equals the final trace `seq`.
- A bundle whose state is `running` but whose files have stopped growing may
  be an interrupted run (crash, reboot); viewers should label it as possibly
  interrupted rather than live.

## Externalized values and artifacts

Large payloads are stored once, content-addressed, under `artifacts/` and
referenced from the documents that use them. This applies uniformly to every
**persisted value position**. These positions include `input`, `outputs.*`,
`results.*.output`, `steps[*].prompt`, `steps[*].output`, and `finalOutput`.
Trace event payload values follow the same rule.

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

The same output can legitimately appear in several places. Externalization
keeps each copy in `outputs`, `results`, `steps`, or the trace as the same small
reference.

## manifest.json

Identity and pointers, kept in sync with the state on every snapshot:

```json
{
  "schema": "pi-workflows.run-bundle.v1",
  "runId": "20260729T023912Z-autoimplement-3f2a9c1b",
  "workflowName": "autoimplement",
  "runTitle": "autoimplement: fix the flaky test",
  "workflowSource": {
    "kind": "file",
    "path": "/repo/.pi/workflows/autoimplement.workflow.ts",
    "hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
  },
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

`workflowSource` identifies the root definition used by the run. User workflow
files use an absolute path and SHA-256 hash. Package-provided workflows use a
stable identity such as `{ "kind": "builtin", "id": "monitor", "revision": "4" }`.
A built-in identity does not contain an installation path.

A composed run also records `workflowSources`, sorted by mount path, and `definitionDigest`. Each mounted source has `mountPath`, `workflowName`, and the same file or built-in source identity. The digest is SHA-256 over the resolved definition snapshot.

`paths.artifacts` is declared from bundle creation so a live session-event
patch can safely reference a newly written artifact before the next workflow
state projection. The directory itself is created only when needed.
`paths.session` appears when the run binds to Pi. Readers must start from
`manifest.json`, check `schema`, skip bundles they do not understand, resolve
files through `paths`, and reject any path that escapes the bundle directory.

## workflow.json

A serializable snapshot of the graph taken at run start
(`pi-workflows.definition-snapshot.v1`). Functions such as prompts and
validators are not serialized. Each node keeps only its metadata (`nodeType`,
`timeoutMs`, `statusDetail`, `expectedOutput`, `summary`, `actionExecution`),
and edges are copied verbatim. A fixed `timeoutMs: null` is preserved and means
that the node has no wall-clock deadline. Timeout callbacks remain omitted.
A human-decision snapshot records fixed `onTimeout` duration and response values. A dynamic timeout callback is omitted and marked as dynamic. Included nodes also record `mountPath`, `localNodeId`, and internal entry or exit status. The top-level `composition.mounts` list records every mount, entry, named exit, and child step limit. The snapshot is what lets viewers draw all nodes, including ones that have not run yet. It is immutable after run start.

## Resume and repair

An interrupted run (status `running` with no terminal trace event) can resume
instead of failing. Resume is a named operation with strict rules:

1. The caller must hold the run's queue claim. Only the current claim holder
   may resume or interrupt a bundle, and every bundle write verifies the
   claim token first (write fencing).
2. A torn trace tail (a crash mid-append) is truncated to the last complete
   line. Trace events the state projection never recorded are dropped, so
   `state.traceSeq` and the trace agree again before any new event.
3. Completed nodes replay from the projection. The in-flight node reruns with
   a fresh attempt; a `run_resumed` trace event marks the boundary.
4. `state.workflowSource` pins the root workflow source from run start. File
   sources require the same hash. Built-in sources require the same catalog
   id and revision.
5. Composed runs also require the same sorted `workflowSources` and
   `definitionDigest`. A changed or missing child refuses normal resume.
6. A forced resume records the identity mismatch in the `run_resumed` payload.

Continuation runs (answering a checkpoint) are new bundles, not resumed ones.
They link back through `state.parentRunId`, carry the parent's outputs,
results, and step records forward, and note `continuedFrom` in their
`run_started` payload. Bundles stay append-only; a continuation is the only
way work follows a terminal `waiting` state.

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
  "workflowSource": {
    "kind": "file",
    "path": "/repo/.pi/workflows/autoimplement.workflow.ts",
    "hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
  },
  "workflowSources": [
    {
      "mountPath": ["redesign"],
      "workflowName": "autoplan",
      "source": { "kind": "builtin", "id": "autoplan", "revision": "1" }
    }
  ],
  "definitionDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "startedAt": "…",
  "updatedAt": "…",
  "status": "running",
  "input": { "task": "fix the flaky test" },
  "outputs": {},
  "results": {},
  "steps": [],
  "updates": []
}
```

- `workflowSource` is the canonical root source identity. Resuming a file requires
  the same hash. Resuming a built-in requires the same catalog revision.
- `workflowSources` and `definitionDigest` attest the complete composed graph.
  A mismatch refuses resume instead of loading another child definition.
- `status` is one of `running`, `waiting`, `completed`, `failed`, `timed_out`,
  or `cancelled`. A controller host records an abandoned bundle as `failed`
  with a final `run_interrupted` trace event. Before doing that, recovery checks
  the trace tail and repairs a stale projection when the terminal event was
  already appended. The controller store can then retry a genuinely abandoned
  child attempt without changing this schema. If startup stopped before a
  manifest existed, the scheduler preserves that incomplete directory as a
  hidden sibling before creating the reserved run.
- While a node is executing, `currentNode` and `currentAttemptId` identify it.
  `currentNodeStartedAt` and `statusDetail` add timing and display context.
  These fields disappear when the node finishes. The executing node's type comes from the definition
  snapshot, not from the state.
- While a pause request holds the run at a step boundary, `paused` is `true`
  (with matching `run_paused`/`run_resumed` trace events); it disappears when
  the run resumes or ends.
- Per-node data lives in `outputs` (the accepted output of each finished node,
  latest attempt wins on loops) and `results` (the full result record of the
  latest attempt, including outcome and timing).
- `updates` contains the latest durable record for each `(type, key)` pair,
  sorted by trace sequence. New runs start with an empty array. Older bundles
  can omit it. Resume keeps it; checkpoint continuation starts a new empty
  projection. The trace keeps the complete update history.
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
  (`shell`/`function`). Shell actions also record `command`, `args`, `cwd`,
  `exitCode`, `signal`, and `durationMs`. Shell stdout/stderr live in the step
  output (the parsed or raw shell result) and are externalized when large.
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

`scope` is one of `run`, `node`, `agent`, `action`, or `session`.
A node-scoped `update_published` event carries the runtime update ID, type, key, and data;
its event sequence and timestamp are the update sequence and timestamp. See
[WORKFLOW_UPDATES.md](WORKFLOW_UPDATES.md) for the full contract. `nodeId` and
`attemptId` are present on node-scoped and agent-scoped events. Consumers must
ignore unknown event types and unknown payload fields so new ones can be added
within the same schema version.

The trace alone is sufficient to reconstruct the run because terminal node
events carry outputs and receipts.

Event catalog and payload contracts:

| type                | scope   | payload                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `run_started`       | run     | `workflowName`, `runTitle?`, `input`                                |
| `session_bound`     | session | `piSessionId`                                                       |
| `node_started`      | node    | `nodeType`, `statusDetail?`                                         |
| `agent_prompt_sent` | agent   | `prompt`                                                            |
| `node_finished`     | node    | `outcome: "ok"`, `durationMs`, `output`, `conversation?`, `action?` |
| `node_failed`       | node    | `outcome`, `durationMs`, `error`, `conversation?`, `action?`        |
| `include_entered`   | run     | `mountPath`, `workflowName`, `invocation`                           |
| `include_exited`    | run     | `mountPath`, `workflowName`, `invocation`, `exit`, `output`         |
| `run_paused`        | run     | _(empty)_                                                           |
| `run_resumed`       | run     | _(empty)_                                                           |
| `run_completed`     | run     | `status`, `finalOutput`                                             |
| `run_waiting`       | run     | `status`, `waitingOn`, `finalOutput`                                |
| `run_failed`        | run     | `status`, `error`                                                   |
| `run_timed_out`     | run     | `status`, `error`                                                   |
| `run_cancelled`     | run     | `status`, `error?`                                                  |
| `run_interrupted`   | run     | `error`                                                             |

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

A run that outlives its first session (parked, then resumed by another
session or the host) gains a second capture under
`session/segments/<attemptId>/` with the same file layout (`binding.json`,
`entries.ndjson`, `events.ndjson`, `capture.json`). The first capture stays
flat at `session/`; only captures from the second bind onward become
segments, so readers that predate segments keep working on single-session
bundles. An interrupted run finalizes any segment still `recording` as
`failed` with the interruption reason.

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
- Entries include everything that happened in the conversation during the run.
  This includes workflow prompts and nudges together with user interruptions.
- `conversation` ranges in step records and `node_finished` events address
  entries by Pi entry id (`entry.id`).

### events.ndjson

The temporal journal records documented Pi `turn_*` and `message_*` hooks plus
`tool_execution_*` hooks with schema `pi-workflows.session-event.v1`. Each
record has a per-file `seq`, timestamp, `nodeId`, and `attemptId`. Optional
turn, message, and tool call IDs link related records. A normalized `type` and
`payload` carry the event data.
The full contract and event catalog are in
[session-event-journal.md](session-event-journal.md).

Events preserve semantic deltas. Assistant `partial` snapshots are never
stored, and neither are terminal `message` or `error` snapshots. Tool update records omit Pi's
cumulative `partialResult`. Final `message_finished` records link to settled
Pi entries with `entryId`; after that linkage, `entries.ndjson` is the
verbatim content authority.

Readers process events by `seq`. Timestamps schedule playback but never reorder
records. A torn final line is buffered while capture is `recording`; malformed
complete lines, sequence gaps, and terminal torn tails are integrity failures.

### capture.json

`capture.json` is an atomically replaced integrity projection:

```json
{
  "schema": "pi-workflows.session-capture.v1",
  "eventSchema": "pi-workflows.session-event.v1",
  "status": "complete",
  "eventCount": 241,
  "entryCount": 7,
  "lastEventSeq": 241
}
```

`status` starts as `recording` and ends as `complete` or `failed`. Failed
capture adds `failure` with `failedAt` plus a code and message. Capture failure
is visible to readers but does not fail the workflow. Terminal readers verify
the counts and last sequence, then check schemas and contiguous event order. Missing temporal files
in a session-bound bundle are invalid, not an older supported layout.

## Versioning

Each file carries a versioned schema identifier, and the identifier changes
only on breaking shape changes. Readers check `manifest.json`'s `schema` field
and skip bundles they do not understand. Within a version, additions of new
fields and new trace event types are allowed; readers must ignore what they do
not know.
