# Workflow server

Status: the out-of-process server, unified live client, workflow-message contract, and restored session behavior are implemented. [Unify workflow run state](2026-09-04-workflow-run-state-plan.md) records the approved refactor for turn ownership, managed effects, restarts, terminal data, cancellation, and runner recovery. [Unify workflow messages and restore hosted behavior](2026-09-02-unify-workflow-messages-plan.md), [run workflows outside Pi](2026-08-30-out-of-process-workflow-host-plan.md), [restore workflow session delivery and controls](2026-09-01-restore-session-delivery-controls-plan.md), and [unify live workflow clients](2026-09-01-unified-workflow-client-plan.md) record the earlier design and implementation plans.

## Purpose

The workflow server keeps durable workflow state correct when Pi, a workflow, or the server stops unexpectedly. It owns the workflow database and supervises a separate process for each active run. Pi remains the user interface and performs interactive model turns through its documented extension APIs.

The server solves two different failures:

- A busy workflow cannot block the process that renews run claims.
- A crashed or stale runner cannot leave contradictory state or continue writing after another runner takes over.

## Terms

- **Server:** The single user-level process that owns workflow state, claims, commands, and runner supervision.
- **Client:** A Pi extension instance or command-line process connected to the server.
- **Runner:** A child process that loads one workflow and executes one active run generation.
- **Origin session:** The Pi session that started an interactive run.
- **Claim:** A time-limited right to change one run.
- **Generation:** A number increased each time a new owner claims a run. It fences older owners.
- **Durable boundary:** A committed node or lifecycle transition from which execution can resume.
- **Interactive request:** A durable agent or assistant-message step that must run in the origin Pi session.
- **Workflow message:** Server-owned content that Pi must add to an origin conversation, such as a step, reminder, decision, notification, terminal result, or follow-up.
- **Managed effect:** A side effect reserved and settled through an idempotent durable record.
- **Live run view:** The server's versioned, bounded projection of one run, including its durable state, current origin-session activity, allowed controls, and page cursors.
- **Renderer:** A Pi widget, status line, command-line view, Herdr adapter, or `piw` screen that displays or acts on a live run view without deriving workflow state.

## Boundaries

The server belongs to the `@osolmaz/pi-workflows` package. It uses the existing SQLite database at `~/.pi/agent/workflows/state.sqlite` and documented Pi extension APIs.

The design does not change Pi source, Pi session files, Pi message schemas, or private Pi APIs. It does not add a remote service or a second database. The package does not install an operating-system service.

SQLite remains local to one machine. The protocol does not provide distributed consensus or network-filesystem safety.

## Process model

One server owns the global workflow database for one user installation.

```text
Pi extension ─┐
CLI client ───┼── WorkflowClient v1 ── local socket ── workflow server ── SQLite
piw ──────────┘                                              │
                                                             ├── workflow runner A
Remote piw ── SSH tunnel ── loopback WebSocket relay ────────┤
                                                             ├── workflow runner B ── headless pi --mode rpc
                                                             ├── resource runner
                                                             ├── channel adapter child
                                                             └── source resolver
```

The local socket and loopback WebSocket relay carry the same logical client protocol and live run view. The relay reads no state and translates no domain contract. The server is the only production process that opens the live SQLite database. Runner, channel-adapter, and source-resolver channels are private supervision protocols, not alternate client interfaces.

The server may manage runs from more than one project. Each run keeps its canonical project path and source identity.

The server process performs only bounded protocol handling, live-view projection, short SQLite transactions, timers, queue scheduling, and process supervision. It does not import or execute workflow definitions.

A runner loads one workflow source and executes one run generation. It cannot receive a writable `WorkflowRunStore`. It proposes changes to the server over a private child channel. This is an architectural guard against accidental writes. It is not a security sandbox against code running as the same operating-system user.

A channel adapter child handles one approved external presentation channel. It receives only the rendered presentation and the private channel configuration needed for its work. It does not open SQLite or receive the decision subject. The server owns claims, answer verification, settlement, and process supervision.

## Server lifecycle

The package CLI owns server lifecycle commands:

```text
pi-workflows server start
pi-workflows server status
pi-workflows server stop
pi-workflows server run
```

`run` stays attached for direct operation and tests. `start` starts the package process on demand and waits for a ready handshake. It does not install systemd, launchd, or another persistent service.

The server uses one global lock and one server epoch. Socket creation and the SQLite server claim must agree before the server accepts commands. A second live server refuses to start. After the old server lease expires, a new server increases the epoch before it handles work. Messages from an older epoch are rejected.

The server stays alive while it has a connected client, an active runner, a scheduled wake, a pending managed resource, a pending external-channel decision, or other unsettled work. An idle server may exit after a documented idle period. A later client can start it again.

## Claim rules

A run claim contains:

- owner type and owner ID;
- token hash;
- generation;
- acquisition time;
- heartbeat time;
- expiry time.

A protected state write uses one SQLite transaction:

1. Read the expected resource revision and lease.
2. Compare owner type, owner ID, token hash, and generation.
3. Require a future expiry time.
4. Renew heartbeat and expiry for that exact claim.
5. Apply the domain change.
6. Add the immutable event and viewer delta.
7. Increase the resource revision.
8. Commit.

The transaction fails without changes when any check fails.

An expired claim cannot renew itself, even when the owner ID and token hash still match. Recovery first takes a new claim and increases the generation.

The server also renews active claims from a timer. The timer is a backup for a run with no state writes. Normal write correctness does not depend on the timer.

Claim rejection uses `ClaimLostError` with one internal reason:

- `missingAuthority`
- `expired`
- `ownerChanged`
- `tokenChanged`
- `generationChanged`

Logs may show the run ID, generation, and reason. They must not show a raw token or token hash.

## Run lifecycle

The run and queue projections follow these states:

| Run state   | Queue state | Claim | Runner   | Meaning                                                 |
| ----------- | ----------- | ----- | -------- | ------------------------------------------------------- |
| `queued`    | `queued`    | none  | none     | Ready for server scheduling.                            |
| `running`   | `starting`  | host  | starting | A runner launch is being recorded.                      |
| `running`   | `running`   | host  | live     | A runner is executing one node.                         |
| `running`   | `parked`    | none  | none     | Execution stopped at a durable boundary and can resume. |
| `waiting`   | `parked`    | none  | none     | A checkpoint or interactive request needs input.        |
| `completed` | `done`      | none  | none     | The run finished successfully.                          |
| `failed`    | `failed`    | none  | none     | The run failed with a durable error.                    |
| `timed_out` | `failed`    | none  | none     | The run exceeded a declared timeout.                    |
| `cancelled` | `cancelled` | none  | none     | Cancellation completed.                                 |

The `host` claim-owner value and `pi-workflows.worker-launch.v1` launch schema are retained version-1 internal identifiers. They do not name public components.

A lifecycle transaction updates the run, queue, attempt, decision, lease, event, and viewer facts that belong to one transition. The database must not commit a failed event while the run remains running, or a terminal queue row while the run remains nonterminal.

A terminal state commits before the server builds its terminal workflow message. Missing or invalid presentation data can prevent that message, but it cannot roll back completion, failure, or cancellation. The server schedules another attempt and also finds missing terminal messages when it starts, so repaired presentation data can produce the same terminal message later.

Waiting and paused work does not keep a runner or a live claim. Resume takes a new claim generation and starts a new runner from the last durable boundary.

## Runner lifecycle

A runner launch envelope contains:

```json
{
  "schema": "pi-workflows.worker-launch.v1",
  "runId": "run-id",
  "generation": 2,
  "runnerEpoch": "opaque-id",
  "projectPath": "/canonical/project/path",
  "workflowSource": {
    "root": {
      "kind": "file",
      "path": "/canonical/project/path/.pi/workflows/example.workflow.ts",
      "hash": "sha256-digest"
    },
    "mounted": []
  },
  "definitionDigest": "sha256:digest",
  "inputHash": "sha256:digest",
  "protocolVersion": 1
}
```

Before it loads workflow modules, the runner verifies the root identity and every saved mounted file hash or built-in revision. After loading, it also checks the complete mounted-source map against the saved map. A mismatch parks the run with `workflowSourceChanged`. The normal scheduler does not claim that run again. The operator can restore the recorded source and explicitly resume the run, or cancel it. Changed included code does not execute.

After the ready message, the server sends one explicit command: `start`, `resume`, `continue`, or `restart`. A continuation names its waiting checkpoint parent. A restart begins a new run from the workflow start. The runner never infers the command from a nullable parent ID.

The server records a runner epoch before spawn. The child must return a ready message before the startup deadline. Every later child message includes the run ID, generation, and runner epoch.

The server records one terminal runner outcome:

- `exited`
- `cancelled`
- `timedOut`
- `crashed`
- `claimLost`
- `orphaned`

A runner exit is not automatically a run failure. The server decides from the last committed attempt and effect state whether it can resume, must park, or must fail. If the saved run revision did not advance after the runner became ready, the server parks the run with `runnerNoProgress` and does not claim it again automatically. An explicit resume can make one new attempt after the operator corrects the cause.

## Process supervision

Each runner starts in its own process group. A headless Pi child starts in another process group so normal runner completion can stop all Pi tool descendants without signaling the runner itself. The runner registers that direct child with the server before it sends a prompt and unregisters it only after group shutdown. The server owns the one process registry and reaps a registered child if its runner exits first.

The server enforces:

- a startup handshake deadline;
- node deadlines already declared by the workflow engine;
- bounded protocol messages;
- bounded captured stdout and stderr;
- cancellation with `SIGTERM` and bounded `SIGKILL` escalation;
- process-group cleanup;
- orphan checks after server restart;
- portable memory or process limits where Node and the operating system support them.

The child protocol applies backpressure and has an independent 1 MiB frame limit. Before the server sends a reply, it measures the encoded response. An oversized required result is stored in the existing content-addressed blob store. The server returns a small digest-bound reference, and the runner reads and verifies the value in bounded 512 KiB parts. Missing content, bad ranges, wrong lengths, wrong digests, invalid media types, malformed JSON, and oversized errors return bounded failures. They do not crash the runner.

Execution reads are narrow. `prepareRunResume()` and continuation reads return only `WorkflowRunState`. Pi session entries, tool results, activity events, viewer history, workflow snapshots, settings, and follow-ups stay in server-owned SQLite unless one exact execution operation needs them. The runner cannot request a complete `LoadedWorkflowRun`. The server measures every runner reply, so another operation cannot silently cross the frame limit.

The full logical result and request receipt remain durable for repeat handling. Matching repeated requests return the same value or content reference. Normal blob pruning removes unreferenced transfer content. Viewer history continues through its separate bounded page and content-reference interface.

The process registry includes a process start identity, not only a PID. The server accepts a runner registration only when the PID is a direct child of that active runner. A reused PID cannot let a new server kill an unrelated process.

## Live client protocol

Every production client uses one versioned `WorkflowClient` protocol. No extension, CLI command, Herdr adapter, or `piw` mode opens the live SQLite database. Clients connect through a user-only local socket. Unix socket mode is `0600`. Other platforms use their equivalent local transport and access control. Remote viewing uses a loopback-only WebSocket relay through an SSH tunnel. The relay carries the same messages and does not read SQLite.

The alpha hard cut replaces the existing server request and replay protocols in place with `pi-workflows.client.v1`. It adds no `v2`, compatibility path, fallback reader, or second live protocol. One neutral JSON schema is the wire-contract source for TypeScript and Rust. Shared conformance fixtures must pass in both languages.

Messages use newline-delimited canonical JSON on the local socket and one canonical JSON object per WebSocket message. TypeScript and Rust use the same ECMAScript number formatting and UTF-16 object-key order for canonical JSON. Both parsers reject unknown envelope fields and non-canonical framing. One message is at most 1 MiB, matching the existing durable event limit. The receiver closes only the offending connection when framing or validation fails.

Each message uses one envelope:

```json
{
  "schema": "pi-workflows.client.v1",
  "type": "request",
  "requestId": "opaque-id",
  "clientId": "opaque-id",
  "operation": "run.cancel",
  "runId": "run-id",
  "expectedRevision": 12,
  "idempotencyKey": "stable-key",
  "payload": {}
}
```

The `type` is `hello`, `request`, `response`, or `event`. A response repeats the request ID and includes its outcome, revision, receipt, or bounded safe error. An event names its subscription and carries one revisioned run-list snapshot, run-view snapshot, patch, page, origin-session workflow-message change, or availability change. Valid command outcomes remain `accepted`, `adopted`, `rejected`, `conflict`, `notFound`, `claimLost`, and `unavailable`.

The server commits a command receipt before it acknowledges success. The request ID identifies one transport attempt and is excluded from the durable fingerprint. The Pi extension sends state-changing commands through the durable client path. If a connection closes after commit but before response, a retry uses a new request ID with the same client ID, idempotency key, operation, and payload, then adopts the stored receipt. Reusing a request ID or idempotency key with another durable payload returns a conflict. An `interaction.submit` response stays pending while the supervised child validates the value and settles only after the durable outcome is `accepted`, `adopted`, or `rejected`. A reconnect with the same durable identity and payload waits for and returns that same outcome. Clients do not poll SQLite for submission results.

View and subscription reads do not create receipts. Reconnection restores desired subscriptions from the last accepted presentation revision. A retained revision receives patches. A stale revision receives a bounded snapshot. A slow subscriber gets at most one socket-buffered snapshot at a time because the server waits for drain and coalesces later polls. A backpressured client write stops waiting when its connection closes, its socket fails, or its request is cancelled. Every explicit client unsubscribe removes the matching server subscription, including run-list and origin-session subscriptions.

The protocol owns four operation groups:

- run and resource manager commands, including start, pause, resume, cancel, restart, decisions, updates, submissions, settings, follow-ups, reconciliation, and server control;
- live views and recording, including run lists, snapshots, subscriptions, pages, referenced content, origin-session workflow messages, terminal-view clear, and batched session events;
- active-branch and model-turn reports;
- state and channel maintenance, including status, verification, backup, prune, channel status, channel reload, and explicit channel recovery against the active database. Backup and applied prune use one fresh CLI idempotency key per user invocation. An automatic reconnect retry keeps that key and uses a new request ID. A later invocation gets a new key. The server finishes an in-flight operation after a disconnect, stores its accepted or rejected receipt before response, waits for it during shutdown, and adopts an exact retry.

`workflowMessage.reportBranch` reports workflow message IDs and Pi entry IDs from the complete origin-session view window together with `isIdle` and `hasPendingMessages`. The server adopts matching entries, changes a matching pending or cancelled message to `sent`, closes proved-lost turns, and creates one missing message of the source's own kind after a branch change. `workflowTurn.report` records exact model-turn starts and ends. The server keeps one active coordinator connection and process-local epoch for each origin session. A replacement connection fences the old one. Only the active epoch receives the next eligible pending message or can report branch and turn state. Polling alone creates no durable command.

### Live run view

The server returns one canonical `pi-workflows.run-view.v1` document. It contains the existing bounded workflow projection and page cursors plus a `display` object. The queue field contains display metadata only. It does not repeat the input, launch options, runner affinity, or claim capability; the complete input remains reachable through the state projection. The `display` object contains the effective status, current activity kind, allowed controls, and the stored reason when action is required. A reason above the shared 16 KiB inline-content threshold uses a small `reason` notice and a digest-bound `reasonContent` reference, so one diagnostic cannot exceed the 1 MiB protocol frame while the complete reason remains available. Renderers use this object directly. They must not combine separate queries or infer status from durable rows.

The unfinished node-attempt row is the one durable source for the current node. A running run exposes it as `currentNode`. A parked interactive run exposes the same node as `waitingOn`. A checkpoint has no unfinished attempt, so its completed checkpoint node supplies `waitingOn`. During an exact origin-session model turn, the server `display` changes that waiting node to running for presentation only. It does not infer another node or change the durable run state.

Generated referenced content is stored directly in `run_view_content` under its exact run ID, content digest, and media type. It does not share general state-blob media metadata. A content read must match all three values, so a reference from another run or another media representation is unavailable.

The origin-session response contains the active run view. When no run is active, it keeps the most recent terminal run visible while its terminal workflow message is pending or its first model turn is open, and then for 60 seconds after that turn ends. A newer run or `sessionView.clearTerminal` removes the retained terminal view. `/workflow clear` and the matching `piw` action call that control without changing workflow state.

The response also contains an ordered byte-bounded window of all nonterminal workflow messages and open sent messages needed for recovery, their complete count, and the next eligible pending message ID only for the active coordinator epoch. Message records include the source, content reference, order, state, and Pi entry needed by the shared coordinator. A branch report can name only IDs from this complete window. The server returns all these facts from one consistent read. The extension materializes the complete run revision and message content before it updates the widget or coordinator. After every server connection, it reports the active branch before it sends a workflow message or reports a model turn. Polling an idle session creates no durable command.

Each history page has both an item limit and an encoded byte budget. Oversized values become digest-bound content references. Large workflow topology uses bounded node, edge, graph-step, and transition projections plus references for the complete original definition and complete graph history. Before the server advertises a generated reference, it stores the bytes under the exact run ID, content digest, and media type in `run_view_content`. It does not share media metadata with general state blobs. Memory-cache eviction cannot make a reference unavailable. `view.content` returns bounded chunks until the client has the complete value. The client verifies the assembled bytes against both the response digest and the digest in the advertised reference. TypeScript clients assemble every run-history page for one revision and hydrate the complete definition, complete graph history, and all referenced content before they emit a complete non-interactive view or update the Pi widget. Rust automatically requests and verifies the complete referenced definition and graph history, decodes the complete values, and then builds its graph layout. Session-event pages include the replay checkpoint immediately before the first event in the page. A large checkpoint is also a referenced value. TypeScript hydrates it with the run view, and Rust requests and resolves it before replay. A step-centered trace page selects the exact stored attempt first and uses the node ID only if that attempt has no trace event. The run list reads only status facts and never loads complete run histories.

The closed `display.status` set is `queued`, `running`, `waiting`, `paused`, `completed`, `failed`, `timed_out`, `cancelled`, and `ambiguous`.

The server computes effective status in this order:

1. A durable ambiguous external effect that requires explicit review is `ambiguous`. An effect that is still applying under a live runner is not ambiguous.
2. A live supervised runner or an exact active origin-session workflow turn is `running`.
3. A durable terminal result keeps its terminal label after its presentation turn ends.
4. A durable pause is `paused` after its active Pi turn ends.
5. A pending interaction, decision, or presentation with no exact active turn is `waiting`.
6. Parked resumable work with no pending interaction is `queued`.
7. Admitted work that has not started is `queued`.

Server connection failure is the client condition `unavailable`, not a `display.status` value. `paused` is never inferred from a parked queue, pending interaction, stale cursor, or missing activity report.

### Origin-session activity

`agent_start` has no message payload. The extension binds it through the current origin-session view. The latest sent step is open while its interaction remains pending and its run is not paused. Any turn that starts in that state is workflow work. A terminal or follow-up message is open only until its first turn ends. Decisions and notifications never open a turn. The server rejects a start against a closed message.

Each report names the sent workflow message, workflow turn ID, run, and origin session. The extension creates the turn ID at start and keeps it through the matching end and server reconnect. If the session view or message receipt is still loading, it buffers start and end and reports them in order when the message becomes available.

At `agent_end`, the extension derives `completed`, `aborted`, or `error` from the documented assistant messages. It reads response-entry evidence from `ctx.sessionManager.getBranch()`; the entry ID can be null. The server applies the end, activity update, pause, unproductive-turn counter, and pending step-message cancellation in one transaction. A repeated report adopts that result. A stale turn ID cannot clear newer activity.

An aborted turn sets the run pause, cancels pending step messages, and does not increment `unproductiveTurnEnds`. The interaction derives its paused state from the run. Resuming that submitted-output step atomically clears the pause, increments the interaction revision, and creates one step message with reason `resumed`. Pi starts a fresh model turn from that message. A protected decision does not start a model turn, so pause and resume do not change its interaction revision or create another decision message. A completed, recoverably failed, or proved-lost turn increments the counter only when the submitted-output step remains pending, not paused, and has no accepted or validating submission. Values one and two create one step message with reason `reminder`; a value above two fails the attempt. At most one pending reminder-reason step exists. Acceptance, pause, cancellation, timeout, and branch re-presentation cancel pending step messages.

The process-local coordinator epoch ends on client disconnect, but an open reported workflow turn does not end. Server startup does not close Pi turns. On `session_start`, `workflowMessage.reportBranch` closes an unended open message as `lost` only when Pi is idle. A busy Pi session re-reports the same started turn. A lost step follows the unproductive-turn rule. A lost terminal or follow-up closes after its first turn. Follow-up activity controls ordering but does not show the completed workflow as `running`. Activity cannot grant workflow authority or settle a workflow request.

### Renderers and controls

The Pi widget, Pi status line, `/piw`, `Ctrl+Shift+R`, Herdr placement adapter, CLI status output, and every local or remote `piw` screen consume the same live run view. The Pi extension subscribes by origin session and materializes the complete step history before it renders the widget. The Herdr adapter receives the exact run target from that view and owns only pane placement and focus. The TypeScript CLI and Rust TUI subscribe by run ID and use protocol pages and referenced content. Explicit `piw <runId>` mode keeps the requested run selected and does not replace it with the newest run-list item. They do not open live SQLite or compile or validate its DDL digest.

Local `piw` may start the server only by executing the installed `pi-workflows server start` command. It does not reimplement server lifecycle. A foreground TypeScript client keeps its cold-start retry timer referenced until the server is ready or the start deadline expires. It uses the package socket on Unix and the same package-derived named pipe as TypeScript on Windows. `piw serve` becomes a loopback WebSocket relay for the same client protocol. It opens one server socket connection for each WebSocket connection and couples their lifecycles one to one. It never multiplexes clients, translates state, or opens the database. A client that cannot start or reach the matching server fails with one clear unavailable or package-version error. It must not fall back to direct SQLite access.

## Runner protocol

The private runner channel accepts these message kinds:

- `runner.ready`
- `node.started`
- `node.update`
- `node.finished`
- `node.failed`
- `run.parked`
- `run.finished`
- `interaction.requested`
- `interaction.accepted`
- `interaction.rejected`
- `notification.requested`
- `presentation.requested`
- `effect.reserve`
- `effect.settle`
- `runner.progress`
- `runner.exiting`

Every runner message includes the runner launch schema, run ID, generation, runner epoch, attempt ID when applicable, expected revision, and a stable message ID. Headless runners use `process.register` and `process.unregister` operations under `runner.progress` to attach their Pi child group to server supervision. Registration requires the live run claim. Unregistration remains valid after a terminal state releases that claim so cleanup can finish.

The server checks the generation and epoch before it reads the payload. A stale runner gets one claim-loss response and must exit. The server stores receipts for accepted state-changing messages so a retry receives the same answer.

## Supervised channel adapters

The server launches one transport-only child for each configured Telegram profile. The child receives only the complete operator presentation, allowed Telegram identities, and the one profile credential that it needs. It does not receive the canonical decision subject, open SQLite, load workflow code, or change run state.

The private version-1 channel protocol has these message kinds:

- `channel.ready`;
- `channel.present`;
- `channel.answer`;
- `channel.settle`; and
- `channel.exiting`.

Each message includes the adapter epoch, profile, sequence, expected channel revision, and stable attempt ID. The server validates these values before it accepts a result or answer. A stale adapter or stale attempt cannot settle newer work.

Before the child sends or edits an external message, the server records a managed effect in `effects` and `effect_attempts`. A confirmed result stores its Telegram message references in the effect result. A known rejection can start a bounded new attempt. If the server or adapter stops while an exact attempt is applying, only that in-flight attempt becomes `ambiguous`; the server does not send it again automatically.

The operator checks Telegram before resolving an ambiguous attempt. `/workflow-channel recover <message-id> confirm` records that the external work happened. `/workflow-channel recover <message-id> retry` starts a new numbered attempt and warns that a duplicate is possible. `channel_messages` remains the decision feature record for delivery and settlement; it does not duplicate the external-effect state or Telegram references.

## Durable protocol records

Reuse current rows when they already own a fact:

- `runs`, `run_queue`, `leases`, and `events` own run lifecycle and claims.
- `node_attempts` owns node execution state and resolved wall-clock deadlines.
- `human_decisions` and resolution tables own checkpoints.
- `effects` and `effect_attempts` own side effects and ambiguous outcomes.
- `workflow_messages` owns all content that Pi must add to an origin conversation.
- `run_bindings` owns origin session and execution mode.

`workflow_messages` contains the target session, message kind, source record, content digest, session order, state, confirmed Pi entry ID, and timestamps. Its states are `pending`, `sent`, and `cancelled`; it has no separate sent timestamp. Active-branch evidence changes a matching pending or cancelled message to `sent`. Message kind determines its renderer, turn behavior, and server eligibility rule. A partial unique index allows at most one pending step message for one interactive request. The table stores no sender, send lease, duplicate flag, or message-to-message pointer.

Add only these records if implementation proves the current rows cannot hold the contract:

### Server commands

`host_commands` stores request ID, client ID, operation, idempotency key, durable request fingerprint, run ID, accepted revision, outcome, receipt or error hash, and timestamps. The request ID is transport identity and is not part of the fingerprint. The request primary key prevents one request ID from naming two payloads. The client and idempotency-key uniqueness adopts the same durable payload across transport attempts.

### Interactive requests

`interactive_requests` stores request ID, run ID, attempt ID, target session ID, kind, contract hash, pending or settled status, accepted submission ID, `unproductiveTurnEnds`, and timestamps. Pause is stored once on the run and derived for its interaction. One attempt has at most one request. The linked node attempt stores its resolved wall-clock deadline.

`interactive_submissions` stores request ID, submission ID, idempotency key, payload hash, validating, accepted, or rejected outcome, receipt hash, and submission time. Repeated keys return the same receipt.

### Runner epochs

`run_workers` stores run ID, generation, runner epoch, launch envelope hash, process identity, status, start time, ready time, finish time, exit code, signal, and bounded diagnostic hash. One run and generation can have several sequential runner epochs, but only one may be active.

These tables remain part of `pi-workflows-state` schema version 1. The DDL digest changes in place under the alpha policy.

## Interactive Pi execution

Agent and assistant-message steps for an interactive run execute in the origin Pi session.

The runner commits the node's resolved wall-clock deadline before it proposes `interaction.requested`. The server commits the request, changes the node attempt to waiting, parks the queue row, releases the claim, and acknowledges the runner. The runner then exits. The server continues to enforce the durable deadline while no runner exists. If the deadline passes, one control claim atomically closes the stale request and schedules a supervised timeout-resume child. The child preserves the same attempt and deadline, records `timed_out`, and follows any `$result.outcome` edge. A run with no timeout recovery edge becomes terminal and releases its session reservation. Restart recovery starts this timeout path before it schedules other work.

The extension finds eligible workflow messages during `session_start`, after model turns settle, and once per second while the session is open. The same poll also establishes the one session subscription when initial server startup or connection fails. It keeps at most one connection attempt and one active subscription, so the open Pi session recovers without a restart and without duplicate coordinators. One `WorkflowMessageCoordinator` handles every message kind. After every server connection, it waits for the complete origin-session view and reports the active branch before it sends a workflow message or reports a model turn. The server view names the next eligible pending message only to the active coordinator epoch.

The coordinator waits until Pi is idle and has no queued user input, keeps the message ID in its in-memory queued map, and searches the active branch for that hidden ID. It reports a matching entry before any send. Otherwise, it rechecks synchronously that Pi is idle, has no pending input, the message is absent, and its connection still owns the active epoch. It calls documented `pi.sendMessage()` with no `await` between the final check and call. A poll can discover work, but it cannot send an ID already in the queued map.

After a send, the coordinator waits for the matching Pi entry and reports the active branch so the server records its entry ID and marks the message `sent`. Branch evidence marks a matching message `sent` even if its source cancelled it after the send. If Pi emits `agent_start` before that report or before the session view loads, the coordinator buffers the start and matching end, records the message first, and then reports the turn events in order.

The server alone decides whether that Pi model turn belongs to the workflow message. `workflowTurn.report` returns a version-1 receipt with `active`, `settled`, or `absent` ownership and the exact saved turn when one exists. The extension exposes workflow activity and starts session capture only after an `active` receipt. It clears its temporary copy after settlement, rejection, or disconnect. Every new Pi `agent_start` replaces any older local copy and requires fresh server acceptance before the turn can become workflow work.

Turn start and end use the exact message, run, session, and turn IDs. A matching repeat adopts the saved result. A conflicting repeat remains an error. When a run becomes terminal, the same transaction ends its open turns as `lost` and cancels pending step and decision messages. Failure and cancellation also cancel pending follow-ups. A committed notification stays eligible for delivery. A late matching end report adopts that terminal cleanup. A terminal run cannot start another step turn, and a later ordinary Pi turn cannot inherit its old workflow ownership.

Active-branch absence is usable only when the branch has no matching ID, Pi is idle, and Pi has no pending messages. If Pi or the extension disappears after the send call but before inspection, the message stays `pending`. A replacement extension reports the branch before another send. The idle branch report settles an unproved open server turn as `lost`. Documented Pi APIs do not prove cross-branch absence or exactly-once model execution.

The extension subscribes to the active origin-session live run view and projects it into Pi's documented widget and status APIs. It never opens SQLite, runs workflow code, or derives a display status. `Shift+Up` and `Shift+Down` scroll the widget. When Herdr is available, the widget also shows `Ctrl+Shift+R piw`, and `/piw` remains the command fallback. Both actions open or focus the exact run from the same view.

A tool update or submission goes to the server. It includes the exact request, node, attempt, expected revision, and tool-call idempotency key. The server first checks this transport contract and records a provisional `validating` submission. It then schedules a supervised workflow child. Only that child loads workflow code and runs the node's `validate` function. The child reports `interaction.accepted` or `interaction.rejected` to the server. The server settles the request only after acceptance. A rejected payload leaves the same request pending and returns the stored actionable error to the model. If the child stops before it reports a result, the server rejects the provisional submission and leaves the request ready for a corrected retry.

An ordinary checkpoint accepts the model-facing `answer` action and starts a continuation run. A protected human decision never accepts that tool action. The extension displays the decision without starting a model turn, and a person answers it with `/workflow answer` through `decision.answer`. When a protected decision reaches its saved `onTimeout` deadline, the server takes a control claim on the waiting parent, atomically records the validated default, closes the pending interaction, releases the parent claim, and reserves the continuation. A human answer cannot win after that deadline.

The session keeps normal Pi entries for prompts, tools, and replies. Pi Workflows stores the public session entry ID used for presentation adoption. It does not edit the Pi session file or schema. A normal runner continuation leaves an active session capture open until the matching Pi turn ends. Only proved interruption can fail that capture; runner handoff alone cannot report that the server stopped.

One session sends one workflow message at a time. Messages keep acceptance order, but an earlier ineligible or cancelled message does not block unrelated eligible work. Source state and message kind decide eligibility. A reload clears only process-local queued state. `workflowMessage.reportBranch` adopts existing entries and closes lost turns. When a pending source has no entry on the active branch, it creates one message of that source's own kind: a step with reason `resumed` for an interaction, or a decision for a protected decision. Repeating a report or returning to a branch that already contains that source creates no new message.

A notify node creates a passive `notification` message in the same transaction as its node result. The final leaf of an interactive checkpoint-continuation chain creates one terminal message with its terminal outcome; parent runs settled by continuation do not. Initial, reminder, and resumed prompts are one `step` kind. Protected decisions and follow-ups use the same table and coordinator. Their feature records keep validation, authority, timeout, counters, and result state.

## Detached execution

A run with headless execution mode uses the existing `pi --mode rpc` integration for agent steps. The Pi child uses a separate process group registered with the server. The runner stops that group during normal completion. Cancellation gives the runner a bounded cleanup interval, and the server reaps the registered group if the runner exits first.

The headless child receives only the workflow step prompt, configured model arguments, and the bridge extension. Its submission uses the same step and attempt contract as origin-session work. A headless run cannot use a visible assistant-message step because it has no origin Pi session.

The run binding records `interactive` or `headless` execution mode. Viewers show that mode without exposing provider credentials.

## Pause and cancellation

An explicit pause command atomically commits `paused = 1` on the run, parks the queue, releases the exact claim, cancels pending step messages, and stores the command receipt. The fenced runner process group then stops. When Escape aborts an origin-session turn, the extension sends one `workflowTurn.report` end message with `stopReason: "aborted"`. The server atomically ends that exact activity, sets the run pause, derives the pending interaction as paused, and cancels its pending step messages. The extension does not send a second pause command. A parked interaction has no runner or live run claim. While its run is paused, updates, submissions, and decision answers are rejected. Resume clears the run pause; work for the same pending interaction continues in place, while other paused work takes a new generation and starts another runner from the last durable boundary. An uncommitted pure node can run again after resume.

Cancellation against a live runner atomically commits terminal cancellation, cancels pending attempt and interaction state, settles effect recovery state, releases the exact claim, and stores the command receipt. A pending effect becomes cancelled. An applying effect becomes ambiguous because the server cannot prove its external outcome. The server then stops the fenced runner process group. A server crash after the receipt cannot resume the cancelled run or retry the ambiguous effect. If the child does not stop by the deadline, the server kills its process group.

Cancellation against an expired running row first takes a new control claim. The claim operation must prove that the old lease is absent or expired. The new owner then cancels the active attempt, effect recovery state, and pending interaction or human decision in one lifecycle transaction.

A client cannot force-cancel a live claim through the stale recovery path.

## Recovery

At startup the server:

1. Takes the global server epoch.
2. Reaps runner records that match an exact stale process identity.
3. Finds expired running runs and active attempts.
4. Reads managed effect state before deciding whether work can repeat.
5. Parks uncertain effects for manual review.
6. Makes pure and fully settled work claimable.
7. Restores pending interactive requests, workflow messages, external-channel decisions, and scheduled resource manager work without changing Pi message or turn state.
8. Starts supervised timeout recovery for pending interactive requests only when their durable deadline expired during a reported model turn from an active connected session. A disconnect suspends the timer, and a new branch report resumes it without losing the prior active time. Message delivery, waiting, paused time, server downtime, and a closed Pi session do not consume the node timeout.
9. Resumes any remaining provisional `validating` submission in a new supervised child.
10. Waits for the extension's active-branch report before it confirms pending entries as sent, closes a turn as `lost`, or creates a branch-specific replacement. The extension sends this report after every server connection.
11. Starts no model turn until a matching Pi session connects or headless mode is declared.

Recovery resumes from the last committed boundary. An uncommitted compute node may run again because compute is pure. An action with a stored effect receipt adopts that receipt. An effect in `ambiguous` state requires explicit recovery.

Claim loss is a handoff, not a run failure. The old owner writes no terminal event after claim loss.

## Effects and retry safety

Compute nodes must not perform external side effects. They can repeat after a runner crash.

Side-effecting action and shell behavior must have one of these contracts:

- a managed effect with an external idempotency key;
- a managed effect with a read-back check that proves whether it applied;
- an explicit non-resumable result that becomes `ambiguous` after an uncertain crash.

The server reserves an effect before execution. The engine creates the idempotency key from the run ID, effect type, full compiled node path, and node visit number. Workflow code provides the effect type and request, but it does not provide this internal key. Included workflows can use the same local node name without sharing a key. The request fingerprint prevents key reuse with another payload.

An applied, rejected, or cancelled effect is terminal. An ambiguous effect is also terminal for automatic retry. An operator may use a separate reviewed recovery action after inspecting the external system.

## Resource managers

The global server also reconciles managed resources. Resource managers keep their existing resource claims, queue, effects, and child workflow request keys.

A resource manager child run enters the same global run queue and runner process model. It does not need an origin Pi session unless its workflow declares an interactive step. A headless child uses the declared provider path. A child that needs an origin session parks with a clear unsupported-input result unless the resource manager supplied an approved session binding.

Resource manager reconcile code runs in a supervised resource runner, not in the server event loop. Resource manager initialization also runs in a source resolver child. Before `resourceManager.apply` commits, the server checks that the resolved source still matches resource manager discovery rules and the exact source digest.

## Failure classification

Use separate states and messages for these failures:

- `claimLost`: another generation owns the run, or the claim expired.
- `workerCrashed`: the child exited without a terminal protocol message after it saved progress.
- `runnerNoProgress`: the child exited before the saved run revision advanced and needs explicit resume or cancellation.
- `workerTimedOut`: the child exceeded a declared deadline.
- `hostUnavailable`: the client cannot reach or start the server.
- `sourceChanged`: the workflow source does not match the saved identity.
- `effectAmbiguous`: an external action may have applied without a receipt.
- `nodeFailed`: workflow code returned a normal failure.
- `protocolRejected`: a message failed schema, revision, attempt, or idempotency checks.

A failure in one class must not be reported as another. In particular, claim loss does not create a failed run event.

## Status and privacy

`pi-workflows server status` reports:

- server state and epoch;
- socket availability;
- active runner count;
- queued, running, parked, and waiting counts;
- expired claim count;
- pending interaction count;
- ambiguous effect count.

It does not print actor IDs, session IDs, project paths, prompts, outputs, payloads, claim tokens, environment variables, or credentials.

Logs use bounded safe errors. Child stdout and stderr may contain private content and stay in the user-only workflow state directory. Public issue and pull-request text must use generic fixtures and no operator-specific identifiers.

## Alpha state policy

This feature changes the current schema in place while the project is in alpha.

Keep `pi-workflows-state` and schema version 1. Change the DDL digest and current contracts directly. Add no compatibility reader, migration shim, dual read, dual write, alias, feature flag, or parallel state root.

When the installed state has the old digest, fail before mutation with the standard backup and reset instruction. Leave the old database untouched.

## Pi API impact

- **Session state:** Pi appends normal messages and tool results. Pi Workflows does not edit session files.
- **Other persistent data:** The workflow SQLite shape changes in place and older alpha state requires reset.
- **Pi internals:** None.
- **Public API:** The extension uses documented command and shortcut registration, tool registration, session lifecycle events, message sending, widgets, status, and session IDs.
- **Client protocol:** All live clients use `pi-workflows.client.v1`. There is no compatibility transport or direct live-state fallback.

## Conformance

The implementation conforms when:

- every protected write checks and renews one live claim atomically;
- an expired or replaced owner cannot write;
- a blocked runner cannot stop server renewal;
- Pi can restart while work computes or waits;
- an open Pi session reconnects after initial server startup or connection fails;
- the server can restart and recover from committed state;
- run, queue, attempt, decision, lease, event, and viewer projections remain consistent after injected crashes;
- an expired running row can be resumed or cancelled safely;
- duplicate commands and submissions return stored receipts;
- an interactive request appears once in the origin session and survives reload;
- every workflow-message kind uses one active coordinator epoch, active-branch report, and turn-report contract;
- initial, reminder, and resumed prompts use one step-message kind and one request counter;
- a busy Pi session with a pending message does not queue duplicate messages or model turns;
- two Pi processes cannot send for one origin session because only one coordinator epoch is active;
- active-branch absence requires no hidden message ID, an idle Pi session, and no pending Pi messages;
- every server connection reports the active branch before any workflow-message send or turn report;
- a crash after send leaves the message pending until branch evidence adopts it;
- active-branch evidence changes a matching pending or cancelled message to sent;
- server restart alone never closes an active Pi turn as `lost`;
- a branch change creates at most one source-kind message when that source has no entry on the active branch;
- a partial unique index allows at most one pending step message for each interactive request;
- pause is stored once on the run and derived for its interaction;
- resuming an aborted submitted-output step creates one new resumed message and one fresh origin-session model turn;
- pausing and resuming a protected decision does not invalidate its answer revision or create a duplicate decision message;
- follow-ups wait for the final continuation outcome, its terminal turn, earlier follow-ups, and release of the origin-session reservation;
- only the final leaf in a checkpoint continuation chain receives a terminal workflow message;
- effects are deduplicated or marked ambiguous;
- external channel delivery and settlement use the same managed-effect and attempt records;
- a channel child is transport-only and cannot open SQLite, load workflow code, or change run state;
- a stale adapter epoch or attempt cannot settle newer channel work;
- an interrupted exact in-flight channel attempt becomes ambiguous and is never retried without explicit recovery;
- explicit confirmation records observed success, while explicit retry creates a new attempt and warns about possible duplication;
- the extension and server run no workflow or resource manager code in their own event loops;
- the production package contains no embedded execution fallback;
- the server is the only production process that opens live SQLite state;
- the widget, status line, Herdr actions, CLI, and `piw` render the same server-produced status and controls;
- running and waiting projections identify the current workflow node from the same unfinished attempt, while checkpoint waits use the completed checkpoint node;
- an exact origin-session model turn presents that same waiting node as running without changing its durable identity;
- a busy origin session displays `running` for the full exact workflow turn, including a terminal or pausing turn, and a stale turn-end report cannot clear newer activity;
- normal runner continuation does not fail an active Pi session capture or report a false server interruption;
- `paused` appears only after a durable pause and matching turn end;
- a terminal run remains in the origin-session view while its terminal message is pending or its first turn is open, and then for 60 seconds after that turn ends, without retaining execution authority;
- a TypeScript-created live database is viewable by the matching Rust `piw` through the client protocol without a duplicated SQLite digest;
- no removed server, replay, or direct SQLite client path remains selectable;
- real Pi end-to-end tests, repository checks, reviewer checks, and CI pass.
