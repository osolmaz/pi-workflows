//! WebSocket client for remote mode (`piw --connect ws://…`). A background
//! task owns the connection and maintains raw run views by applying the
//! snapshot/patch stream; the UI reads a shared, typed projection.

use crate::bundle::types::{DefinitionSnapshot, Manifest, RunState};
use crate::protocol::{apply_patch, ClientMessage, ServerMessage, PROTOCOL_ID};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// A run view decoded for rendering, refreshed whenever the revision moves.
pub struct RemoteView {
    pub revision: u64,
    pub manifest: Manifest,
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub events: Vec<Value>,
    pub session_entries: Vec<Value>,
    pub live: bool,
    pub possibly_interrupted: bool,
}

fn decode_view(revision: u64, raw: &Value) -> Option<RemoteView> {
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
    let session_entries = raw
        .pointer("/session/entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(RemoteView {
        revision,
        manifest,
        state,
        snapshot,
        events,
        session_entries,
        live: raw.get("live").and_then(Value::as_bool).unwrap_or(false),
        possibly_interrupted: raw
            .get("possiblyInterrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[derive(Default)]
struct Shared {
    connected: bool,
    error: Option<String>,
    summaries: Vec<Value>,
    raw_views: HashMap<String, (u64, Value)>,
}

pub struct RemoteRuns {
    shared: Arc<Mutex<Shared>>,
    commands: mpsc::UnboundedSender<ClientMessage>,
    /// Typed cache, refreshed when a view's revision changes.
    decoded: HashMap<String, RemoteView>,
    watched: HashSet<String>,
}

impl RemoteRuns {
    pub fn connect(url: &str) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let task_shared = Arc::clone(&shared);
        let url = url.to_string();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(async move {
                if let Err(error) = run_connection(&url, task_shared.clone(), commands_rx).await {
                    let mut shared = task_shared.lock().unwrap();
                    shared.connected = false;
                    shared.error = Some(format!("{error:#}"));
                }
            });
        });
        commands_tx
            .send(ClientMessage::WatchRuns)
            .context("queueing watch_runs")?;
        Ok(Self {
            shared,
            commands: commands_tx,
            decoded: HashMap::new(),
            watched: HashSet::new(),
        })
    }

    pub fn connected(&self) -> bool {
        self.shared.lock().unwrap().connected
    }

    pub fn error(&self) -> Option<String> {
        self.shared.lock().unwrap().error.clone()
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.shared.lock().unwrap().summaries.clone()
    }

    /// Subscribe to a run, replacing any previous subscription: the UI shows
    /// one run at a time, and keeping old subscriptions alive would stream
    /// (and retain) every previously selected run's history forever.
    pub fn watch(&mut self, run_id: &str) {
        if self.watched.contains(run_id) {
            return;
        }
        let previous: Vec<String> = self.watched.drain().collect();
        for old in previous {
            let _ = self.commands.send(ClientMessage::UnwatchRun {
                run_id: old.clone(),
            });
            self.decoded.remove(&old);
            self.shared.lock().unwrap().raw_views.remove(&old);
        }
        self.watched.insert(run_id.to_string());
        let _ = self.commands.send(ClientMessage::WatchRun {
            run_id: run_id.to_string(),
        });
    }

    /// The typed view for a run, refreshed from the raw view when its
    /// revision changed since the last call.
    pub fn view(&mut self, run_id: &str) -> Option<&RemoteView> {
        let raw = {
            let shared = self.shared.lock().unwrap();
            let (revision, raw) = shared.raw_views.get(run_id)?;
            let cached = self.decoded.get(run_id);
            if cached.is_some_and(|view| view.revision == *revision) {
                None
            } else {
                Some((*revision, raw.clone()))
            }
        };
        if let Some((revision, raw)) = raw {
            if let Some(view) = decode_view(revision, &raw) {
                self.decoded.insert(run_id.to_string(), view);
            }
        }
        self.decoded.get(run_id)
    }
}

async fn run_connection(
    url: &str,
    shared: Arc<Mutex<Shared>>,
    mut commands: mpsc::UnboundedReceiver<ClientMessage>,
) -> Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let (mut sink, mut reads) = ws.split();
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                let text = serde_json::to_string(&command)?;
                sink.send(Message::Text(text.into())).await?;
            }
            incoming = reads.next() => {
                let Some(incoming) = incoming else { break };
                let text = match incoming? {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else {
                    continue;
                };
                // Apply under the lock, then send any follow-up requests
                // after the guard is dropped.
                let resubscribe: Option<String> = {
                    let mut shared = shared.lock().unwrap();
                    match message {
                        ServerMessage::Hello { protocol } => {
                            if protocol != PROTOCOL_ID {
                                anyhow::bail!("unsupported protocol {protocol}");
                            }
                            shared.connected = true;
                            None
                        }
                        ServerMessage::Runs { runs } => {
                            shared.summaries = runs;
                            None
                        }
                        ServerMessage::RunSnapshot { run_id, revision, view } => {
                            shared.raw_views.insert(run_id, (revision, view));
                            None
                        }
                        ServerMessage::RunPatch { run_id, revision, patch } => {
                            match shared.raw_views.get_mut(&run_id) {
                                Some((current, view)) if revision == *current + 1 => {
                                    match apply_patch(view, &patch) {
                                        Ok(()) => {
                                            *current = revision;
                                            None
                                        }
                                        Err(_) => Some(run_id),
                                    }
                                }
                                // Revision gap: take a fresh snapshot.
                                Some(_) => Some(run_id),
                                // A patch for a run we no longer track raced
                                // an unwatch; resubscribing would undo it.
                                None => None,
                            }
                        }
                        ServerMessage::Artifact { .. } => None,
                        ServerMessage::Error { message, .. } => {
                            shared.error = Some(message);
                            None
                        }
                    }
                };
                if let Some(run_id) = resubscribe {
                    // Gap or bad patch: take a fresh snapshot.
                    let text = serde_json::to_string(&ClientMessage::WatchRun { run_id })?;
                    sink.send(Message::Text(text.into())).await?;
                }
            }
        }
    }
    // A clean close (server restart, network drop) must not leave a stale
    // view looking current: record why updates stopped.
    let mut shared = shared.lock().unwrap();
    shared.connected = false;
    if shared.error.is_none() {
        shared.error = Some("connection closed".to_string());
    }
    Ok(())
}
