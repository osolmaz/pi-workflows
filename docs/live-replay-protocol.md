# Live client protocol

Pi Workflows uses one live client protocol for the Pi extension, the TypeScript CLI, local `piw`, and remote `piw` through the loopback relay.

The protocol ID is `pi-workflows.client.v1`. Its schema is [`protocol/client.v1.schema.json`](../protocol/client.v1.schema.json). TypeScript and Rust use the same valid and invalid fixture corpus.

The host is the only process that reads or writes the active SQLite database. A client protocol or package-version mismatch does not mean that SQLite state is incompatible. The client stops and asks for matching `pi-workflows` and `piw` packages.

## Transports

The local transport is a user-only Unix socket:

```text
~/.pi/agent/workflows/host/host.sock
```

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

The run list uses the same display object. An origin-session subscription returns `pi-workflows.session-view.v1`, which contains the current run view and ordered pending interaction records in one read.

A snapshot contains at most 256 items for each large history. `view.page` returns another 256-item window centered on the requested cursor. Page responses use `pi-workflows.run-page.v1`. The client can request other cursors, so the complete logical history remains available.

## Subscriptions and reconnection

A client keeps one persistent connection and records its desired run-list, run, and origin-session subscriptions. After reconnection, it sends those subscriptions again with its accepted run revision. The host sends a bounded snapshot when the client needs one. The protocol also supports retained revision patches.

A slow or disconnected client cannot stop the host, another client, claim renewal, or workflow execution. When a connection closes, the host removes its subscriptions and exact origin-session activity immediately.

## Origin-session activity

The Pi extension reports `started`, `refresh`, and `settled` activity for the exact session, run, interaction request, delivery, and Pi session entry. Reports use a monotonic sequence. Refresh happens before the connection-scoped lease expires.

The host accepts activity only when it matches the durable presented interaction. Activity changes display only. It does not grant authority, renew a workflow claim, settle a step, or change durable pause state. A disconnect or expired activity lease removes the overlay.

## Commands and uncertain results

Durable commands use stable request IDs and idempotency keys. A retry with the same identity and payload adopts the stored receipt. Reusing an identity with another payload is a conflict.

An `interaction.submit` response stays open while the supervised workflow child validates the value. The response settles only after the durable result is accepted, adopted, or rejected. A reconnect repeats the same request identity and adopts the same durable result. Clients do not poll SQLite.

The protocol does not claim exactly-once behavior for an external system that cannot prove it. An uncertain non-idempotent effect becomes ambiguous and requires explicit recovery.

## Maintenance

Active `state.status`, `state.verify`, `state.backup`, and `state.prune` requests run in the host against its existing database connection.

Only `pi-workflows state verify <inactive-backup>` opens SQLite outside the host. It uses a query-only TypeScript connection and rejects the active database, including another path to the same file.
