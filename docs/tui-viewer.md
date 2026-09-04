# Rust TUI viewer (piw)

`tui/` contains `piw`, a Rust terminal viewer for workflow runs. It renders
the same graph as the bundled TypeScript viewer, pinned by the golden fixtures
under `fixtures/layout/`, and adds live following, replay, detailed inspection,
a recorded Pi conversation, themes, and remote viewing.

## Incremental projection

The viewer uses the [incremental and virtualized viewer design](plans/2026-08-28-piw-incremental-viewer-plan.md).

The run browser subscribes to small server-owned metadata views. It does not load trace, step, session, settings, or follow-up payloads. The server publishes a new bounded view only when its content changes.

Each live view keeps the server's `display` value separate from the durable workflow `state`. The run browser, current-run status, timeline, and latest graph use `display` directly. During an origin-session model turn, the latest graph presents the durable `waitingOn` node as running. Replay continues to use durable state and recorded history. `piw` does not calculate another live status.

The selected run contains bounded pages. Step, trace, session-entry, session-event, settings, follow-up, and update pages have both a row limit and a byte budget. Replay can jump to any position. The viewer loads the page that contains that position and keeps only the current windows. A session-event page includes the replay checkpoint immediately before its first event. A compact graph projection keeps the latest attempt for each node and the taken transitions up to the replay point.

Large values use server content references. `piw` fetches workflow definitions, graph history, and complete server display reasons before it publishes the related live view. It fetches other large details when the user opens them. It verifies the byte count and SHA-256 digest before it shows the complete text or JSON value. Page and content requests run outside input and drawing through the shared client protocol. A newer page selection replaces the previous request, including when the user returns to an earlier page. A failed first read leaves the run browser usable. A failed refresh keeps the last good view and marks it stale.

## Install

The crates.io package uses the project name and installs the shorter `piw`
command:

```bash
cargo install pi-workflows
```

## Modes

- `piw` connects to the local package-owned workflow server. If the socket is absent, it runs the installed `pi-workflows server start` command.
- `piw <runId>` opens one server-owned run view.
- `piw <runId> --once` waits for that run, renders one complete 120 × 40 plain-text frame, and exits. It returns a nonzero status for server, protocol, missing-run, or snapshot-timeout failures.
- `piw serve [--bind 127.0.0.1:9377]` relays each WebSocket connection to one server socket over the [live client protocol](live-replay-protocol.md). Only loopback addresses are accepted; use an SSH tunnel for remote viewing.
- `piw --connect ws://…` reads from another `piw serve` process.
- `piw --theme <name>` selects a theme for this invocation.
- `piw --list-themes` prints the built-in theme names.

Local and remote modes use the same semantic run view and the same protocol. `piw` has no SQLite mode or database schema copy.

## Herdr

The npm package contains a native Herdr plugin. Link the installed package with
`pi-workflows herdr setup`. A workflow running in Pi inside Herdr then shows
`Ctrl+Shift+R piw` in its widget. When rows are hidden, the call to action shares
the scroll-controls line. The shortcut and `/piw` command open
the current run directly in a managed Herdr pane. The placement menu supports
right, below, left, above, a new tab, and a new workspace.

The integration resolves the calling pane at invocation time and uses returned
Herdr IDs for every layout change. Existing viewers are found from their exact
run title and focused after Pi reload. Normal Pi sessions do not probe Herdr or
show the shortcut.

## Layout

Boxed graph cards use only their own content. Their outer width is 24 through 32 cells. Their height is 7 through 10 rows. A switch with more than three branches shows its first two branch names and a `+N branches` row. Edge labels and the inspector keep the complete branch information.

Ranks use the tallest card in that rank. Cards are top-aligned. Edge ports, clipping, centering, keyboard movement, and mouse hits use each card's exact bounds. The server sends one retained language-neutral graph scene per watched run. The TUI reuses that scene across status changes and turns only viewport rows and columns into Ratatui spans.

The normal layout contains a run browser, graph, inspector, and two-line replay
timeline. Short terminals use a compact one-line transport. Terminals below 100
columns start with the run browser collapsed to a status rail; `b` toggles it.
Drag the run browser's right border to resize it. Drag the inspector's top
border to resize the bottom panel. PIW saves both sizes in its viewer config and
clamps them when the terminal is smaller. A directly opened single run hides
the browser.

- **Run browser:** every run, newest first, with status, title, elapsed time,
  and a `?` marker for a possibly interrupted run.
- **Graph:** the complete workflow definition using the same layered layout as
  the TypeScript renderer. Full bordered cards are the default. Every card in
  one graph has the same width and height, fixed before layout. The exact step
  id is centered in a header above a horizontal divider. Structured body rows
  pair a type badge with status (`●` agent, `ƒ` compute, `!` notification, `$`
  shell action, `*` function action, `◆` checkpoint), then attempts (`↻`) with
  elapsed time (`◷`). Branch labels use
  `◇`; the final reserved row carries a short detail while unbounded content
  stays in the inspector. The outer border and header divider share the node's
  state color on the graph background. The body background starts inside that
  border, while the header interior uses a separate panel surface. Type badges
  keep their semantic colors. Updates fill reserved rows without moving nodes
  or edges.
  Narrow terminals pan over the fixed graph. Compact line nodes remain
  available with `z`. Start `▶` and terminal `■` markers sit outside the card.
  Branch labels remain on edges and loops use a right-hand gutter.
- **Inspector:** Steps, Trace, Conversation, and Info tabs. Each tab is a
  bracketed symbol button with a full-label mouse target; the selected tab uses
  the accent surface. Steps can expand to full prompt, output, timestamps,
  error, action data, and the settings scope and change number used by that
  attempt. Trace can show the selected attempt, the replay-visible prefix, or
  the full run, with expandable JSON payloads. Conversation shows live text,
  thinking, tool-call construction, and tool execution, then switches settled
  messages to the verbatim Pi entry. Raw records remain expandable. Info shows
  run metadata, final output, settings scopes and change numbers, queued
  follow-up states, capture status, counts, and integrity diagnostics.
- **Timeline:** run status, elapsed time, replay track, playhead, position,
  playback controls, and speed. Every playback action uses the same bracketed
  symbol-button style as the inspector and theme actions. The controls accept
  full-label mouse clicks; the track supports click and drag seeking.

## State presentation

The graph distinguishes these states:

- queued;
- running;
- replay focus;
- completed;
- failed;
- timed out;
- waiting; and
- cancelled.

A live running node uses a blue heavy border and `◐`. A selected historical
step uses a mauve heavy border and `◆`, so replay never looks live. Timed-out
nodes use `×` and a separate color. Type color is independent of state: agent
is green, compute is blue, action is yellow, and checkpoint is mauve. The graph
title distinguishes `(live)`,
`(latest)`, and `(replay)` and also reports paused, reconnecting, disconnected,
and failed or invalid capture states.

## Themes

Catppuccin Mocha is the default. The whole frame uses the theme: application,
panels, graph canvas, node surfaces, selected rows, borders, states,
conversation roles, and timeline. Boxed nodes use a surface color different
from the graph canvas.

Press `,` to open the theme picker. Moving through the list previews a theme
immediately. Enter applies and saves it; Escape restores the exact original
palette. Mouse selection is supported.

Built-in themes are:

- Catppuccin Mocha and Latte;
- terminal palette;
- Tokyo Night and Day;
- Dracula;
- Nord;
- Gruvbox Dark and Light;
- One Dark and Light;
- Solarized Dark and Light;
- Kanagawa and Lotus;
- Rosé Pine and Dawn; and
- Vesper.

Theme configuration is loaded from `PIW_CONFIG_PATH`, then
`$XDG_CONFIG_HOME/piw/config.toml`, then `~/.config/piw/config.toml`:

```toml
[theme]
name = "catppuccin"
auto_switch = false
dark_name = "catppuccin"
light_name = "catppuccin-latte"

[theme.custom]
# canvas_bg = "#1e1e2e"
# node_bg = "#313244"
# accent = "#89b4fa"

[ui]
# sidebar_width = 34
# inspector_height = 16
```

`PIW_THEME` overrides the config file and `--theme` overrides both. Custom
colors accept `#rrggbb`, `#rgb`, `rgb(r,g,b)`, named terminal colors, and
`reset`. Invalid fields are reported without discarding valid fields.

When `auto_switch` is enabled, `PIW_THEME_APPEARANCE=dark|light` or the server's
`COLORFGBG` value selects `dark_name` or `light_name` at startup. A manual
selection in the picker disables automatic switching.

## Replay semantics

A session-bound run uses the temporal session event journal as its replay
track. `-1` means before capture and `None` means latest/live. Each event cursor
folds text, thinking, tool calls, and tool execution through that event's
sequence. PIW keeps a workflow-step selection beside the temporal cursor so
the graph, trace, and attempt inspectors stay aligned. Runs without session
events retain step-based replay.

Playback uses event timestamps at 1x, 2x, 5x, or 10x and breaks timestamp ties
by event sequence. Step-only runs use the 700 ms base interval. Seeking
backward detaches from live. Active runs show a Live button that rejoins the
latest event and enables graph follow. Finished runs omit that button; End
jumps to their latest event. A viewer already at latest follows newly appended
events. A detached viewer stays at its chosen position. Rewinding
never changes graph geometry because card size and layout depend only on the
persisted definition snapshot.

Graph follow is on by default and is shown as `FOLLOW` in the graph title. It
centers the running node, the waiting checkpoint, or the selected replay step,
including nodes at the graph edges and graphs smaller than the viewport. `f`
toggles follow. Keyboard or mouse panning turns it off; `f`, `0`, or returning
to the latest position turns it back on.

The conversation folds `session_events` rows through the temporal cursor.
Unsealed messages stay visible as partial output. A settled `message_finished`
with `entryId` switches that message to the matching verbatim `session_entries`
row. Capture failures, sequence gaps, count mismatches,
and reconciliation diagnostics remain visible. Conversation auto-follow stays
at the bottom until the user moves to an older message and returns with End.

## Remote behavior

The client reconnects automatically with bounded backoff. It restores the run
listing and selected-run subscription after the server returns. Cached content
stays visible but is labeled reconnecting or disconnected, never current.
Revision gaps force a bounded snapshot.

`piw serve` is a frame relay. It keeps no run projection or client activity after either side closes. Clients keep separate revision and page cursors, so one client's replay jump does not move another client. A lagged client gets a bounded snapshot instead of an unbounded patch backlog.

The server resolves expanded prompt and output fields from durable content. Local and remote snapshots carry the same bounded semantic view and do not expose a database path.

## Interaction

- Replay: `[`/`]` previous/next, Space play/pause, Home or `g` to start, End
  to jump to latest, and `{`/`}` to change speed. Active runs also show Live;
  `G` and `L` are its keyboard shortcuts.
- Focus: Tab cycles Runs → Graph → Inspector. Click the full `[symbol Tab]`
  buttons, or use `t` or `1`–`4`, to change inspector tabs.
- Graph: arrows or `hjkl` pan, `0` resets, `f` toggles centered follow, and
  `z`, `+`, or `-` switches boxed/compact density. Clicking a node selects its
  latest visible attempt. Dragging inside the graph pans.
- Browser: `b` expands or collapses it. Up/Down or `j`/`k` selects a run. Drag
  its right border to resize it.
- Inspector: Enter expands the selected step, trace payload, or conversation
  entry. In Trace, `v` changes scope. In Info, `<` and `>` load the previous or next settings, follow-up, and current-update pages. Page Up/Down scrolls long content. Drag its top border to resize the bottom panel.
- Theme: `,` opens the picker; arrows or `j`/`k` preview. Click `[✓ Apply]` or
  `[× Cancel]`; Enter and Escape remain the keyboard equivalents.
- `q` or Ctrl-C quits.

## TypeScript renderer parity

The Rust and TypeScript renderers must reproduce the same plain graph and
layout fixtures under `fixtures/layout/`. Theme backgrounds and ratatui styles
are Rust-only and do not change plain fixture output. Any node text or geometry
change must be made in both renderers and committed with regenerated fixtures:

```bash
npm run fixtures
```
