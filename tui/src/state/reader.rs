//! Read-only access to the canonical Pi Workflows SQLite database.

use crate::state::types::{
    DefinitionSnapshot, Manifest, ManifestPaths, RunState, SessionBinding, SessionCapture,
    SessionEntryRecord, SessionEventRecord, TraceEvent, DEFINITION_SNAPSHOT_SCHEMA,
    RUN_STATE_SCHEMA,
};
use anyhow::{bail, Context, Result};
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

const APPLICATION_ID: i64 = 0x5049_5746;
const USER_VERSION: i64 = 1;

type LoadedSession = (
    Option<SessionBinding>,
    Vec<SessionEntryRecord>,
    Vec<SessionEventRecord>,
    Option<SessionCapture>,
);

#[derive(Debug, Clone)]
pub struct LoadedRun {
    pub manifest: Manifest,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub trace: Vec<TraceEvent>,
    pub session_binding: Option<SessionBinding>,
    pub session_entries: Vec<SessionEntryRecord>,
    pub session_events: Vec<SessionEventRecord>,
    pub session_capture: Option<SessionCapture>,
    pub possibly_interrupted: bool,
}

pub fn read_run(database_path: &Path, run_id: &str) -> Result<LoadedRun> {
    let connection = open(database_path)?;
    let row = connection
        .query_row(
            "SELECT r.output_hash, d.definition_hash, l.owner_id, l.expires_at
             FROM runs r
             JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
             JOIN leases l ON l.resource_id = r.resource_id
             WHERE r.run_id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((state_hash, definition_hash, owner_id, lease_expires_at)) = row else {
        bail!("workflow run not found: {run_id}");
    };
    let state_value = read_json_blob(&connection, &state_hash)?;
    let state: RunState = serde_json::from_value(state_value.clone())?;
    if state.schema != RUN_STATE_SCHEMA {
        bail!("unsupported workflow state schema: {}", state.schema);
    }
    let definition_value = read_json_blob(&connection, &definition_hash)?;
    let snapshot: DefinitionSnapshot = serde_json::from_value(definition_value)?;
    if snapshot.schema != DEFINITION_SNAPSHOT_SCHEMA {
        bail!(
            "unsupported workflow definition schema: {}",
            snapshot.schema
        );
    }
    let trace = read_trace(&connection, run_id)?;
    let (session_binding, session_entries, session_events, session_capture) =
        read_session(&connection, run_id)?;
    let manifest = manifest_from_state(&state);
    let possibly_interrupted = state.status.label() == "running"
        && (owner_id.is_none()
            || lease_expires_at
                .is_none_or(|expires_at| expires_at <= Utc::now().timestamp_millis()));
    Ok(LoadedRun {
        manifest,
        state,
        snapshot: Some(snapshot),
        trace,
        session_binding,
        session_entries,
        session_events,
        session_capture,
        possibly_interrupted,
    })
}

pub fn list_runs(database_path: &Path) -> Vec<(String, Manifest)> {
    let Ok(connection) = open(database_path) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("SELECT run_id FROM runs ORDER BY created_at DESC")
    else {
        return Vec::new();
    };
    let Ok(ids) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    ids.filter_map(|id| {
        let id = id.ok()?;
        let run = read_run(database_path, &id).ok()?;
        Some((id, run.manifest))
    })
    .collect()
}

pub fn with_artifact_placeholders(value: &Value) -> Value {
    value.clone()
}

pub fn resolve_artifacts(value: &Value, _database_path: &Path, _max_bytes: u64) -> Value {
    value.clone()
}

fn open(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("could not open {}", path.display()))?;
    connection.pragma_update(None, "query_only", true)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let user_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if application_id != APPLICATION_ID || user_version != USER_VERSION {
        bail!("incompatible Pi Workflows SQLite schema");
    }
    Ok(connection)
}

fn read_json_blob(connection: &Connection, hash: &[u8]) -> Result<Value> {
    let content: Vec<u8> = connection.query_row(
        "SELECT content FROM blobs WHERE blob_hash = ?1 AND media_type = 'application/json'",
        [hash],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_slice(&content)?)
}

fn read_trace(connection: &Connection, run_id: &str) -> Result<Vec<TraceEvent>> {
    let resource_id: String = connection.query_row(
        "SELECT resource_id FROM runs WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare(
        "SELECT resource_revision, event_type, payload_hash, recorded_at
         FROM events WHERE resource_id = ?1 ORDER BY resource_revision",
    )?;
    let rows = statement.query_map([resource_id], |row| {
        Ok((
            row.get::<_, u64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<Vec<u8>>>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (seq, event_type, payload_hash, recorded_at) = row?;
        let envelope = match payload_hash {
            Some(hash) => read_json_blob(connection, &hash)?,
            None => json!({}),
        };
        let payload = envelope
            .get("payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut event = json!({
            "seq": seq,
            "at": timestamp(recorded_at),
            "runId": run_id,
            "scope": envelope.get("scope").and_then(Value::as_str).unwrap_or("run"),
            "type": event_type,
            "payload": payload,
        });
        if let Some(node_id) = envelope.get("nodeId") {
            event["nodeId"] = node_id.clone();
        }
        if let Some(attempt_id) = envelope.get("attemptId") {
            event["attemptId"] = attempt_id.clone();
        }
        events.push(serde_json::from_value(event)?);
    }
    Ok(events)
}

fn read_session(connection: &Connection, run_id: &str) -> Result<LoadedSession> {
    let mut segments_statement = connection.prepare(
        "SELECT segment_id, binding_hash, status, entry_count, event_count,
                failure_hash
         FROM session_segments
         WHERE run_id = ?1
         ORDER BY created_at, segment_id",
    )?;
    let segment_rows = segments_statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, u64>(4)?,
                row.get::<_, Option<Vec<u8>>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if segment_rows.is_empty() {
        return Ok((None, Vec::new(), Vec::new(), None));
    }

    let mut binding = None;
    let mut entries = Vec::new();
    let mut events = Vec::new();
    let mut status = "complete".to_string();
    let mut failure = None;

    for (segment_id, binding_hash, segment_status, _entry_count, _event_count, failure_hash) in
        segment_rows
    {
        if binding.is_none() {
            if let Some(hash) = binding_hash {
                binding = Some(serde_json::from_value(read_json_blob(connection, &hash)?)?);
            }
        }
        if segment_status == "failed" {
            status = "failed".to_string();
            if failure.is_none() {
                if let Some(hash) = failure_hash {
                    failure = Some(read_json_blob(connection, &hash)?);
                }
            }
        } else if segment_status == "recording" && status != "failed" {
            status = "recording".to_string();
        }

        let mut entries_statement = connection.prepare(
            "SELECT entry_hash, recorded_at
             FROM session_entries WHERE segment_id = ?1 ORDER BY entry_seq",
        )?;
        let segment_entries = entries_statement
            .query_map([&segment_id], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (hash, at) in segment_entries {
            entries.push(serde_json::from_value(json!({
                "seq": entries.len() + 1,
                "at": timestamp(at),
                "entry": read_json_blob(connection, &hash)?,
            }))?);
        }

        let mut events_statement = connection.prepare(
            "SELECT event_type, node_id, attempt_id, turn_id,
                    message_id, tool_call_id, payload_hash, recorded_at
             FROM session_events WHERE segment_id = ?1 ORDER BY event_seq",
        )?;
        let segment_events = events_statement
            .query_map([&segment_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (event_type, node_id, attempt_id, turn_id, message_id, tool_call_id, hash, at) in
            segment_events
        {
            let mut value = json!({
                "seq": events.len() + 1,
                "at": timestamp(at),
                "nodeId": node_id,
                "attemptId": attempt_id,
                "type": event_type,
                "payload": read_json_blob(connection, &hash)?,
            });
            if let Some(turn_id) = turn_id {
                value["turnId"] = json!(turn_id);
            }
            if let Some(message_id) = message_id {
                value["messageId"] = json!(message_id);
            }
            if let Some(tool_call_id) = tool_call_id {
                value["toolCallId"] = json!(tool_call_id);
            }
            events.push(serde_json::from_value(value)?);
        }
    }

    let mut capture = json!({
        "schema": "pi-workflows.session-capture.v1",
        "eventSchema": "pi-workflows.session-event.v1",
        "status": status,
        "eventCount": events.len(),
        "entryCount": entries.len(),
        "lastEventSeq": events.len(),
    });
    if let Some(failure) = failure {
        capture["failure"] = failure;
    }
    Ok((
        binding,
        entries,
        events,
        Some(serde_json::from_value(capture)?),
    ))
}

fn manifest_from_state(state: &RunState) -> Manifest {
    Manifest {
        schema: "pi-workflows.sqlite-view.v1".to_string(),
        run_id: state.run_id.clone(),
        workflow_name: state.workflow_name.clone(),
        run_title: state.run_title.clone(),
        workflow_source: state.workflow_source.clone(),
        started_at: state.started_at.clone(),
        finished_at: state.finished_at.clone(),
        status: state.status,
        trace_schema: "pi-workflows.event.v1".to_string(),
        paths: ManifestPaths {
            workflow: String::new(),
            state: String::new(),
            trace: String::new(),
            session: None,
            artifacts: None,
        },
    }
}

fn timestamp(milliseconds: i64) -> String {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}
