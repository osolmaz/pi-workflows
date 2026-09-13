---
title: Send only current workflow state to Pi
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-12
status: approved
---

# Send only current workflow state to Pi

## Goal

Pi should receive what is happening in the workflow now. Old workflow messages and detailed run
history should stay in the workflow server until a client asks to inspect them.

There will still be one workflow server and one live client protocol. The Pi extension and the
detailed viewer will ask that protocol for different views of the same server-owned state. This is
not a second operating mode.

The live Pi update must stay small as a run gets older. A large current instruction must also remain
available without crossing the 1 MiB client frame limit.

## User requirements

- Keep the design simple enough to explain as “Pi gets what is happening now.”
- Do not send the complete workflow message history to Pi.
- Do not send the complete detailed run view to Pi when the extension needs only current status.
- Keep complete history in SQLite for later inspection.
- Use one server and one client protocol.
- Preserve message delivery, branch recovery, reminders, terminal messages, follow-ups, pause,
  resume, cancellation, answers, updates, and submissions.
- Keep the 1 MiB client frame limit.
- Make the solution suitable for long-running workflows and large histories.
- Do not change Pi core or Pi session files.

## Current problem

`ServerViewStore.session()` in `src/server/view.ts` calls `listSession()` and places every stored
workflow message in `WorkflowSessionView.workflowMessages`. It then reports
`workflowMessageWindowComplete: true`.

Each workflow message contains its complete content. Long step instructions can repeat a large agent
contract. As the run continues, the session snapshot grows with every message. The pending
interaction contract already uses the existing content-reference projection, so it is not the main
source of this growth.

`encodeProtocolLine()` rejects a client frame above 1 MiB. `publishConnection()` catches that error
and closes the complete client socket. The client reconnects after 250 ms and requests the same
oversized snapshot. The extension clears its snapshot, loses current coordinator state, and cannot
submit or answer from that Pi session. The reconnect loop repeats without making progress.

The behavior also differs from the documented contract. [Workflow server](../WORKFLOW_SERVER.md)
and [Live client protocol](../LIVE_REPLAY_PROTOCOL.md) require a bounded session view. The current
code sends the complete message list instead.

## Existing parts to keep

The repository already has the main parts needed for the fix:

- `workflow_messages` stores durable message order, state, content digest, and confirmed Pi entry.
- `workflow_turns` stores the current model turn and its result.
- `run_view_content` and `view.content` provide digest-bound content references and bounded reads.
- Run pages keep detailed viewer history outside one frame.
- The server owns the live SQLite database and all workflow authority.
- The Pi extension uses documented Pi lifecycle, message, tool, command, widget, and status APIs.

The implemented [runner resume state plan](2026-09-04-workflow-runner-resume-state-plan.md) is the
precedent for this boundary. It removed unrelated history from runner replies and kept required large
values available through verified content references.

## Design

### One current session view

Replace the broad session snapshot with a small view of current work. The version-1 contract changes
in place while the project is in alpha.

The new `WorkflowSessionView` contains:

- the session ID;
- the active coordinator epoch and whether branch evidence is required;
- a compact view of the current run;
- the current interactive request, when one exists;
- the one workflow message that Pi must inspect, add, finish, or confirm next;
- the one open workflow turn, when one exists.

The session view does not contain the complete workflow message list or a complete
`WorkflowRunView`.

Remove these message-history fields from the session view:

- `workflowMessages`;
- `workflowMessageStart`;
- `workflowMessageTotal`;
- `workflowMessageWindowComplete`;
- `nextWorkflowMessageId`;
- `openWorkflowMessageId`;
- `cancelledWorkflowMessageIds`.

Use one `workflowMessage` field instead. It is null when Pi has no workflow message to handle.
Cancellation state for the current message belongs in that message projection, so the extension does
not need a separate list of cancelled message IDs.

### Current workflow message selection

The server derives the current workflow message from the existing durable rows. It does not create a
second queue or another source of truth.

Selection uses this order:

1. Use the message for the open workflow turn.
2. Otherwise, use the oldest relevant message whose presence on the active Pi branch is not yet
   known for the current coordinator epoch.
3. Otherwise, use the next pending message that is eligible for delivery.
4. Keep a delivered, cancelled step message current while Pi has not reported its turn, because the
   extension must learn that a message it already holds is cancelled and stop that turn. A message Pi
   never received needs no stopping, and keeping it current would let the extension deliver a
   cancelled step again and would hide the retained terminal view.
5. Keep a retained terminal or follow-up message current until its required delivery or first turn
   finishes.
6. Return null when no message needs Pi.

Future messages remain in SQLite. After Pi settles or confirms the current message, the server sends
a new session snapshot with the next message. A long queue therefore changes the number of small
updates, not the size of one update.

One Pi session can have at most one open workflow turn. Add a partial unique SQLite index on the
target session for rows whose turn state is `started`. Treat an existing violation as an integrity
error. Do not choose one of several open turns silently.

### Branch recovery for one message

The branch report no longer sends an array derived from the complete message history.

After a connection or Pi branch change:

1. The server sends the current workflow message ID and marks branch evidence as required.
2. The extension searches the active Pi branch for that exact ID.
3. The extension reports that the message is present, with its Pi entry ID, or absent.
4. The server validates the session, coordinator epoch, message ID, and entry evidence.
5. The server adopts the existing entry or permits delivery.
6. The server then advances to the next current message if more recovery work exists.

The coordinator stays inactive for delivery until the report is accepted. This keeps reconnect and
branch recovery bounded without sending old message bodies or old message IDs.

Tests must prove that processing one message at a time preserves the current branch rules. This
includes a send followed by disconnect, a branch change, a cancelled message that reached Pi, an
open turn, a retained terminal message, and a reminder.

### Compact current run

The Pi extension does not need the complete detailed run view. Add a `WorkflowSessionRunView` that
contains only the data used by workflow commands, the status line, and the widget:

- run ID and run revision;
- origin-session binding;
- workflow name and optional run title;
- server-produced display status, controls, activity, and safe reason;
- current node, waiting node, pause state, and current timing facts;
- a bounded page of node status rows for the widget;
- a bounded current progress summary.

The server sends the node rows needed for the initial ten-line Pi widget. The view includes the row
start and complete row count. Widget scrolling requests another bounded row page through the existing
client protocol. The complete run stays available through `view.run.get`, `view.run.watch`,
`view.page`, and `view.content`.

Keep the projection semantic. The server sends node IDs, node kinds, states, and progress facts. The
extension continues to apply terminal colors, glyphs, and layout.

### Complete content by reference

A projected workflow message keeps its metadata and content digest. Small content can remain inline.
Content above the existing inline threshold becomes the existing `$artifact` reference under the
message run ID.

Extract the content-reference reader from `materializeRunView()` into one shared TypeScript client
helper. The detailed viewer and the Pi extension both use it. The extension hydrates only the current
message before it calls Pi’s documented message API. It verifies the byte length and SHA-256 digest
before parsing the content.

Message history remains available as a bounded `workflow_messages` run-page kind for detailed
inspection. This page uses the same content projection. No client receives an unbounded array or a
truncated value.

### One safe socket writer

Route every client response and event through one server-owned writer. The writer:

- canonicalizes and encodes the final envelope once;
- checks the complete frame size, including the newline;
- handles socket backpressure;
- records the subscription digest and revision only after a successful write;
- counts oversized server output;
- writes a bounded, rate-limited diagnostic.

An unexpected oversized server event is an internal projection failure. The server sends a small
error for that subscription and keeps the connection and other subscriptions alive. It does not
retry the same failed projection four times per second.

Keep inbound handling separate. Invalid or oversized input can close only the connection that sent
it.

Do not make automatic whole-frame storage the normal response to an oversized session snapshot.
That would hide an unbounded view and make the client download the same excessive state through a
second step. View fields that can be large must declare content references or pages in their own
contracts.

### Connection state and stale display

The client keeps connection state separate from the last valid snapshot.

When the connection closes, the extension keeps the last snapshot for read-only display and marks it
stale. Commands that need workflow authority require a fresh connection, an active coordinator
epoch, and an accepted branch report. A stale snapshot cannot authorize a submission, answer, pause,
resume, cancellation, or update.

Use capped exponential reconnect delay with jitter. Reset the delay after a successful hello and
session snapshot. Include a bounded reason code and safe message when the server can report why one
subscription failed.

The extension must not treat a non-null unsubscribe callback as proof that the subscription is
healthy. Track the active connection ID and the last accepted snapshot instead. Re-arm the session
subscription after connection loss.

### Small snapshots instead of patches

Use complete revisioned snapshots for current session state. Their size stays bounded because they
contain only current work.

Do not add JSON Patch or multi-frame snapshot assembly for this fix. Patches would require base
revision tracking, gap recovery, and a full-snapshot fallback. Multi-frame snapshots would require
assembly and stale-part handling before Pi could act.

Remove the unused `run_patch` client event if no production client sends or accepts it. Keep JSON
Patch for workflow settings, where it is the actual public command format.

### Cache current views

Make `sessionCache` a real cache. Its key must include the durable view revision, current activity
revision, coordinator epoch, coordinator state, and the current message identity. An unchanged
session must not rebuild and hash the same view on every publish pass.

Cache contents are derived state. SQLite remains the source of truth.

## Failure behavior

Use these outcomes:

- A bad inbound frame closes only its connection.
- A session projection that exceeds its assigned frame budget fails only that subscription.
- Missing or invalid referenced content produces a bounded session error and does not deliver a
  message.
- Several open turns for one Pi session produce an integrity error and stop delivery.
- A stale coordinator epoch rejects the report or command without changing state.
- A disconnect keeps the last view for display but removes authority until recovery finishes.
- Reconnect exhaustion reports a clear blocker instead of continuing a fast loop.

Do not report these failures as a paused, failed, or cancelled workflow unless the durable workflow
state has that status.

## Scope

Implementation changes are limited to:

- `src/client/view.ts` and the version-1 client fixtures;
- `src/server/view.ts` and session-view queries;
- `src/server/server.ts` client publication and branch-report handling;
- `src/client/client.ts` connection and subscription recovery;
- `src/client/materialize.ts` or a shared content reader beside it;
- `src/extension/index.ts`;
- `src/extension/session-view.ts`;
- `src/extension/workflow-message-coordinator.ts`;
- `src/extension/widget.ts` when it consumes the compact run projection;
- `src/state/workflow-messages.ts` and the version-1 schema when enforcing one open turn;
- TypeScript and Rust protocol fixtures;
- focused tests and canonical docs.

## Non-goals

This work does not:

- change Pi core or use a private Pi API;
- edit or rewrite Pi session files;
- add a service, database, state root, transport, or compatibility protocol;
- delete, truncate, or hide workflow history;
- raise the 1 MiB client frame limit;
- compress or fragment snapshots;
- let the extension or viewer open live SQLite state;
- change workflow execution, node routing, or effect authority;
- remove post-workflow recovery turns or missing-submission reminders.

## Contract changes

This is an in-place alpha change to `pi-workflows.client.v1` and
`pi-workflows.session-view.v1`.

- The session view changes from a broad run-and-message snapshot to current workflow state.
- The extension receives one current workflow message instead of a message array.
- Branch reports describe only that current message.
- The nested run view becomes a compact session-run view.
- Detailed workflow message history moves to bounded run pages.
- Large current message content uses the existing content-reference contract.
- An outbound projection failure no longer closes the complete client connection.
- The unused `run_patch` event is removed if the implementation audit confirms that it has no
  producer or consumer.

There is no version 2, fallback reader, dual read, dual write, migration shim, or feature flag. An
incompatible local alpha database fails before mutation with the existing backup and reset
instruction.

## Pi API impact

- **Session state:** Pi appends normal workflow messages and tool results. Pi Workflows does not
  write or rewrite session entries.
- **Other persistent data:** Reuse the current workflow database, blob store, and `run_view_content`.
  Add only a bounded private server log in the existing workflow state directory. The one-open-turn
  index changes the current alpha schema in place.
- **Pi internals:** None.
- **Public API changes in Pi:** None.
- **Public API used by the extension:** Documented session lifecycle events, `ctx.sessionManager`
  reads, message sending, tools, commands, widgets, status, and notifications.

The installed public Pi extension API is sufficient for this design.

## Implementation steps

### Add the failing session test

Create a session with at least twenty stored workflow messages whose content is about 300 KiB each.
Include a large run history and a pending interaction. Subscribe through the real client protocol.

Prove that the current implementation attempts a frame above 1 MiB and closes the connection. Keep
all test data generic and inside temporary directories.

### Define the current-state contracts

Replace the session view types and fixtures in place. Add the compact session-run view, one current
workflow message, one current interaction, and one open turn. Remove the old message-window fields.

Update the neutral protocol fixtures used by TypeScript and Rust. Reject unknown old fields.

### Project one current workflow message

Add narrow store queries that read message metadata without loading content for every row. Derive the
current message in durable order. Project only that message and register its large content through
the existing content store.

Add the one-open-turn database constraint and clear integrity errors. Do not add another message
queue or current-message table.

### Simplify branch reporting

Change the version-1 branch report to report presence or absence for the current message ID. Refactor
the extension coordinator around one current message. Remove loops and local sets that exist only to
maintain a copied history list.

Test initial delivery, uncertain delivery after disconnect, active branch changes, resumed prompts,
reminders, cancellation, terminal delivery, terminal turns, follow-ups, and explicit user
cancellation.

### Add the compact run projection

Project only the fields used by the Pi widget, status line, and workflow commands. Add bounded widget
row reads for scrolling. Keep full run inspection on the existing detailed view and page path.

Prove that the extension applies the current snapshot immediately and does not hydrate detailed run
history before it updates status or delivery state.

### Share content hydration

Extract one verified content reader for TypeScript clients. Use it for detailed run materialization
and current workflow message content. Cover chunk order, byte length, digest, media type, missing
content, malformed JSON, and cancellation.

### Centralize client writes

Add one measured client writer and route hello, response, and event writes through it. Keep one
subscription failure from closing the socket. Add bounded logging, an overflow counter, and
rate-limited retry behavior.

Test the exact limit, one byte above it, socket backpressure, a failed subscription beside a healthy
subscription, and a response after a durable command has already committed.

### Make reconnect state explicit

Keep stale display state, remove stale authority, add capped exponential backoff with jitter, and
re-arm subscriptions by connection ID. Report the safe reason for a subscription failure.

Test server restart, connection loss before and after message send, branch report replay, delayed
content hydration, cancellation, and reconnect exhaustion.

### Remove dead paths and update docs

Remove `run_patch` only after confirming that no TypeScript or Rust production path uses it. Wire the
session-view cache and remove state that served only the complete message list.

Update:

- [Workflow server](../WORKFLOW_SERVER.md);
- [Live client protocol](../LIVE_REPLAY_PROTOCOL.md);
- [SQLite state](../SQLITE_STATE.md);
- the neutral client schema and fixtures;
- workflow and extension behavior docs affected by the contract.

Record any departure from this plan in this file after implementation.

## Verification

During implementation, run focused tests after each step. Before completion, run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Then run one real-model live end-to-end test with an authenticated low-cost model and an exact
provider and model ID, as required by this repository.

Result on `feat/current-workflow-state` after the rounds below:

- `npm run check`: 110 files, 1327 tests, statements 90.93%, branches 85.41%.
- `npm run test:e2e`: 14 tests passed.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` in `tui`.
- `npx slophammer-ts@latest dry .`: no findings.
- `npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`: no findings.
- `npx -y @simpledoc/simpledoc check`: repo matches SimpleDoc conventions.
- Runtime live E2E: `20260913T001425191Z-live-runtime-e2e-302519f1`, result `passed`.
- Real-model live E2E: `20260913T001754183Z-live-model-e2e-abc4df03`, provider `openai`, model
  `gpt-5.6-luna`, cost $0.00384, result `passed`.
- CI on the pull request: `check`, `e2e`, `installed-e2e`, and `tui` passed.

Result after the closing vocabulary sweep:

- `npm run check`: 111 files, 1343 tests, statements 90.93%, branches 85.47%.
- `npm run test:e2e`: 14 tests passed.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` in `tui`: 87 tests passed.
- `npx slophammer-ts@latest dry .` and the dependency-boundary check: no findings.
- `npx -y @simpledoc/simpledoc check`: repo matches SimpleDoc conventions.
- Runtime live E2E: `20260913T014917509Z-live-runtime-e2e-f605c294`, result `passed`.
- Real-model live E2E: `20260913T015035278Z-live-model-e2e-69c3e9f4`, provider `openai`, model
  `gpt-5.6-luna`, cost $0.00340, result `passed`.
- CI on the pull request at `c526ea5`: `check`, `e2e`, `installed-e2e`, and `tui` passed.
- Result on the final head `bb36dd6`, after the reviewer rounds 29 to 36:
  - `npm run check`: 111 files, 1348 tests, statements 90.93%, branches 85.48%.
  - `npm run test:e2e`: 14 tests passed.
  - `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` in `tui`: passed.
  - `npx slophammer-ts@latest dry .` and the dependency-boundary check: no findings.
  - `npx -y @simpledoc/simpledoc check`: repo matches SimpleDoc conventions.
  - Runtime live E2E: `20260913T033457066Z-live-runtime-e2e-4e428b1a`, result `passed`.
  - Real-model live E2E: `20260913T033616192Z-live-model-e2e-28b0ef64`, provider `openai`, model
    `gpt-5.6-luna`, cost $0.00339, result `passed`.
  - CI on the pull request at `bb36dd6`: `check`, `e2e`, `installed-e2e`, and `tui` passed.
  - Pi Reviewer round 36, on `bb36dd6`: no findings.
- Pi Reviewer rounds on the pull request reached no findings at round 28. The model named by the
  implementation workflow, `huggingface/deepseek-ai/DeepSeek-V4.1-Flash`, had answered with a rate
  limit during the earlier rounds and returned findings again in rounds 29 to 34. Every finding was
  either fixed with a red-green test or answered with source and test evidence. The later rounds
  fixed a cancelled step that Pi never received, a session view cache that keyed
  the selected message on the run, a lost action subtype, a lost current node during a pending
  handoff, and an empty node window that could not page back.
- Round 29 found that the compact run reported the current and waiting node as unbounded scalars,
  while the window leaves out a row whose own bytes exceed the frame budget. `bcb952c` leaves such
  an identity out of those two facts as well, so no node id larger than one frame reaches a client.
  `test/server-view.test.ts` "leaves out a node identity that cannot fit the frame" covers it, and
  the run stays complete through the row count and the detailed run view.
- Round 31 asked whether a refused restore should stay retryable instead of spending the reconnect
  budget. The rule is intended and already documented and tested: the budget resets only after a
  handshake and a restored subscription set both succeed, a refused restore counts toward it
  (`test/client.test.ts` "keeps the reconnect budget after a refused restore"), and a view from a
  partly restored connection does not reset it ("keeps the reconnect budget after a view from a
  partly restored subscription"). The blocker message now says that the server did not return the
  session view, because the budget also counts a refused restore, and it names the recovery step.
- Round 32 found that the human answer path can no longer answer a pending request that is not the
  one in the session view. The one pending request is the plan's own bound, and the extension needs
  the request's run and revision to answer a decision and must not guess the kind of a request the
  view does not carry, so the refusal stays. The message now names the true state instead of
  claiming that no request waits, `docs/WORKFLOW_SERVER.md` records the rule, and
  `test/extension.test.ts` "answers only the pending request the session view carries" covers both
  the refusal and the answer.
- Round 33 found that the bounded session text cut could fall inside a multi-byte character and end
  the value with a replacement character. `boundSessionText` now cuts on a character boundary;
  `test/server-view.test.ts` "cuts bounded session text at a complete character" covers it.
- Round 34 raised three bounded-cost questions, and each one is already answered by the code, a test,
  or both, so no further change was needed.
  - The message count in `readRunViewCounts` is not an unindexed scan. `workflow_messages_run_idx`
    covers `(run_id, order_number)` (`src/state/schema.ts:558`), and the shared counts helper serves
    `readRunView`, which builds `workflowMessages` and `workflowMessageTotal` for every caller. A
    split would add a branch to a hot path to save one index scan over the messages of one run.
  - The paged node window cannot be dropped before use. The widget asks for a window only through
    `scrollBy`, which needs a loaded run, so `sessionWindowRunId` already equals the incoming run ID
    when a cursor exists. The reset fires only on a real run change, which is the intended behavior,
    and `test/extension.test.ts` "keeps the paged window across a re-arm" covers the reconnect path.
  - An entry-less branch report is accepted and reported as absent. `reportWorkflowBranch` accepts
    every message the session stores, including a cancelled one, and only an ID outside that set is
    refused. `test/server.test.ts` covers both: the refusal at line 2099 and the entry-less present
    report at line 2140, which re-issues the step message.
- Round 35 found two real defects and both are fixed.
  - A report of no message re-issued the step of a paused run. The session view does not carry a
    delivered step while its run is paused, so Pi reports no message while it still holds the step,
    and the report cancelled that message and created a second one. `reportWorkflowBranch` now skips
    a paused source, because a paused run acts on nothing and Pi's branch may still hold the message.
    `test/server.test.ts` "keeps a delivered step of a paused run when the branch reports no message"
    fails without the guard with `[ 'sent', 'pending' ]` and passes with it. `docs/WORKFLOW_SERVER.md`
    records the exception.
  - The Rust version-1 operation list lacked `view.session.window`, so a valid request naming it
    would be refused by the Rust parser while the TypeScript client and the schema accepted it.
    `tui/src/protocol.rs` now lists it, and `test/client-boundary.test.ts` "keeps the Rust client
    operations equal to the version-1 schema" keeps the two lists equal.

The automated tests must not call a real model, modify live workflow state, or write outside their
temporary directories.

For this documentation-only change, run only:

```bash
npx -y @simpledoc/simpledoc check
git diff --check
```

## Acceptance criteria

The change is complete when all of these statements are true:

- Pi receives only current workflow state.
- The session snapshot contains at most one workflow message and one open workflow turn.
- The session snapshot does not contain the complete run view or workflow message history.
- Snapshot size stays bounded when stored workflow history grows from one message to thousands.
- A large current message is read through verified bounded content chunks.
- Old messages and complete run details remain available through the detailed viewer.
- Reconnect and branch recovery inspect one current message at a time.
- A message sent before a disconnect is adopted instead of sent twice.
- Initial, resumed, reminder, terminal, and follow-up messages keep their current behavior.
- Post-workflow recovery and missing-submission reminders remain active and bounded.
- A server-built oversized frame cannot close the complete client connection or start a fast retry
  loop.
- A stale snapshot can render but cannot authorize a state change.
- The widget still supports bounded scrolling without loading complete run history into every
  session snapshot.
- The client protocol has one version-1 path with no compatibility code.
- Pi core and Pi session schemas do not change.
- All required checks, end-to-end tests, the live low-cost model test, and CI pass.

## Implementation record

Status: implemented on 2026-09-12, before merge.

Commits:

- `feat(state): send only current workflow state to Pi`
- `fix(server): keep the next actionable message current`
- `fix(client): bound reconnect and isolate one failed view`
- `refactor(client): remove the unused run_patch event`
- `refactor(state): rename components to workflow server, runner, and resource manager`
- the documentation, test, and naming sweep commit that carries this record.

### Departures from this plan

1. **The widget keeps its own adapter instead of a rewritten data path.** `buildWidgetView(state,
snapshot, ...)` keeps its signature. A new `src/extension/session-run-adapter.ts` rebuilds the
   minimal run state, snapshot, and update records that the widget needs from the compact session
   run. Reason: the widget has about a thousand lines of behavior tests. The adapter keeps those
   tests meaningful, keeps the server-owned facts intact, and avoids a rewrite that the acceptance
   criteria do not require.

2. **The branch report names one message or no message.** `WorkflowBranchReport.workflowMessageId`
   is `string | null`. A session that holds no workflow message yet must still clear the pending
   branch report. Without a nullable value the coordinator can never report, and workflow commands
   stay blocked. The server receipt reports `present` or `absent`. This replaces the removed
   `workflowMessageIds` array.

3. **One open turn per target session is a schema rule.** This plan already required a single open
   turn. The implementation adds `workflow_turns_open_session_idx` beside
   `workflow_turns_open_message_idx`, and `startTurn` rejects a second open turn for the same
   session with the integrity error `Workflow session <id> already has open turn <turnId>`.

4. **A failed subscription projection drops only that subscription.** `publishConnection` isolates
   each subscriber. A failing projection emits `unavailable` with reason code `projection_failed`,
   removes only that subscription, and logs `client view error for subscription <id>`. The client
   re-arms with capped backoff: 1 s doubling to 30 s.

5. **`apply_patch` and `PatchOp` stay in the Rust protocol module.** The `run_patch` event is gone
   from the client schema and from both implementations. The RFC 6902 helpers remain as tested
   public protocol utilities, because the Rust protocol test suite uses them directly.

6. **Component naming was cut over in the same change.** See the next section. The plan did not name
   this work, and it added one commit. It does not change the acceptance criteria.

### Component naming cutover

The public vocabulary is now workflow server, workflow runner, resource manager, resource runner,
and managed resource. The cutover changed names in place. It adds no alias, no second storage path,
and no compatibility reader.

- SQLite: `workflow_server_state`, `server_id`, `server_commands`, `server_epoch`, `run_runners`,
  `runner_epoch`, `runner_messages`, `managed_resources`, `managed_resource_finalizers`,
  `managed_resource_queue`, `managed_resource_workflows`, `resource_manager_name`, and the matching
  indexes.
- Stored values: resource type `managed_resource`; owner and actor `server` and `resource_manager`.
- Protocol schemas: `runner-launch.v1`, `runner-message.v1`, `runner-response.v1`,
  `runner-content-reference.v1`, `runner-content-chunk.v1`, `resource-runner-launch.v1`,
  `resource-runner-message.v1`, `resource-runner-response.v1`, `server-lock.v1`.
- Paths and options: state directory `server`, `server.sock`, `server.lock.json`,
  `server.children.json`, `maxRunners`, `executionRunners`, `PI_WORKFLOWS_MAX_RUNNERS`.
- Server identifiers use the `server-` prefix; managed resources use `managed-resource-`.

Dated plan records under `docs/plans/` and `docs/2026-*.md` keep their original wording, because they
are historical records of the state at their date.

The sweep covers every surface a user or a client sees today: production sources, protocol schemas,
scripts, the Rust crate manifest, and current documentation. It renamed the last three occurrences
that remained after the first pass: the `piw` crate description, one live-E2E comment about who
records an attempt timeout, and two status lines that described a dated record in the retired
wording. `test/component-vocabulary.test.ts` now fails when a retired term returns. It reads every file in the repository
that a person can open, which includes the sources, the protocol schemas, the scripts, the Rust
crate manifest, the skills, and the documentation. Three kinds of file stay out of scope: a dated
record, because it describes the state at its date; a test, because a test may build an invalid old
value on purpose; and `package-lock.json`, because it is generated dependency metadata. The check
failed first on a skill document, which the earlier, narrower version of the sweep did not read.

An automated pass over the tree confirms every item above: 8 SQLite
tables, 4 columns, 9 protocol schemas, 3 state paths, 3 options, 3 stored owner or type values, the
`server-` identifier prefix, and the `managed-resource-` prefix. No `host.sock`, `host.lock.json`, or
`host.children.json` name and no `maxHosts` or `executionHosts` option remains in a current surface.

Three old names stay on purpose, and each one names a fact about an earlier layout rather than the
current one: the dated plan file names, the `apply_patch` and `PatchOp` protocol helpers, and the
legacy state directories `runs`, `decisions`, and `controllers` that `assertNoLegacyState` refuses.
`PI_WORKFLOWS_RUNS_DIR` and `PI_WORKFLOWS_CONTROLLER_DIR` exist only in a dated record that states
they were removed.

The stored database changes shape. This repository is in alpha, so the server reports the existing
reset instruction when it opens an older database. No migration is added.

### Message selection and message history

Selection reads stored message metadata only. `WorkflowMessageStore` gained `listSessionSummaries`,
`listRunSummaries`, `listRunSummaryPage`, `countForRun`, and `materialize`. The view materializes
content for the one message the session must act on. `listSession` and `listRun` now build from the
same summary rows, so no caller loads a content blob per stored row.

`workflow_messages` gained a `trigger_turn` column. It mirrors `content.triggerTurn`, so eligibility,
retention, recovery stopping, and follow-up checks never read the content blob. The alpha cutover
changes the DDL in place, as allowed above.

Complete message history is reachable through the `workflow_messages` run page. It obeys the same
item limit, byte budget, and digest-bound content reference rule as every other history page.

One branch report names one message, so it proves the presence of that message only. The server uses
that evidence for the reported message's own source and leaves every other pending source to its own
report. A report of no message at all proves that the branch holds no workflow message, which covers
every source. Without this rule, a report about one source could cancel and re-create the step
message of another source that Pi still holds, and Pi would receive the same request twice.

### Bounded node window

The session view carries a bounded window of node rows with its first row index and the complete row
count. Rows are the canonical snapshot order. The default window starts `SESSION_NODE_LEAD` rows
before the node the widget shows as working. When the run has no working node, that node is the most
recent failed node, or the last row, which is the row the widget highlights. One
row's `statusDetail`, `error`, `summary`, and human-decision summary are bounded by
`SESSION_TEXT_BYTES`; the complete text stays in the detailed run view. A row whose own identity is
larger than the window budget is left out and the window starts at the next row, so an unbounded
node id cannot break the frame. `test/server-view.test.ts` "leaves out a node row that cannot fit
the frame by itself" drives a 200 KiB node id first and in the middle of a topology.

The widget asks for the adjacent window with `view.session.window`, which moves the node cursor of
the live session subscription. `null` returns the window to the one that follows the working node.
Only a key press at an edge of the loaded window asks for the adjacent window, so the rows between
the current position and that edge stay visible first. A down page opens the next window at its
first row, which continues where the loaded one ended, and an up page opens the previous window at
its last row, where the user was. The view keeps the loaded window and its position until the asked
window arrives, so a failed request stays retryable without losing the position. A window that
already holds rows stops before a row too large for the frame, so its rows stay contiguous and the
next cursor is exact; the following window skips that row and continues. The extension resets the
cursor when the run changes, so a window never outlives its run. A paged window therefore replaces
the loaded rows instead of growing them, and no client holds the complete topology.

When the run has no working node, the default window follows the row the widget highlights: the most
recent failed node when there is one, otherwise the last row. Detail text belongs to the same node,
so the failure the widget shows is never outside the loaded window.

The compact run carries the newest progress updates of its run, up to 16 keys, because a run keeps
up to 1,024 current updates and the oldest keys are the least useful ones for the widget. The
current-updates read already keeps the newest record per type and key, so one busy key cannot hide
another track; the bound removes the least recent keys only. Complete update history stays on the
run's update page. `test/server-view.test.ts` "keeps one progress record per key however often one
key publishes" proves it with five tracks and twenty updates for one key, and asserts that a second monitor cycle replaces the first `next-check` record instead of adding a stale one.

### Acceptance evidence

| Criterion                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi receives only current workflow state                       | `src/client/view.ts` `WorkflowSessionView` carries one `workflowMessage`, one `interaction`, one `openWorkflowTurn`, and the compact run. `test/server-view.test.ts` "keeps the session snapshot bounded while stored message history grows".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| At most one message and one open turn in the snapshot         | The `WorkflowSessionView` type has single fields, not arrays. `workflow_turns_open_session_idx` rejects a second open turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| No complete run view or message history                       | `ServerViewStore.session()` reads `currentWorkflowMessage`, `currentInteraction`, and `sessionRun` with `graphCursor: 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Snapshot stays bounded as history grows                       | The new test stores 25 messages of about 300 KiB each (more than 4 MiB) and asserts the encoded `session_snapshot` frame stays below 256 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Large current message through verified bounded chunks         | `WorkflowMessageCoordinator.prepareContent` hydrates content by reference and verifies `contentDigest` before delivery; a mismatch throws `Workflow message <id> content failed its digest check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Old messages and complete run details remain available        | The bounded snapshot test pages the `workflow_messages` run page to all 25 stored messages and reads one externalized message through `view.content`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Reconnect and branch recovery inspect one message             | `reportBranch` carries one nullable message id; `hasUnconfirmedBranchEntry` tracks one message. One report proves one message, so `test/server.test.ts` "scopes a missing step-message recovery to its own branch report" keeps an unreported source intact, re-issues a message that left the branch, and refuses an unknown message ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A sent message is adopted, not sent twice                     | `test/extension.test.ts` delivery, reminder, and recovery cases; `test/workflow-message-coordinator.test.ts` 21 cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Delivery, reminder, terminal, and follow-up behavior          | The same extension and coordinator tests, with `deliveryCancelled` on the one current message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Oversized frame cannot close the connection or loop fast      | `publishConnection` isolates one subscription; the client re-arms with capped backoff (`RECONNECT_MAX_ATTEMPTS`, 250 ms to 10 s) and reports `reconnect_exhausted`. `test/extension.test.ts` "re-arms the session subscription after a failure during the first publish" proves a failed first publish cannot strand the session view. Every free-form value in the compact run is bounded, so a workflow cannot build an oversized session frame: `test/server-view.test.ts` "bounds every free-form session field so one frame still fits" proves a 64 KiB workflow name, run title, node output, and failure keep the whole projection below a quarter of the frame limit. The reconnect budget resets only after a handshake and its subscription restore both succeed, so a subscription the server keeps refusing counts toward the budget instead of looping; `test/client.test.ts` "counts a refused subscription restore toward reconnect exhaustion" fails without that order. A view from a subscription the server restored while a later one is still refused does not reset the budget either, so a partial restore cannot loop at the base delay; `test/client.test.ts` "keeps the reconnect budget after a view from a partly restored subscription" fails without that rule. |
| An explicit window request is not deferred to the poll        | A change that arrives while a publish pass runs queues one further pass, so `view.session.window` reaches the client without waiting for the 250 ms view poll; `test/server.test.ts` "publishes the asked node window after a pass already running" holds the socket under backpressure and fails without the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A run with many update keys still carries its newest tracks   | The compact run reads a bounded tail of its progress and monitor update types instead of the head of the complete set; `test/server-view.test.ts` "reads the newest progress keys when a run publishes many tracks" seeds 300 tracks after a schedule and fails on the old head read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A stale snapshot renders but cannot authorize                 | The extension keeps the last view, adds the `stale` marker, and refuses commands and branch reports for a stale session id. It also fences the message coordinator, so no Pi turn starts and the running workflow turn may not call a tool from a snapshot the server no longer confirms: `test/workflow-message-coordinator.test.ts` "sends nothing from a snapshot whose subscription failed" and "blocks every tool while a lost subscription leaves the turn unconfirmed" fail without the fence, and `test/extension.test.ts` "fences workflow delivery when the session subscription is lost" proves the wiring. The projection retry deadline belongs to one session, so a new session starts with a fresh budget: `test/extension.test.ts` "starts a new session without the previous projection backoff" fails when a closed session leaves its deadline behind.                                                                                                                                                                                                                                                                                                                                                                                                                     | A cancelled step message whose delivery Pi has not confirmed stays current, so cancellation still stops a delivered turn: `test/server-view.test.ts` "keeps a cancelled step current until Pi confirms its delivery" fails without that rule. |
| Bounded widget scrolling                                      | The widget adapter rebuilds only the rows the server sends. `test/server-view.test.ts` pages a 300-node workflow and reaches every node through bounded windows, opens a run with no working node on its end, and keeps the newest 16 progress keys; `test/extension.test.ts` scrolls the widget to the next window and retries a failed request; `test/client.test.ts` moves and restores the window through the protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A re-armed subscription keeps the paged window                | The extension keeps the cursor it last asked for, because the client subscription that held it is dropped when the connection is lost; `test/extension.test.ts` "re-arms a paged session window with its cursor" pages a 300-node run, drops the subscription, and fails without the cursor on the new watch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A superseded attempt cannot report a finished node as working | Compact node rows report the node's newest attempt; `test/server-view.test.ts` "reports a node whose leftover unfinished attempt was superseded" leaves an unfinished first attempt beside a completed second attempt and fails without that rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| One endpoint, reported before a probe                         | The rename shortened the Unix socket path, and each client reports a path above the operating system limit from its own measurement: `src/client/protocol.ts` `assertSocketPathSupported` and its `test/client-protocol.test.ts` cases on TypeScript side, and `tui/src/main.rs` `check_socket_path` with `tui/src/main.rs` `tests::reports_a_socket_path_above_the_operating_system_limit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| One version-1 path, no compatibility code                     | `run_patch` is removed from the client schema, the TypeScript client, and the Rust client. No alias or second message path exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| One vocabulary in every current surface                       | Every repository file that a person can open contains no retired term; `test/component-vocabulary.test.ts` fails when `hosted`, a `host` owner value, or an old `host` request name returns in a source, a schema, a skill, or a document. Dated records, tests, and `package-lock.json` stay out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A cancelled step Pi never received                            | A cancelled step message stays current only while Pi holds it and has not reported its turn; `test/server-view.test.ts` "drops a cancelled step that Pi never received" proves an undelivered cancelled step is not selected, so the extension cannot deliver it again and the retained terminal view stays visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A selected-message change re-reads the view                   | The session view key names the selected message even when the session holds no live or retained run; `test/server-view.test.ts` "re-reads the session view when only the selected message changes" changes a message status in the same millisecond and proves the next read is fresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| One action subtype per node row                               | A node row keeps the exact `function` or `shell` subtype, so the widget renders a shell action with its own glyph; `test/server-view.test.ts` "carries the action subtype and the current node for a pending attempt" and `test/session-run-adapter.test.ts` "carries the action subtype the widget renders".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The current node survives a pending handoff                   | The widget adapter takes the active node from the run fact, so a run whose active attempt is still `pending` keeps the node highlight and the elapsed time; `test/session-run-adapter.test.ts` "keeps the current node while its attempt is still pending".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A node identity that cannot fit one frame is left out         | The compact run leaves out a current or waiting node identity whose own bytes exceed the window budget, so one long node id never breaks a client frame; `test/server-view.test.ts` "leaves out a node identity that cannot fit the frame".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A window with no rows still pages back                        | An empty node window, which a row too large for one frame can leave behind, returns to the last window that held rows; `test/extension.test.ts` "pages back from an empty node window".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Pi core and Pi session schemas unchanged                      | No file outside this repository changed. The extension sends workflow messages through the existing Pi session API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
