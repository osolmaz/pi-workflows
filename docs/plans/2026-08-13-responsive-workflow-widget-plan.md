---
title: Make the workflow widget responsive
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-13
---

# Make the workflow widget responsive

The live workflow graph breaks into wrapped fragments when a Pi terminal is narrow. This is reproducible in a 43-column Herdr pane. Pi requires every TUI component to return lines that do not exceed the width passed to `render(width)`.

## Requirements

- Render the live workflow widget from Pi's component-form `setWidget` API.
- Use the width supplied to the component's `render(width)` method.
- Keep the boxed graph when all displayed graph lines fit.
- Use a compact node list when the boxed graph does not fit.
- Keep the active or waiting node visible in the compact layout.
- Keep the widget within Pi's 10-line budget.
- Ensure every line has a visible width less than or equal to the supplied width.
- Preserve manual vertical scrolling for the boxed graph.
- Handle widths down to one column without terminal wrapping.

## Non-goals

- Do not modify Pi core.
- Do not change workflow state or persisted schemas.
- Do not add a global output truncation layer.
- Do not change the standalone workflow viewer.

## Design

`buildWidgetView` will accept the available width. It will first build the current boxed graph view. If every displayed line fits after the widget indentation, it will keep that view. Otherwise, it will render a compact list with one node per line and a short overflow marker. The compact list follows the active or waiting node and uses the same status glyphs as the graph.

The extension will install one Pi widget component for each active workflow. Its `render(width)` method will read the latest workflow state and call `buildWidgetView` with that width. State changes will request a normal Pi render by setting the component again. Pi will call the component with the current width after terminal resizes.

## Contract impact

- Session state: no change.
- Other persistent data: no change.
- Pi internals: no change.
- Public API: documented component-form `ctx.ui.setWidget` and `Component.render(width)`.

## Acceptance criteria

- The reproduced 43-column monitor view does not wrap.
- Widths 80, 43, 40, 20, 8, and 1 all return valid lines.
- Every rendered line satisfies `visibleWidth(line) <= width`.
- Wide views still show the boxed graph.
- Narrow views show a readable compact list with the active node.
- Existing scrolling and workflow behavior remain unchanged.

## Verification

- `npm run check`
- `npm run test:e2e`
- `npx slophammer-ts@latest dry .`
- `npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`
- `git diff --check`
- `npx -y @simpledoc/simpledoc check`
- `cargo fmt --check --manifest-path tui/Cargo.toml`
- `cargo clippy --manifest-path tui/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --manifest-path tui/Cargo.toml`
- `pi-reviewer --base main`
- Start Pi in a narrow terminal and confirm that the active monitor widget does not wrap.
