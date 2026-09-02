# Workflow messages in Pi

Status: this document defines the approved target. Version 0.16.0 still uses separate send records for steps, decisions, notifications, and terminal turns. It does not yet restore all behavior described here. See [Unify workflow messages and restore hosted behavior](2026-09-02-unify-workflow-messages-plan.md).

## Goal

Pi Workflows must add several kinds of content to an origin Pi conversation. These include interactive step prompts, protected human decisions, passive notifications, terminal results, and follow-up prompts. Initial, reminder, and resumed prompts are one step-message kind with different display reasons.

The host saves all of them as workflow messages. One extension component sends them through documented Pi APIs. Feature records continue to own workflow results, answers, settings, and timeouts.

The model receives complete instructions when a workflow message starts a turn. The user sees a compact card for structured workflow content and can expand it.

## Workflow message contract

A workflow message is content that Pi Workflows requires Pi to add to one conversation. It does not mean every message in that conversation.

The message kinds are:

| Kind           | Pi behavior                                     | Purpose                                          |
| -------------- | ----------------------------------------------- | ------------------------------------------------ |
| `step`         | Custom message that starts a model turn         | Initial, reminder, or resumed interactive prompt |
| `decision`     | Custom message that does not start a model turn | Protected choice for a person                    |
| `notification` | Custom message that does not start a model turn | Passive workflow notice                          |
| `terminal`     | Custom message that starts a model turn         | Final result and safe recovery choice            |
| `followUp`     | Custom message that starts normal work          | Work saved for after successful completion       |

The host stores one `WorkflowMessage` record before Pi can send it:

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

`kind` determines the custom renderer, whether a model turn starts, and the host eligibility rule. The host does not store duplicate flags or message-to-message pointers for those facts.

`order` is the acceptance order for one origin session. The host marks one pending item as next in the origin-session view. An earlier ineligible or cancelled item does not block unrelated eligible work.

A source lifecycle transaction can change `pending` to `cancelled`. Active-branch evidence changes `pending` or `cancelled` to `sent`; evidence wins because Pi already contains the entry. `sent` is terminal. A pending message can be new or uncertain after a process stopped, so the coordinator always checks the active branch before sending it.

Workflow message IDs and internal send state are not included in provider-facing prompt content. The hidden custom-message details contain only the stable workflow message ID needed for branch recovery.

## Agent step card

Every step message uses the custom type `pi-workflows-agent-step`:

```ts
export type WorkflowAgentStepMessageDetails = {
  schema: "pi-workflows.agent-step-message.v1";
  workflowMessageId: string;
  reason: "initial" | "reminder" | "resumed";
  contract: AgentStepContract;
  presentation?: {
    runTitle?: string;
    statusDetail?: string;
  };
};

pi.sendMessage(
  {
    customType: "pi-workflows-agent-step",
    content: completeModelPrompt,
    display: true,
    details,
  },
  { triggerTurn: true },
);
```

`content` is the complete provider-facing prompt. It includes the task, workflow identity, attempt identity, output form, and completion rules.

The renderer reads `details` and does not parse the prompt. It shows a compact summary by default and the complete prompt when expanded. If the renderer is unavailable, Pi still retains the custom message and its content.

Submitted agent steps call the `workflow` tool. Assistant-message steps reply normally. Both forms keep the existing `agent` node and use `expectedOutput` to select the completion form.

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

A reminder or resumed prompt adds a short label:

```text
↻ monitor › check · reminder
Checking the monitored target
```

The card uses the run title when it is more useful than the workflow name. It omits missing detail and clips or wraps long text to the terminal width.

The expanded card shows the workflow name, run title, run ID, node ID, attempt ID, step reason, completion form, expected output, optional character limit, and complete model prompt. Expansion uses Pi's standard custom-message state and keys. Pi Workflows does not store another expansion setting.

Notifications keep the custom type `pi-workflows-notification` and use `triggerTurn: false`. Decisions and terminal results use their approved structured renderers. The message kind fixes each send policy; the coordinator cannot change it at run time.

## One sender

The extension has one `WorkflowMessageCoordinator` for all message kinds. The host keeps one active coordinator connection and process-local epoch for each origin session. A replacement connection fences the old one, so two Pi processes cannot send for the same session.

The coordinator follows this sequence:

1. After every host connection, wait for the complete origin-session view and report the active branch before any send or turn report.
2. Wait until the host view names the next eligible pending message, Pi is idle, and Pi has no queued user input.
3. Save the message ID in the coordinator's queued map.
4. Search the active Pi branch for the same hidden message ID and report a matching entry.
5. Recheck synchronously that Pi is idle, has no pending input, the message is absent, and this connection still owns the active session epoch.
6. Call `pi.sendMessage()` with no `await` between that final check and call.
7. Wait until the new Pi entry is visible.
8. Report the active branch so the host saves its Pi entry ID and marks the message `sent`.

The coordinator sends only one workflow message at a time. A poll can find work, but it cannot send an ID already in its queued map.

Pi can emit `agent_start` before the host saves the new Pi entry ID. The coordinator keeps that start and any matching end in its in-memory session map. It first marks the workflow message `sent`, then reports the saved turn events in order. It does not drop a turn event while host confirmation is in progress.

A visible active-branch entry with the hidden ID is `sent`, even if the source lifecycle cancelled the message before the evidence arrived. Active-branch absence is usable only when the branch has no matching ID, Pi is idle, and Pi has no pending messages in the same observation. If Pi or the extension disappears after the send call, the message stays `pending`; reconnect reports the branch before another send. These rules do not prove cross-branch absence or exactly-once model execution.

After Pi, the extension, or the host restarts, branch reporting runs before any new send. It re-creates a message of the source's own kind only when the active branch has no entry for that source. A pending interaction gets one `step` with reason `resumed`; a pending decision gets one `decision`. Old incompatible workflow state is not reinterpreted.

## Model-turn status

`agent_start` has no message payload. The extension binds it through the current origin-session view. Turn binding ignores branch membership; only branch reporting and re-presentation inspect the active branch:

- the latest sent step is open while its interaction remains pending and its run is not paused;
- a terminal or follow-up message is open only until its first turn ends;
- decisions and notifications never open a turn.

A start against a closed message is rejected. Follow-up turns are reported for ordering but do not show the completed workflow as `running`.

The extension creates one workflow turn ID at `agent_start` and keeps it through the matching `agent_end` and host reconnect. It buffers starts and ends until the session view and message receipt are ready.

At `agent_end`, it derives `completed`, `aborted`, or `error` from the documented assistant messages. It reads response-entry evidence from `ctx.sessionManager.getBranch()`; the entry ID can be null. The host saves one immutable end result. A repeated report adopts it, and a stale turn ID cannot clear newer activity.

The host applies the end and its workflow consequence in one transaction. An aborted turn sets the run pause and cancels the request's pending step messages; the interaction derives its paused state from the run. A completed, recoverably failed, or proved-lost turn increments `unproductiveTurnEnds` only when the submitted-output step is pending, not paused, and has no accepted or validating submission. Values one and two create one step message with reason `reminder`; a value above two fails the attempt. A partial unique index enforces at most one pending step message for the request, regardless of reason. Acceptance, pause, cancel, timeout, and branch re-presentation cancel all pending step messages. A cancelled message did not start a turn and does not increment the counter.

There is no activity heartbeat, refresh lease, or sequence counter. The host shows `running` from the matching start until the matching end. Host startup never marks a Pi turn lost. On `session_start`, only an idle-session branch report can close an open sent message with synthetic stop reason `lost`. Polling and time alone cannot create a reminder.

## Feature ownership

The workflow message stores only Pi send facts. Other records remain authoritative:

- interactive requests own step contracts, attempts, deadlines, validation, model submissions, and `unproductiveTurnEnds`;
- human decisions own choices, verified answers, expiry, and continuation;
- terminal runs own outcomes, reasons, restart lineage, and results;
- notification nodes own their node results;
- follow-up records own prompt source and authority;
- settings records own current values and accepted changes.

Submitted-output steps can use reminders. Assistant-message steps do not send a reminder after a visible response. An interrupted assistant-message step keeps its attempt ID and adopts a matching completed response from the active branch. A stale attempt or another branch remains invalid.

Each source event creates its workflow message in the same SQLite transaction. The message cannot exist without its source fact, and a source fact cannot require a Pi message without the matching record.

## Restored behavior

The shared contract supports these features without separate send paths:

- at most two reminder-reason step messages after model turns end without a valid submission;
- one resumed-reason step message after a presented paused step resumes;
- one terminal result and recovery turn for the final outcome of each interactive continuation chain;
- safe restart with lineage, a limit of three, and repeated-failure protection;
- ordered follow-up prompts after successful completion, terminal turn end, and release of later workflow reservations;
- protected decisions in Pi and approved external channels;
- passive notifications that do not start model turns;
- terminal result retention while its message is pending or its first turn is open, and then for 60 seconds after that turn ends, in the widget and `piw`;
- conversation recording linked to workflow attempts.

A terminal or follow-up message does not reopen the completed workflow. A slash-looking follow-up remains plain model input because `pi.sendMessage()` does not dispatch extension commands or expand prompt templates. External effects remain idempotent or explicitly ambiguous.

## Session recording

The extension records workflow-related Pi events through a batched host client operation. It uses documented Pi events and does not read or edit Pi session files.

The host deduplicates settled entries by Pi entry ID. It links attempts to their prompt, response, first, and last entries. A recording failure does not fail workflow execution.

## Public API boundary

The extension uses documented `pi.sendMessage()`, `pi.registerMessageRenderer()`, session lifecycle events, agent lifecycle events, widgets, status, commands, shortcuts, and session IDs.

This design does not change Pi core, use private Pi APIs, or change Pi session schemas. It does not add another database or runtime.

## Validation and tests

Tests must prove:

- every message kind uses the one coordinator;
- one workflow message ID creates at most one confirmed Pi entry and one automatic model turn;
- a later manual turn uses a new workflow turn ID without creating another Pi entry;
- two Pi processes that open one session cannot both send because one process-local coordinator epoch is active;
- restart recovery reports the branch and adopts an existing entry before it sends;
- branch absence is usable only when Pi is idle and has no pending input;
- a crash after send leaves the message pending and cannot cause a resend before branch reporting;
- messages remain in saved order without message-pointer deadlocks;
- an early `agent_start` and `agent_end` wait for the message receipt and session view, then apply in order;
- every matching model turn shows `running` for its full duration;
- stale turn-end reports and starts against closed messages are rejected;
- a manual turn cancels pending step messages that it supersedes;
- a turn cannot bind to an interaction whose run is paused;
- aborted turns pause without incrementing the unproductive-turn counter;
- host restart does not close a live Pi turn, while an idle-session branch report can close an unended turn as lost;
- two reminder-reason steps are sent at most once and the next unproductive turn fails;
- initial, reminder, and resumed prompts use the same step kind and differ only by reason;
- terminal and follow-up messages each start only at their durable boundary;
- a branch switch creates one resumed-reason step only when that branch has no entry for the interaction;
- a missing protected decision creates another decision message, not a step;
- branch evidence changes a cancelled message to sent;
- a follow-up-started workflow blocks the next follow-up through its session reservation;
- notifications and protected decisions do not start model turns;
- the provider receives the complete step prompt but no workflow message ID or internal send state;
- collapsed and expanded cards remain safe and complete;
- session recording adopts each settled Pi entry once.

The real Pi end-to-end test must use a clean Pi home with only the packed pi-workflows extension. It must accept any provider and model supported by base Pi. `openai` and `openai-codex` are separate providers.

## Security

Workflow prompts and expected-output descriptions can contain untrusted text. Renderers treat them as text, wrap them safely, and do not interpret workflow control sequences or markup.

Collapsed cards hide full prompts from the normal conversation view. Expanded cards and Pi session files still contain the full content, so normal session privacy rules apply. Credentials, internal send state, and internal message IDs do not enter provider-facing content.
