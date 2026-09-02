# Terminal workflow messages

> **Current version notice:** Version 0.16.0 does not send the terminal and recovery message on every path described here. The approved [workflow-message restoration plan](2026-09-02-unify-workflow-messages-plan.md) implements this contract through `workflow_messages`.

This specification defines the final Pi message for an interactive workflow. It replaces the separate deferred-turn and `workflow_turn_intents` design. Terminal messages use the same host state, client operations, and extension coordinator as all other [workflow messages](WORKFLOW_STEP_MESSAGES.md).

The earlier [deferred-turn plan](plans/2026-08-21-deferred-turn-intents-plan.md) and [terminal restart plan](plans/2026-08-27-workflow-terminal-restart-plan.md) remain historical design records. This document is the current contract.

## Terms

- **Continuation chain:** One interactive workflow and the runs created to continue its checkpoints.
- **Final run:** The last run in the continuation chain.
- **Terminal outcome:** The final run's completed, failed, timed-out, or cancelled result.
- **Terminal workflow message:** The one model-facing message that reports the terminal outcome and offers valid next actions.
- **Restart:** A new immutable run created from an allowed action in the terminal turn.

## Core rule

The host creates one `terminal` workflow message in the same transaction that records the final terminal outcome. Only the final run in a continuation chain creates this message. A parent settled by a continuation does not create one.

The terminal message uses the same `workflow_messages` table and `WorkflowMessageCoordinator` as steps, decisions, notifications, and follow-ups. Initial, reminder, and resumed prompts are one step-message kind. There is no `workflow_turn_intents` table, deferred-turn sender, terminal sender, or second send path.

The terminal message records the factual outcome before it starts a model turn. It does not keep the old assistant turn alive and does not delay cancellation or process cleanup.

## Outcomes

A terminal message can report:

- successful completion;
- workflow failure;
- timeout with no recovery edge;
- cancellation;
- launch or worker failure that became the final run outcome.

Pause, Escape, a waiting checkpoint, a nonfinal continuation parent, user hold, and normal host shutdown do not create a terminal message.

A claim loss is a handoff. It creates no terminal outcome or terminal message unless later recovery proves that the run itself failed.

## Message content and controls

The message names the outcome and the run. It contains only controls valid for that saved outcome. A successful final run can offer follow-up work. A failed or timed-out final run can offer an allowed restart. A cancelled run offers no restart. An ambiguous external effect remains parked and creates no terminal message until explicit recovery produces a real terminal outcome.

A restart creates a new run. It does not reopen or mutate the terminal run. It keeps the approved input and source identity, uses a stable action fingerprint, rejects duplicate activation, and stops after three restarts in one chain.

The terminal result remains visible in the origin-session view while its terminal workflow message is pending or its first model turn is open, and then for 60 seconds after that turn ends. This display retention gives no claim, queue reservation, or execution authority. A new run in that session replaces it immediately. A verified operator can also clear it through `sessionView.clearTerminal`, exposed by `/workflow clear` and `piw`.

## Turn tracking

A terminal workflow message is open only until its first model turn ends. The extension reports the matching `agent_start` and `agent_end` through `workflowTurn.report`.

The end report includes `stopReason: "completed"`, `"aborted"`, or `"error"`. Response-entry evidence comes from `ctx.sessionManager.getBranch()` after `agent_end` and can be null. A repeated report adopts the stored result. A stale turn ID cannot end a newer turn.

If Pi restarts after a terminal message was sent but before its end was reported, the extension's idle-session active-branch report records a synthetic end with `stopReason: "lost"`. Host restart alone does not close the turn. The terminal result remains durable and visible, but the host does not pretend that the model turn completed.

## Sending and recovery

After every host connection, the coordinator waits for the complete origin-session view and reports the active branch before it sends a workflow message or reports a model turn. The host gives the next eligible pending message only to the active coordinator epoch for that session. A replacement connection fences the old one.

The coordinator waits until Pi is idle and has no pending messages. It keeps the terminal workflow message ID in its in-memory queued map, checks the active branch, and reports a matching entry before any send. Otherwise, it performs one final synchronous check that Pi is idle, has no pending input, the message is absent, and its connection still owns the active epoch. It calls documented `pi.sendMessage()` without an `await` between that check and the call.

A matching hidden workflow message ID in the active branch proves that Pi accepted the message. The host records the matching Pi entry ID and changes the message to `sent`, even if its source cancelled it after the send. If the extension reloads, it reports the active branch and adopts that entry before another send.

Absence is usable only when all three facts are true:

1. the active branch has no matching hidden workflow message ID;
2. `ctx.isIdle()` is true; and
3. `ctx.hasPendingMessages()` is false.

If Pi or the extension disappears after `pi.sendMessage()` but before the branch report, the message stays `pending`. A replacement extension reports the active branch before it sends. Documented Pi APIs do not prove cross-branch absence or exactly-once model execution. Pi Workflows guarantees its saved message identity, active-branch evidence, and recovery decisions. It does not claim more.

## Follow-ups

Successful completion can have ordered [follow-up prompts](2026-08-25-workflow-follow-ups.md). They use the same workflow-message coordinator.

A follow-up is eligible only after:

- the final run is successfully completed;
- its terminal workflow message has been sent;
- the terminal model turn has ended;
- every earlier follow-up is settled or cancelled; and
- no nonterminal run reserves the origin session.

A follow-up turn is reported for ordering and recovery, but it does not make the completed workflow display as `running`.

## State and compatibility

This is an alpha hard cut in `pi-workflows-state` schema version 1.

- `workflow_messages` owns terminal message content, `pending`, `sent`, or `cancelled` state, Pi entry evidence, and turn reports.
- Run and continuation rows own terminal outcomes and chain identity.
- `workflow_follow_ups` owns accepted follow-up source prompts and cancellation only.
- `workflow_turn_intents` and `workflow_follow_up_queues` do not exist.

The DDL digest changes in place. There is no migration, compatibility reader, dual path, fallback sender, alias, feature flag, or second schema. Incompatible state remains untouched and fails with the standard backup-and-reset instruction.

## Conformance

An implementation conforms when:

- one continuation chain creates at most one terminal workflow message;
- only the final run creates that message;
- every terminal outcome uses the shared workflow-message path;
- a busy Pi session cannot cause duplicate terminal messages or model turns;
- reload reports the branch and adopts an existing active-branch entry before another send;
- unproved absence leaves the message `pending` and cannot cause a retry before branch reporting;
- a stale or disconnected coordinator epoch cannot send or report message state;
- active-branch evidence changes a matching pending or cancelled message to sent;
- an unended sent message receives a synthetic `lost` end only from an idle-session branch report after Pi restart;
- terminal status remains visible while its message is pending or its first turn is open, and then for 60 seconds after that turn ends, without retaining workflow authority;
- restart creates one separate run and never mutates the terminal run;
- follow-ups wait for the terminal turn and use the same coordinator; and
- no deferred-turn table, sender, or production fallback remains.
