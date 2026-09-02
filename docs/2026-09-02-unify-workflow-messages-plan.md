---
title: Unify workflow messages and restore hosted behavior
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-02
status: approved
---

# Unify workflow messages and restore hosted behavior

## Summary

The out-of-process host made workflow execution safer, but the change did not preserve all session behavior. The current host also loses track of some active model turns. A model can still be responding while the widget and `piw` show `waiting`.

This change gives the host one saved list of workflow messages that Pi must add to a conversation. A workflow message can be a step, human decision, notification, terminal turn, or follow-up prompt. Initial, reminder, and resumed prompts are the same `step` kind with different display reasons. One extension component sends every kind through documented Pi APIs.

The same change restores the user features removed during the host cut. It keeps one global host, one client protocol, one database, and one production runtime.

[Workflow host](WORKFLOW_HOST.md) remains the process and state specification. [Workflow messages in Pi](WORKFLOW_STEP_MESSAGES.md) remains the Pi message specification. This plan changes both contracts in place.

## Current problems

### Active model turns can show `waiting`

The extension currently reports active model work through a four-second host lease. It refreshes that lease every second.

This design has several faults:

- Activity starts when the first step prompt is recorded, not on every matching `agent_start` event.
- A later model turn on the same pending step does not start new activity.
- One delayed refresh can let the lease expire.
- After expiry, later refreshes can be rejected because the host expects a new start.
- Concurrent refreshes can reuse a sequence number.
- The extension hides refresh failures.

The durable run remains `waiting` while an interactive step is parked. When the temporary activity record disappears, every renderer falls back to that durable state even if the model is still responding.

### Completed results disappear immediately

Before the host cut, the Pi widget kept a terminal result for 60 seconds. The current session view returns only a run that still owns the session reservation. A terminal run correctly releases that reservation, but the widget then clears at once.

Display retention and workflow ownership are separate concerns. A terminal result can remain visible without retaining a claim, reservation, or control.

### Session behavior is split

The current host saves and sends three kinds of Pi content through separate paths:

- interactive requests;
- notifications;
- terminal turns.

Each path has different claim operations and different message fields. Reminders, resumed prompts, and follow-up prompts have no complete hosted path. Human decisions use another presentation path. This split made it possible to remove working features when the embedded executor was deleted.

### Documents describe behavior that does not ship

Several reference pages still describe reminders, follow-ups, live settings controls, terminal recovery, Telegram channels, and conversation recording as implemented. Version 0.16.0 does not provide all of that behavior.

## Goals

- Show `running` for the full duration of each matching Pi model turn.
- Keep the last terminal result visible for 60 seconds or until another workflow starts.
- Save every workflow message through one host-owned contract.
- Use one extension component to add workflow messages to Pi.
- Restore every user feature listed in [Behavior to restore](#behavior-to-restore).
- Keep workflow-specific results separate from message sending.
- Make the widget, status line, CLI, and `piw` use the same host view.
- Preserve one global host as the only normal SQLite writer.
- Use documented Pi extension APIs only.

## Boundaries

- Do not restore the embedded workflow executor.
- Do not let the extension, CLI, or `piw` open live SQLite state.
- Do not restore per-project hosts or `/controller start` and `/controller stop`.
- Do not send a workflow prompt into an active model turn.
- Do not run workflow or controller code in the host event loop.
- Do not change Pi core, private Pi APIs, Pi session files, or Pi session schemas.
- Do not add another database, service, runtime, compatibility reader, fallback, or feature flag.
- Do not claim exactly-once model execution.
- Do not retry an uncertain external effect or uncertain Pi message blindly.
- Do not expose workflow message IDs or internal send state to the model.

## Workflow messages

A workflow message is content that the host requires Pi to add to one conversation. It does not mean every message in the Pi session.

The host saves these kinds:

| Kind           | Pi behavior                 | Purpose                                                     |
| -------------- | --------------------------- | ----------------------------------------------------------- |
| `step`         | Starts a model turn         | Initial, reminder, or resumed interactive step prompt       |
| `decision`     | Does not start a model turn | Protected human decision shown in Pi                        |
| `notification` | Does not start a model turn | Passive text from a workflow `notify` node                  |
| `terminal`     | Starts a model turn         | Final result, recovery choice, and safe restart opportunity |
| `followUp`     | Starts normal work          | Work queued to start after successful completion            |

One saved record contains the stable facts needed to add the content to Pi:

```ts
type WorkflowMessage = {
  schema: "pi-workflows.workflow-message.v1";
  workflowMessageId: string;
  runId: string;
  targetSessionId: string;
  kind: "step" | "decision" | "notification" | "terminal" | "followUp";
  sourceId: string;
  contentDigest: string;
  order: number;
  status: "pending" | "sent" | "cancelled";
  piSessionEntryId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The exact Pi content and custom-message details remain in the existing content-addressed value store. `contentDigest` binds the saved record to those bytes. `sourceId` binds it to the feature that created it, such as an interaction request, human decision, or terminal run. Step details contain `reason: "initial" | "reminder" | "resumed"`; the workflow-message table does not store three kinds for the same behavior.

`kind` determines the custom renderer, whether the message starts a model turn, and its host eligibility rule. The host does not store duplicate flags or message-to-message pointers for these derived facts.

`order` is the acceptance order within one origin session. The host marks one pending message as the next eligible message in the origin-session view. An earlier ineligible or cancelled message does not block unrelated eligible work. Source state and message kind decide eligibility, so removing a follow-up or changing a continuation cannot leave a broken pointer chain.

The database table is `workflow_messages`. The public TypeScript name is `WorkflowMessage`. The model does not receive `workflowMessageId`, `sourceId`, internal coordination facts, or Pi entry IDs.

### Message states

- `pending` means the host has no active-branch proof that Pi contains the message. The message can be new or uncertain after a process stopped.
- `sent` means the exact message exists in the target Pi branch and the host saved its Pi entry ID.
- `cancelled` means the source no longer requires the message.

Lifecycle transactions can change `pending` to `cancelled`. Active-branch evidence changes `pending` or `cancelled` to `sent`; evidence always wins because Pi already contains the entry. `sent` is terminal. A pending message is never sent until the active coordinator reports the branch, Pi is idle, Pi has no pending input, and the branch has no matching hidden ID.

A response to a message is not another message state. Interactive request state owns model submissions. Human decision state owns human answers. Model-turn state owns whether the model is currently working. This keeps each status precise.

### One sending path

The version-1 client protocol replaces the separate interaction, notification, terminal-turn, and follow-up send operations with two controls:

- `workflowMessage.reportBranch` reports active-branch workflow message IDs with Pi entry IDs, `isIdle`, and `hasPendingMessages`. The report is bounded to message IDs in the complete origin-session view window. The host adopts entries, closes proved-lost turns, and creates a missing message of the source's own kind.
- `workflowTurn.report` records the start or end of one model turn against an open sent message.

The host keeps one active coordinator connection and process-local epoch for each origin session. A replacement connection fences the old one. Only the active epoch receives the next eligible message or can report branch and turn state. This prevents two Pi processes that opened the same session from sending concurrently without adding durable per-message claim state.

The extension has one `WorkflowMessageCoordinator`. It performs these steps:

1. After every host connection, wait for the complete origin-session view and report the active branch before any send or turn report.
2. Wait until the host view names the next eligible pending message, Pi is idle, and Pi has no queued user input.
3. Keep that message ID in the coordinator's in-memory queued map.
4. Check the active branch for the same hidden workflow message ID and report it when found.
5. Recheck synchronously that Pi is still idle, has no pending input, the message is absent from the active branch, and the connection still owns the active session epoch.
6. Call documented `pi.sendMessage()` with the custom type and turn behavior for the message kind, with no `await` between the final check and the call.
7. Keep the message ID queued until the new Pi entry is visible.
8. Report the active branch so the host saves the Pi entry ID and changes the message to `sent`.

The coordinator sends one message at a time. A poll can discover work, but it cannot send an ID in the in-memory queued map. The host orders messages by session and saved order. A later eligible message cannot pass an earlier eligible message.

Pi can emit `agent_start` before the host records the new session entry. The coordinator keeps that start and any matching end in its in-memory session map. It first records the workflow message as `sent`, then reports the saved turn events in order. It does not drop a turn event because host confirmation was still in progress.

`pi.sendMessage()` does not return the saved Pi entry ID. Branch evidence therefore confirms a send. A visible entry with the hidden workflow message ID is `sent`, even when a lifecycle transaction marked that message `cancelled` before the evidence arrived.

The extension can prove only active-branch absence, and only when the branch has no matching hidden ID, `ctx.isIdle()` is true, and `ctx.hasPendingMessages()` is false in the same synchronous observation. A pending message is never sent before this check. If Pi or the extension disappears after `pi.sendMessage()`, the message stays `pending`; reconnect always reports the branch before another send. These rules do not prove cross-branch absence or exactly-once model execution.

### Feature state stays separate

The unified table replaces only the fields and tables that control adding content to Pi:

- replace the `notifications` send state;
- replace `turn_intents` as the message-send record;
- replace `workflow_follow_ups` send state;
- remove presentation claim and Pi entry fields from `interactive_requests`.

The feature records remain authoritative for their own work:

- `interactive_requests` keeps contracts, deadlines, submissions, validation, and `unproductiveTurnEnds`;
- human decision records keep choices, verified answers, expiry, and continuation;
- terminal run records keep outcome, reason, restart history, and result;
- settings records keep values and accepted changes;
- notification nodes keep their node result;
- follow-up source and authority remain bound to the run.

## Model-turn activity

The extension reports model activity from Pi's documented lifecycle events. It does not use a timer, activity lease, refresh loop, or sequence number.

### Open-message rule

`agent_start` has no message payload, so the extension and host use one closed rule:

- the latest sent `step` message is open while its interaction and attempt remain pending and its run is not paused;
- a sent `terminal` message is open until its first reported turn ends;
- a sent `followUp` message is open until its first reported turn ends;
- `decision` and `notification` messages never open a model turn.

The host rejects a start against a closed message. A normal user turn after a terminal turn has ended does not bind to the terminal message. A follow-up turn is reported for ordering and recovery, but it remains normal conversation work and does not change workflow display status to `running`.

### Start

On `agent_start`, the extension binds the event to the one open message in the current origin-session view. Turn binding does not inspect the active branch because `agent_start` has no message payload; only branch reporting and re-presentation use branch membership. The extension creates `workflowTurnId`, keeps it through the matching `agent_end`, and reports:

```ts
{
  operation: "workflowTurn.report",
  state: "started",
  workflowMessageId,
  workflowTurnId,
  runId,
  targetSessionId,
}
```

If the session view or branch confirmation is still loading, the extension buffers the start and matching end. It reports them in order after the message is confirmed `sent`. A start that still has no open workflow message after the view loads is unrelated normal work and is discarded.

Any model turn that starts while a step interaction is pending and its run is not paused is workflow work because public `agent_start` has no message payload. The extension creates a new turn ID and binds it to the latest open step message. The accepted start transaction cancels every pending step message for that request that the manual turn supersedes.

### End

On `agent_end`, the extension derives `stopReason` as `completed`, `aborted`, or `error` from the documented assistant messages in the event. It reads response-entry evidence from `ctx.sessionManager.getBranch()` after the event; the entry ID can be null. It reports `ended` with the same turn ID, stop reason, and available evidence.

The host applies the end and its workflow consequence in one transaction:

- `aborted` sets the run pause and cancels the interaction's pending step messages; the interaction derives its paused state from the run;
- `completed`, recoverable `error`, and proved `lost` apply the bounded unproductive-turn rule only when the submitted-output step is pending, not paused, and has no accepted or validating submission;
- that rule increments `unproductiveTurnEnds`; a value of one or two creates one `step` message with reason `reminder`, while a value above two fails the attempt with a clear error;
- a partial unique index permits at most one pending `step` message for one request, regardless of display reason;
- accepted submission, pause, cancel, timeout, and branch re-presentation cancel all pending step messages for the request;
- rejected validation after a saved turn end can apply the same rule;
- a cancelled message never started a turn and does not increment the counter;
- terminal and follow-up messages close after their first end.

The transaction stores one immutable end event, updates activity, and creates or cancels messages together. Repeating the same report adopts that result. A stale or different turn ID cannot end newer activity.

The host clears process-local activity when the client disconnects. Host startup does not close a Pi turn because the host cannot know whether Pi is still working. On `session_start`, the extension reports the active branch before new sends. If Pi is still busy, it reports `started` again with the retained turn ID. Only an idle-session branch report can close an open sent message with synthetic `stopReason: "lost"`. A lost step follows the normal unproductive-turn rule. A lost terminal or follow-up closes without reopening the completed workflow.

### Display rule

The host remains the only status reducer.

- A live supervised worker is `running`.
- A live Pi model turn for a step or terminal message is `running`.
- `waiting` means the workflow needs origin-session input and no matching worker or model turn is active.
- `paused` requires a durable pause and the matching turn end.
- Terminal status appears when no terminal presentation turn is active.
- A follow-up starts normal conversation work and does not reopen or display the completed workflow as running.

Every renderer receives the same status, activity, reason, and controls from the host.

## Terminal result retention

The session view selects the active reserved run first. If no run owns the session, it returns the most recent terminal run while its terminal message is pending or its first model turn is open. After that turn ends, the view retains the run for 60 seconds. A terminal run leaves the session view only when one of these events occurs:

- 60 seconds pass after the terminal message's first model-turn end;
- a newer workflow starts in the session;
- a verified operator calls `sessionView.clearTerminal`, exposed as `/workflow clear` and the matching `piw` control.

The clear command changes only the retained view. It does not change the run, message, or result.

A retained terminal view has no pause, resume, answer, cancel, or review authority unless the durable run independently permits that control. Retention does not keep a lease, worker, interaction, or session reservation.

The widget and status line clear from the host view. They do not run their own retention timers.

## Behavior to restore

### Terminal turn and safe restart

A top-level terminal outcome is the final outcome of one interactive root run and its checkpoint-continuation chain. A parent that is settled by a continuation does not create a terminal message. The chain leaf that reaches the final outcome creates one `terminal` workflow message in the same transaction as that outcome. Retention selects the most recent terminal leaf in the chain.

This applies to:

- completed runs, with or without `presentationPrompt`;
- failed runs;
- timed-out runs;
- cancelled runs;
- launch failures;
- claim loss when safe handoff is impossible and the host commits a terminal result;
- controller interruption.

An ordinary claim transfer remains a handoff and creates no terminal message. A stale owner cannot create one.

The message includes the saved input, result, terminal reason, workflow identity, restart count, and earlier terminal outcomes. Workflow data remains quoted data in the prompt.

That one turn presents the result and lets the model choose the next safe action. The model can finish with a normal response, start an authorized workflow, use Monitor for an external wait, or request a safe restart. It must stop when work is complete, the user cancelled, authority is missing, a human decision is required, or the same failure repeated.

Restore the `restart` workflow-tool action. Restart creates a new immutable run with the same approved input and saved workflow identity. The host records parent and root run IDs, restart number, and the parent terminal fingerprint. It rejects:

- restart after cancellation;
- more than three restarts;
- a repeated terminal fingerprint in the same chain;
- a second launch from the same terminal turn;
- stale, replaced, or unauthorized terminal turns.

### Step reasons, reminders, and resume

The initial prompt, reminders, and resumed prompts are all `step` workflow messages for the same interaction request and attempt. Their custom details contain `reason: "initial"`, `"reminder"`, or `"resumed"`. The reason changes the card label only. Eligibility, ordering, sending, recovery, and turn tracking use the same `step` rules.

The request stores `unproductiveTurnEnds`, initially zero. A completed, recoverably failed, or proved-lost turn with no accepted or validating submission increments it. Values one and two create one reminder-reason step. A value above two fails the attempt. Polling and cancelled unsent messages do not change the counter. A partial unique index on the step source enforces one pending step message per request without reading the reason from the content blob.

Resume clears the pause and creates one step message. Its reason is `resumed` when the request has a sent step message and `initial` otherwise. Repeated resume commands adopt the same message. A run that is already working reports `alreadyRunning` and creates no message.

On `session_tree`, the coordinator reports the active branch. If a pending interaction has no entry for that interaction on the active branch, the host cancels its pending step messages and creates one resumed-reason step for that branch. If a pending decision is absent, the host creates one new `decision` message instead. Repeating the same branch report creates no duplicate. Switching back to a branch that already contains an entry for the source creates no new message.

Assistant-message steps keep their existing visible-response rules. They do not use the submitted-output reminder rule.

### Follow-up prompts

Restore these workflow-tool actions and slash commands:

- `queue-follow-up`;
- `remove-follow-up`.

Controllers keep their existing typed methods. All callers use the same host command path and authority checks.

Acceptance creates the `workflow_follow_ups` source record and one `followUp` workflow message in the same transaction. The source run and message stay attached to the chain member that accepted them; continuation does not rewrite either row. The host walks the continuation chain to decide the final source outcome. No terminal or earlier-message pointer is required. The host makes the next follow-up eligible only when:

- the source workflow completed successfully;
- its terminal turn ended;
- every earlier follow-up is cancelled or its turn ended;
- no nonterminal workflow, including a run waiting for a checkpoint or protected decision, currently reserves the origin session.

If a follow-up starts another workflow, that new run reserves the session and blocks the next follow-up until it becomes terminal. Failed, timed-out, and cancelled source runs cancel every unsent follow-up.

A follow-up uses the same documented `pi.sendMessage()` path and starts normal conversation work. Its custom details keep the internal workflow message ID out of provider-facing content and let restart recovery find the exact Pi entry. Because public `pi.sendMessage()` does not dispatch extension slash commands or expand prompt templates, a queued slash-looking string remains plain model input. It cannot resume the completed workflow.

Removal changes the source record and pending workflow message to `cancelled` in one transaction. Cancelled items are satisfied for ordering. A sent follow-up cannot be removed.

### Live settings

Restore `change-settings` in the workflow tool and `/workflow` command. The host remains the only writer.

A change:

- uses RFC 6902 JSON Patch;
- checks scope, actor, allowed paths, and expected change number;
- commits atomically;
- affects only later attempts and routes;
- never changes immutable input, completed work, or a running node;
- returns the same stored receipt on an identical retry.

The step prompt includes only settings paths and values that the actor can read. Actor identity comes from the host connection and command source, not model input.

### Human decisions and Telegram

Keep the current protected Pi decision path. A `decision` workflow message displays the complete approved presentation without starting a model turn. A verified answer still enters through the existing host decision command.

Restore:

- `/workflow-channel setup`;
- `/workflow-channel status`;
- `/workflow-channel reload`;
- Telegram presentation;
- verified Telegram answers;
- expiry, settlement, and duplicate protection.

The host supervises channel adapter children. The private protocol has `channel.ready`, `channel.present`, `channel.answer`, `channel.settle`, and `channel.exiting` messages. Each state-changing message includes the channel profile, saved request or settlement record, expected revision, and stable message ID. Channel children receive only the approved presentation and private channel configuration needed for their work. They do not open SQLite, load workflow code, change runs directly, or receive the decision subject. The host validates and saves every claim and receipt.

A pending external-channel decision is unsettled work and keeps the on-demand host and its adapter child alive until answer, expiry, cancellation, or explicit channel shutdown.

Credentials remain in their existing private files. The change does not copy, print, or move a token.

### Session history in `piw`

Restore workflow-related Pi conversation recording through one batched host client operation. The extension uses documented Pi events and sends only records associated with an active workflow range:

- turn start and end;
- message start and end;
- settled prompt and assistant entries;
- tool start and result.

The host writes the existing `session_segments`, `session_entries`, and `session_events` tables. It deduplicates settled entries by Pi entry ID and binds each workflow attempt to its first and last entries. A capture failure does not fail workflow execution.

The extension does not read or edit Pi session files. Raw session content remains excluded from normal status output.

### Widget, status, and command details

Restore these details from the host view:

- current node ID in the status line;
- display reason and allowed controls;
- progress history from durable `update` records;
- transient Pi notices when a workflow parks, needs a human decision, or reaches a terminal state;
- paged model-facing workflow lists through the existing `offset` input;
- `resumable`, `alreadyRunning`, and clear pause details in status responses;
- the friendly response for an already-answered checkpoint;
- clearing a retained terminal widget when the user explicitly cancels or clears it.

Restore TypeScript viewer step scrubbing and its one-second elapsed-time redraw. Keep Rust and TypeScript layout behavior aligned where both render the same information.

## Existing behavior to preserve

- Notify nodes remain passive and do not start a model turn.
- One workflow message can create at most one confirmed Pi session entry.
- One origin session presents one workflow message at a time.
- Protected human decisions cannot be answered by the model-facing tool.
- Escape pauses only the exact matching workflow turn.
- Pause, cancel, answer, update, and submit remain durable host commands.
- A pending interaction on a paused run rejects update and submit until resume.
- Workflow and controller code remain in supervised children.
- Side effects remain idempotent or explicitly ambiguous.
- `/piw`, `Ctrl+Shift+R`, Herdr placement, and widget scrolling remain available.
- Local and remote `piw` use the same client protocol and exact run view.

## State change

This is an alpha hard cut. Keep all current schema identifiers at version 1 and replace the old message-send contracts in place.

The implementation must:

1. Add `workflow_messages` as the only table that owns Pi message sending, with no sender, send lease, `sending` state, or `sentAt` field.
2. Add the partial unique index for one pending step message per interaction request.
3. Convert runtime code to create workflow messages in the same transaction as the source event.
4. Remove `notifications`, `turn_intents`, and `workflow_follow_up_queues`.
5. Remove presentation claim and Pi entry fields from `interactive_requests` and send state from `workflow_follow_ups`.
6. Keep pause state only on the run and derive whether its pending interaction is paused.
7. Remove the old interaction, notification, turn, and follow-up send operations from the client protocol.
8. Add active-branch and model-turn report operations to `pi-workflows.client.v1`.
9. Remove all dead send coordinators and unused channel code after their replacements work.

Do not add a migration or read old state. On incompatible state, fail before mutation with the standard backup-and-reset instruction. Leave the old database untouched. The release notes must name the exact backup and reset commands.

## Implementation order

### Unify workflow messages first

- Add the version-1 workflow message contract and table.
- Add `workflowMessage.reportBranch` and `workflowTurn.report`.
- Add one process-local active coordinator epoch per origin session.
- Convert steps, decisions, notifications, terminal turns, and follow-ups.
- Replace the separate extension senders with `WorkflowMessageCoordinator`.
- Remove the superseded send fields, tables, protocol operations, and coordinators in the same hard-cut change.

The later status work binds only to `workflow_messages`. Do not implement a temporary binding to `interactive_requests` or `turn_intents`. Do not release or merge a state in which both message paths remain selectable.

### Fix model activity and terminal display

- Replace activity leases and refreshes with the open-message rule and buffered `agent_start` and `agent_end` reports.
- Derive the end stop reason from documented assistant messages and read response entries from the active branch.
- Apply turn end, pause, the unproductive-turn counter, and step-message cancellation in one transaction.
- Reconcile lost turns and branch changes through documented session events.
- Show activity-report failures once with bounded text.
- Restore terminal run selection and `sessionView.clearTerminal`.
- Create one terminal message for each final interactive chain outcome.

### Restore model and user controls

- Restore initial, reminder, and resumed prompts through one step-message kind.
- Restore terminal restart and lineage.
- Restore live settings commands and tool actions.
- Restore follow-up commands and tool actions.
- Restore status fields, list paging, widget updates, and transient notices.

### Restore channels and viewer history

- Run Telegram adapters as supervised children.
- Restore channel setup, reload, delivery, answer, and settlement.
- Add batched session recording through the host client.
- Restore conversation panes and viewer controls.
- Remove any remaining dead channel or recorder code.

### Update reference documentation

Update [Workflow host](WORKFLOW_HOST.md), [Workflow messages in Pi](WORKFLOW_STEP_MESSAGES.md), [SQLite state](SQLITE_STATE.md), [Live client protocol](live-replay-protocol.md), [Deferred workflow turns](DEFERRED_TURNS.md), [workflow follow-ups](2026-08-25-workflow-follow-ups.md), [workflow settings](2026-08-25-workflow-settings.md), [Human decisions](HUMAN_DECISIONS.md), [Human decision presentations](HUMAN_DECISION_PRESENTATIONS.md), [Session event journal](session-event-journal.md), [Rust TUI viewer](tui-viewer.md), the earlier host plans, the authoring reference, and README to match the implementation.

Remove temporary current-version warnings only after live checks pass.

## Tests

### Status and view tests

- Keep one model turn active for longer than ten seconds and prove every view stays `running`.
- Let the old four-second interval pass without any heartbeat mechanism.
- Start a second user turn on the same pending unpaused step and prove it shows `running` and cancels the pending reminder-reason step that it supersedes.
- Start an unrelated turn while the run is paused and prove it does not bind to the workflow.
- Submit during a model turn and prove status remains `running` until `agent_end`.
- Emit an aborted end and prove pause and pending step-message cancellation commit together.
- Accept and reject a submission around turn end and prove no stale reminder-reason step survives.
- Emit `agent_start` and `agent_end` before the message receipt or session view finishes and prove both reports are applied in order.
- Reject a start against a closed terminal message and report a follow-up turn without showing the completed workflow as `running`.
- Disconnect and reconnect the host client during a turn.
- Restart only the host during an active Pi turn and prove it does not mark the turn `lost`; then restart Pi and prove an idle-session branch report closes the unended turn as `lost`.
- Prove `waiting` appears only when no matching worker or turn is active.
- Prove `paused` appears only after the host accepts pause.
- Keep a terminal result visible while its terminal message is pending or its first turn is open, then for 60 seconds after that turn ends; replace it immediately when another run starts.

### Workflow message tests

- Cover every message kind and every state transition.
- Hold Pi busy with an eligible pending message and prove no duplicate message appears.
- Crash before send, after send, and before the Pi entry ID is recorded.
- Adopt an existing branch entry after Pi, extension, or host restart.
- Prove active-branch absence only when no hidden ID exists, Pi is idle, and Pi has no pending messages.
- Replace the active session coordinator and prove the old connection cannot send or report state.
- Disconnect after send but before branch proof, keep the message `pending`, reconnect, report the branch before any send, and adopt the existing entry.
- Restart only the host while Pi remains open and prove the reconnect branch report resolves pending message evidence.
- Reject stale session coordinator epochs, wrong-session branch reports, and mismatched turn-end reports.
- Cancel a pending message through its source lifecycle, then report a late matching Pi entry and prove evidence changes it to `sent`.
- Prove the model never receives workflow message IDs or internal send state.

### Restored feature tests

- End two turns without submission, receive two step messages with reason `reminder`, and fail after the next unproductive turn.
- Pause and resume a presented step and receive one step message with reason `resumed`.
- Prove initial, reminder, and resumed prompts use the same message kind, contract, attempt identity, eligibility, and recovery path.
- Prove the partial unique index allows at most one pending step message per request for every reason.
- Complete, fail, time out, cancel, fail launch without recoverable handoff, and interrupt through a controller; receive one terminal turn in each case.
- Settle a checkpoint parent through a continuation and prove only the final chain leaf gets a terminal turn.
- Restart safely, reject a fourth restart, and reject a repeated terminal fingerprint.
- Queue and remove follow-ups, then send remaining prompts once in order without pointer deadlock.
- Start a workflow from one follow-up and prove its session reservation blocks the next follow-up.
- Keep a slash-looking follow-up as plain model input.
- Change settings during a run and prove only later attempts use the new value.
- Answer one protected decision through Pi and one through a fake Telegram adapter.
- Keep the host alive while an external decision remains pending.
- Clear a retained terminal view without changing its terminal run or message.
- Record conversation entries and events and display them in `piw`.
- Restore status details, progress history, list paging, and viewer controls.

### Live Pi checks

Use a new Pi session with only the packed pi-workflows extension installed.

1. Start a real-model workflow and keep its model turn active for more than ten seconds.
2. Confirm the Pi widget, status line, and `piw` all show `running` throughout.
3. Exercise reminder, Escape pause, resume, terminal recovery, restart, settings, and follow-ups.
4. Complete the workflow and watch the result remain for 60 seconds after the terminal turn ends.
5. Restart Pi with a presented step and confirm that the existing message is adopted and its lost turn recovers.
6. Confirm one Pi entry and at most one automatically triggered model turn for each workflow message ID. A later manual turn uses a new workflow turn ID.
7. Switch Pi branches during a pending step and confirm one resumed-reason step appears only on a branch with no entry for that interaction.
8. Run `piw <runId> --once` during and after each state and compare it with the widget.

The live script must accept any provider and model supported by base Pi. OpenAI and `openai-codex` remain separate providers. The script must not depend on personal extensions or wrappers.

## Required checks

Run:

```bash
npm run check
npm run test:e2e
npm run test:e2e:live -- --runtime-only
git diff --check
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
cargo test --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path tui/Cargo.toml --check
```

Run one real-model live test with an explicit provider and model. Run Pi Reviewer against the base branch until no P0 or P1 finding remains. Check pull-request comments and CI before release.

## Completion criteria

The work is complete when:

- the host owns every workflow message before Pi sends it;
- one extension component sends every workflow message kind;
- all replaced send paths are removed;
- the widget, status line, CLI, and `piw` agree on activity and status;
- active model turns never fall back to `waiting`;
- terminal results remain visible for the defined period without retaining authority;
- initial, reminder, and resumed step prompts, terminal recovery, restart, settings, follow-ups, protected decisions, Telegram channels, and conversation recording work through the host;
- all restored command details and viewer behavior have tests;
- old incompatible state fails without mutation and gives a clear backup-and-reset instruction;
- no Pi core change, direct live SQLite client, embedded executor, second runtime, or compatibility path exists;
- local checks, live Pi tests, review, and CI pass.
