---
title: Run workflows outside Pi
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-30
---

# Run workflows outside Pi

Status: implemented. The implementation keeps schema version 1, uses one global on-demand host, and has no embedded production fallback. The approved [workflow-message restoration plan](2026-09-02-unify-workflow-messages-plan.md) fixes the later model-turn status bug and restores session features that the hard cut removed.

A live workflow lost its lease while it was still working. The workflow engine kept the Node.js event loop busy, so its renewal timer did not run before the 30-second lease expired. The next state write used a generic error, the extension treated the error as a crash, and durable state was left with a running queue row, a running attempt, an expired lease, and a separate failed audit event.

This plan fixes that failure first, then removes its root architectural cause. One user-level host will own workflow state. Each active run will execute in a supervised child process. Pi will become a client that starts work, presents interactive requests, and submits answers through documented extension APIs.

[Workflow host](WORKFLOW_HOST.md) defines the complete target process, protocol, state, recovery, and Pi integration contracts. This plan gives the implementation order and acceptance checks.

## Goals

- Renew a valid run lease in the same transaction as every protected state write.
- Reject every stale writer with a typed claim-loss result.
- Keep run, queue, attempt, decision, lease, audit, and viewer state consistent.
- Recover or cancel expired running rows without treating a live owner as stale.
- Move workflow code out of the Pi extension and host processes.
- Make the host the only normal writer to the workflow database.
- Preserve interactive workflow steps in the original Pi session.
- Supervise workflow children with bounded startup, runtime, output, and shutdown behavior.
- Make retries safe for pure work and explicit for external effects.
- Keep the workflow engine independent of Pi and use documented Pi extension APIs only.

## Non-goals

- Do not change Pi source, private Pi APIs, or Pi session schemas.
- Do not add a remote service, distributed consensus, or network database.
- Do not claim exactly-once execution when an external system has no idempotency support.
- Do not keep the embedded runner as a fallback after the host path is complete.
- Do not add a compatibility reader, dual path, `v2` schema, or automatic state migration for older alpha databases.
- Do not install an operating-system service as part of this change.

## Original failure

The former extension and host renewed 30-second run claims from 10-second `setInterval` callbacks. `src/workflows/engine.ts` can execute a long sequence of synchronous graph transitions without a macrotask yield. A long synchronous node can also block the event loop by itself.

`src/workflows/store.ts` checks lease expiry during a protected write. Every ownership failure currently becomes `Error("Workflow run write rejected because ownership changed")`. The extension handles `ClaimLostError` as a normal handoff, but it handles this generic error as a workflow crash.

The former public cancellation path handled an in-memory run, a queued or starting row, or a waiting human decision. It could not claim and cancel an expired running row.

The former standalone host executed the workflow engine in the same process that renewed claims. Workflow code could therefore block host renewal too.

## Core rules

1. A run has one current claim generation.
2. A stale generation cannot write.
3. An expired claim cannot renew itself.
4. A valid protected write renews the claim and updates state in one SQLite transaction.
5. A true claim loss stops the old runner without a terminal run write.
6. One lifecycle transition updates every related projection in one transaction.
7. Waiting and paused runs release their claim and need no live child.
8. The host executes no workflow code.
9. A workflow child writes no workflow state directly.
10. Pi is the origin client, not the run owner.
11. A durable command is acknowledged only after it is committed.
12. A side effect is retried only when its contract makes the retry safe.
13. The production runtime has one execution path.

## Part 1: Correct lease handling now

### Typed claim loss

Replace the generic ownership error with `ClaimLostError`. Add a nonsecret internal reason for missing authority, expiry, owner mismatch, token mismatch, and generation mismatch. Logs may include the run ID and reason. They must not include the claim token.

### One fenced write transaction

Route every ownership-protected run mutation through one store operation. The operation will:

1. Read the expected resource revision and current lease.
2. Compare owner type, owner ID, token hash, and generation.
3. Require `expires_at` to be later than the transaction time.
4. Update `heartbeat_at` and `expires_at` for the same owner, token, and generation.
5. Apply the domain mutation, event, viewer delta, and revision bump.
6. Commit the complete change.

The claim identity provider may return the caller's identity after local expiry so the store can classify the exact failure. The store remains the authority. It must never renew a lease whose stored expiry has passed.

The timer remains as a backup for asynchronous waits. Correctness must not depend on the timer firing between normal state writes.

### Engine fairness

Yield with `setImmediate` after each committed graph transition. This lets timers, cancellation, and UI work run between fast synchronous nodes. The yield is a fairness measure. Process isolation remains the fix for one long synchronous node.

### Crash classification

A claim-loss catch path will:

- stop the old engine;
- skip terminal run writes;
- skip failed audit events, fallback turns, and terminal callbacks;
- report that the run is available to another runner or already continues there.

Unknown database and engine errors remain failures.

## Part 2: Keep lifecycle state consistent

Create one lifecycle store boundary for run and queue changes. Start, park, wait, resume, complete, fail, and cancel operations will update these facts together:

- run status and finish data;
- queue status and availability;
- active node attempt;
- human decision state when applicable;
- claim release or renewal;
- immutable event;
- viewer projection.

The store will reject impossible transitions. It will not add an audit event without the matching current projection.

Add a read-only diagnosis for contradictory rows. Add a focused repair operation only for states that have exact durable evidence. The repair must not invent successful work.

## Part 3: Recover and cancel stale runs

Add an atomic control claim for an expired run. It will require an expired or absent lease, reject terminal rows, increase the claim generation, and bind a new token before any mutation.

Cancellation will use that claim to commit one terminal cancellation. It will also close an active attempt, cancel pending interactions and human decisions, cancel effects that have not started, and mark applying effects ambiguous. A live claim cannot use this path.

Startup recovery will make expired running rows claimable. A resumable run will continue from its last durable boundary. A run with an uncertain unmanaged side effect will stop for manual review instead of retrying.

## Part 4: One global host

The state database is global to one user installation. Use one host for that database, not one writing host per project.

The host will:

- own all run claims;
- accept commands from Pi clients and command-line clients;
- validate and commit state transitions;
- supervise workflow child processes;
- dispatch durable interactive requests;
- recover work after restart;
- reconcile controllers;
- expose safe status without payloads or tokens.

The host event loop will contain only bounded IPC, short SQLite transactions, timers, and process supervision. It will not load or execute workflow definitions.

The existing package CLI will provide explicit host start, status, and stop behavior. The Pi extension may start the package host on demand. The package will not install systemd, launchd, or another operating-system service.

## Part 5: Local protocol

Use a versioned package-owned local protocol over a user-only Unix socket or the platform equivalent. Socket permissions must limit access to the current user.

Every request will include:

- protocol schema;
- request ID;
- command kind;
- run ID when applicable;
- node and attempt ID when applicable;
- claim generation;
- expected revision;
- idempotency key;
- bounded payload.

The protocol will support start, pause, resume, cancel, ordinary checkpoint answers, protected human answers, interactive step submission, notification delivery, terminal turn delivery, node transition proposals, child progress, child exit, and managed effect operations.

A command is successful only after the host commits it. Duplicate request IDs return the stored receipt. Stale revisions, generations, attempts, and idempotency conflicts return typed rejections.

The host will bound message size and connection buffering. Malformed messages will close only that connection.

## Part 6: One child per active run

Each active workflow runs in a supervised child process. The child receives an immutable launch envelope with the run ID, generation, workflow source identity, project directory, input hash, and protocol endpoint.

The child will:

- verify the root and every mounted source identity before it loads workflow modules;
- load the workflow and compare the resolved mounted-source map with the saved map;
- execute graph and node code;
- propose state transitions to the host;
- request interactive work or managed effects;
- exit when the run parks, waits, finishes, or loses its generation.

The child will not receive a writable state store. This is an architectural boundary against accidental writes, not a security sandbox against malicious same-user code.

The host will enforce:

- startup handshake timeout;
- node and run cancellation;
- bounded stdout and stderr capture;
- process-group termination;
- `SIGTERM` followed by bounded `SIGKILL`;
- orphan cleanup on host restart;
- portable limits where Node and the operating system expose them.

## Part 7: Preserve interactive Pi steps

Interactive agent and assistant-message steps remain in the origin Pi session.

When a child reaches one of these steps:

1. It sends a durable interactive request to the host.
2. The host commits the request and parks the run.
3. The child exits and the claim is released.
4. The Pi extension presents the exact step contract through documented Pi messaging and tool APIs.
5. The extension sends a provisional result to the host with the request, node, attempt, and revision identifiers.
6. The host records it as `validating` and schedules a new supervised child from that durable boundary.
7. The child loads the workflow and runs the node's `validate` function.
8. The host settles the request only after the child accepts it. A rejection keeps the request pending and returns the durable validation error to the model.

If Pi closes, the request stays pending until its durable node deadline. Reopening the same session presents the same request once. A duplicate submission returns the original receipt. The host enforces the saved deadline while the worker is absent and after restart. An expired request atomically closes and starts a supervised child that records the same attempt as timed out. The workflow can route that result through `$result.outcome`; otherwise the run becomes terminal and releases its session reservation. A child failure during validation rejects only that provisional submission and leaves the request ready for a corrected retry. If the host stops after it records `validating` but before activation, startup recovery schedules that same submission unless its deadline expired.

Keep one active interactive request per Pi session. Other requests remain ordered and durable.

A protected human decision is displayed without starting a model turn. The model-facing workflow tool rejects it. A person answers it through the origin Pi session, while an ordinary checkpoint keeps its model-facing answer path.

Notify nodes and terminal results create `workflow_messages` records in the same transaction as their source facts. The origin Pi session claims and adopts both message kinds through the one shared coordinator. There is no notification outbox or terminal-turn intent send path.

Detached workflows can use host-managed `pi --mode rpc` children. Their execution mode and origin are durable provenance.

## Part 8: Safe effects and retries

Treat compute nodes as pure work. A child crash may rerun a compute node from its last committed boundary.

Side-effecting action nodes must use a managed effect record with a stable key and request fingerprint. The host reserves the effect before execution and stores its receipt after execution. Duplicate requests return the stored receipt.

An adapter may report safe retry only when the external system supports an idempotency key or a read-back check proves the result. If a child can have completed an external action but no receipt exists, mark the effect uncertain and stop for manual recovery.

Migrate package-owned workflows to this rule before the host path becomes the only runtime. Do not silently treat arbitrary action code as exactly once.

## Part 9: Alpha state change

This repository's alpha policy requires an in-place schema change with the current schema identifiers. Do not add a migration, compatibility reader, dual path, alias, or `v2` schema.

The changed DDL digest will reject an older state database with the standard clear reset instruction. The old file remains untouched. Documentation must tell users how to back it up before resetting.

The new state shape will add the minimum durable records needed for:

- host command receipts;
- interactive requests and submissions;
- child process epochs and exits;
- uncertain effects when existing effect rows cannot express the state.

Reuse attempts, effects, and feature-specific source records when they already provide the required contract. `workflow_messages` is the only record for content that Pi must add to an origin session. Add no parallel send record for the same fact.

## Part 10: Hard cutover

Land the work in coherent commits and keep one implementation pull request. The final production change will:

1. Use the host path for every new run.
2. Remove embedded engine execution from the extension.
3. Remove host-side in-process workflow execution.
4. Remove old renewal-only ownership handling.
5. Keep read-only viewers on the same canonical database.
6. Keep the extension as a documented Pi client.
7. Keep no fallback or feature flag for the old path.

The host protocol and worker runtime may exist under tests before the final switch. There must never be two selectable production runtimes.

## Tests

### Lease regression

- Run more than one lease interval of synchronous transitions with a fake clock and blocked timers.
- Prove that each valid write renews the lease atomically.
- Prove that an expired claim cannot renew itself.
- Prove that a new generation fences the old token.
- Prove that claim loss adds no failed run event.

### Lifecycle consistency

- Crash before and after every lifecycle commit.
- Verify run, queue, attempt, decision, lease, event, and viewer state.
- Cancel an expired running row.
- Commit live cancellation and its command receipt in one transaction before worker shutdown.
- Cancel a committed run before its scheduled worker activation.
- Reject stale cancellation against a live owner.
- Recover a resumable expired run.
- Stop an uncertain effect for manual review.

### Host and child isolation

- Block a child event loop longer than the run lease and prove the host keeps ownership.
- Kill Pi while a run computes.
- Kill a child before and after a proposed transition.
- Kill the host before and after a committed transition.
- Restart after a provisional interaction submission commits but before child activation.
- Change an included source and prove the resumed child rejects it before module execution.
- Start two hosts and prove that one is rejected or fenced.
- Reject stale child messages after a generation change.
- Kill complete process groups on cancellation.
- Bound malformed input and output floods.

### Interactive bridge

- Start a workflow from real Pi with the mock provider.
- Commit and present an interactive request.
- Restart Pi before submission and present the same request once.
- Restart the host after an interactive deadline expires, close the request, and resume the same attempt into its timeout route.
- Submit once and replay the same receipt for a duplicate.
- Run workflow-specific submission validation only in a supervised child.
- Return an actionable validation error and accept a corrected submission for the same request.
- Reject a stale attempt submission.
- Continue an ordinary checkpoint through the model-facing answer action.
- Reject a protected human decision from that model-facing action.
- Deliver a notify node through the durable origin-session outbox.
- Start one terminal presentation turn only after completion commits.
- Finish the run and preserve normal visible session entries.

### Effects

- Deduplicate a repeated effect request.
- Recover a stored effect receipt after child and host restart.
- Mark a request uncertain when completion cannot be proved.
- Never auto-retry an uncertain effect.

### Repository gates

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Run Pi Reviewer against `main` until no P0 or P1 findings remain. Check pull-request comments and CI after the final review passes.

## Acceptance criteria

- The observed event-loop starvation cannot reproduce false ownership loss.
- A stale runner cannot write after expiry or generation change.
- A child blocked longer than the lease cannot block host renewal.
- Run lifecycle projections remain consistent after injected crashes.
- Expired running rows can be resumed or cancelled safely.
- Pi restart does not lose or falsely fail pending work.
- An unanswered interactive request keeps its original node deadline, follows its timeout route, and cannot hold a stale session reservation forever.
- Host restart recovers durable work without duplicate transitions.
- Interactive steps still use the origin Pi session.
- Duplicate commands and submissions return stored receipts.
- A submission is not accepted until supervised workflow validation succeeds.
- Effects are deduplicated or marked uncertain.
- The extension and host execute no workflow code in production.
- Pi source, private APIs, and session schemas remain unchanged.
- The old in-process runtime and all compatibility paths are removed.
- Local checks, real Pi end-to-end tests, Pi Reviewer, pull-request review, and CI pass.

## Contract impact

- **Session state:** Normal Pi messages and tool results continue to append through documented Pi behavior. Pi Workflows does not edit Pi session files or schemas.
- **Other persistent data:** The canonical workflow SQLite shape changes in place. Older alpha state requires an explicit backup and reset.
- **Pi internals:** None.
- **Public Pi APIs:** The extension uses documented commands, tools, session lifecycle events, message sending, widgets, and status APIs.
- **Workflow authoring API:** Graph structure stays stable. Side-effecting actions gain an explicit managed-effect or manual-recovery requirement.
- **Runtime:** Workflow graphs execute in supervised child processes. One global host owns state and claims.
