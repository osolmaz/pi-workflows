//! Read-only access to the canonical Pi Workflows SQLite database.

use crate::protocol::{PageKind, PatchOp};
use crate::state::types::{
    DefinitionSnapshot, Manifest, ManifestPaths, RunState, SessionBinding, SessionCapture,
    SessionEntryRecord, SessionEventRecord, TraceEvent, DEFINITION_SNAPSHOT_SCHEMA,
    RUN_STATE_SCHEMA,
};
use anyhow::{bail, Context, Result};
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

pub const VIEWER_PAGE_SIZE: u64 = 256;

const APPLICATION_ID: i64 = 0x5049_5746;
const USER_VERSION: i64 = 1;
const SCHEMA_NAME: &str = "pi-workflows-state";
const APP_VERSION: &str = "0.13.3";
pub const SCHEMA_DIGEST: [u8; 32] = [
    0x80, 0x0c, 0x33, 0x49, 0x21, 0x9a, 0xba, 0xf9, 0xc6, 0x1b, 0xbc, 0x59, 0x2e, 0x46, 0x3f, 0x8a,
    0x61, 0x8b, 0x49, 0xa0, 0x2f, 0xfd, 0x99, 0xa7, 0xea, 0x59, 0xa1, 0x3b, 0xc3, 0x22, 0x36, 0x29,
];
const RESET_INSTRUCTION: &str = "Pi Workflows durable state is incompatible. Move or remove the old workflow state, then create a new state.sqlite database.";

type LoadedSession = (
    Option<SessionBinding>,
    Vec<SessionEntryRecord>,
    Vec<SessionEventRecord>,
    Option<SessionCapture>,
);

#[derive(Clone, Copy, Debug, Default)]
pub struct ProjectionCursors {
    pub step: Option<u64>,
    pub trace: Option<u64>,
    pub session_entry: Option<u64>,
    pub session_event: Option<u64>,
    pub settings: Option<u64>,
    pub follow_ups: Option<u64>,
    pub updates: Option<u64>,
}

type LoadedSessionWindow = (
    Option<SessionBinding>,
    Vec<SessionEntryRecord>,
    u64,
    u64,
    Vec<SessionEventRecord>,
    u64,
    u64,
    Option<SessionCapture>,
);

#[derive(Debug, Clone)]
pub struct LoadedRun {
    pub manifest: Manifest,
    pub state: RunState,
    pub graph_steps: Vec<crate::state::types::StepRecord>,
    pub taken_transitions: Vec<String>,
    pub graph_cursor: u64,
    pub step_start: u64,
    pub step_total: u64,
    pub snapshot: Option<DefinitionSnapshot>,
    pub trace: Vec<TraceEvent>,
    pub trace_start: u64,
    pub trace_total: u64,
    pub session_binding: Option<SessionBinding>,
    pub session_entries: Vec<SessionEntryRecord>,
    pub session_entry_start: u64,
    pub session_entry_total: u64,
    pub session_events: Vec<SessionEventRecord>,
    pub session_event_start: u64,
    pub session_event_total: u64,
    pub session_capture: Option<SessionCapture>,
    pub settings_scopes: Vec<Value>,
    pub settings_start: u64,
    pub settings_total: u64,
    pub follow_up_queue: Option<Value>,
    pub follow_up_start: u64,
    pub follow_up_total: u64,
    pub update_start: u64,
    pub update_total: u64,
    pub possibly_interrupted: bool,
    pub presentation_revision: u64,
}

#[derive(Debug, Clone)]
pub struct RunIndexRow {
    pub manifest: Manifest,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub presentation_revision: u64,
    pub retained_from_revision: u64,
    pub lease_owner_id: Option<String>,
    pub lease_expires_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ViewerTargetDelta {
    pub target_type: String,
    pub target_key: String,
    pub patch: Vec<PatchOp>,
}

#[derive(Debug, Clone)]
pub struct ViewerRevisionDelta {
    pub revision: u64,
    pub targets: Vec<ViewerTargetDelta>,
}

#[derive(Debug, Clone)]
pub struct ProjectionPage {
    pub start: u64,
    pub total: u64,
    pub items: Vec<Value>,
    pub graph_cursor: Option<u64>,
    pub graph_steps: Option<Vec<crate::state::types::StepRecord>>,
    pub taken_transitions: Option<Vec<String>>,
}

pub enum ViewerDeltaRead {
    Deltas {
        current_revision: u64,
        deltas: Vec<ViewerRevisionDelta>,
    },
    SnapshotRequired {
        current_revision: u64,
        retained_from_revision: u64,
    },
}

pub struct ProjectionReader {
    connection: Connection,
}

impl ProjectionReader {
    pub fn open(database_path: &Path) -> Result<Self> {
        Ok(Self {
            connection: open(database_path)?,
        })
    }

    pub fn data_version(&self) -> Result<u64> {
        Ok(self
            .connection
            .pragma_query_value(None, "data_version", |row| row.get(0))?)
    }

    pub fn list_run_index(&self) -> Result<Vec<RunIndexRow>> {
        list_run_index(&self.connection)
    }

    pub fn read_window(&self, run_id: &str, cursors: ProjectionCursors) -> Result<LoadedRun> {
        read_run_from_connection(&self.connection, run_id, Some(cursors))
    }

    pub fn read_page(
        &self,
        run_id: &str,
        kind: PageKind,
        cursor: u64,
    ) -> Result<(u64, ProjectionPage)> {
        let transaction = self.connection.unchecked_transaction()?;
        let revision = transaction.query_row(
            "SELECT presentation_revision FROM viewer_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )?;
        let page = match kind {
            PageKind::Steps => read_step_page(&transaction, run_id, Some(cursor))?,
            PageKind::Trace => {
                let (items, start, total) = read_trace_window(&transaction, run_id, Some(cursor))?;
                ProjectionPage {
                    start,
                    total,
                    items: items
                        .into_iter()
                        .map(serde_json::to_value)
                        .collect::<Result<Vec<_>, _>>()?,
                    graph_cursor: None,
                    graph_steps: None,
                    taken_transitions: None,
                }
            }
            PageKind::SessionEntries => {
                read_session_entry_page(&transaction, run_id, Some(cursor))?
            }
            PageKind::SessionEvents => read_session_event_page(&transaction, run_id, Some(cursor))?,
            PageKind::Settings => read_settings_page(&transaction, run_id, Some(cursor))?,
            PageKind::FollowUps => read_follow_up_page(&transaction, run_id, Some(cursor))?,
            PageKind::Updates => read_update_page(&transaction, run_id, Some(cursor))?,
        };
        transaction.commit()?;
        Ok((revision, page))
    }

    pub fn read_deltas(&self, run_id: &str, after_revision: u64) -> Result<ViewerDeltaRead> {
        let (current_revision, retained_from_revision): (u64, u64) = self.connection.query_row(
            "SELECT presentation_revision, retained_from_revision
             FROM viewer_runs WHERE run_id = ?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if after_revision == 0
            || after_revision > current_revision
            || after_revision < retained_from_revision.saturating_sub(1)
        {
            return Ok(ViewerDeltaRead::SnapshotRequired {
                current_revision,
                retained_from_revision,
            });
        }
        let mut statement = self.connection.prepare(
            "SELECT presentation_revision, target_type, target_key, patch_hash
             FROM viewer_deltas
             WHERE run_id = ?1 AND presentation_revision > ?2
             ORDER BY presentation_revision, delta_index",
        )?;
        let rows = statement.query_map(rusqlite::params![run_id, after_revision], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })?;
        let mut grouped: BTreeMap<u64, Vec<ViewerTargetDelta>> = BTreeMap::new();
        for row in rows {
            let (revision, target_type, target_key, patch_hash) = row?;
            let patch = serde_json::from_value(read_json_blob(&self.connection, &patch_hash)?)?;
            grouped
                .entry(revision)
                .or_default()
                .push(ViewerTargetDelta {
                    target_type,
                    target_key,
                    patch,
                });
        }
        let contiguous = grouped
            .keys()
            .copied()
            .eq((after_revision + 1)..=current_revision);
        if !contiguous {
            return Ok(ViewerDeltaRead::SnapshotRequired {
                current_revision,
                retained_from_revision,
            });
        }
        Ok(ViewerDeltaRead::Deltas {
            current_revision,
            deltas: grouped
                .into_iter()
                .map(|(revision, targets)| ViewerRevisionDelta { revision, targets })
                .collect(),
        })
    }
}

pub fn read_run(database_path: &Path, run_id: &str) -> Result<LoadedRun> {
    let connection = open(database_path)?;
    read_run_from_connection(&connection, run_id, None)
}

fn read_run_from_connection(
    connection: &Connection,
    run_id: &str,
    cursors: Option<ProjectionCursors>,
) -> Result<LoadedRun> {
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
    let definition_value = read_json_blob(connection, &definition_hash)?;
    let snapshot: DefinitionSnapshot = serde_json::from_value(definition_value.clone())?;
    if snapshot.schema != DEFINITION_SNAPSHOT_SCHEMA {
        bail!(
            "unsupported workflow definition schema: {}",
            snapshot.schema
        );
    }
    let step_total: u64 = connection.query_row(
        "SELECT count(*) FROM run_steps WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let step_start = cursors.map_or(0, |cursors| page_start(step_total, cursors.step));
    let mut update_page = read_update_page(
        connection,
        run_id,
        cursors.and_then(|cursors| cursors.updates),
    )?;
    if cursors.is_none() && update_page.total > update_page.items.len() as u64 {
        update_page.items = read_updates_range(connection, run_id, 0, -1)?;
        update_page.start = 0;
    }
    let update_start = update_page.start;
    let update_total = update_page.total;
    let state = read_state(
        connection,
        run_id,
        &definition_value,
        cursors.map(|_| step_start),
        update_page.items,
    )?;
    let graph_cursor = cursors.map_or_else(
        || step_total.saturating_sub(1),
        |cursors| {
            cursors
                .step
                .unwrap_or_else(|| step_total.saturating_sub(1))
                .min(step_total.saturating_sub(1))
        },
    );
    let (graph_steps, taken_transitions) = match cursors {
        Some(_) => (
            read_graph_steps(connection, run_id, graph_cursor)?,
            read_taken_transitions(connection, run_id, graph_cursor)?,
        ),
        None => (
            state.steps.clone(),
            state
                .steps
                .windows(2)
                .map(|pair| format!("{}->{}", pair[0].node_id, pair[1].node_id))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect(),
        ),
    };
    let (trace, trace_start, trace_total) = match cursors {
        Some(cursors) => read_trace_window(connection, run_id, cursors.trace)?,
        None => {
            let trace = read_trace(connection, run_id)?;
            let total = trace.len() as u64;
            (trace, 0, total)
        }
    };
    let (
        session_binding,
        session_entries,
        session_entry_start,
        session_entry_total,
        session_events,
        session_event_start,
        session_event_total,
        session_capture,
    ) = match cursors {
        Some(cursors) => read_session_window(
            connection,
            run_id,
            cursors.session_entry,
            cursors.session_event,
        )?,
        None => {
            let (binding, entries, events, capture) = read_session(connection, run_id)?;
            let entry_total = entries.len() as u64;
            let event_total = events.len() as u64;
            (
                binding,
                entries,
                0,
                entry_total,
                events,
                0,
                event_total,
                capture,
            )
        }
    };
    let mut settings_page = read_settings_page(
        connection,
        run_id,
        cursors.and_then(|cursors| cursors.settings),
    )?;
    if cursors.is_none() && settings_page.total > settings_page.items.len() as u64 {
        settings_page.items = read_settings_range(connection, run_id, 0, -1)?;
        settings_page.start = 0;
    }
    let mut follow_up_page = read_follow_up_page(
        connection,
        run_id,
        cursors.and_then(|cursors| cursors.follow_ups),
    )?;
    if cursors.is_none() && follow_up_page.total > follow_up_page.items.len() as u64 {
        follow_up_page.items = read_follow_up_range(connection, run_id, 0, -1)?;
        follow_up_page.start = 0;
    }
    let follow_up_queue = read_follow_up_state(connection, run_id)?.map(|presentation_state| {
        json!({
            "presentationState": presentation_state,
            "items": follow_up_page.items,
        })
    });
    let presentation_revision = connection.query_row(
        "SELECT presentation_revision FROM viewer_runs WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let manifest = manifest_from_state(&state);
    let possibly_interrupted = state.status.label() == "running"
        && (owner_id.is_none()
            || lease_expires_at
                .is_none_or(|expires_at| expires_at <= Utc::now().timestamp_millis()));
    Ok(LoadedRun {
        manifest,
        state,
        graph_steps,
        taken_transitions,
        graph_cursor,
        step_start,
        step_total,
        snapshot: Some(snapshot),
        trace,
        trace_start,
        trace_total,
        session_binding,
        session_entries,
        session_entry_start,
        session_entry_total,
        session_events,
        session_event_start,
        session_event_total,
        session_capture,
        settings_scopes: settings_page.items,
        settings_start: settings_page.start,
        settings_total: settings_page.total,
        follow_up_queue,
        follow_up_start: follow_up_page.start,
        follow_up_total: follow_up_page.total,
        update_start,
        update_total,
        possibly_interrupted,
        presentation_revision,
    })
}

pub fn list_runs(database_path: &Path) -> Vec<(String, Manifest)> {
    let Ok(connection) = open(database_path) else {
        return Vec::new();
    };
    list_run_index(&connection)
        .unwrap_or_default()
        .into_iter()
        .map(|row| (row.manifest.run_id.clone(), row.manifest))
        .collect()
}

fn list_run_index(connection: &Connection) -> Result<Vec<RunIndexRow>> {
    let now = Utc::now().timestamp_millis();
    let mut statement = connection.prepare(
        "SELECT r.run_id, d.workflow_name, r.title, r.status,
                r.created_at, r.finished_at,
                v.presentation_revision, v.retained_from_revision,
                l.owner_id, l.expires_at,
                s.source_type, s.source_ref, s.source_revision
         FROM runs r
         JOIN workflow_definitions d ON d.definition_digest = r.definition_digest
         JOIN viewer_runs v ON v.run_id = r.run_id
         JOIN leases l ON l.resource_id = r.resource_id
         LEFT JOIN run_sources s ON s.run_id = r.run_id AND s.mount_path = ''
         ORDER BY r.created_at DESC, r.run_id DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, u64>(6)?,
            row.get::<_, u64>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<i64>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    })?;
    let mut index = Vec::new();
    for row in rows {
        let (
            run_id,
            workflow_name,
            run_title,
            status_value,
            started_at,
            finished_at,
            presentation_revision,
            retained_from_revision,
            owner_id,
            expires_at,
            source_type,
            source_ref,
            source_revision,
        ) = row?;
        let status = parse_run_status(&status_value)?;
        let workflow_source = match (source_type.as_deref(), source_ref, source_revision) {
            (Some("builtin"), Some(id), Some(revision)) => {
                Some(crate::state::types::WorkflowSource::Builtin { id, revision })
            }
            (Some("file"), Some(path), Some(hash)) => {
                Some(crate::state::types::WorkflowSource::File { path, hash })
            }
            (None, None, None) => None,
            _ => bail!("workflow run source is incomplete: {run_id}"),
        };
        index.push(RunIndexRow {
            manifest: Manifest {
                schema: "pi-workflows.sqlite-view.v1".to_string(),
                run_id,
                workflow_name,
                run_title,
                workflow_source,
                started_at: timestamp(started_at),
                finished_at: finished_at.map(timestamp),
                status,
                trace_schema: "pi-workflows.event.v1".to_string(),
                paths: ManifestPaths {
                    workflow: String::new(),
                    state: String::new(),
                    trace: String::new(),
                    session: None,
                    artifacts: None,
                },
            },
            live: status.label() == "running",
            possibly_interrupted: status.label() == "running"
                && (owner_id.is_none() || expires_at.is_none_or(|value| value <= now)),
            presentation_revision,
            retained_from_revision,
            lease_owner_id: owner_id,
            lease_expires_at: expires_at,
        });
    }
    Ok(index)
}

fn parse_run_status(value: &str) -> Result<crate::state::types::RunStatus> {
    use crate::state::types::RunStatus;
    match value {
        "queued" => Ok(RunStatus::Queued),
        "running" => Ok(RunStatus::Running),
        "waiting" => Ok(RunStatus::Waiting),
        "completed" => Ok(RunStatus::Completed),
        "failed" => Ok(RunStatus::Failed),
        "timed_out" => Ok(RunStatus::TimedOut),
        "cancelled" => Ok(RunStatus::Cancelled),
        _ => bail!("workflow run status is invalid: {value}"),
    }
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

fn read_settings_range(
    connection: &Connection,
    run_id: &str,
    start: u64,
    limit: i64,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT s.scope_id, s.mount_path, s.invocation, s.current_hash, r.revision
         FROM workflow_settings s
         JOIN resources r ON r.resource_id = s.resource_id
         WHERE s.active_run_id = ?1
         ORDER BY s.mount_path, s.invocation LIMIT ?2 OFFSET ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, limit, start], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, u64>(4)?,
        ))
    })?;
    let mut items = Vec::new();
    for row in rows {
        let (scope_id, mount_path, invocation, settings_hash, change_number) = row?;
        items.push(json!({
            "scopeId": scope_id,
            "mountPath": mount_path,
            "invocation": invocation,
            "changeNumber": change_number,
            "settingsHash": encode_hex(&settings_hash),
        }));
    }
    Ok(items)
}

fn read_settings_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM workflow_settings WHERE active_run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    Ok(projection_page(
        start,
        total,
        read_settings_range(connection, run_id, start, VIEWER_PAGE_SIZE as i64)?,
    ))
}

fn read_follow_up_range(
    connection: &Connection,
    run_id: &str,
    start: u64,
    limit: i64,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT follow_up_id, order_number, status, source_type, session_entry_id
         FROM workflow_follow_ups
         WHERE run_id = ?1 ORDER BY order_number LIMIT ?2 OFFSET ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, limit, start], |row| {
        Ok(json!({
            "followUpId": row.get::<_, String>(0)?,
            "order": row.get::<_, u64>(1)?,
            "state": row.get::<_, String>(2)?,
            "source": row.get::<_, String>(3)?,
            "sessionEntryId": row.get::<_, Option<String>>(4)?,
        }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn read_follow_up_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM workflow_follow_ups WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    Ok(projection_page(
        start,
        total,
        read_follow_up_range(connection, run_id, start, VIEWER_PAGE_SIZE as i64)?,
    ))
}

fn read_follow_up_state(connection: &Connection, run_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT presentation_state FROM workflow_follow_up_queues WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn read_state(
    connection: &Connection,
    run_id: &str,
    definition: &Value,
    step_start: Option<u64>,
    updates: Vec<Value>,
) -> Result<RunState> {
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

    let steps = read_steps(connection, run_id, step_start)?;
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
        if let Some((attempt_id, node_id, started_at, scope_id, change_number, settings_hash)) =
            connection
                .query_row(
                    "SELECT attempt_id, node_id, started_at,
                        settings_scope_id, settings_change_number, settings_hash
                 FROM node_attempts
                 WHERE run_id = ?1 AND status IN ('pending', 'running', 'waiting', 'interrupted')",
                    [run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<u64>>(4)?,
                            row.get::<_, Option<Vec<u8>>>(5)?,
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
            match (scope_id, change_number, settings_hash) {
                (Some(scope_id), Some(change_number), Some(settings_hash)) => {
                    state["currentSettingsScopeId"] = json!(scope_id);
                    state["currentSettingsChangeNumber"] = json!(change_number);
                    state["currentSettingsHash"] = json!(encode_hex(&settings_hash));
                }
                (None, None, None) => {}
                _ => bail!("active workflow settings binding is incomplete"),
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
    if !updates.is_empty() {
        state["updates"] = json!(updates);
    }
    if let Some(receipt) = read_human_decision_receipt(connection, run_id)? {
        state["humanDecision"] = receipt;
    }
    Ok(serde_json::from_value(state)?)
}

fn read_graph_steps(
    connection: &Connection,
    run_id: &str,
    cutoff: u64,
) -> Result<Vec<crate::state::types::StepRecord>> {
    let mut statement = connection.prepare(
        "WITH ranked AS (
           SELECT s.step_index, a.attempt_id, a.node_id, a.node_type, a.status,
                  a.settings_scope_id, a.settings_change_number, a.settings_hash,
                  a.started_at, a.finished_at,
                  row_number() OVER (
                    PARTITION BY a.node_id ORDER BY s.step_index DESC
                  ) AS position
           FROM run_steps s
           JOIN node_attempts a ON a.attempt_id = s.attempt_id
           WHERE s.run_id = ?1 AND s.step_index <= ?2
         )
         SELECT attempt_id, node_id, node_type, status,
                settings_scope_id, settings_change_number, settings_hash,
                started_at, finished_at
         FROM ranked WHERE position = 1 ORDER BY step_index",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<u64>>(5)?,
            row.get::<_, Option<Vec<u8>>>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    })?;
    let mut steps = Vec::new();
    for row in rows {
        let (
            attempt_id,
            node_id,
            node_type,
            status,
            settings_scope_id,
            settings_change_number,
            settings_hash,
            started_at,
            finished_at,
        ) = row?;
        let mut value = json!({
            "attemptId": attempt_id,
            "nodeId": node_id,
            "nodeType": node_type,
            "outcome": outcome_for_status(&status)?,
            "startedAt": timestamp(started_at),
            "finishedAt": timestamp(finished_at),
            "prompt": null,
            "output": null,
        });
        if let Some(scope_id) = settings_scope_id {
            value["settingsScopeId"] = json!(scope_id);
        }
        if let Some(change_number) = settings_change_number {
            value["settingsChangeNumber"] = json!(change_number);
        }
        if let Some(hash) = settings_hash {
            value["settingsHash"] = json!(encode_hex(&hash));
        }
        steps.push(serde_json::from_value(value)?);
    }
    Ok(steps)
}

fn read_taken_transitions(
    connection: &Connection,
    run_id: &str,
    cutoff: u64,
) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "WITH ordered AS (
           SELECT s.step_index, a.node_id,
                  lag(a.node_id) OVER (ORDER BY s.step_index) AS previous_node
           FROM run_steps s
           JOIN node_attempts a ON a.attempt_id = s.attempt_id
           WHERE s.run_id = ?1 AND s.step_index <= ?2
         )
         SELECT DISTINCT previous_node, node_id
         FROM ordered WHERE previous_node IS NOT NULL
         ORDER BY previous_node, node_id",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, cutoff], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| row.map(|(from, to)| format!("{from}->{to}")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn read_steps(connection: &Connection, run_id: &str, start: Option<u64>) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT a.attempt_id, a.node_id, a.node_type, a.status,
                a.prompt_hash, a.output_hash, s.output_override_hash, a.receipt_hash, a.error_hash,
                prompt_entry.entry_hash, response_entry.entry_hash,
                first_link.entry_id, last_link.entry_id,
                a.settings_scope_id, a.settings_change_number, a.settings_hash,
                a.started_at, a.finished_at
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
         WHERE s.run_id = ?1 AND (?2 IS NULL OR s.step_index >= ?2)
         ORDER BY s.step_index LIMIT ?3",
    )?;
    let limit = start.map_or(-1_i64, |_| VIEWER_PAGE_SIZE as i64);
    let rows = statement.query_map(rusqlite::params![run_id, start, limit], |row| {
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
            row.get::<_, Option<Vec<u8>>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
            row.get::<_, Option<u64>>(14)?,
            row.get::<_, Option<Vec<u8>>>(15)?,
            row.get::<_, i64>(16)?,
            row.get::<_, i64>(17)?,
        ))
    })?;
    let mut steps = Vec::new();
    for row in rows {
        let (
            attempt_id,
            node_id,
            node_type,
            status,
            stored_prompt_hash,
            output_hash,
            override_hash,
            receipt_hash,
            error_hash,
            prompt_hash,
            response_hash,
            first_entry_id,
            last_entry_id,
            settings_scope_id,
            settings_change_number,
            settings_hash,
            started_at,
            finished_at,
        ) = row?;
        let receipt = receipt_hash
            .as_deref()
            .map(|hash| read_json_blob(connection, hash))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let prompt = if let Some(hash) = prompt_hash.as_deref() {
            let entry = read_json_blob(connection, hash)?;
            prompt_from_entry(&entry).map_or(Value::Null, Value::String)
        } else if let Some(hash) = stored_prompt_hash.as_deref() {
            Value::String(read_text_blob(connection, hash)?)
        } else {
            Value::Null
        };
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
        match (settings_scope_id, settings_change_number, settings_hash) {
            (Some(scope_id), Some(change_number), Some(settings_hash)) => {
                step["settingsScopeId"] = json!(scope_id);
                step["settingsChangeNumber"] = json!(change_number);
                step["settingsHash"] = json!(encode_hex(&settings_hash));
            }
            (None, None, None) => {}
            _ => bail!("saved workflow settings binding is incomplete"),
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

fn read_updates_range(
    connection: &Connection,
    run_id: &str,
    start: u64,
    limit: i64,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "WITH latest AS (
           SELECT u.update_id, u.run_revision, a.node_id, u.attempt_id,
                  u.update_type, u.update_key, u.data_hash, u.recorded_at,
                  row_number() OVER (
                    PARTITION BY u.update_type, u.update_key
                    ORDER BY u.run_revision DESC
                  ) AS position
           FROM workflow_updates u
           JOIN node_attempts a ON a.attempt_id = u.attempt_id
           WHERE a.run_id = ?1
         )
         SELECT update_id, run_revision, node_id, attempt_id,
                update_type, update_key, data_hash, recorded_at
         FROM latest WHERE position = 1
         ORDER BY run_revision LIMIT ?2 OFFSET ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, limit, start], |row| {
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
    let mut values = Vec::new();
    for row in rows {
        let (update_id, seq, node_id, attempt_id, kind, key, hash, at) = row?;
        values.push(json!({
            "updateId": update_id, "seq": seq, "at": timestamp(at), "runId": run_id,
            "nodeId": node_id, "attemptId": attempt_id, "type": kind, "key": key,
            "data": read_json_blob(connection, &hash)?,
        }));
    }
    values.sort_by_key(|value| value["seq"].as_u64().unwrap_or_default());
    Ok(values)
}

fn read_update_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM (
           SELECT 1 FROM workflow_updates u
           JOIN node_attempts a ON a.attempt_id = u.attempt_id
           WHERE a.run_id = ?1 GROUP BY u.update_type, u.update_key
         )",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    Ok(projection_page(
        start,
        total,
        read_updates_range(connection, run_id, start, VIEWER_PAGE_SIZE as i64)?,
    ))
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

fn read_trace_window(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<(Vec<TraceEvent>, u64, u64)> {
    let resource_id: String = connection.query_row(
        "SELECT resource_id FROM runs WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM events WHERE resource_id = ?1",
        [&resource_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    let mut statement = connection.prepare(
        "SELECT resource_revision, event_type, payload_hash, recorded_at
         FROM events
         WHERE resource_id = ?1 AND resource_revision > ?2
         ORDER BY resource_revision LIMIT ?3",
    )?;
    let rows = statement.query_map(
        rusqlite::params![resource_id, start, VIEWER_PAGE_SIZE],
        |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )?;
    let mut events = Vec::new();
    for row in rows {
        let (seq, event_type, payload_hash, recorded_at) = row?;
        let envelope = match payload_hash {
            Some(hash) => read_json_blob(connection, &hash)?,
            None => json!({}),
        };
        let mut event = json!({
            "seq": seq,
            "at": timestamp(recorded_at),
            "runId": run_id,
            "scope": envelope.get("scope").and_then(Value::as_str).unwrap_or("run"),
            "type": event_type,
            "payload": envelope.get("payload").cloned().unwrap_or_else(|| json!({})),
        });
        if let Some(node_id) = envelope.get("nodeId") {
            event["nodeId"] = node_id.clone();
        }
        if let Some(attempt_id) = envelope.get("attemptId") {
            event["attemptId"] = attempt_id.clone();
        }
        events.push(serde_json::from_value(event)?);
    }
    Ok((events, start, total))
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

fn read_step_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM run_steps WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    let graph_cursor = cursor
        .unwrap_or_else(|| total.saturating_sub(1))
        .min(total.saturating_sub(1));
    Ok(ProjectionPage {
        start,
        total,
        items: read_steps(connection, run_id, Some(start))?,
        graph_cursor: Some(graph_cursor),
        graph_steps: Some(read_graph_steps(connection, run_id, graph_cursor)?),
        taken_transitions: Some(read_taken_transitions(connection, run_id, graph_cursor)?),
    })
}

fn read_session_entry_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM session_entries WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    let mut statement = connection.prepare(
        "SELECT entry_hash, recorded_at
         FROM session_entries
         WHERE run_id = ?1 AND run_seq > ?2
         ORDER BY run_seq LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, start, VIEWER_PAGE_SIZE], |row| {
        Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut items = Vec::new();
    for (index, row) in rows.enumerate() {
        let (hash, at) = row?;
        items.push(json!({
            "seq": start + index as u64 + 1,
            "at": timestamp(at),
            "entry": read_json_blob(connection, &hash)?,
        }));
    }
    Ok(ProjectionPage {
        start,
        total,
        items,
        graph_cursor: None,
        graph_steps: None,
        taken_transitions: None,
    })
}

fn read_session_event_page(
    connection: &Connection,
    run_id: &str,
    cursor: Option<u64>,
) -> Result<ProjectionPage> {
    let total: u64 = connection.query_row(
        "SELECT count(*) FROM session_events WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let start = page_start(total, cursor);
    let mut statement = connection.prepare(
        "SELECT e.event_type, e.node_id, e.attempt_id, e.turn_id,
                e.message_id, e.tool_call_id, e.payload_hash, e.recorded_at,
                s.step_index
         FROM session_events e
         LEFT JOIN run_steps s ON s.run_id = e.run_id AND s.attempt_id = e.attempt_id
         WHERE e.run_id = ?1 AND e.run_seq > ?2
         ORDER BY e.run_seq LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, start, VIEWER_PAGE_SIZE], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Vec<u8>>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, Option<u64>>(8)?,
        ))
    })?;
    let mut items = Vec::new();
    for (index, row) in rows.enumerate() {
        let (
            event_type,
            node_id,
            attempt_id,
            turn_id,
            message_id,
            tool_call_id,
            hash,
            at,
            step_index,
        ) = row?;
        let mut value = json!({
            "seq": start + index as u64 + 1,
            "at": timestamp(at),
            "nodeId": node_id,
            "attemptId": attempt_id,
            "type": event_type,
            "payload": read_json_blob(connection, &hash)?,
        });
        if let Some(step_index) = step_index {
            value["stepIndex"] = json!(step_index);
        }
        if let Some(turn_id) = turn_id {
            value["turnId"] = json!(turn_id);
        }
        if let Some(message_id) = message_id {
            value["messageId"] = json!(message_id);
        }
        if let Some(tool_call_id) = tool_call_id {
            value["toolCallId"] = json!(tool_call_id);
        }
        items.push(value);
    }
    Ok(ProjectionPage {
        start,
        total,
        items,
        graph_cursor: None,
        graph_steps: None,
        taken_transitions: None,
    })
}

fn read_session_window(
    connection: &Connection,
    run_id: &str,
    entry_cursor: Option<u64>,
    event_cursor: Option<u64>,
) -> Result<LoadedSessionWindow> {
    let mut segments_statement = connection.prepare(
        "SELECT binding_hash, status, entry_count, event_count, failure_hash
         FROM session_segments
         WHERE run_id = ?1
         ORDER BY created_at, segment_id",
    )?;
    let segment_rows = segments_statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, Option<Vec<u8>>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if segment_rows.is_empty() {
        return Ok((None, Vec::new(), 0, 0, Vec::new(), 0, 0, None));
    }

    let mut binding = None;
    let mut status = "complete".to_string();
    let mut failure = None;
    let mut entry_total = 0u64;
    let mut event_total = 0u64;
    for (binding_hash, segment_status, entry_count, event_count, failure_hash) in &segment_rows {
        entry_total += entry_count;
        event_total += event_count;
        if binding.is_none() {
            if let Some(hash) = binding_hash {
                binding = Some(serde_json::from_value(read_json_blob(connection, hash)?)?);
            }
        }
        if segment_status == "failed" {
            status = "failed".to_string();
            if failure.is_none() {
                if let Some(hash) = failure_hash {
                    failure = Some(read_json_blob(connection, hash)?);
                }
            }
        } else if segment_status == "recording" && status != "failed" {
            status = "recording".to_string();
        }
    }

    let entry_start = page_start(entry_total, entry_cursor);
    let mut entry_statement = connection.prepare(
        "SELECT entry_hash, recorded_at
         FROM session_entries
         WHERE run_id = ?1 AND run_seq > ?2
         ORDER BY run_seq
         LIMIT ?3",
    )?;
    let entry_rows = entry_statement.query_map(
        rusqlite::params![run_id, entry_start, VIEWER_PAGE_SIZE],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let mut entries = Vec::new();
    for (index, row) in entry_rows.enumerate() {
        let (hash, at) = row?;
        entries.push(serde_json::from_value(json!({
            "seq": entry_start + index as u64 + 1,
            "at": timestamp(at),
            "entry": read_json_blob(connection, &hash)?,
        }))?);
    }

    let event_start = page_start(event_total, event_cursor);
    let mut event_statement = connection.prepare(
        "SELECT e.event_type, e.node_id, e.attempt_id, e.turn_id,
                e.message_id, e.tool_call_id, e.payload_hash, e.recorded_at,
                s.step_index
         FROM session_events e
         LEFT JOIN run_steps s ON s.run_id = e.run_id AND s.attempt_id = e.attempt_id
         WHERE e.run_id = ?1 AND e.run_seq > ?2
         ORDER BY e.run_seq
         LIMIT ?3",
    )?;
    let event_rows = event_statement.query_map(
        rusqlite::params![run_id, event_start, VIEWER_PAGE_SIZE],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<u64>>(8)?,
            ))
        },
    )?;
    let mut events = Vec::new();
    for (index, row) in event_rows.enumerate() {
        let (
            event_type,
            node_id,
            attempt_id,
            turn_id,
            message_id,
            tool_call_id,
            hash,
            at,
            step_index,
        ) = row?;
        let mut value = json!({
            "seq": event_start + index as u64 + 1,
            "at": timestamp(at),
            "nodeId": node_id,
            "attemptId": attempt_id,
            "type": event_type,
            "payload": read_json_blob(connection, &hash)?,
        });
        if let Some(step_index) = step_index {
            value["stepIndex"] = json!(step_index);
        }
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

    let mut capture = json!({
        "schema": "pi-workflows.session-capture.v1",
        "eventSchema": "pi-workflows.session-event.v1",
        "status": status,
        "eventCount": event_total,
        "entryCount": entry_total,
        "lastEventSeq": event_total,
    });
    if let Some(failure) = failure {
        capture["failure"] = failure;
    }
    Ok((
        binding,
        entries,
        entry_start,
        entry_total,
        events,
        event_start,
        event_total,
        Some(serde_json::from_value(capture)?),
    ))
}

fn projection_page(start: u64, total: u64, items: Vec<Value>) -> ProjectionPage {
    ProjectionPage {
        start,
        total,
        items,
        graph_cursor: None,
        graph_steps: None,
        taken_transitions: None,
    }
}

fn page_start(total: u64, cursor: Option<u64>) -> u64 {
    if total <= VIEWER_PAGE_SIZE {
        return 0;
    }
    let center = cursor
        .unwrap_or(total.saturating_sub(1))
        .min(total.saturating_sub(1));
    center
        .saturating_sub(VIEWER_PAGE_SIZE / 2)
        .min(total - VIEWER_PAGE_SIZE)
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
