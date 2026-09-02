---
title: Continue normal work after a workflow finishes
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
---

# Continue normal work after a workflow finishes

A workflow can save several prompts for normal work while it runs. Pi Workflows sends them in order only after the workflow is officially terminal, its terminal message is sent, and its terminal model turn has ended. The completed workflow stays terminal and does not enter its start node again.

Follow-up prompts are separate from workflow settings. JSON Patch changes future workflow behavior. Follow-up actions create later normal conversation turns.

## Queue and remove prompts

Use the workflow tool once for each prompt:

```json
{
  "action": "queue-follow-up",
  "prompt": "Release the package and verify the published files."
}
```

The result contains a stable `followUpId` and order number.

Remove an unsent prompt with:

```json
{
  "action": "remove-follow-up",
  "followUpId": "follow-up-0123456789abcdef0123456789abcdef01234567"
}
```

A model can remove only a prompt added by the same session tool source. A controller can remove only its own prompt. A verified human can remove any unsent prompt in the owned run.

Direct commands are also available:

```text
/workflow queue-follow-up Release the package and verify the published files.
/workflow remove-follow-up follow-up-0123456789abcdef0123456789abcdef01234567
```

Controllers use:

```ts
await ctx.workflows.queueFollowUp({
  requestKey: "release-after-run",
  runId,
  prompt: "Release the package and verify the published files.",
});

await ctx.workflows.removeFollowUp({
  requestKey: "remove-release-after-run",
  runId,
  followUpId,
});
```

The host creates the actor and stable request identity. Prompt data cannot claim human or controller authority.

## Ordering and run states

Prompts keep database acceptance order. Several requests can add several prompts while one workflow response is in progress.

- Running, paused, parked, and waiting workflows accept new prompts.
- Pause and park keep prompts queued.
- A checkpoint continuation keeps queued prompt rows attached to the chain member that accepted them. The host walks the continuation chain to determine their final source outcome; it does not rewrite the rows.
- Successful completion records the terminal run and terminal workflow message before a follow-up can send.
- Failed, timed-out, and cancelled workflows cancel every unsent prompt.
- A terminal workflow rejects new prompts. Repeating an earlier request ID can still return its first result.

A repeated request ID with the same prompt returns the first result. Reusing that ID with different content fails.

Each accepted prompt creates its `workflow_follow_ups` source record and one `followUp` workflow message in one transaction. The message points to its source through `sourceId`; the source row stores no message pointer. The host derives eligibility from saved domain facts. A follow-up is eligible only after the source continuation chain completes successfully, its terminal message turn ends, every earlier accepted follow-up is settled or cancelled, and no nonterminal run, including one waiting for a checkpoint or protected decision, reserves the origin session.

## One message path

The shared `WorkflowMessageCoordinator` handles follow-ups. There is no follow-up sender.

1. Wait for the terminal outcome, sent terminal workflow message, and matching model-turn end.
2. After every host connection, wait for the complete origin-session view and report the active branch.
3. Wait until the host view names this `followUp` as the next eligible pending message, Pi is idle, and no earlier workflow message is active.
4. Keep its ID in the coordinator's in-memory queued map and report a matching active-branch entry when one already exists.
5. Otherwise, recheck synchronously that Pi is idle, has no pending input, the message is absent, and the connection still owns the active coordinator epoch. Call documented `pi.sendMessage()` with the follow-up prompt and `triggerTurn: true` without an `await` between the check and call.
6. Report the active branch so the host saves the observed Pi entry ID and marks the message `sent`.
7. Wait for that turn and any workflow it starts to finish before the next follow-up becomes eligible.

The follow-up custom message starts normal conversation work and can use a user-style renderer. Its internal workflow message ID stays in custom details and does not enter provider-facing content. It can ask the model to start another workflow, but it cannot resume or reactivate the completed workflow. Text that starts with `/` remains plain model input; a custom message cannot dispatch a Pi slash command or expand a prompt template. A `restart` chosen from the terminal turn creates a separate immutable workflow run.

Follow-up storage contains only prompts explicitly queued through this feature. Terminal restart does not find, copy, hash, or store an original user message. Conversation history remains owned by Pi.

## Failure handling

- A crash before send leaves the workflow message `pending`.
- A crash after send but before the branch report also leaves it `pending`; reconnect reports the active branch before another send.
- A matching hidden workflow message ID changes a pending or cancelled message to `sent` because the Pi entry already exists.
- An unavailable session leaves the workflow message `pending`.
- An entry on another Pi branch does not confirm the send on the active branch.
- A stale coordinator epoch cannot send or report message state.

Documented Pi APIs do not prove cross-branch absence or exactly-once model execution. Pi Workflows guarantees only its saved order, message state, active-branch evidence, and local state. Sending also needs a later live Pi process, target session, and provider. This feature adds no external service.

## Saved states

`workflow_follow_ups` stores each prompt, source, queue order, and whether the source was removed or cancelled. It does not copy a workflow message ID, message state, or Pi entry ID. `workflow_messages` owns `pending`, `sent`, and `cancelled` state and points back to the source row.

Prompt text stays in the existing content-addressed value store. Normal status views show IDs, order, source type, and state without printing full prompts.

This is an alpha hard change. It keeps schema version 1 and adds no Pi core change, private Pi API, external queue, compatibility reader, dual write, alias, fallback, or second schema.
