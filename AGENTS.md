# AGENTS.md

Before finishing any change, run:

```bash
npm run check      # oxfmt check, oxlint, tsc, build, vitest with coverage (85% thresholds)
npm run test:e2e   # non-destructive end-to-end test against the real pi runtime
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Repository rules:

- Use Conventional Commits for commit messages and PR titles.
- Respect the dependency boundaries in `slophammer.yml`: `src/workflows` never
  imports pi or the other layers; `src/extension` and `src/viewer` may import
  `src/workflows` and never each other.
- Persisted JSON is camelCase with versioned `schema` identifiers. Breaking a
  persisted shape means bumping the schema version string
  (see `docs/run-bundles.md`).
- Tests must not write outside temp directories, call real models, or perform
  destructive actions.
- New engine features need unit tests and a section in `docs/workflows.md`.
