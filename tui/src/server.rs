//! `piw serve`: a WebSocket server exposing run views over the live replay
//! protocol. The server is a run reader like any other — it never writes
//! database runs — and binds to localhost by default because database runs contain
//! private data.

use crate::protocol::{ClientMessage, PatchOp, ServerMessage, PROTOCOL_ID};
use crate::source::RunSource;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// Broadcast from the refresh loop to every connection task.
#[derive(Clone, Debug)]
enum Update {
    Runs(Vec<serde_json::Value>),
    Patch {
        run_id: String,
        revision: u64,
        patch: Vec<PatchOp>,
    },
}

pub struct ServeOptions {
    pub database_path: PathBuf,
    pub bind: String,
}

pub async fn serve(options: ServeOptions) -> Result<()> {
    let listener = TcpListener::bind(&options.bind)
        .await
        .with_context(|| format!("binding {}", options.bind))?;
    eprintln!(
        "piw serve: watching {} on ws://{}/ws",
        options.database_path.display(),
        listener.local_addr()?
    );
    serve_on(listener, options.database_path).await
}

/// Accept-loop core, split out so tests can bind an ephemeral port.
pub async fn serve_on(listener: TcpListener, database_path: PathBuf) -> Result<()> {
    // The protocol has no authentication, so a reachable server hands run
    // database runs to anyone. Refuse non-loopback listeners here, at the single
    // entry point every caller goes through; view remote runs through an
    // SSH tunnel instead.
    let local = listener.local_addr()?;
    if !local.ip().is_loopback() {
        anyhow::bail!(
            "refusing to serve on non-loopback address {local}: the live replay \
             protocol is unauthenticated; bind to 127.0.0.1 and use an SSH tunnel \
             for remote access"
        );
    }
    let source = Arc::new(Mutex::new(RunSource::new(&database_path)?));
    let (updates_tx, _) = broadcast::channel::<Update>(256);

    // Refresh loop: wake on filesystem changes (plus a slow safety tick for
    // the possibly-interrupted timer) and broadcast the resulting patches.
    {
        let source = Arc::clone(&source);
        let updates_tx = updates_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let outcome = source.lock().await.refresh_all();
                for (run_id, revision, patch) in outcome.patches {
                    let _ = updates_tx.send(Update::Patch {
                        run_id,
                        revision,
                        patch,
                    });
                }
                if outcome.listing_changed {
                    let _ = updates_tx.send(Update::Runs(source.lock().await.summaries()));
                }
            }
        });
    }

    loop {
        let (stream, _addr) = listener.accept().await?;
        let source = Arc::clone(&source);
        let updates_rx = updates_tx.subscribe();
        tokio::spawn(async move {
            let _ = handle_connection(stream, source, updates_rx).await;
        });
    }
}

async fn send(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    message: &ServerMessage,
) -> Result<()> {
    let text = serde_json::to_string(message)?;
    sink.send(Message::Text(text.into())).await?;
    Ok(())
}

// The error type (a full HTTP response) is dictated by tungstenite's
// handshake callback signature.
#[allow(clippy::result_large_err)]
fn reject_browser_origins(
    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
    response: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    if request.headers().contains_key("origin") {
        let mut rejection = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(
            Some("browser origins are not allowed".to_string()),
        );
        *rejection.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
        return Err(rejection);
    }
    Ok(response)
}

async fn handle_connection(
    stream: TcpStream,
    source: Arc<Mutex<RunSource>>,
    mut updates_rx: broadcast::Receiver<Update>,
) -> Result<()> {
    // Browsers always send an Origin header; native clients do not. The
    // protocol is unauthenticated, so a web page must never be able to read
    // SQLite workflow state by opening a WebSocket to localhost — reject any
    // browser-originated handshake outright.
    let ws = tokio_tungstenite::accept_hdr_async(stream, reject_browser_origins).await?;
    let (mut sink, mut reads) = ws.split();
    send(
        &mut sink,
        &ServerMessage::Hello {
            protocol: PROTOCOL_ID.to_string(),
        },
    )
    .await?;

    let mut watching_runs = false;
    // Last revision sent per watched run; a broadcast patch is forwarded only
    // when it is exactly the next revision, otherwise the client gets a fresh
    // snapshot (covers the subscribe/broadcast race).
    let mut watched: HashMap<String, u64> = HashMap::new();

    loop {
        tokio::select! {
            incoming = reads.next() => {
                let Some(incoming) = incoming else { break };
                let message = match incoming {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                };
                let Ok(request) = serde_json::from_str::<ClientMessage>(&message) else {
                    // Unknown message types must be ignored.
                    continue;
                };
                match request {
                    ClientMessage::WatchRuns => {
                        watching_runs = true;
                        let runs = source.lock().await.summaries();
                        send(&mut sink, &ServerMessage::Runs { runs }).await?;
                    }
                    ClientMessage::WatchRun { run_id } => {
                        // Snapshot under the lock, send after releasing it: a
                        // slow client must not stall the refresh loop.
                        let snapshot = {
                            let source = source.lock().await;
                            source.get(&run_id).map(|entry| (entry.revision, entry.view()))
                        };
                        match snapshot {
                            Some((revision, view)) => {
                                watched.insert(run_id.clone(), revision);
                                send(&mut sink, &ServerMessage::RunSnapshot {
                                    run_id,
                                    revision,
                                    view,
                                }).await?;
                            }
                            None => {
                                send(&mut sink, &ServerMessage::Error {
                                    message: format!("unknown run {run_id}"),
                                    run_id: Some(run_id),
                                }).await?;
                            }
                        }
                    }
                    ClientMessage::UnwatchRun { run_id } => {
                        watched.remove(&run_id);
                    }
                    ClientMessage::FetchArtifact { run_id, path } => {
                        send(&mut sink, &ServerMessage::Error {
                            message: format!("artifact {path} not available; values are stored in SQLite"),
                            run_id: Some(run_id),
                        }).await?;
                    }
                }
            }
            update = updates_rx.recv() => {
                match update {
                    Ok(Update::Runs(runs)) => {
                        if watching_runs {
                            send(&mut sink, &ServerMessage::Runs { runs }).await?;
                        }
                    }
                    Ok(Update::Patch { run_id, revision, patch }) => {
                        let Some(&last) = watched.get(&run_id) else { continue };
                        if revision == last + 1 {
                            watched.insert(run_id.clone(), revision);
                            send(&mut sink, &ServerMessage::RunPatch { run_id, revision, patch }).await?;
                        } else if revision > last {
                            // Missed one (lagged broadcast): resnapshot.
                            let snapshot = {
                                let source = source.lock().await;
                                source.get(&run_id).map(|entry| (entry.revision, entry.view()))
                            };
                            if let Some((revision, view)) = snapshot {
                                watched.insert(run_id.clone(), revision);
                                send(&mut sink, &ServerMessage::RunSnapshot { run_id, revision, view }).await?;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Dropped updates: resnapshot everything we watch.
                        let run_ids: Vec<String> = watched.keys().cloned().collect();
                        for run_id in run_ids {
                            let snapshot = {
                                let source = source.lock().await;
                                source.get(&run_id).map(|entry| (entry.revision, entry.view()))
                            };
                            if let Some((revision, view)) = snapshot {
                                watched.insert(run_id.clone(), revision);
                                send(&mut sink, &ServerMessage::RunSnapshot { run_id, revision, view }).await?;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}
