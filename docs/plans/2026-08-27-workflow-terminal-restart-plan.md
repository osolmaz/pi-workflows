---
title: Let the model decide what follows a terminal workflow result
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-27
---

# Let the model decide what follows a terminal workflow result

A workflow run can end while the user's larger task is still unfinished. A technical failure, a timeout, or the `maxSteps` limit can end the run without resolving the task. Pi Workflows must give the model one normal turn to inspect the result and decide what to do next.

The model already receives the conversation from Pi. This feature does not find, copy, hash, or store an original user message. It adds the workflow result and terminal reason to the next model turn and lets the model use the conversation it already has.

Related documents:

- [Workflow authoring reference](../workflows.md)
- [Deferred workflow turns](../DEFERRED_TURNS.md)
- [SQLite state](../SQLITE_STATE.md)
- [Continue normal work after a workflow finishes](../2026-08-25-workflow-follow-ups.md)

## Goals

- Give every terminal top-level interactive run at most one normal successor model turn.
- Tell the model the workflow name, run ID, exact input, result, terminal state, terminal reason, and restart history.
- Let the model stop, restart the same workflow, start Monitor, ask for a required decision or authority, or take another safe action.
- Prefer a safe restart when an unexpected technical or temporary failure leaves the user's task unfinished.
- Stop after completed work, explicit human cancellation, missing authority, a required user decision, or a repeated identical failure.
- Keep terminal runs immutable. A restart always creates a new run.
- Preserve one terminal turn and one selected launch across delivery races, reloads, crashes, and compaction.
- Keep retries bounded.

## Boundaries

- Keep the behavior in the shared Pi extension host. Workflow definitions do not add terminal nodes, prompts, flags, or restart logic.
- Use documented Pi extension APIs. Do not change Pi core or private APIs.
- Pi owns conversation history. Pi Workflows does not add original-message persistence or provenance.
- Use the existing deferred-turn coordinator, turn intents, run queue, effects, run input and result records, launch options, and activation recovery.
- Do not add a database table, store, service, controller, daemon, or external resource.
- Do not bypass human checkpoints, required review, CI, scope, authority, cancellation, or safety rules.
- Follow the alpha hard-cut policy. Do not add compatibility readers, dual paths, migrations, aliases, feature flags, or replacement schema versions.

## Terminal decision turn

Each terminal top-level interactive run creates one turn intent. Result presentation and factual fallback compete to settle that same intent. The first successful delivery wins. Reload and crash recovery can continue an unsettled intent, but they cannot send a second turn after settlement.

Waiting checkpoints are not terminal. Controller child runs and internal runs that already report to an owner do not create an independent terminal decision turn.

The turn contains these facts:

- workflow name and revision;
- terminal run ID;
- exact workflow input;
- formatted workflow result or error;
- terminal state;
- terminal reason;
- restart count and earlier terminal outcomes in the same restart chain.

Large results keep the current presentation limits and clear truncation markers. The run ID, state, reason, and restart history are always present. The workflow output is called the result.

The shared instruction tells the model that a terminal workflow result does not prove that the user's larger task is complete. The model reads the current conversation and chooses the next action:

- stop and report the result when the task is complete;
- restart when the task is unfinished after an unexpected technical or temporary failure and retry is safe and authorized;
- start Monitor when an authorized external wait remains;
- ask the user when a decision or new authority is required;
- take another safe authorized action when a workflow is not the right next step.

A workflow state of `completed` can still carry a blocked result. The model decides from the result and conversation. Explicit human cancellation always defaults to stopping.

## Restart action

Add this workflow tool action:

```json
{
  "action": "restart",
  "runId": "terminal-run-id"
}
```

The action reads the terminal run and creates a new immutable run with the same workflow reference, exact input, and safe launch settings. It leaves the old run unchanged.

The action rejects these cases:

- the run is active or waiting;
- the run does not exist;
- the run belongs to another session;
- the run was explicitly cancelled;
- the stored workflow source or revision is no longer available;
- the same terminal outcome already repeated in the restart chain;
- the restart chain reached its limit.

A later explicit user request can still use normal `start` after cancellation or a source change.

The model can select one workflow launch during the terminal decision turn. The host reserves that launch once and starts it only after the model turn settles. The selected launch can be `restart`, Monitor, or another normal workflow start. A second workflow launch from the same terminal turn is rejected.

## Restart limits

A restarted run stores these facts in the existing launch-options value:

- root run ID;
- parent run ID;
- restart number;
- parent terminal fingerprint.

The terminal fingerprint is a stable hash of the workflow identity and revision, exact input, terminal state, canonical result or error, and canonical terminal reason. It excludes timestamps, run IDs, and other values that change between equivalent attempts.

One root run permits at most three restart actions, for at most four runs in the chain. If a terminal fingerprint appears again in the same chain, another restart is rejected immediately. A changed result can remain eligible until the total limit is reached. Starting Monitor does not consume a restart.

## Delivery and recovery

The existing turn-intent claim and settlement records provide one terminal decision turn. Presentation and fallback use the same intent instead of creating separate obligations.

A launch selected during that turn uses the existing session reservation, run queue, and effect receipt. The reservation records the source terminal intent and tool call. Replaying the same request returns the existing reservation or run. It does not create another run.

The launch waits for `agent_settled`. Existing activation recovery starts a reserved launch after reload or a process crash. Recovery must preserve both limits: one terminal turn and one successor run.

## Implementation plan

### Build the terminal decision content

Add a pure helper in `src/extension/deferred-turn.ts` or a focused `src/extension/terminal-decision.ts`. Build the shared facts and instruction from existing run records. Remove the presentation instruction that forbids workflow tool calls.

Verify completed, blocked completed, failed, timed-out, `maxSteps`, and cancelled results.

### Settle one terminal turn intent

Update `finishRun` in `src/extension/index.ts`, `src/extension/deferred-turn-coordinator.ts`, and the existing turn-intent state. Create one intent for every terminal top-level interactive run. Make presentation and fallback settle that same intent.

Verify presentation, fallback, reload, and crash races. Waiting checkpoints and controller child runs must not create competing turns.

### Add generic restart

Update `src/workflows/tool-input.ts`, the workflow tool schema and help text, and control handling in `src/extension/index.ts`. Resolve the named terminal run and create a new run from its exact workflow reference, input, and safe launch settings.

Verify exact input reuse, immutable prior runs, session checks, cancellation checks, source checks, and invalid run states.

### Reserve one selected launch

Update `queueToolLaunch`, presentation tracking, `agent_settled`, and queued activation recovery. Permit one launch reservation from the active terminal decision turn. Delay activation until settlement and reject another reservation.

Verify settlement ordering, reload after reservation, crash recovery, and duplicate calls.

### Enforce restart policy

Add a focused restart-policy helper and store lineage in the existing launch-options value. Compute canonical fingerprints, traverse the bounded parent chain, reject a repeated outcome, and enforce three restarts.

Verify a first technical retry, progress followed by a different failure, repeated `maxSteps`, the total limit, and Monitor selection.

### Update public documentation

Update `docs/workflows.md`, `docs/SQLITE_STATE.md`, and workflow tool examples when implementation lands. Keep the result-presentation, restart, retry, and storage descriptions aligned with the code.

Verify every documented tool example against the real input schema.

## Tests

Add regression tests for:

- completed work;
- a completed workflow with a blocked result;
- failure, timeout, and `maxSteps`;
- explicit cancellation;
- one turn across presentation and fallback races;
- one turn after reload and crash recovery;
- waiting and child-run exclusions;
- exact workflow input reuse;
- an immutable terminal run;
- delayed activation after `agent_settled`;
- idempotent reservation and run creation;
- a repeated terminal fingerprint;
- the three-restart limit;
- Monitor without restart consumption;
- the absence of original-message capture, hashing, or storage.

The end-to-end regression must reproduce the original failure mode. Start a workflow from a normal conversation, force `maxSteps`, receive one terminal decision turn, restart from the exact input, and verify that reload does not create a duplicate turn or run.

## Risks

A model can restart work that is already complete. The shared instruction makes stop the default for successful completed work, and the restart policy limits mistakes.

A retry can repeat an external side effect. The terminal turn includes the prior result and restart history. The new run must re-observe current state before it repeats consequential work.

Presentation and fallback can race. They settle one turn intent.

A selected launch can race with result presentation. The host reserves it and waits for `agent_settled`.

A temporary outage can cause repeated attempts. The model selects Monitor for an external wait, identical outcomes stop, and the chain permits only three restarts.

A workflow can report `completed` with a blocked result. The model decides from the result. Explicit cancellation remains the only terminal outcome that the restart shortcut always rejects.

## Verification

Run these checks after implementation:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
npx -y @simpledoc/simpledoc check
```

Keep coverage at or above 85 percent. Inspect the final diff for duplicate turn sources, duplicate launch reservations, missing restart bounds, original-message handling, hidden retries, and dependency-boundary violations.

## Rollout

This is an in-place alpha change. Keep the current schema identifiers. Restart lineage uses the existing launch-options value, so the plan adds no database table or migration.

If the implementation makes existing alpha state incompatible, fail with the repository's standard clear reset instruction. Do not reinterpret, migrate, or delete old state.

Do not publish a package or create a release without separate authorization.
