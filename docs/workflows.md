# Workflow authoring reference

This document is the authoring reference for pi-workflows definitions. It
covers the file format, every node type, edge routing, the step contract the
model sees, and how runs behave at runtime. For the on-disk run format, see
[run-bundles.md](run-bundles.md).

## Workflow files

A workflow is a TypeScript module whose default export is `defineWorkflow(...)`.
Files are discovered by suffix (`.workflow.ts`, `.workflow.js`, `.workflow.mts`,
`.workflow.mjs`) from these sources, in precedence order:

1. `.pi/workflows/` in the project (highest precedence on name collisions)
2. `~/.pi/agent/workflows/` globally
3. Workflows built into Pi Workflows

Pi Workflows includes built-in `autoplan`, `autodoc`, `autoimplement`,
`plan-approval`, `sanity-check`, and `monitor` workflows. `autoplan` is the current name for the
planning workflow that was first released as `autodevise`; the old command and
export are not retained. A project or global file named `monitor.workflow.ts`
replaces the built-in monitor. The package registers each built-in in
a process-local catalog with a stable reference such as `builtin:monitor` and
an explicit revision. Built-ins are imported with the engine when a Pi process
starts. They are not read from the package directory when a run starts or
resumes. Updating the package on disk cannot mix a new built-in with that
process's old engine; reload or restart Pi to use the new built-in. A revision
mismatch refuses resume. Project and global workflow files still reload on
each run and use their path and SHA-256 hash as their source identity.

The workflow's command name is the file stem, so `.pi/workflows/triage.workflow.ts`
runs as `/workflow triage`. A direct path also works: `/workflow ./somewhere/x.workflow.ts`.
Files are loaded with [jiti](https://github.com/unjs/jiti), so plain TypeScript
works without a build step, and `import ... from "@osolmaz/pi-workflows"` resolves to
the engine that loaded the file.

```typescript
import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

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

| Field                | Type                      | Notes                                                                                                                                                                                                              |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`               | `string`                  | Required. Used in run ids and the step contract. `answer`, `cancel`, `list`, `pause`, `resume`, and `status` are reserved for `/workflow` subcommands.                                                             |
| `source`             | `string`                  | Optional `import.meta.url` for exact provenance when another TypeScript workflow imports this definition directly.                                                                                                 |
| `contractId`         | `string`                  | Optional stable input-and-exit contract identity. Dynamic overrides must match it.                                                                                                                                 |
| `input`              | `function`                | Optional runtime input normalizer and validator. Its return type is the workflow input type.                                                                                                                       |
| `title`              | `string` or function      | Optional run title, resolved once at start from `{ input, workflowName }`. Async resolution is bounded (30s) and cancellable.                                                                                      |
| `presentationPrompt` | `string` or function      | Optional instructions for a normal assistant response after the run. A function receives `{ state, finalOutput, signal }` and may return a prompt or `undefined`. See [Result presentation](#result-presentation). |
| `startAt`            | `string`                  | Required. Id of the first node.                                                                                                                                                                                    |
| `nodes`              | `Record<string, node>`    | Required, non-empty. Node ids must match `[A-Za-z_][A-Za-z0-9_-]*`.                                                                                                                                                |
| `includes`           | `Record<string, include>` | Optional imported or dynamically resolved child workflows.                                                                                                                                                         |
| `exits`              | `Record<string, exit>`    | Optional named successful terminal nodes used when another workflow includes this workflow.                                                                                                                        |
| `edges`              | `WorkflowEdge[]`          | Required. See routing below.                                                                                                                                                                                       |
| `maxSteps`           | `number`                  | Optional loop bound, default 100. The run fails when exceeded.                                                                                                                                                     |

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

Function actions receive `WorkflowActionContext`, which adds
`publishUpdate(update)`. Other callbacks keep the read-only node context.

## Durable runs, parking, and resume

Every interactive `/workflow` run is tracked in the project run queue (see
[CONTROLLERS.md](CONTROLLERS.md) for the store). The session that starts a run
claims it and owns it while it executes; every bundle write proves the claim
first (write fencing).

Closing the Pi session mid-run no longer cancels the run. The engine **parks**:
it stops without a terminal event, releases the claim, and leaves the bundle
resumable. When a runner is available again (a reopened Pi session or the
standalone host), the run **resumes** at the node it stopped on. Completed
nodes replay from the recorded state; only the interrupted node and everything
downstream rerun. Resume repairs a torn trace tail, drops trace events the
state projection never recorded, and refuses to continue if the workflow
source changed since the run started (a forced resume records the mismatch).

The standalone host runs without any Pi session:

```bash
pi-workflows host --project /path/to/project
```

The host claims parked runs, resumes them, and reconciles durable controllers.
Conversation nodes execute in headless `pi --mode rpc` children that load a
small bridge extension; the model sees the same `workflow` tool contract as an
in-session run. The host is a foreground process: start it in a terminal and
stop it with Ctrl-C. A second host for the same project refuses to start, and
a host that dies has its orphaned children reaped by the next one. While the host works, reports enter a durable outbox addressed to the Pi
session that started the run. They remain pending while that session is closed
and never enter another conversation in the same project.

## Node types

### agent

Sends a prompt into the current pi conversation and waits for the model to
submit output through the `workflow` tool.

```typescript
agent({
  prompt: ({ outputs }) => `Review this: ${JSON.stringify(outputs.implement)}`,
  expectedOutput: `{ "verdict": "clean" | "issues_found" }`,
  validate: (output) => output, // optional; throw to reject the submission
  timeoutMs: ({ input }) =>
    (input as { timeoutMinutes?: number }).timeoutMinutes
      ? (input as { timeoutMinutes: number }).timeoutMinutes * 60_000
      : 30 * 60_000, // optional number or context callback; default 15 minutes
  statusDetail: "reviewing", // optional; shown in widget and viewer
});
```

The engine appends a step contract to the prompt (see below). When the model
calls the tool, the output passes through normalization (a JSON string is
parsed tolerantly) and then `validate`. If `validate` throws, the tool call
returns an error and the model can retry within the same step. If the agent
ends its turn without submitting, the extension nudges it, twice by default,
then fails the step. If an agent node times out or the workflow is cancelled,
the extension also aborts its active Pi turn. The model cannot continue to use
tools after the engine has closed that attempt.

`timeoutMs` can be a finite positive number, `null`, or a function of the normal
node context that returns either value. Omit it to use the 15-minute engine
default. Set it to `null` to disable only the wall-clock deadline; cancellation,
parking, claim loss, shutdown, and the node's abort signal still work. A timeout
function can use prepared outputs to select a policy for this run. It has 30
seconds to return. Computed timeout functions are runtime code, so definition
snapshots omit them. Snapshots keep fixed numbers and fixed `null` values.

### compute

Runs a TypeScript function inline. Use it for pure data shaping.

```typescript
compute({ run: ({ outputs }) => ({ merged: { ...outputs } }) });
```

### notify

Queues a durable plain-text message for the Pi session that started the run.
The runner does not write the message into its own conversation. A standalone
host can execute this node, and the message still waits for the origin session.

```typescript
notify({
  kind: "progress", // or "final"
  message: ({ outputs }) => String(outputs.check),
});
```

The runtime gives each logical execution of a notification node a stable index.
A retry after a crash reuses that index, so it cannot queue the same message
twice. Re-entering the node later in a loop gets the next index. A workflow
with a `notify` node must be an interactive queued run with an origin session.
Controller child workflows are detached and must report through their
controller resource instead.

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

A function action can publish a durable update without completing the node:

```typescript
action({
  run: async ({ publishUpdate }) => {
    await publishUpdate({
      type: "progress",
      key: "overall",
      data: {
        schema: "pi-workflows.progress.v1",
        status: "running",
        completed: 40,
        total: 100,
        unit: "rows",
      },
    });
  },
});
```

A shell action can parse complete lines from stdout or stderr and return one
or more updates through `updates.parseLine`. Parsing applies backpressure and
keeps normal output capture. Lines and update data are each limited to 64 KiB.
See [WORKFLOW_UPDATES.md](WORKFLOW_UPDATES.md) for the envelope, progress
schema, limits, estimation, and error rules.

### checkpoint

Ends the run in a `waiting` state for human review. The checkpoint bundle is
terminal, so no process keeps running while the run waits. The human answers
with `/workflow answer <json>` (or plain text), which starts a **continuation
run**: a new run with its own bundle and trace, linked to the checkpointed run
through `parentRunId`. The continuation receives the answer as its input,
carries forward every output the parent produced (including the checkpoint's),
and continues routing along the checkpoint's outgoing edge. Outgoing edges
from checkpoint nodes are allowed exactly so continuations have somewhere to
go; step accounting carries over, so `maxSteps` bounds the whole chain.

```typescript
checkpoint({
  summary: "human decides how to proceed",
  run: ({ outputs }) => outputs.reconcile, // optional; default output is { summary }
});
```

A typed human decision is an authoring layer over checkpoint:

```typescript
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
  replan: choice({
    label: "Replan",
    input: textInput({ name: "instructions", prompt: "What should change?" }),
  }),
});

humanDecision({
  audience: "operator",
  choices,
  onTimeout: {
    afterMs: 10 * 60_000,
    response: { choice: "continue" },
  },
  request: ({ outputs }) => ({
    title: "Approve plan",
    subject: outputs.plan,
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "Review the implementation plan.",
      blocks: [{ kind: "paragraph", text: "The plan is ready for approval." }],
    },
  }),
});
```

The waiting run stores a versioned request and asks every channel configured for the logical audience. The structured `subject` remains machine data. Channels receive only the normalized `presentation`, title, choices, input prompts, and any deadline policy. The first valid verified human answer wins. When `onTimeout` is present and no human answer wins before the saved deadline, recovery applies the validated response with `timeout` provenance. This policy can continue without a configured channel. A continuation preserves the original workflow input and exposes the resolved response as the checkpoint output. `humanDecisionEdge()` provides exhaustive routing for the choices. Existing `body` requests remain a legacy compatibility form and use deterministic readable formatting.

The model-facing workflow tool cannot answer a protected human decision. Pi interactive UI and configured external channels use a host-owned answer path. Ordinary checkpoints keep the existing `/workflow answer` behavior.

See [Human decisions](HUMAN_DECISIONS.md) for channels, recovery, persistence, and plan approval.

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

## Included workflows

Use `includeWorkflow()` to mount a standalone workflow under a parent name:

```typescript
import repair from "./repair.workflow.js";

includes: {
  repair: includeWorkflow(repair, {
    input: ({ outputs }) => ({ issue: outputs.check }),
  }),
},
```

The child declares named exits:

```typescript
exits: {
  completed: { from: "finalize", validate: parseCompleted },
  blocked: { from: "blocked", validate: parseBlocked },
},
```

Enter through the mount and leave through `<mount>.<exit>`:

```typescript
{ from: "check", to: "repair" }
{ from: "repair.completed", to: "check" }
{ from: "repair.blocked", to: "finish" }
```

Direct imports check child input and exit names in TypeScript. Use `includedResult(child, outputs.mount)` to recover the child's discriminated exit output without a cast. Dynamic discovered names, built-in references, and file paths are also supported. Every reference resolves before the run starts.

Child callbacks receive local input, outputs, results, and steps from their current invocation. Persisted node identities include the mount path. Re-entry starts with empty child-local state. Root and child step limits both apply. Internal entry and exit transitions do not consume those limits.

The run records every mounted source and a digest of the resolved graph. Resume refuses a changed child source. Source cycles are rejected before the run starts. See [Workflow composition](WORKFLOW_COMPOSITION.md) for typing, persistence, nesting, and viewer rules.

## Model workflow control

The model sees one `workflow` tool. Its `action` field supports:

- `list` for discovered workflow names and sources.
- `start` with a workflow name or path and structured input.
- `status` for the active run or a supplied run ID.
- `pause`, `resume`, and `cancel` for the active run.
- `answer` with ordinary checkpoint input and an optional run ID. Protected `humanDecision()` gates reject this model-facing action.
- `update` for a non-completing update from the current agent attempt.
- `submit` for the current workflow step contract.

A model-started run is queued until the model's current turn settles. The first
workflow prompt then starts a new turn. This keeps the requesting turn outside
the workflow's first attempt and prevents an early missing-submission reminder.
The normal extension offers all actions. The headless RPC bridge offers only
`update` and `submit`, so a workflow child cannot recursively control other
runs.

### Built-in planning and implementation

The built-in `autoplan` workflow selects a practical in-scope solution and writes a detailed plan. The standalone `autodoc` workflow finds an already selected plan, records it in canonical documentation, verifies those documents, and never devises or implements. The built-in `autoimplement` workflow finds a clear existing plan from explicit input, conversation context, or referenced canonical documents. It blocks when no clear plan exists. An explicit plan bypasses autodoc only when a current-document receipt carries its matching plan digest; otherwise autodoc inspects and adopts or updates the canonical documents. Later invalidating evidence returns to `autoplan` followed by `autodoc`.

The built-in `plan-approval` workflow offers `continue`, `stop`, and exact-text `replan` exits. Its shared policy uses `auto`, `required`, or `skip` mode. Omitted policy defaults to `auto`: ask audience `operator`, then continue with the exact plan after 10 minutes without an answer. Required mode waits for a human. Skip mode creates no decision. Stop and replan always require a human answer.

The internal plan-change workflow composes Autoplan, Autodoc, plan approval, and bounded replanning. Autoimplement and Monitor use it whenever they create or change a plan. Existing supplied or discovered plans bypass the gate. A plan selected by Monitor enters Autoimplement without another decision for the same digest.

Autoimplement runs independent commands through bounded command batches. A batch is an ordinary function action that calls the public `runCommandBatch` helper. Each command has a stable ID, executable, arguments, absolute working directory, timeout, and output limit. Results stay separate and return in input order. One command uses the same path with concurrency one.

Autoimplement gives `implement` an eight-hour deadline. When a supported
long-running agent node times out, one shared read-only fallback inspects the
current repository, accepted workflow outputs, and relevant pull-request state.
It then retries the timed-out stage or routes to verification, review, CI,
delivery, the existing redesign workflow, or blocked. The fallback can run at
most three times in one Autoimplement run. Its own failure or timeout is
terminal. Cancellation remains immediate and never enters fallback. A repeated
effect step first checks what already exists and performs only missing work.
This graph fallback starts after the timed-out turn ends and is separate from
successor-turn delivery.

Autoimplement uses batches for pi-reviewer, pending CI watches, and local verification commands from independent repositories. It keeps model turns, fixes, pushes, comment changes, merges, and releases in their existing order. Reviewer commands are tied to the repository, base branch, pushed head, and relevant dependency fingerprint. A later review round includes only repositories whose head or dependency fingerprint changed. P0 or P1 work still requires another review. P2-only work can be addressed and verified without another reviewer run only because of that P2 work.

Autoimplement inspects every pull request before it waits for CI. It accepts only supported pending `gh pr checks --watch` or `gh run watch` descriptors and binds each one to the validated pull request as `gh pr checks <PR URL> --watch`. Repository and pull-request overrides are rejected. One watch lasts at most five minutes. A failed or timed-out watch affects only its pull request. When checks remain pending, the model runs more useful local tests before checking CI again. Autoimplement does not invent an ETA.

The action abort signal stops active command process groups and prevents queued commands from starting. Accepted outputs use the existing trace and artifacts. An interrupted unaccepted batch runs again because batch commands are read-only or isolated local checks. Progress updates contain metadata only and never control routing. Truncated reviewer or CI output cannot count as clean. See [Run independent commands in bounded batches](plans/2026-08-20-bounded-command-batches-plan.md) for the complete contract and implementation plan.

A model-generated blocker from implementation or a safe later stage does not end autoimplement by itself. A separate blocker-challenge agent checks the task, approved plan, current result, evidence, scope, authority, earlier attempts, and practical alternatives. It confirms a blocker only when the blocker exists now, is outside the granted authority, has no safe path forward, has an empty next action, and includes concrete evidence and checked alternatives. A rejected blocker must name the next practical action and routes through the existing redesign workflow before implementation and verification continue.

Autoimplement can run the blocker challenge at most three times in one run. Each later challenge receives the earlier challenge results. Reaching the limit stops with the normal workflow safety-limit reason. Explicit human stops, cancellation, exhausted workflow or replan limits, protected authorization gaps, and an independent blocked result from redesign remain direct stops. These hard boundaries do not enter the blocker challenge.

### Built-in sanity check

The built-in `sanity-check` workflow reviews a pull request or local contribution before implementation, approval, or merge. It checks whether the change is needed, duplicates existing code, should use a simpler design, adds unnecessary data models or public plugin and SDK APIs, or has scope and test problems.

```json
{
  "mode": "serial",
  "baseRef": "origin/main"
}
```

Serial mode is the default. It runs one review session for all four review areas, then one verification session. Parallel mode runs four focused review sessions at the same time, then one verification session. Serial mode uses two model sessions. Parallel mode uses five. When `baseRef` is omitted, the workflow tries the remote default branch, the current branch upstream, and the first parent, then uses `HEAD` for a working-tree-only review.

The workflow collects pull request intent and repository diff evidence before model review. It bounds evidence and review results before prompt construction and marks truncated input. Every review must cite evidence and give the strongest case for accepting the current design. The verification session removes unsupported claims, requires exact file and symbol references, resolves supported conflicts, and returns `keep`, `simplify`, `refactor`, `drop`, or `needs_evidence`.

Sanity Check revision 3 creates child sessions directly through the documented Pi SDK. A private built-in runner uses `createAgentSession` with `SessionManager.inMemory`, one independent context per child, and only the verified built-in `read`, `grep`, `find`, and `ls` tools. Child sessions load no skills, prompt templates, themes, or context files. They create no Pi session file.

The parent Pi process keeps its normal configured extensions enabled. The child runner resolves enabled user extension paths, excludes Pi Workflows and project extensions by default, and preflights the remaining paths without creating a session. It admits only the extension that registers the exact configured provider, plus any behavior extension on an explicit private allowlist. It rejects competing provider owners, workflow tools or commands, and extensions that replace a built-in read-only tool. The admitted paths are frozen for the group, and each child loads only those explicit paths without a second discovery pass.

Each child owns a separate `ModelRuntime`, provider instance, extension runtime, resource loader, and in-memory session. The runner loads validated model and ordinary credential snapshots into per-child in-memory stores without writing them back. A provider extension uses its existing provider-owned credential store in place; Pi Workflows does not copy, print, migrate, or persist those credentials.

A complete explicit provider, model, and thinking override wins. Otherwise, the runner uses the configured process defaults. It passes the exact cached model and thinking level to the child, then verifies the actual provider, model, thinking level, authentication, extension state, active tools, and tool sources before prompting. A missing or different dispatch is terminal. The runner never silently falls back to OpenRouter, Kimi, a local model, or another provider or model. It does not promise to inherit a model selected temporarily in the origin Pi TUI.

Children do not receive the `workflow` tool, workflow commands, parent run identifiers, update channels, or workflow callbacks. Prompts that invoke extension slash commands are rejected. The parent Sanity Check action remains the only workflow owner. These controls block normal child model and extension bindings from inspecting or changing workflow state. Extensions still run as trusted code in the parent Node process, so this is not an OS sandbox against direct filesystem or network access.

Only bounded final assistant text and safe operational facts leave a live child session. Pi Workflows does not persist child prompts, reasoning, intermediate messages, tool arguments, tool results, message history, credentials, or extension-private state. Timeout and cancellation abort and settle active work before the runner disposes the session, shuts down extensions, and releases provider resources.

The workflow publishes aggregate and per-agent `pi-workflows.progress.v1` tracks under `agents/review/*` and `agents/verification/*`. Progress contains role, the verified actual model when known, state, elapsed facts, and safe phases such as `thinking` or `tool: read`. The Pi widget shows the aggregate plus failed and active children within its ten-line limit. `piw` shows every durable child track and its samples. Both views use existing progress records, so no child workflow run or new persisted schema is needed.

Serial mode still uses two sessions, and parallel mode still uses five. Prompts, review areas, strict result validation, verdicts, and final notification stay unchanged. The workflow sends the final report through a final notification with `triggerTurn: false`, so the origin model does not produce another response. The CLI, JSON or RPC stream, temporary prompt file, standard-output cap, subprocess fallback, shared child runtime, and blanket child-extension ban are not retained. See [the Sanity Check plan](plans/2026-08-21-sanity-check-plan.md) for the selected implementation and test boundaries.

### Built-in monitor

The built-in `monitor` workflow turns a plain request for repeated checks into
one looping workflow run. Its input is:

```json
{
  "task": "Check pull request 123",
  "stopWhen": "The pull request is merged or closed"
}
```

The first check runs immediately. Routine bounded repair is authorized by default. Set `repair: false` for observation-only monitoring. A repair routes through the shared plan-change workflow, Autoimplement, and a fresh check. A repeated issue with unchanged target evidence stops as blocked. Use a repair object with `authorized: true` to narrow its scope or policy. Omit `repair.approval` for the 10-minute autonomous default. Use `approval.mode: "required"` to wait for an explicit answer or `approval.mode: "skip"` to continue without asking.

`everyMinutes` defaults to 30. Each accepted check must provide one concise report and choose `continue`, `repair` when authorized, or `stop`. The
runtime queues that report as a workflow notification with `triggerTurn:
false`, so it does not cause an assistant reply. A check can also provide
independent progress tracks. The regular Pi model running the check observes
the target and submits those facts. Pi Workflows validates the counts and
calculates rates, confidence, and ETA deterministically. The target does not
need a Pi Workflows dependency or reporting protocol.

Intervals must be whole minutes from 1 through 1,440. When `stopWhen` is
omitted, the monitor stops only after an explicit user request. `maxChecks`
defaults to the disclosed safety ceiling of 1,000 and cannot exceed it. Callers
omit `maxChecks` unless the user requests a fixed count. `checkTimeoutMinutes`
is from 5 through 1,440 and defaults to the larger of 60 and `everyMinutes`.
See [MONITOR.md](MONITOR.md) for the check and progress schemas.

The interval uses the existing shell action to launch the current Node
executable with a timer. This works on every platform supported by Pi. The node
and command timeouts are higher than the maximum interval. Cancelling the
workflow aborts the timer process immediately. If the owning Pi process or
standalone host stops during the wait, normal parking rules abort the shell node
and resume later by running that wait again from the beginning.

A monitor uses the session's single active workflow slot. It does not provide
cron syntax, calendar scheduling, OS notifications, or a background service.

## The step contract

Every `agent` prompt ends with a step contract block naming the workflow, the
step id, the attempt id, and the expected output shape:

```
---
Workflow step contract (workflow: autoimplement, step: review, attempt: 6f9d…)

Complete this step by calling the `workflow` tool exactly once with:
{"action": "submit", "step": "review", "attempt": "6f9d…", "output": <your result>}
Expected output: { "route": "clean" | "issues_found", "reason": "short justification" }
The step is complete only after the workflow tool accepts the output.
If the tool reports a validation error, correct the output and call it again.
```

The `workflow` tool uses `{ action: "submit", step, attempt, output }` for step
results. Submissions are rejected (with a reason the model sees) when no step
is pending, the step id is wrong, the attempt id belongs to an earlier attempt
of the same node (loops revisit node ids, so each attempt gets a fresh id), or
`validate` throws.
Acceptance resolves the step and the engine advances. In an interactive Pi
session, each agent prompt arrives as a `pi-workflows-agent-step` custom message
with `triggerTurn: true`. The model receives the complete prompt, while the
conversation shows a compact workflow and node card. Expanding tool output with
Ctrl+O shows the exact contract and full prompt. Reminders and resumed prompts
use the same card and keep the active attempt id.

Headless RPC execution receives the same complete prompt without TUI metadata.
Workflow notifications use a separate message type with `triggerTurn: false`,
so a notification does not start an assistant response. Deferred successor turns
use an internal turn-intent contract instead of the notification outbox. See
[WORKFLOW_STEP_MESSAGES.md](WORKFLOW_STEP_MESSAGES.md) for the step-message contract
and [Deferred workflow turns](DEFERRED_TURNS.md) for the successor-turn contract.

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
`presentationPrompt` produces no presentation. Failed, timed-out, and cancelled
runs are never presented. When one of those outcomes would otherwise strand an
agent after a workflow-caused turn abort or asynchronous crash, the extension
uses the deferred-turn contract to send one factual fallback after settlement.
Async prompt builders have 30 seconds to finish and receive an
`AbortSignal` that fires on timeout, session shutdown, or when a new workflow
or normal user turn starts; stale presentations are discarded. Once a presentation message has
been queued, another workflow cannot start until that assistant response
settles, so results cannot interleave.

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

- Node timeout is 15 minutes unless the node sets `timeoutMs` to a positive
  number or context callback. A timed-out node has outcome `timed_out` and can
  be routed with `$result.outcome`. A timed-out agent node also aborts its Pi
  turn, and late output for that attempt is rejected.
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
- A model-started workflow is persisted as `queued` with its final run ID before the start tool
  returns. Activation waits for the initiating agent turn to settle, then moves through `starting`
  and `running`. `workflow status` and `workflow cancel` accept the run ID before a run bundle
  exists.
- If deferred activation fails, the queue stores a bounded safe error, releases the session
  reservation, and creates one deferred-turn intent for the initiating session. A workflow that
  reports `started` and then crashes before its first prompt follows the same path. The model gets
  one factual follow-up after settlement and can make a new explicit start call. Pi Workflows does
  not retry blindly.
- An agent-issued `workflow cancel` aborts the current node and the current Pi turn, then creates
  one deferred-turn intent. The next natural workflow message resolves it when possible; otherwise
  one factual fallback starts after settlement. Direct `/workflow cancel` remains quiet because it
  is explicit user control. When no run is live but the widget still shows a parked or finished run,
  the command clears the widget.
- One workflow runs per session at a time.
- After the workflow tool accepts an agent-step submission, the extension removes any assistant tail text from the rest of that agent run. The next workflow message is the visible continuation. A deferred intent makes a workflow prompt, presentation, and factual fallback compete to provide one successor turn, so an abort cannot produce two continuation turns.
- Agent nudges: if the model ends its turn without submitting the pending
  step, it gets a reminder, twice by default, then the step fails.

## Workflows started by controllers

A controller can start a workflow as a finite child job with `ctx.workflows.ensure()`. The request key is stable across reconciliation passes, and the input fingerprint prevents one key from being reused for different work.

```typescript
const run = await ctx.workflows.ensure({
  requestKey: `repair:${resource.metadata.generation}`,
  workflow: "repair-pull-request",
  input: { repository: resource.spec.repository, number: resource.spec.number },
});

if (run.state !== "succeeded") {
  return ctx.requeueAfter(5_000, {
    workflowRun: {
      requestId: run.requestId,
      ...(run.runId ? { runId: run.runId } : {}),
      state: run.state,
      attempt: run.attempt,
    },
  });
}
```

Child workflow completion queues the parent resource again. A running child left by a stopped host is recorded as a failed run bundle with a `run_interrupted` event. The controller treats that child attempt as interrupted, and the next parent reconciliation starts another immutable attempt. Consequential external mutations should use the controller effect API so uncertain results are observed before retry.

See [CONTROLLERS.md](CONTROLLERS.md) for controller definitions and the full recovery contract.

## Using the engine outside pi

The engine is pi-agnostic. `WorkflowEngine` takes any `AgentStepExecutor`, so
tests (and other hosts) can script agent steps:

```typescript
import { WorkflowEngine, type AgentStepExecutor } from "@osolmaz/pi-workflows";

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
