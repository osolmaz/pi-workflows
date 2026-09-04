---
title: Keep large workflow history out of runner resume replies
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-04
status: implemented
---

# Keep large workflow history out of runner resume replies

## Goal

A workflow runner must resume, wait, continue, or finish even when its Pi session history is large.

The workflow server will send the runner only the execution state it needs. SQLite will keep session messages and tool results. It will also keep activity events and viewer history. If an execution value cannot fit in one runner-server message, the server will send a content reference and the runner will read the exact value in bounded parts.

## Observed failure

Monitor run `20260904T050230350Z-monitor-da3951fb` failed while it resumed from a waiting step.

The runner called `store.prepareRunResume`. The server returned a complete `LoadedWorkflowRun`, although the engine used only `loaded.state`. The response included all session records and trace history. It also included the workflow snapshot plus all settings and follow-ups.

The first oversized response was 1,322,183 bytes. Its session entries alone used 926,764 bytes. Later retries produced responses of 1,974,127 and 1,989,453 bytes. Each response exceeded the 1 MiB runner protocol limit, so the runner crashed. Starting another runner repeated the same failure because it requested the same complete run.

This is an interface error. Large history is valid stored data, but it is not input to workflow execution.

## Boundaries

This change is limited to the runner-server interface and workflow execution store. It also includes tests and related documentation in this repository.

The workflow server remains the only process that opens the writable SQLite database. Workflow runners do not read SQLite directly. The viewer continues to use its existing bounded pages and content references.

This change does not:

- change Pi core or private Pi interfaces
- change the SQLite schema or schema version
- add a service, database, transport, or production runtime
- truncate or delete workflow history
- raise the message limit as the primary fix
- make the complete run record available to workflow execution

The component naming hard cut is a separate refactor. It does not change this functional contract, and it is kept in a separate commit.

## Design

### Separate execution reads from inspection reads

`LoadedWorkflowRun` is an inspection record. It contains execution state, the saved definition, and all trace or session history. It also contains settings and follow-ups. It is useful inside the server and for inspection code, but it is too broad for the runner interface.

The execution store will expose only the two state reads that the engine uses:

- `prepareRunResume(runId)` prepares the existing run for resume and returns its committed `WorkflowRunState`.
- `readRunState(runId)` returns the current `WorkflowRunState` for continuation checks.

`WorkflowRunStore.readRun()` remains a server-local inspection method. It is removed from `WorkflowExecutionStore` and from the runner protocol.

Resume preparation keeps its current transaction and meaning. It interrupts unfinished node attempts and records `run_resume_prepared`. It then advances the revision and saves the new state. The method returns that committed state. It no longer rebuilds or returns the complete run.

Continuation still uses `WorkflowRunState` to check the parent status and waiting node. It also checks the source and input plus any human decision. It does not load session history or viewer data.

### Keep history in the server

These values stay in SQLite and never cross to a runner as part of resume or continuation:

- session messages and tool results
- session activity events
- session capture records and integrity details
- viewer history and trace pages
- the full saved definition snapshot
- settings history
- follow-up history

The server can still read these values for inspection and reconciliation. Recording and viewer requests can also read them. This plan changes only what the execution runner receives.

### Keep viewer reads separate

`piw` continues to request bounded run pages. Large viewer values continue to use the existing content-reference and chunked-read behavior.

Runner execution reads and viewer reads have different purposes. They must not share a complete-run response or cause one another to load more data.

### Handle a required large execution value

A long workflow can make `WorkflowRunState` itself large. Narrowing the response removes unrelated history, but it does not prove that every required state will always fit in one message.

The runner protocol will therefore support one bounded content path on its existing connection:

1. The server encodes and measures every response before writing it.
2. A response that fits is sent inline.
3. If the result is too large, the server stores or reuses its canonical bytes in the existing content-addressed `blobs` table. It sends a small reference with the media type and byte length plus the SHA-256 digest.
4. The runner reads that content through the same runner protocol in bounded parts, using the digest and byte offset.
5. The runner verifies the final byte length and digest before parsing and using the value.
6. Missing content, a changed digest, an invalid range, or a non-JSON state returns a bounded rejected response. It does not crash the runner.

This is not a second transport. It is a bounded read on the existing runner-server connection and existing content-addressed storage. It keeps the complete required value available without putting it in one control message.

The internal runner protocol gets its own named byte limit instead of importing the external client protocol limit. The fix keeps an explicit bound. It does not depend on making that bound larger.

### Make oversized replies controlled failures

The server must never discover an oversized reply only when it writes to the runner process.

Response preparation will measure the final canonical message first. Large results will become references. If the server cannot persist or reference a large result, it will return a small rejected response for that request. The supervisor will record the request and reason, but it will not mark the runner as crashed only because a reply was large.

Requests keep their existing message IDs, revision checks, claim checks, and accepted, adopted, rejected, or claim-lost outcomes.

## Contract changes

This is an in-place alpha change to the version-1 runner contract.

- `WorkflowExecutionStore.prepareRunResume()` returns `WorkflowRunState`, not `LoadedWorkflowRun`.
- `WorkflowExecutionStore.readRun()` is replaced by `readRunState()`.
- Runner operation `store.readRun` is replaced by `store.readRunState`.
- `store.prepareRunResume` and `store.readRunState` return state inline or through a verified content reference.
- `WorkflowRunStore.readRun()` remains available only to server-local inspection code.
- Runner responses are measured before write and cannot fail with an uncaught size error.
- The internal runner message limit is owned by the runner protocol, not by the external client protocol.

There is no compatibility reader, alternate operation, dual path, feature flag, migration, or version-2 schema. The server and runner change together in one package release.

## Implementation steps

### Add the failing large-history test

**Where**

- `test/server.test.ts`
- `test/server-protocol-state.test.ts`
- `test/workflow-runner-entry.test.ts`
- Add a focused runner-server integration fixture under `test/fixtures/` only if the existing helpers cannot create the case clearly.

**Change**

Create a waiting run with more than 2 MB of recorded session entries and events while keeping its workflow state small. Resume it through the real child-runner protocol used in tests.

Prove that the old complete-run response crossed the runner message limit and crashed the runner. Keep the fixture deterministic and use temporary directories. Do not call a model.

**Verification**

The regression fails on the old code with the same oversized runner-response error seen in the saved Monitor run.

### Narrow resume preparation to workflow state

**Where**

- `src/workflows/store.ts`
- `src/workflows/engine.ts`
- `src/server/workflow-runner-store.ts`
- `src/server/server.ts`

**Change**

Change `prepareRunResume()` to return the committed `WorkflowRunState` directly. Add a state-only store read that reconstructs the execution state from normalized run rows without loading session, trace, viewer, settings, or follow-up records.

Update `WorkflowEngine.resumeRun()` to use the returned state directly. Keep every existing resume validation and interrupted-attempt update. Keep the trace event, revision update, and viewer delta.

**Verification**

Store and engine tests prove that resume returns the same committed state and revision as before. Instrumented tests prove that resume does not query or serialize session history.

### Replace complete-run continuation reads

**Where**

- `src/workflows/engine.ts`
- `src/workflows/store.ts`
- `src/server/workflow-runner-store.ts`
- `src/server/workflow-runner-protocol.ts`
- `src/server/server.ts`

**Change**

Replace the engine-facing `readRun()` method and `store.readRun` runner operation with `readRunState()` and `store.readRunState`.

Update `continueRun()` to read only the parent `WorkflowRunState`. Keep all current waiting-state, source, human-decision, and continuation checks.

Remove the broad read from `WorkflowExecutionStore`. Keep `WorkflowRunStore.readRun()` as a concrete server-side inspection API.

**Verification**

Engine tests cover ordinary continuation plus human-decision continuation. Protocol tests prove that the runner has no operation that returns `LoadedWorkflowRun`.

### Keep history on the server

**Where**

- `src/workflows/store.ts`
- `src/server/server.ts`
- `src/server/view.ts`
- Existing session recording and viewer tests

**Change**

Audit the new state-only paths and confirm that they do not load or serialize session entries, session events, capture records, trace pages, settings history, follow-up history, or the full definition snapshot.

Do not change their storage, retention, recording, or inspection behavior.

**Verification**

A run with more than 2 MB of history resumes with a small state response. The same complete history remains readable from server-local inspection and the viewer after the run finishes.

### Preserve bounded viewer reads

**Where**

- `src/server/view.ts`
- `src/client/client.ts`
- `docs/tui-viewer.md`
- Existing viewer protocol tests

**Change**

Do not route runner state through viewer projections and do not route viewer history through runner operations. Confirm that `piw` still uses bounded pages and existing content references.

No viewer contract change is expected. Update viewer code only if a regression test finds accidental coupling.

**Verification**

Existing viewer page and content-reference tests pass. Hydration, replay, and large-history tests also pass without larger page limits or complete-run reads.

### Add safe large-result handling to the runner protocol

**Where**

- `src/server/workflow-runner-protocol.ts`
- `src/server/child-runner-supervisor.ts`
- `src/server/workflow-runner-entry.ts`
- `src/server/workflow-runner-store.ts`
- `src/workflows/store.ts` or a small server-owned content helper
- Protocol and runner tests

**Change**

Give the internal runner protocol its own named frame limit. Add a typed version-1 content reference and one bounded content-read operation on the existing runner connection.

Before the server writes a response, encode and measure it. Spill only an oversized result to the existing content-addressed blob store. Return its reference so the runner can read and verify bounded parts. Keep message metadata and errors small enough to remain inline.

Convert all content persistence and range failures into bounded rejected responses. Do the same for invalid media types, lengths, digests, or parsed values. Do not stop the runner only because a result is too large.

**Verification**

Protocol tests cover the exact boundary, one byte over it, multiple chunks, and missing content. They also cover invalid offsets, wrong digests, or malformed JSON. A required state larger than one frame resumes successfully after verified reconstruction. A rejected large-result read fails the workflow request clearly without a runner crash loop.

### Audit all runner-server operations

**Where**

- `WorkflowRunnerStoreOperation` in `src/server/workflow-runner-protocol.ts`
- `ServerBackedWorkflowStore` in `src/server/workflow-runner-store.ts`
- Runner operation dispatch in `src/server/server.ts`
- `docs/WORKFLOW_SERVER.md`

**Change**

List every runner request and its response shape. For each operation, return only the value the runner uses. Remove complete-run and other broad response shapes from the runner boundary.

Keep content references as the general safe path for a required value that exceeds one frame. Do not add one-off size exceptions for individual operations.

**Verification**

A contract test exercises every operation with its largest supported result shape. No operation can return a complete run unless workflow execution actually requires every field, and no current operation has that requirement.

### Add full regression coverage and update the contract docs

**Where**

- `test/store.test.ts`
- `test/engine.test.ts`
- `test/engine-more.test.ts`
- `test/server.test.ts`
- `test/workflow-runner-entry.test.ts`
- Existing runner protocol and end-to-end test files
- `docs/WORKFLOW_SERVER.md`
- `docs/SQLITE_STATE.md`
- `docs/workflows.md`

**Change**

Add one deterministic scenario with more than 2 MB of history that resumes, reaches another wait, continues, then finishes. Assert that no runner generation crashes and history remains complete in SQLite. Also assert that viewer reads remain bounded and every runner frame stays within its protocol limit.

Document the execution-only state reads and server-owned history. Also document the content-reference fallback, independent runner frame limit, and controlled large-response failure behavior.

**Verification**

The regression follows the full saved-run lifecycle. It passes without a real model or extra service. It also requires no schema change, history truncation, or raised limit.

## Tests and checks

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

The automated tests must use temporary directories and deterministic providers. They must not call a real model.

After the package tests pass, install the built package through the normal local package path and run a manual smoke test. Use a saved run with more than 2 MB of history. Confirm that it resumes, waits, continues, then finishes. Confirm that `piw` can still inspect the complete history.

## Acceptance criteria

The change is complete when all of these statements are true:

- A run with more than 2 MB of session history can resume, wait, continue, or finish.
- `prepareRunResume()` returns only the committed workflow state.
- Continuation uses a state-only read.
- Session history and viewer history do not enter runner resume or continuation replies.
- `piw` still reads complete history through bounded pages and content references.
- Every runner-server response is measured before it is written.
- A required result larger than one frame is transferred by a verified reference and bounded reads.
- A large reply cannot cause a runner crash loop.
- No runner operation returns a complete run when it needs only one small part.
- The SQLite schema and Pi core do not change, and no installed service changes.
- The public naming hard cut remains a separate refactor commit.
- All repository checks pass.
