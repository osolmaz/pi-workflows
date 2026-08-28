//! Reconnecting WebSocket client for remote mode (`piw --connect ws://…`).
//! The background task treats subscriptions and artifact requests as desired
//! state, so reconnects cannot replay stale commands.

use crate::layout::{layout_graph, GraphLayout};
use crate::protocol::{
    apply_patch, ClientMessage, PageKind, ServerMessage, TargetPatch, PROTOCOL_ID,
};
use crate::state::types::{DefinitionSnapshot, Manifest, RunState, StepRecord};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub struct RemoteView {
    pub revision: u64,
    pub graph_revision: u64,
    generation: u64,
    pub manifest: Manifest,
    pub state: RunState,
    pub graph_steps: Vec<StepRecord>,
    pub taken_transitions: Vec<String>,
    pub graph_cursor: u64,
    pub step_start: u64,
    pub step_total: u64,
    pub snapshot: Option<DefinitionSnapshot>,
    pub graph_layout: Option<GraphLayout>,
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
    pub live: bool,
    pub possibly_interrupted: bool,
}

fn decode_view(revision: u64, generation: u64, raw: &Value) -> Option<RemoteView> {
    let graph_revision = raw
        .get("graphRevision")
        .and_then(Value::as_u64)
        .unwrap_or(revision);
    let manifest: Manifest = serde_json::from_value(raw.get("manifest")?.clone()).ok()?;
    let state: RunState = serde_json::from_value(raw.get("state")?.clone()).ok()?;
    let graph_steps = raw
        .get("graphSteps")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_else(|| state.steps.clone());
    let taken_transitions = raw
        .get("takenTransitions")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let graph_cursor = raw
        .get("graphCursor")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| state.steps.len().saturating_sub(1) as u64);
    let step_start = raw.get("stepStart").and_then(Value::as_u64).unwrap_or(0);
    let step_total = raw
        .get("stepTotal")
        .and_then(Value::as_u64)
        .unwrap_or(state.steps.len() as u64);
    let snapshot: Option<DefinitionSnapshot> = raw
        .get("workflow")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let graph_layout = raw
        .get("graphScene")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .or_else(|| snapshot.as_ref().map(layout_graph));
    let events = raw
        .pointer("/tracePage/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let trace_start = raw
        .pointer("/tracePage/start")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let trace_total = raw
        .pointer("/tracePage/total")
        .and_then(Value::as_u64)
        .unwrap_or(events.len() as u64);
    let session_binding = raw.pointer("/session/binding").cloned();
    let session_entries = raw
        .pointer("/session/entryPage/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_entry_start = raw
        .pointer("/session/entryPage/start")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let session_entry_total = raw
        .pointer("/session/entryPage/total")
        .and_then(Value::as_u64)
        .unwrap_or(session_entries.len() as u64);
    let session_events = raw
        .pointer("/session/eventPage/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_event_start = raw
        .pointer("/session/eventPage/start")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let session_event_total = raw
        .pointer("/session/eventPage/total")
        .and_then(Value::as_u64)
        .unwrap_or(session_events.len() as u64);
    let session_events_malformed = raw
        .pointer("/session/eventsMalformed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_events_torn_tail = raw
        .pointer("/session/eventsTornTail")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_capture = raw.pointer("/session/capture").cloned();
    let session_replay_checkpoint = raw
        .pointer("/session/replayCheckpoint")
        .cloned()
        .filter(|value| !value.is_null());
    let settings_scopes = raw
        .get("settingsScopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let settings_start = raw
        .get("settingsStart")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let settings_total = raw
        .get("settingsTotal")
        .and_then(Value::as_u64)
        .unwrap_or(settings_scopes.len() as u64);
    let follow_up_queue = raw
        .get("followUpQueue")
        .cloned()
        .filter(|value| !value.is_null());
    let follow_up_start = raw
        .get("followUpStart")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let follow_up_total = raw
        .get("followUpTotal")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            follow_up_queue
                .as_ref()
                .and_then(|queue| queue.get("items"))
                .and_then(Value::as_array)
                .map_or(0, |items| items.len() as u64)
        });
    let update_start = raw.get("updateStart").and_then(Value::as_u64).unwrap_or(0);
    let update_total = raw
        .get("updateTotal")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            state
                .updates
                .as_ref()
                .map_or(0, |updates| updates.len() as u64)
        });
    Some(RemoteView {
        revision,
        graph_revision,
        generation,
        manifest,
        state,
        graph_steps,
        taken_transitions,
        graph_cursor,
        step_start,
        step_total,
        snapshot,
        graph_layout,
        events,
        trace_start,
        trace_total,
        session_binding,
        session_entries,
        session_entry_start,
        session_entry_total,
        session_events,
        session_event_start,
        session_event_total,
        session_events_malformed,
        session_events_torn_tail,
        session_capture,
        session_replay_checkpoint,
        settings_scopes,
        settings_start,
        settings_total,
        follow_up_queue,
        follow_up_start,
        follow_up_total,
        update_start,
        update_total,
        live: raw.get("live").and_then(Value::as_bool).unwrap_or(false),
        possibly_interrupted: raw
            .get("possiblyInterrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn apply_target_patches(view: &mut Value, targets: &[TargetPatch]) -> Result<(), String> {
    let mut next = view.clone();
    for target in targets {
        if target.target_key.ends_with(":tail") {
            let pointer = if target.target_type == "timeline" {
                if target.target_key.starts_with("session:") {
                    "/session/eventPage"
                } else {
                    "/tracePage"
                }
            } else if target.target_key.starts_with("entries:") {
                "/session/entryPage"
            } else {
                "/session/eventPage"
            };
            if next.pointer(pointer).is_none_or(|page| !is_tail_page(page)) {
                continue;
            }
        }
        let document = match target.target_type.as_str() {
            "timeline" if target.target_key.starts_with("session:") => {
                next.pointer_mut("/session/eventPage")
            }
            "timeline" => next.pointer_mut("/tracePage"),
            "conversation" if target.target_key.starts_with("entries:") => {
                next.pointer_mut("/session/entryPage")
            }
            "conversation" if target.target_key.starts_with("events:") => {
                next.pointer_mut("/session/eventPage")
            }
            "conversation" => next.pointer_mut("/session"),
            "summary" | "graph" | "replay" | "inspector" => Some(&mut next),
            _ => None,
        }
        .ok_or_else(|| format!("projection target is not loaded: {}", target.target_key))?;
        apply_patch(document, &target.patch)?;
    }
    *view = next;
    Ok(())
}

fn step_reload_cursor(targets: &[TargetPatch], view: &Value) -> Option<u64> {
    targets
        .iter()
        .any(|target| target.target_type == "replay" && target.target_key == "steps:reload")
        .then(|| view.get("stepTotal").and_then(Value::as_u64))
        .flatten()
        .and_then(|total| total.checked_sub(1))
}

fn accept_page_response(
    desired: &mut HashMap<(String, PageKind), u64>,
    submitted: &mut HashMap<(String, PageKind), u64>,
    key: &(String, PageKind),
    cursor: u64,
) -> bool {
    if submitted.get(key) == Some(&cursor) {
        submitted.remove(key);
    }
    match desired.get(key) {
        Some(desired_cursor) if *desired_cursor == cursor => {
            desired.remove(key);
            true
        }
        Some(_) => false,
        None => true,
    }
}

fn is_tail_page(page: &Value) -> bool {
    let Some(start) = page.get("start").and_then(Value::as_u64) else {
        return false;
    };
    let Some(total) = page.get("total").and_then(Value::as_u64) else {
        return false;
    };
    let Some(items) = page.get("items").and_then(Value::as_array) else {
        return false;
    };
    start.saturating_add(items.len() as u64) == total
}

#[derive(Debug, Clone)]
enum ArtifactEntry {
    Loading,
    Ready(String),
    Error(String),
}

#[derive(Default)]
struct Shared {
    connected: bool,
    connecting: bool,
    reconnect_attempt: u32,
    error: Option<String>,
    summaries: Vec<Value>,
    raw_views: HashMap<String, (u64, u64, Value)>,
    next_view_generation: u64,
    watched: HashSet<String>,
    page_requests: HashMap<(String, PageKind), u64>,
    artifacts: HashMap<(String, String), ArtifactEntry>,
}

pub struct RemoteRuns {
    shared: Arc<Mutex<Shared>>,
    wake: Option<mpsc::UnboundedSender<()>>,
    worker: Option<JoinHandle<()>>,
    decoded: HashMap<String, RemoteView>,
}

impl RemoteRuns {
    pub fn connect(url: &str) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared {
            connecting: true,
            ..Shared::default()
        }));
        let (wake_tx, wake_rx) = mpsc::unbounded_channel();
        let task_shared = Arc::clone(&shared);
        let url = url.to_string();
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(run_reconnecting(&url, task_shared, wake_rx));
        });
        let _ = wake_tx.send(());
        Ok(Self {
            shared,
            wake: Some(wake_tx),
            worker: Some(worker),
            decoded: HashMap::new(),
        })
    }

    pub fn connected(&self) -> bool {
        self.shared.lock().unwrap().connected
    }

    pub fn status_label(&self) -> &'static str {
        let shared = self.shared.lock().unwrap();
        if shared.connected {
            "connected"
        } else if shared.reconnect_attempt > 0 {
            "reconnecting"
        } else if shared.connecting {
            "connecting"
        } else {
            "disconnected"
        }
    }

    pub fn error(&self) -> Option<String> {
        self.shared.lock().unwrap().error.clone()
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.shared.lock().unwrap().summaries.clone()
    }

    pub fn watch(&mut self, run_id: &str) {
        let previous: Vec<String> = {
            let mut shared = self.shared.lock().unwrap();
            if shared.watched.len() == 1 && shared.watched.contains(run_id) {
                return;
            }
            let previous: Vec<String> = shared.watched.drain().collect();
            for old in &previous {
                shared.raw_views.remove(old);
            }
            shared
                .page_requests
                .retain(|(candidate, _), _| candidate == run_id);
            shared
                .artifacts
                .retain(|(candidate, _), _| candidate == run_id);
            shared.watched.insert(run_id.to_string());
            previous
        };
        for old in previous {
            self.decoded.remove(&old);
        }
        self.wake();
    }

    pub fn request_page(&self, run_id: &str, kind: PageKind, cursor: u64) {
        self.shared
            .lock()
            .unwrap()
            .page_requests
            .insert((run_id.to_string(), kind), cursor);
        self.wake();
    }

    pub fn request_artifact(&self, run_id: &str, path: &str) {
        let inserted = {
            let mut shared = self.shared.lock().unwrap();
            let key = (run_id.to_string(), path.to_string());
            if let std::collections::hash_map::Entry::Vacant(entry) = shared.artifacts.entry(key) {
                entry.insert(ArtifactEntry::Loading);
                true
            } else {
                false
            }
        };
        if inserted {
            self.wake();
        }
    }

    pub fn artifact_content(&self, run_id: &str, path: &str) -> Option<Result<String, String>> {
        match self
            .shared
            .lock()
            .unwrap()
            .artifacts
            .get(&(run_id.to_string(), path.to_string()))
            .cloned()?
        {
            ArtifactEntry::Loading => None,
            ArtifactEntry::Ready(content) => Some(Ok(content)),
            ArtifactEntry::Error(error) => Some(Err(error)),
        }
    }

    pub fn artifact_snapshot(&self, run_id: &str) -> HashMap<String, Result<String, String>> {
        self.shared
            .lock()
            .unwrap()
            .artifacts
            .iter()
            .filter_map(|((candidate_run, path), entry)| {
                if candidate_run != run_id {
                    return None;
                }
                match entry {
                    ArtifactEntry::Loading => None,
                    ArtifactEntry::Ready(content) => Some((path.clone(), Ok(content.clone()))),
                    ArtifactEntry::Error(error) => Some((path.clone(), Err(error.clone()))),
                }
            })
            .collect()
    }

    pub fn view(&mut self, run_id: &str) -> Option<&RemoteView> {
        let raw = {
            let shared = self.shared.lock().unwrap();
            let (revision, generation, raw) = shared.raw_views.get(run_id)?;
            let cached = self.decoded.get(run_id);
            if cached
                .is_some_and(|view| view.revision == *revision && view.generation == *generation)
            {
                None
            } else {
                Some((*revision, *generation, raw.clone()))
            }
        };
        if let Some((revision, generation, raw)) = raw {
            if let Some(view) = decode_view(revision, generation, &raw) {
                self.decoded.insert(run_id.to_string(), view);
            }
        }
        self.decoded.get(run_id)
    }

    fn wake(&self) {
        if let Some(wake) = &self.wake {
            let _ = wake.send(());
        }
    }
}

impl Drop for RemoteRuns {
    fn drop(&mut self) {
        self.wake.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

async fn run_reconnecting(
    url: &str,
    shared: Arc<Mutex<Shared>>,
    mut wake: mpsc::UnboundedReceiver<()>,
) {
    let mut attempt = 0u32;
    loop {
        {
            let mut shared = shared.lock().unwrap();
            shared.connected = false;
            shared.connecting = true;
            shared.reconnect_attempt = attempt;
        }
        let connection = tokio::select! {
            connection = tokio_tungstenite::connect_async(url) => connection,
            message = wake.recv() => {
                if message.is_none() {
                    return;
                }
                continue;
            }
        };
        match connection {
            Ok((socket, _)) => {
                attempt = 0;
                let result = run_socket(socket, Arc::clone(&shared), &mut wake).await;
                let mut state = shared.lock().unwrap();
                state.connected = false;
                state.connecting = false;
                if state.error.is_none() {
                    state.error = Some(match result {
                        Ok(()) => "connection closed".to_string(),
                        Err(error) => format!("{error:#}"),
                    });
                }
            }
            Err(error) => {
                let mut state = shared.lock().unwrap();
                state.connected = false;
                state.connecting = false;
                state.error = Some(format!("connecting to {url}: {error}"));
            }
        }
        attempt = attempt.saturating_add(1);
        {
            let mut state = shared.lock().unwrap();
            state.reconnect_attempt = attempt;
        }
        let base_ms = (250u64.saturating_mul(1u64 << attempt.min(5))).min(10_000);
        let jitter_ms = (u64::from(attempt).wrapping_mul(137)) % 251;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(base_ms + jitter_ms)) => {}
            message = wake.recv() => {
                if message.is_none() {
                    return;
                }
            }
        }
        if wake.is_closed() {
            return;
        }
    }
}

async fn run_socket(
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    shared: Arc<Mutex<Shared>>,
    wake: &mut mpsc::UnboundedReceiver<()>,
) -> Result<()> {
    let (mut sink, mut reads) = socket.split();
    let mut hello_received = false;
    let mut subscribed = HashSet::new();
    let mut submitted_artifacts = HashSet::new();
    let mut submitted_pages = HashMap::new();

    loop {
        tokio::select! {
            wake_message = wake.recv() => {
                if wake_message.is_none() {
                    return Ok(());
                }
                if hello_received {
                    reconcile_desired(
                        &mut sink,
                        &shared,
                        &mut subscribed,
                        &mut submitted_artifacts,
                        &mut submitted_pages,
                    ).await?;
                }
            }
            incoming = reads.next() => {
                let Some(incoming) = incoming else { return Ok(()) };
                let text = match incoming? {
                    Message::Text(text) => text,
                    Message::Close(_) => return Ok(()),
                    _ => continue,
                };
                let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else {
                    continue;
                };
                let mut resubscribe = None;
                match message {
                    ServerMessage::Hello { protocol } => {
                        if protocol != PROTOCOL_ID {
                            anyhow::bail!("unsupported protocol {protocol}");
                        }
                        {
                            let mut state = shared.lock().unwrap();
                            state.connected = true;
                            state.connecting = false;
                            state.reconnect_attempt = 0;
                            state.error = None;
                        }
                        hello_received = true;
                        send_message(&mut sink, &ClientMessage::WatchRuns).await?;
                        reconcile_desired(
                            &mut sink,
                            &shared,
                            &mut subscribed,
                            &mut submitted_artifacts,
                            &mut submitted_pages,
                        ).await?;
                    }
                    ServerMessage::Runs { runs } => {
                        shared.lock().unwrap().summaries = runs;
                    }
                    ServerMessage::RunSnapshot { run_id, revision, view } => {
                        let mut state = shared.lock().unwrap();
                        if state.watched.contains(&run_id) {
                            state.next_view_generation = state.next_view_generation.wrapping_add(1);
                            let generation = state.next_view_generation;
                            state.raw_views.insert(run_id, (revision, generation, view));
                        }
                    }
                    ServerMessage::RunPatch { run_id, revision, targets } => {
                        let mut state = shared.lock().unwrap();
                        let mut step_cursor = None;
                        match state.raw_views.get_mut(&run_id) {
                            Some((current, _, _)) if revision == *current => {}
                            Some((current, generation, view)) if revision == *current + 1 => {
                                if apply_target_patches(view, &targets).is_ok() {
                                    *current = revision;
                                    *generation = (*generation).wrapping_add(1);
                                    step_cursor = step_reload_cursor(&targets, view);
                                } else {
                                    resubscribe = Some(run_id.clone());
                                }
                            }
                            Some(_) => resubscribe = Some(run_id.clone()),
                            None => {}
                        }
                        if let Some(cursor) = step_cursor {
                            state
                                .page_requests
                                .insert((run_id, PageKind::Steps), cursor);
                        }
                    }
                    ServerMessage::RunPage {
                        run_id,
                        revision,
                        kind,
                        cursor,
                        start,
                        total,
                        items,
                        graph_cursor,
                        graph_steps,
                        taken_transitions,
                        replay_checkpoint,
                    } => {
                        let page_key = (run_id.clone(), kind);
                        let mut state = shared.lock().unwrap();
                        let accepted = accept_page_response(
                            &mut state.page_requests,
                            &mut submitted_pages,
                            &page_key,
                            cursor,
                        );
                        if accepted {
                            if let Some((current, generation, view)) =
                                state.raw_views.get_mut(&run_id)
                            {
                            if revision != *current {
                                resubscribe = Some(run_id);
                            } else {
                                let pointer = match kind {
                                    PageKind::Steps => "/state/steps",
                                    PageKind::Trace | PageKind::TraceAtStep => "/tracePage",
                                    PageKind::SessionEntries => "/session/entryPage",
                                    PageKind::SessionEvents => "/session/eventPage",
                                    PageKind::Settings => "/settingsScopes",
                                    PageKind::FollowUps => "/followUpQueue/items",
                                    PageKind::Updates => "/state/updates",
                                };
                                if let Some(page) = view.pointer_mut(pointer) {
                                    match kind {
                                        PageKind::Steps => {
                                            *page = Value::Array(items);
                                            view["stepStart"] = serde_json::json!(start);
                                            view["stepTotal"] = serde_json::json!(total);
                                            if let Some(cursor) = graph_cursor {
                                                view["graphCursor"] = serde_json::json!(cursor);
                                            }
                                            if let Some(steps) = graph_steps {
                                                view["graphSteps"] = Value::Array(steps);
                                            }
                                            if let Some(transitions) = taken_transitions {
                                                view["takenTransitions"] =
                                                    serde_json::json!(transitions);
                                            }
                                        }
                                        PageKind::Settings => {
                                            *page = Value::Array(items);
                                            view["settingsStart"] = serde_json::json!(start);
                                            view["settingsTotal"] = serde_json::json!(total);
                                        }
                                        PageKind::FollowUps => {
                                            *page = Value::Array(items);
                                            view["followUpStart"] = serde_json::json!(start);
                                            view["followUpTotal"] = serde_json::json!(total);
                                        }
                                        PageKind::Updates => {
                                            *page = Value::Array(items);
                                            view["updateStart"] = serde_json::json!(start);
                                            view["updateTotal"] = serde_json::json!(total);
                                        }
                                        PageKind::Trace
                                        | PageKind::TraceAtStep
                                        | PageKind::SessionEntries
                                        | PageKind::SessionEvents => {
                                            *page = serde_json::json!({
                                                "presentationRevision": revision,
                                                "start": start,
                                                "total": total,
                                                "items": items,
                                            });
                                        }
                                    }
                                    if kind == PageKind::SessionEvents {
                                        if let Some(session) = view
                                            .get_mut("session")
                                            .and_then(Value::as_object_mut)
                                        {
                                            session.insert(
                                                "replayCheckpoint".to_string(),
                                                replay_checkpoint.unwrap_or(Value::Null),
                                            );
                                        }
                                    }
                                    *generation = (*generation).wrapping_add(1);
                                } else {
                                    resubscribe = Some(run_id);
                                }
                            }
                        }
                    }
                    }
                    ServerMessage::Artifact { run_id, path, content } => {
                        let key = (run_id, path);
                        submitted_artifacts.remove(&key);
                        shared
                            .lock()
                            .unwrap()
                            .artifacts
                            .insert(key, ArtifactEntry::Ready(content));
                    }
                    ServerMessage::Error { message, run_id } => {
                        let mut state = shared.lock().unwrap();
                        if let Some(run_id) = run_id {
                            if let Some(key) = submitted_artifacts
                                .iter()
                                .find(|(candidate_run, _)| candidate_run == &run_id)
                                .cloned()
                            {
                                submitted_artifacts.remove(&key);
                                state.artifacts.insert(key, ArtifactEntry::Error(message));
                            } else {
                                state.error = Some(message);
                            }
                        } else {
                            state.error = Some(message);
                        }
                    }
                }
                if hello_received {
                    reconcile_desired(
                        &mut sink,
                        &shared,
                        &mut subscribed,
                        &mut submitted_artifacts,
                        &mut submitted_pages,
                    ).await?;
                }
                if let Some(run_id) = resubscribe {
                    send_message(
                        &mut sink,
                        &ClientMessage::WatchRun {
                            run_id,
                            revision: None,
                            step_cursor: None,
                            trace_cursor: None,
                            session_entry_cursor: None,
                            session_event_cursor: None,
                        },
                    )
                    .await?;
                }
            }
        }
    }
}

async fn reconcile_desired(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    shared: &Arc<Mutex<Shared>>,
    subscribed: &mut HashSet<String>,
    submitted_artifacts: &mut HashSet<(String, String)>,
    submitted_pages: &mut HashMap<(String, PageKind), u64>,
) -> Result<()> {
    let (desired, artifacts, pages) = {
        let state = shared.lock().unwrap();
        let desired = state.watched.clone();
        let artifacts = state
            .artifacts
            .iter()
            .filter_map(|(key, entry)| {
                matches!(entry, ArtifactEntry::Loading).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        let pages = state
            .page_requests
            .iter()
            .map(|(key, cursor)| (key.clone(), *cursor))
            .collect::<Vec<_>>();
        (desired, artifacts, pages)
    };
    let removals: Vec<String> = subscribed.difference(&desired).cloned().collect();
    let additions: Vec<String> = desired.difference(subscribed).cloned().collect();
    for run_id in removals {
        send_message(
            sink,
            &ClientMessage::UnwatchRun {
                run_id: run_id.clone(),
            },
        )
        .await?;
        subscribed.remove(&run_id);
        submitted_pages.retain(|(candidate, _), _| candidate != &run_id);
        submitted_artifacts.retain(|(candidate, _)| candidate != &run_id);
    }
    for run_id in additions {
        let (revision, step_cursor, trace_cursor, session_entry_cursor, session_event_cursor) = {
            let state = shared.lock().unwrap();
            state.raw_views.get(&run_id).map_or(
                (None, None, None, None, None),
                |(revision, _, view)| {
                    (
                        Some(*revision),
                        view.get("stepStart").and_then(Value::as_u64),
                        view.pointer("/tracePage/start").and_then(Value::as_u64),
                        view.pointer("/session/entryPage/start")
                            .and_then(Value::as_u64),
                        view.pointer("/session/eventPage/start")
                            .and_then(Value::as_u64),
                    )
                },
            )
        };
        send_message(
            sink,
            &ClientMessage::WatchRun {
                run_id: run_id.clone(),
                revision,
                step_cursor,
                trace_cursor,
                session_entry_cursor,
                session_event_cursor,
            },
        )
        .await?;
        subscribed.insert(run_id);
    }
    for ((run_id, kind), cursor) in pages {
        let key = (run_id.clone(), kind);
        if submitted_pages.get(&key) != Some(&cursor) {
            submitted_pages.insert(key, cursor);
            send_message(
                sink,
                &ClientMessage::FetchPage {
                    run_id,
                    kind,
                    cursor,
                },
            )
            .await?;
        }
    }
    if submitted_artifacts.is_empty() {
        if let Some((run_id, path)) = artifacts.into_iter().next() {
            let key = (run_id.clone(), path.clone());
            submitted_artifacts.insert(key);
            send_message(sink, &ClientMessage::FetchArtifact { run_id, path }).await?;
        }
    }
    Ok(())
}

async fn send_message(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    message: &ClientMessage,
) -> Result<()> {
    let text = serde_json::to_string(message).context("encoding client message")?;
    sink.send(Message::Text(text.into())).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PatchOp;
    use serde_json::json;

    fn entry_tail_target() -> TargetPatch {
        TargetPatch {
            target_type: "conversation".to_string(),
            target_key: "entries:tail".to_string(),
            patch: vec![
                PatchOp::Replace {
                    path: "/presentationRevision".to_string(),
                    value: json!(2),
                },
                PatchOp::Remove {
                    path: "/items/0".to_string(),
                },
                PatchOp::Append {
                    path: "/items".to_string(),
                    value: vec![json!({"seq": 3})],
                },
                PatchOp::Replace {
                    path: "/start".to_string(),
                    value: json!(1),
                },
                PatchOp::Replace {
                    path: "/total".to_string(),
                    value: json!(3),
                },
            ],
        }
    }

    #[test]
    fn applies_tail_patches_only_to_the_loaded_tail_page() {
        let mut tail = json!({
            "session": {
                "entryPage": {
                    "presentationRevision": 1,
                    "start": 0,
                    "total": 2,
                    "items": [{"seq": 1}, {"seq": 2}]
                }
            }
        });
        apply_target_patches(&mut tail, &[entry_tail_target()]).unwrap();
        assert_eq!(tail.pointer("/session/entryPage/start"), Some(&json!(1)));
        assert_eq!(
            tail.pointer("/session/entryPage/items/1/seq"),
            Some(&json!(3))
        );

        let mut middle = json!({
            "session": {
                "entryPage": {
                    "presentationRevision": 1,
                    "start": 0,
                    "total": 5,
                    "items": [{"seq": 1}, {"seq": 2}]
                }
            }
        });
        let before = middle.clone();
        apply_target_patches(&mut middle, &[entry_tail_target()]).unwrap();
        assert_eq!(middle, before);
    }

    #[test]
    fn a_step_reload_delta_requests_the_latest_step_page() {
        let targets = vec![TargetPatch {
            target_type: "replay".to_string(),
            target_key: "steps:reload".to_string(),
            patch: vec![PatchOp::Replace {
                path: "/stepTotal".to_string(),
                value: json!(12),
            }],
        }];
        assert_eq!(
            step_reload_cursor(&targets, &json!({"stepTotal": 12})),
            Some(11)
        );
        assert_eq!(step_reload_cursor(&targets, &json!({"stepTotal": 0})), None);
    }

    #[test]
    fn an_older_response_cannot_discard_a_newer_page_request() {
        let key = ("run-1".to_string(), PageKind::SessionEvents);
        let mut desired = HashMap::from([(key.clone(), 900)]);
        let mut submitted = HashMap::from([(key.clone(), 900)]);

        assert!(!accept_page_response(
            &mut desired,
            &mut submitted,
            &key,
            800,
        ));
        assert_eq!(desired.get(&key), Some(&900));
        assert_eq!(submitted.get(&key), Some(&900));

        assert!(accept_page_response(
            &mut desired,
            &mut submitted,
            &key,
            900,
        ));
        assert!(!desired.contains_key(&key));
        assert!(!submitted.contains_key(&key));
    }

    #[test]
    fn rejects_a_patch_without_mutating_the_last_good_view() {
        let mut view = json!({"presentationRevision": 1});
        let before = view.clone();
        let result = apply_target_patches(
            &mut view,
            &[TargetPatch {
                target_type: "graph".to_string(),
                target_key: String::new(),
                patch: vec![PatchOp::Replace {
                    path: "/missing/value".to_string(),
                    value: json!(2),
                }],
            }],
        );
        assert!(result.is_err());
        assert_eq!(view, before);
    }
}
