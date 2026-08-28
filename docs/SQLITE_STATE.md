# SQLite state

Pi Workflows stores all live durable state in one database:

```text
~/.pi/agent/workflows/state.sqlite
```

There is one database for the user installation. Project and run IDs separate data inside it. Workflow targets do not read or write this database.

## Viewer projection

The database includes the [incremental and virtualized viewer design](plans/2026-08-28-piw-incremental-viewer-plan.md).

`viewer_runs` stores one presentation revision and retained revision floor for each run. `viewer_deltas` stores ordered target patches by run, presentation revision, and delta index. `viewer_session_checkpoints` stores the bounded active message and tool state at each 256-event boundary. A viewer-visible transaction writes the domain change, advances the presentation revision, and writes its patch blobs before the same commit. Session-event transactions write each reached replay checkpoint in that transaction.

The store retains 256 presentation revisions. A reader with an older cursor must take a bounded snapshot. Patches use `add`, `replace`, `remove`, and `append`. They target small projection documents or pages. Patch creation does not reconstruct and compare complete run views.

`session_entries` and `session_events` have run-wide sequence numbers and indexed `(run_id, run_seq)` ranges. Step, trace, entry, and event reads contain at most 256 rows. Run-list queries read metadata, status, lease facts, and the presentation revision. They do not read payload bodies.

This is an in-place alpha schema change. The schema name and version remain `pi-workflows-state` version 1. The DDL digest and exact shape changed. An older alpha database fails with the standard reset instruction and remains untouched. There is no compatibility reader, migration shim, dual path, feature flag, alias, or `v2` schema.

## Storage boundary

The database stores:

- workflow definitions, runs, events, node attempts, outputs, and updates
- captured Pi session entries and events
- run and controller queues, claims, retries, and continuations
- human-decision requests, submissions, resolutions, and cancellations
- controller resources, finalizers, effects, and child workflows
- notifications and deferred turns
- workflow settings, accepted JSON Patch changes, and post-completion follow-up prompts
- nonsecret channel cursors, inbox records, messages, and settlement receipts
- canonical JSON, text, and large text values

Credentials and raw secrets must not enter the database. Channel credential files stay in their existing private configuration directory.

The implementation does not create live run directories, artifact files, decision directories, project databases, controller databases, or channel databases.

## Database settings

Every writer enables:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

The database also uses:

- `STRICT` tables
- application ID `0x50495746`
- user version `1`
- a bounded WAL checkpoint and journal size
- directory mode `0700`
- database and backup mode `0600`

Read-only tools open the same file with SQLite read-only mode and `PRAGMA query_only = ON`.

Opening code verifies the application ID, user version, schema metadata, compiled DDL digest, and exact SQLite schema shape. An incompatible database fails with an instruction to clear the incompatible alpha state. Pi Workflows does not import, reinterpret, or delete that state.

The normalized run layout is an in-place alpha cutover. It keeps SQLite user version `1` and the current `v1` public record identifiers. A database with the former nested run-snapshot layout is incompatible and must be moved or removed. There is no migration, compatibility reader, dual write, alias, or second schema generation.

## Shared records

Four record groups provide the common lifecycle rules.

### Resources

`resources` identifies each mutable aggregate and holds its current revision. Runs, settings scopes, follow-up queues and items, decisions, controller resources, effects, channels, notifications, deferred turns, and session segments have stable resource identities.

Every accepted domain command compares its expected revision and increments it once.

### Leases

`leases` holds the current owner, a hash of its random claim token, lease times, and a monotonically increasing generation.

A new owner always receives a new generation. Releasing a lease clears the owner fields but does not reduce or reuse the generation. A stale token or generation cannot write after ownership changes.

### Events

`events` is the immutable audit history. Each event records the resource revision, event type, actor class, private local actor ID when applicable, lease generation, payload blob, and commit time.

A domain row and its event are written in one transaction. Normal APIs never update or delete events.

### Effects

`effects` is the transactional outbox. A domain transaction records required follow-up work before it commits. Each effect has:

- a deterministic effect ID
- a source resource and exact source revision
- an effect type and idempotency key
- a canonical payload blob
- an owner scope
- a status and retry time
- a result, error, external reference, and settlement time when applicable

`effect_attempts` records each application attempt and ownership generation. A matching repeated request adopts the existing effect. A different request under the same key is a conflict.

Local effects use deterministic transactions. Run queue settlement effects are created only for runs that have a `run_queue` row; direct engine and controller-child runs do not create phantom queue work. External effects use provider idempotency or observation when available. An uncertain result becomes `ambiguous` and is not repeated without evidence.

## Domain tables

The shared records do not replace domain schemas. The following `STRICT` tables keep the state explicit:

| Area                | Tables                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Schema and projects | `schema_meta`, `projects`                                                                                                    |
| Content             | `blobs`                                                                                                                      |
| Shared lifecycle    | `resources`, `leases`, `events`                                                                                              |
| Workflows           | `workflow_definitions`, `runs`, `run_sources`, `run_steps`, `run_bindings`, `run_queue`, `node_attempts`, `workflow_updates` |
| Live settings       | `workflow_settings`, `workflow_setting_changes`                                                                              |
| Post-run follow-ups | `workflow_follow_up_queues`, `workflow_follow_ups`                                                                           |
| Session capture     | `session_segments`, `session_entries`, `attempt_entries`, `session_events`                                                   |
| Human decisions     | `human_decisions`, `human_decision_resolutions`, `human_decision_submissions`, `continuations`                               |
| Controllers         | `controller_resources`, `controller_finalizers`, `controller_queue`, `controller_workflows`                                  |
| Effects             | `effects`, `effect_attempts`                                                                                                 |
| Pi delivery         | `notifications`, `turn_intents`                                                                                              |
| Channels            | `channels`, `channel_cursors`, `channel_inbox`, `channel_messages`, `channel_message_parts`                                  |

Foreign keys join projects, runs, attempts, decisions, controllers, effects, and channel records. Partial unique indexes enforce one active node attempt per run, one queued or running reservation per Pi session, one decision winner, and one deterministic effect key. A parked waiting parent does not block its continuation. Reserving that continuation settles the parked parent queue in the same transaction, so a failed reservation leaves the parent recoverable.

### Terminal restart state

The [terminal workflow restart contract](plans/2026-08-27-workflow-terminal-restart-plan.md)
uses the existing tables. It adds no state store or table. A restarted run keeps
its root run ID, parent run ID, restart number, and parent terminal fingerprint
in the existing launch-options value. The fingerprint uses the workflow
identity and revision, exact input, terminal state, canonical result or error,
and canonical reason. It excludes run IDs, timestamps, and other values that
change between equivalent attempts.

One terminal turn intent covers result presentation and factual fallback. A
selected restart, Monitor run, or other workflow start uses the existing
session reservation, run queue, and effect receipt. The successor run's launch
options record the source terminal run, intent, model tool call, and canonical
request fingerprint. A repeated call adopts that reservation or run. Activation
waits for `agent_settled`, and normal queue recovery activates a surviving
reservation once.

Restart creates a new run. The terminal run remains unchanged. Restart lineage
allows three restarts after the original run and rejects a repeated terminal
fingerprint in the same chain. A Monitor selection records terminal selection
but no restart lineage. Conversation history remains in Pi. This state does not
identify, hash, copy, or store an original user message.

## Content-addressed values

`blobs` stores canonical JSON and UTF-8 text as bytes. Its primary key is the 32-byte SHA-256 digest of the bytes.

Insertion verifies the digest, media type, byte length, and exact bytes. Repeated content adopts the existing row. This replaces separate artifact files while keeping outputs, errors, settled Pi entries, and rendered channel text deduplicated. Opening the database never deletes blobs. The explicit prune command removes unreferenced blobs after it deletes safe old run trees.

Runs do not store a nested `WorkflowRunState` blob. `runs` stores run-level facts and hashes for independent values. `run_sources` stores source identity without source JSON blobs. `node_attempts` stores structured workflow outputs and small execution receipts. `session_entries` is the only stored copy of each settled Pi entry. `attempt_entries` links an attempt to its prompt, response, first, and last Pi entries. `run_steps` stores ordered attempt membership and only stores an output override when a continuation changes a carried checkpoint answer.

Readers derive `steps`, `outputs`, `results`, carried-step count, current-node fields, waiting state, source objects, and continuation decision receipts from these rows. Compact trace events do not copy prompts, node outputs, run inputs, final outputs, action receipts, or assistant receipts.

### Assistant-message attempts

An agent definition records `expectedOutput` as either a submitted-output description or `{ "kind": "assistant-message", "maxChars"?: number }`. Omitted `maxChars` means that Pi Workflows adds no character limit.

A completed interactive assistant-message attempt uses the settled Pi response entry as its output. It does not store a second output blob. Its small receipt keeps the text digest, final Pi session entry ID, optional author-supplied limit, and whether recovery adopted an existing response. A noninteractive attempt with no captured response entry keeps one normal output blob.

An interrupted assistant-message attempt keeps its attempt ID when the origin Pi session resumes it. The executor adopts a matching completed assistant child from the active Pi branch instead of displaying the response twice. Submitted and non-agent attempts keep their normal fresh-attempt resume behavior.

## Write contract

A resource command uses this order:

```text
BEGIN IMMEDIATE
verify the exact schema
verify the actor and operation
verify the expected resource revision
verify the claim token, generation, and expiry when ownership is required
verify the domain transition
write content-addressed values
increment the resource revision
write the immutable event
update the domain row
insert deterministic follow-up effects
COMMIT
```

Any failed check rolls back the complete command.

Session-event batches use `session_events` as their journal. They update the contiguous segment counter in the same transaction and do not create a generic `session.events_appended` event for each flush. The recorder stores order, IDs, roles, status, and timing boundaries. It discards token deltas, completed text, thinking text, tool arguments, tool results, and incremental tool progress. The settled Pi entries keep the replay content.

A TypeScript write permit carries the expected facts between layers. It is not authority by itself. The store verifies durable ownership and revision data again inside the transaction.

## Ownership

Reading or finding a row never gives write authority.

- A run owner may advance the run, apply automatic decision policy, create its continuation, settle its parent, and complete its queue work.
- A controller claim owner may update controller status, reserve effects, and start child workflows for that resource.
- A verified human channel actor may submit one answer candidate for the named decision. It does not gain run ownership.
- A channel lease owner may update only its channel cursor, inbox, delivery, and settlement records.
- Control commands have narrow explicit operations, such as requesting cancellation or deletion.
- Model-originated workflow answers cannot resolve protected human decisions.

Stores check ownership in the same transaction as the write. Shared scans, status commands, lists, viewers, and the Rust `piw` program are read-only.

## Competing outcomes

Each domain has one atomic winning fact.

Human answers, timeout policy, explicit cancellation, and no-default expiry compete through `human_decision_resolutions`. Its decision primary key allows one immutable winner.

A deadline with a validated default response is timeout-policy acceptance. It cannot become an expiry cancellation. Expiry cancellation is valid only when there is no default response.

Late or repeated commands return or adopt the durable winner. They do not overwrite it.

The same rule applies to run terminal outcomes, continuation admission, queue settlement, controller effects, retry scheduling, and channel settlement through their domain constraints and expected revisions.

## Read contract

Status is a pure projection of domain rows, immutable facts, current leases, and effect results.

A settings scope uses its resource revision as its public change number. Each accepted patch, current value, and node binding is saved in one transaction. A checkpoint continuation keeps the same settings resources and transfers them to the continuation run.

A follow-up queue records acceptance order and final-presentation state. Successful terminalization changes queued items to ready or pending presentation in the same transaction as the terminal run fact. Failure, timeout, and cancellation cancel unsent items. Delivery uses item leases and active Pi branch evidence.

- A terminal run fact overrides stale queue presentation.
- An accepted decision is accepted even if its continuation effect is still pending.
- A cancelled decision is cancelled even if parent cleanup is still pending.
- A stale owner is not shown as current.
- An ambiguous external effect is shown as unresolved.

Read paths do not repair state. Owner reconcilers apply pending effects and write receipts.

## Projects and concurrency

All projects use the same file. `projects` stores a stable ID and canonical path. Project-scoped controller and run queries use that key. Standalone host lock and child-process registry files use a project hash under the workflow state directory, so different projects can run hosts concurrently while two hosts for one project still conflict.

SQLite WAL permits concurrent readers while one writer commits. Writers are serialized by SQLite and must keep transactions short. Hashing, model calls, shell work, and external requests happen outside write transactions.

This contract is for local storage on one machine. It does not claim distributed consensus or network-filesystem safety.

## Backup and verification

An active database must be backed up with the SQLite backup API. Copying only `state.sqlite` while WAL writes are active is not supported.

Verification checks:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

A backup is opened read-only and checked before it is accepted.

Supported commands are:

```bash
pi-workflows state status
pi-workflows state verify
pi-workflows state backup /absolute/path/to/state-backup.sqlite
pi-workflows state prune --before 2026-08-01T00:00:00Z --dry-run
pi-workflows state prune --before 2026-08-01T00:00:00Z --backup /absolute/path/to/before-prune.sqlite --apply
```

`status` reports only safe counts, file size, active leases, and unsettled effects.
It does not print actor IDs, channel references, payloads, or credentials.

`prune --dry-run` reports complete terminal run trees older than the cutoff and the trees that safety checks block. It does not change the database. `prune --apply` requires a new absolute backup path. It verifies the backup, locks maintenance, rechecks the same selection in an exclusive transaction, and refuses trees with live queues, active leases, unsettled effects, controller references, channel references, or step links from runs outside the tree. It deletes the safe aggregates, removes blobs with no remaining foreign-key reference, checkpoints the WAL, vacuums the file, and runs integrity and foreign-key checks. Pi Workflows never runs prune at startup.

## Alpha cutover

This is a hard cut. Pi Workflows has no normal reader or writer for older live storage. It does not use dual reads, dual writes, aliases, versioned state roots, or automatic import.

Older state remains untouched. If it is present when a new database would be created, Pi Workflows fails with a clear instruction instead of guessing or deleting data.
