//! Live-update tests: the run source's snapshot/patch invariant (applying
//! the patch stream to an old view reproduces the current view), and an
//! end-to-end WebSocket round trip through `piw serve` and the client.

mod common;

use common::{append_trace, state_value, write_bundle};
use piw::protocol::apply_patch;
use piw::source::RunSource;
use serde_json::json;
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

    // Grow the bundle on disk; the server must stream the change through.
    append_trace(
        &dir,
        &json!({
            "seq": 2, "at": "2026-01-01T00:00:02.000Z", "scope": "node",
            "type": "node_started", "runId": "run-live", "nodeId": "plan",
            "attemptId": "a1", "payload": {},
        }),
    );
    while client.view("run-live").map(|view| view.events.len()) != Some(2) {
        assert!(Instant::now() < deadline, "no patch before timeout");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(client.error(), None);

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
