---
title: Make the workflow widget responsive
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-13
---

# Make the workflow widget responsive

The live workflow widget must remain easy to scan without using most of the conversation area. The boxed graph wrapped into broken fragments in a 43-column Herdr pane, and it was hard to read even when it fit. Pi requires every TUI component to return lines that do not exceed the width passed to `render(width)`.

## Requirements

- Render the live workflow widget from Pi's component-form `setWidget` API.
- Use the width supplied to the component's `render(width)` method.
- Use the compact node list as the Pi widget's default and only layout.
- Keep one line per node in workflow definition order.
- Keep the active or waiting node visible.
- Put the status glyph first and a one-column node-type glyph second.
- Use terminal-safe type glyphs: `●` agent, `ƒ` compute, `!` notification, `$` shell action, `*` function action, and `◆` checkpoint.
- Show concise runtime details when space permits: repeated visits, active elapsed time, latest completed duration, current status detail, and node errors.
- Use Pi's supplied theme for TUI colors. Keep RPC and other non-TUI widget output plain.
- Make the active node unmistakable by coloring its full line with the theme accent and making its name bold.
- Color a held or waiting focus line with the warning color.
- Color only the status glyph for completed and failed nodes, color failed error text, and dim pending nodes and non-focused type glyphs.
- Keep status glyphs as the non-color state signal.
- Keep the widget within Pi's 10-line budget.
- Ensure every line has a visible width less than or equal to the supplied width.
- Preserve manual vertical scrolling for long node lists.
- Handle widths down to one column without terminal wrapping.

## Non-goals

- Do not modify Pi core.
- Do not change workflow state or persisted schemas.
- Do not add a global output truncation layer.
- Do not change the standalone workflow viewer.

## Design

`buildWidgetView` accepts the available width and renders a compact list with one node per line. Each line uses this order:

```text
<status> <type> <node name> · <repeat count> · <runtime detail> · <time>
```

Optional fields are omitted when they do not apply and truncated from the right when the terminal is narrow. Repeated visits use `↻N`. The active node shows elapsed time. A completed node shows the duration of its latest result. An error replaces routine timing details. The list follows the active or waiting node and uses one scroll coordinate system.

Node-type glyphs come from one shared formatter used by both the compact widget and graph viewer. The node snapshot already distinguishes shell actions from function actions, so this change needs no workflow schema change. A shell action named `sleep` appears as `$ sleep`; it does not become a new wait-node type.

The extension installs one Pi widget component for each active workflow. The documented component factory supplies Pi's current `Theme`. Its `render(width)` method reads the latest workflow state and calls `buildWidgetView` with that width and theme. State changes request a normal Pi render by setting the component again. Pi calls the component with the current width after terminal resizes. RPC mode keeps using serializable string arrays and does not receive color codes. The standalone viewer remains the place to inspect the full workflow graph.

## Contract impact

- Session state: no change.
- Other persistent data: no change.
- Pi internals: no change.
- Public API: documented component-form `ctx.ui.setWidget`, its supplied `Theme`, and `Component.render(width)`.

## Acceptance criteria

- The Pi widget uses the compact list at all terminal widths.
- The reproduced 43-column monitor view does not wrap.
- Widths 80, 43, 40, 20, 8, and 1 all return valid lines.
- Every rendered line satisfies `visibleWidth(line) <= width`.
- Each real node and action subtype uses its documented one-column glyph.
- A repeated node shows its visit count, and active and completed nodes show useful timing.
- The active node remains visible in a long workflow and its full line uses the theme accent with a bold name.
- Completed, failed, waiting, and pending states use the specified theme roles without relying on color alone.
- TUI lines remain width-safe after color codes are added.
- RPC widget lines contain no ANSI color codes.
- Existing scrolling and workflow execution behavior remain unchanged.

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
