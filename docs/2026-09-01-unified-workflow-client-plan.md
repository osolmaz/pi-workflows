---
title: Unify live workflow clients
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-01
status: implemented
---

# Unify live workflow clients

## Follow-up

The single host, client protocol, and run view remain the correct base. Version 0.16.0 still uses a short activity lease, clears terminal session display too soon, and did not preserve all session features during the cut. [Unify workflow messages and restore hosted behavior](2026-09-02-unify-workflow-messages-plan.md) is the approved follow-up. It replaces the activity lease with Pi turn events and gives all Pi-bound workflow content one shared message path.

## Goal

Give every live Pi Workflows interface one source of truth.

One package-owned host will own live SQLite state and produce one versioned run view. The Pi widget, status line, workflow controls, Herdr actions, CLI, and Rust `piw` viewer will use the same client protocol and the same run view. No production client will read or interpret live SQLite state.

This is one client design, not three separate repairs:

```text
one host + one WorkflowClient v1 protocol + one run view + several renderers
```

The change is an alpha hard cut. It replaces the split live client paths and removes the old paths in the same change.

## User-visible failures

Three failures exposed the split design.

- The Pi workflow widget showed a pause icon and `[waiting]` while the origin Pi session was actively processing the workflow turn.
- The widget no longer showed the Herdr viewer action. `Ctrl+Shift+R` and `/piw` were not wired after the out-of-process cut.
- A matching installed `piw` rejected a live database that the TypeScript host accepted because Rust contained an older copied application version and DDL digest.

These are not independent display defects. The extension, Herdr integration, and Rust viewer use separate live-state paths and separate status logic.

## Root cause

`WorkflowClient` is the authority for commands, but it is not the authority for live views.

The Pi extension opens SQLite twice during one refresh. It first finds the origin session reservation and then loads the run from a second database snapshot. It maps durable workflow state directly to a widget label. The host cannot add exact origin-session model activity to that result.

The Herdr adapter still exists, but the extension no longer connects it to the active workflow view or registers its shortcut and command.

The Rust viewer opens the live database directly. It therefore copies TypeScript-owned SQLite identity facts and can drift from the package that writes the database. Its separate replay protocol is also another live interface.

Polling frequency cannot fix these ownership errors. A longer lease or another SQLite compatibility check would preserve the split design.

## Public Pi API feasibility

The documented Pi extension API provides the required boundary:

- session identity and lifecycle events;
- exact custom-message delivery through `pi.sendMessage()`;
- agent start, end, and settled events;
- command and shortcut registration;
- widget and status updates;
- the existing workflow tool and extension execution context.

The extension can associate its own delivered workflow message with the matching origin-session model turn. It can report that activity to the host without changing Pi core, reading private state, or changing Pi session files. No required public capability is missing.

## Boundaries

### In scope

- Replace the current host request, direct SQLite view, and replay client paths with one versioned live client protocol.
- Make the host the only production process that opens the active SQLite database.
- Add one host-produced live run view with one effective display status and allowed controls.
- Add exact, ephemeral origin-session workflow-turn activity reports.
- Restore the widget, status line, `/piw`, `Ctrl+Shift+R`, and the Herdr placement chooser from the same run view.
- Make local and remote `piw` use the same host protocol and projection.
- Move active database status, verification, backup, and prune commands through the host.
- Remove duplicated SQLite identity constants and all selectable direct live-state readers.
- Add unit, integration, Rust, real Pi, and Herdr tests.
- Update documentation to match the implementation.

### Out of scope

- Pi core, private Pi APIs, Pi session schemas, or Pi session file edits.
- Another repository or an external service.
- A second database, cache database, state bridge, or operating-system service.
- A second production workflow runtime.
- A compatibility reader, protocol fallback, schema `v2`, migration, dual read, dual write, alias, or feature flag.
- A claim of exactly-once behavior for an external effect that cannot prove its result.
- Release or package publication as part of this documentation change.

## Selected design

### One live client protocol

Replace `pi-workflows.host-request.v1`, `pi-workflows.host-response.v1`, and `pi-workflows.replay.v1` with one logical protocol named `pi-workflows.client.v1`.

The protocol has one envelope with four message types:

- `hello` identifies the protocol and package version;
- `request` asks for a command, view, page, subscription, activity change, or maintenance action;
- `response` settles one request;
- `event` carries a revisioned list, snapshot, patch, page, origin-session delivery change, or availability change.

An `interaction.submit` request stays open while the supervised child validates the submitted value. Its one response settles only after the durable submission becomes `accepted`, `adopted`, or `rejected`. If the connection fails, repeating the same request ID and payload waits for and returns the same durable outcome. A local tool abort stops waiting without cancelling the host command. A later retry uses a new transport request ID with the same durable idempotency and submission IDs, so a late response cannot settle the retry. Clients do not poll SQLite for validation results.

Use newline-delimited canonical JSON on the user-only local socket. Use one canonical JSON object per message on the loopback WebSocket transport. Both transports carry the same fields and semantics. TypeScript and Rust use the same ECMAScript number formatting and UTF-16 object-key order. Both parsers reject unknown envelope fields and non-canonical framing. A validation failure closes only the offending connection.

Create one neutral wire schema at `protocol/client.v1.schema.json`. TypeScript and Rust parsers must validate against that contract and the same accepted and rejected fixture corpus. Neither language owns a private variant.

The private worker and source-resolver channels stay separate because they are internal supervision boundaries. They are not selectable user clients and do not expose live views.

### One WorkflowClient abstraction

Move the public client boundary to `src/client/`.

`WorkflowClient` owns:

- on-demand host startup and connection without a durable status probe;
- explicit status requests when a caller asks for host status;
- verified chunk reads and content-reference hydration;
- one persistent connection per client process;
- request IDs, idempotency keys, and command receipts;
- desired run-list, origin-session, and run subscriptions;
- reconnect and revision resume;
- bounded snapshot recovery when a cursor is stale or a client falls behind;
- repeatable page navigation, including returning to a previously viewed cursor;
- protocol and package-version rejection;
- sanitized unavailable and not-found errors, including closed-socket backpressure waits.

The Pi extension and TypeScript CLI use this implementation. Rust implements the same wire contract in `tui/src/client.rs` and proves parity with the shared fixtures. Rust does not import TypeScript and does not know the SQLite schema digest.

### One live run view

The host produces `pi-workflows.run-view.v1` from one consistent host-side read. It includes:

- the current bounded workflow, graph, attempt, trace, and session projection;
- presentation revision and page cursors;
- live and interruption facts;
- a `display` object with effective status, activity kind, allowed controls, and either the complete inline reason or a small notice plus a digest-bound `reasonContent` reference.

The run-list row contains the same `display` object. The origin-session response contains the complete active run view or no active run plus an ordered byte-bounded window of workflow messages and their complete count. The approved follow-up also retains the newest terminal run for its bounded display period. Message records include the source, content reference, order, send state, and Pi entry needed by the shared coordinator. The host returns this session response from one consistent read. A client does not resolve a reservation, load a run, or inspect message tables in separate reads.

Large history remains available through byte-bounded pages. The host counts histories and reads only the selected SQLite ranges. A page has an item limit and an encoded byte budget. It echoes the requested cursor and run-view revision, and a client rejects a response that no longer matches its request or current snapshot. Large workflow topology has bounded node, edge, graph-step, and transition projections plus durable references to the complete original definition and complete graph history. TypeScript clients assemble every run-history page for one revision and hydrate the complete definition. Values that do not fit inline use digest-bound opaque content references, and `view.content` returns the complete value in verified chunks before a TypeScript non-interactive viewer emits the complete run or the extension updates its widget. TypeScript and Rust load the complete graph steps and transitions through the same verified content interface. Rust also requests and verifies the complete referenced workflow definition, decodes only the complete value, and then builds the graph layout. Session-event pages include the replay checkpoint immediately before their first event. A large checkpoint uses the same content protocol. TypeScript hydrates it with the run view, and Rust requests and resolves it before replay. The complete logical result remains available. The client protocol does not add an arbitrary user-visible truncation.

The run list is also byte-bounded and revision-bound. It contains only lightweight status and source facts. TypeScript and Rust clients assemble every page for one revision before replacing the visible complete list. An unchanged subscription performs a lightweight revision check and reuses its prior result.

The origin-session response also contains read-only notification and turn availability. The shared delivery coordinator issues a claim only when the matching fact is true. A claimed terminal turn loads its exact run by ID instead of using the latest run in the session. Its idle poll does not write an empty claim or host-status command.

### One status reducer

Only the host computes the effective display status.

The closed `display.status` set is `queued`, `running`, `waiting`, `paused`, `completed`, `failed`, `timed_out`, `cancelled`, and `ambiguous`.

Use this precedence:

1. A durable ambiguous external effect that requires explicit review is `ambiguous`. An effect that is still applying under a live worker is not ambiguous.
2. Another durable terminal result keeps its `completed`, `failed`, `timed_out`, or `cancelled` label.
3. A durable pause is `paused`.
4. A live supervised worker or an exact active origin-session workflow turn is `running`.
5. A pending interaction, decision, or presentation with no exact active turn is `waiting`.
6. Parked resumable work with no pending interaction is `queued`.
7. Admitted work that has not started is `queued`.

Transport failure is the client condition `unavailable`. It is not a `display.status` value and must not appear as `waiting` or `paused`.

A parked queue is not enough to display `paused`. Only the durable pause flag permits that label and icon. A renderer does not inspect workflow rows to override the host result.

### Exact origin-session activity

The Pi extension already owns the delivery map that links a workflow delivery to the visible custom message. Extend that coordinator to report activity for only that exact delivery.

A report contains:

- origin session ID;
- run ID;
- request ID;
- delivery ID;
- client connection ID;
- increasing activity sequence;
- state `started`, `refresh`, or `settled`.

The host accepts activity only when the durable pending interactive request and its recorded delivery or presentation entry match the session, run, request, and delivery. Presentation-claim settlement does not end the request, so valid activity can continue while the model turn runs. Repeated reports are idempotent. A stale sequence, replaced delivery, or wrong session is rejected.

The host keeps activity in memory with a short renewable lease tied to the client connection. The first report on each connection is `started`; only later reports on that same connection are refreshes. One constants module under `src/client/` owns both the refresh period and lease duration. The refresh period must be shorter than the lease duration, and the lease duration must bound how long a dead client can leave a false `running` display. The host clears activity on the matching settled event, connection loss, or lease expiry. A missing report falls back to durable `waiting`. It never creates a false `paused` or `running` state.

Activity is display evidence only. The host requires the deterministic `interaction:<request-id>` delivery ID and keys one overlay by connection and request. A caller-supplied alternate label cannot create a second overlay. Activity cannot renew a run claim, settle an interaction, change a workflow state, or authorize a control command. Durable workflow correctness does not depend on it.

### One renderer input

The Pi extension subscribes to the active run view for its origin session. It gives that same immutable view to:

- the widget renderer;
- the status-line renderer;
- the Escape-to-pause matcher;
- the `/piw` command;
- the `Ctrl+Shift+R` shortcut;
- the Herdr placement and focus adapter.

The Herdr adapter owns only Herdr capability checks, pane placement, labels, focus, and cleanup. It receives the exact run ID and workflow name from the run view. It does not query workflow state.

The widget shows the Herdr hint only when the documented Herdr capability check succeeds. The command remains available as a fallback and reports a bounded reason when Herdr or `piw` is unavailable.

### One live `piw` source

Local `piw` connects to the package-owned host, subscribes to run views, and fetches pages through `pi-workflows.client.v1`. When the socket is absent, Rust may start the host only by executing the installed `pi-workflows server start` command. Rust does not reimplement host launch, locking, epochs, or readiness. If that command is unavailable or fails, `piw` stops with the direct install or startup instruction.

`piw serve` stops reading SQLite. It becomes a loopback-only WebSocket relay for the same logical protocol. Remote clients continue to use an SSH tunnel. The relay opens one host socket connection for each WebSocket connection and couples their lifecycles one to one. It carries frames only. It does not multiplex clients, translate run state, keep another projection, or retain activity after either side closes.

Remove the selectable local SQLite source and the copied TypeScript application version and DDL digest from Rust. The Rust viewer has no SQLite mode, including for backups. If the host and viewer protocol do not match, `piw` stops with one direct package-version instruction. It must not suggest deleting live state and must not fall back to SQLite.

Only `pi-workflows state verify` may open an operator-selected inactive backup in query-only mode. That TypeScript maintenance path cannot select the active state path and is not part of the Rust viewer.

## Contract changes

This is an alpha hard replacement.

- Keep persisted `pi-workflows-state` at version 1.
- Do not change the SQLite schema unless implementation proves that the host view needs a durable field. The activity overlay needs no durable field.
- Replace the current live wire contracts with `pi-workflows.client.v1` in place.
- Keep the run-view schema at version 1 and change its fields in place.
- Extend the version-1 `host_commands` operation set in place so backup and prune receipts are durable.
- Exclude transport request IDs from durable request fingerprints. Keep every other command field in the durable identity.
- Remove direct live SQLite access from the Pi extension, TypeScript viewer paths, replay server, Rust viewer, and active-state maintenance CLI.
- Remove the old replay protocol and all production fallback selection.
- Keep old incompatible state untouched and use the standard backup-and-reset instruction only when the SQLite digest itself is incompatible.
- A client protocol mismatch must ask for matching packages. It must not misreport a valid database as incompatible.

No migration, compatibility reader, dual protocol, bridge period, or feature flag is permitted.

## Implementation plan

### 1. Define the neutral client contract

**Location:** `protocol/client.v1.schema.json`, shared protocol fixtures, `src/client/protocol.ts`, and `tui/src/protocol.rs`.

**Change:** Define the one envelope, operation names, outcomes, subscriptions, run-view snapshots, patches, pages, activity reports, maintenance requests, safe errors, and protocol handshake. Keep foreground host-start retry timers referenced until success or timeout; unreference only background reconnect timers. End a backpressured write wait on connection close, socket error, or request cancellation. Replace the host and replay schema identifiers. Add one accepted and rejected fixture corpus used by TypeScript and Rust.

**Verification:** TypeScript and Rust accept every valid fixture, reject every invalid fixture, and serialize the same canonical messages. No old live protocol identifier remains in production code.

### 2. Make the host the only live database reader

**Location:** `src/server/`, `src/state/`, controller stores, and state maintenance commands.

**Change:** Add host handlers for atomic origin-session view lookup, run-list and run-view snapshots, revision subscriptions, bounded pages, and active database maintenance. Keep projection reads and writes in the host. A view read must resolve the session reservation, run, durable display facts, and presentation revision from one consistent read boundary. Persist generated large view values in the run-scoped content table under their digest and media type before advertising their references. Do not reuse general state blobs or allow another run to read the content. Store the complete original workflow definition, not its escaped projection. Externalize large replay checkpoints and make both clients resolve them. Route state-changing Pi extension commands through the durable retry path. Give the CLI one stable client identity and one fresh key for each backup or applied prune invocation. Reuse that key only for the invocation's automatic reconnect retry, with a new request ID. Keep an in-flight maintenance operation alive after disconnect, store its accepted or rejected command receipt before response, wait for it during host shutdown, and adopt an exact retry. Wait for socket drain before sending another snapshot, and remove every subscription kind explicitly when its client unsubscribes.

**Verification:** Concurrent run changes cannot produce a view for the wrong session or combine two revisions. A source-level dependency test fails if production extension, CLI, relay, or Rust code opens the active database path. It permits SQLite only in the named TypeScript module that verifies an explicit inactive backup.

### 3. Add the host status reducer and activity overlay

**Location:** a host-owned view module under `src/server/` or `src/viewer/`, with no Pi import.

**Change:** Build the `display` object from durable facts and the validated activity overlay. Add connection-scoped activity leases and monotonic sequences. Apply the documented status precedence and allowed-control rules in one function.

**Verification:** Table tests cover every durable state, worker state, pending request, parked resumable run, pause, terminal result, ambiguous effect, activity start, activity expiry, disconnect, and stale sequence. `paused` appears only with the durable pause fact. Activity changes no durable row.

### 4. Replace the Pi extension's SQLite view

**Location:** `src/extension/session-view.ts`, `src/extension/index.ts`, and the delivery coordinator.

**Change:** Remove all extension imports and construction of `ServerStateStore`, `SqliteResourceManagerStore`, `WorkflowRunStore`, and the active state path. Replace `waitForInteractionSubmission`, `pendingInteractionForSession`, `pendingDecision`, `interactionPresentationClaimIsLive`, `hasClaimableNotification`, `hasClaimableTurn`, `terminalRunState`, `sessionRun`, and the widget's two-read refresh with `WorkflowClient` requests or the one origin-session subscription. The `interaction.submit` response supplies the final validation outcome. Report exact delivery activity from documented Pi events and the coordinator's delivery map. Render only the host `display` object. Keep Escape pause tied to the exact active workflow delivery.

**Verification:** Hold Pi busy longer than both the poll interval and activity lease. The widget stays `running` while refreshed exact activity is live, falls back to `waiting` after activity ends without submission, and shows `paused` only after the host accepts pause. The controlled run produces one visible delivery and one model turn without claiming a universal exactly-once guarantee.

### 5. Restore Herdr actions from the same view

**Location:** `src/extension/index.ts`, `src/extension/herdr-viewer.ts`, widget rendering, and extension tests.

**Change:** Register `/piw` and `Ctrl+Shift+R` through documented Pi APIs. Pass the current run target from the subscribed view to the existing Herdr adapter. Restore the conditional widget hint, placement chooser, exact-run pane labels, reuse, focus, and cleanup.

**Verification:** Outside Herdr, normal Pi behavior is unchanged. Inside a disposable Herdr session, the widget shows the hint, all supported placements open the exact run, repeated open focuses the existing pane, and failure leaves no empty tab or workspace.

### 6. Replace Rust live SQLite access

**Location:** `tui/src/client.rs`, `tui/src/source.rs`, `tui/src/source_loader.rs`, `tui/src/server.rs`, `tui/src/state/reader.rs`, and `tui/src/main.rs`.

**Change:** Make the protocol client the only Rust source. Remove the default active database path, all Rust `ProjectionReader` and backup-reader paths, copied application version, copied DDL digest, and direct-reader command selection. Start the host only through the installed TypeScript CLI. Make `piw serve` map each loopback WebSocket connection to one host socket connection and relay the same client protocol. Use the Unix socket on Unix and the package-derived named pipe on Windows. Drop old run pages, content requests, and artifacts when selection moves to another run.

**Verification:** A database created by the TypeScript package is visible in local and remote `piw` through the host. A protocol mismatch gives a package-version error. A valid live database never produces a Rust DDL mismatch. No `piw` live mode opens `state.sqlite`.

### 7. Remove split paths and update documentation

**Location:** old host/replay protocol code, obsolete viewer readers, `docs/WORKFLOW_SERVER.md`, `docs/SQLITE_STATE.md`, `docs/live-replay-protocol.md`, README usage, and package contents.

**Change:** Delete the superseded request/response and replay contracts, direct live readers, duplicated status reducers, and fallback flags. Update all user commands and architecture diagrams to show the one client stack. Keep inactive backup verification explicitly separate.

**Verification:** Search and dependency checks find no selectable direct live-state reader, old protocol identifier, copied DDL digest, or second status reducer. Package dry runs contain the client schema and both clients.

## Failure handling

- If the host cannot start or connect, clients show `unavailable` with one bounded next action. They do not display a cached run as current.
- If a client disconnects, the host expires its activity and subscriptions. Reconnection requests a patch from the last accepted revision or receives a bounded snapshot.
- If a subscriber falls behind retained revisions, only that subscriber receives a new bounded snapshot.
- If an activity report is stale or mismatched, the host rejects it and keeps the durable view.
- If Pi returns from message delivery but the visible result cannot be proved, the delivery remains ambiguous and blocked. The display protocol does not retry it.
- If a control command has an uncertain transport result, the client repeats the same request ID and payload and adopts the stored receipt.
- If a client protocol version is wrong, the client asks for matching package versions. It does not ask the user to reset SQLite.
- If the live SQLite schema is truly incompatible, the host fails before mutation with the standard backup-and-reset instruction and leaves all files untouched.

## Tests

### Contract and unit tests

- Shared TypeScript and Rust wire fixtures, including ECMAScript number formatting and UTF-16 key ordering.
- Envelope size, framing, unknown field, malformed message, and safe-error tests.
- Status precedence and allowed-control table tests.
- Activity validation against the recorded deterministic delivery ID and entry, duplicate alternate-ID rejection, idempotency, sequence, first report after reconnect, refresh-before-expiry, disconnect, and bounded expiry tests.
- Foreground cold-start timer reference tests and backpressured-write close and cancellation tests.
- Rust complete-definition request, digest verification, decode, and graph-layout tests.
- Atomic origin-session view tests, including bounded pending delivery records and removal of a terminal run when its reservation ends.
- Large workflow-topology frame tests with exact complete durable definition recovery, including user data that looks like an artifact sentinel.
- More-than-256-node graph-history tests that recover all graph steps and transitions through verified content in TypeScript and Rust.
- Large replay-checkpoint frame tests with TypeScript hydration and Rust artifact resolution.
- Durable backup and applied-prune retry tests with a new transport request ID and one stored receipt, plus separate-invocation key tests that prevent stale receipt reuse.
- One-shot and Rust explicit-watch missing-run tests that show a not-found error instead of rendering `null` or loading forever.
- Full TypeScript run-page assembly, exact-attempt step-trace selection, widget history, and content-hydration tests that bind bytes to the advertised digest, plus Rust page and content retrieval tests.
- Extension mutation tests that prove the durable client path is used for starts, updates, and submissions.
- Slow subscriber and response backpressure, close-before-drain cleanup, explicit unsubscribe, stale revision, reconnect, and bounded page tests.
- Durable generated-content recovery after memory-cache eviction, same-byte media collision tests, run-scoped read tests, and oversized run-list diagnostic references.
- Run-list and full-view failure tests that preserve the complete stored diagnostic instead of the machine error code.
- Idempotent interaction retry with a different attempted submission ID.
- Rust run-switch cleanup, explicit single-run selection, and cross-platform local transport compilation.
- Herdr capability, command, shortcut, placement, reuse, and cleanup tests.

### Integration tests

- Start one host and connect extension, CLI, and Rust clients to the same run.
- Prove that all clients receive the same revision, display status, and allowed controls.
- Create live state with TypeScript and view it through Rust without SQLite identity constants.
- Pause, resume, cancel, and submit through the one protocol and adopt repeated request receipts.
- Restart the host and recover subscriptions without a second database reader.
- Run the loopback WebSocket relay and compare its messages with local socket messages.
- Verify that active-state maintenance commands go through the host.
- Verify that only the TypeScript inactive-backup verifier can open SQLite outside the host and that it cannot select the active path.

### Live tests

Use a new Pi session and a disposable Herdr tab.

1. Start an interactive test workflow.
2. Keep the origin model turn active longer than the polling and activity lease intervals.
3. Confirm that the widget and status line show `running`, not `paused` or stale `waiting`.
4. Confirm that `Ctrl+Shift+R` and `/piw` open or focus the exact run.
5. Pause with Escape, confirm a durable `paused` view, resume, and complete.
6. Open the same run with local `piw` and the loopback relay.
7. Confirm one delivered workflow message and one model turn in this controlled run.
8. Restart the Pi session, reconnect, and confirm the correct run and controls.

## Required checks

Run:

```bash
npm run check
npm run test:e2e
git diff --check
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
npm pack --dry-run
cargo test --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path tui/Cargo.toml --check
```

Run Pi Reviewer against `main` with a ten-minute tool timeout until no P0 or P1 finding remains. Check pull-request comments and CI before merge.

## Rollout

Implement this as one release-sized hard cut. Do not publish the TypeScript package or Rust crate separately. Do not install one without the matching other package.

Before release, test the packed package in a new Pi session and a disposable Herdr tab. Confirm that the package starts its host on demand and does not install an operating-system service.

This documentation task does not publish a release.

## Completion criteria

The work is complete when:

- the host is the only production process that opens active SQLite state;
- all live clients use `pi-workflows.client.v1`;
- the host produces one canonical run view and one display status;
- the Pi widget, status line, controls, Herdr actions, CLI, and `piw` agree on the same revision;
- exact origin-session activity changes display only and cannot change authority;
- `paused` can come only from durable pause;
- local and remote `piw` work without copied SQLite identity facts;
- no direct live SQLite client, old replay protocol, fallback, or second status reducer remains;
- all unit, integration, live, repository, reviewer, and CI checks pass.
