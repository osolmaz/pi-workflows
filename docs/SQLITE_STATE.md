# SQLite state

Pi Workflows stores all live durable state in one database:

```text
~/.pi/agent/workflows/state.sqlite
```

There is one database for the user installation. Project and run IDs separate data inside it. Workflow targets do not read or write this database.

## Storage boundary

The database stores:

- workflow definitions, runs, events, node attempts, outputs, and updates
- captured Pi session entries and events
- run and controller queues, claims, retries, and continuations
- human-decision requests, submissions, resolutions, and cancellations
- controller resources, finalizers, effects, and child workflows
- notifications and deferred turns
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

## Shared records

Four record groups provide the common lifecycle rules.

### Resources

`resources` identifies each mutable aggregate and holds its current revision. Runs, decisions, controller resources, effects, channels, notifications, deferred turns, and session segments have stable resource identities.

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

| Area                | Tables                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Schema and projects | `schema_meta`, `projects`                                                                        |
| Content             | `blobs`                                                                                          |
| Shared lifecycle    | `resources`, `leases`, `events`                                                                  |
| Workflows           | `workflow_definitions`, `runs`, `run_bindings`, `run_queue`, `node_attempts`, `workflow_updates` |
| Session capture     | `session_segments`, `session_entries`, `session_events`                                          |
| Human decisions     | `human_decisions`, `human_decision_resolutions`, `human_decision_submissions`, `continuations`   |
| Controllers         | `controller_resources`, `controller_finalizers`, `controller_queue`, `controller_workflows`      |
| Effects             | `effects`, `effect_attempts`                                                                     |
| Pi delivery         | `notifications`, `turn_intents`                                                                  |
| Channels            | `channels`, `channel_cursors`, `channel_inbox`, `channel_messages`, `channel_message_parts`      |

Foreign keys join projects, runs, attempts, decisions, controllers, effects, and channel records. Partial unique indexes enforce one active node attempt per run, one queued or running reservation per Pi session, one decision winner, and one deterministic effect key. A parked waiting parent does not block its continuation. Reserving that continuation settles the parked parent queue in the same transaction, so a failed reservation leaves the parent recoverable.

## Content-addressed values

`blobs` stores canonical JSON and UTF-8 text as bytes. Its primary key is the 32-byte SHA-256 digest of the bytes.

Insertion verifies the digest, media type, byte length, and exact bytes. Repeated content adopts the existing row. This replaces separate artifact files while keeping large prompts, outputs, errors, session payloads, and rendered channel text deduplicated.

### Assistant-message attempts

An agent definition records `expectedOutput` as either a submitted-output description or `{ "kind": "assistant-message", "maxChars"?: number }`. Omitted `maxChars` means that Pi Workflows adds no character limit.

A completed assistant-message attempt stores the exact text through the normal output blob. Its result record also stores a receipt with the text digest, final Pi session entry ID when available, optional author-supplied limit, and whether recovery adopted an existing response. Session tables keep the prompt-to-response entry range and the normal Pi message events.

An interrupted assistant-message attempt keeps its attempt ID when the origin Pi session resumes it. The executor adopts a matching completed assistant child from the active Pi branch instead of displaying the response twice. Submitted and non-agent attempts keep their normal fresh-attempt resume behavior.

## Write contract

A write command uses this order:

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

Status is a pure projection of domain rows, immutable facts, current leases, and effect receipts.

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
```

`status` reports only safe counts, file size, active leases, and unsettled effects.
It does not print actor IDs, channel references, payloads, or credentials.

## Alpha cutover

This is a hard cut. Pi Workflows has no normal reader or writer for older live storage. It does not use dual reads, dual writes, aliases, versioned state roots, or automatic import.

Older state remains untouched. If it is present when a new database would be created, Pi Workflows fails with a clear instruction instead of guessing or deleting data.
