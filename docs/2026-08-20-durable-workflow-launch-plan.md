---
title: Make deferred workflow launches durable
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-20
---

# Make deferred workflow launches durable

The launch queue and activation contract in this plan remain current. [Deferred workflow turns](DEFERRED_TURNS.md) replaces the launch-specific failure-notification mechanism with the general successor-turn intent contract.

## Goal

A successful `workflow start` call must create a real queued workflow before it returns. The model
must receive the final run ID, and pi-workflows must start that run only after the current agent turn
settles.

If startup then fails, pi-workflows must save the failure and start one new model turn with an
actionable error. The model can correct the request and call `workflow start` again. A failed launch
must release the session reservation so the corrected run can start.

This change stays inside pi-workflows. It uses the existing project-scoped SQLite controller store
and documented Pi extension APIs. It does not change Pi, add a service, or add another database.

## Current failure

The current tool path stores a pending launch only in `pendingToolLaunch`. It returns:

```text
Workflow <name> will start after this turn finishes.
```

After the agent turn settles, the `agent_settled` handler clears `pendingToolLaunch` and calls
`startRun`. If `startRun` fails, the handler sends only a TUI notification. No run ID was returned,
`workflow status` has no durable launch to inspect, and the model receives no new turn.

This happened twice while starting `autoimplement`. The tool reported a queued launch, but no run
became active. The initiating model could not see the startup error and incorrectly reported that
the workflow had started.

## Decision

Use a durable prepared run and one model-visible failure follow-up.

During the `workflow start` tool call, pi-workflows will:

1. Resolve and validate the workflow and all available start conditions.
2. Allocate the final run ID.
3. Save a queued record in the existing SQLite workflow queue.
4. Reserve the initiating Pi session.
5. Return the run ID and say that the workflow is queued.

After the current agent turn settles, pi-workflows will:

1. Claim the queued record.
2. Change it to `starting`.
3. Build the engine and executor without running a node.
4. Change the record to `running`.
5. Release the engine to run the first node.

If startup fails, pi-workflows will:

1. Change the record to `failed`.
2. Save a bounded safe error.
3. Release the session reservation.
4. Create one eligible deferred-turn intent for the owning Pi session.
5. Resolve that intent with one factual follow-up after settlement.

The new model turn will contain the failed run ID and an actionable error. The model can fix the
workflow reference, input, source, or local condition and call `workflow start` again. Each retry is
an explicit model action with a new run ID. pi-workflows does not perform a blind automatic retry.

## Alpha compatibility contract

pi-workflows is in alpha. Change the current storage and tool contracts in place.

- Keep `pi-workflows.controller-store.v1`.
- Keep existing run-bundle schema identifiers.
- Do not add a v2 schema.
- Do not add a compatibility reader, data migration, dual path, alias, feature flag, or fallback to
  `pendingToolLaunch`.
- Change the SQLite table definitions and TypeScript types directly.
- Remove the superseded status values and launch path in the same change.

An existing controller store with the old alpha table layout is incompatible. On open, pi-workflows
must verify the required table columns and status contract. If the layout is old, it must stop with a
clear instruction to preserve any needed run evidence and reset the project-scoped controller store.
It must not silently reinterpret or delete old state.

Run bundles remain separate evidence. Resetting an incompatible controller queue must not delete run
bundle directories.

## Public behavior

### Start

A successful tool result becomes:

```text
Workflow autoimplement queued (run autoimplement-...).
```

The structured result contains:

```json
{
  "action": "start",
  "workflow": "autoimplement",
  "runId": "autoimplement-...",
  "queued": true
}
```

Queued means that the durable reservation exists. It does not mean that the engine is running.

Every check that can run before acknowledgement must run before the queue record is committed. This
includes:

- Workflow resolution and definition validation.
- Declared input validation.
- Parent checkpoint and source checks for continuations.
- Controller-store access.
- Existing active or queued session reservation.
- Pending final presentation conflicts.

A preflight error returns through the original tool call. The model can correct it in the same turn.
No queued record remains after a failed preflight.

### Activation

Interactive activation starts only from a safe idle boundary:

- `agent_settled` after the initiating turn.
- `session_start` recovery when no agent turn is active.
- The next `agent_settled` event when recovery starts during an active turn.

Repeated lifecycle events must not start the same run twice. Claims use compare-and-set updates, a
claim token, a bounded lease, and a final fence before the engine starts its first node.

No compute node, shell action, function action, agent node, or presentation starts while the
initiating agent turn is active.

### Failure and model iteration

A deferred startup failure becomes a terminal queued-run state. The safe follow-up message is:

```text
Workflow autoimplement failed to start (run autoimplement-...): <safe reason>.
Inspect the error and call workflow start again only after you correct the cause.
```

The message does not contain raw workflow input, prompt text, credentials, request headers, or a
stack trace.

The turn intent has a deterministic ID derived from the session, run, and launch event. Pi Workflows records it in `workflow_turn_intents`. Before a delivery retry, it checks the Pi session branch for the intent ID. This prevents a duplicate after a crash between session append and intent resolution.

A failed launch releases the one-workflow session reservation before it sends the follow-up. The
model can therefore call `workflow start` during the new turn. If that launch also fails, the same
process repeats with a new run ID. The regular Pi loop and user control remain the bounds; Pi
Workflows does not create an internal retry loop.

### Status

`workflow status` with a run ID reads the queued-run record before a run bundle exists. After the
engine starts, it also reads the normal run bundle.

Status reports these launch states:

```text
queued
starting
running
failed
cancelled
parked
done
```

A failed status includes only the bounded safe error. Status without a run ID shows the current
session reservation or the displayed run.

### Cancellation

`workflow cancel` accepts the queued run ID. Cancellation changes `queued` or `starting` to
`cancelled` atomically and invalidates the activation fence. A race cannot release the executor after
cancellation wins.

A cancelled launch releases the session reservation and sends no failure follow-up. A later start
can create a new run.

## Storage contract

Use the existing `workflow_run_queue` table as the source of truth for launch state.

Change its alpha v1 layout in place to store:

- Final run ID.
- Workflow name and immutable source identity.
- Definition digest.
- Private workflow input while activation needs it.
- Launch state.
- Owning Pi session.
- Claim token and lease expiry.
- Safe failure code and message.
- Created, updated, started, and finished times.

Replace the current `claimed`, `parked`, and `done` launch-state contract with:

```text
queued | starting | running | parked | done | failed | cancelled
```

Keep `parked` and `done` for current resume and terminal queue behavior. Remove `claimed`; `starting`
and `running` state its meaning directly.

Clear private queue input when the launch becomes `running`, `failed`, or `cancelled`. The normal run
bundle owns input after the engine starts.

Keep `workflow_notifications` limited to passive `progress` and `final` reports. A launch failure creates an eligible row in `workflow_turn_intents`; it does not add a run-level notification kind.

The project-scoped controller store remains private local state. Tests must verify restrictive file
and directory permissions.

## State transitions

Only these launch transitions are valid:

```text
queued -> starting
queued -> cancelled
starting -> running
starting -> failed
starting -> cancelled
starting -> queued       # expired lease with no run bundle
running -> parked
running -> done
running -> failed
running -> cancelled
parked -> starting       # explicit resume
parked -> cancelled
```

Every transition uses an expected current state and claim token when applicable. A stale handler gets
no ownership and performs no side effect.

When recovery finds `starting` after a lease expires:

- No run bundle: return to `queued`.
- Valid running bundle: reconcile to `running` and use existing run recovery.
- Waiting bundle: reconcile to `parked`.
- Terminal bundle: reconcile to `done`, `failed`, or `cancelled`.
- Changed workflow source or unreadable bundle: record `failed` and notify the owning session.

## Error contract

Classify startup failures into a small set of stable codes, such as:

```text
workflow_not_found
workflow_invalid
input_invalid
source_changed
store_unavailable
activation_failed
cancelled
```

Persist a plain safe message with a strict byte limit. Keep the original error only in transient
process memory for local debug logging. Never persist or send the stack, causes, raw input, prompt,
credential, or unbounded provider text.

A failure must remain useful. The safe message should name the check that failed and the action that
can correct it without including secret values.

## Implementation plan

### 1. Replace the alpha controller-store layout

Update `src/controllers/sqlite.ts` and its exported queue and notification types.

- Keep `CONTROLLER_STORE_SCHEMA` at `pi-workflows.controller-store.v1`.
- Change `SCHEMA_SQL` directly.
- Remove old alpha `ALTER TABLE` compatibility logic for the workflow queue.
- Add exact-layout validation after table creation.
- Add the launch states and safe failure fields.
- Generalize workflow notifications for run-level failure notices.
- Add a partial unique index for one `queued`, `starting`, or `running` interactive reservation per
  origin session.

For an incompatible existing table, return a clear alpha reset error. Do not mutate it.

### 2. Add atomic launch operations

Add focused SQLite methods:

- `reservePreparedRun`
- `claimPreparedRun`
- `markPreparedRunRunning`
- `failPreparedRun`
- `cancelPreparedRun`
- `parkRunningRun`
- `finishRunningRun`
- `findSessionReservation`
- `listRecoverableRuns`
- `recoverExpiredStartingRun`

Use `BEGIN IMMEDIATE`, expected states, claim tokens, and lease checks.

### 3. Split preparation from activation

Refactor `src/extension/index.ts`.

Create a small `src/extension/launch-coordinator.ts` if it keeps state transitions and recovery out of
the extension entry point.

Preparation owns resolution, validation, run ID allocation, immutable source identity, definition
digest, and reservation. Activation owns claims, engine construction, recorder setup, `activeRun`,
running state, and executor release.

Controller child workflows remain on their controller scheduler path. Share pure workflow-resolution
helpers where useful, but do not make controller children wait for an interactive agent boundary.

### 4. Change the start tool

Update `src/extension/workflow-tool.ts` and the extension start handler.

Return the queued run ID only after the SQLite transaction commits. Remove the old “will start”
result and every success message that says the workflow already started.

### 5. Add the failure follow-up

Create a versioned custom message for launch results. Store only:

- Notification schema.
- Notification ID.
- Run ID.
- Workflow name.
- `failed` state.
- Safe error code and message.

Deliver it through public `pi.sendMessage` after settlement with `triggerTurn: true` and
`deliverAs: "followUp"`.

The notification asks the model to inspect and correct the cause. It does not automatically call
`workflow start`.

### 6. Update status, cancellation, and recovery

Status must read the queue before a run bundle exists. Cancellation must target queued and starting
runs by ID. Session startup and agent settlement must ask the launch coordinator for recoverable work
owned by that session.

Delete `pendingToolLaunch` and all status, cancel, shutdown, and `agent_settled` branches that depend
on it.

### 7. Keep rendering secondary

Render queued, starting, failed, and cancelled launch state in the TUI from durable storage. A TUI
notification can announce failure, but it is not the source of truth and is not the only delivery
surface.

### 8. Update documentation

Update `docs/workflows.md` with the queued start contract, run ID, status, cancellation, failure
follow-up, and model retry behavior. Update controller-store documentation with the alpha reset rule.
Do not document a v2 schema or migration path.

## Tests

Add or update these tests:

1. Clean alpha v1 store creation with the new exact layout.
2. Old alpha v1 layout rejection with a clear reset instruction.
3. No automatic table migration or silent deletion.
4. One-session reservation and different-session independence.
5. Durable run ID before the start tool returns.
6. Synchronous preflight failure with no queue record.
7. Zero engine activity before `agent_settled`.
8. Duplicate `agent_settled` and `session_start` events with one activation.
9. Lease expiry and recovery at every activation boundary.
10. Cancellation before claim, during `starting`, and before executor release.
11. Source change between preparation and activation.
12. Safe error redaction and byte bounds.
13. One durable launch-failure turn intent.
14. Crash before session append, after append, and before intent resolution.
15. Failed reservation release followed by a corrected model start.
16. Repeated model correction attempts with one active reservation at a time.
17. Status for every launch and run state.
18. Current child workflow, continuation, parking, resume, recorder, widget, and presentation
    behavior.

Add a real Pi end-to-end test in `test/e2e/workflow.e2e.test.ts` with the existing mock provider:

1. The model calls `workflow start` for a valid file workflow.
2. The tool returns a durable queued run ID.
3. The test changes or removes the workflow source before the initiating turn settles.
4. Activation records `failed`.
5. Pi sends one follow-up model turn with the safe error.
6. The model corrects the request and calls `workflow start` again.
7. The new run starts and reaches its first workflow step.
8. The first failed run remains inspectable by ID.

The test must use the packaged extension and real Pi lifecycle events. It must not call a real model
or external service.

## Acceptance criteria

- The start tool never reports success without a committed queued record and final run ID.
- The model can correct synchronous start errors in the same turn.
- A deferred startup failure always becomes durable before notification.
- One launch-failure intent starts one new model turn.
- The model can correct the cause and start a new run.
- Failed and cancelled launches release the session reservation.
- No two runs activate for one reservation.
- Reload, restart, compaction, and repeated settlement do not lose or duplicate a launch.
- Status and cancellation work before a run bundle exists.
- Private input and error details do not leak.
- No Pi change, new service, new database, v2 schema, compatibility path, or migration exists.
- The old `pendingToolLaunch` path is gone.

## Verification

Run the canonical repository gates:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

Run pi-reviewer against the base branch and fix all valid P0 and P1 findings before release work.

Package publication and OnurPi adoption are separate tasks. Do not edit an installed `node_modules`
copy as the implementation source.

## Non-goals

- Do not change Pi or propose a new Pi API.
- Do not add a service, daemon, remote queue, telemetry endpoint, or second database.
- Do not preserve old alpha controller-store layouts.
- Do not add a migration or v2 schema.
- Do not add blind automatic workflow retries.
- Do not change built-in workflow behavior except for test fixtures needed to verify startup.
- Do not publish or adopt a package as part of this documentation change.
