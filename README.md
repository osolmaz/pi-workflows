# pi-workflows

<p align="center">
  <img src="assets/cover.svg" alt="pi-workflows: a representative multi-step workflow graph with plan, implement, verify, review, a fix loop, and a clean finish" width="880">
</p>

pi-workflows is a workflow extension for the [Pi coding agent](https://pi.dev).
It lets you define multi-step agent workflows as TypeScript graphs and trigger
them at any point in a Pi conversation with `/workflow`. A standalone terminal
viewer shows each run live.

Agent steps run inside your current Pi conversation, so the model keeps
everything it already knows from the discussion. A submitted agent step
returns structured output through the JSON `workflow` tool, while an
assistant step writes a normal visible response that becomes the node
output. The [design philosophy](docs/DESIGN_PHILOSOPHY.md) explains the
principles behind the engine and its public parts.

## Install

```bash
pi install npm:@osolmaz/pi-workflows
```

You can also install directly from GitHub:

```bash
pi install git:github.com/osolmaz/pi-workflows
```

Or try the npm package without installing it:

```bash
pi -e npm:@osolmaz/pi-workflows
```

The Pi package includes the extension and six optional skills:

- `pi-workflows` teaches the agent how to operate and author workflows.
- `monitor` starts and operates the built-in monitor workflow.
- `autoplan` selects the best practical solution and writes an implementation plan.
- `autodoc` records an existing plan in canonical documentation.
- `autoimplement` implements an existing plan and verifies the result.
- `sanity-check` reviews whether a contribution is necessary, and whether it is focused and well supported.

Pi discovers these skills when it loads the package. Use `pi config` to disable
the extension, all bundled skills, or one skill independently. The equivalent
settings entry below keeps the extension and disables only `monitor`:

```json
{
  "packages": [
    {
      "source": "npm:@osolmaz/pi-workflows",
      "skills": ["-skills/monitor"]
    }
  ]
}
```

Set `"skills": []` to disable all bundled skills while keeping the extension.
Set `"extensions": []` to keep the skills without loading the extension.

Install the interactive terminal viewer separately from crates.io. The crate
is named `pi-workflows` and installs the `piw` command:

```bash
cargo install pi-workflows
piw
```

The npm package also includes the simpler `pi-workflows` snapshot viewer. To
link that command from a clone, run `npm install && npm run build && npm link`,
or run it in place with `npx tsx src/viewer/cli.ts`.

All live workflow and controller state uses one local database:

```text
~/.pi/agent/workflows/state.sqlite
```

Runs, decisions, queues, claims, controllers, session capture, notifications,
channel transport state, effects, and large text values all live there.
Viewers open the database read-only, and every write checks its actor,
expected revision, and owner lease when required. See
[SQLite state](docs/SQLITE_STATE.md).

## Quick start

Put a workflow file in `.pi/workflows/` (project) or `~/.pi/agent/workflows/`
(global):

```typescript
// .pi/workflows/echo.workflow.ts
import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: ({ input }) => `Answer concisely: ${(input as { task?: string }).task}`,
      expectedOutput: `{ "reply": "your concise answer" }`,
    }),
  },
  edges: [],
});
```

Then, from any Pi conversation:

```
/workflow echo summarize this repository
```

`/workflow` with no arguments lists discovered workflows. `/workflow pause`
stops the worker and parks the run at its last durable boundary. `/workflow
resume` starts a new worker generation from that boundary. `/workflow cancel`
stops the active run; `/workflow cancel <run-id>` can also cancel a named stale
run when no live owner holds it. A checkpoint waits until `/workflow answer
<json-or-text>` supplies its input.

Trailing text becomes `{ task: "..." }`, and `--input-json {"key": "value"}`
passes arbitrary input. The names `answer`, `cancel`, `list`, `pause`, `resume`,
and `status` are reserved and rejected as workflow names.

A workflow can also expose [settings that change during a
run](docs/2026-08-25-workflow-settings.md) and queue [normal follow-up work
after completion](docs/2026-08-25-workflow-follow-ups.md).

Use `expectedOutput: assistantMessage()` when a normal assistant response must
be a node inside the graph rather than a presentation after the run. Its exact
visible text becomes the node output after the turn settles. The helper has no
default character limit; a workflow can set one explicitly with
`assistantMessage({ maxChars: 2_000 })`.

## Workflow composition

A workflow can import another workflow and connect its named exits without copying its nodes:

```typescript
import { compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";
import autoplan from "./autoplan.workflow.js";

export default defineWorkflow({
  source: import.meta.url,
  name: "parent",
  startAt: "start",
  includes: {
    design: includeWorkflow(autoplan, {
      input: ({ outputs }) => ({ problem: String(outputs.start) }),
    }),
  },
  nodes: {
    start: compute({ run: () => "Fix the reported defect" }),
    finish: compute({ run: ({ outputs }) => outputs.design }),
  },
  edges: [
    { from: "start", to: "design" },
    { from: "design.ready", to: "finish" },
    { from: "design.blocked", to: "finish" },
  ],
});
```

Direct imports check child input and exit names in TypeScript, while names and
paths remain available for dynamic discovery. Nested children share one run,
trace, pause state, and cancellation state. See
[Workflow composition](docs/WORKFLOW_COMPOSITION.md) for the complete contract.

## Agent-managed workflows

The model can use the `workflow` tool to list, start, inspect, pause, resume,
cancel, and answer workflows. It uses `update` for durable progress from the
current attempt and `submit` for structured step output. Assistant-message
steps require a normal visible assistant response instead. The extension sends
all lifecycle mutations to the host and reports success only after the host
commits them.

A model-started workflow is saved before the tool reports it as accepted, so
the returned run ID works with `workflow status` and `workflow cancel`
immediately. Duplicate host commands and step submissions adopt their stored
receipts instead of repeating a committed transition.

pi-workflows includes a [monitor](docs/MONITOR.md) workflow for plain-language
requests such as:

> Monitor PR 123 every 30 minutes. Report failed checks. Stop when it is merged or closed.

The monitor checks immediately, reports only the states requested by the user,
waits with a normal shell action, and loops until its stop condition or check
limit. Every check is reported without starting an extra assistant turn. Its
input supports `task`, `everyMinutes`, `stopWhen`, `maxChecks`, and an
optional `checkTimeoutMinutes`.

Monitor is observation-only by default. An explicit `repair` policy authorizes
its composed `autoplan` and `autoimplement` path. The monitor checks the
target again after repair and stops when the same issue and target evidence
return without progress. Project and global workflows can replace the built-in
`monitor` by using the same file name.

A monitor occupies the session's one active workflow slot. If its worker or the
host stops during the shell wait, the run parks and repeats that idempotent wait
node when the host resumes it.

Because interactive agent steps run in the origin conversation, you can have a
long discussion first and then trigger a workflow that builds on it. The
`autoplan` example does exactly that. It frames the problem and scope, then
devises an elegant production-ready solution and compares it with the holy
grail. It
then selects the best practical in-scope solution without asking the user to
resolve the gap. The ideal can win when it is feasible, but work outside the
current authority cannot block a valid practical solution. The workflow keeps
the detailed implementation plan and shows one short assistant response with
the selected plan and a gist of every rejected option. `autoplan` replaces the
earlier `autodevise` name, and the old command and export are not retained.

## Viewers

Runs persist in `~/.pi/agent/workflows/state.sqlite` as they execute. The
viewer reads that database and re-renders on every state change:

```bash
pi-workflows view          # interactive picker, live updates
pi-workflows view <runId>  # jump straight to one run
pi-workflows runs          # plain list of recent runs
pi-workflows view --once   # print a snapshot and exit (good for scripts)
```

The run detail view draws the workflow as a boxed graph. `←/→` replays the
recorded steps with each step's full output, and scrubbing to the end snaps
back to following the run live.

The Rust `piw` viewer under `tui/` is the full interactive terminal UI, with
selectable themes, detailed trace and conversation inspection, temporal
replay, and reconnecting remote viewing. See
[the piw guide](docs/tui-viewer.md).

Inside Pi, a compact widget above the editor shows one line per workflow node,
with glyphs for node status and type. Scroll it with `shift+↑` / `shift+↓`.
Use `piw` when you need the full boxed graph and its edges.

## Herdr integration

pi-workflows also ships as a [Herdr](https://herdr.dev) plugin. After installing
`piw` and pi-workflows, synchronize the bundled plugin:

```bash
pi-workflows herdr sync
```

Run the same command after a pi-workflows update. `pi-workflows herdr setup`
remains an alias for existing installations.

When Pi runs inside Herdr, the workflow widget shows a `Ctrl+Shift+R piw`
shortcut. The shortcut opens the exact SQLite run state and lets you choose a
split, tab, or new workspace. `/piw` opens the same menu, and `/piw right`,
`/piw below`, `/piw left`, `/piw above`, `/piw tab`, or `/piw workspace`
selects a placement directly. If a viewer for that run already exists,
pi-workflows focuses it instead of opening a duplicate.

The plugin uses Herdr's public pane APIs and runs no service or polling loop. It
is also available through the [Herdr plugin marketplace](https://herdr.dev/plugins/).

## Node types

A workflow is a graph of named nodes with exactly one entry point. Each node
finishes with an output, and edges decide what runs next.

An `agent` node sends a prompt into the origin Pi conversation as a compact
[workflow step message](docs/WORKFLOW_STEP_MESSAGES.md). By default, it waits
for structured output through the `workflow` tool. With
`expectedOutput: assistantMessage()`, it waits for a normal visible assistant
response and uses the exact text as its output. A `compute` node runs a pure
TypeScript function. A `notify` node writes a durable message for the Pi
session that started the run. An `action` or `shell` node must declare an
`idempotentEffect(...)` or `manualEffect(...)` recovery contract before it can
perform a side effect. A `checkpoint` node ends the run in a `waiting` state so
a human can pick it up. On top of `agent`, the `decision` helper asks
the model to pick from a fixed set of choices and validates the answer, and
`decisionEdge` routes on the result with compile-time case checking.

Running steps can publish durable [workflow updates](docs/WORKFLOW_UPDATES.md),
including progress counts and ETA data.

See [docs/workflows.md](docs/workflows.md) for the full authoring reference
and [docs/SQLITE_STATE.md](docs/SQLITE_STATE.md) for the on-disk run format.

## Controllers

Controllers keep long-running automation aligned with current external state. They store desired state in `spec` and report observed state through conditions and `status`, then reconcile a deduplicated resource key whenever an event or retry makes it ready.

Put `*.controller.ts` files in `.pi/controllers/` or `~/.pi/agent/controllers/`. Import the API from `@osolmaz/pi-workflows/controllers`:

```typescript
import { conditionTrue, defineController } from "@osolmaz/pi-workflows/controllers";

export default defineController({
  name: "example",
  initialStatus: () => ({ phase: "new" }),
  reconcile: (ctx, resource) =>
    ctx.settled({
      controllerStatus: { phase: "done" },
      conditions: [conditionTrue("Ready", "Complete")],
    }),
});
```

Apply and inspect resources from Pi:

```text
/controller apply example item-1 {"enabled":true}
/controller get example item-1
/controller reconcile example item-1
```

The extension resolves controller initialization in a child process, then sends the declarative resource to the global host. Controller reconciliation also runs in supervised children. The standalone CLI provides read-only views with `pi-workflows controllers` and `pi-workflows controller <controller> <key>`. See [docs/CONTROLLERS.md](docs/CONTROLLERS.md) for reconciliation, queue, effect, and child workflow semantics.

## Always-on workflows

Every workflow enters one durable global queue. The extension starts the
package-owned host on demand. Closing Pi does not stop a compute, action, or
shell node. When a run reaches an interactive agent, assistant-message, or
human-decision step, the host parks it and saves a request for the origin Pi
session. Reopening that session presents the same request once.

The host also reconciles controllers. Controller child workflows without an
origin session can use headless `pi --mode rpc` agent steps. A child that needs
a visible assistant response must have an origin-session binding.

Use the CLI to inspect or control the on-demand process:

```bash
pi-workflows host start
pi-workflows host status
pi-workflows host stop
pi-workflows host run  # stay attached; stop with Ctrl-C
```

These commands manage one host for the complete user database, not one host per
project. They do not install an operating-system service. A new host reaps exact
orphan process identities and resumes safe work from committed state. See
[docs/workflows.md](docs/workflows.md#durable-runs-parking-and-resume) and
[docs/WORKFLOW_HOST.md](docs/WORKFLOW_HOST.md).

## Examples

The [examples/workflows/](examples/workflows/) directory contains complete
workflow examples. Copy any of them into `.pi/workflows/` to use them:

- `echo` is the smallest possible workflow, one agent step.
- `branch` classifies a task with a `decision` and routes to either a
  continue lane or a clarification checkpoint.
- `shell` runs a runtime-owned shell command and parses its output, with no
  agent step at all.
- `two-turn` chains three agent steps that build on each other's outputs in
  the same conversation.
- `plain-summary` turns structured source data into one visible assistant
  response without a default character or sentence limit. It is also a built-in workflow that other workflows can include.
- `autoplan` turns the current problem into a chosen practical solution and
  a detailed implementation plan, using the ideal end state as guidance rather
  than an out-of-scope requirement. It also shows an assistant response without
  character or sentence limits, with the selected plan and each rejected option.
- `autoimplement` finds a clear existing plan, prepares a safe branch or
  worktree before mutation, documents it when needed, and verifies the current
  change against eligible base-branch failures. It writes and runs the exact
  pi-reviewer command and tracks P0 through P2 findings, then handles PR
  comments and CI and finalizes the PR. P0 and P1 fixes require another review, while P2-only work
  is verified without another reviewer round. A five-minute CI wait routes to
  additional useful local testing, and new evidence can route through autoplan
  and autodoc before implementation resumes.
- `human-decision` shows a reusable verified-human gate with a structured
  machine subject, a separate readable operator presentation, plain choices,
  and exact replan text.
- `approved-plan` includes the shared plan-change workflow, which composes
  autoplan, autodoc, the configurable plan decision, and bounded replanning.
- `autoresearch` runs an iterative feature-search loop in the style of
  [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Setup
  creates a frozen evaluation harness, one editable feature file, and a
  journal. Each loop iteration then runs one generation of experiments and
  journals every result, and an assess decision keeps looping until a kept
  result plateaus or a diverse generation all fails. Conclusions are
  written before the winner is promoted out of the loop directory.

The controller example at `examples/controllers/pull-request.controller.ts`
shows child repair work and check polling. It also uses expected-head guards
and recoverable merge effects.

## Origins

The workflow model was originally ported from
[openclaw/acpx](https://github.com/openclaw/acpx) flows.

## License

[MIT](LICENSE)
