# Workflow messages in Pi

This page describes workflow delivery, including the post-workflow model turn and bounded submission reminders from the [workflow recovery plan](2026-09-08-workflow-recovery-plan.md).

## Goal

Pi Workflows must add several kinds of content to an origin Pi conversation. These include interactive step prompts, protected human decisions, passive notifications, terminal results, and follow-up prompts. Initial, resumed, and reminder prompts are one step-message kind with different display reasons.

The server saves all of them as workflow messages. One extension component sends them through documented Pi APIs. Feature records continue to own workflow results, answers, settings, and timeouts.

The model receives complete instructions when a workflow message starts a turn. The user sees a compact card for structured workflow content and can expand it.

## Workflow message contract

A workflow message is content that Pi Workflows requires Pi to add to one conversation. It does not mean every message in that conversation.

The message kinds are:

| Kind           | Pi behavior                                      | Purpose                                    |
| -------------- | ------------------------------------------------ | ------------------------------------------ |
| `step`         | Custom message that starts a model turn          | Initial, resumed, or reminder prompt       |
| `decision`     | Custom message that does not start a model turn  | Protected choice for a person              |
| `notification` | Custom message that does not start a model turn  | Passive workflow notice                    |
| `terminal`     | Starts a model turn unless explicitly cancelled | Recorded result and bounded recovery       |
| `followUp`     | Custom message that starts normal work           | Work saved for after successful completion |

The server stores one `WorkflowMessage` record before Pi can send it:

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

The exact Pi content and custom display details remain in the content-addressed value store. `contentDigest` binds the record to those bytes. `sourceId` links the message to the feature record that created it.

`kind` determines the custom renderer, whether a model turn starts, and the server eligibility rule. The server does not store duplicate flags or message-to-message pointers for those facts.

`order` is the acceptance order for one origin session. The server marks one pending item as next in the origin-session view. An earlier ineligible or cancelled item does not block unrelated eligible work.

A source lifecycle transaction can change `pending` to `cancelled`. Active-branch evidence changes `pending` or `cancelled` to `sent`; evidence wins because Pi already contains the entry. `sent` is terminal. A pending message can be new or uncertain after a process stopped, so the coordinator always checks the active branch before sending it.

Workflow message IDs and internal send state are not included in provider-facing prompt content. The hidden custom-message details contain only the stable workflow message ID needed for branch recovery.

## Agent step card

Every step message uses the custom type `pi-workflows-step`:

```ts
export type WorkflowAgentStepMessageDetails = {
  schema: "pi-workflows.agent-step-message.v1";
  workflowMessageId: string;
  reason: "initial" | "resumed";
  contract: AgentStepContract;
  presentation?: {
    runTitle?: string;
    statusDetail?: string;
  };
};

pi.sendMessage(
  {
    customType: "pi-workflows-step",
    content: completeModelPrompt,
    display: true,
    details,
  },
  { triggerTurn: true },
);
```

`content` is the complete provider-facing prompt. It includes the task, workflow identity, attempt identity, output form, and completion rules.

The renderer reads `details` and does not parse the prompt. It shows a compact summary by default and the complete prompt when expanded. If the renderer is unavailable, Pi still retains the custom message and its content.

Submitted agent steps call `workflow submit` or `workflow update` with the exact `requestId`. Assistant-message steps reply normally and are accepted only through the separate assistant-response path at `agent_settled`. Ordinary checkpoints accept `answer`; protected decisions accept only the verified human path or their declared timeout policy. Both forms keep the existing `agent` node and use `expectedOutput` to select the completion form.

## Engine boundary

The workflow engine remains independent of Pi. It produces an `AgentStepRequest` with a complete prompt and structured contract. One pure formatter builds the same provider-facing prompt for interactive and RPC execution. The extension does not shorten or rebuild it from display fields.

When a workflow has live settings, the formatter adds the settings scope, change number, bounded current value, allowed model paths, and exact `change-settings` action. It also adds the `queue-follow-up` and `remove-follow-up` actions. Actor identity is not model input. The extension derives it from the documented tool call.

An assistant-message step parks for its origin Pi session. A detached run without an approved origin session fails before it creates that message.

## Compact display

A collapsed step card shows only the workflow identity and current work. For example:

```text
▶ monitor › check
Checking the monitored target
```

A resumed prompt adds a short label:

```text
↻ monitor › check · resumed
Checking the monitored target
```

The card uses the run title when it is more useful than the workflow name. It omits missing detail and clips or wraps long text to the terminal width.

The expanded card shows the workflow name, run title, run ID, node ID, attempt ID, step reason, completion form, expected output, optional character limit, and complete model prompt. Expansion uses Pi's standard custom-message state and keys. Pi Workflows does not store another expansion setting.

Notifications keep the custom type `pi-workflows-notification` and use `triggerTurn: false`. Decisions and terminal results use their approved structured renderers. The message kind fixes each send policy; the coordinator cannot change it at run time.

## One sender

The extension has one `WorkflowMessageCoordinator` for all message kinds. The server keeps one active coordinator connection and process-local epoch for each origin session. A replacement connection fences the old one, so two Pi processes cannot send for the same session.

The coordinator retains only workflow-owned turns. Its local state is absent,
delivering, running, or settled awaiting acknowledgment. An ordinary chat turn
never creates an owned turn or blocks later workflow delivery. Recovery requires
an already recorded active workflow turn and its exact message as the latest
user or custom input in the active Pi branch. A delivered step with no active
workflow turn cannot claim a later ordinary chat response.
A delayed acknowledgment retains the same message, turn ID, and exact response;
it never creates another model attempt. Unconfirmed delivery stays visible as
unconfirmed instead of being reported as a received step.

The coordinator follows this sequence:

1. After every server connection, wait for the complete origin-session view and report the active branch before any send or turn report.
2. Wait until the server view names the next eligible pending message, Pi is idle, and Pi has no queued user input.
3. Save the message ID in the coordinator's queued map.
4. Search the active Pi branch for the same hidden message ID and report a matching entry.
5. Recheck synchronously that Pi is idle, has no pending input, the message is absent, and this connection still owns the active session epoch.
6. Call `pi.sendMessage()` with no `await` between that final check and call.
7. Wait until the new Pi entry is visible.
8. Report the active branch so the server saves its Pi entry ID and marks the message `sent`.

The coordinator sends only one workflow message at a time. A poll can find work, but it cannot send an ID already in its queued map.

Pi can emit `agent_start` before the server saves the new Pi entry ID. The coordinator keeps that start and any matching end in its in-memory session map. It first marks the workflow message `sent`, then reports the saved turn events in order. It does not drop a turn event while server confirmation is in progress.

A visible active-branch entry with the hidden ID is `sent`, even if the source lifecycle cancelled the message before the evidence arrived. Active-branch absence is usable only when the branch has no matching ID, Pi is idle, and Pi has no pending messages in the same observation. If Pi or the extension disappears after the send call, the message stays `pending`; reconnect reports the branch before another send. These rules do not prove cross-branch absence or exactly-once model execution.

After Pi, the extension, or the server restarts, branch reporting runs before any new send. It re-creates a message of the source's own kind only when the active branch has no entry for that source. A pending interaction gets one `step` with reason `resumed`; a pending decision gets one `decision`. Old incompatible workflow state is not reinterpreted.

## Model-turn status

`agent_start` has no message payload. A locally delivered prompt binds its start
through the coordinator's saved message identity. Reconnect requires the same
recorded active turn, run, session, and message, with no later user or custom
input in the active branch. Neither a session view nor an old branch entry alone
proves that a message caused the current turn.

Only pending, unpaused agent requests and explicit follow-ups can open model
turns. Decisions, notifications, and terminal notices cannot. A stale start can
adopt an already closed result but cannot create new activity. An identity
mismatch is rejected before a turn changes.

`agent_end` records low-level stop information. The coordinator retains the
workflow turn through automatic Pi retries and waits for `agent_settled` before
submitting visible assistant text, recording the turn end, or delivering more
work. End reports carry `completed`, `aborted`, `error`, or `lost` and the exact
response-entry evidence when available. A delayed acknowledgment keeps the settled
response ID pending. Once message and turn ownership are confirmed, the coordinator
submits that exact response before it reports the end. Later events cannot replace
the pending turn or its response. Repeated reports adopt the saved result.

The session view derives `cancelledWorkflowMessageIds` from cancelled agent requests and cancelled or removed follow-ups. It includes sent messages whose source was cancelled. This is a projection of existing records, not another durable state store. The coordinator calls public `ctx.abort()` once, only for its exact running owned turn. A rejected start acknowledgment follows the same stop-and-settle path. It never submits a result from the cancelled turn. Lost end acknowledgments retain that turn and its response without aborting later ordinary chat.

A terminal workflow outcome cancels pending messages but does not fabricate Pi turn settlement. Any open workflow turn blocks the next delivery until an end report or a valid idle branch observation closes it.

An aborted pending step pauses its run. Resume retains the request and attempt,
advances the request revision, and creates one resumed step message when needed.
A protected decision keeps its answer revision and decision message. A missing
submission stays pending: the host adds no reminder turn or hidden retry limit.

Durable execution status and the visible status remain separate. A completed run remains
completed during reporting or follow-up work. An agent request can remain durably waiting
while its workflow-owned Pi turn is active; the visible status is `running` during that work.
An active supervised runner also displays `running`. Without active workflow work, a pending
request displays `waiting`. Paused, ambiguous, and terminal states retain precedence. Ordinary
chat does not count as workflow activity. Response controls follow the exact pending request
in both running and waiting displays, not the visible label alone. Host
recovery closes active-time intervals at their last durable samples, not the Pi
turn itself. Only an idle-session branch report can prove an unended turn lost.

## Feature ownership

The workflow message stores only Pi send facts. Other records remain authoritative:

- interactive requests own exact response identity, kind, validation, and accepted submissions;
- node attempts and active intervals own execution history and the active-time budget;
- human decisions own choices, verified answers, and absolute expiry;
- terminal runs own outcomes, reasons, restart lineage, and results;
- notification nodes own their node results;
- follow-up records own prompt source and authority;
- settings records own current values and accepted changes.

Submitted and assistant-message steps keep their exact attempt while parked.
Recovery adopts accepted receipts and matching branch evidence; it does not use
the oldest pending request or accept text from another request or branch.

Requests and their required messages commit together. Terminal reporting can be
retried from recorded facts after execution settles; a reporting failure cannot
reverse execution or cancellation.

## Terminal results and follow-ups

A non-cancelled terminal result starts an owned model turn for explanation and
safe recovery. It stays in the origin-session view while pending or active and
for 60 seconds after settlement. Cancellation produces a passive terminal result.
A restart targets the terminal run and revision and creates fresh work without
copying old steps, changed settings, approvals, or effects. Automatic starts and
restarts from terminal turns share a two-launch limit per recovery chain. Each
terminal turn has a 15-minute active-time limit.

Explicit follow-ups wait for successful completion, successful terminal-turn
settlement, prior follow-up settlement, and release of the session reservation. They remain
normal conversation work. Slash-looking text cannot dispatch an extension
command. External effects still require saved receipts or explicit recovery of
an ambiguous outcome. See [terminal workflow messages](DEFERRED_TURNS.md).

## Session recording

The extension records workflow-related Pi events through a batched server client operation. It uses documented Pi events and does not read or edit Pi session files.

The server deduplicates settled entries by Pi entry ID. It links attempts to their prompt, response, first, and last entries. The coordinator finalizes capture after the terminal notice has a confirmed entry on the current branch, without starting a model turn. Explicit follow-up turns have their own capture segment. A recording failure does not fail workflow execution or block the next delivery.

## Public API boundary

The extension uses documented `pi.sendMessage()`, `pi.registerMessageRenderer()`, session lifecycle events, agent lifecycle events, widgets, status, commands, shortcuts, and session IDs.

This design does not change Pi core, use private Pi APIs, or change Pi session schemas. It does not add another database or runtime.

## Validation and tests

Tests must prove:

- every message kind uses the one coordinator;
- one workflow message ID adopts its confirmed Pi entry before another send;
- an automatic Pi retry cannot submit a partial response before the settled boundary;
- a later manual turn uses a new workflow turn ID without creating another Pi entry;
- two Pi processes that open one session cannot both send because one process-local coordinator epoch is active;
- restart recovery reports the branch and adopts an existing entry before it sends;
- branch absence is usable only when Pi is idle and has no pending input;
- a crash after send leaves the message pending and cannot cause a resend before branch reporting;
- messages remain in saved order without message-pointer deadlocks;
- an early `agent_start` and `agent_settled` wait for the message receipt and session view, then apply in order;
- model activity remains separate from durable execution status;
- normal runner progress leaves the active session capture open until the matching turn ends;
- stale turn-end reports and starts against closed messages are rejected;
- a manual turn cancels pending step messages that it supersedes;
- a turn cannot bind to an interaction whose run is paused;
- aborted pending turns pause without adding reminder work;
- resuming an aborted step creates one new resumed message and one fresh model turn;
- resuming a protected decision keeps its answer revision and does not create a duplicate decision message;
- server restart does not close a live Pi turn, while an idle-session branch report can close an unended turn as lost;
- repeated missing submissions remain pending without automatic extra model turns;
- initial and resumed prompts use the same step kind and differ only by reason;
- terminal messages never start turns, and follow-ups start only at their declared boundary;
- a branch switch creates one resumed-reason step only when that branch has no entry for the interaction;
- a missing protected decision creates another decision message, not a step;
- branch evidence changes a cancelled message to sent;
- a follow-up-started workflow blocks the next follow-up through its session reservation;
- cancelled owned turns abort once, and delayed acknowledgments cannot abort later ordinary chat;
- an expired command preserves partial work, stops before recovery, and cannot submit late success;
- terminal execution leaves an active Pi turn owned until actual settlement;
- notifications and protected decisions do not start model turns;
- the provider receives the complete step prompt but no workflow message ID or internal send state;
- collapsed and expanded cards remain safe and complete;
- session recording adopts each settled Pi entry once.

The real Pi end-to-end test must use a clean Pi home with only the packed pi-workflows extension. It must accept any provider and model supported by base Pi. `openai` and `openai-codex` are separate providers.

## Security

Workflow prompts and expected-output descriptions can contain untrusted text. Renderers treat them as text, wrap them safely, and do not interpret workflow control sequences or markup.

Collapsed cards hide full prompts from the normal conversation view. Expanded cards and Pi session files still contain the full content, so normal session privacy rules apply. Credentials, internal send state, and internal message IDs do not enter provider-facing content.
