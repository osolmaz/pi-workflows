# Development guide

This document covers the standards for working on pi-workflows itself. For
authoring workflows, see [workflows.md](workflows.md).

## Layout and boundaries

```
src/workflows/   engine core: definitions, graph, engine, store, loader
src/extension/   pi integration: /workflow command, workflow tool, widget
src/viewer/      standalone TUI viewer over run bundles
```

The dependency direction is enforced by `slophammer.yml`. `src/workflows`
imports nothing outside itself and never imports pi. `src/extension` and
`src/viewer` may import `src/workflows` and never each other. The viewer
observes runs purely through the bundle files, so it works from any process.

Within `src/render`, `graph.ts` computes a pure layered layout (ported from
the acpx replay viewer: labelled switch expansion, DFS back-edge detection,
longest-path layering, barycenter ordering, virtual pass-through cells for
long edges), `canvas.ts` is a character grid that merges box-drawing
characters by connectivity, and `graph-render.ts` turns a run bundle plus a
replay position into the drawn graph in one of two node styles: `box`
(bordered nodes, used by the viewer) or `line` (single-line nodes, used by
the in-pi widget where vertical space is scarce). `render.ts` in `src/viewer`
composes the full detail view (header, graph, step timeline, step inspector)
and stays pure so tests can assert on rendered lines.

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
bundle, then renders the finished run through the viewer CLI. Nothing outside
the temp directories is touched, and no real model is called.

## Conventions

- Conventional Commits for commit messages and PR titles.
- Persisted JSON uses camelCase keys and versioned `schema` identifiers; see
  [run-bundles.md](run-bundles.md). Breaking a persisted shape means bumping
  the schema version string.
- Every exported API of the engine (`src/workflows/index.ts`) is covered by
  unit tests; new node types or edge semantics need tests in `test/` and a
  section in [workflows.md](workflows.md).
