---
title: Simplify workflow run storage
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-25
status: implemented
---

# Simplify workflow run storage

## Goal

Keep one SQLite database. Pi owns conversation history. Pi Workflows owns workflow facts. Store each
large prompt or output once, and build the public `pi-workflows.run-state.v1` view when a reader asks
for it.

This is a hard alpha cutover. The schema stays at version 1. An old database is rejected without any
change. There is no migration, second reader, fallback, alias, or `v2` schema.

## Data model

`runs` keeps run identity, the definition reference, launch options, title, status, input, terminal
output or error, and timestamps. It does not keep source JSON, a human-decision receipt, carried-step
counts, or current-node fields.

`run_sources` keeps the immutable source identity for the root workflow and each mounted workflow.
The empty mount path identifies the root source. Mount names come from the definition snapshot.

`node_attempts` keeps attempt identity, node identity, status, one structured output, one error, and
times. It can keep one small execution receipt for action or assistant-message facts. It does not
keep input, contract, prompt, or general step-metadata blobs.

`run_steps` remains the ordered step list. A continuation refers to parent attempts. It stores an
output override only when the accepted human answer changes the carried checkpoint output. Readers
count these parent attempts to derive `carriedStepCount`.

`session_entries` remains the only durable copy of settled Pi entries. `attempt_entries` links an
attempt to its prompt, response, first, and last Pi entries. Interactive prompts and visible
assistant outputs are read from those entries. A structured submitted output or an action output
continues to use `node_attempts.output_hash`.

Current-node fields come from the one active attempt. `waitingOn` comes from the last step of a
waiting run. A continuation human-decision receipt comes from the decision and continuation rows.
Trace and session events keep order, IDs, status, and small timing facts. They do not copy prompts,
messages, tool arguments, tool results, or workflow outputs.

## Cleanup

Add an explicit command:

```text
pi-workflows state prune --before <timestamp> --dry-run
pi-workflows state prune --before <timestamp> --backup <absolute-path> --apply
```

The command selects complete terminal run trees older than the cutoff. It refuses a tree with an
active queue, active lease, unsettled effect, controller reference, channel reference, or a step
reference from a run outside the tree. Apply mode requires and verifies a backup. It rechecks the
selection in an exclusive transaction, deletes the selected aggregates, removes unreferenced blobs,
checkpoints the WAL, vacuums the database, and runs SQLite integrity and foreign-key checks. Startup
never runs cleanup.

## Verification

Focused tests cover repeated large outputs, repeated large interactive prompts, long delta-heavy
sessions, continuation step sharing, incompatible old state, and prune safety. The repository checks
run once after their code surface is final. Pi Reviewer then checks the pull request until no P0 or
P1 issue remains. CI must be green before the rebase merge and patch release.
