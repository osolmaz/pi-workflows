# Live replay protocol

The Rust viewer (`tui/`) can watch runs in two ways: by reading SQLite runs
directly from the filesystem (the default, in-process) or by connecting to a
`piw serve` WebSocket server. Both paths produce the same semantic state; the
protocol below is the network form of that state. Protocol id:
`pi-workflows.replay.v1`.

The server is a reader like any other: it only consumes SQLite runs (see
[SQLITE_STATE.md](SQLITE_STATE.md)) and never writes them. The protocol has no
authentication, so the server only accepts loopback bind addresses and refuses
to start on anything else; workflow state contains private data, and remote viewing
goes through an SSH tunnel. Handshakes that
carry an `Origin` header are rejected: browsers always send one, and a web
page must not be able to read workflow state by opening a WebSocket to localhost.

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
  "session": {
    "binding": { … },
    "entries": [ … ],
    "events": [ … ],
    "eventsMalformed": false,
    "eventsTornTail": false,
    "capture": { … }
  },
  "live": true,
  "possiblyInterrupted": false
}
```

- `manifest`, `workflow`, `state`, `events`, and every `session` field are
  semantic projections from SQLite. `workflow` is the definition snapshot,
  top-level `events` are workflow events, `session.entries` are settled Pi
  entries, `session.events` are normalized temporal events, and
  `session.capture` is capture integrity. `session` is `null` until a binding
  exists.
- `live` is true while the run status is non-terminal. `possiblyInterrupted`
  is a reader-side diagnostic based on current ownership and update time.
- Values are resolved from content-addressed SQLite blobs.

Because the full trace and session history are part of the view, replay
scrubbing is a pure client-side operation; rewinding never requires the
server. Clients order session events by `seq` and use `at` only for playback
timing.

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
- Session growth uses `append` at `/session/entries` and `/session/events`.
  Capture changes use `replace` at `/session/capture`. Changes to the derived
  tail diagnostics use `replace` at `/session/eventsMalformed` and
  `/session/eventsTornTail`.
- The server waits 50 ms after a filesystem notification before refreshing,
  so one token burst normally becomes one revision. Batch boundaries never
  merge or alter event records.
- Patches are computed against the previous view revision; applying them in
  order reproduces the server's view exactly.

## Messages

Client to server:

| type             | fields          | meaning                      |
| ---------------- | --------------- | ---------------------------- |
| `watch_runs`     | —               | subscribe to the run listing |
| `watch_run`      | `runId`         | subscribe to one run's view  |
| `unwatch_run`    | `runId`         | end a run subscription       |
| `fetch_artifact` | `runId`, `path` | unsupported; returns `error` |

Server to client:

| type           | fields                       | meaning                                         |
| -------------- | ---------------------------- | ----------------------------------------------- |
| `hello`        | `protocol`                   | sent once on connect                            |
| `runs`         | `runs`                       | full run listing (summaries), re-sent on change |
| `run_snapshot` | `runId`, `revision`, `view`  | full view after subscribe                       |
| `run_patch`    | `runId`, `revision`, `patch` | incremental view update                         |
| `artifact`     | `runId`, `path`, `content`   | reserved; not sent by SQLite-backed servers     |
| `error`        | `message`, `runId?`          | request failed                                  |

SQLite-backed views contain resolved values. A `fetch_artifact` request returns
an `error` because there is no artifact directory.

Run listing summaries are the manifest plus `live` and
`possiblyInterrupted`:

```json
{ "type": "runs", "runs": [ { "manifest": { … }, "live": true, "possiblyInterrupted": false } ] }
```

The run listing is small and changes rarely, so it is always sent whole; only
run views use patches.

## Reconnection

The native client treats the run listing and selected run as desired state rather
than one-shot commands. After a connection closes,
it keeps the cached run visible with a stale/reconnecting label, retries with
bounded backoff, sends `watch_runs` after the next valid `hello`, and restores
the current `watch_run`. A reconnect receives a fresh snapshot before later
patches.

## SQLite semantics behind the protocol

The server polls `state.sqlite` through a query-only connection. Each refresh
reads a committed run projection, immutable events, session rows, and blob
values. A transaction is either fully visible or not visible, so a client never
observes half of a state transition.
