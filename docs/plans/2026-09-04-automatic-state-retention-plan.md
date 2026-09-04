---
title: Add automatic workflow state retention
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-04
status: approved
---

# Add automatic workflow state retention

## Goal

Pi Workflows will remove old completed workflow state automatically. It will keep active, resumable, pending, unsettled, and undelivered work.

The server will retain terminal run trees for 30 days. It will then remove safe expired trees and blobs that no retained record or active runner uses. The manual prune command will use the same safety rules.

A regression test will also protect the earlier runner fix. Repeated runner replies must not copy growing Pi session history and make the database grow by several gigabytes.

## Observed problem

One old state database reached about 6.1 GB. The `blobs` table held about 6.06 GB across 101,355 blobs, which were almost all JSON. `worker_messages.result_hash` was the main reference path.

Older runner replies copied growing session and workflow history into new immutable result blobs. Small changes produced another large blob, so content hashing could not deduplicate the replies. [Keep large workflow history out of runner resume replies](2026-09-04-workflow-runner-resume-state-plan.md) fixed that interface by returning only the execution state a runner needs.

That fix stops the main amplification path. Completed workflow history still remains until a person runs `pi-workflows state prune`, so the database can still grow without a retention rule.

## Selected design

Use the existing run-tree prune logic as the one cleanup engine. Automatic cleanup and manual prune will share selection, deletion, blob collection, and compaction rules.

A terminal root run and all its restart or continuation descendants remain for 30 days after `finished_at`. Every descendant must be terminal and older than the cutoff before the server can remove the tree. Protected state or a reference from outside the tree blocks removal.

The Workflow Server checks for cleanup after startup recovery and after workflow runners exit. It starts cleanup only while normal server work is idle. One server process completes no more than one sweep in 24 hours. An interrupted sweep remains due and continues at the next safe trigger.

Automatic cleanup creates no backup. Creating a new backup for every sweep would cause another unbounded store. The explicit manual prune command keeps its current dry-run and backup-first apply forms.

This design does not add size-based deletion. A clear time limit gives users predictable history. Recent or protected data can still be large, so this design does not promise a hard disk-size cap.

## Retention contract

### Eligible run trees

A run tree is eligible only when all of these facts are true:

- The root run and every descendant have status `completed`, `failed`, `timed_out`, or `cancelled`.
- Every run in the tree has `finished_at` earlier than the 30-day cutoff.
- No row outside the tree depends on a row inside it.
- No protected work belongs to the tree.

The cleanup transaction rechecks the exact root tree before deletion. A changed tree is skipped.

### Protected work

Automatic cleanup must keep a tree when it contains or owns any of this work:

- a waiting or parked run
- a queued, starting, running, or parked queue row
- a pending workflow message
- an open workflow turn
- a pending interaction or human decision
- a recording session segment
- a queued follow-up
- an active lease
- a pending, applying, or ambiguous effect
- controller ownership or a managed resource reference
- a continuation or step reference from outside the tree
- an active runner content hash
- a resumable checkpoint
- an undelivered terminal result

Unknown or conflicting ownership blocks deletion. Cleanup must fail closed.

### Automatic scheduling

The server requests one automatic sweep after recovery and after a workflow runner exits. Overlapping requests join the same in-process task.

A sweep starts only when there is no active or pending workflow runner, resource-manager runner, state-maintenance command, or server shutdown. It deletes one complete root tree in one transaction, yields, and checks for new work before it selects another tree.

A completed sweep starts a 24-hour in-process interval. A sweep that stops because new work appeared remains due. The next idle startup or runner-exit trigger can continue it without waiting for another complete interval.

The cleanup scheduler is part of the existing server process. It does not add a service, scheduler process, or second writer.

### Blob cleanup

After run deletion, the state layer removes only blobs with no database foreign-key reference and no active runner reference. The existing schema scan remains the source for blob references, so a future blob foreign key is protected automatically.

A repeated sweep is safe. A second sweep finds no extra rows from work that was already removed.

### Space reuse and file compaction

After logical deletion, the server truncates the WAL while idle and reads SQLite `page_count`, `freelist_count`, and `page_size`. SQLite can reuse free pages even when the main file does not shrink.

Automatic cleanup runs `VACUUM` only when all of these facts are true:

- normal server work is still idle
- at least 64 MiB is reclaimable
- at least 20 percent of database pages are free

A skipped or failed `VACUUM` does not undo committed logical deletion. The server reports the outcome and leaves the free pages available for reuse. It does not claim that the file shrank unless measurement proves it.

Manual prune keeps its current backup-first full compaction and integrity checks.

### Failure handling

A cleanup error does not fail a workflow or stop the server. The server records one clear diagnostic and waits for a later safe trigger. It does not retry in a tight loop.

Cleanup is atomic for one complete root tree. An interruption can leave later trees for another sweep, but it cannot leave half of one lineage tree deleted.

## Public behavior

Retained runs keep their current resume, viewer, content-reference, and terminal-result behavior. The viewer continues to read bounded pages. Pi Workflows does not edit Pi session history.

After an expired tree is removed, it no longer appears in run lists. A direct run view returns not found.

The manual commands remain:

```bash
pi-workflows state prune --before <timestamp> --dry-run
pi-workflows state prune --before <timestamp> --backup <absolute-path> --apply
```

Automatic cleanup adds no client protocol operation. The SQLite schema name and version remain `pi-workflows-state` version 1. This change adds no migration, compatibility reader, second state path, fallback, feature flag, archive, or external resource.

## Implementation

### Share the cleanup engine

**Where**

- `src/state/prune.ts`
- version-1 invariants in `src/state/schema.ts`

**Change**

Split the current prune work into shared run-tree selection, exact-tree deletion, unreferenced-blob collection, page measurement, and compaction operations. Add every protected-state check from this plan.

Automatic deletion must recheck and delete one root tree in the same transaction. Manual prune keeps its backup and complete-selection recheck.

**Check**

State tests prove that eligible trees are removed as one unit. Each protected state keeps its whole tree. Foreign-key and integrity checks pass after deletion.

### Add automatic cleanup

**Where**

- `src/state/prune.ts`
- `src/server/server.ts`

**Change**

Add an automatic entry point with a cutoff of the current time minus 30 days. It uses the shared cleanup engine without creating a backup.

Process one complete root tree per transaction. Yield between trees. Stop when normal server work appears and leave the sweep due.

**Check**

Automatic and manual cleanup select the same eligible trees. Automatic cleanup creates no backup. A stopped sweep continues later without duplicate deletion.

### Schedule cleanup from the server lifecycle

**Where**

- lifecycle fields in `src/server/server.ts`
- `WorkflowServer.start()`
- server shutdown
- the active-run exit path after the server removes the run from `activeRuns`

**Change**

Request cleanup after startup recovery and after runner exit. Coalesce overlapping requests. Enforce the idle check and 24-hour completed-sweep interval.

A failed sweep logs one bounded error and waits for a later trigger. Shutdown starts no new sweep and settles any current scheduling task safely.

**Check**

Server tests use fake time and temporary databases to cover startup, runner exit, coalescing, the 24-hour interval, interruption, clean shutdown, and one injected failure.

### Reuse pages and compact when worthwhile

**Where**

- database-size helpers in `src/state/prune.ts`
- `test/prune.test.ts`

**Change**

Measure free SQLite pages after deletion. Truncate the WAL while idle. Run automatic `VACUUM` only above the 64 MiB and 20 percent thresholds.

Keep committed deletion when compaction is skipped or fails. Report logical deletion and physical file size separately.

**Check**

Tests prove page reuse below the thresholds, no early automatic `VACUUM`, physical reduction after successful compaction, and intact retained data after a simulated compaction failure.

### Add the large-state regression

**Where**

- `test/server.test.ts`
- `test/workflow-runner-content.test.ts`
- the existing large-resume test fixture

**Change**

Create more than 2 MiB of distinct recorded session history. Run several resume, wait, continue, and terminal runner exchanges. Add a small unique item between exchanges.

Measure distinct blobs referenced by `worker_messages.result_hash`, every runner frame, total blob bytes, and SQLite pages. The test must prove that runner control replies contain only required execution state or content references. They must not copy complete session history into every reply.

**Check**

The regression fails when each reply includes the growing history. It passes when result growth follows new workflow state, and every runner frame stays inside its protocol limit.

### Cover retention behavior

**Where**

- `test/prune.test.ts`
- `test/server.test.ts`
- `test/server-view.test.ts`
- the existing state-prune client tests

**Change**

Test recent and expired trees, restart and continuation families, pending and sent terminal messages, open turns, waiting and parked work, every blocker, concurrent manual prune, automatic blob cleanup, viewer access, and resume.

Use temporary databases and deterministic executors. Automated tests must not call a model or touch the user's live state.

**Check**

Retained runs still resume and render. Expired delivered terminal trees disappear as one unit. Protected trees remain. Repeated cleanup has no additional effect.

### Update documentation

**Where**

- `docs/SQLITE_STATE.md`
- `docs/WORKFLOW_SERVER.md`
- `docs/workflows.md`
- CLI help where it describes state retention

**Change**

Document the contract in this plan. Remove the old statement that Pi Workflows never prunes at startup.

**Check**

Documentation matches the code constants and tests. It makes no hard size or file-shrink promise.

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

Automated tests use temporary directories and deterministic executors. They do not call a real model.

After these checks pass, run the separate installed-package E2E with the exact authenticated low-cost model `openai/gpt-5.6-luna`. Use temporary workflow state. Do not prune or seed the user's live database.

## Acceptance criteria

The work is complete when all of these statements are true:

- Terminal root-run trees remain for 30 days.
- Cleanup removes only complete eligible trees.
- Every active, pending, open, resumable, recording, queued, leased, unsettled, controller-owned, cross-linked, undelivered, or active-content case remains protected.
- Automatic cleanup runs without a second service or manual command.
- Manual prune remains backup-first.
- Repeated cleanup is safe and does not partly delete a lineage tree.
- Freed pages can be reused.
- Automatic `VACUUM` follows the 64 MiB, 20 percent, and idle rules.
- Retained runs still resume and render through bounded reads.
- Deleted runs return not found.
- The large-state regression proves that repeated runner replies do not copy growing session history.
- The SQLite schema stays at version 1 with no migration or compatibility path.
- Pi core, Pi session history, other repositories, external services, and the user's live workflow state remain unchanged.
- All repository checks and the separate real-model E2E pass.
