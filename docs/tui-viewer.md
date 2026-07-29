# Rust TUI viewer (piw)

`tui/` contains `piw`, a Rust terminal viewer for workflow runs. It renders
the same graph as the bundled TypeScript viewer (pinned by the golden
fixtures under `fixtures/layout/`) and adds live following, full replay with
a transport bar, and a conversation pane fed by the recorded Pi session
entries.

## Modes

- `piw` — browse and view runs from the local runs directory
  (`PI_WORKFLOWS_RUNS_DIR` or `~/.pi/agent/workflows/runs`).
- `piw <runId|runDir>` — open one run directly (a bare run id resolves
  inside the default runs directory).
- `piw serve [--runs-dir <dir>] [--bind 127.0.0.1:9377]` — expose the runs
  directory over the [live replay protocol](live-replay-protocol.md). Only
  loopback addresses are accepted; tunnel over SSH to view runs remotely.
- `piw --connect ws://…` — view runs served by another process or machine.

Direct filesystem mode and connected mode share the same semantic-state code;
the protocol is the network form of the in-process state.

## Layout

```
┌ runs ─────────┬ graph ──────────────────────────────┐
│ ● two-turn    │       ┌────────┐                    │
│ ○ autoimpl…   │       │ plan ✓ │                    │
│ ○ echo        │       └───┬────┘                    │
│               │       ┌───▼────────┐                │
│               │       │ implement ◐│                │
│               │       └────────────┘                │
├───────────────┴─────────────────────────────────────┤
│ inspector: [output] [prompt] [conversation] [trace] │
│ …                                                   │
├─────────────────────────────────────────────────────┤
│ ⏮ ◀ ▶ ⏭  ▮▮▮▮▮▮▯▯▯▯ 12/17  LIVE                    │
└─────────────────────────────────────────────────────┘
```

- **Runs sidebar**: every bundle, most recent first, with status glyph,
  title (or workflow name), and elapsed time. Runs stuck in `running`
  without file growth are marked _possibly interrupted_ (`?`).
- **Graph pane**: the workflow DAG, laid out with the same algorithm as the
  TypeScript viewer (layering, barycenter ordering, virtual cells for long
  edges). Node states derive from the steps visible at the current replay
  position: queued, active, completed, failed, waiting, cancelled. Taken
  edges are highlighted; back-edges (loops) route through a right-hand
  gutter. The camera follows the active node by default; panning detaches
  it.
- **Inspector**: tabs for steps (with the selected step's prompt, output,
  action receipt, and error), the raw trace events (tailing while live),
  the conversation (see below), and run info. In direct filesystem mode,
  artifact references in previews are resolved by reading the bundle;
  connected mode shows compact placeholders.
- **Transport bar**: run status and elapsed time, the replay position
  (`step n/m` or `LIVE`), a play indicator, and the key hints. Following
  the live edge is the default; any backward navigation detaches, and
  `G`/`L`/`End` jump back to live.

## Replay semantics

Replay position is a step index (`-1` = before any step; detached from live
whenever it is set). The view at a position derives everything from the
steps visible up to it — graph statuses, taken transitions, the in-flight
transition, and the conversation reveal — matching the TypeScript renderer's
scrubbing semantics exactly. Rewinding is stable: layouts do not reflow
while scrubbing (the graph depends only on the definition snapshot).

The conversation pane renders the recorded Pi session entries (user prompts,
assistant messages, tool results) with progressive reveal in replay: entries
past the last visible step's `conversation` range stay hidden, using the
explicit entry ranges in step records — never heuristics. The selected
step's entry range is highlighted in the gutter, so an attempt's exact
conversation slice is always visible.

## Interaction

- Replay (global): `[`/`]` step back/forward, `space` play/pause, `Home`/`g`
  to start, `End`/`G`/`L` to live.
- Focus: `Tab` cycles Runs → Graph → Inspector; panes react to `↑↓`/`jk`
  (select run, pan, scrub or scroll), `t`/`1`–`4` switch inspector tabs.
- Graph: arrows/`hjkl` pan, `0` resets, `f` toggles follow, `z` (or
  `+`/`-`) switches node density between line and box style — the same two
  renderings as the TypeScript viewer.
- Mouse: wheel scrolls the pane under the cursor, drag pans the graph,
  click selects runs and focuses panes.
- `q` or `Ctrl-C` quits.

## Parity with the TypeScript viewer

The layout and render port must reproduce the golden fixtures
byte-for-byte (`fixtures/layout/*.json`; regenerate with `npm run
fixtures`). Any intentional algorithm change updates the fixtures and both
implementations in the same commit.
