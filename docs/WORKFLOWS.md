# Workflow authoring reference

This document is the authoring reference for pi-workflows definitions. It
covers the file format, every node type, edge routing, the step contract the
model sees, and how runs behave at runtime. For durable state, see
[SQLITE_STATE.md](SQLITE_STATE.md).

## Starting and resuming runs

A successful start call confirms that a run was created. Wait for the delivered
step contract before submitting an agent result. Report worktree creation or
implementation progress only after the corresponding recorded steps succeed.
The status view distinguishes unconfirmed step delivery, active agent work,
required results, and a durable pause. Waiting uses a different glyph from pause.

Resume uses the run's original source and graph, including ordinary workflows
without included workflows. Source and graph checks run before any durable
mutation. `WorkflowEngine.resumeRun` has no `force` option. Restore the original
source to resume its accepted work, or explicitly start a new run for changed
code. A new run does not inherit outputs, approvals, or effect receipts.
File and built-in source identities verify code; callers of the direct engine
API must supply source identity to detect callback-body changes that leave the
structural graph unchanged.

## Workflow files

A workflow is a TypeScript module whose default export is `defineWorkflow(...)`.
Files are discovered by suffix (`.workflow.ts`, `.workflow.js`, `.workflow.mts`,
`.workflow.mjs`) from these sources, in precedence order:

1. `.pi/workflows/` in the project (highest precedence on name collisions)
2. `~/.pi/agent/workflows/` globally
3. Workflows built into Pi Workflows

Pi Workflows includes built-in `plain-summary`, `autoplan`, `autodoc`,
`autoimplement`, `plan-approval`, `sanity-check`, and `monitor` workflows. `autoplan` is the current name for the
planning workflow that was first released as `autodevise`; the old command and
export are not retained. A project or global file named `monitor.workflow.ts`
replaces the built-in monitor. Each built-in has a stable reference such as
`builtin:monitor` and an explicit revision. A resolver child snapshots the
selected built-in before start, and each run runner verifies that identity
before execution. A revision mismatch refuses resume. Project and global
workflow files also use their absolute path and SHA-256 hash as source
identity.

Package-internal workflows can be registered as non-discoverable built-ins.
They do not appear in the workflow list or ordinary name lookup, but composed
built-ins record them with a stable built-in ID and revision. This keeps source
identity independent of the package installation path. It does not weaken file
identity checks for project and global workflows.

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

| Field        | Type                      | Notes                                                                                                                                                  |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`       | `string`                  | Required. Used in run ids and the step contract. `answer`, `cancel`, `list`, `pause`, `resume`, and `status` are reserved for `/workflow` subcommands. |
| `source`     | `string`                  | Optional `import.meta.url` for exact provenance when another TypeScript workflow imports this definition directly.                                     |
| `contractId` | `string`                  | Optional stable input-and-exit contract identity. Dynamic overrides must match it.                                                                     |
| `input`      | `function`                | Optional runtime input normalizer and validator. Its return type is the workflow input type.                                                           |
| `title`      | `string` or function      | Optional run title, resolved once at start from `{ input, workflowName }`. Async resolution is bounded (30s) and cancellable.                          |
| `startAt`    | `string`                  | Required. Id of the first node.                                                                                                                        |
| `nodes`      | `Record<string, node>`    | Required, non-empty. Node ids must match `[A-Za-z_][A-Za-z0-9_-]*`.                                                                                    |
| `includes`   | `Record<string, include>` | Optional imported or dynamically resolved child workflows.                                                                                             |
| `exits`      | `Record<string, exit>`    | Optional named successful terminal nodes used when another workflow includes this workflow.                                                            |
| `edges`      | `WorkflowEdge[]`          | Required. See routing below.                                                                                                                           |
| `maxSteps`   | `number`                  | Optional loop bound, default 100. The run fails when exceeded.                                                                                         |

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
  settings?: unknown; // fixed typed settings for this attempt, when declared
  settingsScopeId?: string;
  settingsChangeNumber?: number;
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

A workflow can declare typed JSON settings with `workflowSettings()`. Each node
attempt receives one fixed copy. Authorized changes use RFC 6902 JSON Patch and
affect only later attempts. Use `settingsRoute()` for a pure route choice that
must retry when a newer settings change wins before route settlement. See
[Change workflow settings during a run](2026-08-25-workflow-settings.md).

Function actions receive `WorkflowActionContext`, which adds
`publishUpdate(update)`. Other callbacks keep the read-only node context.

## Durable runs, parking, and resume

Every run enters one global SQLite queue. One package-owned server claims runs,
renews live claims, commits state, and supervises one child process for each
active run generation. The extension is a local server client. It does not run
the workflow engine or workflow definitions.

The server starts on demand when a Pi or CLI client needs it. These commands
control the same user-level server for all projects:

```bash
pi-workflows server start
pi-workflows server status
pi-workflows server stop
pi-workflows server run
```

`server run` stays attached. The other commands start, inspect, or stop the
on-demand process. No command installs an operating-system service.

The extension, CLI, and `piw` use the same version-1 client protocol over a Unix socket or Windows named pipe. The server sends byte-bounded run-list and run-view pages. Clients collect a complete run list for one revision and reject stale run pages whose cursor or revision no longer matches. A run view's `revision` is the presentation cursor; `runRevision` is the execution resource revision used by restart and other exact execution commands. The server reads only the selected history ranges and reuses an unchanged subscribed view after a lightweight revision check. It waits for a slow socket to drain and removes every subscription when its client unsubscribes. Large values stay available through verified content chunks. Server-generated aggregate values are saved and linked to the run before the server advertises them.

A runner verifies the root and all mounted source identities before it loads
workflow modules. It then checks the resolved mounted-source map and executes
from committed state through a server-backed store. Resume reads return only
`WorkflowRunState`. Session messages, tool results, activity
events, viewer history, settings, follow-ups, and other inspection data stay in
server-owned SQLite. If one required result exceeds the runner protocol frame,
the server returns a digest-bound reference and the runner reads and verifies it
in bounded parts. A source mismatch parks the
run with `workflowSourceChanged`; normal scheduling does not retry it. Restore
the recorded source and explicitly resume, or cancel the run. A headless Pi
child uses its own registered process group. The runner stops that group on
normal completion, and the server reaps it if the runner exits first. If the
runner stops for another recoverable reason, pure work can run again. A
protected write checks and renews the exact live token and generation in one
transaction. An expired or replaced owner cannot revive itself.

Interactive agent and assistant-message steps do not run headlessly for a Pi
session. The runner commits a durable interaction request and parks. The origin
session presents the request through documented Pi APIs and submits the exact
request, node, attempt, and revision. The server records submitted output as
provisional. A new supervised runner loads the workflow and runs its `validate`
function before the server accepts the submission. A validation error leaves the
same request pending and returns the error to the model. Closing Pi leaves that
request pending; reopening the same session adopts the existing session entry
or presents it once. Step prompts, protected decisions, notifications, terminal
results, and follow-ups use the server-owned `workflow_messages` table and one
extension sender. Initial and resumed prompts are the same step-message
kind with different display reasons. A terminal workflow message becomes
eligible only after the terminal outcome is committed. A resource manager child
without an origin session can use a supervised headless `pi --mode rpc` child
for structured agent steps.

Pause stops the runner and parks at the last durable boundary. Resume takes a
new generation. Cancellation can stop a live runner or atomically claim and
cancel an expired running row. Resume refuses changed workflow source.

## Node types

### agent

Sends a prompt to the model. `expectedOutput` selects one of two output forms.

While the workflow-owned Pi turn or supervised runner is active, the visible run status is
`running`. The durable agent request can still be waiting for its result. With no active work,
a pending request displays `waiting`. Pause, ambiguity, and terminal outcomes retain precedence.
The exact pending request determines response controls in both running and waiting displays:
agent steps retain `submit` and `update`, checkpoints retain `answer`, and protected decisions
retain only their human response path. Ordinary chat is not workflow activity.

`allowedTools` optionally restricts a step to exact tool names, for example `allowedTools: ["read", "grep", "find", "ls"]`. Omit it for the normal tool set; use `[]` to permit only matching workflow `submit` and `update` calls. Do not include `workflow` in the list. Restrictions remain in composed child graphs, definition snapshots, and the durable step contract. Changing them requires a new run under the fixed-definition rule.

The origin Pi extension blocks other calls through public `tool_call` before execution, including while delivery acknowledgment is pending. It applies the restriction only to the workflow-owned running turn, not later ordinary chat. This is an exact tool allowlist, not a filesystem sandbox: authors must trust the implementations of the tools they allow. No shell is implicitly read-only.

An executor must declare `enforcesToolAllowlist: true` only when it enforces that contract before every tool call. The current headless RPC executor does not support restricted steps. The engine rejects such a step before calling that executor rather than silently dropping its restriction; use an origin Pi session. Scripted executors that run no model tools can declare support.

The existing string form waits for a `workflow submit` call:

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

The assistant-message form waits for one normal visible response and uses its
exact text as the node output:

```typescript
agent({
  prompt: ({ outputs }) => `Explain this plainly: ${JSON.stringify(outputs.review)}`,
  expectedOutput: assistantMessage(),
});
```

`assistantMessage()` has no default character limit. Authors can opt in with
`assistantMessage({ maxChars: 2_000 })`. It cannot be combined with `validate`
because an invalid response is already visible and must not be retried.

For submitted output, the engine appends the existing workflow-tool contract.
The server checks the durable transport identifiers, stores a `validating`
submission, and starts a supervised runner. In that runner, the output passes
through tolerant JSON normalization and then `validate`. The tool reports
success only after this check accepts the output. If the tool turn is aborted,
the client stops waiting but does not cancel the durable server command. A retry
uses a new transport request ID with the same durable submission identity and
adopts the stored result. Rejected submissions return
the validation error and can retry in the same step. When a late submission loses
to the active-time limit, the error says that the request expired only when the
saved timeout event names that exact request. Other revision conflicts keep the
generic conflict error. If the model settles
without submitting, the server sends up to two reminders for the exact pending
request. It waits for the owned turn to settle and does not remind during validation,
pause, or another active turn. If both reminders end without an accepted result,
the run fails with `missingSubmission`. Accepted results remain saved. The timeout
remains active during each reported model turn, and cancellation remains active throughout.
For assistant-message output, the engine appends a normal-response contract,
waits for `agent_settled`, rejects empty, failed, aborted, or tool-only results,
and never suppresses the visible text. Timeout and cancellation abort either
form's active Pi turn.

`timeoutMs` can be a finite positive number, `null`, or a function of the normal
node context that returns either value. Omit it to use the 15-minute engine
default. The limit counts active node execution. For an origin-session agent
node, it counts reported model-turn time from an active connected Pi session.
It excludes message delivery, waiting, paused time, disconnects, and server downtime. Set it to `null` to disable only this deadline; cancellation,
parking, claim loss, shutdown, and the node's abort signal still work. A timeout
function can use prepared outputs to select a policy for this run. It has 30
seconds to return. Computed timeout functions are runtime code, so definition
snapshots omit them. Snapshots keep fixed numbers and fixed `null` values.

### Terminal recovery and fresh restarts

Terminal messages return responsibility to the regular Pi model after execution
ends. The model checks whether the user's task is complete, explains the outcome,
and can correct mistakes within existing permission. Cancellation is different:
its terminal message is passive and stops automatic continuation.

The collapsed terminal card shows the workflow, status, and error. Expand it to
read the full result and recovery instructions. An explicit `assistantMessage()`
node can still provide a workflow-specific explanation. The terminal turn should
refer to that explanation rather than repeat it. `presentationPrompt` is not supported.
Autoimplement prepares its structured result, runs an explicit summary node,
and then returns the prepared result. A failed summary cannot erase accepted work.

The extension submits visible assistant text and records the end of a workflow
turn at `agent_settled`. `agent_end` records only low-level activity. Automatic Pi
retries keep the same unsettled turn and cannot submit an unfinished response.
Branch evidence must identify the exact workflow message before reconnect can
adopt its turn.

A fresh restart targets `runId` plus `expectedRevision`. It starts from the original
input in a new run and does not copy old steps, changed settings, decisions, or
effects. The workflow server rejects a stale revision or unsettled external effects before
reserving work. An identical retry adopts the same child run.

An owned terminal turn can start or restart work within existing user permission.
Each terminal handoff can create only one recovery run. Repeated commands must
adopt that run, even after it finishes. Both commands count toward a shared limit
of two automatic launches per recovery chain. Each terminal turn has a 15-minute active-time limit. Disconnects and server
downtime do not consume that time. Saved launch counts and active elapsed time survive
reconnects. An interrupted recovery turn stops with a visible blocker rather than
silently replaying work. A later explicit user request can authorize new work.

Queued follow-ups wait for the source's terminal turn to finish successfully. Another
workflow started during recovery must also release the session before a follow-up
can run. Cancellation or interrupted recovery keeps those follow-ups from running
automatically. These rules implement the [workflow recovery plan](2026-09-08-workflow-recovery-plan.md).

### compute

Runs a TypeScript function inline. Use it for pure data shaping.

```typescript
compute({ run: ({ outputs }) => ({ merged: { ...outputs } }) });
```

### notify

Queues a durable plain-text message for the Pi session that started the run.
The runner does not write the message into its own conversation. A standalone
server can execute this node, and the message still waits for the origin session.

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
ResourceManager child workflows are detached and must report through their
managed resource instead.

### action

Performs managed work. Every function action and shell action must declare how
the server recovers if the runner exits after the external operation but before
it saves a receipt.

Use `idempotentEffect(type)` only when the operation has a stable external
idempotency key or a read-back check that makes another attempt safe:

```typescript
import { action, idempotentEffect } from "@osolmaz/pi-workflows";

action({
  effect: idempotentEffect("preview.deploy"),
  run: async ({ input }) => await deployPreview(input),
});
```

Use `manualEffect(type)` when the external system cannot prove whether an
uncertain request applied. An uncertain runner exit marks that effect
`ambiguous`, parks the run, and requires explicit operator recovery. The server
does not retry it automatically.

The shell form (`shell` is a synonym that requires `exec`) runs a command owned
by the workflow definition, with a timeout and captured output:

```typescript
shell({
  effect: idempotentEffect("repository.status"),
  exec: () => ({
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
  effect: idempotentEffect("dataset.process"),
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

The server reserves the effect before it lets the action run. The engine creates
the internal key from the run ID, effect type, full compiled node path, and node
visit number. Workflow code does not supply that key. Two included workflows
can use the same local node name without sharing an effect. A repeated key with
the same request adopts the durable record; the same key with another request
is a conflict. A normal caught error settles the attempt as rejected. After an
uncertain process exit, an idempotent effect returns to pending for retry, while
a manual effect becomes ambiguous. This is not an exactly-once claim.

### checkpoint

Creates a durable input request and parks the run. The run is waiting, not
terminal. Its input, settings, history, and active attempt stay unchanged.
The optional callback creates the request content once. It does not complete
the node.

An answer completes that exact request in the same run. The answer becomes the
checkpoint output, and execution follows its outgoing edge. A checkpoint at the
end of the graph completes the run with its answer. Each answered checkpoint
counts once toward `maxSteps`. Invalid responses do not create another run or
change another request.

```typescript
checkpoint({
  summary: "human decides how to proceed",
  run: ({ outputs }) => outputs.reconcile, // optional request content; defaults to { summary }
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

The waiting run stores the request and asks every channel configured for the audience. The structured `subject` remains machine data. Channels receive the normalized `presentation`, title, choices, input prompts, and deadline policy. The first valid verified human answer wins. When `onTimeout` is present and no human answer wins before the saved deadline, the server accepts the declared response with `timeout` provenance and resumes the same run. This policy can continue without a configured channel. The original input remains unchanged, and the resolved response becomes the checkpoint output. `humanDecisionEdge()` provides exhaustive routing for the choices.

The model-facing workflow tool cannot answer a protected human decision. The origin Pi session displays the request without starting a model turn. A person uses `/workflow answer <requestId> <response>` to send the answer through the server-owned path. Ordinary checkpoints can also use the model-facing `answer` action.

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

Use `controlLoop()` when one decision point must send work to several branches
that return after one bounded action. The helper returns normal switch and
return edges. It adds no node type or runtime state. The workflow still owns
observation, decision checks, progress checks, terminal checks, and failure
handling. See [Control loops](CONTROL_LOOPS.md).

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

- `list` for discovered workflow names and sources;
- `start` with a workflow name or path and structured input;
- `status` for the active run or a supplied run ID;
- `pause` and `resume` for the active session run;
- `cancel` for the active run or a supplied run ID;
- `answer` with an exact checkpoint `requestId` and input;
- `update` with an exact agent `requestId` and a non-completing update;
- `submit` with an exact agent `requestId` and its output.

A direct user request to continue or resume the active workflow maps to
`resume` immediately. The model does not call `status` instead of `resume` or
use it as a prerequisite. An already active run adopts the resume request. A
pending interaction on a paused run remains the same durable request and resumes
without a runner. Other paused or parked work gets a new claim generation and runner.
With no resumable run, the server rejects the request.

The origin Pi session shows its active run in the workflow widget. The extension
renders each bounded server session snapshot immediately. It does not wait for
complete step, trace, session, settings, follow-up, or update history, and it
does not hydrate large run content for this compact view. Detailed clients load
that data through the shared protocol only when they need it. The snapshot
carries a bounded window of node rows. Scrolling past an edge of that window
moves the live session subscription with `view.session.window`, so the widget
shows the adjacent window instead of the complete topology. A window request
that fails stays retryable, and the widget keeps the loaded window until the
next one arrives. `Shift+Up` and
`Shift+Down` scroll the widget by default; see
[Widget scroll shortcuts](#widget-scroll-shortcuts) to remap or remove them. A
sent step message is open only while its
interaction is pending and its run is not paused. Because public `agent_start`
has no message payload, any model turn that starts in that state is workflow
work. If Escape ends that turn with Pi's public `aborted` stop reason, one
turn-end report atomically sets the run pause and cancels the interaction's
pending step messages. A turn that starts while the run is paused does not bind
to the workflow. The paused run does not accept updates, submissions, or
decision answers until `resume`.

`status` reports the durable queue projection. A server command succeeds only
after its transaction commits. The protocol stores request fingerprints and
receipts, so an exact duplicate adopts the committed result and conflicting
reuse is rejected.

The normal extension offers these actions through the origin Pi session. The
headless RPC bridge offers only `update` and `submit`, so a resource manager child
cannot recursively control unrelated runs. ResourceManager code can use its narrow
`ctx.workflows` methods for child runs, settings, and follow-up records. Those
methods also commit through the global server.

### Widget scroll shortcuts

The widget registers `Shift+Up` and `Shift+Down` by default. An optional
`shortcuts.json` file in the extension config directory changes those keys
without patching the package. The default directory is `~/.config/pi-workflows`,
where `/workflow-channel` also keeps its `channels.json`; the
`PI_WORKFLOWS_CONFIG_DIR` environment variable moves both files.

```json
{
  "schema": "pi-workflows.shortcuts.v1",
  "scrollUp": "ctrl+alt+up",
  "scrollDown": "ctrl+alt+down"
}
```

Each field takes one Pi key id: modifiers from `ctrl`, `shift`, `alt`, and
`super`, joined with `+` before a key name such as `up`, `pageUp`, `j`, or `f5`.
Modifier order and letter case do not matter. Rules:

- Without the file, both directions keep the default keys.
- An omitted field keeps its default. `null` leaves that direction
  unregistered, so both `null` values turn keyboard scrolling off.
- `ctrl+shift+r` stays reserved for `/piw`.
- When both fields resolve to the same key, only the scroll-up direction stays
  registered.
- A file that is unreadable, is not valid JSON, or lacks the `pi-workflows.shortcuts.v1`
  schema registers neither direction and warns once per session with the file
  path.
- A value that is not a documented `modifier+key` id, or a key reserved for
  `/piw`, leaves that one direction unregistered and warns once with the value.
  The other direction keeps its resolved key.

The widget shows the keys in effect in its controls line. A pair that shares its
modifiers and uses `up` and `down` renders as one label, which for the keys above
is `ctrl+alt+↑/↓ scroll`, and the default pair renders as `shift+↑/↓ scroll`.
Other pairs are listed in full, for example `ctrl+up · alt+down`. The segment is
omitted when both directions are off. The extension reads the file when it
loads, so run `/reload` after a change. Scrolling down at the last loaded node
asks the server for the next node window, and scrolling up at the first loaded
node asks for the previous one.

The reason this file exists is another package that also uses `shift+up` or
`shift+down`, such as `pi-background-tasks`. Remap or remove those two keys here
and that package keeps them, so Pi reports no conflict that names pi-workflows.
Turning both directions off leaves hidden rows out of keyboard reach: the
controls line keeps showing how many rows are hidden, and `/piw` opens the whole
run in the viewer. A remapped combination can also fail to reach Pi, for example
a `super` key in a terminal that does not report the modifier, so prefer keys
that the terminal sends reliably.

### Built-in plain summary

The built-in `plain-summary` workflow turns supplied structured data into one
normal assistant message. Its input has `source`, `purpose`, optional
`mustInclude`, optional `maxChars`, optional `maxSentences`, and `format` set to
`paragraphs`, `bullets`, or `mixed`. The workflow applies no character or
sentence limit by default. A caller can request either limit with a positive
integer. `assistantMessage()` itself also has no default limit.

The summarizer uses only the supplied source, treats instructions inside that
source as data, keeps required points, and returns the same text as its
`completed` result. The source enters the normal model prompt and Pi session,
so callers must pass only data that is suitable for that conversation. It has no notify node or final presentation prompt, so
including it in another workflow produces one readable assistant response
before the parent continues.

### Built-in planning and implementation

The built-in `autoplan` workflow first asks the model to capture everything the
user has instructed for the intended purpose in the available conversation
context. Relevant earlier and queued user messages must keep their wording and
order. The model returns one `originalUserInstructions` string and must not
summarize, rewrite, explain, label, omit, or add instructions. Validation checks
only that the string is not empty and preserves the accepted text without
normalization. Every later Autoplan agent prompt includes this string as the
authoritative user instructions. Structured run input such as scope,
constraints, a previous plan, and new evidence remains supplemental. Ready and
blocked final outputs include the same string for audit and downstream use.

Autoplan then records two through four practical candidates, describes the ideal
separately, chooses one option, records a rejection reason for every other
explicit option, and writes a detailed plan. It includes `plain-summary` to show
the chosen plan, its main steps, and the rejected options in one assistant
message without a character or sentence limit. The detailed records remain in
the run bundle. See
[Capture the user's complete intent in Autoplan](plans/2026-08-25-autoplan-user-intent-capture-plan.md)
for the selected design and implementation plan.

The standalone `autodoc` workflow finds an already selected plan, records it in
canonical documentation, and never devises or implements. It prepares a safe
workspace only when documentation must change. Program actions run candidate
checks, compare eligible failures with the base revision in a temporary
detached worktree, and keep matching baseline failures visible without blocking
the current change. The built-in `autoimplement` workflow finds a clear existing
plan from explicit input, conversation context, or referenced canonical
documents. One central `decide` controller chooses the next safe branch from
current evidence. An explicit plan bypasses autodoc only when a
current-document receipt carries its matching plan digest; otherwise autodoc
inspects and adopts or updates the canonical documents. Later invalidating
evidence returns to `autoplan` followed by `autodoc`.

The built-in `plan-approval` workflow offers `continue`, `stop`, and exact-text `replan` exits. Its shared policy uses `auto`, `required`, or `skip` mode. Omitted policy defaults to `auto`: ask audience `operator`, then continue with the exact plan after 10 minutes without an answer. Required mode waits for a human. Skip mode creates no decision. Stop and replan always require a human answer.

The internal plan-change workflow composes Autoplan, Autodoc, plan approval, and bounded replanning. Autoimplement and Monitor use it whenever they create or change a plan. Existing supplied or discovered plans bypass the gate. A plan selected by Monitor enters Autoimplement without another decision for the same digest.

Autoimplement runs independent commands through bounded command batches. A batch is an ordinary function action that calls the public `runCommandBatch` helper. Each command has a stable ID, executable, arguments, absolute working directory, timeout, and output limit. Results stay separate and return in input order. One command uses the same path with concurrency one.

Autoimplement prepares the workspace before its first edit-capable node. `workspaceMode` accepts `auto`, `branch`, `worktree`, or `defaultBranch`. Auto mode adopts a current task branch, creates a model-named branch from a clean default branch, or creates a model-named standard sibling worktree when the default checkout has existing work. Program actions validate and apply names. Direct default-branch work requires explicit authority and does not imply commit, push, merge, or release authority. Every later stage uses the prepared absolute path.

Autoimplement gives `implement` and the shared verifier's `semanticRepair` the same named eight-hour deadline. The engine default stays unchanged. Each branch performs one bounded unit of work and returns to observation after expected success, failure, or timeout. The controller can choose plan discovery, workspace preparation, documentation, implementation, repair, verification, publication, review, P2 work, comment handling, CI, delivery, redesign, completion, or blocked. Cancellation remains immediate and terminal. Unexpected parser, graph, and invariant errors still fail the run.

Local verification uses one shared change-verification planner. A caller can supply exact `verificationChecks` and explicit `verificationUntested` work when the prepared workspace is already known. Otherwise the planner uses a 30-minute active-time limit. Its prompt and validator use the same command-safety lists, including the rule that all Git commands are forbidden. One rejection returns all independent check errors in stable order, and no command starts before acceptance. Failed or timed-out planning returns a normal blocked child result to the Autoimplement controller. Candidate-only and remote-only checks remain explicit without invented evidence.

Direct program actions run candidate checks and read-only base-eligible checks with the same command, arguments, timeout, and output limit. Results separate related, unrelated, fixed-baseline, unknown, and untested findings. Matching base failures do not block the candidate. Related failures enter a two-attempt mechanical or semantic repair loop. Unknown or incomplete evidence needs bounded judgment, and truncated, timed-out, cancelled, or spawn-failed output cannot pass.

A failed or timed-out semantic repair enters `reconcileRepair`, not terminal failure. The recovery agent can use only `read`, `grep`, `find`, `ls`, `list_sessions`, and its exact workflow submit/update calls. Shells, edits, process input, process termination, and unrelated workflow controls are blocked. It inspects saved edits, receipts, and command sessions without changing repository contents. If a command still needs termination, it reports that exact blocker instead of receiving broader tools. It can verify completed work, request a bounded retry, or report a blocker. Verification or retry requires evidence that the previous commands have stopped. Failed and timed-out attempts count against the existing two-attempt repair bound. Intentional cancellation stays terminal. If reconciliation fails, times out, or cannot establish command state, it returns a blocker rather than starting more work.

The extension aborts only the cancelled workflow-owned Pi turn through public `ctx.abort()`. The server retains that turn until Pi confirms settlement or an idle branch observation proves it lost. The next prompt cannot run before that boundary. Aborting Pi does not prove that third-party detached commands stopped: reconciliation must inspect those commands through their existing owner tools. There is no hidden model retry or new process-control protocol.

Autoimplement uses batches for pi-reviewer and pending CI watches. It keeps model turns, fixes, pushes, comment changes, merges, and releases in their existing order. Reviewer commands are tied to the repository, base branch, pushed head, and relevant dependency fingerprint. A later review round includes only repositories whose head or dependency fingerprint changed. P0 or P1 work still requires another review. P2-only work can be addressed and verified without another reviewer run only because of that P2 work.

Autoimplement inspects every pull request before it waits for CI. It accepts only supported pending `gh pr checks --watch` or `gh run watch` descriptors and binds each one to the validated pull request as `gh pr checks <PR URL> --watch`. Repository and pull-request overrides are rejected. One watch lasts at most five minutes. A failed or timed-out watch affects only its pull request. When checks remain pending, the model runs more useful local tests before checking CI again. Autoimplement does not invent an ETA.

The action abort signal stops active command process groups and prevents queued commands from starting. Accepted outputs use immutable events and content-addressed blobs. An interrupted unaccepted batch runs again because batch commands are read-only or isolated local checks. Progress updates contain metadata only and never control routing. Truncated reviewer or CI output cannot count as clean. See [Run independent commands in bounded batches](plans/2026-08-20-bounded-command-batches-plan.md) for the complete contract and implementation plan.

A branch blocker does not end Autoimplement by itself. The controller can repair, retry, redesign, move to another safe branch, or return blocked. A blocked decision requires current evidence and at least one checked alternative. The loop permits at most 40 accepted decisions and removes a route after three consecutive returns with the same stable facts. Changed evidence resets that route count. If the controller itself fails or times out three times without an accepted decision, Autoimplement returns a normal blocked result. These limits prevent blind retries while allowing real progress.

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

Sanity Check revision 4 creates child sessions directly through the documented Pi SDK. A private built-in runner uses `createAgentSession` with `SessionManager.inMemory`, one independent context per child, and only the verified built-in `read`, `grep`, `find`, and `ls` tools. Child sessions load no skills, prompt templates, themes, or context files. They create no Pi session file.

The parent Pi process keeps its normal configured extensions enabled. The child runner resolves enabled user extension paths, excludes Pi Workflows and project extensions by default, and preflights the remaining paths without creating a session. It admits only the extension that registers the exact configured provider, plus any behavior extension on an explicit private allowlist. It rejects competing provider owners, workflow tools or commands, and extensions that replace a built-in read-only tool. The admitted paths are frozen for the group, and each child loads only those explicit paths without a second discovery pass.

Each child owns a separate `ModelRuntime`, provider instance, extension runtime, resource loader, and in-memory session. The runner loads validated model and ordinary credential snapshots into per-child in-memory stores without writing them back. A provider extension uses its existing provider-owned credential store in place; Pi Workflows does not copy, print, migrate, or persist those credentials.

A complete explicit provider, model, and thinking override wins. Otherwise, the runner uses the configured process defaults. It passes the exact cached model and thinking level to the child, then verifies the actual provider, model, thinking level, authentication, extension state, active tools, and tool sources before prompting. A missing or different dispatch is terminal. The runner never silently falls back to OpenRouter, Kimi, a local model, or another provider or model. It does not promise to inherit a model selected temporarily in the origin Pi TUI.

Children do not receive the `workflow` tool, workflow commands, parent run identifiers, update channels, or workflow callbacks. Prompts that invoke extension slash commands are rejected. The parent Sanity Check action remains the only workflow owner. These controls block normal child model and extension bindings from inspecting or changing workflow state. Extensions still run as trusted code in the parent Node process, so this is not an OS sandbox against direct filesystem or network access.

Only bounded final assistant text and safe operational facts leave a live child session. Pi Workflows does not persist child prompts, reasoning, intermediate messages, tool arguments, tool results, message history, credentials, or extension-private state. Timeout and cancellation abort and settle active work before the runner disposes the session, shuts down extensions, and releases provider resources.

The workflow publishes aggregate and per-agent `pi-workflows.progress.v1` tracks under `agents/review/*` and `agents/verification/*`. Progress contains role, the verified actual model when known, state, elapsed facts, and safe phases such as `thinking` or `tool: read`. The Pi widget shows the aggregate plus failed and active children within its ten-line limit. `piw` shows every durable child track and its samples. Both views use existing progress records, so no child workflow run or new persisted schema is needed.

Serial mode still uses two child sessions, and parallel mode still uses five. Review prompts, review areas, strict result validation, verdicts, and progress stay unchanged. After verification, an assistant-message agent shows the full bounded report verbatim. A mismatch stops before summary generation. The graph then includes `plain-summary`, which shows a short plain-language explanation with the verdict and the most important next action. The detailed response always settles before the summary starts. A final compute node returns the original strict result, so presentation cannot change the verdict. Sanity Check creates no extra terminal model turn.

The CLI, JSON or RPC stream, temporary prompt file, standard-output cap, subprocess fallback, shared child runtime, and blanket child-extension ban are not retained. See [the Sanity Check plan](plans/2026-08-21-sanity-check-plan.md) for the selected implementation and test boundaries.

### Built-in monitor

The built-in `monitor` workflow turns a plain request to finish and monitor an
authorized goal into one looping workflow run. It accepts only `task`,
`stopWhen`, `everyMinutes`, and `maxChecks`:

```json
{
  "task": "Finish pull request 123 within the recorded repository and delivery authority.",
  "stopWhen": "The pull request is merged or safe continuation is blocked.",
  "everyMinutes": 30
}
```

The first `observe` step runs immediately and is read-only. It inspects the real
target with normal tools and chooses `wait`, `act`, or `stop`. `wait` means that
useful target work is moving or an external event must finish. `act` states one
safe action that existing authority permits. `stop` means that the goal is
complete or cannot continue safely.

An `advance` or `recover` action runs directly in a separate normal-tools step.
A `repair` action composes the shared plan-change workflow and Autoimplement.
Monitor observes again immediately after every action. It stops instead of
repeating a completed repair when the same stable failure and target state
return. The timer is reachable only from `wait`.

`everyMinutes` defaults to 30. Every accepted observation provides one concise
report that separates Monitor state, goal state, and target work state. The
runtime queues that report as a workflow notification with `triggerTurn:
false`, so it does not cause an assistant reply. An observation can also provide
independent progress tracks. The regular Pi model observes the target and
submits those facts. Pi Workflows validates counts and calculates rates,
confidence, and ETA deterministically. The target does not need a Pi Workflows
dependency or reporting protocol.

Intervals must be whole minutes from 1 through 1,440. When `stopWhen` is
omitted, the monitor stops only after an explicit user request. `maxChecks`
defaults to the disclosed observation safety limit of 1,000 and cannot exceed
it. Callers omit `maxChecks` unless the user requests a fixed count. Unknown
fields fail before a run is created. See [MONITOR.md](MONITOR.md) for the
observation, action, and progress schemas.

The interval uses the existing shell action to launch the current Node
executable with a timer. This works on every platform supported by Pi. The node
and command timeouts are higher than the maximum interval. Cancelling the
workflow aborts the timer process immediately. If the owning Pi process or
standalone server stops during the wait, normal parking rules abort the shell node
and resume later by running that wait again from the beginning.

A monitor uses the session's single active workflow slot. It does not provide
cron syntax, calendar scheduling, OS notifications, or a background service.

## Runner capacity

Workflow runs and resource-manager reconciles share one workflow server scheduler. Start, restart, resume, result validation, and timeout recovery all wait for the same runner capacity. The default is four execution runners; set `PI_WORKFLOWS_MAX_RUNNERS` before starting the workflow server to change it. Waiting and paused requests keep their durable identity without occupying a runner. A submitted candidate stays durable until a runner can validate it. Cancellation does not wait for capacity.

One unfinished interactive run reserves its origin Pi session, including while waiting or paused. Independent headless work does not reserve that session.

## The step contract

Every `agent` prompt ends with a step contract block naming the workflow, the
step id, attempt id, durable request id, and expected output shape:

```
---
Workflow step contract (workflow: autoimplement, step: review, attempt: 6f9d…)

This step is your work now. Nothing else will start it, so do not sleep or poll for another step.
Complete this step by calling the `workflow` tool exactly once with:
{"action": "submit", "requestId": "request-EXACT_ID_FROM_CONTRACT", "output": <your result>}
Expected output: { "route": "clean" | "issues_found", "reason": "short justification" }
The step is complete only after the workflow tool accepts the output.
If the tool reports a validation error, correct the output and call it again.
```

The `workflow` tool uses `{ action: "submit", requestId, output }` for step
results. The request binds one run and one attempt. Loops and retries get new
request IDs; they cannot accept an earlier request's output. A missing, stale,
wrong-kind, or other-session request is rejected, as is output that fails
`validate`. The server never selects the oldest pending request.
Acceptance resolves the step and the engine advances. In an interactive Pi
session, each agent prompt arrives as a `pi-workflows-step` custom message
with `triggerTurn: true`. The coordinator sends a step only while Pi is idle, so
a pending step starts a new model turn and the model ends its current turn
instead of sleeping or polling for it. The model receives the complete prompt,
while the conversation shows a compact workflow and node card. Expanding tool
output with Ctrl+O shows the exact contract and full prompt. Step messages with
reason `resumed` use the same card and keep the active attempt ID.

Headless RPC execution receives the same complete prompt without TUI metadata.
Workflow notifications use a custom message with `triggerTurn: false`, so a
notification does not start an assistant response. Step prompts, decisions, notifications, terminal results, and follow-ups use the same saved workflow-message contract and extension coordinator. Initial and resumed prompts use the same step kind. See
[Workflow messages in Pi](WORKFLOW_STEP_MESSAGES.md) and the approved
[workflow-message restoration plan](2026-09-02-unify-workflow-messages-plan.md).

## Visible responses

Workflow nodes normally produce structured values for routing and persistence.
When a person must receive normal prose, use an agent node with
`expectedOutput: assistantMessage()`. The runner parks and records the exact
step request. The origin Pi session starts the model turn, and the visible
assistant text becomes the node output after the turn settles.

The request keeps its node and attempt ID across Pi reload. The extension first
looks for an existing session entry with the durable request ID. It inserts a
new visible message only when no adopted entry exists. A repeated submission
returns its stored receipt.

A headless resource manager child cannot produce a visible assistant message without
an approved origin-session binding. Use structured agent output for detached
work. A terminal run creates its own terminal workflow message through the shared coordinator only after the outcome is durable.

## Runtime behavior

Runs execute one node at a time. Runners propose narrow transitions; the workflow server
validates and commits them before execution moves on. A start must follow the
accepted graph route. A completed run must return its accepted final node output.
Runners cannot skip a checkpoint, rewrite an active attempt's start, or replace
the full saved run state. Defaults worth knowing:

- Node timeout is 15 minutes unless the node sets `timeoutMs` to a positive
  number or context callback. A timed-out node has outcome `timed_out` and can
  be routed with `$result.outcome`. A timed-out agent node also aborts its Pi
  turn, and late output for that attempt is rejected. Interactive runs save the
  resolved budget before they park. The workflow server records active intervals with a
  monotonic clock. Message delivery, waiting, pauses, disconnects, wall-clock
  changes, and server downtime do not consume the limit. Recovery keeps the last
  saved elapsed-time sample without rewriting the attempt's start timestamp.
  Human decision deadlines remain absolute wall-clock deadlines.
- `maxSteps` (workflow-level, default 100) bounds loops built from cycles in
  the graph.
- `/workflow pause` atomically parks the run with `paused: true`, stores the
  receipt, and fences the runner before process-group shutdown. `/workflow
resume` takes a new generation and reruns only work after the last durable
  boundary.
- The server tells each runner to `start`, `resume`, or `restart`.
  An answered checkpoint resumes its exact attempt in the same run. An explicit
  restart creates a new child run at the workflow start. The model-facing result
  returns the child as `runId`, the terminal source as `parentRunId`, and the
  saved `restartNumber`, and tells the model to continue with the child.
- Resuming an active run adopts the existing work. Duplicate start, control,
  update, and submission messages return their stored receipts.
- A start is committed as `queued` with its final run ID before the command
  reports success. Cancellation can use that run ID before its scheduled runner
  starts. Active cancellation commits its terminal state and command receipt
  together before runner shutdown. It cancels effects that have not started and
  marks applying effects ambiguous for explicit recovery. `workflow status` and
  `workflow cancel` can use the run ID immediately.
- One interactive workflow request is presented per Pi session. Other requests
  remain durable and ordered.
- Each protected write renews only its exact live token and generation in the
  same transaction. Claim loss does not write a failed run event.
- An uncommitted pure or idempotent node can run again after a runner crash. An
  uncertain manual effect parks as ambiguous and never retries automatically.
  If a ready runner exits before the saved run revision advances, the server parks
  the run with `runnerNoProgress`. The scheduler does not claim it again until
  an operator explicitly resumes or cancels it.
- Server status reports safe counts and timestamps. It does not report session
  IDs, project paths, prompts, payloads, tokens, process IDs, or credentials.

## Run history retention

Pi Workflows keeps a terminal root run and all its explicit restart descendants for 30 days from `finished_at`. The server can remove the tree after that point only when every descendant is terminal and no protected work or outside reference remains.

Protected work includes waiting or parked runs, live queue rows, pending workflow messages, open workflow turns, pending interactions or decisions, recording session segments, queued follow-ups, active leases, unsettled effects, controller ownership, active runner content, resumable checkpoints, and undelivered terminal results.

The server checks for cleanup after startup recovery and after workflow runners exit. It also schedules a daily check after each completed sweep. Cleanup runs only while normal server work is idle. One process completes at most one sweep in 24 hours. If work appears, cleanup stops between complete root trees. The next idle lifecycle trigger or a five-minute idle retry continues it.

Automatic cleanup does not create a backup. The explicit `pi-workflows state prune` apply command still requires a new absolute verified backup. Both paths use the same eligibility, deletion, and blob-reference rules.

Deleting a run tree removes its unreferenced blobs. SQLite can reuse those pages immediately. Automatic `VACUUM` runs only while the server remains idle, at least 64 MiB is reclaimable, and at least 20 percent of pages are free. A failed or skipped compaction does not restore deleted history or make free pages unusable.

Retained runs keep complete resume and viewer behavior through the existing bounded reads. An expired deleted run no longer appears in lists and a direct view returns not found. Pi session history is not changed.

This is a history policy, not a hard disk limit. Recent or protected runs can be large. See [SQLite state](SQLITE_STATE.md) and [the automatic state-retention plan](plans/2026-09-04-automatic-state-retention-plan.md) for the full safety and test contract.

## Workflows started by resource managers

A resource manager can start a workflow as a finite child job with `ctx.workflows.ensure()`. The request key is stable across reconciliation passes, and the input fingerprint prevents one key from being reused for different work.

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

Child workflow completion queues the parent resource again. The global server runs the child through the same queue and supervised runner model as any other run. A server or runner crash resumes the existing durable run when its committed effect state makes that safe. Consequential external mutations belong in the workflow or resource manager effect API; an uncertain result stops for explicit recovery.

See [RESOURCE_MANAGERS.md](RESOURCE_MANAGERS.md) for resource manager definitions and the full recovery contract.

## Using the engine outside Pi

The engine remains Pi-agnostic. `WorkflowEngine` takes any `AgentStepExecutor`,
so tests and custom library integrations can script agent steps. The package's
production extension does not use this as a selectable embedded runtime; it
always sends runs to the global server.

```typescript
import { WorkflowEngine, type AgentStepExecutor } from "@osolmaz/pi-workflows";

const executor: AgentStepExecutor = {
  async runAgentStep(request) {
    const accepted = await request.accept({ answer: "42" });
    if (!accepted.ok) throw new Error(accepted.error);
    return { output: accepted.value };
  },
};

const engine = new WorkflowEngine({
  executor,
  databasePath: "/tmp/workflow-state.sqlite",
});
const { state } = await engine.run(workflow, { task: "..." });
```

## Test the installed package

The installed-package end-to-end test packs this repository and installs the
archive with production dependencies in a temporary consumer project. It then
starts the repository-pinned base Pi with only that Pi Workflows installation.
The test checks command isolation, server startup, widget and status changes,
pause, resume, completion, and `piw <runId> --once` output.

Run the deterministic phase without a model call:

```bash
npm run test:e2e:live -- --runtime-only
```

A real-model phase is manual. Supply the exact Pi provider and model as separate
values. The runner does not select a default or accept model fallback:

```bash
npm run test:e2e:live -- \
  --provider openai \
  --model gpt-5.6-luna
```

For providers that reserve credit against the requested output allowance, pass
`--max-output-tokens N` with the generated profile. OpenRouter can reject a
small smoke test when the model's catalog default requests hundreds of thousands
of output tokens. This option changes only the exact built-in model's `maxTokens`
through Pi's documented `modelOverrides`. It does not change the provider, model
ID, API, endpoint, or credentials. The test verifies and reports the allowance,
keeps the complete response, and fails immediately on a provider error.

```bash
npm run test:e2e:live -- \
  --provider openrouter \
  --model deepseek/deepseek-v4-flash \
  --max-output-tokens 4096
```

For subscription authentication, use a dedicated Pi profile that has no other
extensions or resources. The output-budget option cannot modify this existing
profile:

```bash
npm run test:e2e:live -- \
  --profile ~/.config/pi-workflows-e2e/openai-codex \
  --provider openai-codex \
  --model gpt-5.6-luna
```

The real-model phase also saves partial work in a temporary directory, lets the agent step expire, and verifies that the owned Pi command stopped before a recovery step runs. The harness checks the process and durable workflow outcomes independently of the model's recovery claim.

The profile and normal provider environment remain operator-owned. The runner
does not read, copy, print, or save credentials. It uses one guarded temporary
root and removes that root after success or failure. Use `--keep` only when you
need the isolated files for diagnosis.
