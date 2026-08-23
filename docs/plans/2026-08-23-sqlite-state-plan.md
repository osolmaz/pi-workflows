---
title: Move durable workflow state to SQLite
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-23
status: implemented
---

# SQLite state plan

## Goal

Replace the split file and SQLite stores with one database:

```text
~/.pi/agent/workflows/state.sqlite
```

This database becomes the only live source of workflow state. It stores workflow definitions, runs, events, node attempts, outputs, progress updates, Pi session capture, queues, claims, human decisions, continuations, cancellation, controllers, retries, notifications, deferred turns, channel transport state, effects, receipts, and the large text values currently stored as artifact files.

The replacement must also fix the broader ownership problem. Finding shared state never grants permission to change it. Every write checks the actor, current owner when ownership is required, ownership generation, expected resource revision, and requested state transition in the same transaction.

The current formats are specified in [Run bundle format](../SQLITE_STATE.md), [Human decisions](../HUMAN_DECISIONS.md), and [Controller runtime specification](../CONTROLLERS.md). This plan replaces their storage sections. Workflow authoring behavior stays the same unless this plan names a required contract change.

## Boundaries

The implementation may change Pi Workflows source and documentation, including tests and viewers. It may change internal and persisted contracts in place under the repository's alpha policy.

The implementation must not:

- change Pi core or OnurPi
- add a service, daemon, network coordinator, or another database product
- change workflow targets or require them to use a Pi Workflows API
- store credentials or raw secrets
- keep an old storage reader or writer
- add dual reads, dual writes, migration code, aliases, or versioned storage directories
- import, reinterpret, or delete old state automatically
- promise exactly-once remote effects when a provider cannot prove them
- deploy, release, or publish a package as part of the implementation task

## Selected design

Use one SQLite database per user installation. Projects and runs share that database as keyed rows.

Use four shared records:

- A **resource** is one mutable item, such as a run, decision, controller resource, effect, or channel.
- A **lease** says which process currently owns a resource. Every ownership change increases a durable generation number.
- An **event** is the immutable audit record for one accepted resource change.
- An **effect** is follow-up work created by a resource change, such as creating a continuation, delivering a notification, or closing a decision presentation.

Keep workflow and decision rules in named domain tables, along with controller and channel rules. Shared tables provide revision checks and ownership, plus event ordering, content storage, and effect execution. They must not become a generic JSON state machine.

## Database contract

### Location

The production database path is fixed:

```text
~/.pi/agent/workflows/state.sqlite
```

Tests use a temporary home directory. The implementation removes `PI_WORKFLOWS_RUNS_DIR` and `PI_WORKFLOWS_CONTROLLER_DIR` instead of giving live storage several roots.

### Connection settings

Every connection enables:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

The implementation must also:

- use `STRICT` tables
- set a fixed `PRAGMA application_id`
- set `PRAGMA user_version = 1`
- set a bounded WAL checkpoint policy and journal size limit
- create the parent directory with mode `0700`
- create the database with mode `0600`
- open viewer connections with `PRAGMA query_only = ON`
- use the SQLite backup API instead of copying an active database file
- run an integrity check before any schema repair or replacement
- run a foreign-key check as part of verification and backup validation

### Schema identity

`schema_meta` stores the expected schema name, version, canonical DDL digest, application version, and timestamps. Opening code compares all of these with the compiled schema before exposing the connection.

The implementation rejects:

- the wrong `application_id`
- an unsupported `user_version`
- a missing or changed `schema_meta` row
- an unexpected table, column, index, trigger, or constraint
- a different canonical DDL digest
- failed integrity or foreign-key checks

There is no migration framework in this alpha change. An incompatible database produces one clear reset instruction.

### Time and identifiers

- Store timestamps as UTC epoch milliseconds in `INTEGER` columns.
- Keep every public identifier as `TEXT`, including run and message identifiers.
- Store SHA-256 values as 32-byte `BLOB` values.
- Store booleans as constrained `INTEGER` values `0` or `1`.
- Use `CHECK` constraints for every closed status or type set.
- Use foreign keys for every relation that SQLite can enforce.

## Core schema

### `schema_meta`

One row describes the exact database shape.

| Field            | Type      | Rules                                          |
| ---------------- | --------- | ---------------------------------------------- |
| `id`             | `INTEGER` | Primary key, always `1`                        |
| `schema_name`    | `TEXT`    | Always `pi-workflows-state`                    |
| `schema_version` | `INTEGER` | Always `1` for this schema                     |
| `schema_digest`  | `BLOB`    | 32-byte SHA-256 of canonical DDL               |
| `app_version`    | `TEXT`    | Package version that created the current shape |
| `created_at`     | `INTEGER` | Creation time                                  |
| `updated_at`     | `INTEGER` | Last schema write time                         |

### `projects`

Projects separate repository-local workflows and controllers without separate databases.

| Field            | Type      | Rules                                    |
| ---------------- | --------- | ---------------------------------------- |
| `project_id`     | `TEXT`    | Primary key, derived from canonical path |
| `canonical_path` | `TEXT`    | Unique absolute path                     |
| `created_at`     | `INTEGER` | Creation time                            |

### `blobs`

`blobs` replaces artifact files and repeated JSON payloads. It stores canonical JSON and UTF-8 text as bytes.

| Field         | Type      | Rules                                          |
| ------------- | --------- | ---------------------------------------------- |
| `blob_hash`   | `BLOB`    | Primary key, 32-byte SHA-256                   |
| `media_type`  | `TEXT`    | For example `application/json` or `text/plain` |
| `byte_length` | `INTEGER` | Non-negative and equal to `length(content)`    |
| `content`     | `BLOB`    | Original canonical bytes                       |
| `created_at`  | `INTEGER` | First insertion time                           |

Insertion hashes the original bytes and rejects a hash or length mismatch. JSON is canonicalized before hashing. Repeated content adopts the existing row only when its media type and length match and its bytes are identical.

### `resources`

`resources` provides one revision counter for each mutable item.

| Field           | Type      | Rules                                                   |
| --------------- | --------- | ------------------------------------------------------- |
| `resource_id`   | `TEXT`    | Primary key                                             |
| `resource_type` | `TEXT`    | `run`, `decision`, `controller`, `effect`, or `channel` |
| `revision`      | `INTEGER` | Starts at `0`, increases once per accepted change       |
| `created_at`    | `INTEGER` | Creation time                                           |
| `updated_at`    | `INTEGER` | Last accepted change time                               |

A resource type cannot change. A command supplies the expected revision. A successful transaction changes it from `n` to `n + 1` and inserts event revision `n + 1`.

### `leases`

`leases` records current ownership. The row remains after release so the generation never resets.

| Field          | Type      | Rules                                                             |
| -------------- | --------- | ----------------------------------------------------------------- |
| `resource_id`  | `TEXT`    | Primary key, foreign key to `resources`                           |
| `generation`   | `INTEGER` | Starts at `0`, increases on every successful claim                |
| `owner_type`   | `TEXT`    | `session`, `host`, `controller`, or `channel`; nullable when free |
| `owner_id`     | `TEXT`    | Private local owner ID; nullable when free                        |
| `token_hash`   | `BLOB`    | SHA-256 of the random claim token; nullable when free             |
| `acquired_at`  | `INTEGER` | Nullable when free                                                |
| `heartbeat_at` | `INTEGER` | Nullable when free                                                |
| `expires_at`   | `INTEGER` | Nullable when free                                                |

A table check requires all owner fields to be set together or all to be null. Claiming an unowned or expired lease increments `generation`, writes the owner data, and returns the raw random token plus generation. Releasing a lease clears owner data and keeps the generation.

Indexes cover `expires_at` and `(owner_type, owner_id)`.

### `events`

`events` is the immutable audit history.

| Field               | Type      | Rules                                                                                 |
| ------------------- | --------- | ------------------------------------------------------------------------------------- |
| `event_seq`         | `INTEGER` | Global autoincrement primary key                                                      |
| `event_id`          | `TEXT`    | Unique public event ID                                                                |
| `resource_id`       | `TEXT`    | Foreign key to `resources`                                                            |
| `resource_revision` | `INTEGER` | Positive revision accepted by this event                                              |
| `event_type`        | `TEXT`    | Domain event name                                                                     |
| `actor_type`        | `TEXT`    | `session`, `host`, `controller`, `channel`, `human`, `policy`, `control`, or `system` |
| `actor_id`          | `TEXT`    | Private local actor ID when applicable                                                |
| `lease_generation`  | `INTEGER` | Ownership generation used for the write, when applicable                              |
| `payload_hash`      | `BLOB`    | Optional foreign key to `blobs`                                                       |
| `recorded_at`       | `INTEGER` | Commit time                                                                           |

`(resource_id, resource_revision)` is unique. Events are inserted in the same transaction as the matching domain change. Normal store APIs never update or delete them.

## Workflow schema

### `workflow_definitions`

This table stores immutable normalized workflow snapshots.

| Field               | Type      | Rules                                               |
| ------------------- | --------- | --------------------------------------------------- |
| `definition_digest` | `BLOB`    | Primary key, 32-byte digest                         |
| `workflow_name`     | `TEXT`    | Workflow name                                       |
| `definition_hash`   | `BLOB`    | Foreign key to canonical definition JSON in `blobs` |
| `created_at`        | `INTEGER` | First insertion time                                |

Run-specific source identity stays on `runs` because two sources can resolve to the same definition.

### `runs`

`runs` is the current run snapshot. It is updated with the matching event in one transaction.

| Field                  | Type      | Rules                                                                              |
| ---------------------- | --------- | ---------------------------------------------------------------------------------- |
| `run_id`               | `TEXT`    | Primary key                                                                        |
| `resource_id`          | `TEXT`    | Unique foreign key to a `run` resource                                             |
| `project_id`           | `TEXT`    | Nullable foreign key to `projects`                                                 |
| `parent_run_id`        | `TEXT`    | Nullable self-reference                                                            |
| `definition_digest`    | `BLOB`    | Foreign key to `workflow_definitions`                                              |
| `workflow_ref`         | `TEXT`    | Workflow name or requested catalog reference                                       |
| `workflow_source_hash` | `BLOB`    | Canonical source identity in `blobs`                                               |
| `launch_options_hash`  | `BLOB`    | Canonical launch options in `blobs`                                                |
| `source_type`          | `TEXT`    | `builtin` or `file`                                                                |
| `source_ref`           | `TEXT`    | Built-in ID or absolute file path                                                  |
| `source_revision`      | `TEXT`    | Built-in revision or file hash                                                     |
| `title`                | `TEXT`    | Optional display title                                                             |
| `status`               | `TEXT`    | `queued`, `running`, `waiting`, `completed`, `failed`, `timed_out`, or `cancelled` |
| `paused`               | `INTEGER` | Constrained boolean                                                                |
| `status_detail`        | `TEXT`    | Optional current detail                                                            |
| `input_hash`           | `BLOB`    | Required foreign key to `blobs`                                                    |
| `output_hash`          | `BLOB`    | Nullable foreign key to `blobs`                                                    |
| `error_hash`           | `BLOB`    | Nullable foreign key to `blobs`                                                    |
| `created_at`           | `INTEGER` | Creation time                                                                      |
| `updated_at`           | `INTEGER` | Last state change                                                                  |
| `finished_at`          | `INTEGER` | Set for terminal status                                                            |

Do not store a second root-run ID. It can be found through `parent_run_id`. Do not store the current node separately. The one active node attempt identifies it.

Indexes cover `(project_id, created_at)`, `(status, updated_at)`, and `parent_run_id`.

### `run_bindings`

This table records the Pi session that owns interactive execution.

| Field               | Type      | Rules                              |
| ------------------- | --------- | ---------------------------------- |
| `run_id`            | `TEXT`    | Primary key, foreign key to `runs` |
| `origin_session_id` | `TEXT`    | Pi session ID                      |
| `execution_mode`    | `TEXT`    | `interactive` or `headless`        |
| `created_at`        | `INTEGER` | Binding time                       |

### `run_queue`

`run_queue` contains scheduling data. Ownership remains in the run resource lease.

| Field                | Type      | Rules                                                                       |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `run_id`             | `TEXT`    | Primary key, foreign key to `runs`                                          |
| `status`             | `TEXT`    | `queued`, `starting`, `running`, `parked`, `done`, `failed`, or `cancelled` |
| `available_at`       | `INTEGER` | Earliest claim time                                                         |
| `affinity_runner_id` | `TEXT`    | Optional preferred owner                                                    |
| `origin_session_id`  | `TEXT`    | Session reservation copied for an enforceable partial unique index          |
| `consecutive_errors` | `INTEGER` | Non-negative retry count                                                    |
| `error_code`         | `TEXT`    | Optional stable code                                                        |
| `error_hash`         | `BLOB`    | Optional detail in `blobs`                                                  |
| `created_at`         | `INTEGER` | Creation time                                                               |
| `updated_at`         | `INTEGER` | Last queue change                                                           |
| `started_at`         | `INTEGER` | First execution time                                                        |
| `finished_at`        | `INTEGER` | Terminal queue time                                                         |

Indexes cover claimable status and time. A partial unique index permits one queued, starting, or running reservation per origin session. Parked waiting parents are excluded, and continuation reservation settles the parent queue in the same transaction. `continuations` keeps parent linkage unique.

### `node_attempts`

Each node execution gets one row.

| Field               | Type      | Rules                                                                               |
| ------------------- | --------- | ----------------------------------------------------------------------------------- |
| `attempt_id`        | `TEXT`    | Primary key                                                                         |
| `run_id`            | `TEXT`    | Foreign key to `runs`                                                               |
| `node_id`           | `TEXT`    | Resolved node ID                                                                    |
| `attempt_number`    | `INTEGER` | Positive number for this run and node                                               |
| `node_type`         | `TEXT`    | Recorded node type                                                                  |
| `status`            | `TEXT`    | `pending`, `running`, `waiting`, `completed`, `failed`, `timed_out`, or `cancelled` |
| `input_hash`        | `BLOB`    | Optional input in `blobs`                                                           |
| `contract_hash`     | `BLOB`    | Optional model contract in `blobs`                                                  |
| `presentation_hash` | `BLOB`    | Optional presentation in `blobs`                                                    |
| `output_hash`       | `BLOB`    | Optional output in `blobs`                                                          |
| `result_hash`       | `BLOB`    | Optional full result in `blobs`                                                     |
| `error_hash`        | `BLOB`    | Optional failure in `blobs`                                                         |
| `started_at`        | `INTEGER` | Start time                                                                          |
| `deadline_at`       | `INTEGER` | Optional deadline                                                                   |
| `finished_at`       | `INTEGER` | Terminal time                                                                       |
| `created_at`        | `INTEGER` | Row creation time                                                                   |
| `updated_at`        | `INTEGER` | Last state change                                                                   |

`(run_id, node_id, attempt_number)` is unique. A partial unique index allows only one `pending`, `running`, or `waiting` attempt per run.

### `workflow_updates`

| Field         | Type      | Rules                                |
| ------------- | --------- | ------------------------------------ |
| `update_id`   | `TEXT`    | Primary key                          |
| `attempt_id`  | `TEXT`    | Foreign key to `node_attempts`       |
| `update_seq`  | `INTEGER` | Positive sequence within the attempt |
| `update_type` | `TEXT`    | Update type                          |
| `update_key`  | `TEXT`    | Stable key within the type           |
| `data_hash`   | `BLOB`    | Foreign key to `blobs`               |
| `recorded_at` | `INTEGER` | Acceptance time                      |

`(attempt_id, update_seq)` is unique. The current update for a `(type, key)` pair is the greatest accepted sequence.

## Session capture schema

### `session_segments`

One row represents one Pi capture segment for a run owner tenure.

| Field          | Type      | Rules                                    |
| -------------- | --------- | ---------------------------------------- |
| `segment_id`   | `TEXT`    | Primary key                              |
| `run_id`       | `TEXT`    | Foreign key to `runs`                    |
| `attempt_id`   | `TEXT`    | Optional foreign key to `node_attempts`  |
| `capture_key`  | `TEXT`    | Stable key for a later owner segment     |
| `session_id`   | `TEXT`    | Pi session ID                            |
| `resource_id`  | `TEXT`    | Unique foreign key to a session resource |
| `binding_hash` | `BLOB`    | Complete session binding in `blobs`      |
| `status`       | `TEXT`    | `recording`, `complete`, or `failed`     |
| `entry_count`  | `INTEGER` | Non-negative accepted count              |
| `event_count`  | `INTEGER` | Non-negative accepted count              |
| `failure_hash` | `BLOB`    | Optional failure in `blobs`              |
| `created_at`   | `INTEGER` | Segment start                            |
| `finished_at`  | `INTEGER` | Segment end                              |

### `session_entries`

| Field         | Type      | Rules                             |
| ------------- | --------- | --------------------------------- |
| `segment_id`  | `TEXT`    | Foreign key to `session_segments` |
| `entry_seq`   | `INTEGER` | Positive contiguous sequence      |
| `entry_id`    | `TEXT`    | Pi entry ID                       |
| `entry_hash`  | `BLOB`    | Verbatim entry JSON in `blobs`    |
| `recorded_at` | `INTEGER` | Capture time                      |

The primary key is `(segment_id, entry_seq)`. `(segment_id, entry_id)` is unique.

### `session_events`

| Field          | Type      | Rules                             |
| -------------- | --------- | --------------------------------- |
| `segment_id`   | `TEXT`    | Foreign key to `session_segments` |
| `event_seq`    | `INTEGER` | Positive contiguous sequence      |
| `event_type`   | `TEXT`    | Documented Pi event type          |
| `node_id`      | `TEXT`    | Optional node ID                  |
| `attempt_id`   | `TEXT`    | Optional attempt ID               |
| `turn_id`      | `TEXT`    | Optional Pi turn ID               |
| `message_id`   | `TEXT`    | Optional Pi message ID            |
| `tool_call_id` | `TEXT`    | Optional Pi tool call ID          |
| `payload_hash` | `BLOB`    | Event payload in `blobs`          |
| `recorded_at`  | `INTEGER` | Capture time                      |

The primary key is `(segment_id, event_seq)`.

## Human decision schema

### `human_decisions`

The request row is immutable after insertion.

| Field                   | Type      | Rules                                     |
| ----------------------- | --------- | ----------------------------------------- |
| `decision_id`           | `TEXT`    | Primary key                               |
| `resource_id`           | `TEXT`    | Unique foreign key to a decision resource |
| `run_id`                | `TEXT`    | Foreign key to `runs`                     |
| `attempt_id`            | `TEXT`    | Foreign key to `node_attempts`            |
| `audience`              | `TEXT`    | Logical audience                          |
| `title`                 | `TEXT`    | Display title                             |
| `subject_hash`          | `BLOB`    | Canonical subject in `blobs`              |
| `presentation_hash`     | `BLOB`    | Allowed display document in `blobs`       |
| `choices_hash`          | `BLOB`    | Choice contract in `blobs`                |
| `request_digest`        | `BLOB`    | Unique 32-byte digest                     |
| `presentation_revision` | `INTEGER` | Positive revision                         |
| `deadline_at`           | `INTEGER` | Optional deadline                         |
| `default_response_hash` | `BLOB`    | Optional validated policy response        |
| `request_hash`          | `BLOB`    | Complete immutable request in `blobs`     |
| `created_at`            | `INTEGER` | Creation time                             |

Indexes cover `run_id` and `deadline_at`.

### `human_decision_resolutions`

The primary key permits one immutable winner.

| Field               | Type      | Rules                                                                 |
| ------------------- | --------- | --------------------------------------------------------------------- |
| `decision_id`       | `TEXT`    | Primary key, foreign key to `human_decisions`                         |
| `outcome`           | `TEXT`    | `accepted` or `cancelled`                                             |
| `provenance`        | `TEXT`    | `human`, `timeout_policy`, `explicit_cancel`, or `expired_no_default` |
| `response_hash`     | `BLOB`    | Required for acceptance                                               |
| `reason`            | `TEXT`    | Required for cancellation                                             |
| `channel`           | `TEXT`    | Human channel when applicable                                         |
| `actor_id`          | `TEXT`    | Private verified actor ID when applicable                             |
| `external_event_id` | `TEXT`    | Channel event ID when applicable                                      |
| `idempotency_key`   | `TEXT`    | Source idempotency key when applicable                                |
| `resolution_digest` | `BLOB`    | Unique 32-byte digest                                                 |
| `resolved_at`       | `INTEGER` | Winning time                                                          |

Checks enforce the accepted and cancelled field combinations.

### `human_decision_submissions`

This table records all human answer attempts without granting them authority.

| Field               | Type      | Rules                                                        |
| ------------------- | --------- | ------------------------------------------------------------ |
| `submission_id`     | `TEXT`    | Primary key                                                  |
| `decision_id`       | `TEXT`    | Foreign key to `human_decisions`                             |
| `request_digest`    | `BLOB`    | Request observed by the sender                               |
| `channel`           | `TEXT`    | Verified source channel                                      |
| `actor_id`          | `TEXT`    | Verified actor                                               |
| `external_event_id` | `TEXT`    | Source event                                                 |
| `idempotency_key`   | `TEXT`    | Unique within channel                                        |
| `response_hash`     | `BLOB`    | Submitted response in `blobs`                                |
| `result`            | `TEXT`    | `won`, `adopted`, `already_resolved`, `stale`, or `rejected` |
| `winner_digest`     | `BLOB`    | Existing winner when applicable                              |
| `submitted_at`      | `INTEGER` | Attempt time                                                 |

`(channel, idempotency_key)` is unique.

### `continuations`

| Field             | Type      | Rules                                               |
| ----------------- | --------- | --------------------------------------------------- |
| `continuation_id` | `TEXT`    | Primary key                                         |
| `parent_run_id`   | `TEXT`    | Foreign key to `runs`                               |
| `trigger_type`    | `TEXT`    | `decision`, `checkpoint`, `controller`, or `manual` |
| `trigger_id`      | `TEXT`    | Stable trigger identity                             |
| `child_run_id`    | `TEXT`    | Unique foreign key to `runs`                        |
| `input_hash`      | `BLOB`    | Continuation input in `blobs`                       |
| `created_at`      | `INTEGER` | Admission time                                      |

`(trigger_type, trigger_id)` is unique.

## Controller schema

### `controller_resources`

| Field                    | Type      | Rules                                       |
| ------------------------ | --------- | ------------------------------------------- |
| `controller_resource_id` | `TEXT`    | Primary key                                 |
| `resource_id`            | `TEXT`    | Unique foreign key to a controller resource |
| `project_id`             | `TEXT`    | Foreign key to `projects`                   |
| `controller_name`        | `TEXT`    | Controller definition name                  |
| `resource_key`           | `TEXT`    | Key within controller and project           |
| `resource_uid`           | `TEXT`    | Unique durable UID                          |
| `spec_generation`        | `INTEGER` | Positive desired-state generation           |
| `spec_hash`              | `BLOB`    | Spec JSON in `blobs`                        |
| `status_hash`            | `BLOB`    | Status JSON in `blobs`                      |
| `deletion_requested_at`  | `INTEGER` | Optional deletion time                      |
| `created_at`             | `INTEGER` | Creation time                               |
| `updated_at`             | `INTEGER` | Last accepted change                        |

`(project_id, controller_name, resource_key)` is unique. `resources.revision` replaces the separate controller resource version.

### `controller_finalizers`

| Field                    | Type   | Rules                                 |
| ------------------------ | ------ | ------------------------------------- |
| `controller_resource_id` | `TEXT` | Foreign key to `controller_resources` |
| `finalizer`              | `TEXT` | Finalizer name                        |

The primary key is `(controller_resource_id, finalizer)`.

### `controller_queue`

| Field                    | Type      | Rules                                              |
| ------------------------ | --------- | -------------------------------------------------- |
| `controller_resource_id` | `TEXT`    | Primary key, foreign key to `controller_resources` |
| `available_at`           | `INTEGER` | Earliest claim time                                |
| `queue_version`          | `INTEGER` | Monotonic enqueue generation                       |
| `consecutive_errors`     | `INTEGER` | Non-negative retry count                           |
| `last_error_hash`        | `BLOB`    | Optional error in `blobs`                          |
| `created_at`             | `INTEGER` | Enqueue time                                       |
| `updated_at`             | `INTEGER` | Last queue change                                  |

Ownership uses the controller resource lease.

### `controller_workflows`

| Field                    | Type      | Rules                                                                    |
| ------------------------ | --------- | ------------------------------------------------------------------------ |
| `request_id`             | `TEXT`    | Primary key                                                              |
| `controller_resource_id` | `TEXT`    | Foreign key to `controller_resources`                                    |
| `request_key`            | `TEXT`    | Stable key from controller code                                          |
| `workflow_name`          | `TEXT`    | Requested workflow                                                       |
| `input_fingerprint`      | `BLOB`    | 32-byte digest                                                           |
| `reserved_run_id`        | `TEXT`    | Deterministic run ID before the run row exists                           |
| `run_id`                 | `TEXT`    | Optional foreign key to `runs`                                           |
| `status`                 | `TEXT`    | `pending`, `running`, `waiting`, `succeeded`, `failed`, or `interrupted` |
| `attempt_count`          | `INTEGER` | Non-negative count                                                       |
| `error_hash`             | `BLOB`    | Optional error in `blobs`                                                |
| `created_at`             | `INTEGER` | Creation time                                                            |
| `updated_at`             | `INTEGER` | Last change                                                              |

`(controller_resource_id, request_key)` is unique.

## Effect schema

### `effects`

`effects` is the transactional outbox. Each effect is also a resource and receives its own lease.

| Field                | Type      | Rules                                                                     |
| -------------------- | --------- | ------------------------------------------------------------------------- |
| `effect_id`          | `TEXT`    | Primary key                                                               |
| `resource_id`        | `TEXT`    | Unique foreign key to an effect resource                                  |
| `source_resource_id` | `TEXT`    | Resource that created the effect                                          |
| `source_revision`    | `INTEGER` | Exact source revision                                                     |
| `effect_type`        | `TEXT`    | Domain effect name                                                        |
| `idempotency_key`    | `TEXT`    | Stable key within source and type                                         |
| `payload_hash`       | `BLOB`    | Effect request in `blobs`                                                 |
| `owner_scope`        | `TEXT`    | `run`, `controller`, `channel`, or `system`                               |
| `status`             | `TEXT`    | `pending`, `applying`, `applied`, `rejected`, `ambiguous`, or `cancelled` |
| `attempt_count`      | `INTEGER` | Non-negative count                                                        |
| `next_attempt_at`    | `INTEGER` | Optional retry time                                                       |
| `result_hash`        | `BLOB`    | Optional result in `blobs`                                                |
| `external_ref`       | `TEXT`    | Optional provider reference                                               |
| `error_hash`         | `BLOB`    | Optional error in `blobs`                                                 |
| `created_at`         | `INTEGER` | Intent time                                                               |
| `updated_at`         | `INTEGER` | Last state change                                                         |
| `settled_at`         | `INTEGER` | Terminal time                                                             |

`(source_resource_id, effect_type, idempotency_key)` is unique. An identical duplicate adopts the existing effect. A different payload under the same key is a conflict.

### `effect_attempts`

| Field              | Type      | Rules                                                |
| ------------------ | --------- | ---------------------------------------------------- |
| `effect_id`        | `TEXT`    | Foreign key to `effects`                             |
| `attempt_number`   | `INTEGER` | Positive sequence                                    |
| `owner_id`         | `TEXT`    | Private owner ID                                     |
| `lease_generation` | `INTEGER` | Generation used for this attempt                     |
| `started_at`       | `INTEGER` | Attempt start                                        |
| `finished_at`      | `INTEGER` | Attempt end                                          |
| `outcome`          | `TEXT`    | `applied`, `rejected`, `ambiguous`, or `interrupted` |
| `result_hash`      | `BLOB`    | Optional result in `blobs`                           |
| `error_hash`       | `BLOB`    | Optional error in `blobs`                            |

The primary key is `(effect_id, attempt_number)`.

## Pi delivery schema

### `notifications`

| Field                | Type      | Rules                           |
| -------------------- | --------- | ------------------------------- |
| `notification_id`    | `TEXT`    | Primary key                     |
| `effect_id`          | `TEXT`    | Unique foreign key to `effects` |
| `run_id`             | `TEXT`    | Foreign key to `runs`           |
| `attempt_id`         | `TEXT`    | Foreign key to `node_attempts`  |
| `notification_index` | `INTEGER` | Stable node execution index     |
| `target_session_id`  | `TEXT`    | Pi session target               |
| `notification_type`  | `TEXT`    | `progress` or `final`           |
| `content_hash`       | `BLOB`    | Text in `blobs`                 |
| `created_at`         | `INTEGER` | Creation time                   |

`(run_id, attempt_id, notification_index)` is unique.

### `turn_intents`

| Field               | Type      | Rules                                  |
| ------------------- | --------- | -------------------------------------- |
| `turn_intent_id`    | `TEXT`    | Primary key                            |
| `effect_id`         | `TEXT`    | Unique foreign key to `effects`        |
| `run_id`            | `TEXT`    | Foreign key to `runs`                  |
| `target_session_id` | `TEXT`    | Pi session target                      |
| `resolution_type`   | `TEXT`    | Existing deferred-turn resolution type |
| `facts_hash`        | `BLOB`    | Safe facts in `blobs`                  |
| `eligible_at`       | `INTEGER` | Earliest delivery time                 |
| `created_at`        | `INTEGER` | Creation time                          |

## Channel schema

### `channels`

This table stores nonsecret runtime identity. Private channel configuration and credential references remain in their existing protected configuration files.

| Field          | Type      | Rules                                    |
| -------------- | --------- | ---------------------------------------- |
| `channel_id`   | `TEXT`    | Primary key                              |
| `resource_id`  | `TEXT`    | Unique foreign key to a channel resource |
| `adapter_type` | `TEXT`    | For example `pi` or `telegram`           |
| `profile_key`  | `TEXT`    | Private local profile key                |
| `created_at`   | `INTEGER` | Creation time                            |

### `channel_cursors`

| Field          | Type      | Rules                     |
| -------------- | --------- | ------------------------- |
| `channel_id`   | `TEXT`    | Foreign key to `channels` |
| `cursor_key`   | `TEXT`    | Adapter cursor name       |
| `cursor_value` | `TEXT`    | Adapter cursor value      |
| `updated_at`   | `INTEGER` | Last change               |

The primary key is `(channel_id, cursor_key)`.

### `channel_inbox`

This table replaces separate callback and reply tables.

| Field               | Type      | Rules                                |
| ------------------- | --------- | ------------------------------------ |
| `channel_id`        | `TEXT`    | Foreign key to `channels`            |
| `external_event_id` | `TEXT`    | Provider event ID                    |
| `event_type`        | `TEXT`    | `callback` or `reply` for Telegram   |
| `payload_hash`      | `BLOB`    | Validated private payload in `blobs` |
| `received_at`       | `INTEGER` | Receipt time                         |
| `processed_at`      | `INTEGER` | Optional completion time             |
| `result_hash`       | `BLOB`    | Optional result in `blobs`           |

The primary key is `(channel_id, external_event_id)`.

### `channel_messages`

| Field                       | Type      | Rules                                            |
| --------------------------- | --------- | ------------------------------------------------ |
| `message_id`                | `TEXT`    | Primary key                                      |
| `channel_id`                | `TEXT`    | Foreign key to `channels`                        |
| `decision_id`               | `TEXT`    | Optional foreign key to `human_decisions`        |
| `purpose`                   | `TEXT`    | `delivery` or `settlement`                       |
| `content_hash`              | `BLOB`    | Rendered text in `blobs`                         |
| `external_conversation_ref` | `TEXT`    | Private provider conversation reference          |
| `external_message_ref`      | `TEXT`    | Private provider message reference               |
| `status`                    | `TEXT`    | `pending`, `confirmed`, `failed`, or `ambiguous` |
| `created_at`                | `INTEGER` | Creation time                                    |
| `updated_at`                | `INTEGER` | Last change                                      |

### `channel_message_parts`

| Field                       | Type      | Rules                             |
| --------------------------- | --------- | --------------------------------- |
| `message_id`                | `TEXT`    | Foreign key to `channel_messages` |
| `recipient_index`           | `INTEGER` | Zero-based recipient number       |
| `part_index`                | `INTEGER` | Zero-based part number            |
| `content_hash`              | `BLOB`    | Part digest or content in `blobs` |
| `external_conversation_ref` | `TEXT`    | Provider conversation reference   |
| `external_message_ref`      | `TEXT`    | Provider message reference        |

The primary key is `(message_id, recipient_index, part_index)`.

## Write contract

Every state change uses this order:

```text
BEGIN IMMEDIATE
verify the exact schema
verify actor authority
verify the expected resource revision
verify the lease token and generation plus its expiry when ownership is required
verify the domain transition
increment the resource revision
insert the immutable event
update the domain row
insert deterministic follow-up effects
COMMIT
```

Any failed check rolls back the complete command.

A runtime `WritePermit` carries the resource, operation, actor, expected revision, and lease evidence. It improves typing but is not authority by itself. The transaction must verify the database rows again.

### Claiming ownership

A claim transaction:

1. Reads the lease row under `BEGIN IMMEDIATE`.
2. Rejects a live owner.
3. Increments `generation`.
4. Writes owner fields and the token hash.
5. Records the lease event.
6. Returns the raw token and generation.

Renewal and release compare the resource and token hash plus the generation and current owner. Release clears owner fields and keeps the generation.

### Resolving a human decision

Human, policy-timeout, explicit cancellation, and no-default expiry candidates all use one resolution function. The primary key on `human_decision_resolutions.decision_id` selects one winner.

The winning transaction also writes all required effect intents. A verified channel actor may submit a human candidate but cannot continue or cancel the run directly. Automatic policy requires the run owner's valid lease. Model-facing workflow answers remain forbidden for protected decisions.

A deadline with a validated default response creates a `timeout_policy` acceptance candidate. `expired_no_default` cancellation is legal only when the request has no default response.

### Applying effects

An effect worker:

1. Claims the effect resource.
2. Inserts an `effect_attempts` row.
3. Rechecks the effect and source revision.
4. Performs the local or external action.
5. Records the result and receipt.
6. Marks the effect terminal and releases ownership.

Local effects must be exactly once by transaction and deterministic identity. External effects use provider idempotency or observation when available. An uncertain provider result becomes `ambiguous` and is not repeated blindly.

## Read contract

Reads never obtain or imply write authority.

All status surfaces read domain rows and immutable resolutions together with current leases and effect receipts. A terminal fact overrides stale intermediate presentation:

- an accepted decision is shown as accepted or continuation pending
- a cancelled decision is shown as cancelled even before parent cleanup finishes
- a run with a terminal event is never shown as actionable waiting work
- an ambiguous effect is shown as unresolved instead of successful

Viewer connections use `query_only`. Read code must not repair state.

## Storage replacement

The implementation removes every live reader and writer for:

- `~/.pi/agent/workflows/runs/`
- `~/.pi/agent/workflows/decisions/`
- controller SQLite sidecars
- decision-channel SQLite sidecars
- run manifests and workflow snapshots
- `state.json`
- `trace.ndjson`
- session JSON and NDJSON capture files
- artifact text files
- the old runs and controller directory environment variables

When old state exists and `state.sqlite` does not, database open fails with a clear reset instruction. The implementation does not inspect, import, rewrite, or delete that state. When both old state and the new database exist, only `state.sqlite` is live; diagnostics may report the unused old paths without reading their contents.

## API changes

The public workflow authoring API stays the same.

Required runtime changes are:

- `WorkflowRunResult` no longer exposes `runDir`
- run lookup takes a `runId`
- viewer commands take a run ID instead of a run directory
- `WorkflowRunState` remains a generated public view and is not stored as JSON
- run-bundle and artifact-reference types are removed unless still needed for an explicit export feature
- `WorkflowRunStore` becomes a SQLite-backed repository or is replaced by a clearer state repository
- `PI_WORKFLOWS_RUNS_DIR` and `PI_WORKFLOWS_CONTROLLER_DIR` are removed
- test isolation uses a temporary home directory or an injected database path in test-only constructors

The TypeScript viewer and Rust `piw` viewer must use the same read contract. The live replay protocol sends database-derived snapshots and ordered events.

## Code organization

Add a Pi-independent state layer:

```text
src/state/
  authority.ts
  blobs.ts
  database.ts
  effects.ts
  events.ts
  schema-check.ts
  schema.ts
  transaction.ts
  types.ts
```

`src/state` imports no Pi, workflow, controller, host, extension, viewer, or built-in code. Update `slophammer.yml` so workflows and controllers may import this lower layer.

Keep domain stores with their owners:

```text
src/workflows/sqlite-store.ts
src/workflows/human-decision.ts
src/controllers/sqlite.ts
src/extension/decision-channels.ts
```

Only approved repository modules may execute mutating SQL. Add a repository check that rejects raw `INSERT`, `UPDATE`, `DELETE`, schema mutation, and transaction control outside the state and domain store allowlist.

## Implementation steps

### Add the canonical specification

Add this plan and a future evergreen `docs/SQLITE_STATE.md` when the implementation lands. Keep current evergreen documents accurate until the code changes. At implementation completion, replace each affected storage section in the current documentation.

### Add the database foundation

Implement path resolution, secure creation, connection settings, exact DDL, schema digest checks, read-only connections, and write transactions. Add busy-error classification, integrity verification, and WAL-aware backup maintenance.

Verify database creation, permissions, exact shape, incompatible-shape rejection, read-only enforcement, backup restore, and WAL handling in temporary homes.

### Add shared state records

Implement canonical JSON encoding, content hashing, deduplicated blob writes, resource revisions, persistent lease generations, event insertion, effect reservation, effect attempts, and idempotent adoption.

Verify hash mismatches, conflicting duplicate blobs, stale revisions, stale leases, generation reuse, duplicate event revisions, effect conflicts, and transaction rollback.

### Move run execution

Replace file-backed run initialization and transitions with SQL transactions. Move all definition, run, attempt, output, update, and terminal state into the database.

Keep `WorkflowRunState` as a projection for existing TypeScript consumers. Add equivalence fixtures that compare the old in-memory result shape with the new database projection for the same scripted run.

### Move ownership and queues

Move interactive and headless run scheduling into `run_queue`. Replace optional file-store fences with mandatory lease checks. Use one transaction for claim checks and run writes.

Verify concurrent claims, owner handoff, claim loss, renewal, release, parking, terminal settlement, session affinity, and child-run admission.

### Move session capture

Write Pi entries and temporal events to `session_entries` and `session_events`. Keep sequence and count checks. Move segment status and capture failure into `session_segments`.

Verify verbatim entry recovery, contiguous event sequences, final message linkage, incomplete capture, several owner segments, and viewer replay.

### Move human decisions

Replace decision directories with decision tables. Route human answers and timeout policy together with cancellation candidates through one transaction. Create every required parent, continuation, notification, and presentation effect in the winning transaction.

Verify all race orders, stale request digests, duplicate submissions, model-answer rejection, late human input, owner-only policy, parent status projection, and one continuation.

### Move controllers

Move the complete controller resource lifecycle into the canonical database, including queue work, finalizers, effects, events, and child workflows. Remove the project controller database path and schema.

Verify the complete controller lifecycle, including revision conflicts, generation changes, delayed work, effects, child workflows, deletion, and finalizers.

### Move notifications and deferred turns

Replace notification and turn-intent queue tables with domain rows linked to shared effects. Keep deterministic logical indexes and exact target-session checks.

Verify duplicate prevention, owner delivery, factual fallback competition, and terminal receipts.

### Move channel transport state

Move all channel transport state into the canonical database. This includes leases, Telegram offsets, inbound events, messages, and message parts. Consolidate callbacks and replies into `channel_inbox`. Keep private configuration and credentials outside the database.

Verify lease ownership, cursor progress, duplicate external events, message splitting, stale presentation closure, bounded settlement, and ambiguous sends.

### Move all readers

Change status, recent runs, widgets, TypeScript viewer, Rust viewer, live replay, controller views, and control tools to the read-only database interface.

Verify that every surface agrees for each run and effect state, including stale ownership and ambiguous effects. Add a test that detects any write from a read path.

### Remove old storage

Delete every old storage module for run bundles, artifacts, decisions, controllers, and channels. Remove the related path APIs, environment variables, schemas, fixtures, and compatibility helpers.

Search source, tests, examples, package files, and docs for old path names and file contracts. Keep no dormant fallback.

### Add maintenance and diagnostics

Add supported read-only verification and WAL-aware backup operations. Report database size, schema identity, integrity, foreign-key status, active leases, and unsettled effects without exposing private actor or channel details.

Do not add automatic destructive cleanup in this change. A later retention feature needs separate scope and explicit deletion rules.

### Update canonical documentation

After code behavior matches this plan:

- replace [Run bundle format](../SQLITE_STATE.md) with the SQLite state specification or retire it in favor of `SQLITE_STATE.md`
- update [Human decisions](../HUMAN_DECISIONS.md)
- update [Controller runtime specification](../CONTROLLERS.md)
- update [Workflow authoring reference](../workflows.md)
- update [Rust TUI viewer](../tui-viewer.md)
- update [Development guide](../development.md)
- update [Design philosophy](../DESIGN_PHILOSOPHY.md)

Do not describe the new database as shipped before the implementation passes verification.

## Tests

### Schema tests

Test:

- exact tables, columns, indexes, foreign keys, and checks
- wrong application ID, user version, schema row, or DDL digest
- unexpected schema objects
- permissions
- integrity and foreign-key failures
- read-only connections
- backup and restore into a temporary home

### Transaction tests

Test:

- failed commands write nothing
- one resource revision and event per accepted command
- domain rows and events cannot diverge
- follow-up effects appear in the source transaction
- identical idempotent requests adopt
- conflicting requests return the durable winner
- process loss before commit leaves no partial command
- process loss after commit leaves a complete fact and pending effects

### Ownership tests

Test:

- one winner for concurrent claims
- generation increases for every new owner
- released generations are never reused
- stale token, generation, revision, or expired lease cannot write
- owner handoff during work rejects the stale write
- readers and shared scans perform zero writes

### Run tests

Test run creation, node execution, looping, included workflows, progress updates, pause, continuation, cancellation, failure, timeout, owner loss, session binding, headless execution, and terminal projection.

### Decision tests

Test human versus timeout, human versus cancellation, timeout versus cancellation, defaulted deadline, no-default deadline, stale digest, duplicate answer, late answer, repeated cancellation, owner-only policy, model-answer rejection, one continuation, parent projection, and stale presentation closure.

### Controller tests

Test the complete controller lifecycle, including resource updates, generations, queue claims, delayed work, effect receipts, uncertain outcomes, child workflows, deletion, finalizers, and owner loss.

### Channel tests

Test cursors, duplicate callbacks, duplicate replies, message splitting, delivery receipts, settlement receipts, lease handoff, missing profiles, and ambiguous provider outcomes.

### Multi-process tests

Use child processes with barriers and controllable clocks to test concurrency, busy handling, WAL behavior, and owner handoff across all mutation types. Keep a frozen prior-build harness and prove that it cannot discover or write `state.sqlite`. Prove that current code never writes old paths.

### Real Pi tests

Run the package through the real non-destructive Pi path with a temporary home. Cover interactive execution, protected decisions, continuation, cancellation, controller work, notification delivery, status, viewer replay, and headless execution.

## Verification

Run:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
git diff --check
```

Review the complete diff and every persisted-state mutation before delivery. Stop if any old storage writer remains, any read path mutates state, any race creates two winners, or any committed event can disagree with its domain row or required effects.

## Contract impact

- **Session state:** Pi continues to record normal workflow messages. Pi Workflows stores its captured run view in SQLite.
- **Other persistent data:** one canonical `state.sqlite` replaces run bundles, decision directories, artifact files, controller databases, and channel sidecars.
- **Pi internals:** none.
- **Public Pi API:** the existing documented extension and UI interfaces, including commands and lifecycle hooks.
- **Public Pi Workflows API:** workflow authoring stays stable. Runtime APIs that expose run directories change to run IDs and database-backed views.
