# Live replay protocol

The Rust viewer (`tui/`) can read SQLite directly or connect to `piw serve`. Both modes use the same bounded viewer projection. The protocol ID is `pi-workflows.replay.v1`.

The server reads SQLite and never writes it. It accepts loopback addresses only. Remote use goes through an SSH tunnel. The server rejects WebSocket handshakes with an `Origin` header so a web page cannot read workflow state from localhost.

## Framing

The endpoint is `/ws`. Each message is one JSON object with a `type` field. Unknown message types and fields are ignored. The server sends `hello` first. A client disconnects when it does not support the protocol ID.

```json
{ "type": "hello", "protocol": "pi-workflows.replay.v1" }
```

## Bounded run view

A snapshot contains one bounded run view:

```json
{
  "presentationRevision": 42,
  "graphRevision": 17,
  "manifest": { … },
  "workflow": { … },
  "graphScene": {
    "ranks": [ … ],
    "edges": [ … ],
    "segments": [ … ],
    "rankOfNode": { … }
  },
  "graphSteps": [ … ],
  "takenTransitions": [ "prepare->run" ],
  "stepStart": 768,
  "stepTotal": 1000,
  "state": {
    "steps": [ … ]
  },
  "tracePage": {
    "presentationRevision": 42,
    "start": 768,
    "total": 1000,
    "items": [ … ]
  },
  "session": {
    "presentationRevision": 42,
    "binding": { … },
    "entryPage": {
      "presentationRevision": 42,
      "start": 768,
      "total": 1000,
      "items": [ … ]
    },
    "eventPage": {
      "presentationRevision": 42,
      "start": 768,
      "total": 1000,
      "items": [ … ]
    },
    "capture": { … }
  },
  "settingsScopes": [ … ],
  "followUpQueue": { … },
  "live": true,
  "possiblyInterrupted": false
}
```

Each step, trace, session-entry, and session-event page contains at most 256 rows. `graphSteps` contains at most one latest attempt per node at the replay cursor. `takenTransitions` contains distinct transitions up to that cursor. `graphScene` is the retained language-neutral rank and route plan shared by Rust and TypeScript.

A snapshot does not contain complete trace or session history. A replay jump fetches the page that contains the requested zero-based cursor.

## Revisions and target patches

Each viewer-visible SQLite transaction advances the run presentation revision and commits ordered target patches with the same transaction. The server reads those patches. It does not build complete old and new run views to compare them.

```json
{
  "type": "run_patch",
  "runId": "run-1",
  "revision": 43,
  "targets": [
    {
      "targetType": "conversation",
      "targetKey": "entries:tail",
      "patch": [
        { "op": "replace", "path": "/presentationRevision", "value": 43 },
        { "op": "remove", "path": "/items/0" },
        { "op": "append", "path": "/items", "value": [ { "seq": 1001, … } ] },
        { "op": "replace", "path": "/start", "value": 745 },
        { "op": "replace", "path": "/total", "value": 1001 }
      ]
    }
  ]
}
```

The patch set supports `add`, `replace`, `remove`, and `append`. `append` adds each value to the target array in order. Tail patches keep their page at 256 rows by removing old leading rows when necessary.

A patch targets one bounded document or page. A client applies a tail patch only when it holds that tail page. Older loaded pages stay valid because committed history is immutable. A target that needs a fresh bounded projection causes a snapshot. This still avoids complete-run reads and complete-run JSON comparison.

Revisions must arrive in order. Duplicate state is harmless because a client ignores an old revision. A wrong run, malformed patch, missing path, stale page, future revision, or gap cannot replace the last good view. A gap or a cursor older than retained patches causes a bounded snapshot.

The database retains 256 presentation revisions per run. The server does not replay an unbounded patch backlog.

## Pages

A client asks for a page with `fetch_page`:

```json
{
  "type": "fetch_page",
  "runId": "run-1",
  "kind": "session_events",
  "cursor": 20000
}
```

`kind` is one of `steps`, `trace`, `session_entries`, `session_events`, `settings`, `follow_ups`, or `updates`. The server answers with `run_page`:

```json
{
  "type": "run_page",
  "runId": "run-1",
  "revision": 43,
  "kind": "session_events",
  "cursor": 20000,
  "start": 19872,
  "total": 48620,
  "items": [ … ]
}
```

Page reads use bounded ranges. The response echoes the requested `cursor` and carries the presentation revision read in the same SQLite snapshot as its rows. A client ignores an older response when a newer cursor is pending. A step page also returns `graphCursor`, `graphSteps`, and `takenTransitions` for that exact replay point, even when the selected step was already in the prior page. Settings, follow-up, and current-update pages keep the Info inspector complete without loading every record. A page request does not change the shared watched-run projection or another client's cursor.

## Messages

Client to server:

| Type             | Fields                                                                                                | Meaning                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `watch_runs`     | none                                                                                                  | Subscribe to run-list rows.                    |
| `watch_run`      | `runId`, optional `revision`, `stepCursor`, `traceCursor`, `sessionEntryCursor`, `sessionEventCursor` | Subscribe or resume one run.                   |
| `unwatch_run`    | `runId`                                                                                               | End one run subscription.                      |
| `fetch_page`     | `runId`, `kind`, `cursor`                                                                             | Read one bounded page.                         |
| `fetch_artifact` | `runId`, `path`                                                                                       | Unsupported for SQLite state; returns `error`. |

Server to client:

| Type           | Fields                                                 | Meaning                                  |
| -------------- | ------------------------------------------------------ | ---------------------------------------- |
| `hello`        | `protocol`                                             | Identify the protocol.                   |
| `runs`         | `runs`                                                 | Send all lightweight run-list rows.      |
| `run_snapshot` | `runId`, `revision`, `view`                            | Send one bounded run view.               |
| `run_patch`    | `runId`, `revision`, `targets`                         | Apply direct bounded target patches.     |
| `run_page`     | `runId`, `revision`, `kind`, `start`, `total`, `items` | Return one bounded page.                 |
| `artifact`     | `runId`, `path`, `content`                             | Reserved and not sent by SQLite servers. |
| `error`        | `message`, optional `runId`                            | Report a sanitized request failure.      |

The run list contains `presentationRevision`, `manifest`, `live`, and `possiblyInterrupted`. It contains no payload bodies.

## Several clients

The server keeps one projection and graph scene for each watched run. The first watcher loads it. Later watchers reuse it. The last unwatch or disconnect releases it. Different watched runs load independently.

Each client keeps its own revision and page cursors. Network sends happen outside the shared state lock. A slow client cannot stop another client. If a broadcast receiver falls behind, that client receives a bounded snapshot.

## Reconnection

The client keeps the run list and selected run as desired state. After a disconnect, it keeps cached content visible with a stale or reconnecting label. It retries with bounded backoff, sends `watch_runs` after the next valid `hello`, and resumes `watch_run` from its revision and page cursors. A retained cursor receives patches. A stale cursor receives a bounded snapshot and requested pages.

## SQLite consistency

The server uses a query-only SQLite connection. A writer commits the domain change, presentation revision, and patch records atomically. A reader sees all of that transaction or none of it.

The refresh timer first checks `PRAGMA data_version`. An unchanged value causes no run-index query and no payload read. A changed value refreshes lightweight rows and only the watched projections whose presentation revisions changed.
