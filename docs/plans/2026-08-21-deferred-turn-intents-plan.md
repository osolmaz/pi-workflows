---
title: Guarantee one successor turn after workflow interruption
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
---

# Guarantee one successor turn after workflow interruption

Pi Workflows can stop the active agent turn before the agent receives a tool result or can take its next action. This happens when an active workflow step is cancelled, times out, loses its queue claim, or is interrupted by a controller. The workflow can also return a successful start result and then fail asynchronously before it sends its first prompt. In that case, the user can see a UI error while the model still believes that the workflow started successfully.

Add one general rule: an eligible workflow event creates one durable obligation for one later agent turn. The next normal workflow prompt or result presentation satisfies the obligation when one exists. Otherwise, Pi Workflows sends one factual fallback turn after the old turn settles.

This plan replaces the earlier corrective-notification idea. A corrective message is one possible fallback. The underlying mechanism is a purpose-neutral successor-turn obligation.

Related documents:

- [Deferred workflow turns](../DEFERRED_TURNS.md)
- [Make deferred workflow launches durable](../2026-08-20-durable-workflow-launch-plan.md)
- [Route workflow reports to their starting session](2026-08-13-session-addressed-workflow-notifications-plan.md)
- [Workflow authoring reference](../workflows.md)

## Goals

- Keep workflow cancellation and process termination immediate.
- Give an agent that causes its own turn to stop one later normal turn when the Pi session remains available.
- Give asynchronous workflow failures one model-facing turn when the start tool already returned success.
- Let the next workflow prompt or presentation satisfy the obligation instead of sending a duplicate fallback.
- Preserve the obligation across ordinary extension restart, polling, and delivery races.
- Keep user Escape, pause, direct administrative cancellation, and session shutdown quiet.
- Keep workflow recovery separate from turn delivery.

## Non-goals

- Do not keep the aborted assistant turn alive.
- Do not return the cancel tool result to the aborted turn.
- Do not retry a workflow node, resume a terminal run, or repeat an external mutation.
- Do not add a workflow-engine primitive or a public workflow-author API.
- Do not add a service, another database file, an external queue, or a controller.
- Do not change Pi core or use a private Pi API.
- Do not guarantee a turn after permanent process, session, machine, storage, or model-provider loss.
- Do not treat message insertion as proof that the model started or completed a turn.
- Do not include the separate Autoimplement node-timeout recovery change in this implementation.

## Successor-turn rule

A source event can create at most one `DeferredTurnIntent`. The intent starts pending and resolves once as one of:

- `workflowPrompt`: the next workflow agent prompt was sent;
- `presentation`: a completed or waiting result presentation was sent;
- `fallback`: Pi Workflows sent a factual fallback message because no natural successor remained.

The three paths compete for the same record. A successful claim by one path prevents the other paths from sending another turn.

Fallback eligibility is separate from pending state. An intent can remain pending but ineligible while the workflow can still route to another agent step or presentation. Durable terminal or handoff evidence makes the intent eligible only when no immediate natural successor remains.

## Event policy

| Event                                                        | Create an intent | Initial fallback eligibility      | Notes                                                                                                     |
| ------------------------------------------------------------ | ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Agent calls `workflow cancel` during an active workflow turn | Yes              | No                                | Persist before `ctx.abort()`. Terminal cancellation makes it eligible.                                    |
| Agent-step timeout                                           | Yes              | No                                | A later recovery prompt can resolve it naturally. Terminal timeout makes it eligible.                     |
| Terminal workflow failure after an active turn abort         | Yes              | No                                | Terminal handling updates the existing intent and makes it eligible.                                      |
| Workflow reports started, then crashes asynchronously        | Yes              | Yes, after durable failure        | Covers failures before the first workflow prompt, including invalid runtime input discovered after start. |
| Queued launch activation fails                               | Yes              | Yes, after durable launch failure | Replaces the `launch_failure` notification trigger.                                                       |
| ResourceManager stops an active workflow agent turn          | Yes              | No                                | Terminal or handoff policy decides eligibility.                                                           |
| Queue claim is lost during an active agent turn              | Yes              | No                                | Treat as ownership transfer, not failure.                                                                 |
| Completed or waiting run has a presentation                  | No new intent    | Not applicable                    | The presentation resolves an existing intent when present.                                                |
| Direct `/workflow cancel`                                    | No               | Not applicable                    | The user explicitly requested control and no automatic model turn.                                        |
| Ordinary workflow pause                                      | No               | Not applicable                    | The current step stops only at its normal boundary.                                                       |
| User Escape                                                  | No               | Not applicable                    | Keep the workflow held until explicit resume.                                                             |
| Session shutdown                                             | No               | Not applicable                    | A closing session cannot run another turn.                                                                |

A later distinct event can create a new intent. Repeated handling of the same source event must return the existing intent.

## Storage

Add `workflow_turn_intents` to the existing `SqliteResourceManagerStore` database. Keep the database path and `pi-workflows.controller-store.v1` schema identifier.

The existing `workflow_notifications` table remains a passive outbox for workflow-authored `progress` and `final` reports. It cannot represent this lifecycle clearly because it has one delivery transition and identifies node notification output. Adding natural resolution, fallback eligibility, and competing claims to that table would mix two different contracts.

The intent table stores:

| Field                       | Meaning                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `intent_id`                 | Deterministic primary key                                                                    |
| `source_event_id`           | Stable identity of the event that requires a successor                                       |
| `run_id`                    | Related workflow run                                                                         |
| `workflow_ref`              | Workflow identity used in factual messages                                                   |
| `target_session_id`         | Pi session that owns the successor turn                                                      |
| `cause`                     | Closed event cause                                                                           |
| `node_id`                   | Source node when known                                                                       |
| `attempt_id`                | Source attempt when known                                                                    |
| `fallback_facts_json`       | Bounded `pi-workflows.deferred-turn-facts.v1` camelCase facts used to build fallback content |
| `requested_at`              | Time the obligation was created                                                              |
| `eligible_at`               | Time fallback became eligible, or null                                                       |
| `resolved_at`               | Time one path resolved the intent, or null                                                   |
| `resolution`                | `workflowPrompt`, `presentation`, `fallback`, or null                                        |
| `resolution_message_id`     | Stable custom-message identity for the resolving send                                        |
| `delivery_claim_token`      | Current resolution claimant                                                                  |
| `delivery_claim_expires_at` | Claim lease expiry                                                                           |

Causes are:

```text
agentCancelled | timedOut | failed | launchFailed | controllerInterrupted | claimLost
```

The deterministic intent ID includes the target session, run, source event, source node or `$launch`, attempt when known, and cause. Reusing an ID with different immutable facts is an error.

Store methods must support:

- idempotent intent creation;
- exact lookup;
- a natural-resolution claim for one run and session;
- an eligible fallback claim for one session;
- fallback eligibility updates;
- resolution with the matching claim token;
- claim release and lease expiry;
- bounded diagnostic listing.

Every claim and resolution uses an immediate transaction or conditional update.

## Abort handling

Track abort provenance on the active run before cancellation occurs. The provenance distinguishes:

- agent tool cancellation;
- direct user cancellation;
- timeout;
- controller interruption;
- claim loss;
- Escape;
- shutdown.

When the executor abort callback is about to call `ctx.abort()` for an eligible active turn:

1. Build the deterministic source event and intent ID.
2. Call `ensureWorkflowTurnIntent` synchronously.
3. Record the intent ID in system-abort bookkeeping.
4. Call `ctx.abort()` immediately.

A storage error must not prevent cancellation. Save a bounded error and retry the same intent during terminal handling. If both writes fail, show a clear warning and record a run event. Do not claim that a successor turn is guaranteed.

## Turn coordinator

Add one `DeferredTurnCoordinator` in `src/extension`. All extension-owned workflow agent prompts and result presentations pass through it.

When no intent exists, the coordinator preserves current message content and delivery options.

When an intent exists, the coordinator:

1. Defers the Pi send while the old turn is still active or aborting.
2. Waits for `agent_settled` or verified idle session state.
3. Claims the pending intent for natural resolution.
4. Adds `turnIntentId` to custom-message details.
5. Sends the normal workflow prompt or presentation.
6. Resolves the intent as `workflowPrompt` or `presentation`.
7. Releases the claim if sending fails.

This settlement rule applies to natural prompts as well as fallback messages. A recovery prompt sent while the old turn is aborting can otherwise be lost with that turn.

If the message send succeeds but SQLite resolution fails, later recovery scans the current session branch for `turnIntentId`. An existing message resolves the intent without another send.

## Terminal and asynchronous failures

Terminal handling uses the durable run or launch state as its source of truth.

For `cancelled`, `timed_out`, or `failed` outcomes with no natural successor:

1. Find or recreate the deterministic intent.
2. Update its bounded fallback facts from the observed terminal state.
3. Make it fallback-eligible.

A workflow can also fail after `workflow start` returns success but before an active agent step calls `ctx.abort()`. The run completion rejection path must create an already-eligible intent for this case. The current turn can finish normally, and the fallback arrives afterward with the actual failure. This prevents the model from reporting that a crashed workflow is still running.

Completed and waiting outcomes continue through normal presentation. That presentation resolves an existing intent and prevents fallback.

Parked runs remain pending for resume and do not claim a terminal outcome.

## Fallback delivery

The coordinator checks eligible intents:

- after `agent_settled`, after system-abort bookkeeping is clear;
- when a session starts;
- during the existing periodic synchronization pass while the session is idle.

For each claimed intent, it sends one `pi-workflows-deferred-turn` custom message with:

- the stable `turnIntentId`;
- the workflow and run identity;
- the observed terminal or handoff state;
- the source node and attempt when known;
- a bounded safe reason;
- an instruction to inspect durable state before any authorized correction.

Delivery uses:

```ts
{
  deliverAs: "followUp",
  triggerTurn: true,
}
```

The message does not say that recovery ran or succeeded. It does not resume the old run or grant permission for new work.

The coordinator does not deliver while the session is shutting down or while an Escape-interrupted workflow is held.

## Claim loss

Claim loss transfers execution responsibility. It is not proof that the run failed.

The old runner must:

1. Ensure the pending intent before aborting the active turn when possible.
2. Stop all fenced run-bundle writes.
3. Leave the intent unresolved and fallback-ineligible while another runner can continue.

The new runner's next workflow prompt can claim and resolve the same intent naturally. Only durable terminal state or explicit no-successor handoff evidence can make the intent fallback-eligible. A timer alone cannot establish failure.

## Launch failure change

Queued launch activation failure moves from `workflow_notifications` to deferred-turn intents.

After the queue row is durably marked failed:

1. Record the launch failure event.
2. Create one already-eligible intent keyed by the run and `$launch`.
3. Let post-settlement synchronization deliver the fallback.

Immediate `workflow start` validation errors remain ordinary tool errors in the current live turn and create no intent.

Remove the `launch_failure` runtime notification kind and trigger branch. Existing pending `launch_failure` rows are incompatible alpha state. Detect them before synchronization and give a precise controller-store reset instruction. Do not reinterpret, migrate, or silently delete them.

## Implementation order

1. Add the intent types, validation, row mapping, schema, and store operations.
2. Add storage tests for identity, eligibility, claims, leases, resolution, and collisions.
3. Add the event policy, stable identity helper, and fallback builder.
4. Add abort provenance to active-run control paths.
5. Persist intents before eligible `ctx.abort()` calls and retry during terminal handling.
6. Add the coordinator and route workflow prompts and presentations through it.
7. Add terminal eligibility and asynchronous post-start failure handling.
8. Move queued launch failure to intents and remove its notification trigger.
9. Add post-settlement fallback synchronization.
10. Add claim-loss transfer behavior.
11. Apply the alpha storage checks and reset error.
12. Update the workflow documentation to match the shipped behavior.
13. Run focused tests, real-Pi end-to-end tests, and all repository checks.

## Acceptance criteria

- Agent-issued active cancellation aborts the old turn and produces exactly one later fallback turn.
- The aborted turn does not receive the cancel result and does not continue work.
- A timeout with a natural recovery prompt resolves the intent through that prompt and sends no fallback.
- A terminal timeout sends one fallback after settlement.
- A workflow that returns a successful start result and then crashes sends one later model-facing failure turn.
- A completed or waiting presentation resolves an existing intent and sends no fallback.
- Queued launch failure uses an intent instead of a triggered workflow notification.
- Direct cancellation, pause, Escape, user hold, and shutdown send no automatic successor turn.
- Claim loss performs no stale fenced write and can resolve through the new runner's prompt.
- Polling, extension restart, lease expiry, and repeated terminal handling do not duplicate turns.
- A send-before-resolution crash is repaired from the session message identity.
- Permanent intent-store failure is reported without weakening cancellation or claiming delivery.
- Existing passive progress and final notifications keep their current behavior.

## Tests

Add or extend tests for:

- persisted type validation and JSON round trips;
- deterministic identity and collision rejection;
- fresh and existing controller stores;
- intent creation, eligibility, claims, lease expiry, release, and all resolutions;
- intent persistence before `ctx.abort()`;
- agent cancellation and direct user cancellation;
- terminal timeout and timeout with a natural successor;
- terminal workflow failure;
- successful start followed by asynchronous runtime failure before the first prompt;
- completed and waiting presentation;
- queued launch failure and immediate start validation failure;
- controller interruption and claim-loss transfer between two runners;
- deferred natural prompts and presentations after settlement;
- busy-session deferral and session-start recovery;
- duplicate polling and extension restart;
- send failure and send-before-resolution recovery;
- Escape, pause, user hold, and shutdown;
- real-Pi cancellation and timeout ordering with a mock provider.

Use temporary databases and run directories. Tests must not call real models, mutate remote systems, or write outside temporary directories.

## Verification

Run these checks before completion:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
git diff --check
npx -y @simpledoc/simpledoc check
```

Keep coverage at or above 85 percent. Inspect the final diff for duplicate turn sources, unresolved claims, stale launch-trigger code, quiet-event regressions, hidden retries, and dependency-boundary violations.

## Rollout

Keep the controller store at `pi-workflows.controller-store.v1` during alpha. Add the intent table in place and remove the launch-trigger runtime path in the same change.

Do not add a schema v2, compatibility reader, dual write, alias, or feature flag. If pending legacy launch notifications exist, stop with a clear reset instruction. Historical terminal run bundles remain readable because this change does not alter the run-bundle contract.

Do not publish a package or create a release without separate authorization.

## Contract impact

- **Session state:** internal workflow messages gain an optional `turnIntentId`; fallback uses `pi-workflows-deferred-turn`.
- **ResourceManager storage:** add `workflow_turn_intents`; restrict workflow notifications to passive `progress` and `final` kinds.
- **Run bundles:** unchanged.
- **Workflow engine:** unchanged.
- **Workflow author API:** unchanged.
- **Pi core:** unchanged.
- **Public Pi APIs:** use existing `sendMessage`, `followUp`, `triggerTurn`, session lifecycle events, and `ctx.abort()`.
