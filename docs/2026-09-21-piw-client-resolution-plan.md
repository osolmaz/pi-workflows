---
title: piw client resolution plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-21
---

# piw client resolution plan

## Purpose

A Herdr viewer pane opened and then closed in under a second, and Pi reported
success. The pane ran an old `piw` client from `PATH`, which could not use the
running server state and then failed to start a server of its own. Onur asked for
the most elegant, long-term, production-ready version of this fix, so that the
client is resolved once, by absolute path, by the session that owns the server, and
so that a failure inside the pane is visible instead of silent. The client binary
belongs to crates.io, and npm ships JavaScript only.

## Observed failure

- The pane command is `["node", "plugins/herdr/viewer.mjs"]`, and that script spawns `piw` through `PATH`.
- The Herdr server environment, which plugin panes inherit, starts with `/home/onur/.cargo/bin` and holds neither `~/.local/bin` nor the npm global bin directory.
- `~/.cargo/bin/piw` was 0.16.8, while the loaded package and the server were 0.17.4.
- The 0.16.8 client could not use the 0.17.4 state, so it ran `pi-workflows server start`, which is not on the pane `PATH`, and failed with `No such file or directory (os error 2)`.
- The command exited, Herdr closed the pane, and the failure stayed invisible.
- The Pi extension still reported "Opened piw in Herdr." because its probe only checks that some `piw --version` exits 0.

## Requirements

1. Add a client-resolution helper to the pi-workflows TypeScript sources that returns the absolute path of the `piw` binary plus its version string. Resolution order: an explicit `PIW_BIN` environment value when it is set and executable; a package-local platform binary when one is installed, at `node_modules/@osolmaz/piw-<os>-<arch>/bin/piw` (`bin/piw.exe` on Windows), which is a forward hook only because no platform package ships in this work; otherwise the first `piw` on `PATH`, which keeps today's behavior on machines with no package-local binary. When nothing is found, return a structured error naming every location that was tried. Publish no platform package in this work.
2. Add a version compatibility check that compares the resolved client version against the running pi-workflows package version. It must tolerate a `piw ` prefix and a leading `v` in the client output, and it must report both versions when they differ. The check stays strict, and the failure message carries the one command that fixes a missing or mismatched client: `cargo install pi-workflows --version <expected>`. crates.io is the only client distribution, and npm ships no binary.
3. Extend `plugins/herdr/viewer.mjs` so it resolves the client through that helper or through `PIW_BIN`, never through `PATH` when an explicit path is present, and so a missing or mismatched client prints a clear message that stays visible: the pane must not exit silently. Label the pane with the failure state so the user sees the outcome in the pane title. When stdin is not a terminal, print the same message and exit nonzero.
4. Extend the Herdr pane open call in `src/extension/herdr-viewer.ts` to pass `--env PIW_BIN` with the resolved absolute client path, `--env PIW_NO_AUTOSTART=1`, and `--env PIW_SOCKET` with the socket path that this Pi session's server uses. Check the client version before opening the pane: on a missing client or a mismatch, notify inside Pi with both versions and do not open the pane.
5. Add `PIW_NO_AUTOSTART` support to the Rust client: when it is set and the server socket is unreachable, print one clear error that names the socket path and exit nonzero, without spawning a server. When it is not set, keep today's autostart behavior for interactive use.
6. Add `PIW_SOCKET` support to the Rust client so the socket path can be pinned explicitly, and pass it from the extension, so a pane always reaches the server that owns the session state. Keep the derived default path when the variable is unset.
7. (Deferred) Do not distribute the client through npm in this work. crates.io owns the client binary through `cargo install pi-workflows --version <expected>`, npm ships JavaScript only, and the strict version check in requirement 2 binds the two distributions. Keep the package-local lookup from requirement 1 as the hook that a later prebuilt-client distribution can use, and leave the release automation unchanged. Do not publish anything, do not bump the version, and do not run a release or publish workflow in this run.
8. Keep the current machine working and keep interactive behavior: a machine with no package-local binary must resolve `piw` from `PATH` exactly as today, and a human running `piw` in a shell must still get the current autostart behavior.
9. Add unit tests: resolution order (`PIW_BIN`, package-local binary, `PATH`, nothing found), version parsing and comparison, the viewer failure path, `PIW_NO_AUTOSTART` when the socket is unreachable, and `PIW_SOCKET` pinning. Update every existing test that asserts the current pane-open arguments or the current spawn behavior.
10. Update documentation: state that npm ships JavaScript only, that crates.io owns the client binary through `cargo install pi-workflows --version <x>`, and that the strict version check binds the two distributions. Correct this plan so it no longer asks for per-platform npm packages, and update `README.md` and `docs/TUI_VIEWER.md` to match.
11. Verify on this machine: build the client, then prove the three outcomes with a temporary Herdr plugin pane (create it, check each outcome, then remove the plugin, its panes, and its config and state directories). The three outcomes are: a resolved and matching client shows the viewer; a client on `PATH` that does not match produces a visible message and the pane stays open; a pane with no reachable server and `PIW_NO_AUTOSTART` set reports the socket path instead of starting a server. The user's own Herdr plugins, panes, labels, and layout must be unchanged afterwards.

## Design

### One owner per concern

The Pi session owns the workflow server and owns the client version. A viewer
pane is only a window: it draws one run and starts nothing. The client is
resolved once, by absolute path, by the session that owns the server, and its
version is checked against the running package version before any pane opens. The
client binary belongs to crates.io, and npm ships JavaScript only.

### Client resolution order

1. `PIW_BIN`, when it is set and points at an executable file.
2. The package-local platform binary, when one is installed, at `node_modules/@osolmaz/piw-<os>-<arch>/bin/piw` or `bin/piw.exe`. No platform package ships in this work, so this step is a forward hook.
3. The first `piw` on `PATH`, which preserves today's behavior.

When all three fail, the error names every location that was tried, so the
message itself states what to install or set.

### Version rule

The resolved client version must equal the running package version. The parser
tolerates a `piw ` prefix and a leading `v`. The strict equality check stays, and
the mismatch is reported with both versions rather than hidden.

### Pane environment

The extension passes three values to the pane:

| Variable           | Value                                         | Purpose                                         |
| ------------------ | --------------------------------------------- | ----------------------------------------------- |
| `PIW_BIN`          | The resolved absolute client path             | The pane runs this file, never a `PATH` lookup  |
| `PIW_SOCKET`       | The socket path this Pi session's server uses | The pane reaches the server that owns the state |
| `PIW_NO_AUTOSTART` | `1`                                           | The pane never starts a server                  |

### Loud failure

A pane that cannot run keeps its message on screen instead of exiting, and the
pane label states the failure, so the outcome is visible in the pane title. The
extension also checks the client before opening the pane and reports the two
versions inside Pi when they differ.

### Packaging

npm ships JavaScript only: the extension, the viewer pane launcher, and the
resolution helper. No compiled client is published through npm, and the release
automation stays unchanged.

crates.io owns the client binary, and `cargo install pi-workflows --version <x>`
is the install path. The two distributions cannot drift apart because the strict
version check compares the resolved client against the running package version and
reports both when they differ.

The resolver keeps an explicit `PIW_BIN` value and a package-local lookup, so a
later prebuilt-client distribution needs no resolver change. Such a distribution
is a planned follow-up and is not built or published here.

## Non-goals

- No publish to npm or crates.io, no version bump, and no release or publish workflow run.
- No platform package, no `optionalDependencies` entry, and no compiled client inside npm, and no change to the release workflows.
- No change to Herdr core, and no change to Herdr's own configuration.
- No restart of Herdr, and no change to the `PATH` of any process.
- No service, daemon, socket coordinator, or background helper.
- No change to any other repository.
- No signal to another agent, pane, or process.
- The strict client and server version check is not loosened.
- The `PATH` fallback stays for machines with no package-local binary.
- Autostart stays for a human running `piw` in a shell.
- Both installed clients on this machine stay at the same version, and the backup copy of the older client in `~/scratch` stays.
- The resolution, version check, environment handoff, loud failure, `PIW_NO_AUTOSTART`, and `PIW_SOCKET` work land completely on their own, with no packaging work. Any later prebuilt-client distribution stays a documented, tested, and unpublished follow-up, and it needs no resolver change because the `PIW_BIN` hook and the package-local lookup already exist.

This plan replaces the earlier non-goal "Do not change Herdr core or `piw`" from
[the Herdr piw plan](2026-08-18-herdr-piw-plan.md), but only for the client
changes named here. Herdr core still stays unchanged.

## Acceptance criteria

- A pane with a resolved and matching client shows the viewer.
- A pane whose `PATH` client does not match shows a message that stays visible, and the pane stays open.
- A pane with no reachable server and `PIW_NO_AUTOSTART` set reports the socket path and starts no server.
- A machine with no package-local binary resolves `piw` from `PATH` exactly as today.
- A human running `piw` in a shell still gets the autostart behavior.
- The extension reports a mismatch inside Pi and does not open a pane for it.
- The user's Herdr plugins, panes, labels, and layout are unchanged after verification.

## Verification

- The repository's own local checks pass for both the TypeScript and the Rust sides, including the existing test, lint, format, typecheck, and coverage commands that exist in the repository.
- The new unit tests pass for resolution order, version comparison, the viewer failure path, `PIW_NO_AUTOSTART`, and `PIW_SOCKET`.
- A temporary Herdr plugin pane shows all three outcomes from requirement 11, and the temporary plugin is fully removed afterwards.
- Repository state confirms that no compiled client, no platform package directory, no `optionalDependencies` entry, and no release-workflow change was added, and that no release, publish, or version bump was executed.
- The live machine state is unchanged: the Herdr plugin list still has the same three plugins, no plugin pane from the verification remains, and no Pi or Herdr process was signalled.
- The Pi extension still opens the pane for a real run when the resolved client matches, and reports the mismatch instead of opening the pane when it does not.
