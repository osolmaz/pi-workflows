---
title: Keep the Herdr plugin linked after package updates
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-20
---

# Keep the Herdr plugin linked after package updates

pi-workflows ships its Herdr plugin inside the npm package. Herdr records the package's absolute path. npm can move an installed package between nested and hoisted `node_modules` directories during an update, which leaves Herdr linked to a path that no longer exists.

pi-workflows will own one explicit command that finds its own package and repairs this link. OnurPi will call that command after it installs an exact reviewed pi-workflows release. OnurPi will not contain Herdr paths, manifests, or link-repair rules.

## Outcome

The canonical command is:

```bash
pi-workflows herdr sync --json
```

`pi-workflows herdr setup` remains an alias for compatibility.

The command validates the bundled package before it changes Herdr. It then creates a missing link, enables a disabled link, leaves a correct link unchanged, or replaces a link to another package path or version. A successful result requires a new Herdr query that shows the expected plugin ID, package version, package root, manifest path, enabled state, and no warning.

## Scope

### pi-workflows

- Resolve the installed package root from the running CLI.
- Validate `package.json`, `herdr-plugin.toml`, and the bundled viewer before changing Herdr.
- Reconcile the current registration through Herdr's public CLI.
- Return a versioned JSON result with one of `linked`, `relinked`, `enabled`, `unchanged`, or `unavailable`.
- Return `unavailable` only when the Herdr executable is absent.
- Treat malformed package data, malformed Herdr output, command failures, identity conflicts, and failed verification as errors.
- Keep output bounded and use argument arrays instead of shell commands.
- Test source and packed-package layouts, including paths that contain spaces.

### OnurPi

- Keep the pi-workflows dependency pinned to an exact reviewed release.
- Invoke the local `pi-workflows herdr sync --json` command from an explicit TypeScript sync script after dependency installation.
- Accept the versioned result and keep Herdr-specific behavior in pi-workflows.
- Keep package installation free of `postinstall` side effects.

## Non-goals

- Do not create another Herdr plugin package or release.
- Do not duplicate the manifest or viewer in OnurPi.
- Do not add hard-coded `node_modules` paths.
- Do not edit Herdr state files directly.
- Do not change Herdr core or Pi core.
- Do not hot-reload running Pi processes. A running process still needs `/reload` or restart after a package update.
- Do not add a service, watcher, or implicit package-install mutation.

## Command contract

The JSON result uses schema `pi-workflows.herdr-sync.v1` and contains:

- the result status;
- whether Herdr state changed;
- the plugin ID;
- the expected and effective versions when available;
- the effective enabled state when available;
- a plain summary; and
- an advisory that running Pi processes must reload after a package update.

A missing Herdr executable returns `unavailable` with exit code zero because Herdr is an optional integration. Every other failure returns a nonzero exit code and does not claim success.

The command preflights the new package before unlinking an old registration. Herdr currently exposes separate unlink and link commands, so replacement cannot be atomic. If replacement fails, pi-workflows makes one restore attempt only when the previous package root still passes the same validation. It then reports the state found by a fresh Herdr query.

Concurrent sync commands converge on the same target. After a failed or ambiguous mutation, the command queries Herdr and adopts the result only when another process already reached the exact expected state. It does not repeat the same mutation blindly.

## Compatibility

Existing `herdr setup` callers use the same implementation. Other pi-workflows CLI commands do not change. The npm package remains the only source of the plugin manifest and viewer.

OnurPi adds only invocation timing and result handling. It does not parse the Herdr manifest or issue link commands.

## Verification

### pi-workflows

- Test first link, unchanged link, disabled link, moved package path, stale path, and version update.
- Test missing Herdr, malformed manifests, malformed plugin records, command failures, post-action mismatches, and bounded restore behavior.
- Test concurrent adoption and paths with spaces.
- Run the CLI from `npm pack` contents in nested and hoisted layouts.
- Run `npm run check`, `npm run test:e2e`, Slophammer, SimpleDoc, and diff checks.

### OnurPi

- Test every structured result and invalid command output with a fake executable.
- Verify the wrapper contains no plugin ID, manifest copy, Herdr mutation command, or package path.
- Verify root and wrapper dependency pins remain equal.
- Run `npm run check`, `npm run slophammer`, SimpleDoc, and diff checks.

### Adoption

After a separately approved pi-workflows release, update OnurPi to that exact version and run:

```bash
npm run workflows:sync
```

Then verify the Herdr plugin list, open `piw`, and start or reload Pi to confirm resource discovery. Repeating the sync must return `unchanged`.
