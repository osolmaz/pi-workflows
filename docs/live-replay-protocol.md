# Live client protocol

Pi Workflows uses one live client protocol for the Pi extension, the TypeScript CLI, local `piw`, and remote `piw` through the loopback relay.

The protocol ID is `pi-workflows.client.v1`. Its schema is [`protocol/client.v1.schema.json`](../protocol/client.v1.schema.json). TypeScript and Rust use the same valid and invalid fixture corpus.

The host is the only process that reads or writes the active SQLite database. A client protocol or package-version mismatch does not mean that SQLite state is incompatible. The client stops and asks for matching `pi-workflows` and `piw` packages.

## Transports

The local transport is a user-only Unix socket on Unix systems:

```text
~/.pi/agent/workflows/host/host.sock
```

On Windows, the same client uses the package-derived `\\.\pipe\pi-workflows-<state-directory-hash>` named pipe. Local `piw`, `piw serve`, and the TypeScript client derive the same endpoint from the workflow state directory.

Each message is one canonical JSON object followed by a newline. A message can be at most 1 MiB. Unknown envelope fields, non-canonical JSON, and invalid framing close only the offending connection.

`piw serve` provides the remote transport at `/ws`. It binds to loopback only. Each WebSocket connection has one matching host-socket connection, and their lifecycles are coupled. The relay forwards one canonical JSON object per text frame. It does not read SQLite, translate views, multiplex clients, or retain state.

Remote clients use an SSH tunnel to reach the loopback relay.

## Envelope

The protocol has four message types:

- `hello` identifies the protocol connection and package version.
- `request` carries one operation, request ID, client ID, idempotency key, optional run ID and revision, and payload.
- `response` settles one request with an outcome, optional revision, receipt, or safe error.
- `event` carries a revisioned run list, run snapshot, run patch, run page, session snapshot, or unavailable condition.

The host sends `hello` first:

```json
{
  "connectionId": "connection-1",
  "packageVersion": "0.15.3",
  "schema": "pi-workflows.client.v1",
  "type": "hello"
}
```

A request uses a stable request ID and idempotency key:

```json
{
  "clientId": "client-1",
  "idempotencyKey": "status-1",
  "operation": "host.status",
  "payload": {},
  "requestId": "request-1",
  "schema": "pi-workflows.client.v1",
  "type": "request"
}
```

The closed outcomes are `accepted`, `adopted`, `rejected`, `conflict`, `notFound`, `claimLost`, and `unavailable`.

## Run and session views

The host produces `pi-workflows.run-view.v1` from one consistent database read. The view contains the bounded workflow state, graph, trace, session projection, page cursors, presentation revision, and one `display` object.

The closed display statuses are:

- `queued`
- `running`
- `waiting`
- `paused`
- `completed`
- `failed`
- `timed_out`
- `cancelled`
- `ambiguous`

Only the host computes this status. A parked queue is not a pause. `paused` requires the durable pause flag. An exact live worker or origin-session turn is `running`. An uncertain external effect that needs operator action is `ambiguous`. `unavailable` is a client connection condition, not a run status.

The run list uses the same display object. The host sends it as revision-bound `pi-workflows.run-list-page.v1` pages. Each page reads only lightweight run status and source facts. It does not load input, launch options, steps, trace, or session history. TypeScript and Rust clients collect all pages for one revision before they replace the visible list. If the revision changes, they discard the partial list and start from the next subscription event.

An origin-session subscription returns `pi-workflows.session-view.v1`, which contains the current run view, ordered pending interaction records, and read-only notification and turn availability in one read. The Pi extension sends a durable claim command only when the matching availability fact is true. After a turn claim, it reads the claimed run by its exact run ID. It does not use the latest run in the session. An idle session does not create empty claim or status commands.

A snapshot page contains at most 256 items and also has a byte budget. `view.page` returns another byte-bounded window that contains the requested cursor. Page responses use `pi-workflows.run-page.v1` and echo the requested cursor and run-view revision. A client applies a page only when both still match its current request and snapshot. A session-event page also carries the replay checkpoint for the exact sequence before its first item, so reducing the page does not lose earlier active messages or tool calls.

The host counts histories first and reads only the selected SQLite ranges. An unchanged subscription uses a lightweight revision check and reuses its prior view. It does not rebuild complete histories every 250 milliseconds.

Large prompt, output, event, settings, follow-up, and update values use a content reference instead of making a protocol frame exceed 1 MiB. `view.content` returns the referenced UTF-8 content in verified chunks. The reference includes its media type, byte count, SHA-256 digest, and an opaque marker for host-created references. The host saves generated view content in the content-addressed blob store and links it to the run before it advertises the reference. Memory-cache eviction therefore cannot make an advertised aggregate unavailable. Run pruning removes the durable link. Clients reassemble and verify all chunks before display. Opaque content is restored as user data without interpreting nested objects as host references. Other cursors and content references keep the complete logical history and result available.

## Subscriptions and reconnection

A client keeps one persistent connection and records its desired run-list, run, and origin-session subscriptions. After reconnection, it sends those subscriptions again with its accepted run revision. The host sends a bounded snapshot when the client needs one. The protocol also supports retained revision patches. Unsubscribing sends the subscription ID to the host for every subscription kind, so no unused snapshot work remains on a live connection.

A slow or disconnected client cannot stop the host, another client, claim renewal, or workflow execution. The host waits for socket drain before it publishes another snapshot to that connection. Polling coalesces while the connection is blocked, so the socket buffer cannot grow by one snapshot on every poll. When a connection closes, the host removes its subscriptions and exact origin-session activity immediately.

## Origin-session activity

The Pi extension reports `started`, `refresh`, and `settled` activity for the exact session, run, interaction request, delivery, and Pi session entry. Reports use a monotonic sequence. Refresh happens before the connection-scoped lease expires.

The host accepts activity only when it matches the durable presented interaction. Activity changes display only. It does not grant authority, renew a workflow claim, settle a step, or change durable pause state. A disconnect or expired activity lease removes the overlay.

## Commands and uncertain results

Durable commands use stable idempotency keys. A retry with the same durable identity and payload adopts the stored receipt. Reusing that identity with another payload is a conflict. The request ID identifies one transport attempt. A retry after a local abort uses a new request ID and keeps the durable idempotency and submission IDs, so a late response from the aborted attempt cannot settle the retry.

An `interaction.submit` response stays open while the supervised workflow child validates the value. The response settles only after the durable result is accepted, adopted, or rejected. A tool abort stops waiting immediately but does not undo an accepted host command. A later retry adopts the durable outcome. The host waits on the stored submission ID returned by adoption, not a different ID from the retry attempt. Clients do not poll SQLite.

The protocol does not claim exactly-once behavior for an external system that cannot prove it. An uncertain non-idempotent effect becomes ambiguous and requires explicit recovery.

## Maintenance

Active `state.status`, `state.verify`, `state.backup`, and `state.prune` requests run in the host against its existing database connection. `state.status` returns the database file size and safe counts for resources, runs, controllers, decisions, settings scopes, pending interactions, pending follow-ups, active leases, and unsettled effects.

Only `pi-workflows state verify <inactive-backup>` opens SQLite outside the host. It uses a query-only TypeScript connection and rejects the active database, including another path to the same file.
