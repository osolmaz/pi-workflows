use piw::source::RunSource;
use piw::state::reader::{list_runs, read_run};
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
            "CREATE TABLE blobs(blob_hash BLOB PRIMARY KEY, media_type TEXT, content BLOB);
             CREATE TABLE resources(resource_id TEXT PRIMARY KEY, revision INTEGER);
             CREATE TABLE workflow_definitions(definition_digest BLOB PRIMARY KEY, workflow_name TEXT, definition_hash BLOB);
             CREATE TABLE runs(run_id TEXT PRIMARY KEY, resource_id TEXT, definition_digest BLOB, parent_run_id TEXT, title TEXT, status TEXT, paused INTEGER, status_detail TEXT, input_hash BLOB, final_output_hash BLOB, error_hash BLOB, created_at INTEGER, updated_at INTEGER, finished_at INTEGER);
             CREATE TABLE run_sources(run_id TEXT, mount_path TEXT, source_type TEXT, source_ref TEXT, source_revision TEXT);
             CREATE TABLE leases(resource_id TEXT PRIMARY KEY, owner_id TEXT, expires_at INTEGER);
             CREATE TABLE events(resource_id TEXT, resource_revision INTEGER, event_type TEXT, payload_hash BLOB, recorded_at INTEGER);
             CREATE TABLE node_attempts(attempt_id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, node_type TEXT, status TEXT, output_hash BLOB, receipt_hash BLOB, error_hash BLOB, started_at INTEGER, finished_at INTEGER);
             CREATE TABLE run_steps(run_id TEXT, step_index INTEGER, attempt_id TEXT, output_override_hash BLOB);
             CREATE TABLE attempt_entries(attempt_id TEXT, role TEXT, segment_id TEXT, entry_id TEXT);
             CREATE TABLE workflow_updates(update_id TEXT, run_revision INTEGER, attempt_id TEXT, update_type TEXT, update_key TEXT, data_hash BLOB, recorded_at INTEGER);
             CREATE TABLE human_decisions(decision_id TEXT, run_id TEXT, request_hash BLOB);
             CREATE TABLE human_decision_resolutions(decision_id TEXT, outcome TEXT, response_hash BLOB);
             CREATE TABLE continuations(decision_id TEXT, parent_run_id TEXT, continuation_run_id TEXT, created_at INTEGER);
             CREATE TABLE session_segments(segment_id TEXT, run_id TEXT, capture_key TEXT, binding_hash BLOB, status TEXT, entry_count INTEGER, event_count INTEGER, failure_hash BLOB, created_at INTEGER);
             CREATE TABLE session_entries(segment_id TEXT, entry_seq INTEGER, entry_id TEXT, entry_hash BLOB, recorded_at INTEGER);
             CREATE TABLE session_events(segment_id TEXT, event_seq INTEGER, event_type TEXT, node_id TEXT, attempt_id TEXT, turn_id TEXT, message_id TEXT, tool_call_id TEXT, payload_hash BLOB, recorded_at INTEGER);
             CREATE TABLE workflow_settings(scope_id TEXT, resource_id TEXT, active_run_id TEXT, mount_path TEXT, invocation INTEGER, current_hash BLOB);
             CREATE TABLE workflow_follow_up_queues(run_id TEXT, presentation_state TEXT);
             CREATE TABLE workflow_follow_ups(run_id TEXT, follow_up_id TEXT, order_number INTEGER, status TEXT, source_type TEXT, session_entry_id TEXT);",
        )
        .unwrap();
    let snapshot = json!({
        "schema": "pi-workflows.definition-snapshot.v1",
        "name": "demo", "startAt": "work",
        "nodes": {"work": {"nodeType": "compute"}}, "edges": []
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
fn refreshes_a_run_after_one_committed_update() {
    let (_temp, database) = fixture();
    let mut source = RunSource::new(&database);
    let before = source.get("run-1").unwrap().revision;
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
    drop(connection);

    let outcome = source.refresh_all();
    assert_eq!(outcome.patches.len(), 1);
    assert_eq!(source.get("run-1").unwrap().revision, before + 1);
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
            "INSERT INTO session_entries(segment_id, entry_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 1, 'entry-1', ?1, 1), ('s2', 1, 'entry-2', ?2, 2)",
            params![first_entry, second_entry],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO session_events(segment_id, event_seq, event_type, node_id, attempt_id, turn_id, payload_hash, recorded_at) VALUES ('s1', 1, 'turn_started', 'work', 'a1', 't1', ?1, 1), ('s2', 1, 'turn_started', 'work', 'a2', 't2', ?1, 2)",
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
    connection.execute("INSERT INTO session_segments(segment_id, run_id, status, entry_count, event_count, created_at) VALUES ('s1', 'run-1', 'complete', 2, 0, 1)", []).unwrap();
    connection.execute("INSERT INTO session_entries(segment_id, entry_seq, entry_id, entry_hash, recorded_at) VALUES ('s1', 1, 'prompt', ?1, 1), ('s1', 2, 'response', ?2, 2)", params![prompt, response]).unwrap();
    connection.execute("INSERT INTO node_attempts(attempt_id, run_id, node_id, node_type, status, receipt_hash, started_at, finished_at) VALUES ('a1', 'run-1', 'work', 'agent', 'completed', ?1, 1, 2)", [receipt]).unwrap();
    connection
        .execute("INSERT INTO run_steps VALUES ('run-1', 0, 'a1', NULL)", [])
        .unwrap();
    connection.execute("INSERT INTO attempt_entries VALUES ('a1', 'prompt', 's1', 'prompt'), ('a1', 'response', 's1', 'response'), ('a1', 'first', 's1', 'prompt'), ('a1', 'last', 's1', 'response')", []).unwrap();
    drop(connection);

    let run = read_run(&database, "run-1").unwrap();
    assert_eq!(run.state.steps[0].prompt, json!("Do the work"));
    assert_eq!(run.state.steps[0].output, json!("Done"));
    assert_eq!(run.state.outputs["work"], json!("Done"));
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
    assert!(read_run(Path::new(&database), "run-1").is_err());
}
