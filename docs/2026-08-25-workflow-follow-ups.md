---
title: Continue normal work after a workflow finishes
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
---

# Continue normal work after a workflow finishes

A workflow can save several normal user prompts while it runs. Pi Workflows sends them in order only after the workflow is officially terminal and its final response has settled. The completed workflow stays terminal and does not enter its start node again.

Follow-up prompts are separate from workflow settings. JSON Patch changes future workflow behavior. Follow-up actions create later normal user turns.

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

Prompts keep database acceptance order. Several user messages can therefore add several prompts while one workflow response is in progress.

- Running, paused, parked, and waiting workflows accept new prompts.
- Pause and park keep prompts queued.
- A checkpoint continuation takes the queued prompts with it in the same transaction that creates the new run.
- Successful completion records the terminal run before prompts can become ready.
- Failed, timed-out, and cancelled workflows cancel every unsent prompt.
- A terminal workflow rejects new prompts. Repeating an earlier request ID can still return its first result.

A repeated request ID with the same prompt returns the first result. Reusing that ID with different content fails.

## Final response barrier

Each run saves one final-response state:

- `not-needed`: the workflow has no final presentation;
- `pending`: the terminal run has a final response that has not settled;
- `settled`: the active session branch contains the presentation message and its completed assistant response;
- `unavailable`: the extension recorded a definite timeout, failure, or restart gap.

Successful completion changes queued prompts to `pending_presentation` when a final response is required. It changes them directly to `ready` when no final response is required. A settled or unavailable presentation changes pending prompts to ready.

The extension includes the run ID in documented presentation-message details. On restart, it scans the active durable branch for the presentation message and completed assistant response. It saves the observed entry IDs. It does not treat an in-memory event alone as proof.

## Delivery

The follow-up coordinator handles one prompt at a time:

1. Wait for terminal workflow state and a completed final-response barrier.
2. Wait for the target session to be idle and have no active workflow.
3. Claim the first ready prompt with a lease.
4. Scan the active session branch for its stable follow-up ID.
5. If the message already exists, save its session entry ID without sending it again.
6. Otherwise, call documented `pi.sendUserMessage` with the prompt and a short nonsecret ID in a Markdown comment.
7. After Pi saves the normal user message, scan the branch and save its entry ID and send time.
8. Wait for that user turn and any workflow it starts to finish before taking the next prompt.

`pi.sendUserMessage` returns no message ID. Branch evidence is required after a new send and after restart.

The follow-up message is a normal user message. It can start normal work or a different workflow. It cannot resume or reactivate the completed workflow.

## Failure handling

- A crash before claim leaves the prompt ready.
- A crash after claim lets another process continue after the lease expires.
- A crash before message append leaves no branch evidence and permits a retry.
- A crash after append but before the database update is resolved by finding the follow-up ID in the active branch.
- A definite send failure releases the claim.
- An unavailable session leaves the prompt pending.
- Branching follows the active Pi branch. A message on another branch does not count as delivered on the active branch.

Current documented Pi APIs cannot guarantee exactly-once model execution. Pi Workflows can guarantee only its saved order, claim, active-branch evidence, and local delivery state. Delivery also needs a later live Pi process, database, target session, and provider. This feature adds no external service.

## Saved states

A follow-up is in one of these states:

- `queued`;
- `pending_presentation`;
- `ready`;
- `sent`;
- `removed`;
- `cancelled`.

A lease is temporary claim data, not another follow-up state.

`workflow_follow_up_queues` stores presentation state and per-run order. `workflow_follow_ups` stores each prompt, source, state, session entry ID, and times. Prompt text stays in the existing content-addressed value store. Normal status views show IDs, order, source type, and state without printing full prompts.

This is part of the same alpha hard change as workflow settings. It adds no Pi core change, private Pi API, external queue, compatibility reader, dual write, alias, fallback, or second schema.
