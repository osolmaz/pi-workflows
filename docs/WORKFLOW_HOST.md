# Workflow host

Status: implemented. The out-of-process host, unified live workflow client, session delivery, widget, Herdr controls, and client-only `piw` viewer are one production path. [Run workflows outside Pi](2026-08-30-out-of-process-workflow-host-plan.md), [restore workflow session delivery and controls](2026-09-01-restore-session-delivery-controls-plan.md), and [unify live workflow clients](2026-09-01-unified-workflow-client-plan.md) record the approved redesigns.

## Purpose

The workflow host keeps durable workflow state correct when Pi, a workflow, or the host stops unexpectedly. It owns the workflow database and supervises a separate process for each active run. Pi remains the user interface and performs interactive model turns through its documented extension APIs.

The host solves two different failures:

- A busy workflow cannot block the process that renews run claims.
- A crashed or stale runner cannot leave contradictory state or continue writing after another runner takes over.

## Terms

- **Host:** The single user-level process that owns workflow state, claims, commands, and worker supervision.
- **Client:** A Pi extension instance or command-line process connected to the host.
- **Worker:** A child process that loads one workflow and executes one active run generation.
- **Origin session:** The Pi session that started an interactive run.
- **Claim:** A time-limited right to change one run.
- **Generation:** A number increased each time a new owner claims a run. It fences older owners.
- **Durable boundary:** A committed node or lifecycle transition from which execution can resume.
- **Interactive request:** A durable agent or assistant-message step that must run in the origin Pi session.
- **Managed effect:** A side effect reserved and settled through an idempotent durable record.
- **Live run view:** The host's versioned, bounded projection of one run, including its durable state, current origin-session activity, allowed controls, and page cursors.
- **Renderer:** A Pi widget, status line, command-line view, Herdr adapter, or `piw` screen that displays or acts on a live run view without deriving workflow state.

## Boundaries

The host belongs to the `@osolmaz/pi-workflows` package. It uses the existing SQLite database at `~/.pi/agent/workflows/state.sqlite` and documented Pi extension APIs.

The design does not change Pi source, Pi session files, Pi message schemas, or private Pi APIs. It does not add a remote service or a second database. The package does not install an operating-system service.

SQLite remains local to one machine. The protocol does not provide distributed consensus or network-filesystem safety.

## Process model

One host owns the global workflow database for one user installation.

```text
Pi extension ─┐
CLI client ───┼── WorkflowClient v1 ── local socket ── workflow host ── SQLite
piw ──────────┘                                              │
                                                             ├── run worker A
Remote piw ── SSH tunnel ── loopback WebSocket relay ────────┤
                                                             ├── run worker B ── headless pi --mode rpc
                                                             ├── controller worker
                                                             └── source resolver
```

The local socket and loopback WebSocket relay carry the same logical client protocol and live run view. The relay reads no state and translates no domain contract. The host is the only production process that opens the live SQLite database. The worker and source-resolver channels are private supervision protocols, not alternate client interfaces.

The host may manage runs from more than one project. Each run keeps its canonical project path and source identity.

The host process performs only bounded protocol handling, live-view projection, short SQLite transactions, timers, queue scheduling, and process supervision. It does not import or execute workflow definitions.

A worker loads one workflow source and executes one run generation. It cannot receive a writable `WorkflowRunStore`. It proposes changes to the host over a private child channel. This is an architectural guard against accidental writes. It is not a security sandbox against code running as the same operating-system user.

## Host lifecycle

The package CLI owns host lifecycle commands:

```text
pi-workflows host start
pi-workflows host status
pi-workflows host stop
pi-workflows host run
```

`run` stays attached for direct operation and tests. `start` starts the package process on demand and waits for a ready handshake. It does not install systemd, launchd, or another persistent service.

The host uses one global lock and one host epoch. Socket creation and the SQLite host claim must agree before the host accepts commands. A second live host refuses to start. After the old host lease expires, a new host increases the epoch before it handles work. Messages from an older epoch are rejected.

The host stays alive while it has a connected client, an active worker, a scheduled wake, a pending controller, or unsettled work. An idle host may exit after a documented idle period. A later client can start it again.

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

The host also renews active claims from a timer. The timer is a backup for a run with no state writes. Normal write correctness does not depend on the timer.

Claim rejection uses `ClaimLostError` with one internal reason:

- `missingAuthority`
- `expired`
- `ownerChanged`
- `tokenChanged`
- `generationChanged`

Logs may show the run ID, generation, and reason. They must not show a raw token or token hash.

## Run lifecycle

The run and queue projections follow these states:

| Run state   | Queue state | Claim | Worker   | Meaning                                                 |
| ----------- | ----------- | ----- | -------- | ------------------------------------------------------- |
| `queued`    | `queued`    | none  | none     | Ready for host scheduling.                              |
| `running`   | `starting`  | host  | starting | A worker launch is being recorded.                      |
| `running`   | `running`   | host  | live     | A worker is executing one node.                         |
| `running`   | `parked`    | none  | none     | Execution stopped at a durable boundary and can resume. |
| `waiting`   | `parked`    | none  | none     | A checkpoint or interactive request needs input.        |
| `completed` | `done`      | none  | none     | The run finished successfully.                          |
| `failed`    | `failed`    | none  | none     | The run failed with a durable error.                    |
| `timed_out` | `failed`    | none  | none     | The run exceeded a declared timeout.                    |
| `cancelled` | `cancelled` | none  | none     | Cancellation completed.                                 |

A lifecycle transaction updates the run, queue, attempt, decision, lease, event, and viewer facts that belong to one transition. The database must not commit a failed event while the run remains running, or a terminal queue row while the run remains nonterminal.

Waiting and paused work does not keep a worker or a live claim. Resume takes a new claim generation and starts a new worker from the last durable boundary.

## Worker lifecycle

A worker launch envelope contains:

```json
{
  "schema": "pi-workflows.worker-launch.v1",
  "runId": "run-id",
  "generation": 2,
  "workerEpoch": "opaque-id",
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

Before it loads workflow modules, the worker verifies the root identity and every saved mounted file hash or built-in revision. After loading, it also checks the complete mounted-source map against the saved map. A mismatch parks the run with `workflowSourceChanged`. The normal scheduler does not claim that run again. The operator can restore the recorded source and explicitly resume the run, or cancel it. Changed included code does not execute.

The host records a worker epoch before spawn. The child must return a ready message before the startup deadline. Every later child message includes the run ID, generation, and worker epoch.

The host records one terminal worker outcome:

- `exited`
- `cancelled`
- `timedOut`
- `crashed`
- `claimLost`
- `orphaned`

A worker exit is not automatically a run failure. The host decides from the last committed attempt and effect state whether it can resume, must park, or must fail.

## Process supervision

Each worker starts in its own process group. A headless Pi child starts in another process group so normal worker completion can stop all Pi tool descendants without signaling the worker itself. The worker registers that direct child with the host before it sends a prompt and unregisters it only after group shutdown. The host owns the one process registry and reaps a registered child if its worker exits first.

The host enforces:

- a startup handshake deadline;
- node deadlines already declared by the workflow engine;
- bounded protocol messages;
- bounded captured stdout and stderr;
- cancellation with `SIGTERM` and bounded `SIGKILL` escalation;
- process-group cleanup;
- orphan checks after host restart;
- portable memory or process limits where Node and the operating system support them.

The child protocol must apply backpressure. A child that exceeds message or output limits fails its worker epoch with a clear infrastructure reason. The complete durable workflow result stays in SQLite within the existing value limits.

The process registry includes a process start identity, not only a PID. The host accepts a worker registration only when the PID is a direct child of that active worker. A reused PID cannot let a new host kill an unrelated process.

## Live client protocol

Every production client uses one versioned `WorkflowClient` protocol. No extension, CLI command, Herdr adapter, or `piw` mode opens the live SQLite database. Clients connect through a user-only local socket. Unix socket mode is `0600`. Other platforms use their equivalent local transport and access control. Remote viewing uses a loopback-only WebSocket relay through an SSH tunnel. The relay carries the same messages and does not read SQLite.

The alpha hard cut replaces the existing host request and replay protocols in place with `pi-workflows.client.v1`. It adds no `v2`, compatibility path, fallback reader, or second live protocol. One neutral JSON schema is the wire-contract source for TypeScript and Rust. Shared conformance fixtures must pass in both languages.

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

The `type` is `hello`, `request`, `response`, or `event`. A response repeats the request ID and includes its outcome, revision, receipt, or bounded safe error. An event names its subscription and carries one revisioned run-list snapshot, run-view snapshot, patch, page, origin-session delivery change, or availability change. Valid command outcomes remain `accepted`, `adopted`, `rejected`, `conflict`, `notFound`, `claimLost`, and `unavailable`.

The host commits a command receipt before it acknowledges success. The request ID identifies one transport attempt and is excluded from the durable fingerprint. The Pi extension sends state-changing commands through the durable client path. If a connection closes after commit but before response, a retry uses a new request ID with the same client ID, idempotency key, operation, and payload, then adopts the stored receipt. Reusing a request ID or idempotency key with another durable payload returns a conflict. An `interaction.submit` response stays pending while the supervised child validates the value and settles only after the durable outcome is `accepted`, `adopted`, or `rejected`. A reconnect with the same durable identity and payload waits for and returns that same outcome. Clients do not poll SQLite for submission results.

View and subscription reads do not create receipts. Reconnection restores desired subscriptions from the last accepted presentation revision. A retained revision receives patches. A stale revision receives a bounded snapshot. A slow subscriber gets at most one socket-buffered snapshot at a time because the host waits for drain and coalesces later polls. A backpressured client write stops waiting when its connection closes, its socket fails, or its request is cancelled. Every explicit client unsubscribe removes the matching host subscription, including run-list and origin-session subscriptions.

The protocol owns four operation groups:

- run and controller commands, including start, pause, resume, cancel, answers, updates, submissions, reconciliation, and host control;
- live views, including lightweight run lists, one run snapshot, revision subscriptions, byte-bounded pages, chunked referenced content, and one consistent origin-session response with its active run view, ordered pending delivery records, and read-only delivery availability;
- origin-session activity reports for the exact workflow delivery being processed by Pi;
- state maintenance, including status, verification, backup, and prune against the active database. Backup and applied prune use one fresh CLI idempotency key per user invocation. An automatic reconnect retry keeps that key and uses a new request ID. A later invocation gets a new key. The host finishes an in-flight operation after a disconnect, stores its accepted or rejected receipt before response, waits for it during shutdown, and adopts an exact retry.

`notification.claim` and `turn.claim` can create a claim or revalidate the exact retained claim before delivery. Revalidation checks the in-memory client claim and its durable lease without creating another claim.

### Live run view

The host returns one canonical `pi-workflows.run-view.v1` document. It contains the existing bounded workflow projection and page cursors plus a `display` object. The queue field contains display metadata only. It does not repeat the input, launch options, worker affinity, or claim capability; the complete input remains reachable through the state projection. The `display` object contains the effective status, current activity kind, allowed controls, and the complete stored reason when action is required. Renderers use this object directly. They must not combine separate queries or infer status from durable rows.

Generated referenced content is stored directly in `run_view_content` under its exact run ID, content digest, and media type. It does not share general state-blob media metadata. A content read must match all three values, so a reference from another run or another media representation is unavailable.

The origin-session response contains this active run view or no active run plus an ordered byte-bounded window of pending delivery records, their complete count, and read-only notification and turn availability for that session. It does not retain an older terminal run after the session reservation ends. The records include the request, delivery, contract, revision, presentation entry, and claim facts required by the shared delivery coordinator. The host returns them from one consistent read. The extension materializes the complete active run revision and hydrates the definition and delivery contracts before it updates the widget or delivery coordinator. It issues a claim command only when the matching availability fact is true. Polling an idle session creates no durable command.

Each history page has both an item limit and an encoded byte budget. Oversized values become digest-bound content references. Large workflow topology uses bounded node, edge, graph-step, and transition projections plus references for the complete original definition and complete graph history. Before the host advertises a generated reference, it stores the bytes under the exact run ID, content digest, and media type in `run_view_content`. It does not share media metadata with general state blobs. Memory-cache eviction cannot make a reference unavailable. `view.content` returns bounded chunks until the client has the complete value. The client verifies the assembled bytes against both the response digest and the digest in the advertised reference. TypeScript clients assemble every run-history page for one revision and hydrate the complete definition, complete graph history, and all referenced content before they emit a complete non-interactive view or update the Pi widget. Rust automatically requests and verifies the complete referenced definition and graph history, decodes the complete values, and then builds its graph layout. Session-event pages include the replay checkpoint immediately before the first event in the page. A large checkpoint is also a referenced value. TypeScript hydrates it with the run view, and Rust requests and resolves it before replay. A step-centered trace page selects the exact stored attempt first and uses the node ID only if that attempt has no trace event. The run list reads only status facts and never loads complete run histories.

The closed `display.status` set is `queued`, `running`, `waiting`, `paused`, `completed`, `failed`, `timed_out`, `cancelled`, and `ambiguous`.

The host computes effective status in this order:

1. A durable ambiguous external effect that requires explicit review is `ambiguous`. An effect that is still applying under a live worker is not ambiguous.
2. Another durable terminal result keeps its terminal label.
3. A durable pause is `paused`.
4. A live supervised worker or an exact active origin-session workflow turn is `running`.
5. A pending interaction, decision, or presentation with no exact active turn is `waiting`.
6. Parked resumable work with no pending interaction is `queued`.
7. Admitted work that has not started is `queued`.

Host connection failure is the client condition `unavailable`, not a `display.status` value. `paused` is never inferred from a parked queue, pending interaction, stale cursor, or missing activity report.

### Origin-session activity

The Pi extension reports `started`, `settled`, and lease refreshes only for the exact workflow delivery that it can identify through documented Pi lifecycle events and its in-memory delivery map. The host requires the deterministic `interaction:<request-id>` delivery identity and keys activity by connection and request, not by an unchecked caller label. The first activity report on each client connection is `started`; only later reports on that connection are refreshes. Each report includes the origin session, run, request, delivery, client connection, and increasing activity sequence. The host validates these facts against the durable pending interactive request and its recorded delivery or presentation entry. Settlement of the presentation claim does not end activity while the model turn continues.

Activity is ephemeral display state. It cannot grant workflow authority, settle a request, change a durable run state, or survive as a claim. A repeated report is idempotent. A stale sequence, replaced delivery, or wrong session is rejected. One shared client constants module defines the refresh period and lease duration. The refresh period is shorter than the lease duration, and the lease duration bounds stale `running` display after client loss. The host clears activity on the matching settled event, client disconnect, or lease expiry. Missing activity falls back to the durable `waiting` view and never creates a false `paused` or `running` state.

### Renderers and controls

The Pi widget, Pi status line, `/piw`, `Ctrl+Shift+R`, Herdr placement adapter, CLI status output, and every local or remote `piw` screen consume the same live run view. The Pi extension subscribes by origin session and materializes the complete step history before it renders the widget. The Herdr adapter receives the exact run target from that view and owns only pane placement and focus. The TypeScript CLI and Rust TUI subscribe by run ID and use protocol pages and referenced content. Explicit `piw <runId>` mode keeps the requested run selected and does not replace it with the newest run-list item. They do not open live SQLite or compile or validate its DDL digest.

Local `piw` may start the host only by executing the installed `pi-workflows host start` command. It does not reimplement host lifecycle. A foreground TypeScript client keeps its cold-start retry timer referenced until the host is ready or the start deadline expires. It uses the package socket on Unix and the same package-derived named pipe as TypeScript on Windows. `piw serve` becomes a loopback WebSocket relay for the same client protocol. It opens one host socket connection for each WebSocket connection and couples their lifecycles one to one. It never multiplexes clients, translates state, or opens the database. A client that cannot start or reach the matching host fails with one clear unavailable or package-version error. It must not fall back to direct SQLite access.

## Worker protocol

The private worker channel accepts these message kinds:

- `worker.ready`
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
- `worker.progress`
- `worker.exiting`

Every worker message includes the worker launch schema, run ID, generation, worker epoch, attempt ID when applicable, expected revision, and a stable message ID. Headless workers use `process.register` and `process.unregister` operations under `worker.progress` to attach their Pi child group to host supervision. Registration requires the live run claim. Unregistration remains valid after a terminal state releases that claim so cleanup can finish.

The host checks the generation and epoch before it reads the payload. A stale worker gets one claim-loss response and must exit. The host stores receipts for accepted state-changing messages so a retry receives the same answer.

## Durable protocol records

Reuse current rows when they already own a fact:

- `runs`, `run_queue`, `leases`, and `events` own run lifecycle and claims.
- `node_attempts` owns node execution state and resolved wall-clock deadlines.
- `human_decisions` and resolution tables own checkpoints.
- `effects` and `effect_attempts` own side effects and ambiguous outcomes.
- `notifications` and `turn_intents` own passive and terminal Pi messages.
- `run_bindings` owns origin session and execution mode.

Add only these records if implementation proves the current rows cannot hold the contract:

### Host commands

`host_commands` stores request ID, client ID, operation, idempotency key, durable request fingerprint, run ID, accepted revision, outcome, receipt or error hash, and timestamps. The request ID is transport identity and is not part of the fingerprint. The request primary key prevents one request ID from naming two payloads. The client and idempotency-key uniqueness adopts the same durable payload across transport attempts.

### Interactive requests

`interactive_requests` stores request ID, run ID, attempt ID, target session ID, kind, contract hash, pending or settled status, accepted submission ID, and timestamps. One attempt has at most one request. The linked node attempt stores its resolved wall-clock deadline.

`interactive_submissions` stores request ID, submission ID, idempotency key, payload hash, validating, accepted, or rejected outcome, receipt hash, and submission time. Repeated keys return the same receipt.

### Worker epochs

`run_workers` stores run ID, generation, worker epoch, launch envelope hash, process identity, status, start time, ready time, finish time, exit code, signal, and bounded diagnostic hash. One run and generation can have several sequential worker epochs, but only one may be active.

These tables remain part of `pi-workflows-state` schema version 1. The DDL digest changes in place under the alpha policy.

## Interactive Pi execution

Agent and assistant-message steps for an interactive run execute in the origin Pi session.

The worker commits the node's resolved wall-clock deadline before it proposes `interaction.requested`. The host commits the request, changes the node attempt to waiting, parks the queue row, releases the claim, and acknowledges the worker. The worker then exits. The host continues to enforce the durable deadline while no worker exists. If the deadline passes, one control claim atomically closes the stale request and schedules a supervised timeout-resume child. The child preserves the same attempt and deadline, records `timed_out`, and follows any `$result.outcome` edge. A run with no timeout recovery edge becomes terminal and releases its session reservation. Restart recovery starts this timeout path before it schedules other work.

The extension finds pending requests during `session_start`, after `agent_settled`, and once per second while the session is open. One shared session-delivery coordinator handles step prompts, protected decisions, notifications, and terminal presentation turns. It waits until Pi is idle and has no pending messages before it claims new work. Because the host claim is asynchronous, it checks those conditions again immediately before the synchronous call to the documented `pi.sendMessage()` API. The coordinator remembers the claimed delivery before that final check. If Pi became busy, a later poll can send with that exact claim while its lease remains live. An expired unused claim is discarded. Polling cannot acquire a second claim or send a delivery that is already queued.

The host grants one live presentation claim. The current presenter cannot claim the same request again before that claim expires. A poll that sees any live presentation claim treats it as unavailable, not as a tool failure. When the matching custom message appears in the active Pi branch, the coordinator records its public session entry ID through the host and clears the local queued state. If Pi becomes idle without exposing a matching entry after the confirmation interval, the coordinator reports the delivery as ambiguous and keeps it blocked. A failed durable receipt also keeps the visible message blocked. Neither case can send the message again. The normal `workflow` tool contract then submits updates and results.

The extension subscribes to the active origin-session live run view and projects it into Pi's documented widget and status APIs. It never opens SQLite, runs workflow code, or derives a display status. `Shift+Up` and `Shift+Down` scroll the widget. When Herdr is available, the widget also shows `Ctrl+Shift+R piw`, and `/piw` remains the command fallback. Both actions open or focus the exact run from the same view.

A tool update or submission goes to the host. It includes the exact request, node, attempt, expected revision, and tool-call idempotency key. The host first checks this transport contract and records a provisional `validating` submission. It then schedules a supervised workflow child. Only that child loads workflow code and runs the node's `validate` function. The child reports `interaction.accepted` or `interaction.rejected` to the host. The host settles the request only after acceptance. A rejected payload leaves the same request pending and returns the stored actionable error to the model. If the child stops before it reports a result, the host rejects the provisional submission and leaves the request ready for a corrected retry.

An ordinary checkpoint accepts the model-facing `answer` action and starts a continuation run. A protected human decision never accepts that tool action. The extension displays the decision without starting a model turn, and a person answers it with `/workflow answer` through `decision.answer`. When a protected decision reaches its saved `onTimeout` deadline, the host takes a control claim on the waiting parent, atomically records the validated default, closes the pending interaction, releases the parent claim, and reserves the continuation. A human answer cannot win after that deadline.

The session keeps normal Pi entries for prompts, tools, and replies. Pi Workflows stores the public session entry ID used for presentation adoption. It does not edit the Pi session file or schema.

One session delivers one host-owned message at a time. Other requests remain ordered by creation time. A reload or restart clears only the process-local queued state. The new extension instance scans the active Pi branch first, adopts an existing entry, and sends only when no matching entry exists and a new claim is available. It never retries only because a poll interval or claim lease elapsed.

Notify nodes enqueue passive messages in the existing `notifications` outbox. The shared coordinator claims a message through the host, adopts an existing session entry after a crash, and marks delivery through the host. A completed run with a root `presentationPrompt` creates an ineligible `turn_intent` before the terminal commit. The same terminal transaction makes that intent eligible. The coordinator claims it, starts one normal Pi turn while Pi is idle, and records the public session entry ID. No completion turn starts before the completed state is durable.

## Detached execution

A run with headless execution mode uses the existing `pi --mode rpc` integration for agent steps. The Pi child uses a separate process group registered with the host. The worker stops that group during normal completion. Cancellation gives the worker a bounded cleanup interval, and the host reaps the registered group if the worker exits first.

The headless child receives only the workflow step prompt, configured model arguments, and the bridge extension. Its submission uses the same step and attempt contract as origin-session work. A headless run cannot use a visible assistant-message step because it has no origin Pi session.

The run binding records `interactive` or `headless` execution mode. Viewers show that mode without exposing provider credentials.

## Pause and cancellation

Pause atomically commits `paused = 1`, parks the queue, releases the exact claim, and stores the command receipt. The fenced worker process group then stops. If a Pi model turn ends while the public extension context signal is aborted, or with public stop reason `aborted`, the extension sends this same host pause command only when that `agent_end` event contains the pending interaction's workflow prompt. A parked interaction has no worker or live run claim, so the host marks it paused in place. While paused, updates, submissions, and decision answers are rejected. Resume clears the pause on that same pending interaction; other paused work takes a new generation and starts another worker from the last durable boundary. An uncommitted pure node can run again after resume.

Cancellation against a live worker atomically commits terminal cancellation, cancels pending attempt and interaction state, settles effect recovery state, releases the exact claim, and stores the command receipt. A pending effect becomes cancelled. An applying effect becomes ambiguous because the host cannot prove its external outcome. The host then stops the fenced worker process group. A host crash after the receipt cannot resume the cancelled run or retry the ambiguous effect. If the child does not stop by the deadline, the host kills its process group.

Cancellation against an expired running row first takes a new control claim. The claim operation must prove that the old lease is absent or expired. The new owner then cancels the active attempt, effect recovery state, and pending interaction or human decision in one lifecycle transaction.

A client cannot force-cancel a live claim through the stale recovery path.

## Recovery

At startup the host:

1. Takes the global host epoch.
2. Reaps worker records that match an exact stale process identity.
3. Finds expired running runs and active attempts.
4. Reads managed effect state before deciding whether work can repeat.
5. Parks uncertain effects for manual review.
6. Makes pure and fully settled work claimable.
7. Restores pending interactive requests and scheduled controller work.
8. Starts supervised timeout recovery for pending interactive requests whose durable node deadlines expired.
9. Resumes any remaining provisional `validating` submission in a new supervised child.
10. Starts no model turn until a matching Pi session connects or headless mode is declared.

Recovery resumes from the last committed boundary. An uncommitted compute node may run again because compute is pure. An action with a stored effect receipt adopts that receipt. An effect in `ambiguous` state requires explicit recovery.

Claim loss is a handoff, not a run failure. The old owner writes no terminal event after claim loss.

## Effects and retry safety

Compute nodes must not perform external side effects. They can repeat after a worker crash.

Side-effecting action and shell behavior must have one of these contracts:

- a managed effect with an external idempotency key;
- a managed effect with a read-back check that proves whether it applied;
- an explicit non-resumable result that becomes `ambiguous` after an uncertain crash.

The host reserves an effect before execution. The effect key includes the source resource, effect type, and author-provided idempotency key. The request fingerprint prevents key reuse with another payload.

An applied, rejected, or cancelled effect is terminal. An ambiguous effect is also terminal for automatic retry. An operator may use a separate reviewed recovery action after inspecting the external system.

## Controllers

The global host also reconciles controllers. Controllers keep their existing resource claims, queue, effects, and child workflow request keys.

A controller child run enters the same global run queue and worker process model. It does not need an origin Pi session unless its workflow declares an interactive step. A headless child uses the declared provider path. A child that needs an origin session parks with a clear unsupported-input result unless the controller supplied an approved session binding.

Controller reconcile code runs in a supervised controller worker, not in the host event loop. Controller initialization also runs in a source resolver child. Before `controller.apply` commits, the host checks that the resolved source still matches controller discovery rules and the exact source digest.

## Failure classification

Use separate states and messages for these failures:

- `claimLost`: another generation owns the run, or the claim expired.
- `workerCrashed`: the child exited without a terminal protocol message.
- `workerTimedOut`: the child exceeded a declared deadline.
- `hostUnavailable`: the client cannot reach or start the host.
- `sourceChanged`: the workflow source does not match the saved identity.
- `effectAmbiguous`: an external action may have applied without a receipt.
- `nodeFailed`: workflow code returned a normal failure.
- `protocolRejected`: a message failed schema, revision, attempt, or idempotency checks.

A failure in one class must not be reported as another. In particular, claim loss does not create a failed run event.

## Status and privacy

`pi-workflows host status` reports:

- host state and epoch;
- socket availability;
- active worker count;
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
- a blocked worker cannot stop host renewal;
- Pi can restart while work computes or waits;
- the host can restart and recover from committed state;
- run, queue, attempt, decision, lease, event, and viewer projections remain consistent after injected crashes;
- an expired running row can be resumed or cancelled safely;
- duplicate commands and submissions return stored receipts;
- an interactive request appears once in the origin session and survives reload;
- a busy Pi session held longer than both delivery leases does not queue duplicate messages or model turns;
- effects are deduplicated or marked ambiguous;
- the extension and host run no workflow or controller code in their own event loops;
- the production package contains no embedded execution fallback;
- the host is the only production process that opens live SQLite state;
- the widget, status line, Herdr actions, CLI, and `piw` render the same host-produced status and controls;
- a busy origin session displays `running` only while its exact workflow turn is active, and `paused` appears only after a durable pause;
- a TypeScript-created live database is viewable by the matching Rust `piw` through the client protocol without a duplicated SQLite digest;
- no removed host, replay, or direct SQLite client path remains selectable;
- real Pi end-to-end tests, repository checks, reviewer checks, and CI pass.
