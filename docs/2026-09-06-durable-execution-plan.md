---
title: Simplify durable workflow execution
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-06
status: in-progress
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
- Response replay after settlement, unified scheduling, timing, explicit model work, shared controls, client updates, and final validation remain in progress.
