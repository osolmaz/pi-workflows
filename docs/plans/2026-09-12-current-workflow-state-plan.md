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
4. Keep a retained terminal or follow-up message current until its required delivery or first turn
   finishes.
5. Return null when no message needs Pi.

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
before the node the widget shows as working, so the widget still shows the context of that node. One
row's `statusDetail`, `error`, `summary`, and human-decision summary are bounded by
`SESSION_NODE_TEXT_BYTES`; the complete text stays in the detailed run view.

The widget asks for the adjacent window with `view.session.window`, which moves the node cursor of
the live session subscription. `null` returns the window to the one that follows the working node.
The extension resets the cursor when the run changes, so a window never outlives its run. A paged
window therefore replaces the loaded rows instead of growing them, and no client holds the complete
topology. A failed window request clears its cursor again, so the same edge stays retryable.

The compact run carries the newest progress updates of its run, up to 16 keys, because a run keeps
up to 1,024 current updates and the oldest keys are the least useful ones for the widget. Complete
update history stays on the run's update page.

### Acceptance evidence

| Criterion                                                | Evidence                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi receives only current workflow state                  | `src/client/view.ts` `WorkflowSessionView` carries one `workflowMessage`, one `interaction`, one `openWorkflowTurn`, and the compact run. `test/server-view.test.ts` "keeps the session snapshot bounded while stored message history grows".                                                                                             |
| At most one message and one open turn in the snapshot    | The `WorkflowSessionView` type has single fields, not arrays. `workflow_turns_open_session_idx` rejects a second open turn.                                                                                                                                                                                                               |
| No complete run view or message history                  | `ServerViewStore.session()` reads `currentWorkflowMessage`, `currentInteraction`, and `sessionRun` with `graphCursor: 0`.                                                                                                                                                                                                                 |
| Snapshot stays bounded as history grows                  | The new test stores 25 messages of about 300 KiB each (more than 4 MiB) and asserts the encoded `session_snapshot` frame stays below 256 KiB.                                                                                                                                                                                             |
| Large current message through verified bounded chunks    | `WorkflowMessageCoordinator.prepareContent` hydrates content by reference and verifies `contentDigest` before delivery; a mismatch throws `Workflow message <id> content failed its digest check`.                                                                                                                                        |
| Old messages and complete run details remain available   | The bounded snapshot test pages the `workflow_messages` run page to all 25 stored messages and reads one externalized message through `view.content`.                                                                                                                                                                                     |
| Reconnect and branch recovery inspect one message        | `reportBranch` carries one nullable message id; `hasUnconfirmedBranchEntry` tracks one message. One report proves one message, so `test/server.test.ts` "scopes a missing step-message recovery to its own branch report" keeps an unreported source intact, re-issues a message that left the branch, and refuses an unknown message ID. |
| A sent message is adopted, not sent twice                | `test/extension.test.ts` delivery, reminder, and recovery cases; `test/workflow-message-coordinator.test.ts` 21 cases.                                                                                                                                                                                                                    |
| Delivery, reminder, terminal, and follow-up behavior     | The same extension and coordinator tests, with `deliveryCancelled` on the one current message.                                                                                                                                                                                                                                            |
| Oversized frame cannot close the connection or loop fast | `publishConnection` isolates one subscription; the client re-arms with capped backoff (`RECONNECT_MAX_ATTEMPTS`, 250 ms to 10 s) and reports `reconnect_exhausted`. `test/extension.test.ts` "re-arms the session subscription after a failure during the first publish" proves a failed first publish cannot strand the session view.    |
| A stale snapshot renders but cannot authorize            | The extension keeps the last view, adds the `stale` marker, and refuses commands and branch reports for a stale session id.                                                                                                                                                                                                               |
| Bounded widget scrolling                                 | The widget adapter rebuilds only the rows the server sends. `test/server-view.test.ts` pages a 300-node workflow and reaches every node through bounded windows; `test/extension.test.ts` scrolls the widget to the next window; `test/client.test.ts` moves and restores the window through the protocol.                                |
| One version-1 path, no compatibility code                | `run_patch` is removed from the client schema, the TypeScript client, and the Rust client. No alias or second message path exists.                                                                                                                                                                                                        |
| Pi core and Pi session schemas unchanged                 | No file outside this repository changed. The extension sends workflow messages through the existing Pi session API.                                                                                                                                                                                                                       |
