---
title: Restore workflow session delivery and controls
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-01
---

# Restore workflow session delivery and controls

The out-of-process workflow host removed the Pi workflow widget and Escape-to-pause behavior. A later delivery safety fix also caused normal polling to report `Interactive request presentation claim conflict`. This plan restores those features and fixes delivery without bringing back the embedded workflow runtime.

[Workflow host](WORKFLOW_HOST.md) remains the process and state specification. [Workflow step messages](WORKFLOW_STEP_MESSAGES.md) remains the session message specification. This plan records the cause, scope, implementation order, and acceptance checks for the repair.

## Observed problems

- The active workflow widget no longer appears in Pi.
- Escape aborts the current model turn but leaves its workflow unpaused.
- Polling can report a presentation claim conflict before the workflow step appears.
- A visible message can become eligible for another send if saving its durable receipt fails.

The affected live run remained durably parked at its interactive request. No workflow state or Pi session message was lost.

## Root cause

The out-of-process redesign removed the embedded extension executor. The old widget and `agent_end` pause handler were coupled to that executor, so both were removed with it. The redesign did not add host-backed replacements.

The delivery coordinator checks Pi again after an asynchronous host claim. If Pi becomes busy during that claim, the coordinator currently drops the claim. The next poll tries to claim the same interaction before its ten-second presentation lease expires. The host correctly rejects that second claim. The extension incorrectly exposes the expected rejection as a workflow tool failure.

The coordinator also removes its local queued guard before durable settlement finishes. A settlement error can therefore make later polling treat a message that is already visible in Pi as sendable work.

## Requirements

- Keep one global host as the normal workflow state writer.
- Keep workflow and controller code in supervised child processes.
- Use documented Pi extension APIs only.
- Preserve one ordered session delivery path for steps, decisions, notifications, and final results.
- Never send through an expired claim.
- Never resend a message that is visible in Pi only because its durable receipt failed.
- Pause a presented workflow interaction when its Pi model turn ends with stop reason `aborted`.
- Reject workflow updates and submissions while that interaction is paused.
- Restore the widget as a read-only view of durable host state.
- Keep schema identifiers at version 1 and add no compatibility path.

## Delivery coordinator

The coordinator will have three in-memory states for one delivery:

1. `claimed`: the host granted a lease, but Pi became busy before send;
2. `queued`: `pi.sendMessage()` was called and the matching Pi entry is not yet durably settled;
3. settled or ambiguous: the host accepted the public Pi entry ID, or settlement could not be proved.

The coordinator records `claimExpiresAt` with every claim. A later poll can use the same claim while it is live. It discards an expired unused claim and may then request a new claim. It does not request another claim while a live claim is remembered.

The extension reads the presentation claim owner and expiry from the existing version-1 interaction row. A live claim held by any extension is normal unavailable work. It is not a tool error. Notification and terminal-turn claim receipts also include their exact expiry.

The coordinator keeps a queued delivery until durable settlement succeeds. If the Pi entry is visible and settlement fails, the coordinator reports an ambiguous receipt and keeps the send blocked. Recovery may acquire a fresh claim and adopt the existing Pi entry, but it cannot send that delivery again.

## Widget

The extension will read the active origin-session run and render the existing workflow widget from its durable run state and definition snapshot. This path is read-only. It does not load workflow source, execute workflow code, or write workflow state.

The widget will:

- show running, waiting, and paused state;
- use the existing bounded ten-line renderer;
- support `Shift+Up` and `Shift+Down` scrolling;
- use serializable lines outside TUI mode;
- clear when the session has no active run or shuts down.

## Escape and pause

The extension will use Pi's documented `agent_end` event and public extension context abort signal. It will act only when:

- the active context signal is aborted, or an assistant message has stop reason `aborted`;
- the origin session has a pending agent or assistant interaction;
- the matching workflow prompt is recorded in durable state or present in the active Pi branch; and
- the run is not already paused.

The extension will send `run.pause` to the host. A live worker uses the existing exact-claim pause transaction. A waiting interaction has no worker and no live run claim, so the host will atomically set `paused = 1` on the parked run. The host will reject updates and submissions while paused.

Resume will clear the pause on the same pending interaction without creating a worker or a second prompt. Other paused work will keep the existing behavior: take a new claim generation and resume in a supervised child.

## Scope

The change may update:

- the extension delivery coordinator and host client integration;
- the read-only workflow widget projection;
- host pause and resume handling for parked interactions;
- existing version-1 interaction response fields;
- focused unit, integration, and live Pi tests;
- the workflow host and authoring documentation.

## Non-goals

- Do not change Pi core, private Pi APIs, or Pi session schemas.
- Do not restore the embedded workflow executor.
- Do not add a second production runtime, database, service, feature flag, migration, or compatibility reader.
- Do not claim exactly-once execution for an external effect that cannot prove it.
- Do not release until the repair passes a live test in a new Pi session.

## Implementation order

1. Keep a live claim in the shared delivery coordinator and add claim expiry to all delivery receipts.
2. Treat an existing live presentation claim as unavailable work.
3. Keep visible messages blocked until durable settlement succeeds or recovery adopts them.
4. Add atomic pause and resume operations for a parked interaction.
5. Reject updates and submissions while the run is paused.
6. Add the public `agent_end` Escape handler.
7. Restore the widget as a read-only durable-state view.
8. Add regression tests and update the canonical documentation.
9. Run repository checks, Pi Reviewer, a new-session live test, and CI before release.

## Acceptance criteria

- Pi can remain busy longer than both the poll interval and presentation lease without a duplicate message or claim error.
- Every delivery ID creates at most one Pi session message and one model turn.
- A visible message with a failed receipt remains blocked from resend.
- A competing live presentation claim does not appear as a workflow tool failure.
- The widget appears for an active origin-session run and shows paused state after Escape.
- Escape pauses the matching waiting run through the host.
- A paused interaction rejects `update` and `submit`.
- Resume keeps the same request and allows submission without another prompt.
- Non-aborted turns and unrelated sessions do not pause the workflow.
- The extension and host execute no workflow or controller code in their own event loops.

## Verification

Run:

```bash
npm run check
npm run test:e2e
git diff --check
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Then run Pi Reviewer against `main` with a ten-minute tool timeout until no P0 or P1 finding remains. Test the built package in a new Pi session and a new Herdr tab. The live test must show the widget, start one workflow step, pause it with Escape, resume it, and complete it without a duplicate prompt or claim error.
