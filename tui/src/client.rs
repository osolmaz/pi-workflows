//! Reconnecting WebSocket client for remote mode (`piw --connect ws://…`).
//! The background task treats subscriptions and artifact requests as desired
//! state, so reconnects cannot replay stale commands.

use crate::bundle::types::{DefinitionSnapshot, Manifest, RunState};
use crate::protocol::{apply_patch, ClientMessage, ServerMessage, PROTOCOL_ID};
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
    generation: u64,
    pub manifest: Manifest,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub events: Vec<Value>,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    pub session_events: Vec<Value>,
    pub session_capture: Option<Value>,
    pub live: bool,
    pub possibly_interrupted: bool,
}

fn decode_view(revision: u64, generation: u64, raw: &Value) -> Option<RemoteView> {
    let manifest: Manifest = serde_json::from_value(raw.get("manifest")?.clone()).ok()?;
    let state: RunState = serde_json::from_value(raw.get("state")?.clone()).ok()?;
    let snapshot: Option<DefinitionSnapshot> = raw
        .get("workflow")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let events = raw
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_binding = raw.pointer("/session/binding").cloned();
    let session_entries = raw
        .pointer("/session/entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_events = raw
        .pointer("/session/events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_capture = raw.pointer("/session/capture").cloned();
    Some(RemoteView {
        revision,
        generation,
        manifest,
        state,
        snapshot,
        events,
        session_binding,
        session_entries,
        session_events,
        session_capture,
        live: raw.get("live").and_then(Value::as_bool).unwrap_or(false),
        possibly_interrupted: raw
            .get("possiblyInterrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
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
            shared.watched.insert(run_id.to_string());
            previous
        };
        for old in previous {
            self.decoded.remove(&old);
        }
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
                    ServerMessage::RunPatch { run_id, revision, patch } => {
                        let mut state = shared.lock().unwrap();
                        match state.raw_views.get_mut(&run_id) {
                            Some((current, _, view)) if revision == *current + 1 => {
                                if apply_patch(view, &patch).is_ok() {
                                    *current = revision;
                                } else {
                                    resubscribe = Some(run_id);
                                }
                            }
                            Some(_) => resubscribe = Some(run_id),
                            None => {}
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
                    ).await?;
                }
                if let Some(run_id) = resubscribe {
                    send_message(&mut sink, &ClientMessage::WatchRun { run_id }).await?;
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
) -> Result<()> {
    let (desired, artifacts) = {
        let state = shared.lock().unwrap();
        let desired = state.watched.clone();
        let artifacts = state
            .artifacts
            .iter()
            .filter_map(|(key, entry)| {
                matches!(entry, ArtifactEntry::Loading).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        (desired, artifacts)
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
    }
    for run_id in additions {
        send_message(
            sink,
            &ClientMessage::WatchRun {
                run_id: run_id.clone(),
            },
        )
        .await?;
        subscribed.insert(run_id);
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
