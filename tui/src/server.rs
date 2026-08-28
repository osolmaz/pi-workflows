//! `piw serve`: loopback-only, revisioned live replay over bounded projections.

use crate::protocol::{ClientMessage, PageKind, PatchOp, ServerMessage, TargetPatch, PROTOCOL_ID};
use crate::source::{ProjectionUpdate, RefreshOutcome, RunSource};
use crate::state::reader::ViewerDeltaRead;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Debug)]
enum Update {
    Runs(Vec<serde_json::Value>),
    Delta {
        run_id: String,
        revision: u64,
        targets: Vec<TargetPatch>,
    },
    SnapshotRequired {
        run_id: String,
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

pub async fn serve_on(listener: TcpListener, database_path: PathBuf) -> Result<()> {
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

    {
        let source = Arc::clone(&source);
        let updates_tx = updates_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let Ok(outcome) = run_blocking(&source, RunSource::refresh_all).await else {
                    continue;
                };
                broadcast_outcome(&updates_tx, &source, outcome).await;
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

async fn broadcast_outcome(
    updates_tx: &broadcast::Sender<Update>,
    source: &Arc<Mutex<RunSource>>,
    outcome: RefreshOutcome,
) {
    for ProjectionUpdate { run_id, delta } in outcome.updates {
        let targets = delta
            .targets
            .into_iter()
            .map(|target| TargetPatch {
                target_type: target.target_type,
                target_key: target.target_key,
                patch: target.patch,
            })
            .collect::<Vec<_>>();
        if targets_are_direct(&targets) {
            let _ = updates_tx.send(Update::Delta {
                run_id,
                revision: delta.revision,
                targets,
            });
        } else {
            let _ = updates_tx.send(Update::SnapshotRequired { run_id });
        }
    }
    for run_id in outcome.snapshots_required {
        let _ = updates_tx.send(Update::SnapshotRequired { run_id });
    }
    if outcome.listing_changed {
        let runs = source.lock().await.summaries();
        let _ = updates_tx.send(Update::Runs(runs));
    }
}

fn page_cursors_for_run(
    page_cursors: &HashMap<(String, PageKind), u64>,
    run_id: &str,
) -> Vec<(PageKind, u64)> {
    let mut cursors = page_cursors
        .iter()
        .filter_map(|((candidate, kind), cursor)| (candidate == run_id).then_some((*kind, *cursor)))
        .collect::<Vec<_>>();
    cursors.sort_unstable();
    cursors
}

fn targets_are_direct(targets: &[TargetPatch]) -> bool {
    !targets.is_empty()
        && targets.iter().all(|target| {
            target.patch.iter().any(|operation| {
                !matches!(
                    operation,
                    PatchOp::Replace { path, .. }
                        if path == "/presentationRevision" || path == "/graphRevision"
                )
            })
        })
}

async fn run_blocking<T, F>(source: &Arc<Mutex<RunSource>>, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut RunSource) -> T + Send + 'static,
{
    let source = Arc::clone(source);
    Ok(tokio::task::spawn_blocking(move || {
        let mut source = source.blocking_lock();
        operation(&mut source)
    })
    .await?)
}

async fn send(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    message: &ServerMessage,
) -> Result<()> {
    let text = serde_json::to_string(message)?;
    sink.send(Message::Text(text.into())).await?;
    Ok(())
}

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
    let mut watched: HashMap<String, u64> = HashMap::new();
    let mut page_cursors: HashMap<(String, PageKind), u64> = HashMap::new();

    let session_result: Result<()> = async {
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
                    continue;
                };
                match request {
                    ClientMessage::WatchRuns => {
                        watching_runs = true;
                        let runs = source.lock().await.summaries();
                        send(&mut sink, &ServerMessage::Runs { runs }).await?;
                    }
                    ClientMessage::WatchRun {
                        run_id,
                        revision,
                        step_cursor,
                        trace_cursor,
                        session_entry_cursor,
                        session_event_cursor,
                    } => {
                        let first_watch = !watched.contains_key(&run_id);
                        let request_run_id = run_id.clone();
                        let result = run_blocking(&source, move |source| -> Result<_> {
                            if first_watch {
                                source.watch(&request_run_id)?;
                            }
                            let result = (|| -> Result<_> {
                                let resume = revision
                                    .map(|cursor| source.deltas_after(&request_run_id, cursor))
                                    .transpose()?;
                                let snapshot = source
                                    .get(&request_run_id)
                                    .map(|entry| (entry.revision, entry.view()));
                                Ok((resume, snapshot))
                            })();
                            if first_watch && result.is_err() {
                                source.unwatch(&request_run_id);
                            }
                            result
                        }).await?;
                        if first_watch && result.is_ok() {
                            watched.insert(run_id.clone(), revision.unwrap_or(0));
                        }
                        let available = match result {
                            Ok((Some(ViewerDeltaRead::Deltas { deltas, current_revision }), snapshot))
                                if revision.is_some() => {
                                    let mut sent = revision.unwrap_or(0);
                                    for delta in deltas {
                                        let targets = delta.targets.into_iter().map(|target| TargetPatch {
                                            target_type: target.target_type,
                                            target_key: target.target_key,
                                            patch: target.patch,
                                        }).collect::<Vec<_>>();
                                        if !targets_are_direct(&targets) {
                                            sent = 0;
                                            break;
                                        }
                                        send(&mut sink, &ServerMessage::RunPatch {
                                            run_id: run_id.clone(),
                                            revision: delta.revision,
                                            targets,
                                        }).await?;
                                        sent = delta.revision;
                                    }
                                    watched.insert(run_id.clone(), sent.max(current_revision));
                                    if sent < current_revision {
                                        if let Some((snapshot_revision, view)) = snapshot {
                                            watched.insert(run_id.clone(), snapshot_revision);
                                            send(&mut sink, &ServerMessage::RunSnapshot {
                                                run_id: run_id.clone(),
                                                revision: snapshot_revision,
                                                view,
                                            }).await?;
                                        }
                                    }
                                true
                            }
                            Ok((_, Some((snapshot_revision, view)))) => {
                                watched.insert(run_id.clone(), snapshot_revision);
                                send(&mut sink, &ServerMessage::RunSnapshot {
                                    run_id: run_id.clone(),
                                    revision: snapshot_revision,
                                    view,
                                }).await?;
                                true
                            }
                            Ok((_, None)) | Err(_) => {
                                send(&mut sink, &ServerMessage::Error {
                                    message: format!("run {run_id} is unavailable"),
                                    run_id: Some(run_id.clone()),
                                }).await?;
                                false
                            }
                        };
                        if available {
                            for (kind, cursor) in [
                                (PageKind::Steps, step_cursor),
                                (PageKind::Trace, trace_cursor),
                                (PageKind::SessionEntries, session_entry_cursor),
                                (PageKind::SessionEvents, session_event_cursor),
                            ] {
                                if let Some(cursor) = cursor {
                                    page_cursors.insert((run_id.clone(), kind), cursor);
                                    send_projection_page(
                                        &mut sink,
                                        &source,
                                        run_id.clone(),
                                        kind,
                                        cursor,
                                    )
                                    .await?;
                                }
                            }
                        }
                    }
                    ClientMessage::UnwatchRun { run_id } => {
                        if watched.remove(&run_id).is_some() {
                            page_cursors.retain(|(candidate, _), _| candidate != &run_id);
                            let remove_id = run_id.clone();
                            let _ = run_blocking(&source, move |source| source.unwatch(&remove_id)).await;
                        }
                    }
                    ClientMessage::FetchPage { run_id, kind, cursor } => {
                        if watched.contains_key(&run_id) {
                            page_cursors.insert((run_id.clone(), kind), cursor);
                            send_projection_page(&mut sink, &source, run_id, kind, cursor).await?;
                        }
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
                    Ok(Update::Runs(runs)) if watching_runs => {
                        send(&mut sink, &ServerMessage::Runs { runs }).await?;
                    }
                    Ok(Update::Runs(_)) => {}
                    Ok(Update::Delta { run_id, revision, targets }) => {
                        let Some(&last) = watched.get(&run_id) else { continue };
                        if revision == last + 1 {
                            watched.insert(run_id.clone(), revision);
                            send(&mut sink, &ServerMessage::RunPatch { run_id, revision, targets }).await?;
                        } else if revision > last {
                            send_snapshot(
                                &mut sink,
                                &source,
                                &mut watched,
                                &page_cursors,
                                run_id,
                            )
                            .await?;
                        }
                    }
                    Ok(Update::SnapshotRequired { run_id }) => {
                        if watched.contains_key(&run_id) {
                            send_snapshot(
                                &mut sink,
                                &source,
                                &mut watched,
                                &page_cursors,
                                run_id,
                            )
                            .await?;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let run_ids: Vec<String> = watched.keys().cloned().collect();
                        for run_id in run_ids {
                            send_snapshot(
                                &mut sink,
                                &source,
                                &mut watched,
                                &page_cursors,
                                run_id,
                            )
                            .await?;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
    }.await;

    let watched_ids: Vec<String> = watched.into_keys().collect();
    let _ = run_blocking(&source, move |source| {
        for run_id in watched_ids {
            source.unwatch(&run_id);
        }
    })
    .await;
    session_result
}

async fn send_projection_page(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    source: &Arc<Mutex<RunSource>>,
    run_id: String,
    kind: PageKind,
    cursor: u64,
) -> Result<()> {
    let request_id = run_id.clone();
    let page = run_blocking(source, move |source| source.page(&request_id, kind, cursor)).await?;
    match page {
        Ok((revision, page)) => {
            let graph_steps = page
                .graph_steps
                .map(|steps| {
                    steps
                        .into_iter()
                        .map(serde_json::to_value)
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            send(
                sink,
                &ServerMessage::RunPage {
                    run_id,
                    revision,
                    kind,
                    cursor,
                    start: page.start,
                    total: page.total,
                    items: page.items,
                    graph_cursor: page.graph_cursor,
                    graph_steps,
                    taken_transitions: page.taken_transitions,
                    replay_checkpoint: page.replay_checkpoint,
                },
            )
            .await?;
        }
        Err(_) => {
            send(
                sink,
                &ServerMessage::Error {
                    message: "run page is unavailable".to_string(),
                    run_id: Some(run_id),
                },
            )
            .await?;
        }
    }
    Ok(())
}

async fn send_snapshot(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    source: &Arc<Mutex<RunSource>>,
    watched: &mut HashMap<String, u64>,
    page_cursors: &HashMap<(String, PageKind), u64>,
    run_id: String,
) -> Result<()> {
    let snapshot_id = run_id.clone();
    let snapshot = run_blocking(source, move |source| {
        source
            .get(&snapshot_id)
            .map(|entry| (entry.revision, entry.view()))
    })
    .await?;
    if let Some((revision, view)) = snapshot {
        watched.insert(run_id.clone(), revision);
        send(
            sink,
            &ServerMessage::RunSnapshot {
                run_id: run_id.clone(),
                revision,
                view,
            },
        )
        .await?;
        for (kind, cursor) in page_cursors_for_run(page_cursors, &run_id) {
            send_projection_page(sink, source, run_id.clone(), kind, cursor).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_keeps_each_run_page_cursor() {
        let cursors = HashMap::from([
            (("run-1".to_string(), PageKind::Trace), 40),
            (("run-1".to_string(), PageKind::SessionEvents), 80),
            (("run-2".to_string(), PageKind::Trace), 120),
        ]);
        assert_eq!(
            page_cursors_for_run(&cursors, "run-1"),
            vec![(PageKind::Trace, 40), (PageKind::SessionEvents, 80)]
        );
    }

    #[test]
    fn sends_only_complete_direct_target_patches() {
        let revision_only = TargetPatch {
            target_type: "graph".to_string(),
            target_key: String::new(),
            patch: vec![PatchOp::Replace {
                path: "/presentationRevision".to_string(),
                value: json!(2),
            }],
        };
        assert!(!targets_are_direct(&[revision_only]));

        let tail = TargetPatch {
            target_type: "conversation".to_string(),
            target_key: "entries:tail".to_string(),
            patch: vec![
                PatchOp::Replace {
                    path: "/presentationRevision".to_string(),
                    value: json!(2),
                },
                PatchOp::Append {
                    path: "/items".to_string(),
                    value: vec![json!({"seq": 1})],
                },
            ],
        };
        assert!(targets_are_direct(&[tail]));
    }
}
