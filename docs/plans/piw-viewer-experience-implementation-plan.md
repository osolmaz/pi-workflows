# PIW viewer experience implementation plan

## Objective

Make `piw` a state-rich, terminal-native workflow viewer with Catppuccin as
its complete default visual system, a Herdr-style theme picker, clearer replay
and run states, a useful inspector, a real timeline, and resilient remote
viewing.

The result is verified by styled ratatui buffer tests, graph parity fixtures,
remote reconnect tests, real-run end-to-end tests, and manual PTY checks across
dark, light, narrow, and wide terminal layouts.

## Boundaries

- Keep `piw` a standalone Rust TUI. Do not imitate browser-only effects such
  as shadows, smooth camera animation, or fractional text animation.
- Do not modify Pi internals or undocumented Pi APIs.
- Do not write or rewrite Pi session history.
- Do not change the workflow run-bundle schemas or persisted run documents.
- Persist only viewer preferences under the user's normal config directory.
  Do not store replay positions, run data, or session data there.
- Preserve the existing TypeScript/Rust graph layout contract. Any textual or
  geometric graph change must be made in both renderers and reflected in the
  shared fixtures.
- Keep compact line nodes as an optional density mode; bordered nodes remain
  the default.
- Keep all remote access loopback-only unless the existing SSH-tunnel workflow
  is used.

## Product decisions

### Terminal-native ACPX parity

Adopt ACPX ideas that improve inspection and state comprehension:

- semantic, surface-backed graph nodes;
- separate running and replay-focus presentation;
- a visible timeline and playback speed controls;
- detailed attempt and event inspection;
- graph-node selection;
- a collapsible run browser;
- structured tool-call and tool-result rendering; and
- reliable live reconnection.

Do not adopt ELK, React Flow, browser card decoration, smooth zoom, animated
edges, multiple ACP-session concepts, or character-by-character replay.

### Stable full node cards

Box mode is the canonical graph presentation. Each node is a full card with a
border, an interior surface, and enough padding to keep its outer dimensions
stable. Compact line mode remains an explicit density option and does not set
the box-mode contract.

The graph computes one card width and one card height before it runs layout.
Every real node uses those dimensions. The calculation uses the largest card
required by the immutable definition and reserves fixed rows for every runtime
field. Shorter cards receive blank padding. A status change, timer tick, new
attempt, replay seek, selection change, or live event may replace text inside a
reserved slot, but it must never resize a node or move the graph. Terminal
resize changes the viewport only. A small viewport pans over the graph instead
of shrinking or clipping cards.

A full card contains the same classes of information as an ACPX workflow card:

- the exact node id and full node type;
- a status symbol with its text label;
- semantic markers for start, branch count, and terminal position;
- every branch label associated with the node;
- not-visited or attempt-count metadata;
- live elapsed time or final duration; and
- the complete node `statusDetail` or short terminal outcome when present.

Use the established symbols consistently:

| Meaning       | Symbol |
| ------------- | ------ |
| queued        | `·`    |
| running       | `◐`    |
| replay focus  | `◆`    |
| completed     | `✓`    |
| failed        | `✗`    |
| timed out     | `×`    |
| waiting       | `⏸`    |
| cancelled     | `~`    |
| start node    | `▶`    |
| branch node   | `◇N`   |
| terminal node | `■`    |

Node-card fields must not use ellipses or disappear because another state needs
the space. Long fixed text wraps during the initial card measurement, and all
nodes are padded to the resulting graph-wide dimensions. Prompts, outputs,
errors, tool payloads, and other unbounded attempt details remain in the
inspector; they are not node-card fields.

### Theme model

Use a purpose-built `piw` theme contract rather than Pi's 51-token theme JSON
format. `piw` is a standalone viewer and needs graph, timeline, run-state, and
node-surface tokens that Pi themes do not define.

Use the same operating model as Herdr:

- Catppuccin Mocha is the default;
- built-in dark and light themes are selectable;
- moving through the picker previews immediately;
- Apply persists the choice;
- Cancel restores the exact original palette;
- config and CLI selection are supported; and
- optional per-token overrides layer on top of a built-in palette.

The initial built-in list should match Herdr's user-facing list and names:

- `catppuccin`
- `catppuccin-latte`
- `terminal`
- `tokyo-night`
- `tokyo-night-day`
- `dracula`
- `nord`
- `gruvbox`
- `gruvbox-light`
- `one-dark`
- `one-light`
- `solarized`
- `solarized-light`
- `kanagawa`
- `kanagawa-lotus`
- `rose-pine`
- `rose-pine-dawn`
- `vesper`

Theme names are normalized by lowercasing and replacing spaces and underscores
with hyphens. Unknown names produce a visible diagnostic and fall back to
Catppuccin instead of panicking.

### Surface hierarchy

Every frame must be painted from theme tokens. Do not rely on the terminal's
default background except in the explicit `terminal` theme.

For Catppuccin Mocha, use a clear hierarchy:

- application background: Crust (`#11111b`);
- panel background: Mantle (`#181825`);
- graph canvas: Base (`#1e1e2e`);
- ordinary node surface: Surface 0 (`#313244`);
- selected/running node surface: Surface 1 (`#45475a`);
- main text: Text (`#cdd6f4`);
- secondary text: Subtext 0 (`#a6adc8`);
- muted lines: Overlay 0 (`#6c7086`);
- accent/running: Blue (`#89b4fa`);
- replay focus: Mauve (`#cba6f7`);
- completed: Green (`#a6e3a1`);
- waiting: Yellow (`#f9e2af`);
- failed: Red (`#f38ba8`);
- timed out/interrupted: Peach (`#fab387`);
- branch/tool accent: Teal (`#94e2d5`).

A node box must always have a background distinct from its graph canvas. State
is carried primarily by the border, glyph, and accent text rather than by
painting every state a different card color.

## Theme architecture

### Semantic palette

Add `tui/src/theme/` with a `Theme` or `Palette` value containing semantic
colors rather than component-specific ad hoc styles. At minimum, define:

- surfaces: `appBg`, `panelBg`, `canvasBg`, `nodeBg`, `nodeFocusBg`,
  `selectionBg`, `surfaceDim`;
- structure: `border`, `borderFocused`, `edge`, `edgeBack`, `edgeTaken`;
- text: `text`, `subtext`, `muted`;
- interaction: `accent`, `replayFocus`;
- state: `running`, `success`, `warning`, `error`, `timedOut`, `cancelled`;
- content: `branch`, `user`, `assistant`, `tool`; and
- timeline: `timelineTrack`, `timelineFill`, `timelineThumb`.

Components must request semantic styles from the active theme. Remove direct
`Color::Cyan`, `Color::Green`, and similar choices from `tui/src/ui/` and
`tui/src/ui/conversation.rs`. Literal colors should remain only in built-in
palette definitions, color parsing, and theme tests.

### Canvas roles and node backgrounds

The current `CanvasStyle` combines node and edge meanings, and sparse spaces
cannot carry a background. Replace it with semantic canvas roles that
separate:

- ordinary text;
- muted text;
- queued, taken, active, and back edges; and
- queued, running, replay-focused, completed, failed, timed-out, waiting, and
  cancelled nodes.

Add an intentional-space/fill operation to `CharCanvas` so every cell inside a
bordered node carries `nodeBg` or `nodeFocusBg`. Draw the node surface before
its border and content, and ensure graph edges cannot bleed through node
interiors.

Node content should use separate roles for the status glyph, node id, node
type, and metadata instead of applying one color to the whole line. Plain-text
fixture output must remain deterministic.

### Configuration

Add viewer configuration at:

1. `PIW_CONFIG_PATH`, when set;
2. `$XDG_CONFIG_HOME/piw/config.toml`; or
3. `~/.config/piw/config.toml`.

Use this shape:

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
```

Color values accept `#rrggbb`, `#rgb`, `rgb(r,g,b)`, named terminal colors,
and `reset` aliases. Invalid overrides are reported and ignored individually;
they do not invalidate the entire theme.

Configuration precedence is:

1. an explicit picker selection made during the current session;
2. `--theme <name>`;
3. `PIW_THEME`;
4. config file; and
5. `catppuccin`.

Add `--list-themes`. A picker Apply writes only the theme selection, preserves
unknown config keys and comments, and uses a same-directory temporary file plus
atomic rename. Applying a manual theme disables `auto_switch`, matching Herdr.

Host light/dark detection and automatic sibling switching are a final theme
phase, not a prerequisite for manual theme selection. When added, query the
host terminal background only through standard terminal escape sequences,
restore terminal modes on exit, and retain the manually configured theme when
the terminal does not answer.

### Theme picker

Add a modal opened with `,`:

- list every built-in theme;
- show compact color swatches;
- preview on Up/Down, `j`/`k`, or mouse selection;
- Apply with Enter;
- Cancel with Escape and restore the original palette exactly;
- mark the persisted/current theme with a checkmark; and
- show config write errors inside the modal without closing it.

The modal must be usable at 80x24, clip or scroll at smaller sizes, and paint
its own panel background. Update the footer help to advertise the picker
without displacing essential replay controls.

## State presentation

Replace the current overloaded active state with these distinct graph states:

- queued;
- running;
- replay focus;
- completed;
- failed;
- timed out;
- waiting;
- cancelled.

Requirements:

- Running uses the active glyph, active color, live elapsed timer, and heavy
  border.
- Replay focus uses a distinct glyph/color and heavy border, but never says or
  looks like it is currently running.
- Timed out has a width-stable glyph and the `timedOut` color instead of using
  the failed presentation.
- Waiting remains distinct.
- `paused: true` is visible in the graph title and transport even if the run's
  persisted status is `running`.
- `statusDetail`, `waitingOn`, and run errors are shown consistently without
  overflowing node cells.
- `(live)`, `(latest)`, and `(replay)` remain separate from the persisted run
  outcome.

Where glyph or node text changes affect graph fixture output, update both
`src/render/` and `tui/src/render.rs`, regenerate the fixtures, and retain
byte-for-byte plain rendering parity.

## Inspector

Refactor the inspector out of `tui/src/ui/mod.rs` into focused modules and make
it useful for debugging without changing bundle data.

### Steps

- Keep the visible attempt list.
- Provide summary and expanded detail modes.
- Render full wrapped prompt, output, and error content in expanded mode.
- Render complete action receipts: action type, command, arguments, working
  directory, exit code, signal, and duration.
- Show the selected attempt id and timestamps.
- Resolve local artifact-backed fields within existing containment and size
  limits.
- Use a side-by-side attempt-list/detail layout when wide and a stacked layout
  when narrow.

### Trace

Make trace rows selectable and add three explicit scopes:

- selected attempt;
- replay-visible trace; and
- full run.

For replay-visible trace, derive the cutoff from events associated with the
visible attempt ids and include run-level events only up to that sequence. The
full-run mode must be labeled because it can reveal events after the current
replay position.

Enter expands the selected event's sanitized JSON payload. Preserve trace tail
following only while the user is at the bottom and the scope includes live
events.

### Info

Keep and theme the existing run Info tab. Continue showing source, status,
status detail, error, counts, interruption warning, and final output.

Store selection and scroll state per inspector tab so switching tabs does not
lose the user's place.

## Replay timeline

Replace the text-only footer with a responsive terminal timeline:

- a Unicode track, completed segment, and playhead;
- `step n/m`, before-first, latest, and LIVE labels;
- mouse click and drag seeking;
- previous, play/pause, next, start, and latest hit areas;
- 1x, 2x, 5x, and 10x playback speeds;
- the existing `[`, `]`, Space, Home, End, `g`, `G`, and `L` controls; and
- `{` and `}` for slower/faster playback.

Playback remains discrete. At 1x, retain the current 700 ms step interval;
other speeds divide that interval. Do not synthesize fractional attempt state.

Use two footer rows when the terminal has enough height and a compact one-row
fallback in short terminals. Seeking backward detaches from live; selecting
latest rejoins live. Appended steps advance automatically only when the viewer
was already following latest.

## Remote reliability and artifacts

Refactor `RemoteRuns` into a reconnecting client:

- bounded exponential backoff with jitter;
- explicit connecting, reconnecting, connected, and disconnected states;
- automatic `watch_runs` and selected-run resubscription after reconnect;
- existing revision-gap resnapshot behavior;
- cached data remains visible with a prominent stale/disconnected label; and
- dropping the client stops and joins the background worker cleanly.

Do not treat commands sent while offline as delivered. Keep desired
subscriptions in shared state and reconcile them after each successful hello.

Wire the existing artifact protocol into the inspector. Cache bounded artifact
content by `(runId, path)`, serialize requests so the current protocol's errors
can be associated with the outstanding request, and retain path containment
and maximum-size checks. Do not change the replay protocol schema for this
feature.

## Graph and run-browser interaction

### Graph semantics

Replace the current one-line box interior with the stable full-card contract.
Every boxed node shows identity, type, current status, semantic markers, and
branch labels. It also shows attempt metadata and timing plus the available
short detail or outcome. The exact node id remains visible.

Compute canonical graph-wide card dimensions before placing ranks and routing
edges. Pass those fixed bounds into layout, drawing, camera targeting, mouse hit
testing, and edge attachment. Fill unused rows and columns with intentional
node-surface padding. Live and replay updates redraw card cells without
re-running layout.

Keep branch labels on edges as routing labels and repeat them inside branch
cards as node metadata, matching ACPX. Show all labels instead of taking a
fixed prefix.

Implement card measurement and rendering in both graph renderers, regenerate
parity fixtures, and verify that every replay position has identical
`NodeBounds` for each node.

### Graph selection

Return node bounds with the rendered canvas. Use those bounds for:

- precise active/replay camera targeting instead of searching styled text;
- mouse hit testing; and
- selecting the latest visible attempt for a clicked node.

A queued node click may focus the definition node but must not invent an
attempt. Panning and clicking must remain distinguishable by a drag threshold.

### Run browser

Add expanded and collapsed browser modes:

- expanded retains title, status, elapsed time, and interrupted marker;
- collapsed is a narrow status rail;
- `b` toggles the mode;
- a single directly opened run continues to hide the browser; and
- narrow terminals start collapsed without overwriting an explicit user
  toggle during that session.

Theme selected rows with `selectionBg` and preserve a visible status color in
both modes.

## Conversation rendering

Keep Pi's recorded session entries and explicit conversation ranges as the
authoritative source.

- Preserve replay-safe progressive reveal; do not show future messages while
  rewound.
- Preserve the selected attempt's visible gutter.
- Render tool calls with tool name and a compact argument summary.
- Render tool results with running/success/error state and a short preview.
- Let Enter expand the selected tool payload as sanitized JSON.
- Add sticky live auto-follow: remain at the bottom while new entries arrive,
  detach when the user scrolls upward, and reattach with End.
- Keep thinking text distinguishable but readable under every built-in theme.

Do not add a multiple-session selector; the current bundle contract records one
Pi conversation per run.

## Responsive layout

Introduce explicit layout tiers rather than relying only on percentages:

- **wide:** run browser, graph, and split attempt detail use available width;
- **standard:** current graph-over-inspector layout;
- **narrow:** collapsed browser, compact timeline, and stacked inspector; and
- **very short:** one-row transport and minimum viable pane titles.

Every tier must preserve access to run status, replay position, graph content,
and inspector tabs. Avoid silently dropping information solely because the
terminal resized.

## Implementation sequence

### 1. Theme foundation

- Add semantic palette, built-ins, parser, config loader, CLI override, and
  Catppuccin default.
- Paint the full frame and every panel from palette surfaces.
- Replace all hard-coded UI colors.
- Add node-surface canvas roles and filled node rectangles.
- Add styled buffer tests for Catppuccin and one light theme.

Exit criterion: Catppuccin is visibly applied to the whole viewer, and every
boxed node has a surface color distinct from the graph background.

### 2. Theme picker and persistence

- Add the `,` modal with preview/apply/cancel and mouse support.
- Persist atomically while preserving unrelated config.
- Add all Herdr-aligned built-ins and custom overrides.
- Add invalid-config diagnostics and `--list-themes`.

Exit criterion: a user can preview, cancel, apply, restart, and retain any
built-in theme.

### 3. State correctness

- Split running from replay focus.
- Add timed-out and paused presentation.
- Apply semantic state colors consistently to graph, run rows, inspector, and
  timeline.
- Update both renderers and fixtures where plain graph output changes.

Exit criterion: no historical replay position appears live, and every persisted
run/node state has a distinct tested presentation.

### 4. Inspector depth

- Refactor inspector modules.
- Add full attempt details and complete action receipts.
- Add selectable trace scopes and expandable payloads.
- Preserve per-tab selection and scroll state.

Exit criterion: all existing step and trace fields can be inspected without
opening bundle files manually.

### 5. Replay timeline

- Add the responsive timeline, hit areas, seeking, and speeds.
- Keep discrete deterministic playback and live-follow semantics.

Exit criterion: keyboard and mouse can seek any recorded step and reliably
return to live.

### 6. Remote resilience

- Add reconnect state machine, resubscription, cancellation, and server-restart
  tests.
- Connect remote artifact fetching to expanded inspector fields.

Exit criterion: restarting `piw serve` does not require restarting the viewer,
and cached data is never presented as current while disconnected.

### 7. Graph and browser interaction

- Replace one-line boxed interiors with stable full node cards.
- Measure one canonical card size from all node-card fields before layout.
- Add node bounds and click selection.
- Add start/end semantics and branch metadata in both renderers. Include status
  and attempt counts. Timing and the short detail use their own slots.
- Add collapsed run browser and responsive layout tiers.

Exit criterion: every node-card field is visible, node bounds stay unchanged
across every live and replay state, graph nodes are selectable, and an
80-column terminal remains usable through panning.

### 8. Conversation polish and host-theme switching

- Add structured tool rows, expansion, and sticky auto-follow.
- Add optional host appearance detection and dark/light sibling switching.
- Verify terminal state restoration after normal exit, errors, and Ctrl-C.

Exit criterion: live tool activity remains readable and auto-switching never
leaves terminal modes or colors altered after exit.

## Expected file changes

Likely additions:

```text
tui/src/theme/mod.rs
tui/src/theme/builtins.rs
tui/src/theme/config.rs
tui/src/ui/theme_picker.rs
tui/src/ui/timeline.rs
tui/src/ui/inspector.rs
tui/src/ui/runs.rs
```

Likely modifications:

```text
tui/Cargo.toml
tui/src/main.rs
tui/src/lib.rs
tui/src/canvas.rs
tui/src/render.rs
tui/src/client.rs
tui/src/ui/mod.rs
tui/src/ui/graph.rs
tui/src/ui/conversation.rs
src/render/*                 # only for shared graph text/geometry changes
fixtures/layout/*            # regenerated only when shared output changes
docs/tui-viewer.md
docs/development.md
README.md
```

Avoid leaving theme logic split between components. Palette definitions,
parsing, resolution, and style derivation belong under `tui/src/theme/`.

## Verification

### Unit tests

- Every built-in theme resolves by canonical name and documented aliases.
- Catppuccin is the default.
- Invalid theme names and colors fall back predictably with diagnostics.
- Config precedence and atomic save behavior are deterministic.
- Picker preview, Cancel, and Apply preserve the correct palette.
- Every non-terminal built-in has distinct `canvasBg` and `nodeBg` values.
- Styled ratatui buffers contain the expected frame, panel, canvas, node, and
  focused-node backgrounds.
- No state shares the wrong semantic role, especially failed/timed-out and
  running/replay-focus.
- Timeline coordinate mapping is correct at step `-1`, first, middle, latest,
  and after terminal resize.
- Trace replay cutoffs cannot reveal later attempt events.
- Node hit testing accounts for viewport offsets.
- Every boxed node in one graph has the same outer dimensions.
- Node bounds remain identical across every runtime state. Selection and replay
  focus also leave the bounds unchanged.
- Long node ids, status details, and branch labels wrap without truncation and
  without changing the graph-wide card size after layout.
- Every documented status and semantic symbol appears with the matching text
  label and color role.

### Integration tests

- Existing plain graph parity fixtures are regenerated for the full-card
  geometry and continue to match between TypeScript and Rust.
- Shared fixtures assert identical node bounds at every replay position.
- Theme changes do not alter plain fixture output unless an intentional shared
  graph change updates both renderers.
- A remote client reconnects after a server restart and receives a fresh
  snapshot.
- Subscription changes made while disconnected are reconciled after reconnect.
- Local and remote expanded artifact views enforce the same size and path
  limits.
- Narrow and wide TestBackend layouts retain all required controls.

### Manual PTY checks

Exercise at least:

- Catppuccin Mocha at 80x24 and 140x40;
- Catppuccin Latte on a light terminal;
- `terminal` theme with a custom terminal palette;
- a completed run, a live run, a waiting run, a timed-out run, and a cancelled
  run;
- replay before the first step, detached replay, and return to live;
- theme preview followed by Cancel and Apply;
- a stopped and restarted remote server; and
- tool calls, action receipts, long output, and artifact-backed values;
- a graph containing every node state and semantic symbol; and
- long ids, status details, and branch labels in an 80-column viewport.

### Repository checks

Before finishing each coherent implementation slice, run the relevant focused
Rust tests. Before finishing the complete work, run:

```bash
cargo fmt --check --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path tui/Cargo.toml
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

## Completion criteria

The work is complete when:

1. Catppuccin Mocha is the default and colors every visible viewer surface.
2. Boxed nodes are full cards with one stable graph-wide size, intentional
   padding, and every documented card field visible without truncation.
3. Users can preview, apply, persist, and cancel built-in theme choices from
   the TUI.
4. No component chooses ad hoc colors outside the theme layer.
5. Running, replay focus, completed, failed, timed out, waiting, cancelled,
   paused, latest, replay, and live states are unambiguous.
6. Full attempt, action, trace, run, and conversation details are inspectable.
7. The timeline supports keyboard and mouse seeking plus playback speeds.
8. Remote viewing reconnects safely and labels stale cached data.
9. Graph selection and the collapsed browser work in narrow terminals.
10. Node status and semantic markers use the documented ACPX-style slots and
    symbols. Attempt counts and timing use reserved slots, as do short details,
    without changing node bounds.
11. Graph parity, bundle schemas, Pi session state, and Pi internals remain
    unchanged except for intentional shared renderer fixture updates.
