# Session event journal

Pi Workflows records the Pi conversation events associated with a workflow run. The journal supports live viewing, replay, and exact links from workflow steps to settled Pi entries.

All records live in the canonical [SQLite state](SQLITE_STATE.md) database.

## Tables

### `session_segments`

A segment is one capture owner tenure for one run. It stores:

- the run and optional node attempt
- the Pi session ID
- the content-addressed binding record
- recording, complete, or failed status
- accepted entry and event counts
- failure details when capture fails
- start and finish times

A later owner writes another segment. It does not rewrite the earlier segment.

### `session_entries`

Each row stores one settled Pi session entry with a contiguous sequence, Pi entry ID, recorded time, and blob hash for the verbatim entry JSON.

### `session_events`

Each row stores one normalized temporal event with a contiguous sequence and these references when applicable:

- node and attempt ID
- turn ID
- message ID
- tool-call ID
- event payload blob
- receipt time

## Event types

The current event types are:

- `turn_started`
- `turn_finished`
- `message_started`
- `assistant_event`
- `message_finished`
- `tool_execution_started`
- `tool_execution_updated`
- `tool_execution_finished`

Unknown future event types remain visible to generic readers.

## Write rules

The recorder queues hot-path Pi events in memory and writes bounded batches. One transaction writes the complete batch, updates the segment count, increments the segment resource revision, and appends its audit event.

The writer checks:

- positive contiguous event sequence numbers
- required event envelope fields
- the 1 MiB per-event limit
- current segment state
- current owner authority when ownership is required

A failed batch writes a failed capture status. Failed and complete capture states are terminal. A later completion call cannot replace a failed capture.

Workflow execution does not fail because temporal capture failed. The run and the capture report their states separately.

## Settled entries

A `message_finished` event can refer to the Pi entry ID that settled the message. Replay first shows temporal deltas, then switches to the verbatim entry when that settled link is available.

Agent workflow steps also store their first and last Pi entry IDs. This makes the conversation slice for each step explicit without changing Pi session data.

## Read and replay rules

Readers order events by `event_seq`, not by wall-clock time. The `recorded_at` value controls playback timing only.

A capture is invalid when:

- sequences have a gap
- required references are missing
- row counts differ from the segment counters
- a terminal run still reports recording
- a settled event refers to an entry that does not exist

The TypeScript and Rust viewers read the same committed rows. They do not repair capture state.

## Privacy

Session entries and events can contain prompts, generated text, thinking, tool arguments, tool results, paths, and command output. The workflow directory uses mode `0700`, and `state.sqlite` uses mode `0600`.

Status output does not expose raw session payloads. Remote replay is loopback-only unless the operator uses an SSH tunnel.

## Pi API boundary

The recorder uses Pi's documented `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` hooks.

It does not change Pi session files, session entry schemas, or Pi internals.
