use piw::protocol::PageKind;
use piw::source::RunSource;
use piw::state::reader::{list_runs, read_run, ProjectionReader, SCHEMA_DIGEST};
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn blob(connection: &Connection, value: &serde_json::Value) -> Vec<u8> {
    let content = serde_json::to_vec(value).unwrap();
    let hash = Sha256::digest(&content).to_vec();
    connection
        .execute(
            "INSERT OR IGNORE INTO blobs(blob_hash, media_type, content) VALUES (?1, 'application/json', ?2)",
            params![hash, content],
        )
        .unwrap();
    hash
}

fn fixture() -> (TempDir, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("state.sqlite");
    let connection = Connection::open(&database).unwrap();
    connection
        .pragma_update(None, "application_id", 0x5049_5746_i64)
        .unwrap();
    connection
        .pragma_update(None, "user_version", 1_i64)
        .unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_meta(id INTEGER PRIMARY KEY, schema_name TEXT, schema_version INTEGER, schema_digest BLOB, app_version TEXT);
             CREATE TABLE blobs(blob_hash BLOB PRIMARY KEY, media_type TEXT, content BLOB);
             CREATE TABLE resources(resource_id TEXT PRIMARY KEY, revision INTEGER);
             CREATE TABLE workflow_definitions(definition_digest BLOB PRIMARY KEY, workflow_name TEXT, definition_hash BLOB);
             CREATE TABLE runs(run_id TEXT PRIMARY KEY, resource_id TEXT, definition_digest BLOB, parent_run_id TEXT, title TEXT, status TEXT, paused INTEGER, status_detail TEXT, input_hash BLOB, final_output_hash BLOB, error_hash BLOB, created_at INTEGER, updated_at INTEGER, finished_at INTEGER);
             CREATE TABLE viewer_runs(run_id TEXT PRIMARY KEY, presentation_revision INTEGER, retained_from_revision INTEGER, updated_at INTEGER);
             CREATE TABLE viewer_deltas(run_id TEXT, presentation_revision INTEGER, delta_index INTEGER, target_type TEXT, target_key TEXT, patch_hash BLOB, recorded_at INTEGER);
             CREATE TABLE run_sources(run_id TEXT, mount_path TEXT, source_type TEXT, source_ref TEXT, source_revision TEXT);
             CREATE TABLE leases(resource_id TEXT PRIMARY KEY, owner_id TEXT, expires_at INTEGER);
             CREATE TABLE events(resource_id TEXT, resource_revision INTEGER, event_type TEXT, payload_hash BLOB, recorded_at INTEGER);
             CREATE TABLE node_attempts(attempt_id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, node_type TEXT, status TEXT, prompt_hash BLOB, output_hash BLOB, receipt_hash BLOB, error_hash BLOB, settings_scope_id TEXT, settings_change_number INTEGER, settings_hash BLOB, started_at INTEGER, finished_at INTEGER);
             CREATE TABLE run_steps(run_id TEXT, step_index INTEGER, attempt_id TEXT, output_override_hash BLOB);
             CREATE TABLE attempt_entries(attempt_id TEXT, role TEXT, segment_id TEXT, entry_id TEXT);
             CREATE TABLE workflow_updates(update_id TEXT, run_revision INTEGER, attempt_id TEXT, update_type TEXT, update_key TEXT, data_hash BLOB, recorded_at INTEGER);
             CREATE TABLE human_decisions(decision_id TEXT, run_id TEXT, request_hash BLOB);
             CREATE TABLE human_decision_resolutions(decision_id TEXT, outcome TEXT, response_hash BLOB);
             CREATE TABLE continuations(decision_id TEXT, parent_run_id TEXT, continuation_run_id TEXT, created_at INTEGER);
             CREATE TABLE session_segments(segment_id TEXT, run_id TEXT, capture_key TEXT, binding_hash BLOB, status TEXT, entry_count INTEGER, event_count INTEGER, failure_hash BLOB, created_at INTEGER);
             CREATE TABLE session_entries(segment_id TEXT, run_id TEXT, entry_seq INTEGER, run_seq INTEGER, entry_id TEXT, entry_hash BLOB, recorded_at INTEGER);
             CREATE TABLE session_events(segment_id TEXT, run_id TEXT, event_seq INTEGER, run_seq INTEGER, event_type TEXT, node_id TEXT, attempt_id TEXT, turn_id TEXT, message_id TEXT, tool_call_id TEXT, payload_hash BLOB, recorded_at INTEGER);
             CREATE TABLE workflow_settings(scope_id TEXT, resource_id TEXT, active_run_id TEXT, mount_path TEXT, invocation INTEGER, current_hash BLOB);
             CREATE TABLE workflow_follow_up_queues(run_id TEXT, presentation_state TEXT);
             CREATE TABLE workflow_follow_ups(run_id TEXT, follow_up_id TEXT, order_number INTEGER, status TEXT, source_type TEXT, session_entry_id TEXT);",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO schema_meta VALUES (1, 'pi-workflows-state', 1, ?1, '0.13.3')",
            [SCHEMA_DIGEST.as_slice()],
        )
        .unwrap();
    let snapshot = json!({
        "schema": "pi-workflows.definition-snapshot.v1",
        "name": "demo", "startAt": "work",
        "nodes": {"work": {"nodeType": "compute"}}, "edges": [],
        "composition": {"mounts": [{"mountPath": ["child"], "workflowName": "child"}]}
    });
    let definition_hash = blob(&connection, &snapshot);
    let input_hash = blob(&connection, &json!({}));
    let event_hash = blob(&connection, &json!({"scope": "run", "payload": {}}));
    let digest = vec![1_u8; 32];
    connection
        .execute(
            "INSERT INTO workflow_definitions(definition_digest, workflow_name, definition_hash) VALUES (?1, 'demo', ?2)",
            params![digest, definition_hash],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO resources(resource_id, revision) VALUES ('resource-1', 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO runs(run_id, resource_id, definition_digest, status, paused, input_hash, created_at, updated_at) VALUES ('run-1', 'resource-1', ?1, 'running', 0, ?2, 1, 1)",
            params![vec![1_u8; 32], input_hash],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO viewer_runs(run_id, presentation_revision, retained_from_revision, updated_at) VALUES ('run-1', 1, 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO run_sources VALUES ('run-1', '', 'file', 'inline:demo', 'test')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO leases(resource_id, owner_id, expires_at) VALUES ('resource-1', NULL, NULL)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO events(resource_id, resource_revision, event_type, payload_hash, recorded_at) VALUES ('resource-1', 1, 'run_started', ?1, 1)",
            [event_hash],
        )
        .unwrap();
    drop(connection);
    (temp, database)
}

#[test]
fn reads_and_lists_runs_from_sqlite() {
    let (_temp, database) = fixture();
    let run = read_run(&database, "run-1").unwrap();
    assert_eq!(run.state.run_id, "run-1");
    assert_eq!(
        run.state.definition_digest.as_deref(),
        Some("sha256:0101010101010101010101010101010101010101010101010101010101010101")
    );
    assert_eq!(run.trace.len(), 1);
    assert!(run.possibly_interrupted);
    assert_eq!(list_runs(&database).len(), 1);
    let connection = Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE leases SET owner_id = 'host', expires_at = ?1 WHERE resource_id = 'resource-1'",
            [i64::MAX],
        )
        .unwrap();
    drop(connection);
    assert!(!read_run(&database, "run-1").unwrap().possibly_interrupted);
}

#[test]
fn idle_refresh_reads_only_data_version_and_never_loads_payloads() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database).unwrap();
    for _ in 0..100 {
        source.refresh_all();
    }
    let idle = source.stats();
    assert_eq!(idle.data_version_checks, 101);
    assert_eq!(idle.index_reads, 1);
    assert_eq!(idle.window_reads, 0);
    assert_eq!(idle.payload_rows_read, 0);

    source.watch("run-1").unwrap();
    let loaded = source.stats();
    assert_eq!(loaded.window_reads, 1);
    assert_eq!(loaded.payload_rows_read, 1);
    for _ in 0..100 {
        source.refresh_all();
    }
    let settled = source.stats();
    assert_eq!(settled.index_reads, 1);
    assert_eq!(settled.window_reads, 1);
    assert_eq!(settled.payload_rows_read, 1);
}

#[test]
fn waiting_runs_remain_live() {
    let (_temp, database) = fixture();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE runs SET status = 'waiting' WHERE run_id = 'run-1'",
            [],
        )
        .unwrap();
    drop(connection);

    let reader = ProjectionReader::open(&database).unwrap();
    let run = reader
        .list_run_index()
        .unwrap()
        .into_iter()
        .find(|row| row.manifest.run_id == "run-1")
        .unwrap();
    assert!(run.live);
}

#[test]
fn page_revision_comes_from_the_same_sqlite_snapshot_as_its_rows() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database).unwrap();
    let connection = Connection::open(&database).unwrap();
    let entry_hash = blob(&connection, &json!({"id": "entry-1", "type": "message"}));
    connection
        .execute(
            "INSERT INTO session_segments(segment_id, run_id, capture_key, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', NULL, 'recording', 1, 0, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_entries(segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 'run-1', 1, 1, 'entry-1', ?1, 1)",
            [entry_hash],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE viewer_runs SET presentation_revision = 2, updated_at = 2 WHERE run_id = 'run-1'",
            [],
        )
        .unwrap();
    drop(connection);

    let (revision, page) = source.page("run-1", PageKind::SessionEntries, 0).unwrap();
    assert_eq!(revision, 2);
    assert_eq!(page.total, 1);
    assert_eq!(page.items.len(), 1);
}

#[test]
fn applies_a_direct_tail_delta_without_reloading_the_selected_run() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database).unwrap();
    source.watch("run-1").unwrap();
    assert_eq!(source.stats().window_reads, 1);

    let connection = Connection::open(&database).unwrap();
    let entry_hash = blob(&connection, &json!({"id": "entry-1", "type": "message"}));
    connection
        .execute(
            "INSERT INTO session_segments(segment_id, run_id, capture_key, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', NULL, 'recording', 1, 0, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_entries(segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 'run-1', 1, 1, 'entry-1', ?1, 1)",
            [entry_hash],
        )
        .unwrap();
    let patch_hash = blob(
        &connection,
        &json!([
            {"op": "replace", "path": "/presentationRevision", "value": 2},
            {"op": "append", "path": "/items", "value": [{"seq": 1, "entry": {"id": "entry-1", "type": "message"}}]},
            {"op": "replace", "path": "/total", "value": 1}
        ]),
    );
    connection
        .execute(
            "UPDATE viewer_runs SET presentation_revision = 2, updated_at = 2 WHERE run_id = 'run-1'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO viewer_deltas(run_id, presentation_revision, delta_index, target_type, target_key, patch_hash, recorded_at) VALUES ('run-1', 2, 0, 'conversation', 'entries:tail', ?1, 2)",
            [patch_hash],
        )
        .unwrap();
    drop(connection);

    let outcome = source.refresh_all();
    assert_eq!(outcome.updates.len(), 1);
    assert_eq!(source.stats().window_reads, 1);
    let entry = source.get("run-1").unwrap();
    assert_eq!(entry.revision, 2);
    assert_eq!(entry.graph_revision, 1);
    assert_eq!(entry.session_entry_total, 1);
    assert_eq!(entry.session_entries.len(), 1);
}

#[test]
fn shares_one_loaded_projection_across_watchers() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database).unwrap();
    source.watch("run-1").unwrap();
    source.watch("run-1").unwrap();
    assert_eq!(source.watcher_count("run-1"), 2);
    assert_eq!(source.stats().window_reads, 1);
    assert!(source.get("run-1").is_some());

    let _ = source.page("run-1", PageKind::Trace, 0).unwrap();
    assert_eq!(source.stats().page_reads, 1);
    assert_eq!(source.stats().window_reads, 1);

    source.unwatch("run-1");
    assert_eq!(source.watcher_count("run-1"), 1);
    assert!(source.get("run-1").is_some());
    source.unwatch("run-1");
    assert_eq!(source.watcher_count("run-1"), 0);
    assert!(source.get("run-1").is_none());
}

#[test]
fn refreshes_a_run_after_one_committed_update() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database).unwrap();
    source.watch("run-1").unwrap();
    let before = source.get("run-1").unwrap().revision;
    let window_reads = source.stats().window_reads;
    let connection = Connection::open(&database).unwrap();
    let final_output_hash = blob(&connection, &json!(true));
    let event_hash = blob(
        &connection,
        &json!({"scope": "run", "payload": {"finalOutput": true}}),
    );
    connection
        .execute(
            "UPDATE runs SET status = 'completed', final_output_hash = ?1, updated_at = 2, finished_at = 2 WHERE run_id = 'run-1'",
            [final_output_hash],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE resources SET revision = 2 WHERE resource_id = 'resource-1'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO events(resource_id, resource_revision, event_type, payload_hash, recorded_at) VALUES ('resource-1', 2, 'run_completed', ?1, 2)",
            [event_hash],
        )
        .unwrap();
    let patch_hash = blob(
        &connection,
        &json!([
            {"op": "replace", "path": "/presentationRevision", "value": 2},
            {"op": "replace", "path": "/graphRevision", "value": 2},
            {"op": "replace", "path": "/state/status", "value": "completed"},
            {"op": "add", "path": "/state/finalOutput", "value": true},
            {"op": "replace", "path": "/manifest/status", "value": "completed"},
            {"op": "add", "path": "/manifest/finishedAt", "value": "1970-01-01T00:00:00.002Z"},
            {"op": "replace", "path": "/live", "value": false}
        ]),
    );
    connection
        .execute(
            "UPDATE viewer_runs SET presentation_revision = 2, updated_at = 2 WHERE run_id = 'run-1'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO viewer_deltas(run_id, presentation_revision, delta_index, target_type, target_key, patch_hash, recorded_at) VALUES ('run-1', 2, 0, 'graph', '', ?1, 2)",
            [patch_hash],
        )
        .unwrap();
    drop(connection);

    let outcome = source.refresh_all();
    assert_eq!(outcome.updates.len(), 1);
    assert_eq!(source.get("run-1").unwrap().revision, before + 1);
    assert_eq!(source.stats().window_reads, window_reads);
    assert_eq!(
        source.get("run-1").unwrap().state.status.label(),
        "completed"
    );
}

#[test]
fn combines_capture_segments_in_order() {
    let (_temp, database) = fixture();
    let connection = Connection::open(&database).unwrap();
    let first_entry = blob(&connection, &json!({"id": "entry-1", "type": "message"}));
    let second_entry = blob(&connection, &json!({"id": "entry-2", "type": "message"}));
    let payload = blob(&connection, &json!({"turnIndex": 1}));
    connection
        .execute(
            "INSERT INTO session_segments(segment_id, run_id, capture_key, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', NULL, 'complete', 1, 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_segments(segment_id, run_id, capture_key, status, entry_count, event_count, created_at) VALUES ('s2', 'run-1', 'handoff', 'complete', 1, 1, 2)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_entries(segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 'run-1', 1, 1, 'entry-1', ?1, 1), ('s2', 'run-1', 1, 2, 'entry-2', ?2, 2)",
            params![first_entry, second_entry],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_events(segment_id, run_id, event_seq, run_seq, event_type, node_id, attempt_id, turn_id, payload_hash, recorded_at) VALUES ('s1', 'run-1', 1, 1, 'turn_started', 'work', 'a1', 't1', ?1, 1), ('s2', 'run-1', 1, 2, 'turn_started', 'work', 'a2', 't2', ?1, 2)",
            [payload],
        )
        .unwrap();
    drop(connection);

    let run = read_run(&database, "run-1").unwrap();
    assert_eq!(run.session_entries.len(), 2);
    assert_eq!(run.session_entries[1].seq, 2);
    assert_eq!(run.session_events.len(), 2);
    assert_eq!(run.session_events[1].seq, 2);
}

#[test]
fn projects_attempt_content_from_pi_entries() {
    let (_temp, database) = fixture();
    let connection = Connection::open(&database).unwrap();
    let prompt = blob(
        &connection,
        &json!({"id": "prompt", "type": "custom_message", "content": "Do the work"}),
    );
    let response = blob(
        &connection,
        &json!({
            "id": "response", "type": "message",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Done"}]}
        }),
    );
    let receipt = blob(
        &connection,
        &json!({"assistantMessage": {"sha256": "abc", "entryId": "response"}}),
    );
    let settings_hash = vec![0xcd_u8; 32];
    connection.execute("INSERT INTO session_segments(segment_id, run_id, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', 'complete', 2, 0, 1)", []).unwrap();
    connection.execute("INSERT INTO session_entries(segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 'run-1', 1, 1, 'prompt', ?1, 1), ('s1', 'run-1', 2, 2, 'response', ?2, 2)", params![prompt, response]).unwrap();
    connection.execute("INSERT INTO node_attempts(attempt_id, run_id, node_id, node_type, status, receipt_hash, settings_scope_id, settings_change_number, settings_hash, started_at, finished_at) VALUES ('a1', 'run-1', 'work', 'agent', 'completed', ?1, 'scope-complete', 3, ?2, 1, 2)", params![receipt, settings_hash]).unwrap();
    connection
        .execute("INSERT INTO run_steps VALUES ('run-1', 0, 'a1', NULL)", [])
        .unwrap();
    connection.execute("INSERT INTO attempt_entries VALUES ('a1', 'prompt', 's1', 'prompt'), ('a1', 'response', 's1', 'response'), ('a1', 'first', 's1', 'prompt'), ('a1', 'last', 's1', 'response')", []).unwrap();
    drop(connection);

    let run = read_run(&database, "run-1").unwrap();
    assert_eq!(run.state.steps[0].prompt, json!("Do the work"));
    assert_eq!(run.state.steps[0].output, json!("Done"));
    assert_eq!(
        run.state.steps[0].settings_scope_id.as_deref(),
        Some("scope-complete")
    );
    assert_eq!(run.state.steps[0].settings_change_number, Some(3));
    assert_eq!(
        run.state.steps[0].settings_hash.as_deref(),
        Some("cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd")
    );
    assert_eq!(run.state.outputs["work"], json!("Done"));
}

#[test]
fn reads_bounded_step_pages_with_compact_graph_state() {
    let (_temp, database) = fixture();
    let mut connection = Connection::open(&database).unwrap();
    let transaction = connection.transaction().unwrap();
    for index in 0..300_u64 {
        let attempt_id = format!("attempt-{index}");
        transaction
            .execute(
                "INSERT INTO node_attempts(attempt_id, run_id, node_id, node_type, status, started_at, finished_at) VALUES (?1, 'run-1', 'work', 'compute', 'completed', ?2, ?2)",
                params![attempt_id, index as i64 + 1],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO run_steps(run_id, step_index, attempt_id) VALUES ('run-1', ?1, ?2)",
                params![index, attempt_id],
            )
            .unwrap();
    }
    transaction.commit().unwrap();

    let reader = ProjectionReader::open(&database).unwrap();
    let first = reader
        .read_window(
            "run-1",
            piw::state::reader::ProjectionCursors {
                step: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(first.step_start, 0);
    assert_eq!(first.step_total, 300);
    assert_eq!(first.state.steps.len(), 256);
    assert_eq!(first.graph_cursor, 0);
    assert_eq!(first.graph_steps.len(), 1);
    assert_eq!(first.graph_steps[0].attempt_id, "attempt-0");

    let (_, last) = reader.read_page("run-1", PageKind::Steps, 299).unwrap();
    assert_eq!(last.start, 44);
    assert_eq!(last.total, 300);
    assert_eq!(last.items.len(), 256);
    assert_eq!(last.graph_cursor, Some(299));
    assert_eq!(
        last.graph_steps.as_ref().unwrap()[0].attempt_id,
        "attempt-299"
    );
    assert_eq!(last.items[255]["attemptId"], json!("attempt-299"));
}

#[test]
fn reads_bounded_session_pages_by_run_sequence() {
    let (_temp, database) = fixture();
    let mut connection = Connection::open(&database).unwrap();
    connection
        .execute(
            "INSERT INTO session_segments(segment_id, run_id, capture_key, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', NULL, 'complete', 300, 0, 1)",
            [],
        )
        .unwrap();
    let transaction = connection.transaction().unwrap();
    for sequence in 1..=300_u64 {
        let hash = blob(&transaction, &json!({"sequence": sequence}));
        transaction
            .execute(
                "INSERT INTO session_entries(segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 'run-1', ?1, ?1, ?2, ?3, ?1)",
                params![sequence, format!("entry-{sequence}"), hash],
            )
            .unwrap();
    }
    transaction.commit().unwrap();

    let reader = ProjectionReader::open(&database).unwrap();
    let (_, first) = reader
        .read_page("run-1", PageKind::SessionEntries, 0)
        .unwrap();
    assert_eq!(first.start, 0);
    assert_eq!(first.total, 300);
    assert_eq!(first.items.len(), 256);
    assert_eq!(first.items[0]["seq"], json!(1));

    let (_, last) = reader
        .read_page("run-1", PageKind::SessionEntries, 299)
        .unwrap();
    assert_eq!(last.start, 44);
    assert_eq!(last.items.len(), 256);
    assert_eq!(last.items[255]["seq"], json!(300));
}

#[test]
fn pages_settings_follow_ups_and_current_updates_without_truncation() {
    let (_temp, database) = fixture();
    let mut connection = Connection::open(&database).unwrap();
    let transaction = connection.transaction().unwrap();
    transaction
        .execute(
            "INSERT INTO node_attempts(attempt_id, run_id, node_id, node_type, status, started_at, finished_at) VALUES ('updates', 'run-1', 'work', 'compute', 'completed', 1, 1)",
            [],
        )
        .unwrap();
    for index in 0..300_u64 {
        let resource_id = format!("settings-{index}");
        transaction
            .execute(
                "INSERT INTO resources(resource_id, revision) VALUES (?1, 1)",
                [&resource_id],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO workflow_settings(scope_id, resource_id, active_run_id, mount_path, invocation, current_hash) VALUES (?1, ?2, 'run-1', '', ?3, ?4)",
                params![format!("scope-{index}"), resource_id, index, vec![index as u8; 32]],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO workflow_follow_ups(run_id, follow_up_id, order_number, status, source_type, session_entry_id) VALUES ('run-1', ?1, ?2, 'queued', 'human', NULL)",
                params![format!("follow-{index}"), index],
            )
            .unwrap();
        let data_hash = blob(&transaction, &json!({"index": index}));
        transaction
            .execute(
                "INSERT INTO workflow_updates(update_id, run_revision, attempt_id, update_type, update_key, data_hash, recorded_at) VALUES (?1, ?2, 'updates', 'progress', ?3, ?4, ?2)",
                params![format!("update-{index}"), index + 1, format!("key-{index}"), data_hash],
            )
            .unwrap();
    }
    transaction.commit().unwrap();

    let mut source = RunSource::new(&database).unwrap();
    for kind in [PageKind::Settings, PageKind::FollowUps, PageKind::Updates] {
        let (_, page) = source.page("run-1", kind, 299).unwrap();
        assert_eq!(page.start, 44);
        assert_eq!(page.total, 300);
        assert_eq!(page.items.len(), 256);
    }
}

#[test]
fn projects_the_active_settings_binding() {
    let (_temp, database) = fixture();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute(
            "INSERT INTO node_attempts(attempt_id, run_id, node_id, node_type, status, settings_scope_id, settings_change_number, settings_hash, started_at) VALUES ('active', 'run-1', 'work', 'compute', 'running', 'scope-1', 2, ?1, 1)",
            [vec![0xab_u8; 32]],
        )
        .unwrap();
    drop(connection);

    let run = read_run(&database, "run-1").unwrap();
    assert_eq!(
        run.state.current_settings_scope_id.as_deref(),
        Some("scope-1")
    );
    assert_eq!(run.state.current_settings_change_number, Some(2));
    assert_eq!(
        run.state.current_settings_hash.as_deref(),
        Some("abababababababababababababababababababababababababababababababab")
    );
}

#[test]
fn remote_mode_does_not_require_local_state() {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_piw"))
        .args(["--connect", "ws://127.0.0.1:9/ws"])
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("database"));
}

#[test]
fn rejects_an_incompatible_database() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("wrong.sqlite");
    Connection::open(&database).unwrap();
    let error = read_run(Path::new(&database), "run-1").unwrap_err();
    assert!(error.to_string().contains("Move or remove"));
}

#[test]
fn rejects_an_old_schema_with_the_same_version_numbers() {
    let (_temp, database) = fixture();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute("UPDATE schema_meta SET schema_digest = zeroblob(32)", [])
        .unwrap();
    drop(connection);

    let error = RunSource::new(&database).err().unwrap();
    assert!(error.to_string().contains("Move or remove"));
}
