---
title: Give Built-in Workflows Stable Identities
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-13
status: implemented
---

# Give Built-in Workflows Stable Identities

A long-lived Pi process must never combine an old workflow engine with a new built-in workflow file. Built-in workflows also need identities that survive package paths, source and distribution layouts, and later package updates. This plan replaces path-based built-in loading with a general catalog for all current and future built-ins.

## Requirements

- Load every built-in workflow and its validator from one process module graph.
- Identify built-ins with stable references such as `builtin:monitor`.
- Record a built-in revision and refuse resume when the loaded revision differs.
- Keep project and global workflow files hot-reloadable and path-based.
- Keep project and global workflows able to override a built-in by name.
- Let the Pi extension and standalone host resolve the same stable reference.
- Preserve existing nonterminal built-in runs through one bounded migration.
- Remove old built-in file paths from active run bundles and queue records after migration.
- Apply the design to all built-ins, not only the monitor.

## Data model

A resolved workflow source is one of two forms:

```typescript
type WorkflowSource =
  { kind: "builtin"; id: string; revision: string } | { kind: "file"; path: string; hash: string };
```

`kind` is the discriminator. A built-in `id` is stable across installations. A built-in `revision` is an explicit catalog value that maintainers change when the definition changes. A file source keeps its absolute path and SHA-256 hash.

Run state and the run manifest will store `workflowSource`. Queue records will store a display name and one canonical source reference: `builtin:<id>` for built-ins and an absolute path for files. New code will stop writing `workflowPath` and `workflowHash` to run bundles.

This is a deliberate in-place change to the version 1 run-state and controller-store contracts. The migration is bounded to existing nonterminal built-in runs. It rewrites their path and hash fields to `workflowSource`, then updates their nonterminal queue rows to `builtin:<id>`. It does not keep a runtime fallback reader after migration.

## Architecture

The workflow layer will define a generic `BuiltinWorkflowCatalog`. The built-ins layer will create the catalog from imported workflow definitions. The Pi extension and standalone host will receive or import that catalog and pass it to the generic resolver. The workflow engine will receive a resolved `WorkflowSource`; it will not know how built-ins were registered.

The catalog will:

- validate stable built-in IDs;
- reject duplicate IDs and workflow names;
- compute a deterministic revision from the definition snapshot and package revision input;
- discover built-ins by name;
- resolve `builtin:<id>` without disk access;
- return the same imported definition for the lifetime of the process.

## Migration

Migration runs before a session or host claims resumable workflow work.

For each nonterminal run bundle:

1. Read the stored workflow path and hash.
2. Match only a catalog entry's registered legacy path pattern and workflow name.
3. Require the old hash to equal an explicitly registered legacy revision for that built-in.
4. Rewrite the manifest and state to `workflowSource: { kind: "builtin", id, revision }` with atomic file replacements.
5. Rewrite the matching nonterminal queue source reference to `builtin:<id>`.
6. Leave terminal bundles unchanged.

If identity or revision cannot be proved, leave the run unchanged and report a clear blocker. Do not guess from the filename alone.

## Scope and non-goals

This changes Pi Workflows only. It uses no Pi internals and changes no Pi session entry. It updates Pi Workflows run bundles and controller queue records as described above.

It does not add runtime compatibility readers, aliases, dual-write fields, or a permanent migration service. It does not hot-reload package-provided built-ins. A package update takes effect after Pi reload or restart.

## Acceptance criteria

- Starting `monitor` records `workflowSource.kind === "builtin"` and `id === "monitor"`.
- No new built-in run records an installation path as its identity.
- One process keeps its imported built-ins after files on disk change.
- Source-loaded Pi and the distribution-loaded host resolve the same built-in reference and revision.
- Project and global monitor overrides remain file sources and still reload.
- A changed built-in revision parks or refuses resume with a clear source-change error.
- Known existing nonterminal monitor runs migrate and resume.
- Unknown legacy paths or hashes are not migrated.
- No runtime fallback for old built-in paths remains after migration.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
```

Also test a source-loaded Pi extension, a distribution-loaded standalone host, a project override, a changed built-in revision, and a copied legacy nonterminal run bundle with its matching queue row. After OnurPi updates its immutable pin, start a fresh Pi RPC process and run the built-in monitor through its first check.
