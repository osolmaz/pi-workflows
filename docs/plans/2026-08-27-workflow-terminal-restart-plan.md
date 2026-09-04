---
title: Workflow terminal decision and restart plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-27
---

# Full plan

## Goal

After every top-level workflow run ends, give the model one normal successor turn.

That turn contains the workflow result and terminal reason. The model uses the conversation it already has to decide whether to:

- stop because the user’s task is complete
- restart the same workflow as a new run
- start Monitor for an authorized external wait
- ask the user for a required decision or authority
- take another safe authorized action

The system does not save or identify the original user message. It does not restart automatically. It gives the model one clear decision opportunity and makes safe retry the default for unfinished work after technical failures.

## Shared terminal behavior

The shared terminal message must include:

- workflow name and revision
- terminal run ID
- exact workflow input
- workflow result
- terminal state
- terminal reason
- restart count
- earlier terminal outcomes in the same restart chain

The message must tell the model:

> A workflow run ended, but that does not prove the user’s task is complete. Use the current conversation and this result to decide what to do next. If the task is unfinished because of an unexpected technical or temporary failure, prefer a safe restart. Stop if the work is complete, the user cancelled it, new authority is required, the user must make a decision, or the same failure has repeated. Use Monitor only for an authorized external wait.

Use the term **result**, not “durable result.”

## Implementation steps

### 1. Build one shared terminal-decision message

**Where**

- `src/extension/deferred-turn.ts`
- Add `src/extension/terminal-decision.ts` if a separate pure module keeps the code smaller.

**Change**

Add a pure builder that reads the existing run record and produces the shared terminal facts and prompt.

It must not read, copy, hash, or store an original user message.

Use the existing stored workflow input and result. Apply the existing output-size rules to large results, but always include the run ID, state, reason, and restart history.

**Verification**

Unit tests must cover completed, failed, timed-out, maxSteps, cancelled, and blocked results.

### 2. Create one terminal turn for every top-level run

**Where**

- `finishRun` in `src/extension/index.ts`
- `src/extension/deferred-turn-coordinator.ts`
- Existing turn-intent state in `src/resource-managers/sqlite.ts`

**Change**

Create one terminal turn intent when a top-level interactive run reaches a terminal state.

Normal presentation and fallback delivery must compete for the same intent. The first successful delivery settles it. Every later delivery attempt becomes a no-op.

Do not create this turn for:

- waiting checkpoints
- resource manager child runs
- internal helper runs that already report to an owner

**Verification**

Race tests must prove that presentation, fallback, reload recovery, and crash recovery produce one model turn, not two.

### 3. Replace the current terminal presentation instruction

**Where**

- `buildPresentationMessage`
- `buildDeferredTurnContent`
- Related presentation helpers in `src/extension/index.ts`

**Change**

Remove the current instruction that says the model must not call the workflow tool.

Replace it with the shared decision instructions. The terminal turn must permit one workflow launch selected by the model.

Completed runs still get a result turn. A workflow state of `completed` does not always mean the larger user task is complete. For example, the result can say that work is blocked.

Explicit human cancellation must default to stopping.

**Verification**

Tests must prove that the model can select restart or Monitor during the terminal turn and that ordinary completed work does not cause an automatic restart.

### 4. Add a generic restart action

**Where**

- `src/workflows/tool-input.ts`
- Workflow tool registration, schema, help text, and control switch under `src/workflows/`
- Restart handling in `src/extension/index.ts`

**Contract**

```json
{
  "action": "restart",
  "runId": "terminal-run-id"
}
```

**Change**

The action must:

1. Read the terminal run.
2. Confirm that it belongs to the current session.
3. Confirm that it is terminal.
4. Reuse the exact workflow reference, input, and safe launch settings.
5. Create a new immutable run.
6. Record the restart relationship.
7. Leave the old run unchanged.

Reject restart when:

- the run is active or waiting
- the run is unknown
- the run belongs to another session
- the run was explicitly cancelled
- the workflow source or revision is no longer available
- the restart limit was reached
- the same terminal failure already repeated

A later explicit user request can still use normal `start`.

**Verification**

Tool-schema and extension tests must prove exact input reuse, immutable old runs, session checks, source checks, and correct rejection behavior.

### 5. Permit one selected launch during the terminal turn

**Where**

- `queueToolLaunch`
- presentation tracking in `src/extension/index.ts`
- `agent_settled`
- existing queued-launch recovery

**Change**

The current presentation guard rejects workflow launches. Add one narrow exception for the active terminal-decision turn.

The model can reserve one of these:

- restart
- Monitor
- another workflow start

The reservation must not activate until the model turn settles. A second workflow launch from the same terminal turn must fail.

Other tool calls remain subject to their normal rules.

**Verification**

Tests must prove that:

- one launch can be reserved during presentation
- it starts only after `agent_settled`
- a second launch is rejected
- reload after reservation does not lose it
- crash recovery does not start it twice

### 6. Add bounded restart lineage

**Where**

- Add `src/extension/restart-policy.ts`
- Existing run launch-options JSON and accessors
- No new database table

**Change**

Store this information for restarted runs:

- root run ID
- parent run ID
- restart number
- parent terminal fingerprint

A terminal fingerprint is a stable hash of:

- workflow identity and revision
- exact input
- terminal state
- canonical result or error
- canonical terminal reason

Do not include timestamps or new run IDs in the fingerprint.

Allow at most three restart actions after the original run. This permits at most four runs in one chain.

If a terminal fingerprint occurs again in the same chain, reject another restart immediately. If the result changes because the workflow made progress, another restart can remain eligible until the total limit is reached.

Starting Monitor does not consume a restart.

**Verification**

Tests must cover:

- first technical retry
- progress followed by a different failure
- repeated identical maxSteps failure
- three-restart limit
- Monitor selection
- restart history after database reopen

### 7. Make restart reservation idempotent

**Where**

- Existing effect records
- Existing run queue and reservation code
- Terminal turn-intent settlement code

**Change**

Key the selected launch to the source terminal turn intent and tool call.

If the host repeats the same tool call after a crash or reload, return the existing reservation or new run instead of creating another one.

The terminal turn intent, launch reservation, and resulting run must have one inspectable chain.

**Verification**

Inject failures after:

- turn-intent claim
- launch reservation
- run creation
- terminal response settlement

After recovery, there must still be one terminal message and one successor run.

### 8. Document the contract

**Where**

- `docs/workflows.md`
- `docs/SQLITE_STATE.md`
- Workflow tool reference and examples
- Relevant README text

**Change**

Document:

- the shared terminal decision turn
- the `restart` action
- the difference between a workflow ending and the user’s task finishing
- retry defaults and limits
- Monitor selection
- explicit cancellation behavior
- top-level versus child-run behavior
- recovery and duplicate prevention
- that conversation context remains owned by Pi
- that Pi Workflows does not capture or persist an original user message

No workflow definition needs an opt-in or terminal restart step.

### 9. Render deferred terminal turns as compact cards

**Where**

- `src/extension/deferred-turn.ts`
- `src/extension/index.ts`
- Deferred-turn renderer unit tests
- Real-Pi end-to-end tests

**Change**

Register a custom TUI message renderer for the existing `pi-workflows-deferred-turn` message type through Pi's documented `pi.registerMessageRenderer()` API.

Keep the complete existing message content unchanged. The model and session history must still receive the terminal facts, exact input, bounded result, restart history, and instructions. Do not replace that content with a summary, split it into another entry, or hide the deferred fallback with `display: false`.

Add small, bounded presentation fields to the existing message details. The fields cover the workflow name, terminal state or cause, run identity, terminal reason kind, and restart count and limit when available. The renderer must read those fields directly and must not parse the model prompt.

The collapsed card must show a concise workflow summary. It must not show the terminal facts JSON, exact input, result, fingerprint, or full model instructions. The expanded card must show the complete existing content through Pi's standard `expanded` state, consistent with agent-step message cards.

Use standard Pi TUI components and theme colors. Sanitize all workflow-derived display text. Missing or malformed details must produce a safe generic card instead of an exception.

Keep the behavior workflow-agnostic. Ordinary deferred fallbacks, terminal decisions, and restored messages use the same renderer. Presentation messages that already use `display: false` stay unchanged. Headless and RPC behavior stays unchanged. Rendering must not create a duplicate session entry or model turn.

This change uses only `pi.sendMessage()` and `pi.registerMessageRenderer()`. It adds no Pi core or private API use, database table, migration, store, service, controller, daemon, or external resource.

**Verification**

Focused tests must prove that:

- collapsed output shows bounded workflow, state or cause, run, and restart fields
- collapsed output omits the full prompt, terminal JSON, input, result, and fingerprint
- expanded output contains the complete model-facing content
- completed, failed, timed-out, cancelled, launch-failure, and maxSteps states render correctly
- long or terminal-unsafe fields are safe
- missing and malformed details do not throw
- the renderer registers once for `pi-workflows-deferred-turn`
- restored messages render without creating another entry or turn
- real Pi still gives the provider the complete prompt while the session record keeps the custom message type and renderer details

## Contract changes

- The workflow tool gains `restart`.
- Every top-level terminal run owns one terminal turn intent.
- Restart always creates a new run.
- Restart reuses the exact prior workflow input.
- The model makes the continuation decision from the current conversation.
- Restart is preferred, not forced, for unfinished work after technical or temporary failures.
- Explicit cancellation, missing authority, required user decisions, repeated failures, and completed work stop.
- Restart lineage uses existing run launch data.
- No new store, service, controller, or Pi API is added.
- No original-message provenance contract is added.
- The existing deferred-turn message details gain small, bounded presentation fields.
- The existing deferred-turn message content remains complete and unchanged for the model and session history.
- Interactive Pi renders deferred turns through the public message-renderer API. Headless and RPC delivery do not change.

## Test plan

Add regression coverage for:

1. Successful completion produces one result turn and no automatic restart.
2. A blocked result from a completed workflow lets the model select restart.
3. Failed, timed-out, and maxSteps runs offer restart.
4. Explicit cancellation is not restartable through the shortcut.
5. Waiting checkpoints do not produce a terminal turn.
6. ResourceManager child runs do not produce competing turns.
7. Presentation and fallback races produce one turn.
8. Restart uses the exact workflow reference and input.
9. Restart leaves the prior run unchanged.
10. Monitor starts through the normal start path.
11. A selected launch waits for `agent_settled`.
12. Reload and crash recovery do not duplicate turns or runs.
13. The same terminal failure cannot repeat indefinitely.
14. A chain cannot exceed three restarts.
15. No new code captures, hashes, or stores an original user message.
16. The maxSteps failure that caused this incident produces a terminal decision turn instead of silently ending the task.

Run the full repository checks:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## Main risks

- **The model restarts completed work.**
  Make stopping the default for successful results and enforce restart limits.

- **A retry repeats external effects.**
  Include the prior result and restart history so the model can inspect the current state before it retries.

- **Presentation and fallback both fire.**
  Make both settle the same turn intent.

- **A launch starts while the terminal response is still active.**
  Reserve it first and activate it after `agent_settled`.

- **A temporary outage causes a loop.**
  Use Monitor for external waits, stop repeated fingerprints, and allow only three restarts.

## Boundaries

Do not:

- modify Pi core or private APIs
- store or identify an original user message
- add restart nodes to individual workflows
- modify Autoimplement, Monitor, or other workflow definitions
- create a new controller, database, service, or daemon
- bypass cancellation, checkpoints, reviews, CI, authority, or safety rules
- add compatibility shims or parallel state contracts
- release or deploy anything as part of this plan

This is the selected plan.
