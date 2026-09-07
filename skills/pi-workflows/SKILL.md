---
name: pi-workflows
description: Use when creating, reviewing, debugging, starting, inspecting, or controlling pi-workflows; authoring .workflow.ts files; using the workflow tool; handling workflow step contracts, checkpoints, updates, or progress; or deciding how a task should compose workflow primitives.
compatibility: Requires the pi-workflows extension.
---

# pi-workflows

Use pi-workflows for durable multi-step work that needs explicit routing, retries, checkpoints, scheduled waits, or progress. Keep simple one-turn work outside a workflow.

The `workflow` tool schema is the authority for call shapes. A workflow step message is the authority for its exact request ID, step, attempt, and expected output. Do not guess these values from an earlier attempt.

## Operate workflows

Use the smallest applicable action:

- `list` discovers available workflows. Use its offset for later pages.
- `start` starts a discovered workflow name or workflow file path with structured input.
- `status` reads the active run, or the named run when `runId` is supplied.
- `pause`, `resume`, and `cancel` control the current active run.
- `answer` completes the exact ordinary checkpoint request in the same run. It cannot complete an agent step or satisfy a protected `humanDecision()` gate.
- `restart` creates fresh work only when the user explicitly requested it. Supply the exact terminal `runId` and use the view's `runRevision` as `expectedRevision`, not its presentation `revision`. It does not copy old steps, settings changes, approvals, or effects.
- `update` publishes a non-completing durable update for the active step attempt.
- `submit` completes an active submitted agent step with its required output. An assistant-message step completes through its normal visible reply instead.

When the user asks to continue or resume the active workflow, call `workflow` with `action: "resume"` immediately. Do not use `workflow status` as a substitute or prerequisite.

Use `start` only once for one requested run. Before starting, load the matching workflow skill when one exists and build its complete input. Include scope, authority, constraints, identifiers, and finish criteria required by that skill. Do not start with placeholders that still need user or model repair.

For a workflow without a specialized skill, inspect its input contract and make one complete call. For example:

```json
{
  "action": "start",
  "workflow": "examples/workflows/echo.workflow.ts",
  "input": {
    "task": "Summarize this repository in one sentence."
  }
}
```

Do not build a manual polling loop around a workflow that already schedules its own work. Use the `monitor` skill for monitoring requests.

## Complete agent steps

When a workflow step message arrives:

1. Do the requested work with the available tools.
2. Follow the completion form in the current step contract.
3. For a submitted step, produce the exact expected shape and call `workflow` with `action: "submit"` and the exact `requestId` in the current contract. If validation rejects the output, correct it and submit again to that request.
4. For an assistant-message step, reply with the requested normal assistant message. Do not call `workflow submit`; the settled visible reply is the node output.
5. After completion, do not add another response. The workflow sends its next declared step or a factual terminal notice. The notice does not ask for more model work.

A node can run more than once in a loop. Each attempt has a new `requestId`. Never use a request ID from an earlier attempt.

## Publish updates and progress

Use `update` with the exact `requestId` only while that agent request is active. An update does not complete the step and does not control routing.

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
- Use structured node outputs when the graph must inspect fields or choose a route. Use `expectedOutput: assistantMessage()` when exact visible text is the node result.
- Use an ordinary checkpoint for external continuation data that the model may submit. Use `humanDecision()` for a verified human choice. Use its typed `onTimeout` policy only when the workflow may supply a named automatic response after a durable deadline. A timeout response is recorded as policy provenance, not as a human answer.
- Use the shared internal plan-change workflow for Autoplan, Autodoc, plan approval, and bounded exact-text replanning. Do not copy that sequence into Autoimplement, Monitor, or another workflow.
- Set explicit step and command timeouts.
- Bound ordinary loops with `maxSteps` or another clear finish rule.
- Use a controller instead of a workflow for indefinite resource reconciliation.
- Declare all model work in the graph. Use an assistant-message agent for a visible explanation. Terminal notices report saved facts and never start a model turn. Do not use `presentationPrompt` or add reminder loops outside the graph.
- Preserve the single active workflow rule in one Pi session.

Read [../../docs/WORKFLOWS.md](../../docs/WORKFLOWS.md) before creating or changing a workflow. Read [../../docs/WORKFLOW_COMPOSITION.md](../../docs/WORKFLOW_COMPOSITION.md) for nested workflows. Read [../../docs/HUMAN_DECISIONS.md](../../docs/HUMAN_DECISIONS.md) before adding a human gate or channel. Read [../../docs/DESIGN_PHILOSOPHY.md](../../docs/DESIGN_PHILOSOPHY.md) before adding public primitives. Use the examples under [../../examples/workflows](../../examples/workflows) as starting points.

## Verify changes

For workflow definitions, test success, failure, routing, retries or loops, checkpoints, timeouts, cancellation, and resume behavior that applies.

For extension or engine changes, run the repository checks and the real-Pi end-to-end suite. Verify discovery through the installed package path rather than only loading the source extension file.
