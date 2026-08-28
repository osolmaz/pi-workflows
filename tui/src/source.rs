//! Revisioned, bounded database views for the local TUI and replay server.

use crate::layout::{layout_graph, GraphLayout};
use crate::protocol::{apply_patch, PageKind, PatchOp};
use crate::source_loader::{LoadRequest, SourceLoader};
use crate::state::reader::{
    LoadedRun, ProjectionCursors, ProjectionPage, ProjectionReader, RunIndexRow, ViewerDeltaRead,
    ViewerRevisionDelta,
};
use crate::state::types::{
    DefinitionSnapshot, Manifest, RunState, SessionBinding, SessionCapture, SessionEntryRecord,
    SessionEventRecord,
};
use anyhow::{bail, Result};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub type WindowCursor = ProjectionCursors;

pub struct RunEntry {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub manifest_raw: Value,
    pub workflow: Value,
    pub graph_layout: Option<GraphLayout>,
    pub state_raw: Value,
    pub graph_steps: Vec<crate::state::types::StepRecord>,
    pub taken_transitions: Vec<String>,
    pub graph_cursor: u64,
    pub step_start: u64,
    pub step_total: u64,
    pub events: Vec<Value>,
    pub trace_start: u64,
    pub trace_total: u64,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    pub session_entry_start: u64,
    pub session_entry_total: u64,
    pub session_events: Vec<Value>,
    pub session_event_start: u64,
    pub session_event_total: u64,
    pub session_events_malformed: bool,
    pub session_events_torn_tail: bool,
    pub session_capture: Option<Value>,
    pub session_replay_checkpoint: Option<Value>,
    pub settings_scopes: Vec<Value>,
    pub settings_start: u64,
    pub settings_total: u64,
    pub follow_up_queue: Option<Value>,
    pub follow_up_start: u64,
    pub follow_up_total: u64,
    pub update_start: u64,
    pub update_total: u64,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub revision: u64,
    pub graph_revision: u64,
}

impl RunEntry {
    fn from_loaded(database_path: &Path, loaded: LoadedRun) -> Result<Self> {
        let manifest_raw = serde_json::to_value(&loaded.manifest)?;
        let graph_layout = loaded.snapshot.as_ref().map(layout_graph);
        let workflow = loaded
            .snapshot
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(Value::Null);
        let state_raw = serde_json::to_value(&loaded.state)?;
        let events = loaded
            .trace
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()?;
        let session_binding = loaded
            .session_binding
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let session_entries = loaded
            .session_entries
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()?;
        let session_events = loaded
            .session_events
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()?;
        let session_capture = loaded
            .session_capture
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let live = !loaded.state.status.is_terminal();
        Ok(Self {
            dir: database_path.to_path_buf(),
            manifest: loaded.manifest,
            manifest_raw,
            workflow,
            graph_layout,
            state_raw,
            graph_steps: loaded.graph_steps,
            taken_transitions: loaded.taken_transitions,
            graph_cursor: loaded.graph_cursor,
            step_start: loaded.step_start,
            step_total: loaded.step_total,
            events,
            trace_start: loaded.trace_start,
            trace_total: loaded.trace_total,
            session_binding,
            session_entries,
            session_entry_start: loaded.session_entry_start,
            session_entry_total: loaded.session_entry_total,
            session_events,
            session_event_start: loaded.session_event_start,
            session_event_total: loaded.session_event_total,
            session_events_malformed: false,
            session_events_torn_tail: false,
            session_capture,
            session_replay_checkpoint: loaded.session_replay_checkpoint,
            settings_scopes: loaded.settings_scopes,
            settings_start: loaded.settings_start,
            settings_total: loaded.settings_total,
            follow_up_queue: loaded.follow_up_queue,
            follow_up_start: loaded.follow_up_start,
            follow_up_total: loaded.follow_up_total,
            update_start: loaded.update_start,
            update_total: loaded.update_total,
            state: loaded.state,
            snapshot: loaded.snapshot,
            live,
            possibly_interrupted: loaded.possibly_interrupted,
            revision: loaded.presentation_revision,
            graph_revision: loaded.presentation_revision,
        })
    }

    fn session_value(&self) -> Value {
        if self.session_binding.is_none()
            && self.session_entries.is_empty()
            && self.session_events.is_empty()
            && self.session_capture.is_none()
        {
            Value::Null
        } else {
            json!({
                "binding": self.session_binding,
                "presentationRevision": self.revision,
                "entryPage": {
                    "presentationRevision": self.revision,
                    "start": self.session_entry_start,
                    "total": self.session_entry_total,
                    "items": self.session_entries,
                },
                "eventPage": {
                    "presentationRevision": self.revision,
                    "start": self.session_event_start,
                    "total": self.session_event_total,
                    "items": self.session_events,
                },
                "eventsMalformed": self.session_events_malformed,
                "eventsTornTail": self.session_events_torn_tail,
                "capture": self.session_capture,
                "replayCheckpoint": self.session_replay_checkpoint,
            })
        }
    }

    fn apply_root_patch(&mut self, patch: &[PatchOp]) -> bool {
        let mut document = self.view();
        if apply_patch(&mut document, patch).is_err() {
            return false;
        }
        let Some(manifest_raw) = document.get("manifest").cloned() else {
            return false;
        };
        let Some(state_raw) = document.get("state").cloned() else {
            return false;
        };
        let Ok(manifest) = serde_json::from_value(manifest_raw.clone()) else {
            return false;
        };
        let Ok(state) = serde_json::from_value(state_raw.clone()) else {
            return false;
        };
        let Ok(graph_steps) = serde_json::from_value(
            document
                .get("graphSteps")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ) else {
            return false;
        };
        let Ok(taken_transitions) = serde_json::from_value(
            document
                .get("takenTransitions")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ) else {
            return false;
        };
        let Some(graph_revision) = document.get("graphRevision").and_then(Value::as_u64) else {
            return false;
        };
        let Some(graph_cursor) = document.get("graphCursor").and_then(Value::as_u64) else {
            return false;
        };
        let Some(step_start) = document.get("stepStart").and_then(Value::as_u64) else {
            return false;
        };
        let Some(step_total) = document.get("stepTotal").and_then(Value::as_u64) else {
            return false;
        };
        let Some(update_start) = document.get("updateStart").and_then(Value::as_u64) else {
            return false;
        };
        let Some(update_total) = document.get("updateTotal").and_then(Value::as_u64) else {
            return false;
        };
        let Some(live) = document.get("live").and_then(Value::as_bool) else {
            return false;
        };

        self.manifest_raw = manifest_raw;
        self.manifest = manifest;
        self.state_raw = state_raw;
        self.state = state;
        self.graph_steps = graph_steps;
        self.taken_transitions = taken_transitions;
        self.graph_revision = graph_revision;
        self.graph_cursor = graph_cursor;
        self.step_start = step_start;
        self.step_total = step_total;
        self.update_start = update_start;
        self.update_total = update_total;
        self.settings_scopes = document
            .get("settingsScopes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.settings_start = document
            .get("settingsStart")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.settings_total = document
            .get("settingsTotal")
            .and_then(Value::as_u64)
            .unwrap_or(self.settings_scopes.len() as u64);
        self.follow_up_queue = document
            .get("followUpQueue")
            .cloned()
            .filter(|value| !value.is_null());
        self.follow_up_start = document
            .get("followUpStart")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.follow_up_total = document
            .get("followUpTotal")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                self.follow_up_queue
                    .as_ref()
                    .and_then(|queue| queue.get("items"))
                    .and_then(Value::as_array)
                    .map_or(0, |items| items.len() as u64)
            });
        self.live = live;
        if let Some(possibly_interrupted) =
            document.get("possiblyInterrupted").and_then(Value::as_bool)
        {
            self.possibly_interrupted = possibly_interrupted;
        }
        if let Some(session) = document.get("session") {
            if session.is_null() {
                self.session_binding = None;
                self.session_entries.clear();
                self.session_entry_start = 0;
                self.session_entry_total = 0;
                self.session_events.clear();
                self.session_event_start = 0;
                self.session_event_total = 0;
                self.session_capture = None;
                self.session_replay_checkpoint = None;
            } else {
                self.session_binding = session
                    .get("binding")
                    .cloned()
                    .filter(|value| !value.is_null());
                self.session_entries = session
                    .pointer("/entryPage/items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.session_entry_start = session
                    .pointer("/entryPage/start")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.session_entry_total = session
                    .pointer("/entryPage/total")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.session_entries.len() as u64);
                self.session_events = session
                    .pointer("/eventPage/items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.session_event_start = session
                    .pointer("/eventPage/start")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.session_event_total = session
                    .pointer("/eventPage/total")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.session_events.len() as u64);
                self.session_capture = session
                    .get("capture")
                    .cloned()
                    .filter(|value| !value.is_null());
                self.session_replay_checkpoint = session
                    .get("replayCheckpoint")
                    .cloned()
                    .filter(|value| !value.is_null());
                self.session_events_malformed = session
                    .get("eventsMalformed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.session_events_torn_tail = session
                    .get("eventsTornTail")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
        }
        true
    }

    fn apply_delta(&mut self, delta: &ViewerRevisionDelta) -> bool {
        if delta.revision != self.revision + 1 {
            return false;
        }
        for target in &delta.targets {
            let applied = match (target.target_type.as_str(), target.target_key.as_str()) {
                ("replay", "steps:reload") => false,
                ("summary" | "graph" | "replay" | "inspector", _) => {
                    self.apply_root_patch(&target.patch)
                }
                ("conversation", key) if key.starts_with("entries:") => apply_page_patch(
                    &mut self.session_entry_start,
                    &mut self.session_entry_total,
                    &mut self.session_entries,
                    self.revision,
                    &target.patch,
                ),
                ("timeline", key) if key.starts_with("trace:") => apply_page_patch(
                    &mut self.trace_start,
                    &mut self.trace_total,
                    &mut self.events,
                    self.revision,
                    &target.patch,
                ),
                ("timeline", key) if key.starts_with("session:") => apply_page_patch(
                    &mut self.session_event_start,
                    &mut self.session_event_total,
                    &mut self.session_events,
                    self.revision,
                    &target.patch,
                ),
                ("conversation", "capture") => {
                    let mut document = json!({
                        "presentationRevision": self.revision,
                        "capture": self.session_capture,
                    });
                    if apply_patch(&mut document, &target.patch).is_err() {
                        false
                    } else {
                        self.session_capture = document
                            .get("capture")
                            .filter(|value| !value.is_null())
                            .cloned();
                        true
                    }
                }
                _ => false,
            };
            if !applied {
                return false;
            }
        }
        self.revision = delta.revision;
        true
    }

    pub fn view(&self) -> Value {
        json!({
            "presentationRevision": self.revision,
            "graphRevision": self.graph_revision,
            "manifest": self.manifest_raw,
            "workflow": self.workflow,
            "graphScene": self.graph_layout,
            "state": self.state_raw,
            "graphSteps": self.graph_steps,
            "takenTransitions": self.taken_transitions,
            "graphCursor": self.graph_cursor,
            "stepStart": self.step_start,
            "stepTotal": self.step_total,
            "tracePage": {
                "presentationRevision": self.revision,
                "start": self.trace_start,
                "total": self.trace_total,
                "items": self.events,
            },
            "session": self.session_value(),
            "settingsScopes": self.settings_scopes,
            "settingsStart": self.settings_start,
            "settingsTotal": self.settings_total,
            "followUpQueue": self.follow_up_queue,
            "followUpStart": self.follow_up_start,
            "followUpTotal": self.follow_up_total,
            "updateStart": self.update_start,
            "updateTotal": self.update_total,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }
}

pub struct ProjectionUpdate {
    pub run_id: String,
    pub delta: ViewerRevisionDelta,
}

pub struct RefreshOutcome {
    pub updates: Vec<ProjectionUpdate>,
    pub snapshots_required: Vec<String>,
    pub listing_changed: bool,
}

fn apply_page_patch(
    start: &mut u64,
    total: &mut u64,
    items: &mut Vec<Value>,
    revision: u64,
    patch: &[PatchOp],
) -> bool {
    if start.saturating_add(items.len() as u64) != *total {
        return true;
    }
    let mut page = json!({
        "presentationRevision": revision,
        "start": *start,
        "total": *total,
        "items": items,
    });
    if apply_patch(&mut page, patch).is_err() {
        return false;
    }
    let (Some(next_start), Some(next_total), Some(next_items)) = (
        page.get("start").and_then(Value::as_u64),
        page.get("total").and_then(Value::as_u64),
        page.get("items").and_then(Value::as_array),
    ) else {
        return false;
    };
    *start = next_start;
    *total = next_total;
    *items = next_items.clone();
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SourceStats {
    pub data_version_checks: u64,
    pub index_reads: u64,
    pub window_reads: u64,
    pub page_reads: u64,
    pub payload_rows_read: u64,
}

pub struct RunSource {
    database_path: PathBuf,
    reader: ProjectionReader,
    loader: SourceLoader,
    next_generation: u64,
    pending: BTreeMap<String, u64>,
    data_version: u64,
    index: BTreeMap<String, RunIndexRow>,
    runs: BTreeMap<String, RunEntry>,
    cursors: BTreeMap<String, WindowCursor>,
    watched: BTreeMap<String, usize>,
    local_selected: Option<String>,
    single_run_id: Option<String>,
    load_errors: BTreeMap<String, String>,
    stats: SourceStats,
}

impl RunSource {
    pub fn new(database_path: &Path) -> Result<Self> {
        let reader = ProjectionReader::open(database_path)?;
        let loader = SourceLoader::new(database_path)?;
        let data_version = reader.data_version()?;
        let index = reader
            .list_run_index()?
            .into_iter()
            .map(|row| (row.manifest.run_id.clone(), row))
            .collect();
        Ok(Self {
            database_path: database_path.to_path_buf(),
            reader,
            loader,
            next_generation: 0,
            pending: BTreeMap::new(),
            data_version,
            index,
            runs: BTreeMap::new(),
            cursors: BTreeMap::new(),
            watched: BTreeMap::new(),
            local_selected: None,
            single_run_id: None,
            load_errors: BTreeMap::new(),
            stats: SourceStats {
                data_version_checks: 1,
                index_reads: 1,
                ..SourceStats::default()
            },
        })
    }

    pub fn single(database_path: &Path, run_id: &str) -> Result<Self> {
        let mut source = Self::new(database_path)?;
        if !source.index.contains_key(run_id) {
            bail!("workflow run not found: {run_id}");
        }
        source.single_run_id = Some(run_id.to_string());
        source.select(run_id)?;
        Ok(source)
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn get(&self, run_id: &str) -> Option<&RunEntry> {
        self.runs.get(run_id)
    }

    pub fn ordered_run_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.index.keys().cloned().collect();
        ids.sort_by(|left, right| {
            let left_row = &self.index[left];
            let right_row = &self.index[right];
            right_row
                .manifest
                .started_at
                .cmp(&left_row.manifest.started_at)
                .then_with(|| right.cmp(left))
        });
        ids
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.ordered_run_ids()
            .iter()
            .filter_map(|id| self.index.get(id))
            .map(|row| {
                json!({
                    "presentationRevision": row.presentation_revision,
                    "manifest": row.manifest,
                    "live": row.live,
                    "possiblyInterrupted": row.possibly_interrupted,
                })
            })
            .collect()
    }

    pub fn select(&mut self, run_id: &str) -> Result<()> {
        if self.local_selected.as_deref() == Some(run_id) && self.runs.contains_key(run_id) {
            return Ok(());
        }
        if !self.index.contains_key(run_id) {
            bail!("workflow run not found: {run_id}");
        }
        let previous = self.local_selected.replace(run_id.to_string());
        self.submit_load(run_id);
        if let Some(previous) = previous {
            if previous != run_id {
                self.pending.remove(&previous);
                if !self.watched.contains_key(&previous) {
                    self.runs.remove(&previous);
                    self.cursors.remove(&previous);
                    self.load_errors.remove(&previous);
                }
            }
        }
        Ok(())
    }

    pub fn watch(&mut self, run_id: &str) -> Result<()> {
        if !self.index.contains_key(run_id) {
            bail!("workflow run not found: {run_id}");
        }
        let count = self.watched.entry(run_id.to_string()).or_default();
        *count += 1;
        if *count == 1 && !self.runs.contains_key(run_id) {
            self.load(run_id)?;
        }
        Ok(())
    }

    pub fn unwatch(&mut self, run_id: &str) {
        let Some(count) = self.watched.get_mut(run_id) else {
            return;
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.watched.remove(run_id);
            if self.local_selected.as_deref() != Some(run_id) {
                self.runs.remove(run_id);
                self.cursors.remove(run_id);
                self.load_errors.remove(run_id);
            }
        }
    }

    pub fn watcher_count(&self, run_id: &str) -> usize {
        self.watched.get(run_id).copied().unwrap_or(0)
    }

    pub fn deltas_after(&self, run_id: &str, revision: u64) -> Result<ViewerDeltaRead> {
        self.reader.read_deltas(run_id, revision)
    }

    pub fn page(
        &mut self,
        run_id: &str,
        kind: PageKind,
        cursor: u64,
    ) -> Result<(u64, ProjectionPage)> {
        let (revision, page) = self.reader.read_page(run_id, kind, cursor)?;
        self.stats.page_reads += 1;
        self.stats.payload_rows_read += page.items.len() as u64;
        Ok((revision, page))
    }

    pub fn stats(&self) -> SourceStats {
        self.stats
    }

    pub fn load_error(&self, run_id: &str) -> Option<&str> {
        self.load_errors.get(run_id).map(String::as_str)
    }

    pub fn is_stale(&self, run_id: &str) -> bool {
        self.runs.contains_key(run_id) && self.load_errors.contains_key(run_id)
    }

    pub fn cursor(&self, run_id: &str) -> WindowCursor {
        self.cursors.get(run_id).copied().unwrap_or_default()
    }

    pub fn request_window(&mut self, run_id: &str, cursor: WindowCursor) -> Result<()> {
        self.cursors.insert(run_id.to_string(), cursor);
        if self.watched.contains_key(run_id) {
            self.load(run_id)?;
        } else if self.local_selected.as_deref() == Some(run_id) {
            self.submit_load(run_id);
        }
        Ok(())
    }

    pub fn drain(&mut self) {
        for result in self.loader.drain() {
            if self.pending.get(&result.run_id).copied() != Some(result.generation) {
                continue;
            }
            self.pending.remove(&result.run_id);
            match result.loaded {
                Ok(loaded) => {
                    self.stats.window_reads += 1;
                    self.stats.payload_rows_read += loaded_payload_rows(&loaded);
                    if self.index.get(&result.run_id).is_some_and(|row| {
                        row.presentation_revision == loaded.presentation_revision
                    }) {
                        match RunEntry::from_loaded(&self.database_path, loaded) {
                            Ok(mut entry) => {
                                if let Some(layout) = self
                                    .runs
                                    .get(&result.run_id)
                                    .and_then(|current| current.graph_layout.clone())
                                {
                                    entry.graph_layout = Some(layout);
                                }
                                self.load_errors.remove(&result.run_id);
                                self.runs.insert(result.run_id, entry);
                            }
                            Err(_) => {
                                self.load_errors
                                    .insert(result.run_id, "run data is unavailable".to_string());
                            }
                        }
                    }
                }
                Err(_) => {
                    self.load_errors
                        .insert(result.run_id, "run data is unavailable".to_string());
                }
            }
        }
    }

    pub fn refresh_all(&mut self) -> RefreshOutcome {
        self.drain();
        self.stats.data_version_checks += 1;
        let Ok(next_data_version) = self.reader.data_version() else {
            return RefreshOutcome {
                updates: Vec::new(),
                snapshots_required: Vec::new(),
                listing_changed: false,
            };
        };
        let mut listing_changed = self.refresh_interruption_clock();
        if next_data_version == self.data_version {
            return RefreshOutcome {
                updates: Vec::new(),
                snapshots_required: Vec::new(),
                listing_changed,
            };
        }
        self.data_version = next_data_version;
        let Ok(rows) = self.reader.list_run_index() else {
            return RefreshOutcome {
                updates: Vec::new(),
                snapshots_required: Vec::new(),
                listing_changed,
            };
        };
        self.stats.index_reads += 1;
        let next_index: BTreeMap<String, RunIndexRow> = rows
            .into_iter()
            .map(|row| (row.manifest.run_id.clone(), row))
            .collect();
        listing_changed |= index_changed(&self.index, &next_index);
        self.index = next_index;

        let demanded: BTreeSet<String> = self
            .watched
            .keys()
            .cloned()
            .chain(self.local_selected.iter().cloned())
            .collect();
        let mut updates = Vec::new();
        let mut snapshots_required = Vec::new();
        for run_id in demanded {
            let Some(index) = self.index.get(&run_id) else {
                self.runs.remove(&run_id);
                self.load_errors.remove(&run_id);
                continue;
            };
            let target_revision = index.presentation_revision;
            let previous_revision = self.runs.get(&run_id).map_or(0, |entry| entry.revision);
            if previous_revision == target_revision {
                continue;
            }
            let mut needs_load = previous_revision == 0;
            match self.reader.read_deltas(&run_id, previous_revision) {
                Ok(ViewerDeltaRead::Deltas { deltas, .. }) => {
                    for delta in deltas {
                        if let Some(entry) = self.runs.get_mut(&run_id) {
                            needs_load |= !entry.apply_delta(&delta);
                        }
                        updates.push(ProjectionUpdate {
                            run_id: run_id.clone(),
                            delta,
                        });
                    }
                }
                Ok(ViewerDeltaRead::SnapshotRequired { .. }) | Err(_) => {
                    needs_load = true;
                    snapshots_required.push(run_id.clone());
                }
            }
            needs_load |= self
                .runs
                .get(&run_id)
                .is_none_or(|entry| entry.revision != target_revision);
            if !needs_load {
                continue;
            }
            if self.watched.contains_key(&run_id) {
                let _ = self.load(&run_id);
            } else {
                self.submit_load(&run_id);
            }
        }
        RefreshOutcome {
            updates,
            snapshots_required,
            listing_changed,
        }
    }

    fn submit_load(&mut self, run_id: &str) {
        self.next_generation = self.next_generation.wrapping_add(1);
        let generation = self.next_generation;
        self.pending.insert(run_id.to_string(), generation);
        self.loader.submit(LoadRequest {
            run_id: run_id.to_string(),
            cursor: self.cursors.get(run_id).copied().unwrap_or_default(),
            generation,
        });
    }

    fn load(&mut self, run_id: &str) -> Result<()> {
        let cursor = self.cursors.get(run_id).copied().unwrap_or_default();
        let loaded = match self.reader.read_window(run_id, cursor) {
            Ok(loaded) => loaded,
            Err(error) => {
                self.load_errors
                    .insert(run_id.to_string(), "run data is unavailable".to_string());
                return Err(error);
            }
        };
        self.stats.window_reads += 1;
        self.stats.payload_rows_read += loaded_payload_rows(&loaded);
        match RunEntry::from_loaded(&self.database_path, loaded) {
            Ok(mut entry) => {
                if let Some(layout) = self
                    .runs
                    .get(run_id)
                    .and_then(|current| current.graph_layout.clone())
                {
                    entry.graph_layout = Some(layout);
                }
                self.load_errors.remove(run_id);
                self.runs.insert(run_id.to_string(), entry);
                Ok(())
            }
            Err(error) => {
                self.load_errors
                    .insert(run_id.to_string(), "run data is unavailable".to_string());
                Err(error)
            }
        }
    }

    fn refresh_interruption_clock(&mut self) -> bool {
        let now = Utc::now().timestamp_millis();
        let mut changed = false;
        for row in self.index.values_mut() {
            let next = row.live
                && (row.lease_owner_id.is_none()
                    || row
                        .lease_expires_at
                        .is_none_or(|expires_at| expires_at <= now));
            if next != row.possibly_interrupted {
                row.possibly_interrupted = next;
                if let Some(entry) = self.runs.get_mut(&row.manifest.run_id) {
                    entry.possibly_interrupted = next;
                }
                changed = true;
            }
        }
        changed
    }
}

fn loaded_payload_rows(loaded: &LoadedRun) -> u64 {
    (loaded.state.steps.len()
        + loaded.graph_steps.len()
        + loaded.trace.len()
        + loaded.session_entries.len()
        + loaded.session_events.len()
        + loaded.settings_scopes.len()
        + loaded.state.updates.as_ref().map_or(0, Vec::len)
        + usize::from(loaded.follow_up_queue.is_some())) as u64
}

fn index_changed(
    before: &BTreeMap<String, RunIndexRow>,
    after: &BTreeMap<String, RunIndexRow>,
) -> bool {
    if before.len() != after.len() || before.keys().ne(after.keys()) {
        return true;
    }
    before.iter().any(|(run_id, prior)| {
        after.get(run_id).is_none_or(|next| {
            prior.manifest != next.manifest
                || prior.live != next.live
                || prior.possibly_interrupted != next.possibly_interrupted
        })
    })
}

#[allow(dead_code)]
fn _retain_public_types(
    _binding: Option<SessionBinding>,
    _entries: Vec<SessionEntryRecord>,
    _events: Vec<SessionEventRecord>,
    _capture: Option<SessionCapture>,
) {
}
