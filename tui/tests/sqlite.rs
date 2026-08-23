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
             CREATE TABLE workflow_definitions(definition_digest BLOB PRIMARY KEY, definition_hash BLOB);
             CREATE TABLE runs(run_id TEXT PRIMARY KEY, resource_id TEXT, definition_digest BLOB, output_hash BLOB, created_at INTEGER);
             CREATE TABLE leases(resource_id TEXT PRIMARY KEY, owner_id TEXT, expires_at INTEGER);
             CREATE TABLE events(resource_id TEXT, resource_revision INTEGER, event_type TEXT, payload_hash BLOB, recorded_at INTEGER);
             CREATE TABLE session_segments(segment_id TEXT, run_id TEXT, capture_key TEXT, binding_hash BLOB, status TEXT, entry_count INTEGER, event_count INTEGER, failure_hash BLOB, created_at INTEGER);
             CREATE TABLE session_entries(segment_id TEXT, entry_seq INTEGER, entry_hash BLOB, recorded_at INTEGER);
             CREATE TABLE session_events(segment_id TEXT, event_seq INTEGER, event_type TEXT, node_id TEXT, attempt_id TEXT, turn_id TEXT, message_id TEXT, tool_call_id TEXT, payload_hash BLOB, recorded_at INTEGER);",
        )
        .unwrap();
    let state = json!({
        "schema": "pi-workflows.run-state.v1",
        "traceSeq": 1,
        "runId": "run-1",
        "workflowName": "demo",
        "startedAt": "2026-08-23T00:00:00.000Z",
        "updatedAt": "2026-08-23T00:00:00.000Z",
        "status": "running",
        "input": {}, "outputs": {}, "results": {}, "steps": []
    });
    let snapshot = json!({
        "schema": "pi-workflows.definition-snapshot.v1",
        "name": "demo", "startAt": "work",
        "nodes": {"work": {"nodeType": "compute"}}, "edges": []
    });
    let state_hash = blob(&connection, &state);
    let definition_hash = blob(&connection, &snapshot);
    let event_hash = blob(&connection, &json!({"scope": "run", "payload": {}}));
    let digest = vec![1_u8; 32];
    connection
        .execute(
            "INSERT INTO workflow_definitions(definition_digest, definition_hash) VALUES (?1, ?2)",
            params![digest, definition_hash],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO runs(run_id, resource_id, definition_digest, output_hash, created_at) VALUES ('run-1', 'resource-1', ?1, ?2, 1)",
            params![vec![1_u8; 32], state_hash],
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
    let completed = json!({
        "schema": "pi-workflows.run-state.v1",
        "traceSeq": 2,
        "runId": "run-1",
        "workflowName": "demo",
        "startedAt": "2026-08-23T00:00:00.000Z",
        "updatedAt": "2026-08-23T00:00:01.000Z",
        "finishedAt": "2026-08-23T00:00:01.000Z",
        "status": "completed",
        "input": {}, "outputs": {}, "results": {}, "steps": [], "finalOutput": true
    });
    let state_hash = blob(&connection, &completed);
    let event_hash = blob(
        &connection,
        &json!({"scope": "run", "payload": {"finalOutput": true}}),
    );
    connection
        .execute(
            "UPDATE runs SET output_hash = ?1 WHERE run_id = 'run-1'",
            [state_hash],
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
            "INSERT INTO session_entries(segment_id, entry_seq, entry_hash, recorded_at) VALUES ('s1', 1, ?1, 1), ('s2', 1, ?2, 2)",
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
