---
title: Workflow handoff and fixed run definitions
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-07
status: complete
---

# Workflow handoff and fixed run definitions

Keep the architecture small. Make ownership, delivery, and recovery rules explicit.
This corrects regressions found after the [durable execution work](2026-09-06-durable-execution-plan.md).
Normal chat currently leaves a turn record that blocks the first workflow message.
Forced resume accepts changed source, then fails against the old saved graph.

## Scope

Change only pi-workflows. Implement, test, commit, push, review, and rebase-merge this
change into main. Do not release, install packages into user profiles, alter live
runs, reset databases, or modify Pi itself. No new workflow primitive, database,
transport, persisted schema, compatibility path, or hidden model retry is needed.

## Design

- The extension tracks only workflow-owned turns. Its local states are absent,
  delivering, running, and settled awaiting server acknowledgment. Normal chat
  creates no owned turn. Pi automatic retries retain the same owned turn.
- Save delivery identity before the public `sendMessage` call. Confirm delivery
  from the public session branch. Retry reports with the same identity; never
  resend a message merely because its acknowledgment was lost. Preserve an exact
  settled response until submission and turn-end acknowledgment succeed.
- Resume requires the original source and graph. Remove the `force` option.
  Reject changes before any durable mutation. A changed definition requires an
  explicit new run; accepted outputs and approvals are not silently transferred.
- Derive delivery, active model work, required results, and pause labels from
  existing message, turn, request, and run records. An unconfirmed message is not
  proof that the agent received it. A start receipt proves only that a run exists.
- Use Pi's public `agent_start`, `agent_end`, `agent_settled`, `sendMessage`, and
  session branch APIs. Pi's normal message delivery appends the existing custom
  message entry. There are no new Pi session fields or changes to Pi internals.

## Acceptance and validation

Tests must cover ordinary chat before and during start, full step delivery and
submission, automatic retries, delayed branch and turn acknowledgments, reconnect,
cancellation, pause/resume, and changed source or graph. Assert delivery counts,
exact receipts, and durable state. Rejected resume must leave the run unchanged.
Use real Pi with a mock provider for automated full-lifecycle tests, then a
separate authenticated low-cost model for a tool-started live lifecycle.

Run `npm run check`, `npm run test:e2e`,
`npx slophammer-ts@latest dry .`, and
`npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`.
Run SimpleDoc and relevant Rust viewer checks. Existing unrelated documentation
issues must be identified, not silently repaired. Push before running
`pi-reviewer --base main`; address P0/P1 findings before checking CI and merging.

## Completion evidence

Implemented in PR #85. Local validation passed with 1,215 unit tests, 13 real-Pi
mock-provider E2E tests, and 76 Rust tests. Slophammer, Clippy, and format checks
passed. SimpleDoc reports the existing nine naming/frontmatter issues and 24
reference updates.

The final code commit passed the authenticated live test with
`openrouter/deepseek/deepseek-v4-flash`, Pi 0.85.0, and a 4,096-token output
allowance. It verified ordinary chat, a model tool start, exact submission,
next-step completion, and saved conversation capture. The isolated Autoimplement
test also verified actual temporary worktree creation before cancellation.

The first reviewer attempt stopped on an unsupported local provider configuration.
After that configuration was repaired, the configured reviewer found a P1 recovery
case: a delivered step without an active workflow turn could claim an ordinary
chat response. Recovery now requires the recorded active turn and its exact
message as the latest user or custom input. Regression tests cover missing turn
records and later ordinary input. The configured reviewer then completed with no
findings. All four CI jobs passed; the check job needed an unchanged retry after
a lease-renewal test timed out. That test also passed locally in the full suite
and a focused run.

[PR #85](https://github.com/osolmaz/pi-workflows/pull/85) was rebase-merged on
2026-09-07. The branch was removed. The final live-model run was
`20260907T033236999Z-live-model-e2e-8c53326e`, with reported cost $0.0004163409.
No Pi Workflows installation or live run was changed. Recovery of an installed
live session is separate work and requires approval to update that installation.
