//! The run source: reads bundles from a runs directory and maintains one
//! semantic *run view* per run (see docs/live-replay-protocol.md), producing
//! JSON patches as bundles grow. Both the in-process TUI and the WebSocket
//! server consume this; the protocol is just its network form.

use crate::bundle::reader::{list_bundles, read_manifest_value, BundlePaths};
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
    /// Bundle documents verbatim, as sent over the wire. The raw manifest is
    /// kept beside the typed one because views must carry it unmodified,
    /// including forward-compatible fields this build does not know about.
    pub manifest_raw: Value,
    pub workflow: Value,
    pub state_raw: Value,
    pub events: Vec<Value>,
    /// Tailed trace events whose `seq` is still ahead of `state.traceSeq`
    /// (the writer appends the trace before rewriting the state).
    pending_events: Vec<Value>,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    pub session_events: Vec<Value>,
    pub session_capture: Option<Value>,
    /// Typed forms for rendering.
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub revision: u64,
    trace_tailer: NdjsonTailer,
    session_tailer: Option<NdjsonTailer>,
    session_event_tailer: Option<NdjsonTailer>,
    last_growth: Instant,
}

/// Parse and schema-check a state document; unsupported schemas are
/// rejected so incompatible layouts never render.
fn parse_state(raw: &str) -> Option<(Value, RunState)> {
    let state_raw: Value = serde_json::from_str(raw).ok()?;
    let state: RunState = serde_json::from_value(state_raw.clone()).ok()?;
    if state.schema != crate::bundle::types::RUN_STATE_SCHEMA {
        return None;
    }
    Some((state_raw, state))
}

/// The instant corresponding to the newest modification time among the
/// bundle's mutable files, so a run that stalled before we started watching
/// is flagged as possibly interrupted immediately.
fn last_write_instant(paths: &BundlePaths) -> Instant {
    // Appends to files inside session/ do not bump the directory mtime, so
    // the session documents are listed individually: a run mid-conversation
    // must not open as possibly interrupted.
    let newest = [
        Some(paths.state.clone()),
        Some(paths.trace.clone()),
        paths.session_binding(),
        paths.session_entries(),
        paths.session_events(),
        paths.session_capture(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path| std::fs::metadata(path).ok())
    .filter_map(|metadata| metadata.modified().ok())
    .max();
    let age = newest
        .and_then(|mtime| std::time::SystemTime::now().duration_since(mtime).ok())
        .unwrap_or_default();
    Instant::now().checked_sub(age).unwrap_or_else(Instant::now)
}

impl RunEntry {
    fn open(dir: &Path) -> Result<Self> {
        let (manifest_raw, manifest) = read_manifest_value(dir)?;
        let paths = BundlePaths::from_manifest(dir, &manifest);
        let state_text = crate::bundle::reader::read_contained(dir, &paths.state)
            .ok_or_else(|| anyhow::anyhow!("unreadable state in {}", dir.display()))?;
        let (state_raw, state) = parse_state(&state_text)
            .ok_or_else(|| anyhow::anyhow!("unsupported state schema in {}", dir.display()))?;
        let workflow: Value = crate::bundle::reader::read_contained(dir, &paths.workflow)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let snapshot: Option<DefinitionSnapshot> = serde_json::from_value(workflow.clone())
            .ok()
            .filter(|snapshot: &DefinitionSnapshot| {
                snapshot.schema == crate::bundle::types::DEFINITION_SNAPSHOT_SCHEMA
            });
        let last_growth = last_write_instant(&paths);
        let mut entry = Self {
            dir: dir.to_path_buf(),
            trace_tailer: NdjsonTailer::contained(&paths.trace, dir),
            session_tailer: paths
                .session_entries()
                .map(|path| NdjsonTailer::contained(&path, dir)),
            session_event_tailer: paths
                .session_events()
                .map(|path| NdjsonTailer::contained(&path, dir)),
            manifest,
            manifest_raw,
            workflow,
            state_raw,
            events: Vec::new(),
            pending_events: Vec::new(),
            session_binding: None,
            session_entries: Vec::new(),
            session_events: Vec::new(),
            session_capture: None,
            state,
            snapshot,
            live: true,
            possibly_interrupted: false,
            revision: 0,
            last_growth,
        };
        entry.pending_events = entry.trace_tailer.poll().unwrap_or_default();
        entry.events = entry.drain_ready_events();
        entry.read_session_binding();
        if let Some(tailer) = entry.session_tailer.as_mut() {
            entry.session_entries = tailer.poll().unwrap_or_default();
        }
        if let Some(tailer) = entry.session_event_tailer.as_mut() {
            entry.session_events = tailer.poll().unwrap_or_default();
        }
        entry.read_session_capture();
        entry.live = !entry.settled();
        entry.possibly_interrupted = entry.live
            && entry.state.status == crate::bundle::types::RunStatus::Running
            && entry.last_growth.elapsed() >= INTERRUPTED_AFTER;
        Ok(entry)
    }

    /// A bundle is settled (immutable, safe to stop watching) only when the
    /// terminal status has propagated through every document we track: a
    /// terminal manifest alone can race a refresh that still holds the old
    /// state or an undrained trace tail. The tail must also have reached the
    /// state's `traceSeq`: the final append can land between our trace poll
    /// and the terminal state read, and settling then would lose it.
    fn settled(&self) -> bool {
        let capture_settled = self.session_binding.is_none()
            || self.session_capture.as_ref().is_some_and(|capture| {
                matches!(
                    capture.get("status").and_then(Value::as_str),
                    Some("complete" | "failed")
                )
            });
        self.manifest.status.is_terminal()
            && self.state.status.is_terminal()
            && self.pending_events.is_empty()
            && self.last_seen_seq() >= self.state.trace_seq
            && capture_settled
    }

    /// Highest trace sequence this entry has observed (published or pending).
    fn last_seen_seq(&self) -> u64 {
        self.pending_events
            .last()
            .or_else(|| self.events.last())
            .and_then(|event| event.get("seq").and_then(Value::as_u64))
            .unwrap_or(0)
    }

    /// Take the pending trace events whose `seq` the state projection has
    /// caught up with. Publishing a trace tail ahead of its state would make
    /// the panes disagree mid-transition (trace is written first).
    fn drain_ready_events(&mut self) -> Vec<Value> {
        let ready_count = self
            .pending_events
            .iter()
            .take_while(|event| {
                event
                    .get("seq")
                    .and_then(Value::as_u64)
                    .is_none_or(|seq| seq <= self.state.trace_seq)
            })
            .count();
        self.pending_events.drain(..ready_count).collect()
    }

    fn read_session_binding(&mut self) {
        if self.session_binding.is_some() {
            return;
        }
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(path) = paths.session_binding() {
            if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &path) {
                self.session_binding = serde_json::from_str(&raw).ok();
            }
        }
        // The session directory can appear after the manifest was first
        // written (it is recorded in manifest.paths from the start), so the
        // tailer may need to be created late.
        if self.session_tailer.is_none() {
            self.session_tailer = paths
                .session_entries()
                .map(|path| NdjsonTailer::contained(&path, &self.dir));
        }
        if self.session_event_tailer.is_none() {
            self.session_event_tailer = paths
                .session_events()
                .map(|path| NdjsonTailer::contained(&path, &self.dir));
        }
    }

    fn read_session_capture(&mut self) {
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(path) = paths.session_capture() {
            if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &path) {
                self.session_capture = serde_json::from_str(&raw).ok();
            }
        }
    }

    fn session_value(&self) -> Value {
        match &self.session_binding {
            Some(binding) => json!({
                "binding": binding,
                "entries": self.session_entries,
                "events": self.session_events,
                "capture": self.session_capture,
            }),
            None => Value::Null,
        }
    }

    pub fn view(&self) -> Value {
        json!({
            "manifest": self.manifest_raw,
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
            "manifest": self.manifest_raw,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    /// Re-read changed files and return the patch from the previous view to
    /// the current one. `None` means nothing changed.
    fn refresh(&mut self) -> Option<Vec<PatchOp>> {
        let mut patch: Vec<PatchOp> = Vec::new();

        // Tail the trace first, but publish only after the state below has
        // been re-read: events past `state.traceSeq` wait in `pending_events`
        // so a mid-transition read never shows a trace tail ahead of the
        // projection.
        let newly_polled = self.trace_tailer.poll().unwrap_or_default();
        let mut trace_grew = !newly_polled.is_empty();
        self.pending_events.extend(newly_polled);

        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &paths.state) {
            if let Some((state_raw, state)) = parse_state(&raw) {
                if state_raw != self.state_raw {
                    self.state = state;
                    self.state_raw = state_raw;
                    patch.push(PatchOp::Replace {
                        path: "/state".into(),
                        value: self.state_raw.clone(),
                    });
                }
            }
        }
        // The writer appends the trace before rewriting the state, so a
        // freshly read state can reference sequences that landed after the
        // poll above; re-poll rather than wait for a change notification the
        // finished writer will never produce again.
        if self.state.status.is_terminal() && self.last_seen_seq() < self.state.trace_seq {
            let late = self.trace_tailer.poll().unwrap_or_default();
            trace_grew = trace_grew || !late.is_empty();
            self.pending_events.extend(late);
        }
        let ready_events = self.drain_ready_events();
        if !ready_events.is_empty() {
            patch.push(PatchOp::Append {
                path: "/events".into(),
                value: ready_events.clone(),
            });
            self.events.extend(ready_events);
        }
        if let Ok((manifest_raw, manifest)) = read_manifest_value(&self.dir) {
            // Compare the raw document: a change confined to a field this
            // build does not know must still produce a patch.
            if manifest_raw != self.manifest_raw {
                self.manifest = manifest;
                self.manifest_raw = manifest_raw;
                patch.push(PatchOp::Replace {
                    path: "/manifest".into(),
                    value: self.manifest_raw.clone(),
                });
            }
        }

        let had_binding = self.session_binding.is_some();
        let previous_capture = self.session_capture.clone();
        self.read_session_binding();
        // Tail session journals before publishing a newly discovered binding,
        // so the first session value is already internally consistent.
        let new_entries: Vec<Value> = self
            .session_tailer
            .as_mut()
            .map(|tailer| tailer.poll().unwrap_or_default())
            .unwrap_or_default();
        let new_session_events: Vec<Value> = self
            .session_event_tailer
            .as_mut()
            .map(|tailer| tailer.poll().unwrap_or_default())
            .unwrap_or_default();
        let session_grew = !new_entries.is_empty() || !new_session_events.is_empty();
        self.session_entries.extend(new_entries.clone());
        self.session_events.extend(new_session_events.clone());
        self.read_session_capture();
        let capture_changed = self.session_capture != previous_capture;
        if !had_binding && self.session_binding.is_some() {
            patch.push(PatchOp::Replace {
                path: "/session".into(),
                value: self.session_value(),
            });
        } else if self.session_binding.is_some() {
            if !new_entries.is_empty() {
                patch.push(PatchOp::Append {
                    path: "/session/entries".into(),
                    value: new_entries,
                });
            }
            if !new_session_events.is_empty() {
                patch.push(PatchOp::Append {
                    path: "/session/events".into(),
                    value: new_session_events,
                });
            }
            if capture_changed {
                patch.push(PatchOp::Replace {
                    path: "/session/capture".into(),
                    value: self.session_capture.clone().unwrap_or(Value::Null),
                });
            }
        }

        if !patch.is_empty() || trace_grew || session_grew || capture_changed {
            self.last_growth = Instant::now();
        }
        let live = !self.settled();
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
    /// Single-bundle mode: `runs_dir` is the bundle itself, so directory
    /// scanning must not run (it would treat the bundle as an empty listing
    /// and drop the run).
    single: bool,
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
            single: false,
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
            single: true,
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
    /// listing membership changed. No-op in single-bundle mode.
    pub fn scan(&mut self) -> bool {
        if self.single {
            return false;
        }
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
            // Terminal bundles are immutable per the format contract; stop
            // re-reading them (discovery of new runs still happens above).
            if !entry.live {
                continue;
            }
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
