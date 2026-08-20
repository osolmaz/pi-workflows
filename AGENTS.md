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
- Persisted JSON is camelCase with versioned `schema` identifiers
  (see `docs/run-bundles.md`).
- Tests must not write outside temp directories, call real models, or perform
  destructive actions.
- New engine features need unit tests and a section in `docs/workflows.md`.

## Alpha compatibility policy

pi-workflows is in alpha. Until the repository explicitly leaves alpha:

- Do not preserve backward compatibility unless the user explicitly requires it for a task.
- Change persisted schemas and public contracts in place. Keep their current version identifiers.
- Do not add `v2` schemas, compatibility readers, migration shims, dual reads, dual writes, aliases,
  deprecated paths, or feature flags only to support older alpha state.
- Remove the superseded implementation in the same change.
- If old local state is incompatible, fail with a clear reset instruction. Do not silently
  reinterpret or delete that state.
