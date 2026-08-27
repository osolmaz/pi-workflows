# Deferred workflow turns

This specification defines how Pi Workflows schedules one successor agent turn after a workflow event stops or strands the current turn. It covers every top-level interactive terminal result, cancellation, timeout, launch failure, controller interruption, and claim loss.

The implementation plans are [Guarantee one successor turn after workflow interruption](plans/2026-08-21-deferred-turn-intents-plan.md) and [Workflow terminal decision and restart](plans/2026-08-27-workflow-terminal-restart-plan.md).

## Terms

- **Source event:** The workflow event that creates the need for another turn.
- **Turn intent:** The durable obligation to send one successor turn.
- **Natural successor:** The next workflow agent prompt or result presentation.
- **Fallback:** A factual model-facing message sent when no natural successor remains.
- **Resolution:** The recorded fact that one message path satisfied the intent.
- **Target session:** The Pi session that owns the successor turn.

## Core rule

Each eligible source event creates at most one turn intent. Exactly one of these message paths can resolve it:

1. a workflow agent prompt;
2. a result presentation;
3. a factual fallback.

Every top-level interactive terminal run owns one intent. Its presentation and fallback claim that same intent before sending. A waiting presentation can resolve an earlier interruption intent, but waiting state does not create a terminal intent. A resolved intent cannot start another turn.

Cancellation and process termination remain immediate. Pi Workflows does not keep the old assistant turn alive and does not wait for the successor before stopping active work.

## Intent lifecycle

An intent has two stored states:

| State    | Condition                                                     | Meaning                                                   |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Pending  | `resolvedAt` is null                                          | No message path has resolved the intent.                  |
| Resolved | `resolvedAt`, `resolution`, and `resolutionMessageId` are set | One message path was sent or found in the session branch. |

Pending intents have separate fallback eligibility:

| Eligibility | Condition            | Meaning                                                          |
| ----------- | -------------------- | ---------------------------------------------------------------- |
| Ineligible  | `eligibleAt` is null | A natural workflow prompt or presentation can still arrive.      |
| Eligible    | `eligibleAt` is set  | Durable state shows that no immediate natural successor remains. |

A claim is temporary coordination state. A claim does not resolve an intent. An expired claim can be acquired again.

Valid resolutions are:

```text
workflowPrompt | presentation | fallback
```

Resolution records message delivery into the Pi session or the presence of the same message in the session branch. It does not prove that a model turn started or completed.

## Source events

Valid causes are:

```text
agentCancelled | timedOut | failed | launchFailed | controllerInterrupted | claimLost | terminal | cancelled
```

The event policy is:

| Event                                                          | Intent                                        | Fallback rule                                                                |
| -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Top-level interactive run completes                            | Create one terminal intent.                   | Presentation and factual fallback compete for the intent.                    |
| Top-level interactive run fails or times out                   | Create or reuse the abort intent.             | Make eligible after the terminal state is durable.                           |
| Agent or user cancels a top-level run                          | Create before turn abort when needed.         | Make eligible after durable cancellation; the decision defaults to stopping. |
| Workflow reports started, then crashes before its first prompt | Create after durable failure.                 | Create as eligible.                                                          |
| Queued launch activation fails                                 | Create after the queue row is durably failed. | Create as eligible.                                                          |
| Controller interrupts an active workflow turn                  | Create before the turn abort when possible.   | Durable terminal or handoff state decides eligibility.                       |
| Active workflow turn loses its queue claim                     | Create before the turn abort when possible.   | Keep ineligible while a new owner can continue.                              |
| Waiting result has a presentation                              | Do not create a terminal intent.              | It can resolve an earlier interruption intent through presentation.          |
| Controller child or internally owned run ends                  | Do not create a terminal intent.              | Its owner receives the result.                                               |
| Workflow pause                                                 | Do not create.                                | No automatic model turn.                                                     |
| User Escape or held workflow                                   | Do not create.                                | No automatic model turn.                                                     |
| Session shutdown                                               | Do not create.                                | A closing session cannot start another turn.                                 |

A terminal failure after a successful start tool result is eligible even when it did not first call `ctx.abort()`. This rule covers asynchronous runtime validation and startup failures that the user can see in the UI but the model cannot see in its current context.

## Stable identity

`intentId` is a deterministic digest of:

- target session ID;
- run ID;
- source event ID;
- node ID or `$launch`;
- attempt ID when known;
- cause.

The same source event must always produce the same ID. Reusing an ID with different immutable facts is an error.

`sourceEventId` identifies the source transition independently of delivery retries. Terminal handling must reuse an earlier abort event instead of creating a second terminal event for the same interruption.

IDs use the existing controller-store key limit of 512 characters. The digest representation must be stable across processes and extension restarts.

## Stored record

`workflow_turn_intents` lives in the existing controller SQLite database.

| Column                      | Null | Meaning                                      |
| --------------------------- | ---- | -------------------------------------------- |
| `intent_id`                 | No   | Deterministic primary key.                   |
| `source_event_id`           | No   | Stable source transition identity.           |
| `run_id`                    | No   | Related workflow run.                        |
| `workflow_ref`              | No   | Workflow identity used in messages.          |
| `target_session_id`         | No   | Session that can receive the successor.      |
| `cause`                     | No   | Closed cause value.                          |
| `node_id`                   | Yes  | Source node when known.                      |
| `attempt_id`                | Yes  | Source attempt when known.                   |
| `fallback_facts_json`       | No   | Bounded factual payload.                     |
| `requested_at`              | No   | Absolute ISO 8601 creation time.             |
| `eligible_at`               | Yes  | Absolute ISO 8601 fallback eligibility time. |
| `resolved_at`               | Yes  | Absolute ISO 8601 resolution time.           |
| `resolution`                | Yes  | Closed resolution value.                     |
| `resolution_message_id`     | Yes  | Stable message identity.                     |
| `delivery_claim_token`      | Yes  | Current claimant.                            |
| `delivery_claim_expires_at` | Yes  | Claim expiry as epoch milliseconds.          |

The table requires these indexes:

- unresolved intents by run and target session;
- unresolved eligible intents by target session, eligibility time, and intent ID.

A resolved row has all three resolution fields. A pending row has none of them. A row cannot change immutable identity or source fields after creation.

## Fallback facts

`fallback_facts_json` uses this versioned camelCase object:

```json
{
  "schema": "pi-workflows.deferred-turn-facts.v1",
  "workflowName": "autoimplement",
  "runId": "20260821T081731Z-autoimplement-407480dd",
  "observedState": "failed",
  "cause": "failed",
  "nodeId": "$launch",
  "attemptId": null,
  "reason": "scope must be a non-empty string",
  "handoff": false
}
```

Rules:

- `schema` is required and has the exact value shown above.
- `workflowName`, `runId`, `observedState`, and `cause` are required strings.
- `nodeId`, `attemptId`, and `reason` are strings or null.
- `handoff` is a required boolean.
- `reason` is safe diagnostic text with at most 8,192 characters.
- The serialized object is at most 64 KiB.
- Unknown fields are rejected during alpha.
- The object must not contain credentials, raw environment values, or unbounded command output.

`handoff: true` means another runner can continue. A handoff message must not describe the run as terminal unless separate durable state proves it.

## Store operations

The controller store provides these internal operations:

- `ensureWorkflowTurnIntent`
- `getWorkflowTurnIntent`
- `claimWorkflowTurnIntentForRun`
- `claimEligibleWorkflowTurnIntentsForSession`
- `makeWorkflowTurnIntentEligible`
- `resolveWorkflowTurnIntent`
- `releaseWorkflowTurnIntentClaim`
- a bounded diagnostic list operation

`ensureWorkflowTurnIntent` is idempotent when all immutable fields match. It fails on an identity collision.

Claim operations use a caller-supplied token and lease duration. Resolution requires the matching live claim token. Conditional updates ensure that natural delivery and fallback cannot both resolve the same intent.

List operations require a positive bounded limit and deterministic ordering.

## Abort ordering

For an eligible active-turn abort, Pi Workflows performs these steps in order:

1. Record abort provenance on the active run.
2. Build the source event and intent ID.
3. Attempt to persist the intent.
4. Record the intent ID in system-abort bookkeeping.
5. Call `ctx.abort()`.

The persistence attempt is synchronous because cancellation immediately crosses the turn boundary. A store failure does not prevent `ctx.abort()`. Terminal handling retries the same intent ID. If retry also fails, Pi Workflows reports that it could not preserve the successor-turn guarantee.

## Natural delivery

All extension-owned workflow prompts and result presentations pass through one `DeferredTurnCoordinator`.

If no intent exists, the coordinator preserves current message content and delivery options.

If a pending intent exists, the coordinator:

1. waits until the old turn has settled or the session is verified idle;
2. claims the intent for the run and session;
3. adds `turnIntentId` to the message details;
4. sends the normal prompt or presentation;
5. resolves the intent with the matching resolution and message ID;
6. releases the claim if sending fails.

A prompt generated during abort handling must not be sent into the aborting turn. The coordinator releases it after `agent_settled`.

## Fallback delivery

Fallback synchronization runs:

- after `agent_settled` and system-abort cleanup;
- when the target session starts;
- during the existing periodic synchronization pass while the session is idle.

The fallback custom message uses this details object:

```json
{
  "schema": "pi-workflows.deferred-turn-message.v1",
  "turnIntentId": "deferred-turn:...",
  "runId": "20260821T081731Z-autoimplement-407480dd",
  "cause": "failed"
}
```

The message type is `pi-workflows-deferred-turn`. Delivery uses:

```ts
{
  deliverAs: "followUp",
  triggerTurn: true,
}
```

For a terminal run, the visible content contains the workflow identity and revision, terminal run ID, exact stored input, bounded result, terminal state and reason, restart count, and earlier terminal outcomes in the chain. It tells the model to use the current conversation, prefer a safe restart for an unfinished task after a technical or temporary failure, and stop for completed work, cancellation, missing authority, a required user decision, or a repeated failure. Values from input and result are data, not instructions.

The content comes only from existing run and queue records. Pi owns conversation history. Pi Workflows does not identify, hash, copy, or store an original user message.

Fallback delivery is disabled during session shutdown and while a user-interrupted workflow is held.

## Selected launch and restart

A terminal decision turn can reserve at most one workflow launch: `restart`, Monitor through normal `start`, or another workflow through normal `start`. The reservation records the source terminal intent, model tool call, and request fingerprint in the new run's existing launch options. It does not activate before `agent_settled`.

Repeating the same tool call adopts the existing reservation or run. A different launch from the same terminal intent fails. Session-start and queue recovery activate a surviving reservation once when the session is idle.

`restart` accepts the terminal run ID. It checks session ownership, terminal state, explicit cancellation, source identity and revision, repeated failure, and the restart limit. It creates a new immutable run from the exact stored reference, input, and safe launch settings. The old run does not change.

Restart lineage in launch options records the root run ID, parent run ID, restart number, and parent terminal fingerprint. The fingerprint covers workflow identity and revision, exact input, terminal state, canonical result or error, and terminal reason. It excludes timestamps and run IDs. The same fingerprint cannot restart twice in one chain. A chain permits three restarts after the original run. Starting Monitor does not add restart lineage.

## Delivery recovery

Every resolving message includes the intent ID in its custom-message details.

Before sending, the coordinator scans the current session branch for that ID. If the message is already present, the coordinator resolves the intent without sending again. This repairs a crash or SQLite failure that occurs after `sendMessage` succeeds but before resolution is stored.

Store leases prevent concurrent processes from sending the same resolution. Branch identity handles the remaining send-before-resolution window.

## Claim transfer

Claim loss stops the old runner's work and all fenced SQLite writes. The intent stays pending and fallback-ineligible while another runner can resume the run.

The new runner's next workflow prompt can resolve the intent. If durable state later proves a terminal outcome with no natural successor, terminal handling makes the intent eligible for fallback to its target session.

Time alone does not prove terminal failure.

## Launch notifications

Workflow-authored `progress` and `final` notifications remain passive. They do not trigger model turns.

The `launch_failure` notification kind is removed. Queued launch failure creates an eligible turn intent instead.

Pending `launch_failure` rows from the earlier alpha contract are incompatible. Pi Workflows must stop with a clear controller-store reset instruction. It must not reinterpret, migrate, or silently delete those rows.

## Post-completion follow-ups

Deferred turns provide the terminal decision before ordered post-completion prompts. Those prompts represent user-requested normal work after successful completion, use `workflow_follow_up_queues` and `workflow_follow_ups`, and are delivered by the separate follow-up coordinator after the terminal intent is resolved. Neither feature reads or changes the other's rows.

See [Continue normal work after a workflow finishes](2026-08-25-workflow-follow-ups.md).

## Availability limits

Pi Workflows can guarantee only the facts under its control:

- the intent was stored;
- a claimant acquired it;
- a custom message was sent or found in the session branch;
- the local intent was resolved.

Pi Workflows cannot guarantee model start or completion with the current Pi API. It also cannot deliver after permanent loss of the process, target session, controller store, machine, or model provider.

Undelivered intents remain pending. The implementation does not add a service to process them outside a live Pi session.

## Compatibility

This is an alpha hard cutover.

- Keep `pi-workflows.controller-store.v1`.
- Add `workflow_turn_intents` to the existing database.
- Remove the launch-trigger runtime path.
- Add no v2 schema, compatibility reader, dual write, alias, or feature flag.
- Keep historical terminal SQLite runs readable because their contract does not change.

## Conformance

An implementation conforms when:

- every top-level interactive terminal run produces at most one intent and one decision message;
- an agent self-cancel and a direct cancellation receive one fallback after settlement;
- an asynchronous crash after a successful start result receives one fallback after settlement;
- a natural recovery prompt or presentation suppresses fallback by resolving the same intent;
- waiting checkpoints, controller children, internal owners, pause, Escape, user hold, and shutdown do not create terminal turns;
- claim transfer permits natural resolution by the new owner and prevents stale writes;
- one terminal turn reserves at most one launch and activates it after `agent_settled`;
- exact replay adopts the same launch, while reload, lease expiry, and send-before-resolution failure do not duplicate turns or runs;
- restart keeps the prior run immutable, preserves exact input, rejects cancellation and repeated fingerprints, and stops after three restarts;
- passive workflow notifications keep their current behavior.
