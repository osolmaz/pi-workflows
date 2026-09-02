//! Reconnecting client used by local Unix-socket and remote WebSocket modes.

use crate::layout::{layout_graph, GraphLayout};
use crate::protocol::{
    apply_patch, encode_request, parse_server_message, ClientRequest, PageKind, ServerMessage,
    TargetPatch, PROTOCOL_ID,
};
use crate::state::types::{
    as_artifact_ref, ArtifactRef, DefinitionSnapshot, Manifest, RunState, StepRecord,
};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(unix)]
use tokio::net::UnixStream;
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

fn decode_view(
    revision: u64,
    generation: u64,
    raw: &Value,
    definition_content: Option<&str>,
) -> Option<RemoteView> {
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
    let snapshot: Option<DefinitionSnapshot> = workflow_definition_value(raw, definition_content)
        .and_then(|value| serde_json::from_value(value).ok());
    let graph_layout = raw
        .get("graphScene")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .or_else(|| snapshot.as_ref().map(layout_graph));
    let events = page_items(raw, "/tracePage/items");
    let trace_start = pointer_u64(raw, "/tracePage/start");
    let trace_total = pointer_u64(raw, "/tracePage/total").max(events.len() as u64);
    let session_binding = raw
        .pointer("/session/binding")
        .cloned()
        .filter(|v| !v.is_null());
    let session_entries = page_items(raw, "/session/entryPage/items");
    let session_entry_start = pointer_u64(raw, "/session/entryPage/start");
    let session_entry_total =
        pointer_u64(raw, "/session/entryPage/total").max(session_entries.len() as u64);
    let session_events = page_items(raw, "/session/eventPage/items");
    let session_event_start = pointer_u64(raw, "/session/eventPage/start");
    let session_event_total =
        pointer_u64(raw, "/session/eventPage/total").max(session_events.len() as u64);
    let settings_scopes = raw
        .get("settingsScopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let follow_up_queue = raw.get("followUpQueue").cloned().filter(|v| !v.is_null());
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
        session_events_malformed: raw
            .pointer("/session/integrity/malformed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        session_events_torn_tail: raw
            .pointer("/session/integrity/tornTail")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        session_capture: raw
            .pointer("/session/capture")
            .cloned()
            .filter(|v| !v.is_null()),
        session_replay_checkpoint: raw
            .pointer("/session/replayCheckpoint")
            .cloned()
            .filter(|v| !v.is_null()),
        settings_start: raw
            .get("settingsStart")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        settings_total: raw
            .get("settingsTotal")
            .and_then(Value::as_u64)
            .unwrap_or(settings_scopes.len() as u64),
        settings_scopes,
        follow_up_start: raw
            .get("followUpStart")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        follow_up_total: raw
            .get("followUpTotal")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        follow_up_queue,
        update_start: raw.get("updateStart").and_then(Value::as_u64).unwrap_or(0),
        update_total,
        live: raw.get("live").and_then(Value::as_bool).unwrap_or(false),
        possibly_interrupted: raw
            .get("possiblyInterrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn page_items(raw: &Value, pointer: &str) -> Vec<Value> {
    raw.pointer(pointer)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn pointer_u64(raw: &Value, pointer: &str) -> u64 {
    raw.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

fn workflow_definition_artifact(raw: &Value) -> Option<ArtifactRef> {
    let workflow = raw.get("workflow")?;
    as_artifact_ref(workflow).or_else(|| workflow.get("content").and_then(as_artifact_ref))
}

fn workflow_definition_value(raw: &Value, content: Option<&str>) -> Option<Value> {
    let workflow = raw.get("workflow")?;
    if workflow_definition_artifact(raw).is_some() {
        return serde_json::from_str(content?).ok();
    }
    Some(workflow.clone())
}

fn workflow_definition_content(
    state: &mut Shared,
    run_id: &str,
    raw: &Value,
) -> (Option<String>, bool) {
    let Some(artifact) = workflow_definition_artifact(raw) else {
        return (None, false);
    };
    let key = (run_id.to_string(), artifact.path.clone());
    match state.artifacts.get(&key).cloned() {
        Some(ArtifactEntry::Ready(content)) => {
            let valid = artifact.media_type == "application/json"
                && content.len() as u64 == artifact.bytes
                && hex_sha256(content.as_bytes()) == artifact.sha256;
            if valid {
                return (Some(content), false);
            }
            let error = "workflow definition content does not match its reference".to_string();
            state
                .artifacts
                .insert(key, ArtifactEntry::Error(error.clone()));
            state.error = Some(error);
            (None, false)
        }
        Some(ArtifactEntry::Error(error)) => {
            state.error = Some(format!(
                "workflow definition content is unavailable: {error}"
            ));
            (None, false)
        }
        Some(ArtifactEntry::Loading(_)) => (None, false),
        None => {
            state
                .artifacts
                .insert(key.clone(), ArtifactEntry::Loading(Vec::new()));
            state.content_requests.insert(key, 0);
            (None, true)
        }
    }
}

fn apply_target_patches(view: &mut Value, targets: &[TargetPatch]) -> Result<()> {
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
        .with_context(|| format!("projection target is not loaded: {}", target.target_key))?;
        apply_patch(document, &target.patch).map_err(anyhow::Error::msg)?;
    }
    *view = next;
    Ok(())
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
    Loading(Vec<u8>),
    Ready(String),
    Error(String),
}

struct RunListAssembly {
    revision: String,
    total: u64,
    items: Vec<Value>,
}

#[derive(Default)]
struct Shared {
    connected: bool,
    connecting: bool,
    reconnect_attempt: u32,
    error: Option<String>,
    summaries: Vec<Value>,
    run_list: Option<RunListAssembly>,
    run_list_request: Option<(String, u64)>,
    raw_views: HashMap<String, (u64, u64, u64, Value)>,
    next_view_generation: u64,
    watched: HashSet<String>,
    page_requests: HashMap<(String, PageKind), u64>,
    content_requests: HashMap<(String, String), u64>,
    artifacts: HashMap<(String, String), ArtifactEntry>,
}

#[derive(Clone)]
enum Endpoint {
    WebSocket(String),
    Local(PathBuf),
}

fn discard_run_state(shared: &mut Shared, run_id: &str) {
    shared.raw_views.remove(run_id);
    shared
        .page_requests
        .retain(|(candidate, _), _| candidate != run_id);
    shared
        .content_requests
        .retain(|(candidate, _), _| candidate != run_id);
    shared
        .artifacts
        .retain(|(candidate, _), _| candidate != run_id);
}

pub struct RemoteRuns {
    shared: Arc<Mutex<Shared>>,
    wake: Option<mpsc::UnboundedSender<()>>,
    worker: Option<JoinHandle<()>>,
    decoded: HashMap<String, RemoteView>,
}

impl RemoteRuns {
    pub fn connect(url: &str) -> Result<Self> {
        Self::start(Endpoint::WebSocket(url.to_string()))
    }

    pub fn connect_local(path: &Path) -> Result<Self> {
        Self::start(Endpoint::Local(path.to_path_buf()))
    }

    fn start(endpoint: Endpoint) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared {
            connecting: true,
            ..Shared::default()
        }));
        let (wake_tx, wake_rx) = mpsc::unbounded_channel();
        let task_shared = Arc::clone(&shared);
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(run_reconnecting(endpoint, task_shared, wake_rx));
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
        let mut shared = self.shared.lock().unwrap();
        let old: Vec<String> = shared.watched.drain().collect();
        for old_id in old {
            if old_id != run_id {
                discard_run_state(&mut shared, &old_id);
                self.decoded.remove(&old_id);
            }
        }
        shared.watched.insert(run_id.to_string());
        drop(shared);
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
        let key = (run_id.to_string(), path.to_string());
        let mut shared = self.shared.lock().unwrap();
        if shared.artifacts.contains_key(&key) {
            return;
        }
        shared
            .artifacts
            .insert(key.clone(), ArtifactEntry::Loading(Vec::new()));
        shared.content_requests.insert(key, 0);
        drop(shared);
        self.wake();
    }

    pub fn artifact_snapshot(
        &self,
        run_id: &str,
    ) -> HashMap<String, std::result::Result<String, String>> {
        self.shared
            .lock()
            .unwrap()
            .artifacts
            .iter()
            .filter(|((candidate, _), _)| candidate == run_id)
            .filter_map(|((_, path), entry)| {
                let value = match entry {
                    ArtifactEntry::Loading(_) => return None,
                    ArtifactEntry::Ready(content) => Ok(content.clone()),
                    ArtifactEntry::Error(error) => Err(error.clone()),
                };
                Some((path.clone(), value))
            })
            .collect()
    }

    pub fn view(&mut self, run_id: &str) -> Option<&RemoteView> {
        let raw = self.shared.lock().unwrap().raw_views.get(run_id).cloned();
        let Some((_, revision, generation, raw)) = raw else {
            self.decoded.remove(run_id);
            return None;
        };
        let (definition_content, requested) = {
            let mut shared = self.shared.lock().unwrap();
            workflow_definition_content(&mut shared, run_id, &raw)
        };
        if requested {
            self.wake();
        }
        let stale = self
            .decoded
            .get(run_id)
            .is_none_or(|view| view.generation != generation);
        if stale {
            if let Some(decoded) =
                decode_view(revision, generation, &raw, definition_content.as_deref())
            {
                self.decoded.insert(run_id.to_string(), decoded);
            } else {
                self.decoded.remove(run_id);
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
    endpoint: Endpoint,
    shared: Arc<Mutex<Shared>>,
    mut wake: mpsc::UnboundedReceiver<()>,
) {
    let mut attempt = 0u32;
    loop {
        {
            let mut state = shared.lock().unwrap();
            state.connected = false;
            state.connecting = true;
            state.reconnect_attempt = attempt;
        }
        let result = match &endpoint {
            Endpoint::WebSocket(url) => run_websocket(url, Arc::clone(&shared), &mut wake).await,
            Endpoint::Local(path) => run_local(path, Arc::clone(&shared), &mut wake).await,
        };
        if wake.is_closed() {
            return;
        }
        {
            let mut state = shared.lock().unwrap();
            state.connected = false;
            state.connecting = false;
            state.error = Some(match result {
                Ok(()) => "connection closed".to_string(),
                Err(error) => format!("{error:#}"),
            });
        }
        attempt = attempt.saturating_add(1);
        let delay = (250u64.saturating_mul(1u64 << attempt.min(5))).min(10_000);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
            message = wake.recv() => if message.is_none() { return; }
        }
    }
}

async fn run_websocket(
    url: &str,
    shared: Arc<Mutex<Shared>>,
    wake: &mut mpsc::UnboundedReceiver<()>,
) -> Result<()> {
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let (mut sink, mut stream) = socket.split();
    let mut sent = HashSet::new();
    let mut counter = 0u64;
    loop {
        for request in reconcile_requests(&shared, &mut sent, &mut counter) {
            let text = encode_request(&request).map_err(anyhow::Error::msg)?;
            sink.send(Message::Text(text.into())).await?;
        }
        tokio::select! {
            message = stream.next() => {
                let Some(message) = message else { return Ok(()) };
                match message? {
                    Message::Text(text) => handle_server_message(text.as_ref(), &shared)?,
                    Message::Close(_) => return Ok(()),
                    Message::Ping(payload) => sink.send(Message::Pong(payload)).await?,
                    Message::Pong(_) => {}
                    Message::Binary(_) | Message::Frame(_) => anyhow::bail!("server frame must be text"),
                }
            }
            message = wake.recv() => {
                if message.is_none() { return Ok(()); }
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

async fn run_local(
    path: &Path,
    shared: Arc<Mutex<Shared>>,
    wake: &mut mpsc::UnboundedReceiver<()>,
) -> Result<()> {
    #[cfg(unix)]
    {
        let socket = UnixStream::connect(path)
            .await
            .with_context(|| format!("connecting to workflow host {}", path.display()))?;
        run_local_connection(socket, shared, wake).await
    }
    #[cfg(windows)]
    {
        let socket = ClientOptions::new()
            .open(path)
            .with_context(|| format!("connecting to workflow host {}", path.display()))?;
        run_local_connection(socket, shared, wake).await
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("local workflow host transport is not supported on this platform");
}

async fn run_local_connection<S>(
    socket: S,
    shared: Arc<Mutex<Shared>>,
    wake: &mut mpsc::UnboundedReceiver<()>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(socket);
    let mut lines = BufReader::new(read).lines();
    let mut sent = HashSet::new();
    let mut counter = 0u64;
    loop {
        for request in reconcile_requests(&shared, &mut sent, &mut counter) {
            let text = encode_request(&request).map_err(anyhow::Error::msg)?;
            write.write_all(text.as_bytes()).await?;
            write.write_all(b"\n").await?;
            write.flush().await?;
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                handle_server_message(&line, &shared)?;
            }
            message = wake.recv() => {
                if message.is_none() { return Ok(()); }
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

fn reconcile_requests(
    shared: &Arc<Mutex<Shared>>,
    sent: &mut HashSet<String>,
    counter: &mut u64,
) -> Vec<ClientRequest> {
    let (watched, pages, contents, revisions, run_list_request) = {
        let state = shared.lock().unwrap();
        (
            state.watched.clone(),
            state.page_requests.clone(),
            state.content_requests.clone(),
            state
                .raw_views
                .iter()
                .map(|(run_id, (_, revision, _, _))| (run_id.clone(), *revision))
                .collect::<HashMap<_, _>>(),
            state.run_list_request.clone(),
        )
    };
    let mut requests = Vec::new();
    if !sent.contains("runs") {
        requests.push(request(
            counter,
            "view.runs.watch",
            None,
            json!({"subscriptionId":"runs"}),
        ));
        sent.insert("runs".to_string());
    }
    sent.retain(|key| {
        !key.starts_with("runs-page:")
            || run_list_request
                .as_ref()
                .is_some_and(|(revision, cursor)| key == &format!("runs-page:{revision}:{cursor}"))
    });
    if let Some((revision, cursor)) = run_list_request {
        let key = format!("runs-page:{revision}:{cursor}");
        if sent.insert(key) {
            requests.push(request(
                counter,
                "view.runs.page",
                None,
                json!({"revision":revision,"cursor":cursor}),
            ));
        }
    }
    let removals: Vec<String> = sent
        .iter()
        .filter_map(|id| id.strip_prefix("run:").map(str::to_string))
        .filter(|run_id| !watched.contains(run_id))
        .collect();
    for run_id in removals {
        requests.push(request(
            counter,
            "view.run.unwatch",
            Some(&run_id),
            json!({"subscriptionId":format!("run:{run_id}")}),
        ));
        sent.remove(&format!("run:{run_id}"));
    }
    for run_id in watched {
        let subscription = format!("run:{run_id}");
        if sent.insert(subscription.clone()) {
            requests.push(request(
                counter,
                "view.run.watch",
                Some(&run_id),
                json!({"subscriptionId":subscription}),
            ));
        }
    }
    let desired_page_keys = pages
        .iter()
        .map(|((run_id, kind), cursor)| {
            let revision = revisions.get(run_id).copied().unwrap_or(0);
            format!("page:{run_id}:{}:{cursor}:{revision}", page_name(*kind))
        })
        .collect::<HashSet<_>>();
    sent.retain(|key| !key.starts_with("page:") || desired_page_keys.contains(key));
    for ((run_id, kind), cursor) in pages {
        let revision = revisions.get(&run_id).copied().unwrap_or(0);
        let key = format!("page:{run_id}:{}:{cursor}:{revision}", page_name(kind));
        if sent.insert(key) {
            requests.push(request(
                counter,
                "view.page",
                Some(&run_id),
                json!({"kind":page_name(kind),"cursor":cursor}),
            ));
        }
    }
    let desired_content_keys = contents
        .iter()
        .map(|((run_id, path), offset)| format!("content:{run_id}:{path}:{offset}"))
        .collect::<HashSet<_>>();
    sent.retain(|key| !key.starts_with("content:") || desired_content_keys.contains(key));
    for ((run_id, path), offset) in contents {
        let key = format!("content:{run_id}:{path}:{offset}");
        if sent.insert(key) {
            requests.push(request(
                counter,
                "view.content",
                Some(&run_id),
                json!({"path":path,"offset":offset}),
            ));
        }
    }
    requests
}

fn request(
    counter: &mut u64,
    operation: &str,
    run_id: Option<&str>,
    payload: Value,
) -> ClientRequest {
    *counter = counter.wrapping_add(1);
    let id = format!("piw-{}-{counter}", std::process::id());
    ClientRequest {
        schema: PROTOCOL_ID.to_string(),
        message_type: "request".to_string(),
        request_id: id.clone(),
        client_id: format!("piw-{}", std::process::id()),
        operation: operation.to_string(),
        idempotency_key: id,
        run_id: run_id.map(str::to_string),
        expected_revision: None,
        payload,
    }
}

fn handle_server_message(text: &str, shared: &Arc<Mutex<Shared>>) -> Result<()> {
    match parse_server_message(text).map_err(anyhow::Error::msg)? {
        ServerMessage::Hello(hello) => {
            anyhow::ensure!(
                hello.package_version == env!("CARGO_PKG_VERSION"),
                "workflow client version mismatch: host {}, piw {}",
                hello.package_version,
                env!("CARGO_PKG_VERSION")
            );
            let mut state = shared.lock().unwrap();
            state.connected = true;
            state.connecting = false;
            state.reconnect_attempt = 0;
            state.error = None;
        }
        ServerMessage::Event(event) => match event.event.as_str() {
            "runs" => {
                start_run_list(&mut shared.lock().unwrap(), &event.payload)?;
            }
            "run_snapshot" => {
                let Some(run_id) = event.run_id else {
                    return Ok(());
                };
                store_snapshot(
                    &mut shared.lock().unwrap(),
                    run_id,
                    event.revision.unwrap_or(0),
                    event.payload,
                );
            }
            "run_patch" => {
                let Some(run_id) = event.run_id else {
                    return Ok(());
                };
                let targets: Vec<TargetPatch> = serde_json::from_value(event.payload)?;
                let mut state = shared.lock().unwrap();
                if let Some((event_revision, view_revision, generation, view)) =
                    state.raw_views.get_mut(&run_id)
                {
                    if event.revision == Some(*event_revision + 1)
                        && apply_target_patches(view, &targets).is_ok()
                    {
                        *event_revision += 1;
                        *view_revision = view
                            .get("revision")
                            .and_then(Value::as_u64)
                            .unwrap_or(view_revision.saturating_add(1));
                        *generation = generation.wrapping_add(1);
                    }
                }
            }
            _ => {}
        },
        ServerMessage::Response(response) => {
            if response.outcome == "unavailable" || response.outcome == "rejected" {
                shared.lock().unwrap().error = response.error;
            } else if let Some(receipt) = response.receipt {
                match receipt.get("schema").and_then(Value::as_str) {
                    Some("pi-workflows.run-list-page.v1") => {
                        if response.outcome == "accepted" {
                            merge_run_list(&mut shared.lock().unwrap(), &receipt)?;
                        } else {
                            shared.lock().unwrap().run_list_request = None;
                        }
                    }
                    Some("pi-workflows.run-page.v1") => {
                        if response.outcome == "accepted" {
                            merge_page(&mut shared.lock().unwrap(), &receipt)?;
                        }
                    }
                    Some("pi-workflows.content-chunk.v1") => {
                        merge_content(&mut shared.lock().unwrap(), &receipt)?;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn start_run_list(state: &mut Shared, page: &Value) -> Result<()> {
    let revision = page
        .get("revision")
        .and_then(Value::as_str)
        .context("run list page has no revision")?
        .to_string();
    let start = page
        .get("start")
        .and_then(Value::as_u64)
        .context("run list page has no start")?;
    let total = page
        .get("total")
        .and_then(Value::as_u64)
        .context("run list page has no total")?;
    let items = page
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .context("run list page items are not an array")?;
    anyhow::ensure!(start == 0, "run list snapshot does not start at zero");
    anyhow::ensure!(
        items.len() as u64 <= total,
        "run list page exceeds its total"
    );
    if items.len() as u64 == total {
        state.summaries = items;
        state.run_list = None;
        state.run_list_request = None;
    } else {
        anyhow::ensure!(!items.is_empty(), "run list page made no progress");
        let cursor = items.len() as u64;
        state.run_list = Some(RunListAssembly {
            revision: revision.clone(),
            total,
            items,
        });
        state.run_list_request = Some((revision, cursor));
    }
    Ok(())
}

fn merge_run_list(state: &mut Shared, page: &Value) -> Result<()> {
    let revision = page
        .get("revision")
        .and_then(Value::as_str)
        .context("run list page has no revision")?;
    let start = page
        .get("start")
        .and_then(Value::as_u64)
        .context("run list page has no start")?;
    let total = page
        .get("total")
        .and_then(Value::as_u64)
        .context("run list page has no total")?;
    let items = page
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .context("run list page items are not an array")?;
    let Some(assembly) = state.run_list.as_mut() else {
        return Ok(());
    };
    if assembly.revision != revision {
        return Ok(());
    }
    let expected = assembly.items.len() as u64;
    anyhow::ensure!(
        start == expected,
        "run list page does not continue the snapshot"
    );
    anyhow::ensure!(
        total == assembly.total,
        "run list total changed while paging"
    );
    anyhow::ensure!(!items.is_empty(), "run list page made no progress");
    assembly.items.extend(items);
    anyhow::ensure!(
        assembly.items.len() as u64 <= assembly.total,
        "run list page exceeds its total"
    );
    if assembly.items.len() as u64 == assembly.total {
        state.summaries = std::mem::take(&mut assembly.items);
        state.run_list = None;
        state.run_list_request = None;
    } else {
        state.run_list_request = Some((revision.to_string(), assembly.items.len() as u64));
    }
    Ok(())
}

fn merge_content(state: &mut Shared, receipt: &Value) -> Result<()> {
    let run_id = receipt
        .get("runId")
        .and_then(Value::as_str)
        .context("content chunk has no runId")?;
    let path = receipt
        .get("path")
        .and_then(Value::as_str)
        .context("content chunk has no path")?;
    let offset = receipt
        .get("offset")
        .and_then(Value::as_u64)
        .context("content chunk has no offset")?;
    let next_offset = receipt
        .get("nextOffset")
        .and_then(Value::as_u64)
        .context("content chunk has no nextOffset")?;
    let total = receipt
        .get("bytes")
        .and_then(Value::as_u64)
        .context("content chunk has no byte total")?;
    let sha256 = receipt
        .get("sha256")
        .and_then(Value::as_str)
        .context("content chunk has no digest")?;
    let complete = receipt
        .get("complete")
        .and_then(Value::as_bool)
        .context("content chunk has no completion marker")?;
    let data = BASE64
        .decode(
            receipt
                .get("data")
                .and_then(Value::as_str)
                .context("content chunk has no data")?,
        )
        .context("content chunk is not valid base64")?;
    let key = (run_id.to_string(), path.to_string());
    let Some(entry) = state.artifacts.remove(&key) else {
        return Ok(());
    };
    let ArtifactEntry::Loading(mut bytes) = entry else {
        state.artifacts.insert(key, entry);
        return Ok(());
    };
    if bytes.len() as u64 != offset || offset.saturating_add(data.len() as u64) != next_offset {
        state.artifacts.insert(
            key.clone(),
            ArtifactEntry::Error("workflow content chunk offset is invalid".to_string()),
        );
        state.content_requests.remove(&key);
        bump_view_generation(state, run_id);
        return Ok(());
    }
    bytes.extend_from_slice(&data);
    if complete {
        let digest = hex_sha256(&bytes);
        if bytes.len() as u64 != total || next_offset != total || digest != sha256 {
            state.artifacts.insert(
                key.clone(),
                ArtifactEntry::Error("workflow content digest does not match".to_string()),
            );
        } else {
            match String::from_utf8(bytes) {
                Ok(content) => {
                    state
                        .artifacts
                        .insert(key.clone(), ArtifactEntry::Ready(content));
                }
                Err(_) => {
                    state.artifacts.insert(
                        key.clone(),
                        ArtifactEntry::Error("workflow content is not UTF-8".to_string()),
                    );
                }
            }
        }
        state.content_requests.remove(&key);
        bump_view_generation(state, run_id);
    } else {
        state
            .artifacts
            .insert(key.clone(), ArtifactEntry::Loading(bytes));
        state.content_requests.insert(key, next_offset);
    }
    Ok(())
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn merge_page(state: &mut Shared, receipt: &Value) -> Result<()> {
    let run_id = receipt
        .get("runId")
        .and_then(Value::as_str)
        .context("run page has no runId")?;
    let kind = receipt
        .get("kind")
        .and_then(Value::as_str)
        .context("run page has no kind")?;
    let start = receipt.get("start").and_then(Value::as_u64).unwrap_or(0);
    let total = receipt.get("total").and_then(Value::as_u64).unwrap_or(0);
    let items = receipt
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .context("run page items are not an array")?;
    let page_kind = page_kind(kind).context("run page kind is invalid")?;
    let cursor = receipt
        .get("cursor")
        .and_then(Value::as_u64)
        .context("run page has no cursor")?;
    let revision = receipt
        .get("revision")
        .and_then(Value::as_u64)
        .context("run page has no revision")?;
    if state.page_requests.get(&(run_id.to_string(), page_kind)) != Some(&cursor) {
        return Ok(());
    }
    let Some((_, view_revision, generation, view)) = state.raw_views.get_mut(run_id) else {
        return Ok(());
    };
    if *view_revision != revision {
        return Ok(());
    }

    match kind {
        "steps" => {
            view["graphSteps"] = receipt
                .get("graphSteps")
                .cloned()
                .unwrap_or_else(|| Value::Array(items.clone()));
            view["stepStart"] = json!(start);
            view["stepTotal"] = json!(total);
            view["graphCursor"] = receipt.get("graphCursor").cloned().unwrap_or(json!(0));
            view["takenTransitions"] = receipt
                .get("takenTransitions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            if let Some(workflow_state) = view.get_mut("state").and_then(Value::as_object_mut) {
                workflow_state.insert("steps".to_string(), Value::Array(items));
            }
        }
        "trace" | "trace_at_step" => {
            view["tracePage"] = json!({"start":start,"total":total,"items":items});
        }
        "session_entries" | "session_events" => {
            let session = view
                .get_mut("session")
                .and_then(Value::as_object_mut)
                .context("run view has no session object")?;
            session.insert(
                if kind == "session_entries" {
                    "entryPage".to_string()
                } else {
                    "eventPage".to_string()
                },
                json!({"start":start,"total":total,"items":items}),
            );
            if kind == "session_events" {
                session.insert(
                    "replayCheckpoint".to_string(),
                    receipt
                        .get("replayCheckpoint")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
        }
        "settings" => {
            view["settingsScopes"] = Value::Array(items);
            view["settingsStart"] = json!(start);
            view["settingsTotal"] = json!(total);
        }
        "follow_ups" => {
            if !view.get("followUpQueue").is_some_and(Value::is_object) {
                view["followUpQueue"] = json!({});
            }
            if let Some(queue) = view.get_mut("followUpQueue").and_then(Value::as_object_mut) {
                queue.insert("items".to_string(), Value::Array(items));
            }
            view["followUpStart"] = json!(start);
            view["followUpTotal"] = json!(total);
        }
        "updates" => {
            view["updates"] = Value::Array(items.clone());
            view["updateStart"] = json!(start);
            view["updateTotal"] = json!(total);
            if let Some(workflow_state) = view.get_mut("state").and_then(Value::as_object_mut) {
                workflow_state.insert("updates".to_string(), Value::Array(items));
            }
        }
        _ => anyhow::bail!("unsupported run page kind {kind}"),
    }
    *generation = generation.wrapping_add(1);
    Ok(())
}

fn bump_view_generation(state: &mut Shared, run_id: &str) {
    if let Some((_, _, generation, _)) = state.raw_views.get_mut(run_id) {
        *generation = generation.wrapping_add(1);
    }
}

fn store_snapshot(state: &mut Shared, run_id: String, event_revision: u64, value: Value) {
    state.next_view_generation = state.next_view_generation.wrapping_add(1);
    let generation = state.next_view_generation;
    let view_revision = value
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(event_revision);
    state
        .raw_views
        .insert(run_id, (event_revision, view_revision, generation, value));
}

fn page_kind(value: &str) -> Option<PageKind> {
    match value {
        "steps" => Some(PageKind::Steps),
        "trace" => Some(PageKind::Trace),
        "trace_at_step" => Some(PageKind::TraceAtStep),
        "session_entries" => Some(PageKind::SessionEntries),
        "session_events" => Some(PageKind::SessionEvents),
        "settings" => Some(PageKind::Settings),
        "follow_ups" => Some(PageKind::FollowUps),
        "updates" => Some(PageKind::Updates),
        _ => None,
    }
}

fn page_name(kind: PageKind) -> &'static str {
    match kind {
        PageKind::Steps => "steps",
        PageKind::Trace => "trace",
        PageKind::TraceAtStep => "trace_at_step",
        PageKind::SessionEntries => "session_entries",
        PageKind::SessionEvents => "session_events",
        PageKind::Settings => "settings",
        PageKind::FollowUps => "follow_ups",
        PageKind::Updates => "updates",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PatchOp;

    #[test]
    fn decodes_the_host_owned_run_view_contract() {
        let source = json!({"kind":"file","path":"/tmp/smoke.workflow.ts","hash":"abc"});
        let raw = json!({
            "manifest": {
                "schema":"pi-workflows.run-manifest.v1",
                "runId":"run-1",
                "workflowName":"smoke",
                "workflowSource":source,
                "startedAt":"2026-01-01T00:00:00.000Z",
                "finishedAt":"2026-01-01T00:00:01.000Z",
                "status":"completed",
                "traceSchema":"pi-workflows.trace-event.v1",
                "paths":{"workflow":"host","state":"host","trace":"host"}
            },
            "state": {
                "schema":"pi-workflows.run-state.v1",
                "traceSeq":1,
                "runId":"run-1",
                "workflowName":"smoke",
                "workflowSource":source,
                "startedAt":"2026-01-01T00:00:00.000Z",
                "finishedAt":"2026-01-01T00:00:01.000Z",
                "updatedAt":"2026-01-01T00:00:01.000Z",
                "status":"completed",
                "input":{},
                "outputs":{},
                "results":{},
                "steps":[],
                "updates":[{"seq":299}]
            },
            "workflow": {
                "schema":"pi-workflows.definition-snapshot.v1",
                "name":"smoke",
                "startAt":"done",
                "nodes":{"done":{"nodeType":"compute"}},
                "edges":[]
            },
            "graphSteps":[],
            "takenTransitions":[],
            "graphCursor":0,
            "stepStart":0,
            "stepTotal":0,
            "tracePage":{"start":0,"total":0,"items":[]},
            "session":{
                "binding":null,
                "entryPage":{"start":0,"total":0,"items":[]},
                "eventPage":{"start":0,"total":0,"items":[]},
                "capture":null,
                "integrity":null
            },
            "settingsScopes":[],
            "settingsStart":0,
            "settingsTotal":0,
            "followUpQueue":null,
            "followUpStart":0,
            "followUpTotal":0,
            "updateStart":299,
            "updateTotal":300,
            "live":false,
            "possiblyInterrupted":false
        });

        let view = decode_view(4, 1, &raw, None).expect("host view should decode");
        assert_eq!(view.manifest.workflow_name, "smoke");
        assert_eq!(view.state.status, crate::state::types::RunStatus::Completed);
        assert_eq!(view.update_total, 300);
    }

    #[test]
    fn large_workflow_definitions_load_before_layout() {
        let nodes = (0..300)
            .map(|index| (format!("node-{index}"), json!({"nodeType":"compute"})))
            .collect::<serde_json::Map<_, _>>();
        let full = json!({
            "schema":"pi-workflows.definition-snapshot.v1",
            "name":"large",
            "startAt":"node-0",
            "nodes":nodes,
            "edges":[]
        });
        let content = serde_json::to_string(&full).unwrap();
        let path = "artifacts/sha256/definition.json";
        let raw = json!({
            "workflow": {
                "schema":"pi-workflows.definition-snapshot.v1",
                "name":"large",
                "startAt":"node-0",
                "nodes":{"node-0":{"nodeType":"compute"}},
                "edges":[],
                "content": {
                    "$artifact": {
                        "path":path,
                        "mediaType":"application/json",
                        "bytes":content.len(),
                        "sha256":hex_sha256(content.as_bytes()),
                        "opaque":true
                    }
                }
            }
        });
        let mut state = Shared::default();
        let (missing, requested) = workflow_definition_content(&mut state, "run-1", &raw);
        assert!(missing.is_none());
        assert!(requested);
        assert_eq!(
            state
                .content_requests
                .get(&("run-1".to_string(), path.to_string())),
            Some(&0)
        );
        state.artifacts.insert(
            ("run-1".to_string(), path.to_string()),
            ArtifactEntry::Ready(content),
        );
        let (loaded, requested) = workflow_definition_content(&mut state, "run-1", &raw);
        assert!(!requested);
        let snapshot: DefinitionSnapshot =
            serde_json::from_value(workflow_definition_value(&raw, loaded.as_deref()).unwrap())
                .unwrap();
        assert_eq!(snapshot.nodes.len(), 300);
        assert_eq!(layout_graph(&snapshot).rank_of_node.len(), 300);

        let mut invalid = raw;
        invalid["workflow"]["content"]["$artifact"]["sha256"] = json!("0".repeat(64));
        let (loaded, requested) = workflow_definition_content(&mut state, "run-1", &invalid);
        assert!(loaded.is_none());
        assert!(!requested);
        assert!(state
            .error
            .as_deref()
            .is_some_and(|error| error.contains("does not match")));
    }

    #[test]
    fn a_run_page_updates_only_its_selected_window() {
        let mut state = Shared::default();
        state.raw_views.insert(
            "run-1".to_string(),
            (
                3,
                3,
                1,
                json!({
                    "state":{"steps":[],"updates":[]},
                    "session":{"entryPage":{"items":[]},"eventPage":{"items":[]}},
                    "settingsScopes":[{"change":1}],
                    "settingsStart":0,
                    "settingsTotal":1
                }),
            ),
        );
        state
            .page_requests
            .insert(("run-1".to_string(), PageKind::Settings), 44);
        state
            .page_requests
            .insert(("run-1".to_string(), PageKind::Steps), 0);
        state
            .page_requests
            .insert(("run-1".to_string(), PageKind::FollowUps), 2);
        state
            .page_requests
            .insert(("run-1".to_string(), PageKind::SessionEvents), 256);
        merge_page(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-page.v1",
                "runId":"run-1",
                "revision":3,
                "kind":"settings",
                "cursor":44,
                "start":44,
                "total":300,
                "items":[{"change":299}]
            }),
        )
        .unwrap();
        merge_page(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-page.v1",
                "runId":"run-1",
                "revision":3,
                "kind":"steps",
                "cursor":0,
                "start":0,
                "total":1,
                "items":[{"step":0}],
                "graphSteps":[{"node":"one"}],
                "graphCursor":0,
                "takenTransitions":[]
            }),
        )
        .unwrap();
        merge_page(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-page.v1",
                "runId":"run-1",
                "revision":3,
                "kind":"follow_ups",
                "cursor":2,
                "start":2,
                "total":3,
                "items":[{"followUpId":"follow-3"}]
            }),
        )
        .unwrap();
        merge_page(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-page.v1",
                "runId":"run-1",
                "revision":3,
                "kind":"session_events",
                "cursor":256,
                "start":256,
                "total":300,
                "items":[{"seq":257}],
                "replayCheckpoint":{"throughSeq":256}
            }),
        )
        .unwrap();
        let (_, _, generation, view) = state.raw_views.get("run-1").unwrap();
        assert_eq!(*generation, 5);
        assert_eq!(view["settingsStart"], 44);
        assert_eq!(view["settingsScopes"], json!([{"change":299}]));
        assert_eq!(view["graphSteps"], json!([{"node":"one"}]));
        assert_eq!(view["state"]["steps"], json!([{"step":0}]));
        assert_eq!(
            view["followUpQueue"]["items"],
            json!([{"followUpId":"follow-3"}])
        );
        assert_eq!(view["session"]["replayCheckpoint"]["throughSeq"], 256);
    }

    #[test]
    fn stale_run_pages_cannot_replace_the_requested_window() {
        let mut state = Shared::default();
        state.raw_views.insert(
            "run-1".to_string(),
            (
                1,
                3,
                1,
                json!({"state":{"steps":[]},"graphSteps":[],"takenTransitions":[]}),
            ),
        );
        state
            .page_requests
            .insert(("run-1".to_string(), PageKind::Steps), 20);
        let receipt = |cursor: u64, revision: u64, item: u64| {
            json!({
                "schema":"pi-workflows.run-page.v1",
                "runId":"run-1",
                "revision":revision,
                "kind":"steps",
                "cursor":cursor,
                "start":cursor,
                "total":100,
                "items":[{"step":item}],
                "graphSteps":[],
                "graphCursor":cursor,
                "takenTransitions":[]
            })
        };
        merge_page(&mut state, &receipt(10, 3, 10)).unwrap();
        merge_page(&mut state, &receipt(20, 2, 2)).unwrap();
        assert_eq!(state.raw_views["run-1"].2, 1);
        merge_page(&mut state, &receipt(20, 3, 20)).unwrap();
        assert_eq!(state.raw_views["run-1"].2, 2);
        assert_eq!(
            state.raw_views["run-1"].3["state"]["steps"],
            json!([{"step":20}])
        );
    }

    #[test]
    fn paged_run_lists_publish_only_complete_matching_revisions() {
        let mut state = Shared::default();
        start_run_list(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-list-page.v1",
                "revision":"3:10:20",
                "start":0,
                "total":3,
                "items":[{"runId":"run-1"},{"runId":"run-2"}]
            }),
        )
        .unwrap();
        assert!(state.summaries.is_empty());
        assert_eq!(state.run_list_request, Some(("3:10:20".to_string(), 2)));
        merge_run_list(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-list-page.v1",
                "revision":"stale",
                "start":2,
                "total":3,
                "items":[{"runId":"stale"}]
            }),
        )
        .unwrap();
        assert!(state.summaries.is_empty());
        merge_run_list(
            &mut state,
            &json!({
                "schema":"pi-workflows.run-list-page.v1",
                "revision":"3:10:20",
                "start":2,
                "total":3,
                "items":[{"runId":"run-3"}]
            }),
        )
        .unwrap();
        assert_eq!(state.summaries.len(), 3);
        assert!(state.run_list_request.is_none());
    }

    #[test]
    fn switching_runs_discards_old_pages_content_and_artifacts() {
        let mut state = Shared::default();
        state
            .raw_views
            .insert("old".to_string(), (1, 1, 1, json!({})));
        state
            .page_requests
            .insert(("old".to_string(), PageKind::Steps), 10);
        state
            .content_requests
            .insert(("old".to_string(), "old.json".to_string()), 0);
        state.artifacts.insert(
            ("old".to_string(), "old.json".to_string()),
            ArtifactEntry::Ready("old".to_string()),
        );
        state
            .page_requests
            .insert(("current".to_string(), PageKind::Steps), 20);

        discard_run_state(&mut state, "old");

        assert!(!state.raw_views.contains_key("old"));
        assert!(state
            .page_requests
            .keys()
            .all(|(run_id, _)| run_id != "old"));
        assert!(state
            .content_requests
            .keys()
            .all(|(run_id, _)| run_id != "old"));
        assert!(state.artifacts.keys().all(|(run_id, _)| run_id != "old"));
        assert!(state
            .page_requests
            .contains_key(&("current".to_string(), PageKind::Steps)));
    }

    #[test]
    fn page_requests_can_return_to_an_earlier_window() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared
            .lock()
            .unwrap()
            .raw_views
            .insert("run-1".to_string(), (7, 7, 1, json!({})));
        let mut sent = HashSet::new();
        let mut counter = 0;
        let request_at = |cursor: u64,
                          shared: &Arc<Mutex<Shared>>,
                          sent: &mut HashSet<String>,
                          counter: &mut u64| {
            shared
                .lock()
                .unwrap()
                .page_requests
                .insert(("run-1".to_string(), PageKind::Steps), cursor);
            reconcile_requests(shared, sent, counter)
                .into_iter()
                .filter(|request| request.operation == "view.page")
                .count()
        };
        assert_eq!(request_at(10, &shared, &mut sent, &mut counter), 1);
        assert_eq!(request_at(20, &shared, &mut sent, &mut counter), 1);
        assert_eq!(request_at(10, &shared, &mut sent, &mut counter), 1);
    }

    #[test]
    fn content_chunks_are_reassembled_and_verified() {
        let content = br#"{"complete":true}"#.to_vec();
        let path = "artifacts/sha256/content.json";
        let key = ("run-1".to_string(), path.to_string());
        let mut state = Shared::default();
        state
            .raw_views
            .insert("run-1".to_string(), (1, 1, 1, json!({"workflow":null})));
        state
            .artifacts
            .insert(key.clone(), ArtifactEntry::Loading(Vec::new()));
        state.content_requests.insert(key.clone(), 0);
        merge_content(
            &mut state,
            &json!({
                "schema":"pi-workflows.content-chunk.v1",
                "runId":"run-1",
                "path":path,
                "mediaType":"application/json",
                "bytes":content.len(),
                "sha256":hex_sha256(&content),
                "offset":0,
                "nextOffset":content.len(),
                "complete":true,
                "data":BASE64.encode(&content)
            }),
        )
        .unwrap();
        assert!(
            matches!(state.artifacts.get(&key), Some(ArtifactEntry::Ready(value)) if value == "{\"complete\":true}")
        );
        assert!(!state.content_requests.contains_key(&key));
        assert_eq!(state.raw_views["run-1"].2, 2);
    }

    #[test]
    fn a_bad_patch_keeps_the_last_good_view() {
        let mut view = json!({"presentationRevision":1});
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
