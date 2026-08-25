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
const SCHEMA_NAME: &str = "pi-workflows-state";
const APP_VERSION: &str = "0.13.3";
pub const SCHEMA_DIGEST: [u8; 32] = [
    0x79, 0xd3, 0x18, 0xfc, 0x67, 0xe1, 0x60, 0x6c, 0xea, 0x25, 0x72, 0x93, 0x28, 0xcf, 0x0a, 0x50,
    0x56, 0x36, 0x2d, 0x1d, 0x3e, 0xf3, 0x52, 0xe1, 0x58, 0xcc, 0x1c, 0xb6, 0xbc, 0x93, 0x97, 0xe2,
];
const RESET_INSTRUCTION: &str = "Pi Workflows durable state is incompatible. Move or remove the old workflow state, then create a new state.sqlite database.";

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
    pub settings_scopes: Vec<Value>,
    pub follow_up_queue: Option<Value>,
    pub possibly_interrupted: bool,
}

pub fn read_run(database_path: &Path, run_id: &str) -> Result<LoadedRun> {
    let connection = open(database_path)?;
    let row = connection
        .query_row(
            "SELECT d.definition_hash, l.owner_id, l.expires_at
             FROM runs r
             JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
             JOIN leases l ON l.resource_id = r.resource_id
             WHERE r.run_id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((definition_hash, owner_id, lease_expires_at)) = row else {
        bail!("workflow run not found: {run_id}");
    };
    let definition_value = read_json_blob(&connection, &definition_hash)?;
    let snapshot: DefinitionSnapshot = serde_json::from_value(definition_value.clone())?;
    if snapshot.schema != DEFINITION_SNAPSHOT_SCHEMA {
        bail!(
            "unsupported workflow definition schema: {}",
            snapshot.schema
        );
    }
    let state = read_state(&connection, run_id, &definition_value)?;
    let trace = read_trace(&connection, run_id)?;
    let (session_binding, session_entries, session_events, session_capture) =
        read_session(&connection, run_id)?;
    let settings_scopes = read_settings(&connection, run_id)?;
    let follow_up_queue = read_follow_ups(&connection, run_id)?;
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
        settings_scopes,
        follow_up_queue,
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

pub fn validate_database(database_path: &Path) -> Result<()> {
    open(database_path).map(drop)
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
        bail!(RESET_INSTRUCTION);
    }
    let schema = connection
        .query_row(
            "SELECT schema_name, schema_version, schema_digest, app_version
             FROM schema_meta WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .unwrap_or(None);
    if !matches!(
        schema,
        Some((name, version, digest, app_version))
            if name == SCHEMA_NAME
                && version == USER_VERSION
                && digest.as_slice() == SCHEMA_DIGEST
                && app_version == APP_VERSION
    ) {
        bail!(RESET_INSTRUCTION);
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

fn read_text_blob(connection: &Connection, hash: &[u8]) -> Result<String> {
    let content: Vec<u8> = connection.query_row(
        "SELECT content FROM blobs WHERE blob_hash = ?1 AND media_type = 'text/plain'",
        [hash],
        |row| row.get(0),
    )?;
    Ok(String::from_utf8(content)?)
}

fn read_settings(connection: &Connection, run_id: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT s.scope_id, s.mount_path, s.invocation, s.current_hash, r.revision
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ?1
         ORDER BY s.mount_path, s.invocation",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, u64>(4)?,
        ))
    })?;
    let mut scopes = Vec::new();
    for row in rows {
        let (scope_id, mount_path, invocation, settings_hash, change_number) = row?;
        scopes.push(json!({
            "scopeId": scope_id,
            "mountPath": mount_path,
            "invocation": invocation,
            "changeNumber": change_number,
            "settingsHash": encode_hex(&settings_hash),
        }));
    }
    Ok(scopes)
}

fn read_follow_ups(connection: &Connection, run_id: &str) -> Result<Option<Value>> {
    let queue = connection
        .query_row(
            "SELECT presentation_state FROM workflow_follow_up_queues WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(presentation_state) = queue else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT follow_up_id, order_number, status, source_type, session_entry_id
         FROM workflow_follow_ups WHERE run_id = ?1 ORDER BY order_number",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok(json!({
            "followUpId": row.get::<_, String>(0)?,
            "order": row.get::<_, u64>(1)?,
            "state": row.get::<_, String>(2)?,
            "source": row.get::<_, String>(3)?,
            "sessionEntryId": row.get::<_, Option<String>>(4)?,
        }))
    })?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(Some(json!({
        "presentationState": presentation_state,
        "items": items,
    })))
}

fn read_state(connection: &Connection, run_id: &str, definition: &Value) -> Result<RunState> {
    let row = connection.query_row(
        "SELECT r.resource_id, d.workflow_name, r.parent_run_id, r.title, r.status,
                r.paused, r.status_detail, r.input_hash, r.final_output_hash, r.error_hash,
                r.definition_digest, r.created_at, r.updated_at, r.finished_at,
                resources.revision
         FROM runs r
         JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
         JOIN resources ON resources.resource_id = r.resource_id
         WHERE r.run_id = ?1",
        [run_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Vec<u8>>(7)?,
                row.get::<_, Option<Vec<u8>>>(8)?,
                row.get::<_, Option<Vec<u8>>>(9)?,
                row.get::<_, Vec<u8>>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, u64>(14)?,
            ))
        },
    )?;
    let (
        _resource_id,
        workflow_name,
        parent_run_id,
        title,
        status,
        paused,
        status_detail,
        input_hash,
        final_output_hash,
        error_hash,
        definition_digest,
        created_at,
        updated_at,
        finished_at,
        revision,
    ) = row;

    let steps = read_steps(connection, run_id)?;
    let mut outputs = serde_json::Map::new();
    let mut results = serde_json::Map::new();
    for step in &steps {
        let outcome = step
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or("failed");
        let node_id = step
            .get("nodeId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let started = step
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let finished = step
            .get("finishedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let duration = chrono::DateTime::parse_from_rfc3339(finished)
            .ok()
            .zip(chrono::DateTime::parse_from_rfc3339(started).ok())
            .map_or(0, |(end, start)| (end - start).num_milliseconds());
        let mut result = json!({
            "attemptId": step.get("attemptId").cloned().unwrap_or(Value::Null),
            "nodeId": node_id,
            "nodeType": step.get("nodeType").cloned().unwrap_or(Value::Null),
            "outcome": outcome,
            "startedAt": started,
            "finishedAt": finished,
            "durationMs": duration,
        });
        if outcome == "ok" {
            let output = step.get("output").cloned().unwrap_or(Value::Null);
            outputs.insert(node_id.to_string(), output.clone());
            result["output"] = output;
        } else {
            outputs.remove(node_id);
        }
        if let Some(error) = step.get("error") {
            result["error"] = error.clone();
        }
        results.insert(node_id.to_string(), result.clone());
        if let Some(mount_path) = exit_mount_path(definition, node_id) {
            if outcome == "ok" {
                let output = step.get("output").cloned().unwrap_or(Value::Null);
                outputs.insert(mount_path.clone(), output.clone());
                result["nodeId"] = json!(mount_path);
                result["output"] = output;
                results.insert(mount_path, result);
            }
        }
    }

    let mut state = json!({
        "schema": RUN_STATE_SCHEMA,
        "traceSeq": revision,
        "runId": run_id,
        "workflowName": workflow_name,
        "startedAt": timestamp(created_at),
        "updatedAt": timestamp(updated_at),
        "status": status,
        "input": read_json_blob(connection, &input_hash)?,
        "outputs": outputs,
        "results": results,
        "steps": steps,
    });
    if let Some(value) = parent_run_id {
        state["parentRunId"] = json!(value);
    }
    if let Some(value) = title {
        state["runTitle"] = json!(value);
    }
    if let Some(value) = status_detail {
        state["statusDetail"] = json!(value);
    }
    if paused != 0 {
        state["paused"] = json!(true);
    }
    if let Some(value) = finished_at {
        state["finishedAt"] = json!(timestamp(value));
    }
    if let Some(hash) = final_output_hash {
        state["finalOutput"] = read_json_blob(connection, &hash)?;
    }
    if let Some(hash) = error_hash {
        state["error"] = json!(read_text_blob(connection, &hash)?);
    }
    let carried: u64 = connection.query_row(
        "SELECT count(*) FROM run_steps s
         JOIN node_attempts a ON a.attempt_id = s.attempt_id
         WHERE s.run_id = ?1 AND a.run_id <> s.run_id",
        [run_id],
        |row| row.get(0),
    )?;
    if carried != 0 {
        state["carriedStepCount"] = json!(carried);
    }
    if status == "running" {
        if let Some((attempt_id, node_id, started_at)) = connection
            .query_row(
                "SELECT attempt_id, node_id, started_at FROM node_attempts
                 WHERE run_id = ?1 AND status IN ('pending', 'running', 'waiting')",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?
        {
            state["currentAttemptId"] = json!(attempt_id);
            state["currentNode"] = json!(node_id);
            if let Some(value) = started_at {
                state["currentNodeStartedAt"] = json!(timestamp(value));
            }
        }
    }
    if status == "waiting" {
        if let Some(node_id) = state["steps"]
            .as_array()
            .and_then(|values| values.last())
            .and_then(|step| step.get("nodeId"))
        {
            state["waitingOn"] = node_id.clone();
        }
    }
    let (root_source, mounted_sources) = read_sources(connection, run_id, definition)?;
    if let Some(source) = root_source {
        state["workflowSource"] = source;
    }
    if !mounted_sources.is_empty() {
        state["workflowSources"] = json!(mounted_sources);
    }
    let has_composed_mounts = definition
        .pointer("/composition/mounts")
        .and_then(Value::as_array)
        .is_some_and(|mounts| !mounts.is_empty());
    if !state["workflowSources"].is_null() || has_composed_mounts {
        state["definitionDigest"] = json!(format!("sha256:{}", encode_hex(&definition_digest)));
    }
    let updates = read_updates(connection, run_id)?;
    if !updates.is_empty() {
        state["updates"] = json!(updates);
    }
    if let Some(receipt) = read_human_decision_receipt(connection, run_id)? {
        state["humanDecision"] = receipt;
    }
    Ok(serde_json::from_value(state)?)
}

fn read_steps(connection: &Connection, run_id: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT a.attempt_id, a.node_id, a.node_type, a.status,
                a.output_hash, s.output_override_hash, a.receipt_hash, a.error_hash,
                prompt_entry.entry_hash, response_entry.entry_hash,
                first_link.entry_id, last_link.entry_id, a.started_at, a.finished_at
         FROM run_steps s JOIN node_attempts a ON a.attempt_id = s.attempt_id
         LEFT JOIN attempt_entries prompt_link
           ON prompt_link.attempt_id = a.attempt_id AND prompt_link.role = 'prompt'
         LEFT JOIN session_entries prompt_entry
           ON prompt_entry.segment_id = prompt_link.segment_id AND prompt_entry.entry_id = prompt_link.entry_id
         LEFT JOIN attempt_entries response_link
           ON response_link.attempt_id = a.attempt_id AND response_link.role = 'response'
         LEFT JOIN session_entries response_entry
           ON response_entry.segment_id = response_link.segment_id AND response_entry.entry_id = response_link.entry_id
         LEFT JOIN attempt_entries first_link
           ON first_link.attempt_id = a.attempt_id AND first_link.role = 'first'
         LEFT JOIN attempt_entries last_link
           ON last_link.attempt_id = a.attempt_id AND last_link.role = 'last'
         WHERE s.run_id = ?1 ORDER BY s.step_index",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<Vec<u8>>>(4)?,
            row.get::<_, Option<Vec<u8>>>(5)?,
            row.get::<_, Option<Vec<u8>>>(6)?,
            row.get::<_, Option<Vec<u8>>>(7)?,
            row.get::<_, Option<Vec<u8>>>(8)?,
            row.get::<_, Option<Vec<u8>>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, i64>(12)?,
            row.get::<_, i64>(13)?,
        ))
    })?;
    let mut steps = Vec::new();
    for row in rows {
        let (
            attempt_id,
            node_id,
            node_type,
            status,
            output_hash,
            override_hash,
            receipt_hash,
            error_hash,
            prompt_hash,
            response_hash,
            first_entry_id,
            last_entry_id,
            started_at,
            finished_at,
        ) = row?;
        let receipt = receipt_hash
            .as_deref()
            .map(|hash| read_json_blob(connection, hash))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let prompt = prompt_hash
            .as_deref()
            .map(|hash| read_json_blob(connection, hash))
            .transpose()?
            .as_ref()
            .and_then(prompt_from_entry)
            .map_or(Value::Null, Value::String);
        let output = if let Some(hash) = override_hash.as_deref().or(output_hash.as_deref()) {
            read_json_blob(connection, hash)?
        } else if let Some(hash) = response_hash.as_deref() {
            assistant_output_from_entry(&read_json_blob(connection, hash)?)?
        } else {
            Value::Null
        };
        let mut step = json!({
            "attemptId": attempt_id,
            "nodeId": node_id,
            "nodeType": node_type,
            "outcome": outcome_for_status(&status)?,
            "startedAt": timestamp(started_at),
            "finishedAt": timestamp(finished_at),
            "prompt": prompt,
            "output": output,
        });
        if let Some(hash) = error_hash {
            step["error"] = json!(read_text_blob(connection, &hash)?);
        }
        if let Some(value) = receipt.get("action") {
            step["action"] = value.clone();
        }
        if let Some(value) = receipt.get("assistantMessage") {
            step["assistantMessage"] = value.clone();
        }
        if let (Some(first), Some(last)) = (first_entry_id, last_entry_id) {
            step["conversation"] = json!({ "firstEntryId": first, "lastEntryId": last });
        }
        steps.push(step);
    }
    Ok(steps)
}

fn read_sources(
    connection: &Connection,
    run_id: &str,
    definition: &Value,
) -> Result<(Option<Value>, Vec<Value>)> {
    let mut statement = connection.prepare(
        "SELECT mount_path, source_type, source_ref, source_revision
         FROM run_sources WHERE run_id = ?1 ORDER BY mount_path",
    )?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut root = None;
    let mut mounted = Vec::new();
    for (mount_path, source_type, source_ref, source_revision) in rows {
        let source = if source_type == "builtin" {
            json!({ "kind": "builtin", "id": source_ref, "revision": source_revision })
        } else {
            json!({ "kind": "file", "path": source_ref, "hash": source_revision })
        };
        if mount_path.is_empty() {
            if source["kind"] != "file"
                || !source["path"]
                    .as_str()
                    .is_some_and(|value| value.starts_with("inline:"))
            {
                root = Some(source);
            }
            continue;
        }
        let workflow_name = definition["composition"]["mounts"]
            .as_array()
            .and_then(|mounts| {
                mounts.iter().find(|mount| {
                    mount["mountPath"].as_array().is_some_and(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("/")
                            == mount_path
                    })
                })
            })
            .and_then(|mount| mount["workflowName"].as_str())
            .unwrap_or(&mount_path);
        mounted.push(json!({
            "mountPath": mount_path.split('/').collect::<Vec<_>>(),
            "workflowName": workflow_name,
            "source": source,
        }));
    }
    Ok((root, mounted))
}

fn read_updates(connection: &Connection, run_id: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT u.update_id, u.run_revision, a.node_id, u.attempt_id,
                u.update_type, u.update_key, u.data_hash, u.recorded_at
         FROM workflow_updates u JOIN node_attempts a ON a.attempt_id = u.attempt_id
         WHERE a.run_id = ?1 ORDER BY u.run_revision",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Vec<u8>>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;
    let mut current = std::collections::BTreeMap::new();
    for row in rows {
        let (update_id, seq, node_id, attempt_id, kind, key, hash, at) = row?;
        current.insert(
            (kind.clone(), key.clone()),
            json!({
                "updateId": update_id, "seq": seq, "at": timestamp(at), "runId": run_id,
                "nodeId": node_id, "attemptId": attempt_id, "type": kind, "key": key,
                "data": read_json_blob(connection, &hash)?,
            }),
        );
    }
    let mut values = current.into_values().collect::<Vec<_>>();
    values.sort_by_key(|value| value["seq"].as_u64().unwrap_or_default());
    Ok(values)
}

fn read_human_decision_receipt(connection: &Connection, run_id: &str) -> Result<Option<Value>> {
    let row = connection
        .query_row(
            "SELECT d.request_hash, r.response_hash FROM continuations c
         JOIN human_decisions d ON d.decision_id = c.decision_id
         JOIN human_decision_resolutions r ON r.decision_id = c.decision_id
         WHERE c.continuation_run_id = ?1 AND r.outcome = 'accepted'",
            [run_id],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?;
    let Some((request_hash, decision_hash)) = row else {
        return Ok(None);
    };
    let request = read_json_blob(connection, &request_hash)?;
    let decision = read_json_blob(connection, &decision_hash)?;
    Ok(Some(json!({
        "schema": "pi-workflows.human-decision-receipt.v1",
        "decisionId": request["decisionId"], "requestDigest": request["requestDigest"],
        "nodeId": request["nodeId"], "response": decision["response"],
        "provenance": decision["provenance"], "acceptedAt": decision["acceptedAt"],
        "answerDigest": decision["answerDigest"], "subjectDigest": decision["subjectDigest"],
        "presentationDigest": decision["presentationDigest"], "revision": decision["revision"],
    })))
}

fn prompt_from_entry(entry: &Value) -> Option<String> {
    if let Some(text) = entry.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    entry.get("content")?.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn assistant_output_from_entry(entry: &Value) -> Result<Value> {
    let Some(parts) = entry["message"]["content"].as_array() else {
        bail!("assistant response entry is invalid");
    };
    let text = parts
        .iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        bail!("assistant response entry has no visible text");
    }
    Ok(Value::String(text))
}

fn outcome_for_status(status: &str) -> Result<&'static str> {
    match status {
        "completed" => Ok("ok"),
        "failed" => Ok("failed"),
        "timed_out" => Ok("timed_out"),
        "cancelled" => Ok("cancelled"),
        _ => bail!("workflow step has nonterminal status: {status}"),
    }
}

fn exit_mount_path(definition: &Value, node_id: &str) -> Option<String> {
    let node = definition.get("nodes")?.get(node_id)?;
    if node.get("includeTransition")?.as_str()? != "exit" {
        return None;
    }
    Some(
        node.get("mountPath")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
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
