# Session event replay implementation plan

## Objective

Add live assistant streaming and deterministic temporal replay to PIW using the
journal defined in
[session-event-journal.md](../session-event-journal.md).

A completed implementation records the documented Pi event stream in each
session-bound run bundle, shows it while the run is active, and replays the same
history later. The workflow trace and final Pi entries keep their existing
roles.

## Boundaries

- Use only documented Pi extension hooks.
- Do not modify Pi source, Pi session state, global Pi session files, provider
  requests, or provider response protocols.
- Keep `trace.ndjson`, `entries.ndjson`, and `events.ndjson` as separate
  contracts.
- Store normalized semantic events. Never persist Pi's cumulative `partial`,
  terminal `message`, or terminal `error` snapshots from
  `AssistantMessageEvent`.
- Preserve every normalized assistant event and timestamp. Filesystem and
  WebSocket batching must not merge event records.
- Keep capture failures separate from workflow failures.
- Keep `src/workflows` independent of Pi and both viewer layers.
- Preserve TypeScript and Rust reducer behavior through shared fixtures.
- Keep boxed node dimensions fixed while temporal events change their status or
  metadata. Live updates must never reflow the graph.
- Replace the session-bound bundle contract in place. Do not add a legacy
  reader, dual writer, migration, or fallback path.
- Keep bundle permissions, artifact containment, terminal sanitization, and
  loopback-only remote viewing unchanged.

## Contract decisions

The durable history is split by authority:

- `trace.ndjson` records workflow transitions.
- `session/entries.ndjson` records final Pi session entries.
- `session/events.ndjson` records temporal session behavior.
- `session/capture.json` reports whether temporal capture completed.

The viewer orders temporal events by `seq`. The `at` timestamp controls replay
speed and never changes event order. Final Pi entries replace provisional
message reconstructions after explicit `entryId` linkage.

Version 1 records each `tool_execution_update` occurrence and timestamp but
omits Pi's arbitrary cumulative `partialResult`. Tool start arguments and the
final tool result are retained. This keeps tool timing without quadratic
storage.

## Schema review

Schemator accepted the session-event envelope without changes in one iteration.
A second review simplified `capture.json` over three iterations. The final
capture projection omits `runId` because the bundle supplies it. It also omits
start, update, and finish timestamps that readers can derive from the journal
and run state. Capture failures keep the durable `failedAt`, `code`, and
`message` fields. The retained event and entry counts let readers check the
append-only files without trusting a malformed tail.

## Implementation order

Work should land in the order below. Each stage has an exit criterion so a
partially completed branch remains reviewable.

### Persisted types

Add the persisted contracts to `src/workflows/types.ts`:

- `WorkflowSessionEventRecord`
- the event type union and payload types
- `WorkflowSessionCapture`
- capture status and failure types

Add schema constants and fixed paths in `src/workflows/store.ts`:

```text
session/events.ndjson
session/capture.json
pi-workflows.session-event.v1
pi-workflows.session-capture.v1
```

Keep event payloads in camelCase. Validate required correlation ids when the
store receives a normalized record. The store must not import Pi event types.

Exit criterion: TypeScript tests can serialize valid persisted shapes and
reject invalid ones without loading the extension.

### Session event writer

Add a dedicated event append path to `WorkflowRunStore`. It must use its own
per-run sequence and append chain so high-rate event writes cannot queue ahead
of workflow-state persistence.

The store API should accept fully stamped ordered batches. It checks the next
expected `seq` inside the event append chain and writes one JSON line per
record. A batch uses one `appendFile` call while preserving separate records.

Add atomic `writeSessionCapture()` support. Create the recording projection
before the first event. At terminal capture, count complete event and entry
lines and write `complete` or `failed` with the durable counts.

After an append error, stop that run's event writer. Do not append after a torn
line. Preserve the first failure and let workflow persistence continue.

Exit criterion: store tests cover sequence assignment, concurrent batches,
torn writes, append failure, atomic capture replacement, final counts, and no
writes after terminal capture.

### Bounded recorder queue

Extend `SessionRecorder` with a memory queue in front of the store batch API.
The recorder assigns the next `seq`, captures `at`, and fixes correlation ids
before enqueueing each event. The `message_update` and `tool_execution_update`
paths then schedule a flush without awaiting filesystem work.

Use initial limits that are easy to test:

- Flush after 25 ms, 256 records, or 256 KiB, whichever comes first.
- Stop capture at 8,192 queued records or 16 MiB of queued JSON.
- Reject a normalized event larger than 1 MiB.

These are implementation safety limits. Measure the synthetic stress test
before changing them. Reaching a limit marks capture as failed and stops
temporal recording. Silent dropping is forbidden.

The writer keeps each event record intact. It may write many lines together,
but it must not combine adjacent text or thinking deltas.

`SessionRecorder.finish()` must wait for an active Pi turn through `turn_end`,
then stop accepting events, flush the queue, drain entry recording, write
terminal capture status, and return. `SessionRecorder.stop()` handles session
shutdown and marks an active turn as interrupted. The engine's existing
`onRunFinishing` hook must await `finish()` before it writes the terminal
workflow event.

Exit criterion: a 10,000-event synthetic stream keeps queue use bounded,
preserves all records below the limit, and does not block an unrelated workflow
snapshot behind the event append chain.

### Pi event normalization

Add a Pi-facing module under `src/extension`, separate from the pure store
contracts. It maps these documented hooks:

| Pi hook                 | Journal event             |
| ----------------------- | ------------------------- |
| `turn_start`            | `turn_started`            |
| `turn_end`              | `turn_finished`           |
| `message_start`         | `message_started`         |
| `message_update`        | `assistant_event`         |
| `message_end`           | `message_finished`        |
| `tool_execution_start`  | `tool_execution_started`  |
| `tool_execution_update` | `tool_execution_updated`  |
| `tool_execution_end`    | `tool_execution_finished` |

The normalizer must exhaustively switch over the installed
`AssistantMessageEvent` union. Tests must fail when a new Pi event variant is
not handled.

For assistant events:

- Drop every `partial` field.
- Drop the cumulative `message` field from `done`.
- Drop the cumulative `error` object from `error`.
- Retain delta strings, block indexes, block-end content, final tool-call
  objects, and stop reasons.

For tool updates, record the event with an empty payload. For tool finish,
encode the final public-hook result with the existing artifact rules.

Exit criterion: normalization tests cover every Pi event variant and assert
that serialized records contain none of the omitted cumulative fields.

### Ownership and correlation

Teach the recorder which agent attempt owns the conversation before the
executor delivers a prompt. Generate run-local turn and message ids as their
start hooks arrive.

Maintain maps for:

- Active attempt to turn.
- Turn to messages.
- Assistant message to generated tool calls.
- `toolCallId` to the owner captured at tool start.

Each end event uses the owner saved at its matching start. It must not read the
workflow's current node again. This prevents a late event from moving to the
next attempt.

Pi persists a message entry after `message_end` handlers return. Buffer that
receipt and later events until the next synchronized boundary hook or workflow
tool execution can record the branch entry. Then release the buffered records
in original hook order. Write `message_finished` with `settled: true` and
`entryId` only when the exact stable message identity matches a durable entry.
Use `settled: false` for an aborted or otherwise unrecorded message. Do not
match messages by text, timestamp, or position during replay.

Exit criterion: tests advance the workflow between start and finish hooks and
confirm that every late event retains its original `nodeId` and `attemptId`.

### Extension wiring and failure policy

Register the new handlers next to the existing session recorder handlers in
`src/extension/index.ts`. Keep event handler setup and teardown scoped to the
active workflow run.

High-rate update handlers enqueue synchronously. Boundary handlers may await a
flush when they need causal ordering or entry linkage. Capture errors are
caught, recorded in `capture.json`, and surfaced to the viewer. They must not
reject an agent turn, fail a tool, or change workflow status.

Session shutdown and workflow cancellation must stop the writer idempotently.
No timer, pending promise, or file handle may survive recorder shutdown.

Exit criterion: hook tests cover normal completion, abort, cancellation,
session shutdown, duplicate stop calls, write failure, and a workflow that
completes successfully after capture fails.

### Bundle readers

Extend both bundle readers with `session/events.ndjson` and
`session/capture.json`.

For TypeScript, update the standalone viewer's bundle model and loader. For
Rust, add serde types under `tui/src/bundle`, a third `NdjsonTailer`, and capture
status loading.

Readers must distinguish:

- Capture currently recording.
- Verified complete capture.
- Explicitly failed capture.
- Missing or invalid capture.
- Sequence gaps or count mismatches.
- A torn final line during recording.

Missing files in a session-bound bundle are an invalid or incomplete capture.
They are not treated as an old format with an alternate read path.

Exit criterion: TypeScript and Rust reader tests produce the same integrity
result for valid and invalid bundles, including failed capture and torn tails.

### Deterministic reducer

Implement a pure temporal reducer in TypeScript and Rust. Its input is the
settled entry list plus session events through a selected sequence. Its output
contains visible settled entries, active messages and content blocks, active or
finished tools, and integrity diagnostics.

The reducer follows these rules:

- Process by `seq` only.
- Append text and thinking deltas by `messageId` and `contentIndex`. Apply the
  same addressing to tool-call deltas.
- Use block-end content to check the folded block.
- Switch to the verbatim Pi entry after a settled `message_finished`.
- Keep unsealed messages visible as partial output.
- Retain unknown event sequence positions while ignoring their payloads.
- Let settled entries win when a reconciliation check fails.

Create shared JSON fixtures under `fixtures/session-events/`. Generate expected
states with the TypeScript implementation and consume the same fixtures from
Rust. Include every event type and every documented failure mode.

Use an in-memory timestamp index and reducer checkpoints for seeking. Start
with one checkpoint every 256 events. Checkpoints are viewer cache data and
must never be written into the run bundle.

Exit criterion: all shared fixtures produce the same visible state and
integrity diagnostics in TypeScript and Rust at every recorded replay point.

### PIW live and replay views

Update the conversation pane to render reducer output. Live mode shows active
text, thinking, tool-call construction, and tool execution as events arrive.
Once a message settles, the pane renders the verbatim Pi entry.

Extend replay position with a temporal cursor while keeping workflow-step
selection intact. The replay clock schedules events from `at`, orders them by
`seq`, and applies the existing 1x, 2x, 5x, and 10x speed choices. Timestamp
ties remain deterministic because sequence order wins.

Follow mode stays attached to the newest temporal event. Manual scrolling or
seeking detaches it, and the existing live controls reattach it. Capture
failure or unverified capture must remain visible in the status area and Info
inspector.

Temporal state also fills the stable full node cards defined in
[piw-viewer-experience-implementation-plan.md](piw-viewer-experience-implementation-plan.md).
A node card reserves slots for its status symbol and label plus its exact id
and type. Separate slots hold start, branch, or terminal markers and every
branch label. Attempt metadata and timing remain visible beside the short detail
or outcome. Every node in the graph uses one canonical outer width
and height chosen before layout. Blank padding fills unused slots. Streaming
and timer ticks may change card contents. Replay and terminal settlement may do
the same without changing node bounds or edge routes.

The boxed card must show all of those fields without ellipses. Long immutable
text wraps during initial measurement, which increases the canonical size for
every node. Narrow terminals pan over the fixed graph. Unbounded prompts and
outputs remain in the inspector, along with error text and tool payloads.

Exit criterion: a manual run visibly streams text and thinking, shows tool
lifecycle changes, can seek into an unfinished message, and reaches the same
final conversation as `entries.ndjson`. Its node cards keep identical bounds at
every temporal cursor while their status and timing fields update.

### Live transport

Extend the run view in `docs/live-replay-protocol.md` and the Rust protocol
types:

```json
"session": {
  "binding": {},
  "entries": [],
  "events": [],
  "capture": {}
}
```

Tail event growth and send it through the existing `append` patch operation at
`/session/events`. Replace capture state at `/session/capture`.

Collect pending event records for up to 50 ms before producing one run patch.
Do not merge event records. The run revision advances once per patch batch, so
a token burst does not create one network revision per token.

Snapshots contain the complete event history and current capture status.
Reconnection, revision-gap recovery, and same-revision snapshot replacement use
the existing resubscription path.

Exit criterion: burst tests show bounded revision growth, exact event order,
and a byte-for-byte equivalent run view after snapshot plus patches or a fresh
resnapshot.

### Documentation and format replacement

When code and tests pass, fold the target contract into
`docs/run-bundles.md` and remove the target-status note from
`docs/session-event-journal.md`. Update `docs/live-replay-protocol.md`,
`docs/tui-viewer.md`, `docs/development.md`, and the README where users need new
commands or controls.

Keep `pi-workflows.run-bundle.v1` and `pi-workflows.replay.v1` as directed by
the repository's in-place replacement policy. Add the two new file schema ids.
Do not document or retain an old session layout.

Exit criterion: the documentation describes only the implemented contract and
all examples validate against real produced bundles.

## Tests

### Storage and normalization

- Every `AssistantMessageEvent` variant maps to the documented payload.
- No persisted record contains `partial`, terminal `message`, terminal `error`,
  or tool `partialResult`.
- Stored bytes grow linearly for generated text of increasing length.
- Batch boundaries do not change event count, sequence, ids, or timestamps.
- Queue overflow and oversized events fail capture without failing the run.
- A failed append leaves at most one torn final line and prevents later event
  appends.
- Terminal capture counts match valid lines on disk.

### Correlation and lifecycle

- Turn and message ids remain stable through late events, as do tool ownership
  and workflow attempt ids.
- A settled message links to the exact recorded Pi entry.
- An aborted message remains unsealed and replayable.
- Recorder shutdown drains once and rejects later enqueue attempts.
- The terminal workflow event is physically later than terminal capture status.
- Bundle files remain unchanged after terminal workflow state.

### Reducer parity

- Text and thinking blocks fold correctly at each delta.
- Tool-call arguments fold before tool execution starts.
- Tool updates advance timing without copying cumulative output.
- Final entries replace provisional messages only at their explicit seal.
- Timestamp ties and backward timestamps preserve sequence order.
- Unknown events do not change known state.
- Reconciliation mismatches produce diagnostics while final entries remain
  authoritative.

### Node-card stability

- Every boxed node uses the same graph-wide outer width and height.
- Node bounds and edge routes remain unchanged at every temporal cursor.
- Symbols for every status from queued through cancelled use their documented
  slots and text labels.
- Start and terminal symbols remain visible beside runtime status data, as does
  the branch count.
- Full node ids and types render without ellipses. Every branch label remains
  visible. Attempt counts and timing fields remain visible, as do short details.
- Long card text expands the initial canonical dimensions and pads every shorter
  card instead of causing later layout changes.

### Local and remote viewing

- Local tailing buffers a torn final event line.
- Append patches preserve every event under a high-rate burst.
- Revision gaps force a complete snapshot. Partial recovery is forbidden.
- Reconnect restores event and capture subscriptions.
- A fresh same-revision snapshot replaces stale cached events.
- Capture failure, missing capture, and interruption have distinct labels.
- Seeking never exposes events or entries later than the selected cursor.

### End-to-end coverage

Extend the mock OpenAI-compatible E2E server to emit text and thinking chunks
plus a tool-call stream. Run a real Pi process with the extension, then assert that:

- The bundle contains the expected temporal files.
- Capture finishes as `complete`.
- Normalized journal events match the streamed order.
- Finalized entries match the reducer's final state.
- The Rust viewer can replay an intermediate chunk.
- No files outside the temporary test directory change.

Add a second E2E failure case with an injected event-writer error. The workflow
must still finish, and PIW must show failed capture.

## Operational checks

Before calling the feature production-ready, measure a synthetic stream with at
least 100,000 small assistant events. Record total bytes, peak queued bytes,
append batch count, elapsed writer time, and workflow snapshot latency while the
stream runs.

This safety check does not select between competing designs. The design passes
when memory stays within the configured queue bound, stored size is
linear in delta bytes, no event is lost below the bound, and workflow snapshots
remain responsive. If the initial constants fail, change the smallest relevant
limit or batch size and rerun the same workload.

## Repository checks

Run focused TypeScript and Rust tests after each stage. Before finishing the
complete implementation, run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
```

Also run the Rust checks directly while iterating on `tui/`:

```bash
cargo fmt --check --manifest-path tui/Cargo.toml
cargo clippy --manifest-path tui/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path tui/Cargo.toml
```

## Contract impact

Session state remains unchanged. The extension reads Pi's normal session
entries and public event payloads but does not append, edit, or remove Pi
entries.

The run bundle gains `session/events.ndjson` and `session/capture.json`. No
other persistent store changes. Pi internals and provider protocols remain
unchanged.

The public Pi API surface is limited to `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update`, and `tool_execution_end`, plus the documented
read-only session manager getters already used by `SessionRecorder`.

## Completion criteria

The work is complete when:

1. Every session-bound run writes the specified journal and capture status.
2. High-rate hooks never await disk and cannot grow memory without a bound.
3. Capture failure is explicit and never changes workflow success or failure.
4. Local and remote PIW views show the same live temporal state.
5. Replay can seek to any event and deterministically reconstruct that point.
6. Final reducer state reconciles with the verbatim Pi entries.
7. TypeScript and Rust pass the same temporal fixtures.
8. Terminal bundles never change after the terminal workflow event.
9. Full boxed nodes show the documented ACPX-style fields and symbols while
   keeping identical bounds across live updates and replay.
10. The full repository and E2E checks pass.
11. The implemented docs contain no legacy session format or fallback path.
