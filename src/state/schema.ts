import { createHash } from "node:crypto";

export const STATE_APPLICATION_ID = 0x50495746;
export const STATE_SCHEMA_NAME = "pi-workflows-state";
export const STATE_SCHEMA_VERSION = 1;
export const STATE_APP_VERSION = "0.14.0";

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

CREATE TABLE workflow_host_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  host_id TEXT,
  token_hash BLOB CHECK (token_hash IS NULL OR length(token_hash) = 32),
  pid INTEGER CHECK (pid IS NULL OR pid > 0),
  process_start_identity TEXT,
  started_at INTEGER,
  heartbeat_at INTEGER,
  expires_at INTEGER,
  CHECK (
    (host_id IS NULL AND token_hash IS NULL AND pid IS NULL AND process_start_identity IS NULL
      AND started_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL)
    OR
    (host_id IS NOT NULL AND token_hash IS NOT NULL AND pid IS NOT NULL
      AND process_start_identity IS NOT NULL AND started_at IS NOT NULL
      AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL)
  )
) STRICT;

INSERT INTO workflow_host_state(id, epoch) VALUES (1, 0);

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
    'run', 'session', 'decision', 'controller', 'effect', 'channel', 'settings', 'follow_up'
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
  root_run_id TEXT NOT NULL REFERENCES runs(run_id),
  lineage_kind TEXT CHECK (lineage_kind IS NULL OR lineage_kind IN ('continuation', 'restart')),
  restart_number INTEGER NOT NULL DEFAULT 0 CHECK (restart_number >= 0),
  parent_terminal_fingerprint BLOB CHECK (
    parent_terminal_fingerprint IS NULL OR length(parent_terminal_fingerprint) = 32
  ),
  definition_digest BLOB NOT NULL REFERENCES workflow_definitions(definition_digest),
  workflow_ref TEXT NOT NULL,
  launch_options_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  title TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'waiting', 'completed', 'failed', 'timed_out', 'cancelled'
  )),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  status_detail TEXT,
  input_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  final_output_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  presentation_prompt_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((status IN ('waiting', 'completed', 'failed', 'timed_out', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((parent_run_id IS NULL) = (lineage_kind IS NULL)),
  CHECK (
    (lineage_kind = 'restart' AND parent_terminal_fingerprint IS NOT NULL) OR
    (lineage_kind IS NOT 'restart' AND parent_terminal_fingerprint IS NULL)
  ),
  CHECK (parent_run_id IS NOT NULL OR restart_number = 0)
) STRICT;

CREATE INDEX runs_project_idx ON runs(project_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs(status, updated_at DESC);
CREATE INDEX runs_parent_idx ON runs(parent_run_id);
CREATE UNIQUE INDEX runs_restart_parent_idx ON runs(parent_run_id)
  WHERE lineage_kind = 'restart';

CREATE TABLE run_view_content (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  content_hash BLOB NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('application/json', 'text/plain')),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, content_hash, media_type),
  CHECK (byte_length = length(content))
) STRICT;

CREATE TABLE viewer_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  presentation_revision INTEGER NOT NULL CHECK (presentation_revision >= 1),
  retained_from_revision INTEGER NOT NULL CHECK (
    retained_from_revision >= 1 AND retained_from_revision <= presentation_revision
  ),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE viewer_deltas (
  run_id TEXT NOT NULL REFERENCES viewer_runs(run_id) ON DELETE CASCADE,
  presentation_revision INTEGER NOT NULL CHECK (presentation_revision >= 1),
  delta_index INTEGER NOT NULL CHECK (delta_index >= 0),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'summary', 'graph', 'replay', 'timeline', 'conversation', 'inspector'
  )),
  target_key TEXT NOT NULL,
  patch_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, presentation_revision, delta_index)
) STRICT;

CREATE INDEX viewer_deltas_resume_idx
  ON viewer_deltas(run_id, presentation_revision, delta_index);

CREATE TABLE viewer_session_checkpoints (
  run_id TEXT NOT NULL REFERENCES viewer_runs(run_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  state_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_seq)
) STRICT;

CREATE TABLE run_sources (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  mount_path TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('builtin', 'file')),
  source_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  PRIMARY KEY (run_id, mount_path)
) STRICT;

CREATE TABLE run_bindings (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  origin_session_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('interactive', 'headless')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX run_bindings_session_idx ON run_bindings(origin_session_id, created_at DESC);

CREATE TABLE workflow_settings (
  scope_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id) ON DELETE CASCADE,
  origin_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  active_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  mount_path TEXT NOT NULL,
  invocation INTEGER NOT NULL CHECK (invocation > 0),
  initial_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  current_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (origin_run_id, mount_path, invocation)
) STRICT;

CREATE INDEX workflow_settings_active_run_idx ON workflow_settings(active_run_id, mount_path, invocation);

CREATE TABLE workflow_setting_changes (
  change_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES workflow_settings(scope_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  change_number INTEGER NOT NULL CHECK (change_number > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'session', 'host', 'controller', 'channel', 'human', 'policy', 'control', 'system'
  )),
  actor_id TEXT,
  source_type TEXT NOT NULL,
  patch_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  before_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  after_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  accepted_at INTEGER NOT NULL,
  UNIQUE (scope_id, request_id),
  UNIQUE (scope_id, change_number)
) STRICT;

CREATE TABLE workflow_follow_ups (
  follow_up_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(resource_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  order_number INTEGER NOT NULL CHECK (order_number > 0),
  target_session_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'session', 'host', 'controller', 'channel', 'human', 'policy', 'control', 'system'
  )),
  actor_id TEXT,
  source_type TEXT NOT NULL,
  prompt_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  status TEXT NOT NULL CHECK (status IN ('queued', 'removed', 'cancelled')),
  reason_hash BLOB REFERENCES blobs(blob_hash),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, request_id),
  UNIQUE (run_id, order_number),
  CHECK ((status IN ('removed', 'cancelled')) = (reason_hash IS NOT NULL))
) STRICT;

CREATE INDEX workflow_follow_ups_order_idx
  ON workflow_follow_ups(target_session_id, run_id, order_number);

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

CREATE TABLE host_commands (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'run.start', 'run.pause', 'run.resume', 'run.cancel', 'run.status', 'run.list',
    'checkpoint.answer', 'decision.answer', 'interaction.submit', 'interaction.update',
    'workflowMessage.reportBranch', 'workflowTurn.report', 'sessionView.clearTerminal',
    'run.restart', 'run.changeSettings', 'followUp.queue', 'followUp.remove', 'session.record',
    'channel.reload', 'channel.recover',
    'controller.list', 'controller.get', 'controller.apply', 'controller.reconcile', 'controller.delete',
    'host.status', 'host.stop', 'state.backup', 'state.prune'
  )),
  idempotency_key TEXT NOT NULL,
  request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
  run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  accepted_revision INTEGER CHECK (accepted_revision IS NULL OR accepted_revision >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'accepted', 'adopted', 'rejected', 'conflict', 'notFound', 'claimLost', 'unavailable'
  )),
  receipt_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  host_epoch INTEGER NOT NULL CHECK (host_epoch > 0),
  created_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  UNIQUE (client_id, idempotency_key)
) STRICT;

CREATE INDEX host_commands_run_idx ON host_commands(run_id, created_at);

CREATE TABLE run_workers (
  worker_epoch TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  host_epoch INTEGER NOT NULL CHECK (host_epoch > 0),
  launch_envelope_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  pid INTEGER,
  process_start_identity TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'starting', 'ready', 'running', 'exited', 'cancelled', 'timedOut',
    'crashed', 'claimLost', 'orphaned'
  )),
  started_at INTEGER NOT NULL,
  ready_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  signal TEXT,
  diagnostic_hash BLOB REFERENCES blobs(blob_hash),
  CHECK ((pid IS NULL) = (process_start_identity IS NULL))
) STRICT;

CREATE UNIQUE INDEX run_workers_active_idx ON run_workers(run_id)
WHERE status IN ('starting', 'ready', 'running');
CREATE INDEX run_workers_generation_idx ON run_workers(run_id, generation, started_at);

CREATE TABLE worker_messages (
  worker_epoch TEXT NOT NULL REFERENCES run_workers(worker_epoch) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'adopted', 'rejected', 'claimLost')),
  accepted_revision INTEGER CHECK (accepted_revision IS NULL OR accepted_revision >= 0),
  result_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (worker_epoch, message_id)
) STRICT;

CREATE TABLE node_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'waiting', 'interrupted',
    'completed', 'failed', 'timed_out', 'cancelled'
  )),
  prompt_hash BLOB REFERENCES blobs(blob_hash),
  output_hash BLOB REFERENCES blobs(blob_hash),
  receipt_hash BLOB REFERENCES blobs(blob_hash),
  error_hash BLOB REFERENCES blobs(blob_hash),
  settings_scope_id TEXT REFERENCES workflow_settings(scope_id),
  settings_change_number INTEGER CHECK (settings_change_number IS NULL OR settings_change_number >= 0),
  settings_hash BLOB REFERENCES blobs(blob_hash),
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
CREATE INDEX node_attempts_deadline_idx ON node_attempts(deadline_at) WHERE deadline_at IS NOT NULL;

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
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  entry_seq INTEGER NOT NULL CHECK (entry_seq > 0),
  run_seq INTEGER NOT NULL CHECK (run_seq > 0),
  entry_id TEXT NOT NULL,
  entry_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, entry_seq),
  UNIQUE (segment_id, entry_id),
  UNIQUE (run_id, run_seq)
) STRICT;

CREATE INDEX session_entries_run_idx ON session_entries(run_id, run_seq);

CREATE TABLE attempt_entries (
  attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('prompt', 'response', 'first', 'last')),
  segment_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (attempt_id, role),
  FOREIGN KEY (segment_id, entry_id)
    REFERENCES session_entries(segment_id, entry_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX attempt_entries_entry_idx ON attempt_entries(segment_id, entry_id);

CREATE TABLE session_events (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  run_seq INTEGER NOT NULL CHECK (run_seq > 0),
  event_type TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  tool_call_id TEXT,
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, event_seq),
  UNIQUE (run_id, run_seq)
) STRICT;

CREATE INDEX session_events_run_idx ON session_events(run_id, run_seq);

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

CREATE TABLE interactive_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'assistant', 'decision')),
  contract_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'cancelled')),
  unproductive_turn_ends INTEGER NOT NULL DEFAULT 0 CHECK (unproductive_turn_ends >= 0),
  accepted_submission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER,
  consumed_at INTEGER,
  CHECK ((status = 'settled') = (accepted_submission_id IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (consumed_at IS NULL OR status = 'settled')
) STRICT;

CREATE INDEX interactive_requests_session_idx
  ON interactive_requests(target_session_id, status, created_at);

CREATE TABLE workflow_messages (
  workflow_message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('step', 'decision', 'notification', 'terminal', 'followUp')),
  source_id TEXT NOT NULL,
  content_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  order_number INTEGER NOT NULL CHECK (order_number > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'cancelled')),
  pi_session_entry_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (target_session_id, order_number),
  CHECK ((status = 'sent') = (pi_session_entry_id IS NOT NULL))
) STRICT;

CREATE INDEX workflow_messages_session_idx
  ON workflow_messages(target_session_id, status, order_number);
CREATE INDEX workflow_messages_run_idx ON workflow_messages(run_id, order_number);
CREATE INDEX workflow_messages_source_idx ON workflow_messages(kind, source_id, order_number);
CREATE UNIQUE INDEX workflow_messages_pending_step_source_idx
  ON workflow_messages(source_id) WHERE kind = 'step' AND status = 'pending';

CREATE TABLE workflow_turns (
  workflow_turn_id TEXT PRIMARY KEY,
  workflow_message_id TEXT NOT NULL REFERENCES workflow_messages(workflow_message_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'ended')),
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('completed', 'aborted', 'error', 'lost')),
  response_session_entry_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK (
    (state = 'started' AND stop_reason IS NULL AND ended_at IS NULL)
    OR
    (state = 'ended' AND stop_reason IS NOT NULL AND ended_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX workflow_turns_open_message_idx
  ON workflow_turns(workflow_message_id) WHERE state = 'started';
CREATE INDEX workflow_turns_session_idx ON workflow_turns(target_session_id, state, started_at);

CREATE TABLE session_terminal_views (
  target_session_id TEXT PRIMARY KEY,
  cleared_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  cleared_at INTEGER NOT NULL
) STRICT;

CREATE TABLE interactive_submissions (
  submission_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES interactive_requests(request_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision > 0),
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  outcome TEXT NOT NULL CHECK (outcome IN ('validating', 'accepted', 'rejected', 'adopted')),
  receipt_hash BLOB REFERENCES blobs(blob_hash),
  submitted_at INTEGER NOT NULL,
  UNIQUE (request_id, idempotency_key)
) STRICT;

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

CREATE TABLE channel_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES human_decisions(decision_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('delivery', 'settlement')),
  content_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'ambiguous')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX channel_messages_decision_idx ON channel_messages(decision_id, purpose, created_at);
`;

export const STATE_SCHEMA_DIGEST = createHash("sha256").update(STATE_SCHEMA_SQL).digest();
