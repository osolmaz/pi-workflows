---
title: Build the incremental and virtualized piw viewer
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-28
status: implemented
---

# Incremental and virtualized piw viewer plan

## Goal

Make `piw` stay fast as workflow history grows.

Pi Workflows will expose one canonical viewer projection for local and remote clients. Every viewer-visible change will advance one run presentation revision and produce a bounded, resumable JSON Patch delta directly from the committed change. Viewers will load small run-list rows, the graph state they need, and bounded pages around the current replay position.

The graph will use bounded adaptive cards. Each card will use space based on its own content. One long name or large switch will not enlarge unrelated cards.

This plan replaces the tactical indexed-worker design. That design would stop loading every run, but it would still poll and rebuild the complete selected run. The selected design removes that remaining scaling limit.

## Current problems

The current local viewer checks SQLite every 300 ms. Its run-list path loads every run in full, and its refresh path then loads every run again. It also reloads terminal runs. The UI performs this work on the same path that handles input and drawing.

A measured database contained 44 runs, 17,812 workflow events, 9,268 session entries, and 48,634 session events. The database was 97 MB. An eight-second all-runs check reached 370 MB peak RSS and used 1.29 CPU seconds. A single-run check reached 37 MB and used 0.04 CPU seconds.

Boxed graph mode also calculates one width and height for the whole graph. A 58-character hierarchical name and a 14-way switch made every card about 62 columns wide and 21 rows high. Most cards contained large empty areas.

## Boundaries

This design keeps SQLite as the canonical durable store. It keeps `piw` as a standalone Rust TUI and keeps the TypeScript graph renderer.

The implementation must not change workflow execution, saved Pi session content, full workflow history, theme behavior, keyboard or mouse meaning, replay meaning, or Pi extension boundaries.

The WebSocket server remains loopback-only. Remote use continues through an SSH tunnel. The design adds no external service, sidecar, cache database, or telemetry system.

The existing JSON Patch operations and `append` extension remain the change format. The implementation changes how patches are created and what they target. It must not rebuild two complete run views to find their differences.

Pi Workflows is in alpha. If the implementation needs a persisted contract change, it will replace the current `v1` contract in place. It will not add a migration shim, compatibility reader, dual read, dual write, feature flag, or `v2` contract. An incompatible database will fail with a clear reset instruction and remain untouched.

The repository source now implements this design. Release work, installation, and adoption of a new `piw` binary remain separate.

## Canonical viewer projection

One projection will serve local and remote viewers. It will have the following read surfaces:

- lightweight rows for the run list;
- graph state and replay metadata for one run;
- bounded timeline pages;
- bounded conversation pages;
- bounded inspector pages; and
- ordered JSON Patch deltas after a known run presentation revision.

Run-list rows contain only the fields needed by the browser, such as identity, title, status, timestamps, and interruption state. Building the list must not read run outputs, trace payloads, session entry bodies, or session event bodies.

The local viewer and `piw serve` must use the same projection rules. They may use different transports, but they must agree on revisions, cursors, pages, gaps, and failure recovery.

## Presentation revision

Each run has one authoritative presentation revision. The revision covers every fact that can change the viewer:

- run status and current position;
- node attempts and completed steps;
- workflow trace records;
- session segments, entries, and temporal events;
- live settings;
- follow-up queues and items;
- human decisions;
- leases and interruption state; and
- any other field exposed by the canonical viewer projection.

A transaction that changes one of these facts also advances the presentation revision. It creates the corresponding JSON Patch operations from the records changed by that transaction. The database commit makes the domain change, revision, and patch visible together. Patch creation must not read the previous complete run view or compare two complete run documents. A viewer must never observe a revision that does not describe the committed state.

The implementation must audit every durable writer that can change viewer output. A missing writer is a correctness bug because it can leave a viewer stale.

## JSON Patch deltas and cursors

A delta is an ordered list of the existing JSON Patch operations after one presentation revision. The current `add`, `replace`, `remove`, and `append` operations remain available. A client identifies the run and last revision it has applied.

Each patch targets one bounded projection document or one bounded page. It does not target one JSON document containing the complete run history. The envelope identifies the target document, run revision, and page revision or cursor needed to apply it safely.

The active timeline or conversation page can use `append` as new records arrive. An unloaded or evicted page is not rebuilt only to apply a patch. Its revision changes, and the client fetches the current page if it needs that range. Stable IDs and page boundaries prevent paths from depending on array positions outside the loaded page.

The server returns the next available patches when the cursor is valid. If the cursor is missing, invalid, or older than the retained patch window, the server returns a fresh bounded snapshot and the pages needed for the current view.

Applying patches in order must produce the same logical view as reading a fresh projection at the final revision. Duplicate patches must be harmless. A client rejects an out-of-order revision, malformed page, invalid path, or mismatched run ID without changing its current good view.

The canonical database retains bounded patch records or enough authoritative revisioned records to return the same patches without reconstructing full history. The implementation must prove bounded resume behavior and must not depend on an unbounded in-memory backlog.

## Paging and replay

Timeline, conversation, and inspector data use bounded pages. A page identifies its run, presentation revision, content range, and neighboring cursors.

The viewer loads the page that contains the current step, event, or time. It may prefetch a small number of neighboring pages. It evicts pages outside a documented memory window.

A jump to another time loads a page around that point. It does not load the complete timeline or conversation. The viewer may show a short loading state while the page arrives. The amount of data loaded for one jump stays bounded.

Replay order and timing keep their current meaning. The temporal session event sequence remains authoritative. Paging changes how the viewer obtains records, not how it interprets them.

Search and count displays must state whether they cover the complete run or only loaded pages. A complete search must use a bounded database query or a paged server operation. It must not silently search only the cache.

## Multiple clients

`piw serve` keeps one shared projection and cache for each watched run.

The first watcher starts that run's projection. Later watchers reuse it. Each client keeps its own revision cursor, selected replay position, and loaded pages. A database change is projected once and fanned out to every client that watches the run.

The server tracks a watcher count for each run. An unwatch request or client disconnect reduces the count. When the count reaches zero, the server releases the run projection and its pages. Different watched runs load independently. Unwatched runs do not load.

A slow client does not block projection work or delivery to other clients. If it falls behind the retained delta window, it receives a fresh bounded snapshot and the pages for its current position. The server does not keep an unbounded queue for that client.

Duplicate clients watching one run must not duplicate database reconstruction, graph layout, or delta generation.

## Client state and failures

The TUI applies database and network results away from the input and drawing path. Input, mouse handling, and frame drawing must not wait for a complete run read, page query, or graph layout.

The run list stays usable when one run fails to load. An initial failure shows a sanitized error for that run. A refresh failure keeps the last good view and marks it stale.

A revision gap causes a fresh bounded snapshot. A malformed page, invalid cursor, or wrong revision is rejected. The viewer keeps its last good state and requests recovery. Reconnect keeps the current stale label until a valid snapshot or delta stream resumes.

Shutdown cancels pending reads and joins local worker tasks. A disconnected client releases server watcher counts and page references.

## Semantic graph scene

Rust and TypeScript will consume one language-neutral semantic scene contract. The contract contains logical nodes and edges, display text, status, branch meaning, card bounds, edge ports, and stable scene identities.

A card calculates its width and height from its own content and then applies documented minimum and maximum bounds. Long text uses one deterministic overflow rule. The local node name remains visible. Full names, details, and branch cases remain available in the inspector.

Branch meaning stays on edges and in the selected-node inspector. A switch with many cases can summarize its card content, but it must keep every logical branch and full case label in the scene.

One node's label, detail, or branch count cannot change the size of another node. The current graph-wide maximum is removed.

Rust and TypeScript use the same size limits, text-width rules, branch order, overflow markers, ports, and fixture output. Unicode width behavior must be pinned by conformance fixtures.

## Retained layout and virtualization

The viewer keeps a retained logical graph scene between updates. A change updates the affected node or edge and recomputes only the ranks and routes that depend on it.

The renderer materializes viewport-near cards and edges. Off-screen graph items remain in the logical scene, so keyboard navigation, centering, search, and replay can still reach them.

Hit testing uses exact visible bounds. Edge routing uses exact node ports. Panning, following, clipping, and mouse selection use the same scene geometry.

The implementation must define the viewport margin and scene eviction rules. These bounds must be large enough to avoid visible popping during normal movement and small enough to keep memory independent of total graph size.

## Performance contract

The implementation must meet these structural rules:

- idle work does not grow with stored trace or session payload;
- an unchanged run causes no payload read;
- building the run list reads no payload bodies;
- client memory is bounded by run-list rows, watched-run metadata, configured page windows, and viewport-near scene data;
- two clients watching one run share projection and layout work;
- a replay jump loads a bounded page; and
- input handling never waits for full-history reconstruction; and
- patch creation never reads or compares complete old and new run views.

Benchmarks must report raw query counts, rows and bytes read, delta sizes, page loads, layout work, input-stall latency, CPU time, and peak RSS. They must use generated fixtures with increasing run count, trace size, session size, graph size, and client count.

Timing measurements must use repeated runs and report the median, range, and a high percentile. Query, load, and memory bounds are deterministic gates. Timing is supporting evidence and must include uncertainty.

The measured comparison points are 370 MB peak RSS for the all-runs view and cards of about 62 columns by 21 rows for the large Autoimplement graph. The new design must show that memory and card size no longer grow from unrelated history or unrelated nodes.

## Implementation sequence

### State revision

Update the durable state writer so every viewer-visible transaction advances the run presentation revision and creates its bounded JSON Patch operations directly. Add the authoritative revision and required bounded patch records to the current SQLite schema in place.

Audit run transitions, attempts, steps, trace, session capture, settings, follow-ups, decisions, leases, and interruption changes. Add one mutation test for each writer.

Exit when a fresh projection and directly created JSON Patch operations agree at every revision without a full-view diff.

### Projection reads

Add canonical read operations for run-list rows, graph state, replay metadata, timeline pages, conversation pages, inspector pages, bounded snapshots, and JSON Patch deltas.

Keep payload bodies out of run-list queries. Make page queries use indexed range bounds. Add query-plan tests and row-read counters.

Exit when increasing payload size does not change idle or run-list work.

### Local viewer

Replace full-run polling with revision checks, page requests, and bounded caches. Apply reads outside the input path. Add loading, stale, error, and recovery states.

Keep replay semantics, themes, input, and inspection behavior. Make arbitrary time jumps request the containing page.

Exit when a delayed database read does not delay synthetic keyboard or mouse input.

### Replay protocol

Keep the current JSON Patch protocol and `append` operation. Change the alpha protocol in place so each patch identifies its bounded projection document or page and carries the required presentation revision, page cursor, and recovery data. Keep the current loopback and browser-origin restrictions.

Update the server to share one directly created patch stream per watched run. Update the client to keep independent cursors and page caches. Remove complete run-view transfer, full-view diffing, and unbounded patch history.

Exit when local and connected viewers produce the same logical view at each revision.

### Graph scene

Define the semantic scene and bounded adaptive card rules. Port the same contract to Rust and TypeScript. Replace graph-wide card sizing with node-owned bounds.

Add retained rank and route updates, viewport materialization, exact hit testing, and full inspector detail. Regenerate shared fixtures.

Exit when long names and large switches do not resize unrelated cards and large graphs keep bounded materialized geometry.

### Multi-client recovery

Add shared watched-run caches, watcher counts, independent client cursors, slow-client recovery, disconnect cleanup, and bounded delivery queues.

Exit when many clients can watch one run without duplicate reconstruction and one stalled client cannot delay the others.

### Benchmarks and checks

Add generated scale fixtures for small and large histories, graphs, replay jumps, and client counts. Record raw structural and timing results. Compare them with the current measurements.

Run the full Rust, TypeScript, parity, protocol, end-to-end, and repository checks.

## Tests

Test presentation revision changes for every viewer-visible writer and remains unchanged for unrelated writes.

Test bounded snapshots plus ordered JSON Patch operations against a fresh projection at every revision. Prove that patch creation does not read a complete old or new run view. Cover `add`, `replace`, `remove`, `append`, duplicate, missing, stale, malformed, invalid-path, wrong-page, and wrong-run cases.

Test first-page, next-page, previous-page, arbitrary-time, end-of-run, active-tail, and evicted-page behavior for timeline, conversation, and inspector data.

Test run-list queries with large payload bodies and prove that no payload rows or blobs are read.

Test local and remote parity for current, replayed, reconnecting, stale, and recovered views.

Test several clients watching the same run, different runs, unwatching, disconnecting, falling behind, and reconnecting. Prove that one run is projected once and released after its last watcher leaves.

Test long labels, long local names, Unicode, large fan-out, loops, back edges, mixed card sizes, clipping, panning, following, centering, keyboard navigation, and mouse hit testing.

Test viewport materialization and retained layout with graphs much larger than the terminal. Prove that logical navigation still reaches off-screen nodes.

Test failure handling for database read errors, protocol gaps, invalid cursors, malformed pages, interrupted streams, and shutdown during a read.

Test performance with growing history and client counts. Assert deterministic query, load, page, cache, and materialized-node bounds. Report timing and memory separately.

## Verification

Run:

```bash
cargo fmt --check --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path tui/Cargo.toml
npm run fixtures
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Use a source-built `piw` in a PTY to verify run selection, replay jumps, box and line modes, panning, mouse selection, reconnect, several clients, and clean exit. Use only generated state for destructive or failure tests.

A read-only check against a real growing database may report aggregate counts, timings, query counts, and memory. It must not print workflow titles, prompts, outputs, session text, actor identifiers, channel references, or credentials. It must not write the database.

## Implementation record

The current alpha schema now stores `viewer_runs` and `viewer_deltas`. A run starts at presentation revision 1. Each viewer-visible write advances that revision in the same SQLite transaction and stores ordered target patches. The store retains 256 revisions. An older or invalid cursor requires a bounded snapshot.

Timeline, step, session-entry, and session-event pages contain at most 256 rows. Session rows have run-wide sequence numbers and indexed `(run_id, run_seq)` reads. Step pages keep full detail for the active replay window. A separate graph projection keeps only the latest attempt per node and the distinct taken transitions up to the replay cursor. Run-list reads use metadata and do not open payload blobs.

The local viewer checks `PRAGMA data_version`. An unchanged check does not scan the run list or load payloads. Local page reads use one overwrite-only worker request, so a newer selection replaces pending work. The source keeps the last good view after a read failure and marks it stale. Direct tail patches update a loaded page without another run read.

`piw serve` keeps one bounded projection and one retained graph scene for each watched run. Watchers share that state. Each client keeps its own revision and page cursors. Page requests do not change another client's window. A client that misses retained deltas receives a bounded snapshot and the pages it requests.

Boxed cards use a content width from 20 through 28 cells, which gives an outer width from 24 through 32 cells. A card has a 7-row core and at most 3 branch rows. A larger switch shows the first two branch names and a `+N branches` row. Each rank uses its own tallest card. Exact node bounds control ports, centering, and mouse hits. The viewer retains the graph layout between state changes and materializes only the visible rows and columns for Ratatui. Rust checks every TypeScript fixture byte for byte, including long labels, large fan-out, and Unicode labels.

The generated scale fixture is 98,242,560 bytes and contains 44 runs, 17,820 run events, 9,284 session entries, and 48,620 session events. Five release-mode runs of 1,000 idle checks each loaded one selected window with 723 payload rows. They performed one run-index read, no later payload loads, and used 9,388 KiB peak RSS, or 9.61 MB. Total time was 1,291 through 2,331 microseconds per 1,000 checks. Median checks took 1 through 2 microseconds, p99 checks took 1 through 2 microseconds, and the maximum was 9 through 27 microseconds. Compared with the measured 370 MB baseline, peak memory fell by about 360.39 MB, or 97.4%. This is much larger than the registered 50% memory reduction gate. A separate run of 1,000,000 unchanged checks used 0.63 CPU seconds in user code and 0.65 CPU seconds in system calls. Its p99 check took 2 microseconds. The deterministic structural gate also passed: idle checks performed zero payload reads after the first bounded selected window.

## Rollout

The implementation is one hard replacement. State writers, projection readers, local viewer, replay server, replay client, and protocol must agree before release.

If the new presentation revision or delta records make the existing alpha database incompatible, startup must stop with the standard clear reset instruction. It must not modify or delete the old database.

Release publication and installation of the matching npm and crates.io packages are separate work. Existing installed viewers keep their current behavior until they are replaced.

## Outside dependencies

SQLite remains responsible for committed read consistency. Ratatui and Crossterm remain responsible for terminal drawing and input. Terminal emulators and Unicode cell-width behavior remain outside repository control. Tests and bounds account for them without assuming they will change.

A matching release and installed `piw` binary are required before users receive the fix.

## Completion criteria

The work is complete when one canonical revisioned projection serves local and remote clients, committed changes create bounded JSON Patch operations without full-view diffing, bounded pages support arbitrary replay positions, shared subscriptions handle several clients without duplicate reconstruction, graph work stays near the viewport, and unrelated history or nodes no longer determine memory, input latency, or card size.

All failure, parity, performance, privacy, hard-replacement, and repository checks must pass before release.
