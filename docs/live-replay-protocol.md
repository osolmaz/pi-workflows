# Live client protocol

> **Current version notice:** The single host and client protocol are implemented, but version 0.16.0 still uses the superseded activity lease and origin-session availability fields. The approved [workflow-message restoration plan](2026-09-02-unify-workflow-messages-plan.md) changes this version-1 protocol in place to use workflow messages, branch reports, and exact model-turn reports.

Pi Workflows uses one live client protocol for the Pi extension, the TypeScript CLI, local `piw`, and remote `piw` through the loopback relay.

The protocol ID is `pi-workflows.client.v1`. Its schema is [`protocol/client.v1.schema.json`](../protocol/client.v1.schema.json). TypeScript and Rust use the same valid and invalid fixture corpus.

The host is the only process that reads or writes the active SQLite database. A client protocol or package-version mismatch does not mean that SQLite state is incompatible. The client stops and asks for matching `pi-workflows` and `piw` packages.

## Transports

The local transport is a user-only Unix socket on Unix systems:

```text
~/.pi/agent/workflows/host/host.sock
```

On Windows, the same client uses the package-derived `\\.\pipe\pi-workflows-<state-directory-hash>` named pipe. Local `piw`, `piw serve`, and the TypeScript client derive the same endpoint from the workflow state directory. A foreground TypeScript cold start keeps its retry wait referenced until the detached host becomes ready or the start deadline expires. Only background reconnect timers are unreferenced.

Each message is one canonical JSON object followed by a newline. TypeScript and Rust use the same ECMAScript number formatting and UTF-16 object-key order, including for arbitrary workflow JSON. A message can be at most 1 MiB. Unknown envelope fields, non-canonical JSON, and invalid framing close only the offending connection. If socket backpressure delays a client write, connection close, socket error, or request cancellation ends the wait instead of leaving the request pending.

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

The host produces `pi-workflows.run-view.v1` from one consistent database read. The view contains the bounded workflow state, graph, trace, session projection, page cursors, presentation revision, and one `display` object. A terminal display includes the stored failure reason, not only its machine error code. A reason above the shared 16 KiB inline-content threshold uses a small `reason` notice and a digest-bound `reasonContent` reference. This keeps the run list below the 1 MiB frame limit and keeps the complete diagnostic available.

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

Only the host computes this status. A parked queue is not a pause. `paused` requires the durable pause flag. An exact live worker or origin-session turn is `running`. An effect being applied by that live worker is still `running`; only a durable `ambiguous` effect that needs operator action is `ambiguous`. `unavailable` is a client connection condition, not a run status.

The run list uses the same display object. The host sends it as revision-bound `pi-workflows.run-list-page.v1` pages. Each page reads only lightweight run status and source facts. It does not load input, launch options, steps, trace, or session history. TypeScript and Rust clients collect all pages for one revision before they replace the visible list. If the revision changes, they discard the partial list and start from the next subscription event.

An origin-session subscription returns `pi-workflows.session-view.v1`. It contains the active run view first. When no run is active, it keeps the most recent terminal run while its terminal workflow message is pending or its first model turn is open, and then for 60 seconds after that turn ends. The same response contains an ordered byte-bounded window of all nonterminal workflow messages and open sent messages needed for recovery, their complete count, and the next eligible pending message only for the active coordinator epoch.

The Pi extension assembles the complete run revision and workflow-message content before it updates the widget or coordinator. After every host connection, it reports the active branch before it sends a workflow message or reports a model turn. The report can name only message IDs from the complete session-view window. The extension always uses the exact run ID from that view. It does not select the latest run separately. An idle session does not create empty commands.

A snapshot page contains at most 256 items and also has a byte budget. `view.page` returns another byte-bounded window that contains the requested cursor. Page responses use `pi-workflows.run-page.v1` and echo the requested cursor and run-view revision. A client applies a page only when both still match its current request and snapshot. A step-centered trace request selects the exact stored attempt first and uses its node only when that attempt has no trace event. Large workflow topology has bounded node, edge, graph-step, and transition projections plus durable content references for the complete original definition and complete graph history. TypeScript clients assemble every run-history page for that revision and hydrate the complete definition and all referenced content before they emit a complete non-interactive view or update the Pi widget. TypeScript and Rust use the same verified content loader for complete graph steps and transitions. Rust also requests, verifies, and decodes the complete referenced definition before it builds the graph layout. A session-event page also carries the replay checkpoint for the exact sequence before its first item, so reducing the page does not lose earlier active messages or tool calls. The checkpoint can itself be a durable content reference. TypeScript hydrates it with the run view, and Rust requests and resolves it before replay.

The host counts histories first and reads only the selected SQLite ranges. An unchanged subscription uses a lightweight revision check and reuses its prior view. It does not rebuild complete histories every 250 milliseconds.

Large prompt, output, event, settings, follow-up, and update values use a content reference instead of making a protocol frame exceed 1 MiB. `view.content` returns the referenced UTF-8 content in verified chunks. The reference includes its media type, byte count, SHA-256 digest, and an opaque marker for host-created references. The host saves generated view content directly under its exact run ID, content digest, and media type before it advertises the reference. It does not share media metadata with general state blobs. A request for another run or media representation is unavailable. Memory-cache eviction therefore cannot make an advertised aggregate unavailable. Run pruning removes the durable content. Clients reassemble all chunks and verify the bytes against both the content response and the advertised reference before display. Opaque content is restored as user data without interpreting nested objects as host references. Other cursors and content references keep the complete logical history and result available.

## Subscriptions and reconnection

A client keeps one persistent connection and records its desired run-list, run, and origin-session subscriptions. A request to watch a run that does not exist returns `notFound` and does not install a subscription. TypeScript and Rust clients show that response instead of waiting for a snapshot. Explicit `piw <runId>` mode keeps that run selected even when the run list contains a newer run. After reconnection, the client sends accepted subscriptions again with its run revision. The host sends a bounded snapshot when the client needs one. The protocol also supports retained revision patches. Unsubscribing sends the subscription ID to the host for every subscription kind, so no unused snapshot work remains on a live connection.

A slow or disconnected client cannot stop the host, another client, claim renewal, or workflow execution. The host waits for socket drain before it publishes another snapshot to that connection. Polling coalesces while the connection is blocked, so the socket buffer cannot grow by one snapshot on every poll. When a connection closes, the host removes its subscriptions and active coordinator epoch. It does not infer that an open model turn ended.

## Origin-session activity

The Pi extension uses `workflowTurn.report` to record `started` and `ended` for the exact workflow message, workflow turn, run, and origin session. There is no refresh, activity lease, heartbeat, or sequence counter. A started turn keeps the host-produced display status `running` until the matching end is accepted. A stale end cannot clear a newer turn.

The host accepts a start only for an open sent workflow message in that origin session. A step message is open while its interaction remains pending and its run is not paused. A terminal or follow-up message is open until its first turn ends. Decisions and notifications never open model turns. Turn binding does not inspect branch membership because documented `agent_start` has no message payload; branch reporting owns entry adoption and branch-specific re-presentation.

If the workflow message or session view is still loading, the extension buffers the matching start and end and reports them in order after the message is confirmed `sent`. Activity changes display only. It does not grant workflow authority, renew a run claim, or settle an interaction. Host startup does not close an open Pi turn. Only a later idle-session active-branch report can close a proved-lost turn.

## Commands and uncertain results

Durable commands use stable idempotency keys. The Pi extension routes each state-changing command through the durable client request path. If the connection closes after the host commits but before the response arrives, the client reconnects with a new request ID and adopts the stored result. A retry with the same durable identity and payload adopts the stored receipt. Reusing that identity with another payload is a conflict. The request ID identifies one transport attempt and is not part of the durable request fingerprint. A retry after a local abort uses a new request ID and keeps the durable idempotency and submission IDs, so a late response from the aborted attempt cannot settle the retry.

An `interaction.submit` response stays open while the supervised workflow child validates the value. The response settles only after the durable result is accepted, adopted, or rejected. A tool abort stops waiting immediately but does not undo an accepted host command. A later retry adopts the durable outcome. The host waits on the stored submission ID returned by adoption, not a different ID from the retry attempt. Clients do not poll SQLite.

The protocol does not claim exactly-once behavior for an external system that cannot prove it. An uncertain non-idempotent effect becomes ambiguous and requires explicit recovery.

## Maintenance

Active `state.status`, `state.verify`, `state.backup`, and `state.prune` requests run in the host against its existing database connection. The CLI uses one stable client identity and creates a fresh idempotency key for each backup or applied prune invocation. If that invocation loses its connection, the client reconnects once with a new request ID and the same invocation key, so the host adopts the exact in-flight or stored result. A later user invocation gets a new key and does not reuse a stale success or rejection. The host keeps an in-flight maintenance command alive after a client disconnect, stores its accepted or rejected receipt before it responds, and adopts the exact retry instead of running the operation again. Host shutdown waits for in-flight maintenance receipts. `state.status` returns the database file size and safe counts for resources, runs, controllers, decisions, settings scopes, pending interactions, pending follow-ups, active leases, and unsettled effects.

Only `pi-workflows state verify <inactive-backup>` opens SQLite outside the host. It uses a query-only TypeScript connection and rejects the active database, including another path to the same file.
