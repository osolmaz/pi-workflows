//! Live-update tests: the run source's snapshot/patch invariant (applying
//! the patch stream to an old view reproduces the current view), and an
//! end-to-end WebSocket round trip through `piw serve` and the client.

mod common;

use common::{append_trace, state_value, write_bundle};
use piw::protocol::apply_patch;
use piw::source::RunSource;
use serde_json::json;
use std::io::Write;
use std::time::{Duration, Instant};

#[test]
fn patches_reproduce_the_view_exactly() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    let mut source = RunSource::new(runs.path());
    let mut tracked = source.get("run-1").unwrap().view();

    // Grow the bundle: node events in the trace, then a state rewrite, then
    // a terminal status in state and manifest.
    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "node",
            "type": "node_started", "runId": "run-1", "nodeId": "plan",
            "attemptId": "a1", "payload": {},
        }),
    );
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state_value("run-1", "completed", 2, vec![])).unwrap(),
    )
    .unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    manifest["status"] = json!("completed");
    manifest["finishedAt"] = json!("2026-01-01T00:00:03.000Z");
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();

    let outcome = source.refresh_all();
    let (run_id, _revision, patch) = &outcome.patches[0];
    assert_eq!(run_id, "run-1");
    apply_patch(&mut tracked, patch).unwrap();
    assert_eq!(
        tracked,
        source.get("run-1").unwrap().view(),
        "patched view must equal the source's current view"
    );
    assert_eq!(tracked["live"], json!(false));
    assert_eq!(tracked["events"].as_array().unwrap().len(), 2);
    assert!(
        outcome.listing_changed,
        "terminal status changes the listing"
    );
}

#[test]
fn trace_events_wait_for_the_state_projection() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-torn", "running");
    let mut source = RunSource::new(runs.path());
    assert_eq!(
        source.get("run-torn").unwrap().view()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Writer appended the trace but has not rewritten state.json yet
    // (state.traceSeq is still 1): the event must be held back.
    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "node",
            "type": "node_started", "runId": "run-torn", "nodeId": "plan",
            "attemptId": "a1", "payload": {},
        }),
    );
    source.refresh_all();
    assert_eq!(
        source.get("run-torn").unwrap().view()["events"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "trace tail ahead of state.traceSeq must not be published"
    );

    // The state catches up: the held event is published with it.
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state_value("run-torn", "running", 2, vec![])).unwrap(),
    )
    .unwrap();
    let outcome = source.refresh_all();
    assert_eq!(outcome.patches.len(), 1);
    assert_eq!(
        source.get("run-torn").unwrap().view()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn terminal_transition_waits_for_the_projection() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-race", "running");
    let mut source = RunSource::new(runs.path());

    // A refresh can observe the new trace tail and the terminal manifest
    // while still holding the old state.json (the reader raced the writer).
    // The run must stay live so the final projection is not lost.
    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "run",
            "type": "run_completed", "runId": "run-race", "payload": {},
        }),
    );
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    manifest["status"] = json!("completed");
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();
    source.refresh_all();
    let entry = source.get("run-race").unwrap();
    assert!(entry.live, "must stay live until the state catches up");
    assert_eq!(entry.view()["events"].as_array().unwrap().len(), 1);

    // The state projection lands: the run settles with everything present.
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state_value("run-race", "completed", 2, vec![])).unwrap(),
    )
    .unwrap();
    source.refresh_all();
    let entry = source.get("run-race").unwrap();
    assert!(!entry.live);
    assert_eq!(entry.view()["events"].as_array().unwrap().len(), 2);
    assert_eq!(entry.view()["state"]["status"], json!("completed"));
}

#[test]
fn terminal_bundles_are_not_re_read() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-done", "completed");
    let mut source = RunSource::new(runs.path());
    assert!(!source.get("run-done").unwrap().live);

    // Growth after terminal status violates the format contract; the source
    // must not pick it up because terminal bundles are skipped entirely.
    append_trace(
        &dir,
        &json!({
            "seq": 99, "at": "2026-01-01T00:09:00.000Z", "scope": "run",
            "type": "bogus", "runId": "run-done", "payload": {},
        }),
    );
    let outcome = source.refresh_all();
    assert!(outcome.patches.is_empty());
}

#[test]
fn unsupported_state_schema_is_skipped() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-future", "running");
    let mut state = state_value("run-future", "running", 1, vec![]);
    state["schema"] = json!("pi-workflows.run-state.v99");
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state).unwrap(),
    )
    .unwrap();
    let source = RunSource::new(runs.path());
    assert!(source.get("run-future").is_none());
}

#[test]
fn single_bundle_mode_survives_refresh() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-solo", "running");
    let mut source = RunSource::single(&dir).unwrap();
    assert!(source.get("run-solo").is_some());
    // Refreshing must not scan the bundle directory as a runs root and
    // drop the only run.
    source.refresh_all();
    assert!(source.get("run-solo").is_some());
}

#[test]
fn manifest_paths_escaping_the_bundle_are_rejected() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-evil", "running");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    manifest["paths"]["trace"] = json!("../../etc/passwd");
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();
    assert!(piw::bundle::reader::read_manifest(&dir).is_err());
    let source = RunSource::new(runs.path());
    assert!(source.get("run-evil").is_none(), "bundle must be skipped");
}

#[test]
fn source_discovers_new_runs() {
    let runs = tempfile::tempdir().unwrap();
    write_bundle(runs.path(), "run-a", "completed");
    let mut source = RunSource::new(runs.path());
    assert_eq!(source.ordered_run_ids(), vec!["run-a"]);

    write_bundle(runs.path(), "run-b", "running");
    let outcome = source.refresh_all();
    assert!(outcome.listing_changed);
    assert_eq!(source.ordered_run_ids().len(), 2);
}

#[test]
fn server_round_trip_with_live_updates() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-live", "running");

    // Start the server on an ephemeral port in its own runtime thread.
    let runs_dir = runs.path().to_path_buf();
    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            let _ = piw::server::serve_on(listener, runs_dir).await;
        });
    });
    let addr = addr_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let mut client = piw::client::RemoteRuns::connect(&format!("ws://{addr}/ws")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while client.summaries().is_empty() {
        assert!(Instant::now() < deadline, "no run listing before timeout");
        std::thread::sleep(Duration::from_millis(25));
    }
    client.watch("run-live");
    while client.view("run-live").is_none() {
        assert!(Instant::now() < deadline, "no snapshot before timeout");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(client.view("run-live").unwrap().events.len(), 1);
    assert!(client.view("run-live").unwrap().live);

    // Grow the bundle on disk (trace first, then the state projection, as
    // the writer does); the server must stream the change through.
    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "node",
            "type": "node_started", "runId": "run-live", "nodeId": "plan",
            "attemptId": "a1", "payload": {},
        }),
    );
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state_value("run-live", "running", 2, vec![])).unwrap(),
    )
    .unwrap();
    while client.view("run-live").map(|view| view.events.len()) != Some(2) {
        assert!(Instant::now() < deadline, "no patch before timeout");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(client.error(), None);

    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts/output.txt"), "remote artifact body").unwrap();
    client.request_artifact("run-live", "artifacts/output.txt");
    while client
        .artifact_content("run-live", "artifacts/output.txt")
        .is_none()
    {
        assert!(Instant::now() < deadline, "artifact response timed out");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(
        client
            .artifact_content("run-live", "artifacts/output.txt")
            .unwrap()
            .unwrap(),
        "remote artifact body"
    );

    client.request_artifact("run-live", "state.json");
    while client.artifact_content("run-live", "state.json").is_none() {
        assert!(
            Instant::now() < deadline,
            "rejected artifact response timed out"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        client
            .artifact_content("run-live", "state.json")
            .unwrap()
            .is_err(),
        "bundle documents must not be readable through fetch_artifact"
    );

    // A handshake carrying an Origin header (i.e. a browser) must be
    // rejected: the protocol is unauthenticated.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let rejected = runtime.block_on(async {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", "http://evil.example".parse().unwrap());
        tokio_tungstenite::connect_async(request).await
    });
    assert!(rejected.is_err(), "browser-origin handshake must fail");
}

#[test]
fn remote_client_reconnects_and_restores_selected_run() {
    fn start_server(
        addr: std::net::SocketAddr,
        runs_dir: std::path::PathBuf,
    ) -> (std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
                ready_tx.send(()).unwrap();
                tokio::select! {
                    _ = piw::server::serve_on(listener, runs_dir) => {}
                    _ = tokio::task::spawn_blocking(move || stop_rx.recv()) => {}
                }
            });
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        (stop_tx, worker)
    }

    let runs = tempfile::tempdir().unwrap();
    write_bundle(runs.path(), "run-reconnect", "running");
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = probe.local_addr().unwrap();
    drop(probe);

    let (stop, worker) = start_server(addr, runs.path().to_path_buf());
    let mut client = piw::client::RemoteRuns::connect(&format!("ws://{addr}/ws")).unwrap();
    client.watch("run-reconnect");
    let first_deadline = Instant::now() + Duration::from_secs(10);
    while client.view("run-reconnect").is_none() {
        assert!(
            Instant::now() < first_deadline,
            "initial snapshot timed out"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    stop.send(()).unwrap();
    worker.join().unwrap();
    let disconnect_deadline = Instant::now() + Duration::from_secs(5);
    while client.connected() {
        assert!(
            Instant::now() < disconnect_deadline,
            "client did not notice disconnect"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(client.status_label(), "reconnecting");

    // Change the bundle while the server is down. A restarted RunSource begins
    // at revision 0 again, so the client must not treat the same revision as
    // proof that its decoded cache is current.
    std::fs::write(
        runs.path().join("run-reconnect/state.json"),
        serde_json::to_string_pretty(&state_value("run-reconnect", "completed", 1, vec![]))
            .unwrap(),
    )
    .unwrap();

    let (stop, worker) = start_server(addr, runs.path().to_path_buf());
    let reconnect_deadline = Instant::now() + Duration::from_secs(15);
    while !client.connected() {
        assert!(
            Instant::now() < reconnect_deadline,
            "client did not reconnect"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    loop {
        if client
            .view("run-reconnect")
            .is_some_and(|view| view.state.status == piw::bundle::types::RunStatus::Completed)
        {
            break;
        }
        assert!(
            Instant::now() < reconnect_deadline,
            "fresh same-revision snapshot did not replace the decoded cache"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    stop.send(()).unwrap();
    worker.join().unwrap();
}

#[test]
fn terminal_run_stays_live_until_the_trace_tail_is_observed() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    let mut source = RunSource::new(runs.path());
    assert!(source.get("run-1").unwrap().live);

    // Terminal state and manifest referencing trace seq 2, while the trace
    // file still ends at seq 1 (the reader's poll can race the final
    // append). The run must not settle with the final event unseen.
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string(&state_value("run-1", "completed", 2, vec![])).unwrap(),
    )
    .unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    manifest["status"] = json!("completed");
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();
    source.refresh_all();
    let entry = source.get("run-1").unwrap();
    assert!(entry.live, "must stay live while the trace tail is missing");
    assert_eq!(entry.view()["events"].as_array().unwrap().len(), 1);

    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "run",
            "type": "run_completed", "runId": "run-1", "payload": {},
        }),
    );
    source.refresh_all();
    let entry = source.get("run-1").unwrap();
    assert_eq!(entry.view()["events"].as_array().unwrap().len(), 2);
    assert!(!entry.live, "fully observed terminal bundle must settle");
}

#[test]
fn session_files_are_discovered_before_the_manifest_names_them() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    let mut source = RunSource::new(runs.path());
    assert_eq!(
        source.get("run-1").unwrap().view()["session"],
        serde_json::Value::Null
    );

    // The writer creates session/ between manifest rewrites, so the manifest
    // does not name it yet; the reader must find it by convention.
    std::fs::create_dir_all(dir.join("session")).unwrap();
    std::fs::write(
        dir.join("session").join("binding.json"),
        serde_json::to_string(&json!({
            "schema": "pi-workflows.session-binding.v1",
            "runId": "run-1",
            "piSessionId": "s-1",
            "cwd": "/tmp",
            "boundAt": "2026-01-01T00:00:01.000Z",
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("session").join("entries.ndjson"),
        format!(
            "{}\n",
            serde_json::to_string(&json!({
                "seq": 1, "at": "2026-01-01T00:00:01.500Z",
                "entry": { "role": "user", "text": "hi" },
            }))
            .unwrap()
        ),
    )
    .unwrap();
    let event = |seq: u64| {
        json!({
            "seq": seq, "at": format!("2026-01-01T00:00:0{seq}.000Z"),
            "nodeId": "agent", "attemptId": "a-1", "turnId": "t1",
            "type": "turn_started", "payload": { "turnIndex": 0 },
        })
    };
    std::fs::write(
        dir.join("session").join("events.ndjson"),
        format!("{}\n", serde_json::to_string(&event(1)).unwrap()),
    )
    .unwrap();
    std::fs::write(
        dir.join("session").join("capture.json"),
        serde_json::to_string(&json!({
            "schema": "pi-workflows.session-capture.v1",
            "eventSchema": "pi-workflows.session-event.v1",
            "status": "recording", "eventCount": 1, "entryCount": 1,
            "lastEventSeq": 1,
        }))
        .unwrap(),
    )
    .unwrap();

    source.refresh_all();
    let view = source.get("run-1").unwrap().view();
    assert_eq!(view["session"]["binding"]["piSessionId"], json!("s-1"));
    assert_eq!(view["session"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(view["session"]["events"].as_array().unwrap().len(), 1);
    assert_eq!(view["session"]["capture"]["status"], json!("recording"));

    std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join("session").join("events.ndjson"))
        .unwrap()
        .write_all(format!("{}\n", serde_json::to_string(&event(2)).unwrap()).as_bytes())
        .unwrap();
    std::fs::write(
        dir.join("session").join("capture.json"),
        serde_json::to_string(&json!({
            "schema": "pi-workflows.session-capture.v1",
            "eventSchema": "pi-workflows.session-event.v1",
            "status": "recording", "eventCount": 2, "entryCount": 1,
            "lastEventSeq": 2,
        }))
        .unwrap(),
    )
    .unwrap();
    let outcome = source.refresh_all();
    let patch = &outcome.patches[0].2;
    let encoded = serde_json::to_value(patch).unwrap();
    assert!(encoded.to_string().contains("/session/events"));
    assert!(encoded.to_string().contains("/session/capture"));
    assert_eq!(
        source.get("run-1").unwrap().view()["session"]["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[cfg(unix)]
#[test]
fn symlinked_documents_outside_the_bundle_are_not_read() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.json");
    std::fs::write(
        &secret,
        serde_json::to_string(&state_value("run-1", "running", 1, vec![])).unwrap(),
    )
    .unwrap();

    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    std::fs::remove_file(dir.join("state.json")).unwrap();
    std::os::unix::fs::symlink(&secret, dir.join("state.json")).unwrap();

    // The manifest path is lexically fine, but the file resolves outside the
    // bundle; the run must be skipped rather than expose external content.
    let source = RunSource::new(runs.path());
    assert!(source.get("run-1").is_none());
}

#[test]
fn artifact_reads_enforce_the_actual_file_size() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts").join("blob.txt"), "x".repeat(100)).unwrap();

    // The reference lies about its size; the limit must apply to the file.
    let value = json!({
        "$artifact": {
            "path": "artifacts/blob.txt", "mediaType": "text/plain",
            "bytes": 5, "sha256": "0".repeat(64),
        },
    });
    let resolved = piw::bundle::reader::resolve_artifacts(&value, &dir, 10);
    assert_eq!(
        resolved,
        json!("«artifact 5B artifacts/blob.txt»"),
        "an oversized artifact must fall back to a placeholder"
    );
    let resolved = piw::bundle::reader::resolve_artifacts(&value, &dir, 1000);
    assert_eq!(resolved, json!("x".repeat(100)));
}

#[test]
fn escaped_artifact_sentinels_stay_literal() {
    let runs = tempfile::tempdir().unwrap();
    let dir = write_bundle(runs.path(), "run-1", "running");
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts").join("blob.txt"), "secret").unwrap();

    // User data that happens to look like a sentinel is persisted wrapped in
    // $escaped; decoding must unwrap it as literal data, not read the file.
    let literal = json!({
        "$artifact": {
            "path": "artifacts/blob.txt", "mediaType": "text/plain",
            "bytes": 6, "sha256": "0".repeat(64),
        },
    });
    let value = json!({ "$escaped": literal });
    assert_eq!(
        piw::bundle::reader::resolve_artifacts(&value, &dir, 1024),
        literal
    );
    assert_eq!(
        piw::bundle::reader::with_artifact_placeholders(&value),
        literal
    );
}

#[test]
fn non_loopback_binds_are_refused() {
    let runs = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    // On loopback, serve() runs forever; a non-loopback bind must instead
    // return an error immediately because the protocol is unauthenticated.
    let result = runtime.block_on(piw::server::serve(piw::server::ServeOptions {
        runs_dir: runs.path().to_path_buf(),
        bind: "0.0.0.0:0".to_string(),
    }));
    let error = result.unwrap_err().to_string();
    assert!(error.contains("non-loopback"), "unexpected error: {error}");
}
