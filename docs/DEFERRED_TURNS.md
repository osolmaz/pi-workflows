# Terminal workflow messages

A terminal message returns responsibility to the regular Pi model after workflow
execution ends. The model explains the result, checks whether the user's task is
complete, and can correct mistakes within existing permission. Explicit user
cancellation stops automatic continuation and produces a passive message instead.

## Execution and reporting

Each interactive run can produce one terminal message. Execution settlement commits
before reporting. A reporting failure cannot reverse cancellation, erase accepted
work, or leave execution cleanup waiting for a model. Pause, disconnect, and normal
server shutdown are not terminal outcomes.

The compact terminal card shows the workflow, status, and error. Its expanded view
contains the full saved result and recovery instructions. The regular model's reply
appears as normal assistant text. An explicit `assistantMessage()` node can still
provide a workflow-specific summary; the terminal turn should refer to it rather
than repeat it. A failed summary does not justify repeating successful work.

## Sending and ownership

Terminal messages use the same [workflow-message path](WORKFLOW_STEP_MESSAGES.md)
as steps and follow-ups. `triggerTurn` is true except for cancellation. One
`WorkflowMessageCoordinator` sends through documented `pi.sendMessage()` after
checking the coordinator epoch, active branch, idle Pi, and pending input.

Matching branch evidence confirms delivery. Reconnect adopts saved evidence before
sending again. The exact owned turn ends at `agent_settled`, not `agent_end`.
Completed execution remains terminal while its recovery turn is active. The view
shows that activity and a cancel control. Full turn recording is completed at the
same settlement boundary.

The public Pi APIs do not establish exactly-once model execution across arbitrary
branches. An interrupted recovery turn stops with a visible blocker rather than
replaying uncertain work. Explicit cancellation aborts only the owned turn and
retains ownership until Pi confirms settlement.

## Recovery limits and next work

An owned terminal turn may restart the exact run or start corrected work within
existing permission. Each terminal handoff can create only one recovery run;
repeated commands must adopt it. Both commands share a limit of two automatic
launches per recovery chain. A terminal turn has a 15-minute active-time limit; disconnected time
and server downtime are excluded. Saved counts and elapsed time survive reconnect.
These limits do not grant spending, merge, release, or deployment permission.

A restart targets `runId` and `expectedRevision`. It uses the original source and
input without copying changed settings, steps, approvals, or effects. Repeated
commands adopt the same child. Stale revisions and unsettled effects are rejected.
A later explicit user request can authorize fresh work after recovery stops.

Queued [follow-ups](2026-08-25-workflow-follow-ups.md) wait for their source run's
successful outcome, successful terminal-turn settlement, earlier follow-up
settlement, and release of the session reservation. They stay attached to their
original source rather than moving to a restart descendant. Cancellation or an
interrupted handoff prevents automatic delivery.

## Durable state

`runs` owns execution outcomes, restart ancestry, and automatic recovery source
references. `workflow_messages` owns delivery evidence and the recovery stop reason.
`workflow_turns` owns exact turn identity and active elapsed time.
`workflow_follow_ups` owns saved prompts. There is no separate recovery store or sender.

The [workflow recovery plan](2026-09-08-workflow-recovery-plan.md) supersedes the
no-turn behavior from the [durable execution plan](2026-09-06-durable-execution-plan.md),
while preserving same-run checkpoints and current ownership protections.
This alpha schema changes in place. Incompatible state stays untouched and fails
with the existing reset guidance; installation must not discard live work.
