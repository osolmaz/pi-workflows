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
- Persisted structured values use camelCase fields and versioned `schema`
  identifiers. Live durable state follows `docs/SQLITE_STATE.md`.
- Tests must not write outside temp directories, call real models, or perform
  destructive actions.
- New engine features need unit tests and a section in `docs/workflows.md`.

## Built-in workflow skill style

Skills that start a built-in workflow must help the model make one complete start call. Follow this
structure in every such `SKILL.md`:

1. Put a `Start the workflow` section near the top.
2. State when to list workflows and when to make the single `start` call.
3. List every input field that affects scope, authority, safety, routing, or completion. Explain how to
   derive it from the conversation, when to omit it, and its safe default.
4. Include one exact, valid JSON `workflow` start example. Use obvious placeholder values and tell the
   model to replace them with facts from the conversation. Do not use comments or ellipses inside the
   JSON.
5. Tell the model to build the complete input before it starts. Do not rely on later turns to repair
   omitted fields.
6. Keep the active-workflow guard: a skill loaded inside a workflow step completes that step and does
   not start a nested workflow.

For workflows that can mutate code or remote state, examples and field rules must include:

- an absolute repository path;
- a concrete scope that names allowed repositories and allowed edit, test, commit, push,
  pull-request, merge, release, and deployment actions;
- inherited user and repository constraints;
- the base branch; and
- explicit merge and release authority, defaulting to false when authority is absent.

When one repository and task are unambiguous, instruct the model to derive a narrow scope instead of
asking the user to restate it. A repository path alone is not a scope. The derived scope must exclude
unrelated repositories and consequential actions that the user did not authorize.

Keep examples short enough to copy as a unit, but complete enough to execute after placeholder values
are replaced. Use the same headings and field language across the built-in workflow skills.

## Alpha compatibility policy

pi-workflows is in alpha. Until the repository explicitly leaves alpha:

- Do not preserve backward compatibility unless the user explicitly requires it for a task.
- Change persisted schemas and public contracts in place. Keep their current version identifiers.
- Do not add `v2` schemas, compatibility readers, migration shims, dual reads, dual writes, aliases,
  deprecated paths, or feature flags only to support older alpha state.
- Remove the superseded implementation in the same change.
- If old local state is incompatible, fail with a clear reset instruction. Do not silently
  reinterpret or delete that state.
