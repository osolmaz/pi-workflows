//! Test helper: write a minimal, spec-valid run bundle to disk.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn state_value(run_id: &str, status: &str, trace_seq: u64, steps: Vec<Value>) -> Value {
    json!({
        "schema": "pi-workflows.run-state.v1",
        "traceSeq": trace_seq,
        "runId": run_id,
        "workflowName": "demo",
        "startedAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:01.000Z",
        "status": status,
        "input": {},
        "outputs": {},
        "results": {},
        "steps": steps,
    })
}

pub fn write_bundle(runs_dir: &Path, run_id: &str, status: &str) -> PathBuf {
    let dir = runs_dir.join(run_id);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = json!({
        "schema": "pi-workflows.run-bundle.v1",
        "runId": run_id,
        "workflowName": "demo",
        "startedAt": "2026-01-01T00:00:00.000Z",
        "status": status,
        "traceSchema": "pi-workflows.trace-event.v1",
        "paths": {
            "workflow": "workflow.json",
            "state": "state.json",
            "trace": "trace.ndjson",
            "artifacts": "artifacts",
        },
    });
    let workflow = json!({
        "schema": "pi-workflows.definition-snapshot.v1",
        "name": "demo",
        "startAt": "plan",
        "nodes": {
            "plan": { "nodeType": "agent" },
            "ship": { "nodeType": "action" },
        },
        "edges": [ { "from": "plan", "to": "ship" } ],
    });
    let trace = json!({
        "seq": 1,
        "at": "2026-01-01T00:00:00.000Z",
        "scope": "run",
        "type": "run_started",
        "runId": run_id,
        "payload": {},
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("workflow.json"),
        serde_json::to_string_pretty(&workflow).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("state.json"),
        serde_json::to_string_pretty(&state_value(run_id, status, 1, vec![])).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("trace.ndjson"),
        format!("{}\n", serde_json::to_string(&trace).unwrap()),
    )
    .unwrap();
    dir
}

pub fn append_trace(dir: &Path, event: &Value) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(dir.join("trace.ndjson"))
        .unwrap();
    writeln!(file, "{}", serde_json::to_string(event).unwrap()).unwrap();
}
