# Rust TUI viewer (piw)

`tui/` contains `piw`, a Rust terminal viewer for workflow runs. It renders
the same graph as the bundled TypeScript viewer (pinned by the golden
fixtures under `fixtures/layout/`) and adds live following, full replay with
a transport bar, and a conversation pane fed by the recorded Pi session
entries.

## Modes

- `piw` — browse and view runs from the local runs directory
  (`PI_WORKFLOWS_RUNS_DIR` or `~/.pi/agent/workflows/runs`).
- `piw <runId|runDir>` — open one run directly.
- `piw serve [--bind 127.0.0.1:0]` — expose the runs directory over the
  [live replay protocol](live-replay-protocol.md).
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
  workflow name, title, and elapsed time. Runs stuck in `running` without
  file growth are labelled _possibly interrupted_.
- **Graph pane**: the workflow DAG, laid out with the same algorithm as the
  TypeScript viewer (layering, barycenter ordering, virtual cells for long
  edges). Node states at the current replay position: pending, running,
  ok, failed, waiting. Taken edges are highlighted; back-edges (loops) are
  drawn as return paths.
- **Inspector**: tabs for the selected step — accepted output, full prompt,
  the conversation slice (see below), and the raw trace events. Artifact
  references are resolved transparently.
- **Transport bar**: replay position over the trace (`seq`), play/pause with
  adjustable speed, step forward/back, jump to start/end, and a LIVE
  indicator. Following the live edge is the default for non-terminal runs;
  any backward navigation detaches, and `L` jumps back to live.

## Replay semantics

Replay position is a trace `seq`. The view at position `n` is the state
reconstructed from events `1..=n` — the graph, steps, and conversation all
derive from the same position, so scrubbing is coherent across panes.
Rewinding is stable: layouts do not reflow while scrubbing (the graph depends
only on the definition snapshot).

The conversation pane renders the recorded Pi session entries (user prompts,
assistant messages, tool results) with progressive reveal in replay: entries
appear at the position of the step that produced them, using the explicit
`conversation` entry ranges in step records. Entries outside any attempt
range (user interruptions, nudges between steps) are shown attributed to the
gap between steps.

## Interaction

- Keyboard: arrows/`hjkl` pan, `+`/`-` zoom density, `tab` cycles inspector
  tabs, `space` play/pause, `[`/`]` step, `g`/`G` start/end, `L` live,
  `enter` open run, `q` back/quit.
- Mouse: wheel scrolls, drag pans the graph, click selects nodes and steps.
- Zoom densities switch node rendering between full boxes, compact boxes,
  and line style — same set as the TypeScript renderer.

## Parity with the TypeScript viewer

The layout and render port must reproduce the golden fixtures
byte-for-byte (`fixtures/layout/*.json`; regenerate with `npm run
fixtures`). Any intentional algorithm change updates the fixtures and both
implementations in the same commit.
