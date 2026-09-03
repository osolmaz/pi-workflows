---
title: Fix workflow turn ownership after failures
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-04
status: approved
---

# Fix workflow turn ownership after failures

## Summary

The workflow host must be the only place that decides whether a Pi model turn belongs to a workflow message. The Pi extension can keep a temporary copy of that decision for the current turn, but it cannot create or retain workflow ownership by itself.

This fixes a failure where a provider outage left an old workflow turn open. Later normal chat turns were then recorded against that old workflow message. Repeated attempts to start the turn caused `UNIQUE constraint failed: workflow_turns.workflow_message_id`.

The fix keeps the existing architecture. It uses `workflowTurn.report` and the version-1 SQLite state contract. It does not change Pi core or add a second execution path.

## Observed failure

Run `20260903T142417617Z-monitor-93c8267e` exposed this sequence:

1. Three provider turns failed with `Not Found`.
2. The workflow tried to fail after three turns without a valid submission.
3. The worker had already put the run in a terminal state.
4. The terminal update returned false and the host threw `Workflow run could not fail after three unproductive turns`.
5. Open workflow-turn state remained.
6. Later normal chat turns were treated as workflow turns.
7. Repeated starts reached the SQLite uniqueness constraint.

The benchmark processes continued, but the monitor workflow could no longer track them reliably.

## Selected design

The host owns the decision for each workflow turn.

At turn start, one host transaction does one of these things:

- Open the exact turn for the exact sent workflow message.
- Return the matching turn that is already open or saved.
- Report that no workflow owns the Pi turn.
- Reject a conflicting report.

At turn end, the extension closes the exact turn accepted at start. A matching repeated report returns the saved result. A report with conflicting IDs or response evidence remains an error.

When a run becomes terminal, the same transaction ends all open turns for that run as `lost` and cancels its still-pending workflow messages. A late start or end report cannot revive the run.

## Protocol contract

`workflowTurn.report` remains the only client operation for workflow model turns. Its version-1 receipt becomes the host's answer about ownership:

- `active` means that the named turn owns the current Pi model turn.
- `settled` means that the named turn has ended.
- `none` means that no workflow owns the Pi model turn.

The exact field names can follow the existing protocol style, but the three results must remain distinct and typed. A matching repeat returns `adopted` with the saved result. The host rejects a report when its turn ID, message ID, run ID, session ID, stop reason, or response entry conflicts with saved evidence.

The extension must not infer ownership from a queued message, an old session view, or the incoming report alone. Only the host receipt grants ownership.

## Durable state rules

The existing `workflow_messages` and `workflow_turns` tables remain in schema version 1. Their uniqueness constraints remain in place.

State methods must perform these changes atomically:

1. Start one exact turn only when its run is live and its message is the current sent message.
2. Return the saved result for a matching repeated start.
3. Detect another open turn before an insert reaches the uniqueness constraint.
4. End one exact turn with its stop reason and response entry evidence.
5. Return the saved result for a matching repeated end.
6. Settle all open turns and pending messages when the run becomes terminal.

The uniqueness index remains a final invariant. A normal provider failure, retry, reconnect, or late report must not surface as a raw SQLite constraint error.

An otherwise valid version-1 database can use the same terminal and idle-session reconciliation rule to end an uncertain open turn as `lost`. This is normal recovery, not a migration. Structurally incompatible state must still fail before mutation with the documented backup-and-reset instruction.

## Host behavior

`reportWorkflowTurn` must check run state, message state, and existing turn state in the transaction that records the result. It must set session model activity from the saved result, not from the requested action.

`applyWorkflowTurnEnd` must treat an already-terminal run as settled. After the third turn without a valid submission, a false return from `failWorkflowRun` is an error only when the run is still nonterminal. If another path already ended the run, the host must reconcile the open interaction, turns, and messages and return the terminal result.

All terminal paths must use one cleanup function before they publish the terminal workflow message. Idle branch reports must use the same turn-ending rule for a turn that cannot be proved complete.

## Extension behavior

The extension creates a temporary candidate when Pi reports `agent_start`. It reports that candidate to the host before it exposes an active workflow message or starts conversation recording.

If the host returns `active`, the extension records the exact accepted turn ID for that Pi turn. At `agent_end`, it reports the end of that exact turn and clears its local copy after the host returns `settled` or the run is terminal.

If the host returns `none`, rejects the start, or becomes unavailable, the extension must not attach the next Pi turn to that candidate. After reconnect, the existing branch and idle report lets the host end any uncertain accepted turn as `lost`.

A terminal session view also clears temporary extension ownership. A later ordinary user message must not create a workflow-turn report or start a workflow conversation recorder.

## Viewer behavior

The host view reports origin-session model activity only when a live run has a host-approved open turn. A terminal run, a settled turn, or a stale client report cannot make the widget or `piw` show active workflow work.

The widget, status line, command output, Herdr view, and `piw` continue to use the same host-produced view. No renderer gets its own recovery rule.

## Implementation steps

1. Update the version-1 turn report receipt in `src/client/view.ts` and its protocol tests.
2. Add atomic turn methods and terminal cleanup in `src/state/workflow-messages.ts`. Keep the current tables and indexes in `src/state/schema.ts`.
3. Route turn reports, provider-error handling, idle recovery, and terminalization through those methods in `src/host/runner.ts`.
4. Make `src/extension/workflow-message-coordinator.ts` keep only host-approved temporary ownership. Update `src/extension/index.ts` so recorders start only after acceptance.
5. Make the host session view derive model activity only from a live, approved open turn.
6. Add state, host, extension, viewer, reconnect, and real-Pi regression coverage.
7. Update `WORKFLOW_HOST.md`, `SQLITE_STATE.md`, and `workflows.md` to match the shipped behavior.

## Tests

Tests must reproduce the observed order:

1. A workflow step message starts a Pi turn.
2. Three Pi turns end with provider errors and no valid submission.
3. Worker terminalization races with the third end report.
4. The session reconnects and reports that it is idle.
5. A normal user turn starts after the failed workflow.

The checks must prove:

- A failed provider turn releases workflow ownership.
- Terminalization leaves no open turn for the run.
- A terminal run cannot start another turn.
- Matching repeated reports return the saved result.
- Conflicting reports remain errors.
- No path produces a raw SQLite uniqueness error.
- The later normal Pi turn creates no workflow turn or workflow recorder.
- The viewer shows origin-turn activity only for an approved open turn on a live run.

Automated tests must use the deterministic provider and temporary directories. They must not call a real model.

Run all repository checks:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
npx -y @simpledoc/simpledoc check
```

After the automated checks pass, install the built package locally and run a no-op workflow plus a forced provider-error recovery smoke test. Confirm that a later normal Pi message creates no workflow turn.

## Boundaries

- Do not change Pi core or its private APIs.
- Do not change Pi session schemas.
- Do not add another database, service, runtime, or protocol operation.
- Do not add a version-2 schema, migration, compatibility reader, dual path, fallback, or feature flag.
- Do not weaken the workflow-turn uniqueness constraints.
- Do not claim exactly-once model calls or external effects.
- Do not publish a release as part of this fix.
