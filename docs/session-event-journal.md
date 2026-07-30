# Session event journal specification

This document defines the target format for temporal Pi session history in a
workflow run bundle. The journal records the order and timing of turns,
messages, assistant output, and tool execution while a workflow runs.

The format extends the authoritative bundle contract in
[run-bundles.md](run-bundles.md).

## Bundle structure

A session-bound run contains these files:

```text
<run-id>/
├── manifest.json
├── workflow.json
├── state.json
├── trace.ndjson
├── session/
│   ├── binding.json
│   ├── entries.ndjson
│   ├── events.ndjson
│   └── capture.json
└── artifacts/
```

`events.ndjson` is an append-only journal. `capture.json` is an atomic status
file that says whether the journal is complete.

## History ownership

Each persisted file answers a different question.

| File                     | Question                                                   | Authority                                               |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| `trace.ndjson`           | What did the workflow engine do?                           | Workflow transitions and outputs                        |
| `session/entries.ndjson` | What settled in the Pi conversation?                       | Final Pi session entries                                |
| `session/events.ndjson`  | What happened over time while the conversation was active? | Timing for turns, messages, assistant output, and tools |
| `session/capture.json`   | Is the temporal history complete?                          | Capture status and final counts                         |

A reader must not rebuild final conversation content from session events after
a matching entry has settled. The Pi entry is the final content. Session events
preserve how that content appeared and preserve partial work that never settled.

The three NDJSON journals keep independent sequence spaces. A sequence number
from one file cannot be compared with a sequence number from another file.
Explicit ids provide cross-file linkage.

## Minimal journal

A journal with one assistant text block can contain these lines:

```json
{"seq":1,"at":"2026-07-30T10:00:00.010Z","nodeId":"review","attemptId":"a1","turnId":"t1","type":"turn_started","payload":{"turnIndex":0}}
{"seq":2,"at":"2026-07-30T10:00:00.020Z","nodeId":"review","attemptId":"a1","turnId":"t1","messageId":"m1","type":"message_started","payload":{"role":"assistant"}}
{"seq":3,"at":"2026-07-30T10:00:00.100Z","nodeId":"review","attemptId":"a1","turnId":"t1","messageId":"m1","type":"assistant_event","payload":{"type":"text_start","contentIndex":0}}
{"seq":4,"at":"2026-07-30T10:00:00.140Z","nodeId":"review","attemptId":"a1","turnId":"t1","messageId":"m1","type":"assistant_event","payload":{"type":"text_delta","contentIndex":0,"delta":"Looks good."}}
{"seq":5,"at":"2026-07-30T10:00:00.150Z","nodeId":"review","attemptId":"a1","turnId":"t1","messageId":"m1","type":"assistant_event","payload":{"type":"text_end","contentIndex":0,"content":"Looks good."}}
{"seq":6,"at":"2026-07-30T10:00:00.170Z","nodeId":"review","attemptId":"a1","turnId":"t1","messageId":"m1","type":"message_finished","payload":{"role":"assistant","settled":true,"entryId":"e1"}}
{"seq":7,"at":"2026-07-30T10:00:00.180Z","nodeId":"review","attemptId":"a1","turnId":"t1","type":"turn_finished","payload":{"turnIndex":0,"messageId":"m1","toolCallIds":[]}}
```

The matching final Pi entry remains in `session/entries.ndjson`:

```json
{
  "seq": 2,
  "at": "2026-07-30T10:00:00.165Z",
  "entry": {
    "type": "message",
    "id": "e1",
    "parentId": "e0",
    "timestamp": "2026-07-30T10:00:00.160Z",
    "message": { "role": "assistant", "content": [{ "type": "text", "text": "Looks good." }] }
  }
}
```

## Event record

Each line in `events.ndjson` has schema
`pi-workflows.session-event.v1`:

```ts
type WorkflowSessionEventRecord = {
  seq: number;
  at: string;
  nodeId: string;
  attemptId: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  type:
    | "turn_started"
    | "turn_finished"
    | "message_started"
    | "assistant_event"
    | "message_finished"
    | "tool_execution_started"
    | "tool_execution_updated"
    | "tool_execution_finished";
  payload: Record<string, unknown>;
};
```

### Fields

| Field        | Required | Type             | Meaning                                       |
| ------------ | -------- | ---------------- | --------------------------------------------- |
| `seq`        | Yes      | positive integer | Position in `events.ndjson`, starting at 1    |
| `at`         | Yes      | ISO 8601 string  | Time when the extension received the Pi event |
| `nodeId`     | Yes      | string           | Workflow node that owned the event            |
| `attemptId`  | Yes      | string           | Workflow attempt that owned the event         |
| `turnId`     | By event | string           | Run-local turn id                             |
| `messageId`  | By event | string           | Run-local message id                          |
| `toolCallId` | By event | string           | Pi tool-call id                               |
| `type`       | Yes      | string           | Normalized event type                         |
| `payload`    | Yes      | object           | Fields specific to the event type             |

`seq` must increase by exactly 1. Physical line order must match `seq` order.
The writer must capture `at` before any asynchronous file work. Readers order
events by `seq`. They use `at` only for playback timing.

Every record has `nodeId` and `attemptId`. The recorder takes ownership from
the active agent-step contract when the turn, message, or tool execution
starts. That ownership remains fixed until the matching end event, even if the
workflow moves to another node.

The ids under `turnId` and `messageId` are generated by the recorder. They are
unique within one run and have no meaning outside that run. Readers must use
them and `toolCallId` directly. Timing is never used to infer relationships.

## Event catalog

The journal records normalized events from Pi's documented extension hooks.
The payloads below are the complete version 1 contract. Unknown payload fields
must be ignored.

### `turn_started`

Source hook: `turn_start`.

Required ids: `turnId`.

```json
{ "turnIndex": 0 }
```

`turnIndex` is copied from Pi. The local `turnId` remains the journal identity.

### `turn_finished`

Source hook: `turn_end`.

Required ids: `turnId`.

```json
{ "turnIndex": 0, "messageId": "m1", "toolCallIds": ["call_1"] }
```

The payload contains references instead of copying the final message and tool
results. Final message content belongs in `entries.ndjson`, and final tool
results belong to `tool_execution_finished` and the settled Pi entries.

### `message_started`

Source hook: `message_start`.

Required ids: `turnId`, `messageId`.

```json
{ "role": "assistant" }
```

`role` is the Pi message role observed at start.

### `assistant_event`

Source hook: `message_update`.

Required ids: `turnId`, `messageId`.

The payload contains one normalized `AssistantMessageEvent`. The allowed shapes
are:

```ts
type NormalizedAssistantEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: unknown }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "aborted" | "error" };
```

The recorder must discard Pi's cumulative `partial` field. It must also discard
the cumulative `message` or `error` object on stream-terminal events. Persisting
those snapshots once per chunk would make storage grow with every repeated
prefix. Delta fields preserve the generated content without that duplication.

The `content` on text and thinking end events and the final `toolCall` object
are retained once. Readers may compare them with the folded deltas and report a
mismatch. A mismatch does not replace the matching final Pi entry.

The event writer must preserve every normalized assistant event. It may batch
several records into one filesystem append, but it must not merge adjacent
deltas or change their timestamps.

### `message_finished`

Source hook: `message_end`.

Required ids: `turnId`, `messageId`.

Settled message:

```json
{ "role": "assistant", "settled": true, "entryId": "e1" }
```

Message without a recorded Pi entry:

```json
{ "role": "assistant", "settled": false }
```

`entryId` is required when `settled` is true and forbidden when it is false.
The recorder must obtain the id while it records the corresponding branch
entry. Readers must not guess this link from message content or timestamps.

### `tool_execution_started`

Source hook: `tool_execution_start`.

Required ids: `turnId`, `messageId`, `toolCallId`.

```json
{ "toolName": "read", "args": { "path": "README.md" } }
```

The tool-call owner is fixed at this event. Later update and finish events with
the same `toolCallId` keep that owner.

### `tool_execution_updated`

Source hook: `tool_execution_update`.

Required ids: `turnId`, `messageId`, `toolCallId`.

```json
{}
```

Version 1 records each update's occurrence and timestamp. Pi exposes
`partialResult` as an arbitrary cumulative value. The recorder omits it to
avoid repeatedly storing growing prefixes. The final result remains available
on `tool_execution_finished` and in the Pi session entries.

### `tool_execution_finished`

Source hook: `tool_execution_end`.

Required ids: `turnId`, `messageId`, `toolCallId`.

```json
{ "toolName": "read", "isError": false, "result": { "content": [] } }
```

`result` is the final public-hook result. Large string leaves use the bundle's
existing artifact encoding. Readers must resolve those references through the
same containment and size checks used for other bundle values.

## Capture status

`session/capture.json` uses schema `pi-workflows.session-capture.v1`. The
recorder creates it before the first session event and replaces it atomically.

```json
{
  "schema": "pi-workflows.session-capture.v1",
  "eventSchema": "pi-workflows.session-event.v1",
  "status": "complete",
  "eventCount": 47,
  "entryCount": 6,
  "lastEventSeq": 47
}
```

| Field          | Required    | Type                 | Meaning                                      |
| -------------- | ----------- | -------------------- | -------------------------------------------- |
| `schema`       | Yes         | string               | Must equal `pi-workflows.session-capture.v1` |
| `eventSchema`  | Yes         | string               | Must equal `pi-workflows.session-event.v1`   |
| `status`       | Yes         | string               | `recording`, `complete`, or `failed`         |
| `eventCount`   | Yes         | non-negative integer | Number of complete event records on disk     |
| `entryCount`   | Yes         | non-negative integer | Number of complete entry records on disk     |
| `lastEventSeq` | Yes         | non-negative integer | Last durable event sequence, or 0            |
| `failure`      | Failed only | object               | First capture failure                        |

A failed status has this shape:

```json
{
  "schema": "pi-workflows.session-capture.v1",
  "eventSchema": "pi-workflows.session-event.v1",
  "status": "failed",
  "eventCount": 31,
  "entryCount": 4,
  "lastEventSeq": 31,
  "failure": {
    "failedAt": "2026-07-30T10:00:01.900Z",
    "code": "event_write_failed",
    "message": "could not append session event batch"
  }
}
```

Status meanings:

- `recording` means the run may append more events or entries. Its counts are
  lower bounds from the last atomic projection and may lag the files.
- `complete` means all observed events were written, both session writers were
  drained, and the counts match the durable files.
- `failed` means the temporal history may be incomplete. Workflow execution
  continues, and settled entries may still be usable.

The first capture failure is retained. After an event append fails, the event
writer must stop appending so a torn line remains at the file tail. The final
status counts only complete lines. If `capture.json` is missing, invalid, still
`recording` after a terminal workflow state, or inconsistent with the journal,
the viewer must report unverified capture instead of treating the journal as
empty or complete.

## Write lifecycle

The recorder follows this order:

1. Bind the run to the Pi conversation.
2. Create `capture.json` with status `recording`.
3. Accept documented Pi events while an agent attempt owns the conversation.
4. Stamp correlation ids and sequence in each hook, then record the receipt time.
5. Queue normalized records in memory and return immediately from high-rate
   update hooks.
6. Append queued records in ordered batches on a dedicated writer.
7. At `message_end`, buffer that receipt and later events until a subsequent
   synchronized hook exposes the durable Pi entry, then attach its exact id
   without changing event order or receipt timestamps.
8. When the workflow requests terminal persistence during an active Pi turn,
   keep capture routed through that turn's final tool, message, and `turn_end`
   hooks.
9. Stop accepting events and drain the event and entry writers.
10. Write terminal `capture.json` atomically.
11. Allow the engine to append its terminal workflow event.

This order keeps the bundle immutable once the terminal workflow event exists.
Waiting for the active turn is bounded at 30 seconds. If the turn does not
finish, capture stops as failed so it cannot hold workflow persistence
indefinitely. A capture failure must never fail the workflow.

The queue must have tested byte and record limits. Reaching either limit marks
capture as failed and stops temporal capture. Silent event dropping is
forbidden.

## Torn writes and validation

Each event is one UTF-8 JSON object followed by `\n`. A reader may ignore an
incomplete final line while capture is `recording`. Any malformed line before
the tail is corruption.

A reader validates these rules:

- Required fields have the documented types.
- `seq` starts at 1 and has no duplicates or gaps.
- Correlation ids required by the event type are present.
- Every finish event refers to a matching start event.
- `message_finished.entryId` exists in `entries.ndjson` when `settled` is true.
- `capture.json` counts match complete journal lines at terminal status.
- No session file changes after terminal workflow state.

Unknown event types and unknown payload fields are ignored. The reader still
advances past their sequence numbers. An unsupported `eventSchema` makes the
temporal journal unavailable. The reader must not guess another shape.

## Deterministic reduction

Live display and replay must use the same reducer. The reducer processes events
in `seq` order and keeps run-local state for turns, messages, content blocks,
and tools.

Text and thinking deltas append to their content blocks. Tool-call deltas use
the same `messageId` and `contentIndex` addressing. Tool lifecycle events update the tool identified
by `toolCallId`. A settled message switches to the matching verbatim Pi entry at
`message_finished`. An unsealed message remains a partial reconstruction.

Replay uses `at` to schedule events at 1x or another selected speed. Ordering
always comes from `seq`. Seeking may use in-memory checkpoints and a timestamp
index, but those are derived viewer data and do not belong in the run bundle.

The TypeScript and Rust reducers must pass the same fixtures. Fixtures cover
normal completion, thinking, tool calls, interleaved tool updates, aborts,
missing final entries, unknown events, timestamp ties, and capture failure.

## Live transport

The live replay protocol adds the journal and status to the existing run view:

```json
{
  "session": {
    "binding": { "schema": "pi-workflows.session-binding.v1" },
    "entries": [],
    "events": [],
    "capture": { "schema": "pi-workflows.session-capture.v1" }
  }
}
```

The server tails `events.ndjson` like the existing trace and entry files.
Journal growth uses an `append` patch at `/session/events`. Capture changes use
a `replace` patch at `/session/capture`.

The server batches pending append records into one patch for a short interval.
It must preserve every event record and its sequence. This batching limits
revision growth without changing the durable history. Reconnection always
starts with a fresh snapshot, followed by later patches.

## Privacy and trust

Session events can contain prompts, generated text, thinking, tool arguments,
tool results, file paths, and command output. Bundle permissions remain `0700`
for directories and `0600` for files. Remote viewing remains loopback-only and
uses the existing SSH tunnel workflow.

Readers must treat all strings and nested values as untrusted. Terminal output
is sanitized before drawing. Artifact paths must stay inside the manifest's
artifact directory.

## Versioning

This change replaces the session-bound `pi-workflows.run-bundle.v1` contract in
place. A session-bound bundle must contain both `events.ndjson` and
`capture.json` after the implementation lands. Missing files are reported as
an invalid or incomplete capture. There is no legacy read path.

The new files use `pi-workflows.session-event.v1` and
`pi-workflows.session-capture.v1`. Breaking either shape requires changing its
schema identifier. New event types and optional payload fields may be added
within version 1 because readers ignore unknown values.

The network view grows within `pi-workflows.replay.v1`. Its existing unknown
field rule makes `session.events` and `session.capture` additive protocol
fields. No dual writer, migration, or fallback reader is part of this change.

## Contract impact

The extension uses only Pi's documented `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update`, and `tool_execution_end` hooks.

Pi session state is unchanged. Normal Pi behavior still creates its own session
entries, and the extension only reads those entries for bundling and linkage.
Pi internals, provider protocols, and global Pi session files are unchanged.
The only new persistent data is `session/events.ndjson` and
`session/capture.json` inside the private workflow run bundle.
