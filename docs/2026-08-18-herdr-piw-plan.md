---
title: Native Herdr piw integration plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-18
---

# Native Herdr piw integration plan

## Purpose

When Pi Workflows runs inside Herdr, show a shortcut that opens the current run in `piw`. The integration must belong to Pi Workflows and ship as one package, repository, version, and release. The same repository must also qualify for Herdr's public plugin marketplace.

## Requirements

- Detect a live Herdr pane without polling.
- Show `Ctrl+Shift+R piw` inside the existing workflow widget only when the integration is available. Put it on the scroll-controls line when that line exists.
- Add `/piw` as a command fallback.
- Let the user open the viewer to the right, below, left, above, in a new tab, or in a new workspace.
- Open the exact run bundle rather than the runs list.
- Focus an existing viewer for the same run instead of opening a duplicate, including after Pi reload.
- Keep the workflow engine and run-bundle format independent of Herdr.
- Use Herdr's public plugin, pane, workspace, tab, label, and snapshot APIs. Do not construct commands from run data.
- Add the public repository to Herdr's plugin marketplace through the `herdr-plugin` topic.

## Design

### One package with two host entry points

The package root will contain `herdr-plugin.toml`. Pi loads the existing extension entry point. Herdr loads a `piw` pane entry point from the same package root. A small checked-in JavaScript launcher validates `PI_WORKFLOWS_RUN_DIR` and starts `piw` with an argv array.

`pi-workflows herdr setup` explicitly links the current package root with `herdr plugin link`. It is idempotent and never changes plugin registration during normal Pi startup.

### Native extension adapter

A Herdr adapter under `src/extension/` will own capability checks and topology operations. It will use Pi's documented `pi.exec` API with bounded timeouts. The adapter will resolve the caller with `herdr pane current --current` on every open action, parse bounded JSON, and use only returned IDs.

The extension will keep a view target containing the exact run ID, workflow name, and bundle directory. The target starts after the bundle exists and lasts as long as the workflow widget. The widget renderer will keep the shortcut inside Pi's ten-line limit. It will append the call to action to the existing `shift+↑/↓ scroll` line when rows are hidden, and use a short standalone line only when no scroll-controls line exists.

### Placement

Right and below use Herdr plugin splits. Left and above create the corresponding right or down split and then swap the new viewer with the caller. A tab uses the current workspace. A workspace is created transactionally; if plugin pane creation fails, only that new workspace is closed.

### Viewer discovery

Herdr's public snapshot does not expose plugin metadata tokens. The launcher will therefore set an exact pane label derived from the run ID before starting `piw`. The adapter will inspect Herdr's public snapshot to find and focus an existing viewer after reload. It will discard stale pane references without adding a state file.

## Non-goals

- Do not change Herdr core or `piw`.
- Do not add a companion Pi extension, event bridge, protocol version, daemon, poller, or new state store.
- Do not install or link the Herdr plugin automatically during Pi startup.
- Do not expose viewer control to the model-visible workflow tool.

## Acceptance criteria

- A workflow started in a normal Pi TUI outside Herdr has unchanged UI and behavior.
- A workflow started in Herdr shows the shortcut and opens its exact bundle in `piw`.
- All six placements work and preserve the calling pane unless the user selects a focused viewer.
- Repeated opens and Pi reloads focus the existing run viewer.
- Failures produce bounded, useful messages and leave no empty tab or workspace.
- The package tarball contains the Herdr manifest and launcher.
- `osolmaz/pi-workflows` is public, has a root `herdr-plugin.toml`, and has the `herdr-plugin` GitHub topic.

## Verification

- `npm run check`
- `npm run test:e2e`
- `npx slophammer-ts@latest dry .`
- `npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`
- `npx -y @simpledoc/simpledoc check`
- `npm pack --dry-run`
- Link the package with `pi-workflows herdr setup` in a disposable Herdr test session.
- Start a finite test workflow in real Pi, open `piw` with `Ctrl+Shift+R`, verify the exact run ID, then test pane reuse and cleanup.
