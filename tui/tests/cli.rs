use std::process::Command;

#[cfg(unix)]
use piw::protocol::{canonical_json, PROTOCOL_ID};
#[cfg(unix)]
use serde_json::{json, Value};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::mpsc;
#[cfg(unix)]
use std::time::Duration;

fn piw() -> Command {
    Command::new(env!("CARGO_BIN_EXE_piw"))
}

#[test]
fn once_requires_a_run_id() {
    let output = piw().arg("--once").output().expect("piw should start");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(stderr.contains("required arguments were not provided"));
    assert!(stderr.contains("<RUN_ID>"));
}

#[test]
fn help_describes_one_frame_rendering() {
    let output = piw().arg("--help").output().expect("piw should start");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout should be UTF-8");
    assert!(stdout.contains("--once"));
    assert!(stdout.contains("Render one complete view as plain text and exit"));
}

#[cfg(unix)]
#[test]
fn once_reports_an_invalid_snapshot_without_waiting_for_the_loading_timeout() {
    let home = tempfile::tempdir().unwrap();
    let socket_path = home.path().join(".pi/agent/workflows/host/host.sock");
    std::fs::create_dir_all(socket_path.parent().unwrap()).unwrap();
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("protocol/fixtures/run-view-controls-v1.json");
    let fixture: Value = serde_json::from_slice(&std::fs::read(fixture_path).unwrap()).unwrap();
    let mut snapshot = fixture["agentSnapshot"].clone();
    snapshot.as_object_mut().unwrap().remove("display");
    let hello = canonical_json(&json!({
        "schema":PROTOCOL_ID,
        "type":"hello",
        "connectionId":"test-connection",
        "packageVersion":env!("CARGO_PKG_VERSION")
    }))
    .unwrap();
    let event = canonical_json(&json!({
        "schema":PROTOCOL_ID,
        "type":"event",
        "subscriptionId":"run:run-agent-controls",
        "event":"run_snapshot",
        "revision":4,
        "runId":"run-agent-controls",
        "payload":snapshot
    }))
    .unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async move {
            use tokio::io::AsyncWriteExt;
            let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
            ready_tx.send(()).unwrap();
            let (probe, _) = listener.accept().await.unwrap();
            drop(probe);
            let (mut client, _) = listener.accept().await.unwrap();
            client.write_all(hello.as_bytes()).await.unwrap();
            client.write_all(b"\n").await.unwrap();
            client.write_all(event.as_bytes()).await.unwrap();
            client.write_all(b"\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
    });
    ready_rx.recv().unwrap();

    let started = std::time::Instant::now();
    let output = piw()
        .env("HOME", home.path())
        .args(["--once", "run-agent-controls"])
        .output()
        .expect("piw should start");
    server.join().unwrap();

    assert!(!output.status.success());
    assert!(started.elapsed() < Duration::from_secs(5));
    let stderr = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(stderr.contains("Workflow run snapshot is invalid: display is missing."));
    assert!(!stderr.contains("timed out waiting for workflow run"));
}
