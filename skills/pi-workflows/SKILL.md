---
name: pi-workflows
description: Use when creating, reviewing, debugging, starting, inspecting, or controlling Pi Workflows; authoring .workflow.ts files; using the workflow tool; handling workflow step contracts, checkpoints, updates, or progress; or deciding how a task should compose workflow primitives.
compatibility: Requires the Pi Workflows extension.
---

# Pi Workflows

Use Pi Workflows for durable multi-step work that needs explicit routing, retries, checkpoints, scheduled waits, or progress. Keep simple one-turn work outside a workflow.

The `workflow` tool schema is the authority for call shapes. A workflow step message is the authority for its current step id, attempt id, and expected output. Do not guess these values from an earlier attempt.

## Operate workflows

Use the smallest applicable action:

- `list` discovers available workflows. Use its offset for later pages.
- `start` starts a discovered workflow name or workflow file path with structured input.
- `status` reads the active run, or the named run when `runId` is supplied.
- `pause`, `resume`, and `cancel` control the current active run.
- `answer` supplies input to an ordinary waiting checkpoint. It cannot satisfy a protected `humanDecision()` gate.
- `update` publishes a non-completing durable update for the active step attempt.
- `submit` completes the active agent step with its required output.

Use `start` only once for one requested run. Do not build a manual polling loop around a workflow that already schedules its own work. Use the `monitor` skill for monitoring requests.

## Complete agent steps

When a workflow step message arrives:

1. Do the requested work with the available tools.
2. Produce output that matches the exact expected shape.
3. Call `workflow` with `action: "submit"` exactly once, using the step and attempt ids from that message.
4. If validation rejects the output, correct it and submit again with the same current ids.
5. After acceptance, end the turn. The workflow sends the next step or presentation message when needed.

A node id can run more than once in a loop. Each run has a new attempt id. Never reuse an attempt id from conversation history.

## Publish updates and progress

Use `update` only while the named step attempt is active. An update does not complete the step and does not control routing.

For progress, publish `pi-workflows.progress.v1` data with stable track keys. Report observed counts and source-provided estimates. Do not invent totals, rates, confidence, or completion times. Use separate keys for concurrent processes and send explicit terminal states before a track disappears.

The workflow definition should publish progress from function and shell actions when the runtime already has exact counts. Do not add an agent step only to format data that code can publish directly.

Read [../../docs/WORKFLOW_UPDATES.md](../../docs/WORKFLOW_UPDATES.md) before adding update producers or progress estimation.

## Author workflows

A workflow is a `.workflow.ts`, `.workflow.js`, `.workflow.mts`, or `.workflow.mjs` module whose default export comes from `defineWorkflow(...)`.

Follow these rules:

- Compose the existing node and edge primitives before adding a new primitive.
- Reuse a finite workflow with a direct typed `includeWorkflow()` mount. Use a controller only when the child needs an independent run or indefinite reconciliation.
- Give included workflows named exits, map their input explicitly, and keep parent edges out of child internals.
- Keep `compute` pure. Put external effects in agent, function-action, or shell-action nodes.
- Use structured node outputs for routing.
- Use an ordinary checkpoint for external continuation data that the model may submit. Use `humanDecision()` for a verified human choice, and use the included `plan-approval` workflow for standard continue, stop, and exact-text replan routing.
- Set explicit step and command timeouts.
- Bound ordinary loops with `maxSteps` or another clear finish rule.
- Use a controller instead of a workflow for indefinite resource reconciliation.
- Keep presentation separate from execution. Use `presentationPrompt` only when a final assistant response is needed.
- Preserve the single active workflow rule in one Pi session.

Read [../../docs/workflows.md](../../docs/workflows.md) before creating or changing a workflow. Read [../../docs/WORKFLOW_COMPOSITION.md](../../docs/WORKFLOW_COMPOSITION.md) for nested workflows. Read [../../docs/HUMAN_DECISIONS.md](../../docs/HUMAN_DECISIONS.md) before adding a human gate or channel. Read [../../docs/DESIGN_PHILOSOPHY.md](../../docs/DESIGN_PHILOSOPHY.md) before adding public primitives. Use the examples under [../../examples/workflows](../../examples/workflows) as starting points.

## Verify changes

For workflow definitions, test success, failure, routing, retries or loops, checkpoints, timeouts, cancellation, and resume behavior that applies.

For extension or engine changes, run the repository checks and the real-Pi end-to-end suite. Verify discovery through the installed package path rather than only loading the source extension file.
