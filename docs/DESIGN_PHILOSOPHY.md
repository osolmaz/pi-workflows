# Design philosophy

pi-workflows should stay small and easy to combine. A small set of clear, general parts should support many kinds of work.

## Primary rule

Provide as few primitives as possible. Prefer combining existing primitives over adding a special one for each feature.

A new primitive belongs in the engine only when it solves a general problem that current primitives cannot express cleanly. It must have one clear job and work in more than one context.

## Composition

Workflows combine `agent`, `compute`, `action`, `notify`, and `checkpoint` nodes through explicit edges. `shell` is the command form of an action. A finite workflow can include another finite workflow through typed input and named exits. This keeps shared prompts and routing in one source. Built-in workflows should use the same public parts available to workflow authors.

Shared behavior should usually start as a data format or pure helper used by a workflow composition. For example, progress can be structured data carried through a general update channel instead of a special progress node.

## Explicit behavior

The graph should show what runs and where it can go. Use structured, validated agent results when the graph must inspect fields or choose a route. Use a declared assistant-message result when exact visible text belongs inside the graph. Commands and other side effects should be declared by the workflow author.

Avoid hidden polling, implicit retries, automatic command generation, and state changes that the graph cannot explain. Required session recovery behavior must also have explicit ownership, bounds, and recorded outcomes. Making behavior explicit must not remove it.

## Model use

Use a model only for work that needs judgment or language understanding. Keep calculations and routing model-free when possible. The same rule applies to waits and commands as well as persistence and notifications.

A passive notification should not start a model turn. Post-workflow recovery turns and missing-submission reminders are required session behavior, defined below; they are not passive notifications.

## Required recovery behavior

These are product requirements. Refactors must preserve them. Do not remove, disable, or replace them with narrower behavior unless the user explicitly approves that specific behavior change. General approval to simplify architecture, reduce model calls, or make execution explicit does not grant that permission.

### Post-workflow model turn

After a workflow ends, give the model a turn to explain the result, inspect failures, correct mistakes, and continue or restart within existing permission. This includes automatic recovery from failed workflow calls and runs, not only a final summary. A summary node inside one workflow does not replace this session-level handoff.

Explicit user cancellation stops automatic continuation and recovery. Do not treat cancellation as permission to restart. Recovery must preserve accepted work, obey existing scope and approval requirements, and never blindly repeat uncertain side effects. Bound recovery attempts and report a blocker when no safe authorized action remains.

### Missing-submission reminders

When a model turn ends without the required submission, give the model a bounded chance to submit or correct its result instead of leaving the workflow waiting silently. Reminders must target the exact still-pending request. Do not overlap active model work, repeat accepted submissions, or bypass pause, cancellation, or protected human decisions. Exhausting the reminder bound must produce a clear blocker or follow the declared failure policy.

Tests must protect both behaviors through completion, failure, interruption, rejected submissions, retry exhaustion, and explicit cancellation. An API that permits recovery is not enough; verify that the model receives the required opportunity to act.

The current implementation still needs restoration of the general post-workflow turn and missing-submission reminders. Existing summaries and workflow-specific repair steps do not close that gap. This section supersedes the removal decisions in the September 6 durable execution plan; it does not claim that restoration has shipped.

## Durable runs

Runs should survive interruption and remain safe to resume. Save the run input and every accepted output. Save attempts and events along with enough evidence of side effects for replay and diagnosis.

Immutable SQLite events are the record of what happened. Domain rows are current projections written in the same transaction. Viewers derive their answers from those facts instead of creating another source of truth.

Live workflow settings follow the same rule. The workflow owns one typed JSON value and path policy. The engine owns ordered JSON Patch application and fixed node bindings. Lifecycle actions, such as queued post-completion prompts, stay outside the settings value.

Reading shared state never gives mutation authority. Every durable write checks its actor, expected resource revision, and current lease generation when ownership is required. Follow-up work uses deterministic effects and idempotent receipts so partial failure can converge safely.

## Boundaries

The workflow engine stays independent of Pi. The Pi extension servers the engine and connects it to a conversation. Controllers manage durable external resources. Viewers read recorded state without changing it.

Keep these layers separate and connect them through small public interfaces.

## Test for a new primitive

Before adding one, ask:

- Can existing primitives express the behavior through composition?
- Will more than one workflow use it?
- Does it have one clear responsibility?
- Can it remain durable and easy to inspect?
- Can the engine support it without importing Pi or a product-specific system?

If the answer is no, add a helper or a workflow composition instead.
