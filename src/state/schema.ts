import { createHash } from "node:crypto";

export const STATE_APPLICATION_ID = 0x50495746;
export const STATE_SCHEMA_NAME = "pi-workflows-state";
export const STATE_SCHEMA_VERSION = 1;
export const STATE_APP_VERSION = "0.12.1";

export const STATE_SCHEMA_SQL = String.raw`
CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_name TEXT NOT NULL CHECK (schema_name = 'pi-workflows-state'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  schema_digest BLOB NOT NULL CHECK (length(schema_digest) = 32),
  app_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE blobs (
  blob_hash BLOB PRIMARY KEY CHECK (length(blob_hash) = 32),
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (byte_length = length(content))
) STRICT;

CREATE TABLE resources (
  resource_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'run', 'session', 'decision', 'controller', 'effect', 'channel', 'notification', 'turn_intent'
  )),
  aggregate_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (resource_type, aggregate_key)
) STRICT;

CREATE TABLE leases (
  resource_id TEXT PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  owner_type TEXT CHECK (owner_type IN ('session', 'host', 'controller', 'channel', 'system')),
  owner_id TEXT,
  token_hash BLOB CHECK (token_hash IS NULL OR length(token_hash) = 32),
  acquired_at INTEGER,
  heartbeat_at INTEGER,
  expires_at INTEGER,
  CHECK (
    (owner_type IS NULL AND owner_id IS NULL AND token_hash IS NULL AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL)
    OR
    (owner_type IS NOT NULL AND owner_id IS NOT NULL AND token_hash IS NOT NULL AND acquired_at IS NOT NULL AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX leases_expires_idx ON leases(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX leases_owner_idx ON leases(owner_type, owner_id) WHERE owner_type IS NOT NULL;

CREATE TABLE events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL REFERENCES resources(resource_id),
  resource_revision INTEGER NOT NULL CHECK (resource_revision > 0),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'session', 'host', 'controller', 'channel', 'human', 'policy', 'control', 'system'
  )),
  actor_id TEXT,
  lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation > 0),
  payload_hash BLOB REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  UNIQUE (resource_id, resource_revision)
) STRICT;

CREATE INDEX events_resource_idx ON events(resource_id, event_seq);

CREATE TABLE workflow_definitions (
  definition_digest BLOB PRIMARY KEY CHECK (length(definition_digest) = 32),
  workflow_name TEXT NOT NULL,
  definition_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(project_id),
  parent_run_id TEXT REFERENCES runs(run_id),
  definition_digest BLOB NOT NULL REFERENCES workflow_definitions(definition_digest),
  workflow_ref TEXT NOT NULL,
  workflow_source_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  launch_options_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  source_type TEXT NOT NULL CHECK (source_type IN ('builtin', 'file')),
  source_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'cancelled'
  )),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  status_detail TEXT,
  input_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  workflow_sources_hash BLOB REFERENCES blobs(blob_hash),
  human_decision_hash BLOB REFERENCES blobs(blob_hash),
  final_output_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  carried_step_count INTEGER NOT NULL DEFAULT 0 CHECK (carried_step_count >= 0),
  current_node TEXT,
  current_attempt_id TEXT,
  current_node_started_at INTEGER,
  waiting_on TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((status IN ('waiting', 'completed', 'failed', 'timed_out', 'cancelled')) = (finished_at IS NOT NULL))
) STRICT;

CREATE INDEX runs_project_idx ON runs(project_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs(status, updated_at DESC);
CREATE INDEX runs_parent_idx ON runs(parent_run_id);

CREATE TABLE run_bindings (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  origin_session_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('interactive', 'headless')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX run_bindings_session_idx ON run_bindings(origin_session_id, created_at DESC);

CREATE TABLE run_queue (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'starting', 'running', 'parked', 'done', 'failed', 'cancelled'
  )),
  available_at INTEGER NOT NULL,
  affinity_runner_id TEXT,
  origin_session_id TEXT NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  error_code TEXT,
  error_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
) STRICT;

CREATE INDEX run_queue_claim_idx ON run_queue(status, available_at, created_at);
CREATE UNIQUE INDEX run_queue_active_session_idx ON run_queue(origin_session_id)
WHERE status IN ('queued', 'starting', 'running');

CREATE TABLE node_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'cancelled'
  )),
  input_hash BLOB REFERENCES blobs(blob_hash),
  contract_hash BLOB REFERENCES blobs(blob_hash),
  prompt_hash BLOB REFERENCES blobs(blob_hash),
  output_hash BLOB REFERENCES blobs(blob_hash),
  step_metadata_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  started_at INTEGER,
  deadline_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, node_id, attempt_number)
) STRICT;

CREATE UNIQUE INDEX node_attempts_active_idx ON node_attempts(run_id)
WHERE status IN ('pending', 'running', 'waiting');
CREATE INDEX node_attempts_run_idx ON node_attempts(run_id, created_at);

CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id),
  output_override_hash BLOB REFERENCES blobs(blob_hash),
  PRIMARY KEY (run_id, step_index),
  UNIQUE (run_id, attempt_id)
) STRICT;

CREATE INDEX run_steps_attempt_idx ON run_steps(attempt_id);

CREATE TABLE workflow_updates (
  update_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
  update_seq INTEGER NOT NULL CHECK (update_seq > 0),
  run_revision INTEGER NOT NULL CHECK (run_revision > 0),
  update_type TEXT NOT NULL,
  update_key TEXT NOT NULL,
  data_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  UNIQUE (attempt_id, update_seq)
) STRICT;

CREATE INDEX workflow_updates_key_idx ON workflow_updates(attempt_id, update_type, update_key, update_seq DESC);

CREATE TABLE session_segments (
  segment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES node_attempts(attempt_id),
  capture_key TEXT,
  session_id TEXT NOT NULL,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id),
  binding_hash BLOB REFERENCES blobs(blob_hash),
  status TEXT NOT NULL CHECK (status IN ('recording', 'complete', 'failed')),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  failure_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE INDEX session_segments_run_idx ON session_segments(run_id, created_at);

CREATE TABLE session_entries (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  entry_seq INTEGER NOT NULL CHECK (entry_seq > 0),
  entry_id TEXT NOT NULL,
  entry_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, entry_seq),
  UNIQUE (segment_id, entry_id)
) STRICT;

CREATE TABLE session_events (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  event_type TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  tool_call_id TEXT,
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, event_seq)
) STRICT;

CREATE TABLE human_decisions (
  decision_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id),
  audience TEXT NOT NULL,
  title TEXT NOT NULL,
  subject_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  presentation_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  choices_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  request_digest BLOB NOT NULL UNIQUE CHECK (length(request_digest) = 32),
  presentation_revision INTEGER NOT NULL CHECK (presentation_revision > 0),
  deadline_at INTEGER,
  default_response_hash BLOB REFERENCES blobs(blob_hash),
  request_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX human_decisions_run_idx ON human_decisions(run_id, created_at);
CREATE INDEX human_decisions_deadline_idx ON human_decisions(deadline_at) WHERE deadline_at IS NOT NULL;

CREATE TABLE human_decision_resolutions (
  decision_id TEXT PRIMARY KEY REFERENCES human_decisions(decision_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'cancelled')),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'human', 'timeout_policy', 'explicit_cancel', 'expired_no_default'
  )),
  response_hash BLOB REFERENCES blobs(blob_hash),
  reason TEXT,
  channel TEXT,
  actor_id TEXT,
  request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
  resolved_at INTEGER NOT NULL,
  CHECK (
    (outcome = 'accepted' AND response_hash IS NOT NULL AND reason IS NULL)
    OR
    (outcome = 'cancelled' AND response_hash IS NULL AND reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE human_decision_submissions (
  decision_id TEXT NOT NULL REFERENCES human_decisions(decision_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'policy', 'control', 'channel')),
  actor_id TEXT,
  channel TEXT,
  candidate_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'adopted', 'already_resolved', 'rejected')),
  result_hash BLOB REFERENCES blobs(blob_hash),
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, attempt_id)
) STRICT;

CREATE TABLE continuations (
  decision_id TEXT PRIMARY KEY REFERENCES human_decisions(decision_id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  continuation_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  response_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE controller_resources (
  controller_resource_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(project_id),
  controller_name TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  uid TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  spec_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  status_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  deletion_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, controller_name, resource_key)
) STRICT;

CREATE INDEX controller_resources_name_idx ON controller_resources(controller_name, resource_key);

CREATE TABLE controller_finalizers (
  controller_resource_id TEXT NOT NULL REFERENCES controller_resources(controller_resource_id) ON DELETE CASCADE,
  finalizer TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (controller_resource_id, finalizer),
  UNIQUE (controller_resource_id, position)
) STRICT;

CREATE TABLE controller_queue (
  controller_resource_id TEXT PRIMARY KEY REFERENCES controller_resources(controller_resource_id) ON DELETE CASCADE,
  available_at INTEGER NOT NULL,
  queue_version INTEGER NOT NULL DEFAULT 1 CHECK (queue_version > 0),
  consecutive_errors INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  last_error_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX controller_queue_claim_idx ON controller_queue(available_at, created_at);

CREATE TABLE controller_workflows (
  request_id TEXT PRIMARY KEY,
  controller_resource_id TEXT NOT NULL REFERENCES controller_resources(controller_resource_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  input_fingerprint BLOB NOT NULL CHECK (length(input_fingerprint) = 32),
  reserved_run_id TEXT,
  run_id TEXT REFERENCES runs(run_id),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'waiting', 'succeeded', 'failed', 'interrupted'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (controller_resource_id, request_key)
) STRICT;

CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id),
  source_resource_id TEXT NOT NULL REFERENCES resources(resource_id),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  effect_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('run', 'controller', 'channel', 'system')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'applying', 'applied', 'rejected', 'ambiguous', 'cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  result_hash BLOB REFERENCES blobs(blob_hash),
  external_ref TEXT,
  error_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (source_resource_id, effect_type, idempotency_key)
) STRICT;

CREATE INDEX effects_pending_idx ON effects(status, next_attempt_at, created_at);

CREATE TABLE effect_attempts (
  effect_id TEXT NOT NULL REFERENCES effects(effect_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  owner_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT CHECK (outcome IN ('applied', 'rejected', 'ambiguous', 'interrupted')),
  result_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  PRIMARY KEY (effect_id, attempt_number)
) STRICT;

CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL UNIQUE REFERENCES effects(effect_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id),
  notification_index INTEGER NOT NULL CHECK (notification_index >= 0),
  target_session_id TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('progress', 'final')),
  content_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, attempt_id, notification_index)
) STRICT;

CREATE TABLE turn_intents (
  turn_intent_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id),
  effect_id TEXT NOT NULL UNIQUE REFERENCES effects(effect_id),
  source_event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  workflow_ref TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  resolution_type TEXT,
  resolution_message_id TEXT,
  facts_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  requested_at INTEGER NOT NULL,
  eligible_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id),
  adapter_type TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (adapter_type, profile_key)
) STRICT;

CREATE TABLE channel_cursors (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  cursor_key TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, cursor_key)
) STRICT;

CREATE TABLE channel_inbox (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('callback', 'reply')),
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  result_hash BLOB REFERENCES blobs(blob_hash),
  PRIMARY KEY (channel_id, external_event_id)
) STRICT;

CREATE TABLE channel_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES human_decisions(decision_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('delivery', 'settlement')),
  content_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  external_conversation_ref TEXT,
  external_message_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'ambiguous')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX channel_messages_decision_idx ON channel_messages(decision_id, purpose, created_at);

CREATE TABLE channel_message_parts (
  message_id TEXT NOT NULL REFERENCES channel_messages(message_id) ON DELETE CASCADE,
  recipient_index INTEGER NOT NULL CHECK (recipient_index >= 0),
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  content_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  external_conversation_ref TEXT NOT NULL,
  external_message_ref TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient_index, part_index)
) STRICT;
`;

export const STATE_SCHEMA_DIGEST = createHash("sha256").update(STATE_SCHEMA_SQL).digest();
