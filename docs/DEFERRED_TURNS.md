# Terminal workflow messages

A terminal notice is a visible report of saved execution facts. It does not ask
Pi to call a model. It uses the same [workflow-message path](WORKFLOW_STEP_MESSAGES.md)
as steps, protected decisions, notifications, and explicit follow-ups.

```json
{
  "schema": "pi-workflows.workflow-message-content.v1",
  "customType": "pi-workflows-terminal",
  "content": "Workflow example: completed.\n{\"error\":null,\"finalOutput\":{\"done\":true},\"reason\":null}",
  "display": true,
  "details": {
    "workflowMessageId": "terminal-message-example",
    "runId": "example-run"
  },
  "triggerTurn": false
}
```

The server supplies the exact message ID, full recorded result, and terminal
facts. The example IDs above are placeholders, not IDs to reuse.

## Execution and reporting

Each interactive run can produce one terminal message. Completed, failed,
timed-out, and cancelled runs all use this path. Checkpoints complete in the
same run and do not produce terminal messages. Pause, session closure, claim
handoff, and normal server shutdown are not terminal outcomes.

Execution settlement commits before reporting. A failure to render or save the
notice cannot reverse cancellation, erase accepted work, or leave cleanup waiting
for a model. The host can retry deterministic reporting from the saved result.
Uncertain external effects remain uncertain even when a run is cancelled.

Use an explicit `assistantMessage()` graph node when a workflow needs a written
explanation. A terminal notice is not a substitute for that node and has no
`presentationPrompt` callback. Its message cannot start a workflow turn.

The origin-session view keeps the terminal result while its notice is pending
and for 60 seconds after confirmed delivery. This grants no execution claim or
session reservation. A new run replaces the terminal view. A verified operator
can clear it through `sessionView.clearTerminal`, `/workflow clear`, or `piw`.

## Sending and recovery

One `WorkflowMessageCoordinator` calls documented `pi.sendMessage()`. Before
sending, it requires the active coordinator epoch, a complete session view, an
active-branch report, idle Pi, and no pending Pi input. There is no asynchronous
boundary between its final checks and the send call.

A matching workflow message ID in the active branch proves delivery. The server
saves the Pi entry ID and marks the message `sent`. Reload adopts that evidence
before another send. Missing acknowledgment leaves the message pending, not
completed. The public Pi APIs do not prove absence on other branches or exactly-once
execution. Pi Workflows does not claim either guarantee.

Only explicit step and follow-up messages create model turns. Their completion
boundary is `agent_settled`; `agent_end` reports low-level activity only.

## Explicit next work

A queued [follow-up prompt](2026-08-25-workflow-follow-ups.md) is eligible after its
own source run completes, its terminal notice is sent, earlier follow-ups settle
or are cancelled, and no nonterminal run reserves the origin session. It does not
wait for a terminal model turn or follow a later restart descendant. It remains
normal conversation work and cannot change completed execution back to running.

A fresh restart requires an explicit user request. It targets the exact terminal
`runId` and `expectedRevision`, including a cancelled run when safe. It creates a
new run from the original input and source, without copying changed settings,
steps, approvals, or effect receipts. Repeated commands adopt the same child.
Stale revisions and unsettled effects are rejected before reservation. There is
no terminal-turn requirement or hard-coded restart count.

## Durable state

`runs` owns execution outcomes and explicit restart ancestry. `workflow_messages`
owns content, delivery state, and branch evidence. `workflow_turns` owns explicit
model-turn identity. `workflow_follow_ups` owns saved follow-up prompts.

The earlier [deferred-turn plan](plans/2026-08-21-deferred-turn-intents-plan.md) and
[terminal restart plan](plans/2026-08-27-workflow-terminal-restart-plan.md) are
historical. The [durable execution plan](2026-09-06-durable-execution-plan.md)
supersedes their continuation and automatic terminal-turn behavior.

This alpha contract changes in place. There is no compatibility reader, parallel
schema, fallback sender, or migration. Incompatible local state stays untouched
and fails with the backup-and-reset instruction.
