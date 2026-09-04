# SQLite state

Status: this is the implemented single-server database contract. The [workflow-message plan](2026-09-02-unify-workflow-messages-plan.md) records the schema version 1 hard cut that unified Pi message state and restored hosted behavior. The [automatic state-retention plan](plans/2026-09-04-automatic-state-retention-plan.md) records the approved 30-day cleanup contract.

Pi Workflows stores all live durable state in one database:

```text
~/.pi/agent/workflows/state.sqlite
```

There is one database for the user installation. Project and run IDs separate data inside it. The server is the only production process that opens this live database. Workflow targets, extensions, CLI clients, Herdr adapters, and `piw` do not open it. Live clients use `pi-workflows.client.v1`.

## Viewer projection

The database includes the [incremental and virtualized viewer design](plans/2026-08-28-piw-incremental-viewer-plan.md). The server owns this projection and exposes it as the canonical live run view. Local and remote renderers do not recreate it or validate its SQLite tables.

`viewer_runs` stores one presentation revision and retained revision floor for each run. `viewer_deltas` stores ordered target patches by run, presentation revision, and delta index. `viewer_session_checkpoints` stores the bounded active message and tool state at each 256-event boundary. `run_view_content` stores generated reference bytes under the exact run ID, content digest, and media type. It is separate from general state blobs, and content reads require all three identities. A viewer-visible transaction writes the domain change, advances the presentation revision, and writes its patch blobs before the same commit. Session-event transactions write each reached replay checkpoint in that transaction.

The store retains 256 presentation revisions. A reader with an older cursor must take a bounded snapshot. Patches use `add`, `replace`, `remove`, and `append`. They target small projection documents or pages. Patch creation does not reconstruct and compare complete run views.

`session_entries` and `session_events` have run-wide sequence numbers and indexed `(run_id, run_seq)` ranges. Step, trace, entry, and event reads contain at most 256 rows. Run-list queries read metadata, status, lease facts, and the presentation revision. They do not read payload bodies.

This is an in-place alpha schema change. The schema name and version remain `pi-workflows-state` version 1. The DDL digest and exact shape changed. An older alpha database fails with the standard reset instruction and remains untouched. There is no compatibility reader, migration shim, dual path, feature flag, alias, or `v2` schema.

## Storage boundary

The database stores:

- workflow definitions, runs, events, node attempts, outputs, and updates
- global server epochs, command receipts, runner epochs, and runner messages
- durable origin-session interaction requests and submissions
- captured Pi session entries and events
- run and resource manager queues, claims, retries, and continuations
- human-decision requests, submissions, resolutions, and cancellations
- managed resources, finalizers, effects, and child workflows
- workflow messages that Pi must add to origin conversations
- workflow settings, accepted JSON Patch changes, and post-completion follow-up prompts
- nonsecret channel cursors, inbox records, messages, and settlement receipts
- canonical JSON, text, and large text values

Credentials and raw secrets must not enter the database. Channel credential files stay in their existing private configuration directory.

The implementation does not create live run directories, artifact files, decision directories, project databases, resource manager databases, or channel databases.

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

The server opens the active database. It verifies the application ID, user version, schema metadata, compiled DDL digest, and exact SQLite schema shape. An incompatible database fails with the standard backup-and-reset instruction. Pi Workflows does not import, reinterpret, or delete that state.

The server completes this verification before it serves any client, and no other production process opens the active database. A maintenance verifier may open an explicit inactive backup with SQLite read-only mode and `PRAGMA query_only = ON`. That offline verification path is not a live client and cannot select the active state database. TypeScript and Rust clients validate the client protocol and package versions, not the SQLite DDL digest.

The normalized run layout is an in-place alpha cutover. It keeps SQLite user version `1` and the current `v1` public record identifiers. A database with the former nested run-snapshot layout is incompatible and must be moved or removed. There is no migration, compatibility reader, dual write, alias, or second schema generation.

## Shared records

Four record groups provide the common lifecycle rules.

### Resources

`resources` identifies each mutable aggregate and holds its current revision. Runs, settings scopes, follow-up items, decisions, managed resources, effects, channels, workflow messages, and session segments have stable resource identities.

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

Local effects use deterministic transactions. For workflow action nodes, the engine creates the idempotency key from the run ID, effect type, full compiled node path, and node visit number. A projected child-workflow view cannot replace that full identity. Run queue settlement effects are created only for runs that have a `run_queue` row; direct engine and resource-manager child runs do not create phantom queue work. External effects use provider idempotency or observation when available. An uncertain result becomes `ambiguous` and is not repeated without evidence.

Telegram delivery and settlement use these shared effect records. The server records one numbered attempt before it tells the supervised adapter child to act. A confirmed result stores Telegram message references in the effect result. `channel_messages` stores the decision feature's delivery or settlement receipt; it does not copy effect state or external message references.

## Domain tables

The shared records do not replace domain schemas. The following `STRICT` tables keep the state explicit:

| Area                | Tables                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Schema and projects | `schema_meta`, `projects`                                                                                                    |
| Content             | `blobs`, `run_view_content`                                                                                                  |
| Shared lifecycle    | `resources`, `leases`, `events`, `workflow_host_state`                                                                       |
| Server protocol     | `host_commands`, `run_workers`, `worker_messages`, `interactive_requests`, `interactive_submissions`                         |
| Workflows           | `workflow_definitions`, `runs`, `run_sources`, `run_steps`, `run_bindings`, `run_queue`, `node_attempts`, `workflow_updates` |
| Live settings       | `workflow_settings`, `workflow_setting_changes`                                                                              |
| Post-run follow-ups | `workflow_follow_ups`                                                                                                        |
| Session capture     | `session_segments`, `session_entries`, `attempt_entries`, `session_events`                                                   |
| Human decisions     | `human_decisions`, `human_decision_resolutions`, `human_decision_submissions`, `continuations`                               |
| Managed resources   | `controller_resources`, `controller_finalizers`, `controller_queue`, `controller_workflows`                                  |
| Effects             | `effects`, `effect_attempts`                                                                                                 |
| Pi messages         | `workflow_messages`, `workflow_turns`                                                                                        |
| Channels            | `channels`, `channel_cursors`, `channel_messages`                                                                            |

The `host_*`, `run_workers`, `worker_*`, and `controller_*` names remain version-1 internal SQLite identifiers. The `host` and `controller` actor and owner values and the `~/.pi/agent/workflows/host/` state directory also remain internal identifiers. Public APIs and documentation call these components the workflow server, workflow runner, resource manager, resource runner, and managed resource. The alpha hard cut adds no alias or second storage path.

`workflow_messages` is the only table that owns adding workflow content to Pi. It stores the target session, message kind, source record, content digest, session order, `pending`, `sent`, or `cancelled` state, confirmed Pi entry ID, and creation and update times. The table stores no sender, send lease, `sending` state, or separate sent time. Active-branch evidence changes `pending` or `cancelled` to `sent`. Initial, reminder, and resumed prompts are all `step` messages; their custom details contain the reason. Interactive requests, decisions, terminal runs, notifications, follow-ups, and settings keep their own domain state.

`workflow_turns` stores the server-approved ownership of one Pi model turn. Each row names the exact workflow message, run, session, and turn ID. A partial unique index permits only one open turn for a message. The server checks for an exact saved turn or another open turn before insertion, so a normal conflict returns a controlled protocol error instead of a raw SQLite error. Terminalization ends every open turn for that run as `lost` in the same transaction. It cancels pending step and decision messages, plus follow-ups when the run did not complete successfully. Committed notifications remain eligible. Matching late reports adopt the saved result, while conflicting identities remain errors.

`channels` stores configured channel resource identities. `channel_cursors` stores the last accepted external polling position. `channel_messages` stores immutable decision delivery and settlement records for audit and duplicate evidence. External application state and Telegram message references belong to `effects` and `effect_attempts`.

Foreign keys join projects, runs, attempts, decisions, managed resources, effects, and channel records. Partial unique indexes enforce one active node attempt per run, one pending step message per interaction request, one nonterminal interactive continuation-chain reservation per Pi session, one decision winner, and one deterministic effect key. A run waiting for a checkpoint or protected decision keeps that chain reservation. A parked waiting parent does not block its own continuation. Reserving that continuation transfers the reservation and settles the parked parent queue in the same transaction, so a failed reservation leaves the parent recoverable.

### ServerBacked commands and interactions

`workflow_host_state` stores the one current server epoch and its live local
claim. `host_commands` stores each client request fingerprint, operation,
outcome, revision, and receipt or error. Repeating an exact request adopts the
stored receipt. Reusing an ID or idempotency key for another request is a
conflict.

`run_workers` records each runner epoch before spawn and later records its exact
process identity and terminal outcome. `worker_messages` deduplicates accepted
state-changing child messages.

`interactive_requests` owns the durable request contract and workflow state for origin-session work. It stores the run, node attempt, target session, contract, request status, accepted submission, `unproductiveTurnEnds`, and revision. Pause is stored once on the run and derived for its one pending interaction. `interactive_submissions` stores the idempotency key, payload, outcome, and receipt. It stores no Pi presentation claim or Pi session entry. `workflow_messages` owns those facts, and the extension reports the active Pi branch after reload.

## Content-addressed values

`blobs` stores canonical JSON and UTF-8 text as bytes. Its primary key is the 32-byte SHA-256 digest of the bytes. An oversized required runner result uses this same content-addressed store, and the runner reads and verifies it in bounded parts. It does not copy session history into runner resume state. `run_view_content` separately keeps server-generated large view values reachable for the life of the run, including aggregate outputs that do not exist as one source record. The server creates this link before it sends a content reference. Deleting the run removes the link, and normal blob pruning can then remove unreferenced content.

Insertion verifies the digest, media type, byte length, and exact bytes. Repeated content adopts the existing row. This replaces separate artifact files while keeping outputs, errors, settled Pi entries, and rendered channel text deduplicated. Automatic retention and explicit prune remove unreferenced blobs after they delete safe old run trees. They retain each blob referenced by a database foreign key or active runner transfer.

Runs do not store a nested `WorkflowRunState` blob. `runs` stores run-level facts and hashes for independent values. `run_sources` stores source identity without source JSON blobs. `node_attempts` stores structured workflow outputs and small execution receipts. `session_entries` is the only stored copy of each settled Pi entry. `attempt_entries` links an attempt to its prompt, response, first, and last Pi entries. `run_steps` stores ordered attempt membership and only stores an output override when a continuation changes a carried checkpoint answer.

Readers derive `steps`, `outputs`, `results`, carried-step count, current-node fields, waiting state, source objects, and continuation decision receipts from these rows. Compact trace events do not copy prompts, node outputs, run inputs, final outputs, action receipts, or assistant receipts.

The run store reads each independent value through its declared media type. Input and final output use JSON readers. Run errors and presentation instructions use text readers. Terminal-message construction uses one typed terminal-data result instead of guessing the blob type. A missing or wrong media type fails presentation after the terminal state commits; it cannot roll back that state.

### Assistant-message attempts

An agent definition records `expectedOutput` as either a submitted-output description or `{ "kind": "assistant-message", "maxChars"?: number }`. Omitted `maxChars` means that Pi Workflows adds no character limit.

A completed interactive assistant-message attempt stores the accepted visible text as its node output. Its small receipt keeps the text digest, final Pi session entry ID, optional author-supplied limit, and whether recovery adopted an existing response.

An interrupted assistant-message attempt keeps its attempt ID. The extension adopts a matching durable request and existing Pi branch entry instead of displaying the prompt or accepting the response twice. Submitted and non-agent attempts use a fresh execution attempt after an uncommitted runner exit.

## Write contract

A resource command uses this order:

```text
BEGIN IMMEDIATE
verify the exact schema
verify the actor and operation
verify the expected resource revision
verify the claim token, generation, and expiry when ownership is required
renew that exact still-live token and generation
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
- A resource manager claim owner may update resource manager status, reserve effects, and start child workflows for that resource.
- A verified human channel actor may submit one answer candidate for the named decision. It does not gain run ownership.
- The server-owned channel adapter path may update only its channel cursor, decision delivery and settlement records, and exact managed effects.
- Control commands have narrow explicit operations, such as requesting cancellation or deletion.
- Model-originated workflow answers cannot resolve protected human decisions.

The global server is the sole live database owner and the normal state writer. Its protected stores check ownership and renew the exact live claim in the same transaction as the write. A stale or expired owner cannot renew itself. Pi extensions, CLI commands, Herdr adapters, and the Rust `piw` program use the versioned client protocol for live reads and controls. They do not open the active database. Only explicit inactive backup verification remains a direct read-only SQLite operation.

## Competing outcomes

Each domain has one atomic winning fact.

Human answers, timeout policy, explicit cancellation, and no-default expiry compete through `human_decision_resolutions`. Its decision primary key allows one immutable winner.

A deadline with a validated default response is timeout-policy acceptance. It cannot become an expiry cancellation. Expiry cancellation is valid only when there is no default response.

Late or repeated commands return or adopt the durable winner. They do not overwrite it.

The same rule applies to run terminal outcomes, continuation admission, queue settlement, resource manager effects, retry scheduling, channel settlement, and workflow-turn reports through their domain constraints and expected revisions. A matching turn report adopts the saved ownership result. A different report for the same turn ID remains a conflict.

## Read contract

Durable status is a pure projection of domain rows, immutable facts, current leases, effect results, and exact workflow-turn start and end reports. The server uses these facts to produce one live run view. An open workflow turn can change display status only. It cannot change workflow authority. Every renderer consumes the server-produced display status and allowed controls without running another status reducer.

A settings scope uses its resource revision as its public change number. Each accepted patch, current value, and node binding is saved in one transaction. A checkpoint continuation keeps the same settings resources and transfers them to the continuation run.

`workflow_follow_ups` records source acceptance order, removal, and cancellation. The source and message stay attached to the continuation-chain member that accepted them; rows are not rewritten when the chain continues. The server walks the chain to find its final outcome. `workflow_messages` owns message state and Pi entry evidence. Failure, timeout, and cancellation cancel unsent follow-up messages.

- A terminal run fact overrides stale message state and has no open workflow turn.
- An accepted decision is accepted even if its continuation effect is still pending.
- A cancelled decision is cancelled even if parent cleanup is still pending.
- A stale owner is not shown as current.
- An ambiguous external effect is shown as unresolved.

Read paths do not repair state. Owner reconcilers apply pending effects and write receipts.

## Projects and concurrency

All projects use the same file. `projects` stores a stable ID and canonical path. Project-scoped resource manager and run queries use that key. One global server owns the file for the user installation. Its socket, lock, and exact child-process registry are under `~/.pi/agent/workflows/host/`. A second live server is rejected even when it was started from another project.

SQLite WAL keeps bounded projection reads consistent with commits. Writers are serialized by SQLite and must keep transactions short. Hashing, model calls, shell work, and external requests happen outside write transactions. Production clients receive revisioned snapshots, patches, and pages from the server instead of opening concurrent SQLite readers.

This contract is for local storage on one machine. It does not claim distributed consensus or network-filesystem safety.

## Automatic retention

The server keeps terminal root-run trees for 30 days from `finished_at`. A tree is eligible only when every restart or continuation descendant is terminal, older than the cutoff, free of protected work, and free of references from outside the tree.

Automatic cleanup keeps a tree when it has a waiting or parked run, a live queue row, a pending workflow message, an open workflow turn, a pending interaction or human decision, a recording session segment, a queued follow-up, an active lease, an unsettled effect, controller ownership, an active runner content hash, a resumable checkpoint, an undelivered terminal result, or a continuation or step reference from outside the tree. Unknown or conflicting ownership also blocks deletion.

The server requests cleanup after startup recovery and after workflow runners exit. It also schedules the next daily check after a completed sweep. Overlapping requests use one in-process task. Cleanup starts only while there is no active or pending workflow runner, resource-manager runner, state-maintenance command, or shutdown. One server process completes no more than one sweep in 24 hours. A due sweep that finds work active or stops between trees remains due. The next idle lifecycle trigger or a five-minute idle retry continues it.

Automatic cleanup does not create a backup. It rechecks and deletes one complete root tree in one transaction, yields, and checks for new work before it selects another tree. Manual prune uses the same selection and deletion code, but keeps its backup requirement.

After logical deletion, the server truncates the WAL while idle and measures `page_count`, `freelist_count`, and `page_size`. SQLite can reuse free pages without shrinking the main file. Automatic cleanup runs `VACUUM` only while the server remains idle, at least 64 MiB is reclaimable, and at least 20 percent of pages are free. A skipped or failed `VACUUM` does not undo committed deletion. The server reports the result and leaves the free pages available for reuse.

A cleanup error does not fail a workflow or stop the server. The server records one bounded diagnostic and waits five minutes before another safe attempt. It does not retry in a tight loop.

Retained runs keep their current resume, viewer, content-reference, and terminal-result behavior. A deleted run is absent from run lists and direct views. Cleanup never edits Pi session history.

The retention policy does not promise a hard database-size limit. Recent or protected work can be large, and physical file shrink depends on a safe, successful `VACUUM`.

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

These commands send maintenance operations to the server when they target the active database. Only `pi-workflows state verify` with an explicit inactive backup opens SQLite in the command process. It rejects the active database, including another path to the same file.

`status` reports only safe counts, file size, active leases, and unsettled effects.
It does not print actor IDs, channel references, payloads, or credentials.

`prune --dry-run` reports complete terminal run trees older than the cutoff and the trees that safety checks block. It does not change the database. `prune --apply` requires a new absolute backup path. It verifies the backup, locks maintenance, rechecks the same selection in an exclusive transaction, deletes safe aggregates and unreferenced blobs, checkpoints the WAL, vacuums the file, and runs integrity and foreign-key checks. The manual command and automatic retention use the same blocker rules. Automatic retention starts after server recovery and does not create a backup.

## Alpha cutover

The persisted-state alpha boundary is a hard cut. Pi Workflows has no normal reader or writer for older live storage. It does not use dual reads, dual writes, aliases, versioned state roots, or automatic import. No direct live-state client, replay server reader, or Rust SQLite fallback remains outside the server.

Older state remains untouched. Pi Workflows fails before mutation with this instruction: “Pi Workflows durable state is incompatible. Back up and move state.sqlite with its -wal and -shm files, then start Pi Workflows to create a new state.sqlite database. The incompatible state was not changed.”
