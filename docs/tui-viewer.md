# Rust TUI viewer (piw)

`tui/` contains `piw`, a Rust terminal viewer for workflow runs. It renders
the same graph as the bundled TypeScript viewer, pinned by the golden fixtures
under `fixtures/layout/`, and adds live following, replay, detailed inspection,
a recorded Pi conversation, themes, and remote viewing.

## Modes

- `piw` browses the local runs directory (`PI_WORKFLOWS_RUNS_DIR` or
  `~/.pi/agent/workflows/runs`).
- `piw <runId|runDir>` opens one run. A bare run id resolves inside the default
  runs directory.
- `piw serve [--runs-dir <dir>] [--bind 127.0.0.1:9377]` exposes the runs
  directory over the [live replay protocol](live-replay-protocol.md). Only
  loopback addresses are accepted; use an SSH tunnel for remote viewing.
- `piw --connect ws://…` reads from another `piw serve` process.
- `piw --theme <name>` selects a theme for this invocation.
- `piw --list-themes` prints the built-in theme names.

Direct filesystem mode and connected mode use the same semantic run view.
The protocol is the network form of that view.

## Layout

The normal layout contains a run browser, graph, inspector, and two-line replay
timeline. Short terminals use a compact one-line transport. Terminals below 100
columns start with the run browser collapsed to a status rail; `b` toggles it.
Drag the run browser's right border to resize it. Drag the inspector's top
border to resize the bottom panel. PIW saves both sizes in its viewer config and
clamps them when the terminal is smaller. A directly opened single run hides
the browser.

- **Run browser:** every bundle, newest first, with status, title, elapsed time,
  and a `?` marker for a possibly interrupted run.
- **Graph:** the complete workflow definition using the same layered layout as
  the TypeScript renderer. Full bordered cards are the default. Every card in
  one graph has the same width and height, fixed before layout, with reserved
  rows for status, exact id and type, graph markers, branch labels, attempts,
  timing, and short detail. Updates fill those rows without moving nodes or
  edges. Narrow terminals pan over the fixed graph. Compact line nodes remain
  available with `z`. Start nodes carry `▶`, branch nodes carry `◇N`, and
  terminal nodes carry `■`. Branch labels remain on edges and loops use a
  right-hand gutter.
- **Inspector:** Steps, Trace, Conversation, and Info tabs. Steps can expand to
  full prompt, output, timestamps, error, and action receipt fields. Trace can
  show the selected attempt, the replay-visible prefix, or the full run, with
  expandable JSON payloads. Conversation shows live text, thinking, tool-call
  construction, and tool execution, then switches settled messages to the
  verbatim Pi entry. Raw records remain expandable. Info shows run metadata,
  final output, capture status, counts, and integrity diagnostics.
- **Timeline:** run status, elapsed time, replay track, playhead, position,
  playback controls, and speed. The track and controls accept mouse clicks;
  the track supports drag seeking.

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
nodes use `×` and a separate color. The graph title distinguishes `(live)`,
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

When `auto_switch` is enabled, `PIW_THEME_APPEARANCE=dark|light` or the host's
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
backward detaches from live; selecting Live or pressing `G`, `L`, or End
rejoins it and enables graph follow. A viewer already at latest follows newly
appended events. A detached viewer stays at its chosen position. Rewinding
never changes graph geometry because card size and layout depend only on the
persisted definition snapshot.

Graph follow is on by default and is shown as `FOLLOW` in the graph title. It
centers the running node, the waiting checkpoint, or the selected replay step,
including nodes at the graph edges and graphs smaller than the viewport. `f`
toggles follow. Keyboard or mouse panning turns it off; `f`, `0`, or returning
to Live turns it back on.

The conversation folds `session/events.ndjson` through the temporal cursor.
Unsealed messages stay visible as partial output. A settled `message_finished`
with `entryId` switches that message to the matching verbatim record from
`session/entries.ndjson`. Capture failures, sequence gaps, count mismatches,
and reconciliation diagnostics remain visible. Live auto-follow stays at the
bottom until the user moves to an older message and returns with End.

## Remote behavior

The client reconnects automatically with bounded backoff. It restores the run
listing and selected-run subscription after the server returns. Cached content
stays visible but is labeled reconnecting or disconnected, never current.
Revision gaps still force a fresh snapshot.

Expanded remote prompt and output fields fetch artifact content on demand.
The client caches bounded responses while the server enforces bundle path,
symlink, and 4 MiB limits.

## Interaction

- Replay: `[`/`]` previous/next, Space play/pause, Home or `g` to start, End,
  `G`, or `L` to live, and `{`/`}` to change speed.
- Focus: Tab cycles Runs → Graph → Inspector. `t` or `1`–`4` changes inspector
  tabs.
- Graph: arrows or `hjkl` pan, `0` resets, `f` toggles centered follow, and
  `z`, `+`, or `-` switches boxed/compact density. Clicking a node selects its
  latest visible attempt. Dragging inside the graph pans.
- Browser: `b` expands or collapses it. Up/Down or `j`/`k` selects a run. Drag
  its right border to resize it.
- Inspector: Enter expands the selected step, trace payload, or conversation
  entry. In Trace, `v` changes scope. Page Up/Down scrolls long content. Drag
  its top border to resize the bottom panel.
- Theme: `,` opens the picker; arrows or `j`/`k` preview, Enter applies, and
  Escape cancels.
- `q` or Ctrl-C quits.

## TypeScript renderer parity

The Rust and TypeScript renderers must reproduce the same plain graph and
layout fixtures under `fixtures/layout/`. Theme backgrounds and ratatui styles
are Rust-only and do not change plain fixture output. Any node text or geometry
change must be made in both renderers and committed with regenerated fixtures:

```bash
npm run fixtures
```
