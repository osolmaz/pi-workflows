# pi-workflows

pi-workflows is a workflow extension for the [pi coding agent](https://pi.dev).
It lets you define multi-step agent workflows as TypeScript graphs, trigger
them at any point in a pi conversation with `/workflow`, and watch them run
live in a standalone terminal viewer.

The workflow model is a port of [openclaw/acpx](https://github.com/openclaw/acpx)
flows into pi itself. Agent steps run inside your current pi conversation, so
the model keeps everything it already knows from the discussion. The model
completes each step by calling a JSON `workflow` tool, which gives the engine
structured, validated output to route on.

## Install

```bash
pi install git:github.com/osolmaz/pi-workflows
```

Or try it without installing:

```bash
pi -e git:github.com/osolmaz/pi-workflows
```

The `pi-workflows` viewer binary is part of the same package. To get it on
your PATH, clone the repo and run `npm install && npm run build && npm link`,
or run it in place with `npx tsx src/viewer/cli.ts`.

## Quick start

Put a workflow file in `.pi/workflows/` (project) or `~/.pi/agent/workflows/`
(global):

```typescript
// .pi/workflows/echo.workflow.ts
import { agent, defineWorkflow } from "pi-workflows";

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

Then, from any pi conversation:

```
/workflow echo summarize this repository
```

`/workflow` with no arguments lists discovered workflows. `/workflow cancel`
stops the active run; if the last run already ended (for example parked at a
checkpoint), it clears the leftover widget instead. Trailing text becomes
`{ task: "..." }`; pass arbitrary input with `--input-json {"key": "value"}`.
The names `cancel` and `list` are reserved and rejected as workflow names.

Because the workflow runs in your current conversation, you can have a long
discussion first and then trigger a workflow that builds on it. The
`elegant-solution` example does exactly that. It asks the model for the most
elegant long-term production-ready solution to the problem you discussed, then
for the holy grail, then whether the two are the same (y/n). On `y` it routes
straight into implementation, and on `n` it asks the model to reconcile the
gap and pauses at a checkpoint for you to decide.

## Watching a run

Runs persist to `~/.pi/agent/workflows/runs/` as they execute. The viewer
tails that directory and re-renders on every state change:

```bash
pi-workflows view          # interactive picker, live updates
pi-workflows view <runId>  # jump straight to one run
pi-workflows runs          # plain list of recent runs
pi-workflows view --once   # print a snapshot and exit (good for scripts)
```

The run detail view draws the workflow as a boxed graph, like the acpx replay
viewer: every node sits in a box (heavy border for the active node), branches
carry their case labels, the taken path is highlighted, and loops route
through a gutter on the right back into their target from above. `←/→` scrubs
backwards and forwards through the recorded steps and re-derives every node's
status as of that step, with the selected step's full output shown below;
scrubbing to the end snaps back to following the run live.

```
              │ ┌──────────────────┐
              ▼ ▼                  │
  ┌──────────────────────────┐     │
  │ ✓ verify [action] 8.0s ×2 │    │
  └──────────────────────────┘     │
              │                    │
              ▼                    │
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓     │
  ┃ ◐ review [agent] 12s ×2  ┃     │
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛     │
     ┌─ clean ─┘ └─ issues ─┐      │
     ▼                      ▼      │
┌───────────┐    ┌───────────────┐ │
│ · done    │    │ ✓ fix [agent] │ │
└───────────┘    └───────────────┘ │
                        └──────────┘
```

Inside pi, a widget above the editor shows the same boxed graph while a
workflow is running, windowed around the active node when it is taller than
pi's widget budget. Scroll the window with `shift+↑` / `shift+↓`; it snaps back
to following the active node whenever the workflow advances a step.

## Node types

A workflow is a graph of named nodes with exactly one entry point. Each node
finishes with a JSON output, and edges decide what runs next.

An `agent` node sends a prompt into the pi conversation and waits for the
model to submit its output through the `workflow` tool. A `compute` node runs
a pure TypeScript function. An `action` node performs a side effect, either a
TypeScript function (`action({ run })`) or a runtime-owned shell command
(`shell({ exec, parse })`). A `checkpoint` node ends the run in a `waiting`
state so a human can pick it up. On top of `agent`, the `decision` helper asks
the model to pick from a fixed set of choices and validates the answer, and
`decisionEdge` routes on the result with compile-time case checking.

See [docs/workflows.md](docs/workflows.md) for the full authoring reference
and [docs/run-bundles.md](docs/run-bundles.md) for the on-disk run format.

## Examples

The [examples/workflows/](examples/workflows/) directory mirrors the acpx
example set. Copy any of them into `.pi/workflows/` to use them:

- `echo` is the smallest possible workflow, one agent step.
- `branch` classifies a task with a `decision` and routes to either a
  continue lane or a clarification checkpoint.
- `shell` runs a runtime-owned shell command and parses its output, with no
  agent step at all.
- `two-turn` chains three agent steps that build on each other's outputs in
  the same conversation.
- `elegant-solution` is the mid-conversation trigger described above.
- `autoimplement` runs an implement, verify, review loop where the review
  decision routes `issues_found` back to a fix step until it comes back
  `clean`, bounded by `maxSteps`.
- `autoresearch` runs an iterative feature-search loop in the style of
  [karpathy/autoresearch](https://github.com/karpathy/autoresearch): setup
  creates a frozen evaluation harness, one editable feature file, and a
  journal; each loop iteration runs one generation of experiments and
  journals every result; an assess decision keeps looping until a kept
  result plateaus or a diverse generation all fails, then conclusions are
  written before the winner is promoted out of the loop directory.

## License

[MIT](LICENSE)
