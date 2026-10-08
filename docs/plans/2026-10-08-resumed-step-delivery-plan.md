---
title: Deliver resumed steps reliably
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-10-08
status: approved
---

# Deliver resumed steps reliably

## Goal

A resumed workflow step must reach the model, and the steps after it must keep arriving. Onur saw an
`autoimplement` run sit at "waiting at classifyImplementation" while the status said "A step is
pending delivery. It starts a new model turn after this turn ends." The model ended its turn again
and again, but no step arrived and the model had nothing to submit. Only a Pi reload clears the
state.

Onur asked for a complete fix that covers every step the server sends more than once for one request.

## Incident

Run `20261008T053816575Z-autoimplement-172158b3` on Pi 1.0.x with pi-workflows 0.17.6:

1. Onur interrupted the implement step turn. The aborted turn paused the run.
2. `workflow resume` created message 7, a `resumed` step for the same request as message 6, which
   Pi already held.
3. The resume turn ended at 08:00:54.755. In its `agent_settled` handler, the extension sent message
   7 with `pi.sendMessage(..., { triggerTurn: true })` and then sent a branch report at once.
4. Since Pi 0.87.0, Pi defers a turn requested during `agent_settled` until all settled handlers
   return, and `ctx.isIdle()` stays true meanwhile. The report therefore said that Pi was idle with
   nothing pending and that message 7 had no entry.
5. The server read that report as proof that message 6 had left the branch. At 08:00:54.795 it
   cancelled message 7 and tried to re-issue the step. The re-issue built the same message ID, so it
   found the row it had just cancelled and left it cancelled.
6. At 08:00:54.842 Pi wrote message 7 and ran the step. The model submitted, and the server created
   message 8 for `classifyImplementation`.
7. The extension still owned a turn for message 7. It waited for the server to show message 7 as
   `sent`, which could never happen because the server no longer named it. While that turn existed,
   the coordinator sent nothing, so message 8 stayed `pending`.

Messages 1 to 6 did not fail because each was the first message of its request.

## Rules

[Workflow server](../WORKFLOW_SERVER.md) already says that one branch report names one message, so
it proves the presence of that message only. The server applied this rule between requests but
broke it inside one request. These rules close the gap:

- **The server draws conclusions only about the named message.** A branch report proves facts about
  the message it names and nothing about the other messages of its request.
- **A message that Pi has not received yet proves nothing.** When the named message is `pending`,
  its missing entry means only that Pi has not added it yet. Pi may still be adding it. The server
  waits. Every step message carries the full prompt and contract, so delivering the pending message
  gives Pi the complete step.
- **Only a lost sent message starts recovery.** When the named message is `sent` and its entry is
  missing from an idle report, it left the branch, and the server re-issues the step as today.
- **Recovery always leaves one message that Pi can receive.** If the message that recovery re-issues
  is `cancelled`, recovery reopens it as `pending`, the same as a `sent` message.
- **The extension reports the message it delivered.** While the extension owns a turn for a
  delivered message that the server has not confirmed, and Pi holds that message, its branch report
  names that message, even when the server's current message is another one. The server then
  records the entry. The existing rule already says that a visible entry is `sent` even when the
  server cancelled the message before the evidence arrived.
- **The extension never waits forever on a turn.** After the extension reported the entry of its
  unconfirmed turn, and the server's current message is a different one, the extension reports the
  turn start and follows the server's answer. An `absent` answer stops the turn and clears it
  through the existing path for refused ownership.

With these rules, the result no longer depends on when Pi writes the entry.

## Scope

- `src/server/server.ts`: limit branch recovery to a named message that is `sent` and missing.
- `src/state/workflow-messages.ts`: let `reopenMessage` reopen a `cancelled` step or decision
  message.
- `src/extension/workflow-message-coordinator.ts`: report the entry of an unconfirmed owned turn,
  and settle that turn with the server when the server stops naming its message.
- Tests for the server and the coordinator.
- [Workflow server](../WORKFLOW_SERVER.md) and [Workflow step messages](../WORKFLOW_STEP_MESSAGES.md):
  state the rules above, and fix the stale sentence that says the branch report covers the complete
  view window.

## Non-goals

- Pi and its session files stay unchanged, and the branch report keeps its format with one message
  ID.
- No change to reports that name no message. They keep their current rule.
- No change to the status text for a pending step.
- No upgrade of the Pi development dependency from 0.85.0. The unit tests model the deferred Pi
  delivery directly, and the E2E suite can run on a newer Pi through `PI_WORKFLOWS_E2E_PI_ENTRY`.
- Post-workflow turns and missing-submission reminders keep their behavior. Reminder steps are a
  second message for a request, so this fix also stops the server from cancelling them.

## Acceptance

- An idle report that names a `pending` resumed step without an entry leaves the step `pending` and
  current. Before this change the server cancelled it.
- An idle report that names a `sent` step without an entry still re-issues the step, and the existing
  tests for messages that left the branch still pass.
- Recovery reopens a `cancelled` re-issue target.
- In a coordinator test where `sendMessage` adds no entry and Pi stays idle until later, the step is
  confirmed once the entry appears, and the next message is delivered.
- A coordinator turn whose message the server cancelled before confirming it reports the entry, and
  the server's answer settles the turn. The coordinator then delivers the next message.

## Verification

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Then run the real-model live E2E from `AGENTS.md` with a low-cost model.

The E2E test "delivers a step resumed from a model turn and the step after it" replays the incident
on a real Pi with a local mock model. `PI_WORKFLOWS_E2E_PI_ENTRY` points the E2E suite at another Pi
`cli.js`. With Pi 1.0.4 and without this fix, the test hangs at the second step with "A step is
pending delivery. It starts a new model turn after this turn ends." With the fix, it passes, and so
does the whole workflow E2E file:

```bash
PI_WORKFLOWS_E2E_PI_ENTRY=/path/to/pi-coding-agent/dist/cli.js \
  npx vitest run --config vitest.e2e.config.ts test/e2e/workflow.e2e.test.ts
```
