# Run bundle format

Every workflow run persists to its own directory, called a run bundle. The
bundle is the contract between the engine and anything that observes runs,
including the bundled terminal viewer. This document specifies the format so
other tools can consume it.

## Location and layout

Bundles live under `~/.pi/agent/workflows/runs/` by default. The
`PI_WORKFLOWS_RUNS_DIR` environment variable overrides the location for both
the engine and the viewer, which is how the test suite keeps runs inside
temporary directories.

```
~/.pi/agent/workflows/runs/
  20260719T023912Z-autoimplement-3f2a9c1b/
    manifest.json     # pi-workflows.run-bundle.v1
    workflow.json     # pi-workflows.definition-snapshot.v1
    state.json        # full run projection
    trace.ndjson      # pi-workflows.trace-event.v1, append-only
```

Run ids are `<UTC timestamp>-<workflow slug>-<8 hex chars>`, so lexical order
is chronological order.

## Write discipline

Every JSON file in the bundle is written atomically (write to a temp file in
the same directory, then rename), so a reader never sees a partial document. `trace.ndjson` is append-only, one JSON object
per line, with writes serialized per file. After a run reaches a terminal
status (`completed`, `failed`, `timed_out`, `cancelled`, or `waiting`), the
bundle no longer changes.

A live viewer needs only two behaviors. Treat `state.json` as the current
projection and re-read it on any file change, and treat `trace.ndjson` as the
event timeline when history matters.

## manifest.json

Identity and pointers, kept in sync with the state on every snapshot:

```json
{
  "schema": "pi-workflows.run-bundle.v1",
  "runId": "20260719T023912Z-autoimplement-3f2a9c1b",
  "workflowName": "autoimplement",
  "runTitle": "autoimplement: fix the flaky test",
  "workflowPath": "/repo/.pi/workflows/autoimplement.workflow.ts",
  "startedAt": "2026-07-19T02:39:12.412Z",
  "finishedAt": "2026-07-19T02:41:03.977Z",
  "status": "completed",
  "traceSchema": "pi-workflows.trace-event.v1",
  "paths": { "workflow": "workflow.json", "state": "state.json", "trace": "trace.ndjson" }
}
```

## workflow.json

A serializable snapshot of the graph taken at run start. Functions such as
prompts and validators are not serialized. Each node keeps only its metadata
(`nodeType`, `timeoutMs`, `statusDetail`, `expectedOutput`, `summary`,
`actionExecution`), and edges are copied verbatim. The snapshot is what lets
the viewer draw all nodes, including ones that have not run yet.

## state.json

The full run projection (`WorkflowRunState` in
[`src/workflows/types.ts`](../src/workflows/types.ts)). The `status` field is
one of `running`, `waiting`, `completed`, `failed`, `timed_out`, or
`cancelled`. While a node is executing, `currentNode`, `currentNodeType`,
`currentNodeStartedAt`, and `statusDetail` describe it, and they disappear
when the node finishes. While a pause request holds the run at a step
boundary, `paused` is `true` (with matching `run_paused`/`run_resumed` trace
events); it disappears when the run resumes or ends.

Per-node data lives in `outputs` (the accepted output of each finished node,
where the latest attempt wins on loops) and in `results` (the full result
record including the outcome and timing). The ordered history is `steps`,
with one record per node execution that includes the prompt text for agent
steps and an action receipt with the command, exit code, and duration for
action steps. When a run pauses at a checkpoint, `waitingOn` names the
checkpoint node. Terminal runs carry `finalOutput` on success and `error` on
failure.

## trace.ndjson

One event per line, monotonically sequenced per run:

```json
{
  "seq": 3,
  "at": "2026-07-19T02:39:14.101Z",
  "scope": "agent",
  "type": "agent_prompt_sent",
  "runId": "...",
  "nodeId": "implement",
  "attemptId": "...",
  "payload": { "prompt": "..." }
}
```

Event types: `run_started`, `node_started`, `agent_prompt_sent`,
`node_finished`, `node_failed`, and a terminal `run_<status>`. The `scope`
field (`run`, `node`, `agent`, `action`) groups them. Consumers should ignore
unknown event types so new ones can be added within the same schema version.

## Versioning

Each file carries a versioned schema identifier such as
`pi-workflows.run-bundle.v1`, and the identifier changes only on breaking
shape changes. Readers should check `manifest.json`'s `schema` field and skip
bundles they do not understand, which is exactly what the bundled viewer does
with unreadable directories.
