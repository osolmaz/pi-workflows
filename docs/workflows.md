# Workflow authoring reference

This document is the authoring reference for pi-workflows definitions. It
covers the file format, every node type, edge routing, the step contract the
model sees, and how runs behave at runtime. For the on-disk run format, see
[run-bundles.md](run-bundles.md).

## Workflow files

A workflow is a TypeScript module whose default export is `defineWorkflow(...)`.
Files are discovered by suffix (`.workflow.ts`, `.workflow.js`, `.workflow.mts`,
`.workflow.mjs`) from two directories, in precedence order:

1. `.pi/workflows/` in the project (highest precedence on name collisions)
2. `~/.pi/agent/workflows/` globally

The workflow's command name is the file stem, so `.pi/workflows/triage.workflow.ts`
runs as `/workflow triage`. A direct path also works: `/workflow ./somewhere/x.workflow.ts`.
Files are loaded with [jiti](https://github.com/unjs/jiti), so plain TypeScript
works without a build step, and `import ... from "pi-workflows"` resolves to
the engine that loaded the file.

```typescript
import { agent, compute, defineWorkflow } from "pi-workflows";

export default defineWorkflow({
  name: "example",
  title: ({ input }) => `example: ${(input as { task?: string }).task}`,
  presentationPrompt: "Present the final answer clearly and concisely.",
  startAt: "ask",
  maxSteps: 50,
  nodes: {
    ask: agent({
      prompt: ({ input }) => `Answer: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "answer": "text" }`,
    }),
    finish: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "finish" }],
});
```

Top-level fields:

| Field                | Type                   | Notes                                                                                                                                                                                                      |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`               | Required. Used in run ids and the step contract. `cancel`, `list`, `pause`, and `resume` are reserved for `/workflow` subcommands.                                                                         |
| `title`              | `string` or function   | Optional run title, resolved once at start from `{ input, workflowName }`. Async resolution is bounded (30s) and cancellable.                                                                              |
| `presentationPrompt` | `string` or function   | Optional instructions for a normal assistant response after the run. A function receives `{ state, finalOutput }` and may return a prompt or `undefined`. See [Result presentation](#result-presentation). |
| `startAt`            | `string`               | Required. Id of the first node.                                                                                                                                                                            |
| `nodes`              | `Record<string, node>` | Required, non-empty. Node ids must match `[A-Za-z_][A-Za-z0-9_-]*`.                                                                                                                                        |
| `edges`              | `WorkflowEdge[]`       | Required. See routing below.                                                                                                                                                                               |
| `maxSteps`           | `number`               | Optional loop bound, default 100. The run fails when exceeded.                                                                                                                                             |

`defineWorkflow` validates the shape eagerly (node ids, edge shapes, function
fields) and validates the graph (unknown targets, duplicate outgoing edges,
unreachable nodes) when a run starts.

## Node context

Every node callback receives the same context object:

```typescript
type WorkflowNodeContext = {
  input: unknown; // the run input
  outputs: Record<string, unknown>; // accepted output per finished node id
  results: Record<string, WorkflowNodeResult>; // full result records, including failures
  state: WorkflowRunState; // the live run state (read-only by convention)
  signal: AbortSignal; // aborted on node timeout or run cancellation
};
```

`outputs` only contains nodes that finished with outcome `ok`. When a node runs
more than once (a loop), the latest result wins. A failed retry removes the
node's earlier output from `outputs`.

Long-running compute, action, and checkpoint callbacks should observe
`context.signal` (pass it to `fetch`/`spawn`, or check `signal.aborted` between
steps). When the node times out or the run is cancelled, the engine stops
waiting immediately, but only cooperative callbacks stop doing work.

## Node types

### agent

Sends a prompt into the current pi conversation and waits for the model to
submit output through the `workflow` tool.

```typescript
agent({
  prompt: ({ outputs }) => `Review this: ${JSON.stringify(outputs.implement)}`,
  expectedOutput: `{ "verdict": "clean" | "issues_found" }`,
  validate: (output) => output, // optional; throw to reject the submission
  timeoutMs: 30 * 60_000, // optional; default 15 minutes
  statusDetail: "reviewing", // optional; shown in widget and viewer
});
```

The engine appends a step contract to the prompt (see below). When the model
calls the tool, the output passes through normalization (a JSON string is
parsed tolerantly) and then `validate`. If `validate` throws, the tool call
returns an error and the model can retry within the same step. If the agent
ends its turn without submitting, the extension nudges it, twice by default,
then fails the step.

### compute

Runs a TypeScript function inline. Use it for pure data shaping.

```typescript
compute({ run: ({ outputs }) => ({ merged: { ...outputs } }) });
```

### action

Performs a side effect. Two forms exist. The function form runs arbitrary
TypeScript:

```typescript
action({ run: async ({ input }) => await deployPreview(input) });
```

The shell form (`shell` is a synonym that requires `exec`) runs a command owned
by the runtime, so the workflow author decides exactly what executes, with a
timeout and captured output:

```typescript
shell({
  exec: ({ input }) => ({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: "/path/to/repo",
    timeoutMs: 10_000,
    allowNonZeroExit: false,
  }),
  parse: (result) => ({ dirty: result.stdout.trim().length > 0 }),
});
```

Without `parse`, the node output is the full `ShellActionResult` (`stdout`,
`stderr`, `exitCode`, `signal`, `durationMs`). A non-zero exit fails the node
unless `allowNonZeroExit` is set. Captured stdout and stderr are each capped
(default 1,000,000 characters, configurable with `maxOutputChars`) so verbose
commands cannot exhaust memory. Both action forms record a receipt (command,
exit code, duration) in the step record for auditability, including when the
command fails.

### checkpoint

Ends the run in a `waiting` state for human review. Runs after a checkpoint do
not resume automatically; the checkpoint output is the run's final output.
Because nothing resumes past a checkpoint, graph validation rejects outgoing
edges from checkpoint nodes.

```typescript
checkpoint({
  summary: "human decides how to proceed",
  run: ({ outputs }) => outputs.reconcile, // optional; default output is { summary }
});
```

### decision

`decision` is sugar over `agent` for constrained choices. It builds the prompt
suffix listing the choices, sets `expectedOutput`, and validates that the
submitted object carries one of the allowed values in the decision field
(default `route`).

```typescript
const choices = ["y", "n"] as const;

decision({
  choices,
  question: ({ outputs }) => `Same as proposed? ${JSON.stringify(outputs.propose)}`,
});
```

Pair it with `decisionEdge`, which builds the matching `switch` edge and makes
a missing case a compile-time error:

```typescript
decisionEdge({ from: "compare", choices, cases: { y: "implement", n: "reconcile" } });
```

## Edges and routing

Each node has at most one outgoing edge. A plain edge is unconditional:

```typescript
{ from: "a", to: "b" }
```

A `switch` edge routes on a JSON path evaluated against the node's result:

```typescript
{ from: "review", switch: { on: "$.route", cases: { clean: "done", issues_found: "fix" } } }
```

Path roots:

- `$.field` and `$output.field` read from the node's accepted output.
- `$result.field` reads from the result record. `$result.outcome` is the main
  use, with values `ok`, `failed`, `timed_out`, or `cancelled`, which lets a
  workflow route failures to a recovery node instead of failing the run.

A missing case for the resolved value fails the run with a routing error. A
node with no outgoing edge (or no matching failure route) ends the run:
`completed` on success, `failed`/`timed_out`/`cancelled` otherwise.

## The step contract

Every `agent` prompt ends with a step contract block naming the workflow, the
step id, the attempt id, and the expected output shape:

```
---
Workflow step contract (workflow: autoimplement, step: review, attempt: 6f9d…)

Complete this step by calling the `workflow` tool exactly once with:
{"step": "review", "attempt": "6f9d…", "output": <your result>}
Expected output: { "route": "clean" | "issues_found", "reason": "short justification" }
The step is complete only after the workflow tool accepts the output.
If the tool reports a validation error, correct the output and call it again.
```

The `workflow` tool takes `{ step, attempt, output }`. Submissions are
rejected (with a reason the model sees) when no step is pending, the step id
is wrong, the attempt id belongs to an earlier attempt of the same node (loops
revisit node ids, so each attempt gets a fresh id), or `validate` throws.
Acceptance resolves the step and the engine advances; the next agent prompt
arrives as a new user message in the same conversation.

## Result presentation

Workflow nodes produce structured JSON for routing and persistence. When a
person should see a normal prose response after the run, add
`presentationPrompt` at the top level:

```typescript
export default defineWorkflow({
  name: "report",
  presentationPrompt: ({ state, finalOutput }) =>
    state.status === "waiting"
      ? `Explain this recommendation and ask the user to decide: ${JSON.stringify(finalOutput)}`
      : "Summarize the completed result and any remaining limitations.",
  // ...startAt, nodes, and edges
});
```

After the final run state has been persisted, the Pi extension sends the
presentation instructions and bounded final result to the model as a hidden
follow-up message. The next visible message is a normal assistant response.
Returning `undefined`, returning an empty string, or omitting
`presentationPrompt` produces no follow-up. Cancelled runs are never
presented.

Presentation is outside the workflow graph: it cannot route to another node,
change the run status, or alter the run bundle. If prompt generation or message
delivery fails, the extension reports a warning and leaves the finished run
unchanged. Opting in adds one hidden custom message and one assistant response
to the normal Pi session; it adds no other persistent data and uses no Pi
internals.

## Runtime behavior

Runs execute one node at a time. Every transition is persisted to the run
bundle before the engine moves on, which is what makes the live viewer
possible. Defaults worth knowing:

- Node timeout is 15 minutes unless the node sets `timeoutMs`. A timed-out
  node has outcome `timed_out` and can be routed with `$result.outcome`.
- `maxSteps` (workflow-level, default 100) bounds loops built from cycles in
  the graph.
- `/workflow pause` requests a pause: the current step finishes normally,
  then the run holds at the step boundary (`paused: true` in the run state,
  `run_paused` in the trace) until `/workflow resume` or `/workflow cancel`.
  Pausing never interrupts a node mid-flight.
- Interrupting a turn (escape) auto-pauses the run: the pending agent step is
  held without nudges and the engine pauses at the next boundary. Node
  timeouts keep ticking while held, so a long-abandoned step still times out.
  `/workflow resume` re-delivers the pending step prompt.
- `/workflow cancel` aborts the current node and marks the run `cancelled`.
  When no run is live but the widget still shows a parked or finished run,
  the same command clears the widget.
- One workflow runs per session at a time.
- Agent nudges: if the model ends its turn without submitting the pending
  step, it gets a reminder, twice by default, then the step fails.

## Using the engine outside pi

The engine is pi-agnostic. `WorkflowEngine` takes any `AgentStepExecutor`, so
tests (and other hosts) can script agent steps:

```typescript
import { WorkflowEngine, type AgentStepExecutor } from "pi-workflows";

const executor: AgentStepExecutor = {
  async runAgentStep(request) {
    const accepted = await request.accept({ answer: "42" });
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  },
};

const engine = new WorkflowEngine({ executor, outputRoot: "/tmp/runs" });
const { state } = await engine.run(workflow, { task: "..." });
```
