---
title: Simplify durable workflow execution
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-06
status: complete
---

# Simplify durable workflow execution

## Goal

Repeated failures have made Pi Workflows difficult to trust. In the reported incident, an agent step accepted a checkpoint answer, reserved a bad continuation, and left its original request pending. A correct submission then selected another pending request. The user approved one coordinated simplification rather than separate guards for each symptom.

Each fact must have one owner, each response must target one exact request, and each additional action must have a declared reason. This plan follows [Design philosophy](DESIGN_PHILOSOPHY.md) and replaces the continuation and terminal-turn choices in the earlier [run-state plan](2026-09-04-workflow-run-state-plan.md). Existing authority, effect, source-verification, and durable-receipt protections remain requirements.

## Scope and authority

Implement, test, commit, push, open a pull request, run Pi Reviewer, verify CI, and merge the approved change in this repository against `main`. Use the legacy implementation process, not a hosted workflow. The user's approval covers this implementation and its required validation. It does not authorize edits to other repositories, a package release, installed-runtime replacement, live-state reset, new services, credential copying, or production resource changes.

Keep the global server, existing SQLite database location, TypeScript graphs, resource managers, Pi extension, and shared live client protocol. Pi core, private Pi APIs, and Pi session schemas remain unchanged.

## Selected design

### One run across checkpoints

Checkpoint answers, submitted agent results, visible assistant responses, and protected decisions complete nodes in the same run. Preserve original input, settings identities, follow-ups, session reservation, outputs, and history. An ordinary checkpoint answer becomes that node's output, not replacement workflow input.

Separate runs are reserved for independent resource-manager work and explicit fresh restarts. Delete checkpoint continuation commands, copied parent step membership, continuation queue settlement, settings transfer, and final-continuation lookup. Preserve explicit restart ancestry and independent child-work request keys.

### Exact durable requests

Use the existing durable request store for four explicit kinds: submitted agent, assistant response, ordinary checkpoint, and protected decision. A request binds the exact run, compiled node, visit, and attempt. Step instructions expose an opaque `requestId`; submission and update tools target it. The server resolves execution identity from that record and validates origin-session ownership and authority. An identifier is not a credential.

Only a submitted-agent request accepts model output submissions and supported progress updates. Assistant steps use their exact visible response evidence. Ordinary checkpoint answers require that exact request kind. Protected decisions require a verified human channel or an explicitly declared timeout policy. Retain the checkpoint primitive without its former continuation semantics.

Remove oldest-request selection, implicit retargeting, and action permission inferred from display status. Duplicate responses adopt their exact saved receipt. Stale, cross-run, cross-session, wrong-kind, and conflicting responses cannot advance execution.

### Typed host-owned transitions

Replace writable full-run snapshots with narrow execution commands. Workers execute workflow code and propose attempt results, input requests, routing, and terminal results. They do not replace authoritative run state. The host checks actor, resource revision, exact attempt, ownership generation, and legal transition before committing.

Workflow-defined validation remains in a supervised worker. A candidate awaiting validation is not an accepted result. Its validation may be recorded durably without settling the request or advancing the graph. Rejection can leave an audit receipt but cannot create another run or change another pending request.

Move lifecycle SQL out of orchestration handlers into focused store operations. Commit related domain rows, immutable events, and required follow-up effects atomically. Presentation failures cannot roll back execution state. Keep existing content references for complete large outputs.

### One scheduler

Move shared workflow queue ownership out of the resource-manager store. Resource managers retain desired and observed state, reconciliation, and stable child request keys, but use the common workflow scheduler.

Remove the independent scheduling and retry loop exported through `ResourceManagerRuntime`; retain shared reconciliation and effect helpers. Hosted scheduling and tests use the same rules.

Apply configurable worker-capacity limits across start, resume, validation, and timeout recovery. Count pending launches as well as active workers. Cancellation, cleanup, and claim renewal must not wait for execution capacity. Preserve one active interactive workflow per origin session and one active reconcile per resource key.

### Explicit model work

Replace `presentationPrompt` with explicit assistant-response nodes, using the existing summary workflow where useful. Terminal notices contain recorded facts and do not start model turns. A failed summary node uses normal graph failure routing; it cannot block cancellation or erase accepted work.

An authorized restart targets an exact terminal run and revision. It does not require a terminal message or terminal model turn. Keep explicit queued user follow-ups, but remove their dependency on a terminal model turn.

Remove hard-coded reminder and restart policies from server orchestration. A missing submission remains an exact pending request or follows a declared workflow failure/retry policy. Safe transport retries and interruption recovery do not authorize new logical model work.

### Separate facts and consistent views

Execution progress, queue delivery, worker ownership, Pi message delivery, and Pi activity remain separate facts with explicit owners. Do not flatten them into one enum or infer one from another. Terminal execution remains terminal during reporting. A sent message does not complete a request, and a process does not prove progress.

The server produces one live status and allowed-action view from authoritative facts. All clients consume it. Action handlers independently validate the same contract at commit time. Keep one wire-schema source and shared TypeScript/Rust conformance fixtures.

### Recovery and time

Logical node visits retain stable effect identities. Pausing or parking preserves a request; retry creates a new attempt only when execution actually retries. Old attempts cannot submit to their replacements.

Recover from accepted outputs and effect receipts without repeating committed work. Fence stale workers by claim generation. Do not relaunch automatically without meaningful saved progress or a declared recovery transition; heartbeats and display revisions are not progress. Uncertain external effects require their declared observation or human recovery path.

Do not rewrite historical start timestamps. Account for agent execution using recorded active intervals and elapsed execution time. Session closure, pause, message delivery, and server downtime do not spend that active budget. Human decision expiry uses its separate absolute wall-clock deadline. Inject clocks in tests and cover overlapping pause, disconnect, recovery, and clock changes.

### Human and external-effect safety

Keep approval bound to the exact subject, presentation, choices, audience, and request revision. Changed proposals require new decisions. Model output cannot grant merge, release, deployment, or other consequential authority. Human response, timeout policy, and cancellation compete for one durable winner.

Keep effect request fingerprints, stable logical identities, receipts, and explicit ambiguous outcomes. Cancelling a run does not claim an uncertain external action was undone. No exactly-once promise for model calls or external systems.

### One Pi delivery coordinator

Keep one coordinator using documented public Pi APIs. Bind messages, requests, and model turns exactly. Record low-level activity separately from the settled/idle boundary used for completion and new delivery. Preserve branch evidence during reconnect and do not infer cross-branch absence.

Use the existing `registerTool`, `registerCommand`, `sendMessage`, session events, `agent_start`, `agent_end`, `agent_settled`, `getBranch`, `isIdle`, and `hasPendingMessages` APIs. No new Pi API, local execution fallback, private hook, or second sender is required. Normal messages and tool results remain normal Pi session entries.

### Storage and diagnostics

Keep current SQLite rows and immutable events, committed together. Do not introduce another store, transport, generic event-sourcing framework, or telemetry system.

Extend existing status and verification paths with exact pending operation, rejection reason, recovery safety, and valid next actions. Check terminal requests, conflicting ownership, and queue consistency without silently repairing ambiguous state. Update existing retention and backup checks for the simpler run model; retain unresolved work and referenced output.

## Delivery sequence

1. Record the approved design and freeze incident failures in deterministic tests.
2. Implement exact request identity and host-owned transition rules.
3. Complete all checkpoints in the same run and remove continuation-only state.
4. Unify scheduling, recovery, timeout accounting, and declared model work.
5. Update built-ins, Pi delivery, tool schemas, clients, viewer fixtures, and canonical documentation.
6. Remove superseded contracts and exports; run all local and installed-package checks.
7. Push the current head, run Pi Reviewer against `main` until no P0/P1 finding remains, address PR comments, verify CI, and merge.

Use coherent commits and keep this plan current across context changes. Do not call an incomplete slice the completed architecture.

## Required tests

Test every action against every request kind and include exact run, session, node, attempt, and request mismatches. Reject invalid actions before domain changes; permit only their audit receipts. No rejection may create a child run, settle another request, or complete a queue item.

Cover duplicate and reordered delivery, candidate validation, acceptance, lost acknowledgments, cancellation, pause, stale claims, and server restart before and after each commit boundary. Cover concurrent human reply, timeout policy, and cancellation. Cover source changes, Pi reconnect and branch changes, automatic Pi retries, missing submissions, terminal reporting, and explicit follow-ups.

Inject external success followed by loss of its receipt. Verify that automatic recovery does not repeat uncertain effects. Check capacity on all launch paths, including pending launches. Verify queue and request invariants after deterministic generated command sequences.

Run a complete composed workflow through ordinary and protected checkpoints, pause and resume it, finish it, and explicitly restart it. Verify that checkpoints never create run rows and restart never copies old steps, settings mutations, approvals, or effects. Verify widget, CLI, and Rust viewer agreement.

## Verification commands

```bash
npm run check
npm run test:e2e
npm run test:e2e:live -- --runtime-only
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
cargo test --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path tui/Cargo.toml --check
git diff --check
```

After deterministic checks, use one authenticated low-cost real-model E2E with an exact provider and model ID. Prefer `openai-codex/gpt-5.6-luna`, `openai/gpt-5.6-luna`, or `openrouter/deepseek/deepseek-v4-flash` when available. Pass provider and model separately and verify runtime selection. Use credentials in place; do not copy them into a temporary profile.

Push before each review. Run `pi-reviewer --base main` with configured defaults and a ten-minute tool-controlled limit. Do not substitute another reviewer. Inspect CI only after the last review has no P0/P1 findings.

## Alpha replacement and operational boundary

Keep current schema version identifiers and replace contracts in place. No compatibility readers, migrations, aliases, dual writes, parallel version identifiers, or feature flags solely for old state. Incompatible state must fail before mutation with the documented backup-and-reset instruction.

All automated tests use temporary directories and deterministic model substitutes. Keep the installed runtime and live database unchanged during this task. Deployment must either finish existing work under the old version or obtain explicit approval before abandoning/resetting incompatible state. Do not automatically copy credentials, install a service, or publish a package.

## Progress

- Approved proposal recorded on `refactor/durable-execution`.
- Added the incident regression: a checkpoint answer at an agent request leaves queue and request state unchanged; a correct submission still completes it.
- Replaced worker snapshot writes with narrow execution transitions. Updates now read authoritative stored state, and workflow node contexts are frozen snapshots.
- Waiting runs no longer have terminal timestamps. Request creation now checks run/attempt identity, keeps accepted requests immutable, and enforces one pending request per run.
- Checkpoint requests now retain the same run, input, attempt, settings, and follow-ups. Request creation and parking commit together. A verified human response or declared timeout completes that request; a normal answer cannot settle a protected decision.
- Removed checkpoint continuation commands, copied steps and output overrides, continuation records, parent queue settlement, and settings transfer. Only explicit fresh restarts can declare run ancestry. Accepted responses remain discoverable for scheduler recovery after a host interruption.
- Typecheck and lint passed after the checkpoint cutover. The complete deterministic suite passed 1,167 of 1,170 tests. Two tests exceeded their time limits under concurrent load; the third exposed an abort test that assumed process startup within 80 ms. That test now waits for observed startup before aborting. All 16 tests in those three files passed with two workers. Repeat full validation after the remaining work.
- Model submissions and updates now name an opaque `requestId`, not a step/attempt pair. Checkpoint answers and human commands also require an exact request ID. The hosted and headless paths use the same contract. Old tool shapes are rejected.
- After this contract change, 1,170 of 1,174 tests passed with two workers. The four failures were old test contracts without request IDs. Their replacement tests pass; a new test also rejects a message whose request ID differs from its contract. Typecheck passed, and the reported lint issues were corrected.
- The server now derives response controls from the pending request kind. Waiting alone cannot expose `answer`. Terminal execution and durable pause keep their labels while worker or Pi activity is reported separately. Removed the remaining engine path that treated waiting as a terminal result. Typecheck, lint, 33 foundation tests, and nine live-view tests passed for this slice.
- Response tools now resolve the exact durable request rather than the pending-view cache. The host checks live origin-session ownership before receipt lookup. Identical submissions adopt their saved result after settlement; conflicting payloads, stale coordinator epochs, other sessions, and the wrong response kind are rejected. Assistant response delivery has a separate private operation. Focused replay, authority, and active-time tests pass; typecheck and lint pass.
- Every hosted execution launch now passes through one capacity check, including resource-manager reconciles, fresh starts, restart, resume, response validation, and expired interaction recovery. Pending launches count toward capacity. Start only reserves durable work. Removed direct response launches, the separate resource-manager capacity rule, and the in-memory pending-resume queue. Capacity is configurable; cancellation and renewal do not wait for it. Interactive reservations survive parking; headless work does not reserve a Pi session. Typecheck, lint, and all 37 focused queue, lifecycle, and capacity tests pass.
- The complete deterministic suite passed all 1,186 tests after scheduler admission changed.
- Moved run queue ownership into `src/workflows/queue.ts`. Resource-manager storage no longer exposes queue operations. Both domain stores reuse the existing SQLite connection and shared project/revision helpers. Removed the unused reserve-and-claim convenience API and old source-repair stubs. Queue, fencing, resource storage, extension, and scheduler tests passed except for one shared read-only connection case; the constructor now uses the connection's actual mode. All 20 tests in the follow-up view, protocol, effects, and hosted resource checks pass. Typecheck and lint pass.
- Removed `ResourceManagerRuntime` and its separate scheduling/retry loop. Replaced its lifecycle and example tests with real hosted-worker tests. The stale-claim test exposed an unhandled failure write from a replaced resource worker; failure recording now checks claim authority in the same transaction as its requeue. Success also commits status, audit, and queue settlement together. All ten hosted resource tests pass, including stale generations, one reconcile per key, timeout, delayed requeue, finalizers, child work, and exact-head fake merges. Typecheck and lint pass.
- Removed `presentationPrompt`, terminal-triggered model turns, server reminder counters, terminal-turn restart requirements, and hard-coded restart limits. Autoimplement now has explicit summary nodes; summary failure retains the prepared result. Terminal notices contain deterministic recorded facts, and explicit follow-ups wait only for notice delivery. Restart targets an exact terminal run revision, adopts duplicate commands, and rejects unsettled effects. Tests cover five explicit restarts with no model turns and a missing external-effect receipt.
- The Pi coordinator now submits assistant responses and closes workflow turns at `agent_settled`, not `agent_end`. Automatic Pi retries retain the same turn. Reconnect and late binding require exact branch evidence. Tests verify that unfinished text is not submitted and that four missing submissions create no reminder messages or hidden failure.
- The deterministic suite reached 1,187 passing tests with one new test expectation corrected afterward. The corrected summary-failure test and the restart/effect-safety test pass. Typecheck and lint pass. Full required checks, installed-package E2E, real-model E2E, reviewer, and CI have not run for this slice.
- Replaced shifted deadlines and rewritten start timestamps with a resolved timeout budget and numbered active intervals in the existing SQLite database. The host samples a monotonic clock. Pauses, disconnects, wall-clock changes, and downtime do not spend the budget. Recovery retains the last durable sample and closes its old interval; no unobserved time is charged. An interval table is needed to retain the actual start, stop, and elapsed evidence without duplicating a cumulative counter or changing historical timestamps. It adds no transport or separate store.
- Clock tests cover duplicate starts, overlapping inactive causes, backward and forward wall-clock changes, crash recovery, transaction rollback, and immutable attempt starts. The hosted test covers pause plus disconnect, paused reconnect, two host restarts, and eventual timeout. The full suite reached 1,190 passing tests with only the expected schema-table count changed. After that fixture update, all 20 clock and database tests pass. Typecheck and lint pass.
- Completed client and documentation updates. The host now checks the legal next graph node and rejects fabricated completion outputs. Shared read-only diagnostics check requests, active clocks, queue settlement, and overlapping workflow turns through the existing status, verification, and backup paths. Removed unused queue affinity fields and the resource-runner error truncation.
- Delayed Pi delivery acknowledgments retain the exact settled response. The coordinator reports the start, submits that saved response, and reports the end in order. A transport failure retains this evidence for retry. This covers the same-process acknowledgment race; it does not promise recovery of an unaccepted response after all local settled-event evidence is lost.
- All 1,195 deterministic tests pass. Typecheck and lint pass. All 75 Rust tests, Rust formatting, and Clippy pass. SimpleDoc reports the same nine existing naming/frontmatter issues and 24 reference updates on both this branch and base commit `ca46ad9`; this change does not rename those unrelated canonical documents.
- Full coverage passes above all 85% thresholds. The installed-package runtime-only E2E passes with Pi `0.85.0`. Slophammer reports zero DRY candidates and no dependency-boundary findings.
- Real-Pi E2E exposed old test fixtures that still submitted step/attempt fields and expected a flattened running status. Updated those fixtures to the exact request contract and deterministic terminal notices. It also exposed conversation capture waiting for the removed terminal model turn. Capture now finalizes after confirmed terminal delivery, and follow-ups use separate capture segments. The delivery callback retries exact acknowledgment failures; capture errors remain observational and do not block later work. All 11 real-Pi E2E tests and 14 focused recorder/coordinator tests pass.
- Final checks after the capture fix pass: 1,196 unit tests and 11 real-Pi E2E tests. Coverage is 90.93% statements, 85.49% branches, 95.22% functions, and 92.54% lines.
- The first real-model attempt used the exact registered `openrouter/deepseek/deepseek-v4-flash` model, but OpenRouter rejected Pi's 384,000-token default output allowance for insufficient credit. No workflow output was accepted. Stopped only the isolated test Pi process; the harness removed its temporary root and reported no credential in output. Added an explicit `--max-output-tokens` test option using only Pi's documented built-in model budget override in the generated profile, with no endpoint, API, credential, or model-ID change. Existing profiles cannot be modified by this option. The harness now fails immediately on provider errors instead of waiting for the workflow timeout.
- The final automated checks pass: 1,198 unit tests and 11 real-Pi E2E tests. Coverage is 90.94% statements, 85.50% branches, 95.26% functions, and 92.56% lines. Slophammer remains clean. SimpleDoc still reports exactly the base commit's existing issues.
- The bounded live-model retry passes through the packed package with Pi `0.85.0`, exact provider `openrouter`, model `deepseek/deepseek-v4-flash`, API `openai-completions`, and verified 4,096-token output allowance. Run `20260906T142741815Z-live-model-e2e-3c7da2e7` returned the exact smoke-test result, recorded one accepted step and complete conversation capture, and reported cost `$0.000220823566`. The same run also repeated the model-free installed-package checks. The launcher confirmed no credential in output and no remaining test roots.
- Opened [PR #84](https://github.com/osolmaz/pi-workflows/pull/84). The first configured Pi Reviewer run completed within ten minutes. It found a P1 reconnect fingerprint omission and a P2 ancestor follow-up cancellation error. Fixed both: submission and assistant-response fingerprints now exclude only the already-validated coordinator epoch; terminal cancellation applies only to the exact source run. Added all response-kind fingerprint tests, a real socket reconnect/adoption regression, and a hosted explicit-restart failure regression that preserves the completed parent's queued follow-up.
- The reconnect regression passes. All 16 focused protocol and restart tests pass. Full validation passes with 1,202 unit tests, 11 real-Pi E2E tests, 90.95% statement coverage, 85.50% branch coverage, 95.30% function coverage, and 92.57% line coverage. Slophammer remains clean. The repeated installed-package and exact-model E2E passes: run `20260906T145032833Z-live-model-e2e-b787f282`, reported cost `$0.000218874234`, same provider/model/API and 4,096-token allowance, no credential in output, and no remaining test roots. The second review found one P1: startup still directly admitted a resource reconcile beside the shared scheduler. Removed that call. The new hosted startup test seeds both kinds of work with `maxWorkers: 1`; it observes two workers with the old line restored and one worker with the fix. Both queues then finish through the shared scheduler. Revalidation passes: 1,203 unit tests, 11 real-Pi E2E tests, all coverage thresholds, and both Slophammer checks. The packed-package live-model check also passes again with the same exact provider/model/API and allowance: run `20260906T150821925Z-live-model-e2e-6dd6ab23`, reported cost `$0.00022472223`, no credential in output, and no remaining test roots. The third review was interrupted. The replacement review completed within ten minutes and found one P1: slash-command restart supplied a presentation revision where execution required the run resource revision.
- Run views now expose both `revision` for presentation and `runRevision` for execution. The restart command uses `runRevision`, and the client rejects views without a valid execution revision. The host and viewer share the run-store revision reader. The shared protocol fixture and documentation describe the separate fields.
- A new real-Pi test restarts a completed run after conversation capture. It also exposed a pending `run.park_queue` receipt created by an unchanged waiting-state update. Settlement effects now describe actual status changes, and successful queue release settles its matching receipt in the same transaction. The test verifies that no unsettled receipt remains, the two revisions differ, and the restarted child records the exact execution revision. Revalidation passes: 1,203 unit tests, 12 real-Pi E2E tests, all coverage thresholds, both Slophammer checks, and all 75 Rust tests with the updated shared fixture. Rust formatting and Clippy also pass. The packed-package exact-model E2E passes again: run `20260906T154630721Z-live-model-e2e-3fd0981a`, reported cost `$0.000226848774`, same provider/model/API and allowance, no credential in output, and no remaining test roots. The next review found no P0/P1 issues and one P2: pausing an active validation worker left its model-time interval open. The host now closes that interval in the pause transaction. A gated validation regression passes with the fix and fails with the close removed. The first inspected CI head passed check, E2E, installed-package E2E, and Rust checks. There were no PR comments or reviews to resolve. Final validation of the pause fix passes: 1,204 unit tests, 12 real-Pi E2E tests, all coverage thresholds, and both Slophammer checks. The exact-model packed-package check also passes: run `20260906T160502392Z-live-model-e2e-ac812c05`, reported cost `$0.000217810962`, same provider/model/API and allowance, no credential in output, and no remaining test roots. The final configured Pi Reviewer run reports no findings. All four [CI jobs](https://github.com/osolmaz/pi-workflows/actions/runs/34044353730) pass for code commit `8ff276e`. No PR comments or review threads required resolution.
- Rebase-merged [PR #84](https://github.com/osolmaz/pi-workflows/pull/84) on 2026-09-06. The merged tree matches the reviewed and tested code tree. Removed the completed branch; no task worktree remains. No package was released, no installed runtime was replaced, and no live workflow database or production resource was changed. SimpleDoc's unchanged baseline issues remain outside this implementation.
