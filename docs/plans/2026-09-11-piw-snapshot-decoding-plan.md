---
title: Fix piw snapshot decoding
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-11
status: approved
---

# Fix piw snapshot decoding

## Goal

`piw` must render every valid version-1 run view that the Workflow Server sends. A new advisory display control must not stop the Rust viewer from loading a run.

The viewer must also tell the user when a run snapshot is invalid. It must show `Loading run…` only before the first snapshot or while it waits for referenced content.

This plan keeps the existing version-1 wire format. It changes no workflow state, execution rule, database record, or Pi session.

## Observed failure

The run `20260911T050755315Z-autoimplement-271c4c4a` was healthy. The TypeScript viewer rendered it, and the Workflow Server sent a valid run snapshot to `piw`.

The snapshot contained these controls for an agent step:

```text
pause, cancel, update, submit
```

The Rust `WorkflowControl` enum did not contain `update`, `submit`, or `human-answer`. Rust could not deserialize the display object. The decoder returned `None` without recording an error, so the TUI kept showing `Loading run…`.

A separate package-version mismatch also occurred before the planning run. Restarting or reloading that Pi session corrected the mismatch. It did not correct this `piw` decoding bug.

## Selected design

Use server-owned display strings.

The Workflow Server owns the advisory display-control vocabulary. TypeScript keeps one list of the current values:

- `pause`
- `resume`
- `cancel`
- `answer`
- `human-answer`
- `update`
- `submit`
- `review`

The Rust run document stores these values as `Vec<String>`. `piw` does not execute them, so it does not need a second closed enum. Future advisory values can render without a coordinated Rust release.

Executable protocol operations remain closed and strictly validated. A future interactive action in `piw` must map a display string to a separate validated operation before execution.

## Version-1 compatibility

Keep these identifiers unchanged:

- `pi-workflows.run-view.v1`
- `pi-workflows.client.v1`
- all other current version-1 state and protocol identifiers

The wire value remains an array of strings. No schema migration, compatibility reader, alternate path, fallback, feature flag, or server change is required.

Strict validation remains in place for:

- client and server envelopes
- required run-view fields
- run statuses
- workflow activity
- executable operations
- protocol framing and canonical JSON

Only advisory display-control names become open strings in the Rust run document. A control with a non-string value remains invalid.

## Decode states

One internal `piw` decoder handles snapshots from both local sockets and WebSockets. It returns one of these states:

- `Ready(RemoteView)` when all required data is valid
- `PendingContent` when a referenced artifact was requested but is not complete
- `Invalid` when a required document or field cannot be decoded

No snapshot is pending. A requested incomplete artifact is also pending. Missing or malformed required data is invalid.

Cache the outcome by run ID and snapshot generation. Do not parse the same invalid generation on every draw. A new snapshot or a completed content request invalidates the cached outcome. A valid newer generation clears the old run error.

Connection errors and run-document errors remain separate. A disconnected client can still show its last good view. An invalid first snapshot shows its run-specific error.

## Error text

An invalid-snapshot error names the document section or field category that failed. It must not include:

- the full run snapshot
- session text
- artifact content
- serialized input or output
- an unbounded rejected value

Use static section names and safe error categories. Keep the complete private payload out of logs and the TUI.

## Implementation

### Make TypeScript the control owner

**Where**

- `src/client/view.ts`
- `src/server/view.ts`

**Change**

Export one readonly tuple with all current display-control values. Derive `WorkflowDisplayControl` and `WorkflowDisplay.controls` from that tuple. Keep `reduceWorkflowDisplay` output and ordering unchanged.

**Check**

Type checking accepts every reducer value. A focused test confirms the tuple and reducer cover agent, assistant, checkpoint, decision, paused, queued, ambiguous, and terminal states.

### Accept advisory strings in Rust

**Where**

- `tui/src/state/types.rs`
- Rust call sites, including `tui/tests/parity.rs`

**Change**

Change `WorkflowDisplay.controls` from `Vec<WorkflowControl>` to `Vec<String>`. Remove the duplicate `WorkflowControl` enum. Keep action-bearing Rust enums closed.

**Check**

Rust deserializes all current controls and an unknown future advisory string. It rejects a non-string control. Existing renderer and parity tests pass.

### Return explicit decode states

**Where**

- `tui/src/client.rs`

**Change**

Replace silent `Option` failures in required run decoding with the three explicit decode states. Keep unresolved referenced content separate from invalid data. Cache the result by run ID and snapshot generation. Clear stale failures after a valid snapshot or content update.

**Check**

Tests cover a valid agent snapshot, an unresolved artifact, malformed manifest, state, and display data, one decode per generation, and recovery from an invalid snapshot to a valid snapshot.

### Show invalid snapshots

**Where**

- `tui/src/ui/mod.rs`
- `render_single_once` in the same module

**Change**

Show `Loading run…` only for the pending state. Show the safe run-specific reason for invalid data. Preserve current connection-error and cached-view behavior. Make `piw --once` return the decode error instead of waiting for its loading timeout.

**Check**

UI tests cover pending, invalid, and ready states. A one-frame test confirms that invalid data returns the decode error directly.

### Add one shared fixture

**Where**

- `protocol/fixtures/run-view-controls-v1.json`
- `test/server-view.test.ts`
- Rust state or client tests

**Change**

Add a minimal valid run-view fixture with:

- all current controls
- the exact `pause`, `cancel`, `update`, and `submit` agent case
- the `human-answer` decision case
- one unknown advisory string case

Use the same fixture in TypeScript and Rust. Keep malformed cases in test code unless the fixture format already supports them cleanly.

**Check**

TypeScript confirms that the fixture matches the server-owned tuple and reducer output. Rust decodes every valid fixture case, including the snapshot shape that failed in 0.16.10.

### Test both transports

**Where**

- focused Rust tests under `tui/tests/` or private tests in `tui/src/client.rs`

**Change**

Send the same canonical `hello` and `run_snapshot` frames through temporary local and loopback WebSocket endpoints. Include one valid agent snapshot and one malformed required-field snapshot.

Do not start the real Workflow Server or read the live database.

**Check**

Both transport paths produce the same `Ready` or `Invalid` result. Neither path waits without a bound or exposes the payload.

### Update specifications

**Where**

- [`docs/TUI_VIEWER.md`](../TUI_VIEWER.md)
- [`docs/LIVE_REPLAY_PROTOCOL.md`](../LIVE_REPLAY_PROTOCOL.md)

**Change**

Document server-owned advisory display strings, closed executable operations, explicit decode states, safe invalid-data errors, local and WebSocket parity, the unchanged version-1 wire format, and the lack of a migration.

**Check**

The specifications match the code constants and tests. They do not claim that old `piw` binaries are fixed.

## Tests

Add regression tests for:

- every current display control
- an unknown advisory string
- a non-string control
- the exact agent-step display from the failed run
- no snapshot
- incomplete referenced content
- valid complete content
- malformed required manifest, state, and display data
- invalid-to-valid recovery
- one decode per snapshot generation
- safe error text
- interactive loading, invalid, and ready states
- `piw --once` invalid-data behavior
- local socket delivery
- WebSocket delivery
- existing run lists, content chunks, patches, replay, rendering, CLI behavior, and protocol fixtures

Tests use fixed fixtures, temporary endpoints, and temporary state. Automated tests do not call a model or touch live user state.

## Checks

Run:

```bash
cargo fmt --manifest-path tui/Cargo.toml -- --check
cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path tui/Cargo.toml --all-targets
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
```

After the automated checks pass, run the separate installed-package live E2E with the exact authenticated low-cost model `openai/gpt-5.6-luna`. Use an existing credential in place. Do not print or copy it.

Run `pi-reviewer` against `main` until no P0 or P1 finding remains. Inspect pull-request comments and CI before merge.

## Risks

### Display strings could be mistaken for actions

Keep executable operations closed. Require a separate validated mapping before `piw` can execute a displayed control.

### Incomplete content could look corrupt

Use `PendingContent` only for requested incomplete artifacts. Keep offset, byte-count, digest, and UTF-8 failures invalid.

### An old error could remain visible

Key decode results to the snapshot generation. Clear the old result on a newer snapshot or completed content request.

### Error text could expose private content

Use static section names and safe categories. Do not include serialized values or content.

### TypeScript and Rust could drift

Use one TypeScript tuple and one fixture consumed by both test suites. Rust accepts future advisory strings before the fixture is updated.

### Transport tests could become slow

Use fixed frames, temporary loopback or in-memory endpoints, and bounded waits.

## Boundaries

This work must not:

- edit Pi core, Pi APIs, Pi sessions, or Pi process lifecycle
- read, rewrite, prune, seed, migrate, or use the live Workflow database as a fixture
- change workflow execution, checkpoint, decision, agent-step, or human-answer behavior
- weaken envelope, framing, or executable operation validation
- add a version-2 schema or another viewer path
- change OnurPi or another repository
- publish a package or release
- install the patch
- deploy
- restart the live Workflow Server while the workflow is active

## Acceptance criteria

The work is complete when:

- valid agent and decision snapshots render in `piw`
- every current and future advisory string can pass through the Rust run document
- non-string controls remain invalid
- only unresolved data shows `Loading run…`
- invalid data shows a safe useful error
- a newer valid snapshot clears an old error
- local and WebSocket paths have the same result
- TypeScript and Rust use the shared fixture
- version-1 identifiers and wire values remain unchanged
- no migration or alternate path exists
- all required checks, review, comments, and CI pass before merge
