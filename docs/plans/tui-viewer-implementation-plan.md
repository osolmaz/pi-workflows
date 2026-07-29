# Rust TUI viewer — implementation plan

Goal: `piw`, a Rust TUI in `tui/` for live viewing and replaying workflow
runs, per [tui-viewer.md](../tui-viewer.md) and
[live-replay-protocol.md](../live-replay-protocol.md).

## Architecture

One crate, library-first with a thin binary:

```
tui/
  Cargo.toml            # package "piw"
  src/
    main.rs             # CLI (clap): browse / open / serve / connect
    bundle/             # serde types, bundle reader, NDJSON tailer, runs watcher
    source/             # RunSource: semantic run views + revisioned patches
    protocol/           # message types, JSON Patch+ apply/diff, WS server+client
    layout/             # port of src/render/graph.ts
    render/             # port of canvas.ts + graph-render.ts (cell canvas, viewport)
    ui/                 # ratatui app: panes, transport, input, camera
  tests/                # fixture parity, protocol round-trip, tailer tests
```

`RunSource` is the seam: the TUI consumes run views + patch streams the same
way whether they come from the local filesystem or a WebSocket.

## Steps

1. **Scaffold** — Cargo crate (ratatui, crossterm, tokio, tokio-tungstenite,
   notify, serde, clap), rustfmt/clippy config, CI job alongside the npm
   checks.
2. **Bundle module** — serde types mirroring `docs/run-bundles.md`, bundle
   reader (manifest-first, schema check, skip unknown), incremental NDJSON
   tailer tolerating torn lines, runs-directory watcher with polling
   fallback, artifact resolution with path containment.
3. **Layout port** — `layout/` reproduces `layoutGraph` exactly; parity test
   deserializes every `fixtures/layout/*.json` and compares ranks, edges,
   segments, and node ranks.
4. **Render port** — cell canvas + boxed/line graph renderer; parity test
   compares ANSI-stripped frames against fixture `frames`.
5. **Source + protocol** — `RunSource` builds run views, computes revisioned
   JSON Patch+ diffs, serves them over WebSocket (`piw serve`); client mode
   applies them. Round-trip test: filesystem view == connected view.
6. **TUI shell** — runs sidebar, graph pane with camera (follow/overview),
   inspector tabs, status line; live mode follows patches.
7. **Replay transport** — seq-based scrubber, play/pause with speed, step
   keys, detach-on-rewind, jump-to-live; per-position state reconstruction
   from the event log.
8. **Conversation pane** — render recorded session entries, progressive
   reveal by replay position, attempt-slice highlighting via `conversation`
   ranges, artifact-backed content on demand.
9. **Polish** — mouse drag/wheel, zoom density levels, keybinding help,
   terminal snapshot tests.

## Testing

- Golden parity against `fixtures/layout/` (regenerate with `npm run
fixtures`; update both implementations together).
- Tailer: torn lines, appends across reads, truncation detection.
- Protocol: snapshot+patch reconstruction equals direct view; revision gap
  forces resnapshot.
- End-to-end: run a workflow via the engine test harness, watch the bundle
  with the Rust source, assert the final view matches the bundle documents.
