//! The run source: reads bundles from a runs directory and maintains one
//! semantic *run view* per run (see docs/live-replay-protocol.md), producing
//! JSON patches as bundles grow. Both the in-process TUI and the WebSocket
//! server consume this; the protocol is just its network form.

use crate::bundle::reader::{list_bundles, read_manifest, BundlePaths};
use crate::bundle::tail::NdjsonTailer;
use crate::bundle::types::{DefinitionSnapshot, Manifest, RunState};
use crate::protocol::PatchOp;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A run whose bundle stopped changing for this long while status is
/// `running` is flagged as possibly interrupted (writer crashed).
const INTERRUPTED_AFTER: Duration = Duration::from_secs(60);

pub struct RunEntry {
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// Bundle documents verbatim, as sent over the wire.
    pub workflow: Value,
    pub state_raw: Value,
    pub events: Vec<Value>,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    /// Typed forms for rendering.
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub revision: u64,
    trace_tailer: NdjsonTailer,
    session_tailer: Option<NdjsonTailer>,
    last_growth: Instant,
}

impl RunEntry {
    fn open(dir: &Path) -> Result<Self> {
        let manifest = read_manifest(dir)?;
        let paths = BundlePaths::from_manifest(dir, &manifest);
        let state_raw: Value = serde_json::from_str(&std::fs::read_to_string(&paths.state)?)?;
        let state: RunState = serde_json::from_value(state_raw.clone())?;
        let workflow: Value = std::fs::read_to_string(&paths.workflow)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let snapshot: Option<DefinitionSnapshot> = serde_json::from_value(workflow.clone()).ok();
        let mut entry = Self {
            dir: dir.to_path_buf(),
            trace_tailer: NdjsonTailer::new(&paths.trace),
            session_tailer: paths.session_entries().map(|path| NdjsonTailer::new(&path)),
            manifest,
            workflow,
            state_raw,
            events: Vec::new(),
            session_binding: None,
            session_entries: Vec::new(),
            state,
            snapshot,
            live: true,
            possibly_interrupted: false,
            revision: 0,
            last_growth: Instant::now(),
        };
        entry.events = entry.trace_tailer.poll().unwrap_or_default();
        entry.read_session_binding();
        if let Some(tailer) = entry.session_tailer.as_mut() {
            entry.session_entries = tailer.poll().unwrap_or_default();
        }
        entry.live = !entry.manifest.status.is_terminal();
        Ok(entry)
    }

    fn read_session_binding(&mut self) {
        if self.session_binding.is_some() {
            return;
        }
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(path) = paths.session_binding() {
            if let Ok(raw) = std::fs::read_to_string(path) {
                self.session_binding = serde_json::from_str(&raw).ok();
            }
        }
        // The session directory can appear after the manifest was first
        // written (it is recorded in manifest.paths from the start), so the
        // tailer may need to be created late.
        if self.session_tailer.is_none() {
            self.session_tailer = paths.session_entries().map(|path| NdjsonTailer::new(&path));
        }
    }

    fn session_value(&self) -> Value {
        match &self.session_binding {
            Some(binding) => json!({
                "binding": binding,
                "entries": self.session_entries,
            }),
            None => Value::Null,
        }
    }

    pub fn view(&self) -> Value {
        json!({
            "manifest": self.manifest,
            "workflow": self.workflow,
            "state": self.state_raw,
            "events": self.events,
            "session": self.session_value(),
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    pub fn summary(&self) -> Value {
        json!({
            "manifest": self.manifest,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    /// Re-read changed files and return the patch from the previous view to
    /// the current one. `None` means nothing changed.
    fn refresh(&mut self) -> Option<Vec<PatchOp>> {
        let mut patch: Vec<PatchOp> = Vec::new();

        let new_events = self.trace_tailer.poll().unwrap_or_default();
        if !new_events.is_empty() {
            patch.push(PatchOp::Append {
                path: "/events".into(),
                value: new_events.clone(),
            });
            self.events.extend(new_events);
        }

        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Ok(raw) = std::fs::read_to_string(&paths.state) {
            if let Ok(state_raw) = serde_json::from_str::<Value>(&raw) {
                if state_raw != self.state_raw {
                    if let Ok(state) = serde_json::from_value::<RunState>(state_raw.clone()) {
                        self.state = state;
                        self.state_raw = state_raw;
                        patch.push(PatchOp::Replace {
                            path: "/state".into(),
                            value: self.state_raw.clone(),
                        });
                    }
                }
            }
        }
        if let Ok(manifest) = read_manifest(&self.dir) {
            if manifest != self.manifest {
                self.manifest = manifest;
                patch.push(PatchOp::Replace {
                    path: "/manifest".into(),
                    value: serde_json::to_value(&self.manifest).unwrap_or(Value::Null),
                });
            }
        }

        let had_binding = self.session_binding.is_some();
        self.read_session_binding();
        if !had_binding && self.session_binding.is_some() {
            patch.push(PatchOp::Replace {
                path: "/session".into(),
                value: self.session_value(),
            });
        } else if let Some(tailer) = self.session_tailer.as_mut() {
            let new_entries: Vec<Value> = tailer.poll().unwrap_or_default();
            if !new_entries.is_empty() {
                self.session_entries.extend(new_entries.clone());
                if self.session_binding.is_some() {
                    patch.push(PatchOp::Append {
                        path: "/session/entries".into(),
                        value: new_entries,
                    });
                }
            }
        }

        if !patch.is_empty() {
            self.last_growth = Instant::now();
        }
        let live = !self.manifest.status.is_terminal();
        if live != self.live {
            self.live = live;
            patch.push(PatchOp::Replace {
                path: "/live".into(),
                value: json!(live),
            });
        }
        let possibly_interrupted = self.live
            && self.state.status == crate::bundle::types::RunStatus::Running
            && self.last_growth.elapsed() >= INTERRUPTED_AFTER;
        if possibly_interrupted != self.possibly_interrupted {
            self.possibly_interrupted = possibly_interrupted;
            patch.push(PatchOp::Replace {
                path: "/possiblyInterrupted".into(),
                value: json!(possibly_interrupted),
            });
        }

        if patch.is_empty() {
            None
        } else {
            self.revision += 1;
            Some(patch)
        }
    }
}

pub struct RunSource {
    runs_dir: PathBuf,
    runs: BTreeMap<String, RunEntry>,
}

/// One refresh round: patches per changed run, and whether the listing
/// (order, membership, summaries) changed.
pub struct RefreshOutcome {
    pub patches: Vec<(String, u64, Vec<PatchOp>)>,
    pub listing_changed: bool,
}

impl RunSource {
    pub fn new(runs_dir: &Path) -> Self {
        let mut source = Self {
            runs_dir: runs_dir.to_path_buf(),
            runs: BTreeMap::new(),
        };
        source.scan();
        source
    }

    /// Open a source for a single bundle directory (no listing).
    pub fn single(bundle_dir: &Path) -> Result<Self> {
        let entry = RunEntry::open(bundle_dir)?;
        let mut runs = BTreeMap::new();
        let run_id = entry.manifest.run_id.clone();
        runs.insert(run_id, entry);
        Ok(Self {
            runs_dir: bundle_dir.to_path_buf(),
            runs,
        })
    }

    pub fn runs_dir(&self) -> &Path {
        &self.runs_dir
    }

    pub fn get(&self, run_id: &str) -> Option<&RunEntry> {
        self.runs.get(run_id)
    }

    /// Run ids ordered newest first (startedAt desc, then run id desc).
    pub fn ordered_run_ids(&self) -> Vec<String> {
        let mut ids: Vec<&RunEntry> = self.runs.values().collect();
        ids.sort_by(|a, b| {
            b.manifest
                .started_at
                .cmp(&a.manifest.started_at)
                .then_with(|| b.manifest.run_id.cmp(&a.manifest.run_id))
        });
        ids.into_iter()
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

    /// Discover new bundles and drop deleted ones. Returns whether the run
    /// listing membership changed.
    pub fn scan(&mut self) -> bool {
        let found = list_bundles(&self.runs_dir);
        let mut changed = false;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (dir, manifest) in found {
            seen.insert(manifest.run_id.clone());
            if !self.runs.contains_key(&manifest.run_id) {
                if let Ok(entry) = RunEntry::open(&dir) {
                    self.runs.insert(manifest.run_id.clone(), entry);
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

    /// Rescan and refresh every run, collecting patches.
    pub fn refresh_all(&mut self) -> RefreshOutcome {
        let mut listing_changed = self.scan();
        let mut patches = Vec::new();
        for (run_id, entry) in self.runs.iter_mut() {
            let live_before = entry.live;
            let interrupted_before = entry.possibly_interrupted;
            let status_before = entry.manifest.status;
            if let Some(patch) = entry.refresh() {
                patches.push((run_id.clone(), entry.revision, patch));
                if entry.live != live_before
                    || entry.possibly_interrupted != interrupted_before
                    || entry.manifest.status != status_before
                {
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
