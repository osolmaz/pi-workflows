//! Database-backed run views for the local TUI and replay server.

use crate::protocol::PatchOp;
use crate::state::reader::{list_runs, read_run, LoadedRun};
use crate::state::types::{
    DefinitionSnapshot, Manifest, RunState, SessionBinding, SessionCapture, SessionEntryRecord,
    SessionEventRecord,
};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct RunEntry {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub manifest_raw: Value,
    pub workflow: Value,
    pub state_raw: Value,
    pub events: Vec<Value>,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    pub session_events: Vec<Value>,
    pub session_events_malformed: bool,
    pub session_events_torn_tail: bool,
    pub session_capture: Option<Value>,
    pub settings_scopes: Vec<Value>,
    pub follow_up_queue: Option<Value>,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub revision: u64,
}

impl RunEntry {
    pub fn open(database_path: &Path, run_id: &str) -> Result<Self> {
        Self::from_loaded(database_path, read_run(database_path, run_id)?, 1)
    }

    fn from_loaded(database_path: &Path, loaded: LoadedRun, revision: u64) -> Result<Self> {
        let manifest_raw = serde_json::to_value(&loaded.manifest)?;
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
            state_raw,
            events,
            session_binding,
            session_entries,
            session_events,
            session_events_malformed: false,
            session_events_torn_tail: false,
            session_capture,
            settings_scopes: loaded.settings_scopes,
            follow_up_queue: loaded.follow_up_queue,
            state: loaded.state,
            snapshot: loaded.snapshot,
            live,
            possibly_interrupted: loaded.possibly_interrupted,
            revision,
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
                "entries": self.session_entries,
                "events": self.session_events,
                "eventsMalformed": self.session_events_malformed,
                "eventsTornTail": self.session_events_torn_tail,
                "capture": self.session_capture,
            })
        }
    }

    pub fn view(&self) -> Value {
        json!({
            "manifest": self.manifest_raw,
            "workflow": self.workflow,
            "state": self.state_raw,
            "events": self.events,
            "session": self.session_value(),
            "settingsScopes": self.settings_scopes,
            "followUpQueue": self.follow_up_queue,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    pub fn summary(&self) -> Value {
        json!({
            "manifest": self.manifest_raw,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    fn refresh(&mut self) -> Option<Vec<PatchOp>> {
        let next = RunEntry::open(&self.dir, &self.manifest.run_id).ok()?;
        let old_view = self.view();
        let next_view = next.view();
        if old_view == next_view {
            return None;
        }
        let revision = self.revision + 1;
        *self = Self { revision, ..next };
        let mut patch = Vec::new();
        for key in [
            "manifest",
            "workflow",
            "state",
            "events",
            "session",
            "live",
            "possiblyInterrupted",
        ] {
            if old_view.get(key) != next_view.get(key) {
                patch.push(PatchOp::Replace {
                    path: format!("/{key}"),
                    value: next_view.get(key).cloned().unwrap_or(Value::Null),
                });
            }
        }
        Some(patch)
    }
}

pub struct RunSource {
    database_path: PathBuf,
    runs: BTreeMap<String, RunEntry>,
    single_run_id: Option<String>,
}

pub struct RefreshOutcome {
    pub patches: Vec<(String, u64, Vec<PatchOp>)>,
    pub listing_changed: bool,
}

impl RunSource {
    pub fn new(database_path: &Path) -> Result<Self> {
        crate::state::reader::validate_database(database_path)?;
        let mut source = Self {
            database_path: database_path.to_path_buf(),
            runs: BTreeMap::new(),
            single_run_id: None,
        };
        source.scan();
        Ok(source)
    }

    pub fn single(database_path: &Path, run_id: &str) -> Result<Self> {
        let entry = RunEntry::open(database_path, run_id)?;
        let mut runs = BTreeMap::new();
        runs.insert(run_id.to_string(), entry);
        Ok(Self {
            database_path: database_path.to_path_buf(),
            runs,
            single_run_id: Some(run_id.to_string()),
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn get(&self, run_id: &str) -> Option<&RunEntry> {
        self.runs.get(run_id)
    }

    pub fn ordered_run_ids(&self) -> Vec<String> {
        let mut entries: Vec<&RunEntry> = self.runs.values().collect();
        entries.sort_by(|a, b| {
            b.manifest
                .started_at
                .cmp(&a.manifest.started_at)
                .then_with(|| b.manifest.run_id.cmp(&a.manifest.run_id))
        });
        entries
            .into_iter()
            .map(|entry| entry.manifest.run_id.clone())
            .collect()
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.ordered_run_ids()
            .iter()
            .filter_map(|id| self.runs.get(id))
            .map(RunEntry::summary)
            .collect()
    }

    pub fn scan(&mut self) -> bool {
        if self.single_run_id.is_some() {
            return false;
        }
        let found = list_runs(&self.database_path);
        let mut changed = false;
        let mut seen = std::collections::HashSet::new();
        for (run_id, _) in found {
            seen.insert(run_id.clone());
            if !self.runs.contains_key(&run_id) {
                if let Ok(entry) = RunEntry::open(&self.database_path, &run_id) {
                    self.runs.insert(run_id, entry);
                    changed = true;
                }
            }
        }
        let stale: Vec<String> = self
            .runs
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in stale {
            self.runs.remove(&id);
            changed = true;
        }
        changed
    }

    pub fn refresh_all(&mut self) -> RefreshOutcome {
        let mut listing_changed = self.scan();
        let mut patches = Vec::new();
        for (run_id, entry) in &mut self.runs {
            let live_before = entry.live;
            if let Some(patch) = entry.refresh() {
                patches.push((run_id.clone(), entry.revision, patch));
                if live_before != entry.live {
                    listing_changed = true;
                }
            }
        }
        RefreshOutcome {
            patches,
            listing_changed,
        }
    }
}

#[allow(dead_code)]
fn _retain_public_types(
    _binding: Option<SessionBinding>,
    _entries: Vec<SessionEntryRecord>,
    _events: Vec<SessionEventRecord>,
    _capture: Option<SessionCapture>,
) {
}
