# Live replay protocol

The Rust viewer (`tui/`) can watch runs in two ways: by reading run bundles
directly from the filesystem (the default, in-process) or by connecting to a
`piw serve` WebSocket server. Both paths produce the same semantic state; the
protocol below is the network form of that state. Protocol id:
`pi-workflows.replay.v1`.

The server is a reader like any other: it only consumes run bundles (see
[run-bundles.md](run-bundles.md)) and never writes them. The protocol has no
authentication, so the server only accepts loopback bind addresses and refuses
to start on anything else; bundles contain private data, and remote viewing
goes through an SSH tunnel. Handshakes that
carry an `Origin` header are rejected: browsers always send one, and a web
page must not be able to read bundles by opening a WebSocket to localhost.

## Transport and framing

A single WebSocket endpoint (`/ws`). Every message is one JSON object with a
`type` field. Unknown message types and unknown fields must be ignored by both
sides. The server sends `hello` on connect; a client that does not recognize
the protocol id must disconnect.

```json
{ "type": "hello", "protocol": "pi-workflows.replay.v1" }
```

## Run views

The unit of synchronization is the **run view**, the semantic state of one
run:

```json
{
  "manifest": { … },
  "workflow": { … },
  "state": { … },
  "events": [ … ],
  "session": { "binding": { … }, "entries": [ … ] },
  "live": true,
  "possiblyInterrupted": false
}
```

- `manifest`, `workflow`, `state`, `events`, `session.binding`, and
  `session.entries` are the bundle documents verbatim (`workflow` is the
  definition snapshot the graph is drawn from, `events` are the parsed trace
  lines, `session.entries` the parsed session records). `session` is `null`
  until a binding exists.
- `live` is true while the run status is non-terminal and the bundle is still
  growing. `possiblyInterrupted` is true when the status is `running` but the
  bundle has not changed for 60 seconds.
- Artifact references inside the view stay references; contents are fetched
  on demand.

Because the full trace and session history are part of the view, replay
scrubbing is a pure client-side operation; rewinding never requires the
server.

## Snapshot, then patches

State synchronization follows a snapshot-then-patch model. After a client
subscribes to a run, the server sends one `run_snapshot`, then a stream of
`run_patch` messages:

```json
{ "type": "run_snapshot", "runId": "…", "revision": 3, "view": { … } }
{ "type": "run_patch", "runId": "…", "revision": 4, "patch": [
  { "op": "append", "path": "/events", "value": [ { "seq": 18, … } ] },
  { "op": "replace", "path": "/state", "value": { … } }
] }
```

- `revision` increases by exactly 1 per patch. A client that observes a gap
  must resubscribe and take a fresh snapshot.
- `patch` is JSON Patch (RFC 6902) plus one extension op: `append`, whose
  `value` is an array of items appended to the array at `path`. Semantically
  `append` equals a sequence of `add` ops at `/-`; it exists so that the
  common case (trace and session growth) stays compact and readable.
- Patches are computed against the previous view revision; applying them in
  order reproduces the server's view exactly.

## Messages

Client to server:

| type             | fields          | meaning                      |
| ---------------- | --------------- | ---------------------------- |
| `watch_runs`     | —               | subscribe to the run listing |
| `watch_run`      | `runId`         | subscribe to one run's view  |
| `unwatch_run`    | `runId`         | end a run subscription       |
| `fetch_artifact` | `runId`, `path` | request artifact contents    |

Server to client:

| type           | fields                       | meaning                                         |
| -------------- | ---------------------------- | ----------------------------------------------- |
| `hello`        | `protocol`                   | sent once on connect                            |
| `runs`         | `runs`                       | full run listing (summaries), re-sent on change |
| `run_snapshot` | `runId`, `revision`, `view`  | full view after subscribe                       |
| `run_patch`    | `runId`, `revision`, `patch` | incremental view update                         |
| `artifact`     | `runId`, `path`, `content`   | artifact contents (UTF-8)                       |
| `error`        | `message`, `runId?`          | request failed                                  |

Artifact requests are answered only from files below the artifact directory
declared by `manifest.paths.artifacts`. Paths outside that directory and
symlinks whose canonical targets leave it are refused. Responses are capped at
4 MiB of actual file size; anything else produces an `error`.

Run listing summaries are the manifest plus `live` and
`possiblyInterrupted`:

```json
{ "type": "runs", "runs": [ { "manifest": { … }, "live": true, "possiblyInterrupted": false } ] }
```

The run listing is small and changes rarely, so it is always sent whole; only
run views use patches.

## Reconnection

The native client treats the run listing, selected run, and pending artifact
reads as desired state rather than one-shot commands. After a connection closes,
it keeps the cached run visible with a stale/reconnecting label, retries with
bounded backoff, sends `watch_runs` after the next valid `hello`, and restores
the current `watch_run`. A reconnect receives a fresh snapshot before later
patches. Pending artifact reads are resubmitted once per connection.

## Filesystem semantics behind the protocol

The server watches the runs directory (inotify with polling fallback) and
tails `trace.ndjson` and `session/entries.ndjson` incrementally. Torn final
NDJSON lines are ignored until complete. `state.json` and `manifest.json` are
re-read on change; a `state.json` whose `traceSeq` is older than the last
tailed trace event is stale and is replaced when the writer catches up. After
a terminal status, watching stops.
