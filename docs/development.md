# Development guide

This document covers the standards for working on pi-workflows itself. For
authoring workflows, see [workflows.md](workflows.md).

## Layout and boundaries

```
src/workflows/   finite graph engine: definitions, execution, bundles, loader
src/builtins/    default workflows shipped at lowest discovery precedence
src/controllers/ durable resources, queue, reconciliation, effects, child runs
src/extension/   pi integration: commands, workflow tool, controller host, widget
src/viewer/      standalone read-only views over runs and controller resources
tui/             Rust piw viewer and live replay server
```

The dependency direction is enforced by `slophammer.yml`. `src/workflows`
imports nothing outside itself and never imports Pi. `src/controllers` may
import the public workflow engine for child-run scheduling. `src/extension`
and `src/viewer` may import both layers and never each other. The viewer reads
run bundles and opens the controller SQLite database read-only, so it works
from any process.

Within `src/render`, `graph.ts` computes a pure layered layout (ported from
the acpx replay viewer: labelled switch expansion, DFS back-edge detection,
longest-path layering, barycenter ordering, virtual pass-through cells for
long edges), `canvas.ts` is a character grid that merges box-drawing
characters by connectivity, and `graph-render.ts` turns a run bundle plus a
replay position into the drawn graph in one of two node styles: `box`
(bordered nodes, used by the viewer and the in-pi widget) or `line`
(single-line nodes). The widget windows the boxed graph around the active
node to stay inside pi's 10-line widget cap; `shift+↑`/`shift+↓` shortcuts
(registered through pi's `registerShortcut`) scroll that window manually, and
the scroll resets to follow mode when the run records a new step. `render.ts`
in `src/viewer`
composes the full detail view (header, graph, step timeline, step inspector)
and stays pure so tests can assert on rendered lines.

The Rust viewer keeps graph layout and plain rendering in parity with
`src/render`, then applies ratatui-only presentation through semantic canvas
roles and `tui/src/theme`. Catppuccin is the default. Theme colors must be
chosen in the theme layer rather than directly in UI components. Graph node
surfaces are intentional styled spaces, so changing the sparse canvas must
preserve those spaces as well as box connectivity. Text or geometry changes
still belong in both renderers and require regenerated fixtures.

The renderer is built so that overlaps cannot corrupt the drawing: every
back edge owns exclusive lane rows and an exclusive gutter column, multiple
edges leaving one node fan out over separate exit columns, and labels are
drawn last through `textOverRun`/`textIfEmpty`, which refuse to overwrite
anything but a plain horizontal run or empty cells. `test/helpers/graph-verify.ts`
enforces this structurally: it re-parses the rendered characters, checks
every node box is unbroken, and traces every declared edge through the
actual box-drawing characters from source box to target arrow.
`test/graph-verify.test.ts` runs that verifier over 60 seeded random
workflow shapes at every replay position; if a rendering change breaks a
line, misplaces an arrow, or lets a label damage an edge, those tests fail
with the offending drawing in the assertion message.

Inside the engine, the pi-facing seam is the `AgentStepExecutor` interface.
The extension implements it on top of the live conversation
(`src/extension/executor.ts`), and tests implement it with a scripted fake
(`test/helpers.ts`). Anything that would couple the engine to pi belongs on
the extension side of that seam.

Temporal session capture follows the same boundary. `src/extension` listens to
Pi's documented `turn_*`, `message_*`, and `tool_execution_*` hooks and
normalizes them before passing records to `WorkflowRunStore`. The workflows layer owns persisted shapes and schema validation. It also owns
ordered append chains but never imports Pi types. High-rate hooks only stamp and enqueue bounded records;
disk writes run on a separate chain. Capture failures are explicit in
`session/capture.json` and never fail workflow execution.

`src/viewer/session-reducer.ts` and `tui/src/session.rs` implement the same
sequence-ordered fold. Shared fixtures in `fixtures/session-events/` pin their
output. Seeking uses viewer-only checkpoints every 256 events and an in-memory
timestamp index. Neither cache is persisted.

## Toolchain

Node 22+, ESM, TypeScript strict (including `exactOptionalPropertyTypes`).
Formatting is oxfmt, linting is oxlint with warnings denied, tests are vitest
with istanbul coverage. The single gate is:

```bash
npm run check   # format:check + lint + typecheck + build + test:coverage
```

Coverage thresholds are 85% lines/functions/branches/statements, configured
in `vitest.config.ts`. The istanbul provider is deliberate. Workflow files are
loaded through jiti at runtime, and the v8 provider mismapped those modules;
istanbul instruments through the vitest transform pipeline only.

Slophammer runs in CI (coverage, complexity max 8, DRY max 0 findings,
dependency boundaries). Run it locally with:

```bash
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## End-to-end tests

```bash
npm run test:e2e
```

The E2E suite (`test/e2e/`) is non-destructive and fully local. It starts a
mock OpenAI-compatible server (`test/e2e/mock-openai.ts`) whose scripted
"model" answers each step contract with a `workflow` tool call, then spawns
the real pi CLI from `devDependencies` in RPC mode with:

- `PI_CODING_AGENT_DIR` pointed at a temp agent dir containing a `models.json`
  for the mock provider,
- `PI_WORKFLOWS_RUNS_DIR` pointed at a temp runs dir,
- the extension loaded from source with `-e src/extension/index.ts`.

It drives `/workflow` over the RPC protocol and asserts on the resulting run
bundle, including temporal events, final entry linkage, capture integrity, and
terminal immutability, then renders the finished run through the viewer CLI.
Nothing outside the temp directories is touched, and no real model is called.

## Publishing

The npm package is `@osolmaz/pi-workflows`. The crates.io package is
`pi-workflows`, and it installs the `piw` executable. Keep both package versions
in sync so one GitHub Release can publish both artifacts.

Trusted publishing uses separate GitHub environments and workflows. Neither
workflow stores a long-lived registry token:

- npm: repository `osolmaz/pi-workflows`, workflow
  `.github/workflows/publish.yml`, environment `npm`;
- crates.io: repository owner `osolmaz`, repository `pi-workflows`, workflow
  `publish-crate.yml`, environment `crates-io`.

For later versions:

1. Update `version` in `package.json`, `package-lock.json`, `tui/Cargo.toml`,
   and `tui/Cargo.lock`, then merge that change into the default branch.
2. Publish a GitHub Release whose tag is `v<version>`, such as `v0.2.0`.
3. Wait for the **Publish npm package** and **Publish crates.io package**
   workflows to finish.
4. Verify the version on both npm and crates.io.

Both workflows reject mismatched tags, commits outside the default branch, and
versions already present in their registry. They run their package checks
before publishing.

## Conventions

- Conventional Commits for commit messages and PR titles.
- Persisted JSON uses camelCase keys and versioned `schema` identifiers; see
  [run-bundles.md](run-bundles.md). Breaking a persisted shape means bumping
  the schema version string.
- Every exported API of the engine (`src/workflows/index.ts`) is covered by
  unit tests; new node types or edge semantics need tests in `test/` and a
  section in [workflows.md](workflows.md).
