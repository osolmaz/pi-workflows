---
title: Unify workflow run state
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-04
status: implemented
---

# Unify workflow run state

## Goal

Several Pi Workflows failures appeared together after the out-of-process host change. A provider error left old workflow-turn ownership behind. A composed workflow reused an effect key. Restart treated a failed run as a checkpoint continuation. Terminal code read a text error as JSON. That read error blocked cancellation, while the host repeatedly started a worker that could not make progress.

These failures have the same architectural cause. Important facts are inferred in more than one place. Local node names stand in for compiled identities. A parent run ID stands in for the kind of child run. Callers guess the type of stored data. Process activity stands in for workflow progress. Presentation work can determine whether a control command commits.

The approved design gives each fact one owner and one typed path. The compiler and engine create execution identities. The host state store commits workflow state. A worker executes one explicit run command. The Pi extension delivers messages and reports public Pi events. Renderers display the host view.

This plan replaces the narrower workflow-turn ownership plan. It keeps that fix and adds the effect, restart, terminal-data, cancellation, and worker-retry work needed to remove the shared cause.

## User requirements

- Use the most direct, long-term design instead of separate guards for each symptom.
- Keep one global out-of-process host as the normal state writer.
- Keep one client protocol and one production runtime.
- Use documented Pi extension APIs only.
- Do not change Pi core or Pi session schemas.
- Keep schema version 1 and make an alpha hard cut. Do not add migrations, compatibility readers, dual paths, fallbacks, or feature flags.
- Preserve strict ownership and uniqueness checks.
- Do not claim exactly-once behavior for model calls or external systems.
- A paused workflow must remain pausable and cancellable after any earlier run failure.

## Confirmed causes

### Composed effects lose their full node path

`manualEffect()` and `idempotentEffect()` derive a key from `state.currentNode`. Workflow composition projects the state into a child workflow before it evaluates that key. The projection changes a compiled path such as `documentation/workspace/inspect` back to the local name `inspect`.

The outer workspace check and the documentation workspace check therefore shared the run ID and visit number. They also shared the effect type and local node name. Their requests differed, so the effect store correctly rejected the second request with `Managed effect key was reused with another request`.

### Restart uses checkpoint continuation

The run queue records whether a child is a `continuation` or a `restart`. The worker bootstrap receives only `parentRunId`. It calls `continueRun()` for every child with a parent.

`continueRun()` requires a parent that is waiting at a checkpoint. A failed terminal run does not meet that contract. A restart must begin at the workflow start with fresh graph and effect state.

### A failed ancestor error is read with the wrong type

Run errors are stored as text. `terminalAncestorOutcomes()` reads an ancestor `error_hash` with `readJson()`. The blob exists, but its media type is text. The generic database error says that the JSON blob is missing or has the wrong media type.

Terminal-message creation calls this reader. As a result, the error can block child failure handling and cancellation.

### A worker can restart forever without progress

When an uninitialized worker exits, the host parks and claims the same run again. The failed restart never changes its saved workflow revision, but the host keeps launching it. The UI reports `running` because a process is active even though the workflow makes no progress.

### Presentation can roll back control state

Cancellation and terminal-message creation currently share a transaction path. If terminal-message creation cannot read its source data, the cancellation fails too. A display failure must not keep execution authority alive.

## Design

### Clear responsibilities

The compiler assigns complete node paths. The engine uses those paths to identify logical work. Child workflows can receive a local view of inputs and outputs, but that local view cannot replace the compiled identity.

The host state store owns every durable transition. Host orchestration code asks the store to start, pause, finish, cancel, or recover work. It does not update lifecycle tables directly.

The worker receives one explicit command and executes it. It does not infer the command from nullable fields.

The Pi extension keeps only temporary state for the current Pi turn. A host response decides whether that turn belongs to a workflow.

Renderers use the host view. They do not infer workflow progress from process presence, messages, or local timers.

### Complete execution identity

Each logical node visit has a stable identity made from:

- the run ID;
- the full compiled node path;
- the visit number.

The visit number is the count for that exact compiled node path. A crash retry of the same unfinished visit keeps the same number. Re-entering the node later gets the next number.

The engine derives managed-effect identity from this logical node visit and the effect type. The projected child context is still used to calculate the effect request, but it is not used to calculate internal identity.

Workflow authors no longer provide the internal effect key. If an external API needs its own idempotency key, the action sends that external key as part of the request to that API. Internal execution identity and an external API key are separate facts.

The effect store keeps its request fingerprint check. Reusing one logical effect identity with a different request remains a hard conflict.

### One run command

The host sends the worker one tagged command:

- `start` begins a root run.
- `resume` continues the same interrupted run from saved state.
- `continue` creates a child from an accepted waiting checkpoint.
- `restart` creates a fresh child after a terminal result.

The worker handles this command with one exhaustive switch. Invalid combinations fail before workflow code runs.

A restart uses the same approved workflow definition and requested input, but it begins at the first node. It does not copy parent steps, outputs, results, open interactions, settings mutations, or effect reservations. The parent run ID and root run ID remain saved as history. The saved history also includes the restart number and terminal fingerprint.

A continuation remains the only path that carries checkpoint state forward. It requires a waiting parent and the exact accepted decision or submission.

The engine should expose one internal entry point that accepts this tagged command. The superseded parent-ID heuristic is removed in the same alpha change.

### One durable transition interface

The existing run store becomes the only interface used by host orchestration for durable run changes. It can use focused internal modules, but callers see typed operations rather than SQL or booleans.

The interface covers:

- starting and ending exact workflow turns;
- reserving and settling exact effects;
- starting, pausing, and resuming runs;
- finishing and timing out runs;
- cancelling runs;
- preparing continuations and restarts;
- recording worker failure and recovery state.

Each operation checks the run generation and claim token in one transaction. It also checks the expected revision and run state against the exact resource identity. It returns one of these results:

- `applied` with the new saved value;
- `adopted` with an equal saved value;
- `conflict` with the conflicting evidence;
- `recoveryRequired` with the saved reason.

A boolean result is not sufficient for a lifecycle change. Callers must know whether another path already completed the same change or whether the request conflicts with current state.

### Workflow-turn ownership

`workflowTurn.report` remains the single version-1 operation for Pi model turns.

At Pi `agent_start`, the extension proposes the exact sent workflow message and a stable turn request ID. The host atomically returns an active turn or reports that no workflow owns the Pi turn. The extension starts workflow recording only after an active result.

At Pi `agent_end`, the extension ends the exact active turn. Matching repeated reports return the saved result. Conflicting evidence remains an error.

When a run becomes terminal, the same state transaction ends its remaining open turns as `lost` and cancels still-pending workflow messages. A late report cannot revive the run. If a connection closes at an uncertain point, the extension does not attach the next Pi turn. The existing branch and idle report lets the host settle an unproved open turn as `lost`.

### Typed run data

Run input and final output are JSON. Run error and presentation instructions are text. Code reads them through named store methods:

- `readRunInput()`;
- `readRunFinalOutput()`;
- `readRunError()`;
- `readPresentationInstructions()`;
- `readTerminalFacts()`.

Callers do not read these blob hashes directly. `readTerminalFacts()` is the only source for terminal messages and ancestor outcomes. It checks media types and returns one typed result.

The underlying content-addressed blob store remains general. The run store owns the meaning of each run column.

### Control state before presentation

Finishing or cancelling a run commits its execution state first. That transaction saves the final status and ends open turns. It cancels pending interactions and messages before it releases the claim. It also records the terminal facts needed for presentation.

Terminal Pi-message creation is an idempotent follow-up transition derived from those saved facts. A host restart can create a missing terminal message later. A presentation error is recorded for repair, but it cannot undo the terminal state or retain execution authority.

This separation applies to completion, failure, timeout, and cancellation.

### Retry only after progress

Every worker launch records the run revision it received. A normal worker exit reports a typed outcome to the host. Known bootstrap and workflow errors include the phase and error text.

If a worker process disappears without a report, the host compares the current run revision with the launch revision. It may resume automatically only when durable progress or a saved recovery transition changed that revision.

If no revision changed, the host parks the run with the worker failure and stops automatic launch. The user can inspect, cancel, or explicitly resume it. This rule has no arbitrary retry count. The same unchanged state is never executed in a tight loop.

The display reports `running` only while one accepted worker or origin-session turn is doing current work. A parked no-progress failure reports its recovery reason.

## State and protocol changes

This is an alpha hard cut in schema and protocol version 1. The implementation must not add a version-2 identifier or a compatibility path.

Expected changes include:

- a tagged worker run command in the existing worker protocol;
- full compiled node identity for managed effects;
- typed results for lifecycle transitions and turn reports;
- typed run-data readers;
- durable no-progress worker failure evidence if the existing event records cannot express it without inference.

Prefer existing tables and event records when they express the contract directly. If the durable no-progress rule requires a new column or constraint, change version-1 DDL in place. An old database then fails before mutation with the standard backup-and-reset instruction.

Existing structurally valid state can use normal terminal and idle-session reconciliation. Do not add migration code to repair old table shapes.

## Implementation plan

### Freeze the failures in tests

Add focused tests that reproduce the current behavior before changing it:

- Mount workspace preparation directly and again under documentation, then prove the current automatic effect key collides.
- Restart a failed workflow and prove the worker selects checkpoint continuation.
- Build terminal ancestry with a failed parent and prove ancestor reading uses the wrong media type.
- Cancel a child of a failed run and prove presentation failure rolls back cancellation.
- Crash an uninitialized worker without a revision change and prove the host repeatedly claims it.
- End a workflow turn during a terminal race and prove a later ordinary Pi turn can inherit old ownership.

The final versions of these tests must assert the corrected behavior. Do not preserve assertions for the defects.

### Move execution identity into the engine

Change managed-effect identity in `src/workflows/definition.ts`, `src/workflows/composition.ts`, `src/workflows/engine.ts`, and the related types.

The compiled engine passes the full node path and visit number to effect reservation. Child-context projection remains limited to workflow-authored request and action functions. Remove the old automatic key calculation from projected `state.currentNode`.

Update authoring docs and all built-in workflows in the same change. Keep no alias for the old internal key contract.

### Make worker commands explicit

Add the tagged run command to `src/host/worker-protocol.ts`, the host bootstrap response, and `src/host/worker-entry.ts`.

Replace the `initialized` and `parentRunId` dispatch heuristic with an exhaustive command switch. Add the engine path for a fresh restart and keep checkpoint continuation separate. Remove the superseded dispatch code.

### Centralize durable transitions

Move direct lifecycle SQL from `src/host/runner.ts` into typed store operations in the state and workflow-store modules. Replace ambiguous boolean returns used by run failure and cancellation with typed results.

Keep claim fencing and revision checks in each state transaction. The runner handles process supervision and protocol routing only.

### Fix terminal state and cancellation

Add the typed run-data readers and use `readTerminalFacts()` for the current result and every ancestor result. Remove direct JSON reads of error hashes.

Commit terminal control state independently from terminal-message creation. Add idempotent reconciliation for a terminal run that has no terminal workflow message.

After this change, the currently paused failed-child case must cancel without a database reset.

### Finish workflow-turn ownership

Implement the approved host-owned turn contract in the state store and host runner. Apply it to the extension coordinator and session view. Then connect it to recorder integration.

A terminal run must have no open workflow turn. A later ordinary Pi turn must produce no workflow-turn report for the terminal run.

### Stop no-progress worker loops

Add structured worker exit reports for all caught bootstrap and execution failures. Save the launch revision and compare it on an unreported exit.

Park an unchanged run with a clear recovery reason. Resume automatically only after a newer durable revision makes another launch meaningful.

### Remove old paths

Delete:

- effect keys derived from projected local node names;
- restart dispatch based only on `parentRunId`;
- direct error-hash JSON reads;
- lifecycle SQL in host orchestration where a typed store operation replaces it;
- cancellation paths that depend on successful terminal presentation;
- automatic relaunch of the same unchanged worker state;
- extension turn ownership that has not been accepted by the host.

Do not keep feature flags or fallback behavior.

### Update documentation

Update `WORKFLOW_HOST.md`, `SQLITE_STATE.md`, and `workflows.md` after implementation so they describe the shipped interfaces and recovery behavior. Keep this plan as the decision and implementation record.

## Tests

### Composition and effects

- Two mounts of the same action receive different full execution identities.
- A crash retry of one unfinished node visit reuses its identity.
- A later loop visit receives a new identity.
- The same identity and request adopts the saved effect.
- The same identity with another request returns a controlled conflict.

### Run commands

- Root start begins at the first node.
- Resume uses the same run and saved current node.
- Continuation accepts only a waiting checkpoint parent and carries the approved state.
- Restart accepts a terminal parent and begins with no parent steps, outputs, results, or effects.
- Invalid command and state combinations fail before workflow code runs.

### Terminal state

- Completed, failed, timed-out, and cancelled ancestors produce typed terminal facts.
- A text error is never passed to `readJson()`.
- Cancellation commits even when terminal presentation is forced to fail.
- A later reconciliation creates the missing terminal message once.
- Terminalization ends open turns and pending interactions in the same state transaction.

### Worker recovery

- A worker crash after a newer durable revision resumes safely.
- A worker crash at the same revision parks once and does not relaunch.
- A known bootstrap error becomes a saved failure instead of a process loop.
- The widget and `piw` show the same parked reason.

### Pi turn ownership

- A provider error ends the exact accepted turn.
- Repeated and reordered reports return saved results or controlled conflicts.
- A terminal race cannot leave an open turn.
- Reconnect settles an unproved turn as `lost`.
- A later ordinary Pi message creates no workflow turn or workflow recorder.

### Full regression

Run Autoimplement with its direct workspace preparation and nested Autodoc workspace preparation. Force the first run to fail after a managed action. Restart it and then pause and cancel it. Prove that effect identities do not collide and restart begins cleanly. Also prove that terminal facts remain readable and cancellation commits without a worker loop.

Automated tests use temporary directories and deterministic providers. They do not call a real model.

## Acceptance criteria

- One component owns each identity and state decision.
- Included workflows cannot collide because they share local node names.
- Restart and checkpoint continuation cannot enter each other's engine path.
- Every run column is read with its declared data type.
- Control commands remain effective when presentation fails.
- A worker cannot relaunch unchanged state indefinitely.
- A terminal run has no open workflow turn.
- Later ordinary Pi turns cannot attach to terminal workflow work.
- No raw SQLite uniqueness or media-type error reaches normal recovery paths.
- Host, extension, widget, CLI, Herdr, and `piw` agree on run activity.
- Pi core and private Pi APIs remain unchanged. Pi session schemas also remain unchanged.
- One host and one database remain. The system keeps one client protocol and one production runtime.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npm run test:e2e:live -- --runtime-only
git diff --check
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
cargo test --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path tui/Cargo.toml --check
```

After deterministic checks pass, install the built package locally. Run a clean no-op workflow. Then run the composed Autoimplement regression and a forced provider-error recovery check. Confirm the widget and `piw` status at each stage. Use a real model only for the final manual installed-package check, with an explicit provider and model selected by the operator.

Run Pi Reviewer against `main` until no P0 or P1 finding remains. Check pull-request comments and CI before merge.

## Scope

The implementation may change Pi Workflows engine, compiler, worker protocol, host state methods, extension coordination, viewer projection, built-in workflows, tests, and documentation in this repository.

## Non-goals

- No Pi core or private Pi API changes.
- No Pi session schema changes.
- No new service, database, state root, or production runtime.
- No operating-system service installation.
- No migration or compatibility path for older alpha state.
- No release or package publication as part of implementation.
- No exactly-once claim for provider calls or external effects.

## Assumptions

- Pi continues to provide the documented extension lifecycle events and session APIs.
- The host remains the only production process that opens live SQLite state.
- A package update can require the documented backup and reset when version-1 DDL changes.
- External systems remain responsible for their own stable idempotency keys or read-back checks.
