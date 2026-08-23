# Design philosophy

pi-workflows should stay small and easy to combine. A small set of clear, general parts should support many kinds of work.

## Primary rule

Provide as few primitives as possible. Prefer combining existing primitives over adding a special one for each feature.

A new primitive belongs in the engine only when it solves a general problem that current primitives cannot express cleanly. It must have one clear job and work in more than one context.

## Composition

Workflows combine `agent`, `compute`, `action`, `notify`, and `checkpoint` nodes through explicit edges. `shell` is the command form of an action. A finite workflow can include another finite workflow through typed input and named exits. This keeps shared prompts and routing in one source. Built-in workflows should use the same public parts available to workflow authors.

Shared behavior should usually start as a data format or pure helper used by a workflow composition. For example, progress can be structured data carried through a general update channel instead of a special progress node.

## Explicit behavior

The graph should show what runs and where it can go. Agent results should be structured and validated. Commands and other side effects should be declared by the workflow author.

Avoid hidden polling, implicit retries, automatic command generation, and state changes that the graph cannot explain.

## Model use

Use a model only for work that needs judgment or language understanding. Keep calculations and routing model-free when possible. The same rule applies to waits and commands as well as persistence and notifications.

A notification should not start a model turn unless the workflow explicitly requests one.

## Durable runs

Runs should survive interruption and remain safe to resume. Save the run input and every accepted output. Save attempts and events along with enough evidence of side effects for replay and diagnosis.

Immutable SQLite events are the record of what happened. Domain rows are current projections written in the same transaction. Viewers derive their answers from those facts instead of creating another source of truth.

Reading shared state never gives mutation authority. Every durable write checks its actor, expected resource revision, and current lease generation when ownership is required. Follow-up work uses deterministic effects and idempotent receipts so partial failure can converge safely.

## Boundaries

The workflow engine stays independent of Pi. The Pi extension hosts the engine and connects it to a conversation. Controllers manage durable external resources. Viewers read recorded state without changing it.

Keep these layers separate and connect them through small public interfaces.

## Test for a new primitive

Before adding one, ask:

- Can existing primitives express the behavior through composition?
- Will more than one workflow use it?
- Does it have one clear responsibility?
- Can it remain durable and easy to inspect?
- Can the engine support it without importing Pi or a product-specific system?

If the answer is no, add a helper or a workflow composition instead.
