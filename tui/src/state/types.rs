//! Serde types mirroring the SQLite workflow state documents specified in
//! `docs/run-database runs.md`. Unknown fields are tolerated everywhere so database runs
//! written by newer writers within the same schema version stay readable.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const RUN_BUNDLE_SCHEMA: &str = "pi-workflows.run-run.v1";
pub const RUN_STATE_SCHEMA: &str = "pi-workflows.run-state.v1";
pub const DEFINITION_SNAPSHOT_SCHEMA: &str = "pi-workflows.definition-snapshot.v1";
pub const SESSION_BINDING_SCHEMA: &str = "pi-workflows.session-binding.v1";
pub const SESSION_EVENT_SCHEMA: &str = "pi-workflows.session-event.v1";
pub const SESSION_CAPTURE_SCHEMA: &str = "pi-workflows.session-capture.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Waiting,
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, RunStatus::Running)
    }

    pub fn label(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Waiting => "waiting",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::TimedOut => "timed_out",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeOutcome {
    Ok,
    TimedOut,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowSource {
    Builtin { id: String, revision: String },
    File { path: String, hash: String },
}

impl WorkflowSource {
    pub fn display(&self) -> String {
        match self {
            WorkflowSource::Builtin { id, revision } => format!("builtin:{id}@{revision}"),
            WorkflowSource::File { path, .. } => path.clone(),
        }
    }
}

#[cfg(test)]
mod workflow_source_tests {
    use super::WorkflowSource;

    #[test]
    fn parses_and_displays_each_source_kind() {
        let builtin: WorkflowSource =
            serde_json::from_str(r#"{"kind":"builtin","id":"monitor","revision":"1"}"#)
                .expect("built-in source should parse");
        let file: WorkflowSource =
            serde_json::from_str(r#"{"kind":"file","path":"/tmp/demo.workflow.ts","hash":"abc"}"#)
                .expect("file source should parse");

        assert_eq!(builtin.display(), "builtin:monitor@1");
        assert_eq!(file.display(), "/tmp/demo.workflow.ts");
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "workflowName")]
    pub workflow_name: String,
    #[serde(rename = "runTitle", skip_serializing_if = "Option::is_none")]
    pub run_title: Option<String>,
    #[serde(rename = "workflowSource", skip_serializing_if = "Option::is_none")]
    pub workflow_source: Option<WorkflowSource>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub status: RunStatus,
    #[serde(rename = "traceSchema")]
    pub trace_schema: String,
    pub paths: ManifestPaths,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestPaths {
    pub workflow: String,
    pub state: String,
    pub trace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub schema: String,
    #[serde(rename = "traceSeq")]
    pub trace_seq: u64,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "workflowName")]
    pub workflow_name: String,
    #[serde(rename = "runTitle", skip_serializing_if = "Option::is_none")]
    pub run_title: Option<String>,
    #[serde(rename = "workflowSource", skip_serializing_if = "Option::is_none")]
    pub workflow_source: Option<WorkflowSource>,
    #[serde(rename = "parentRunId", skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(rename = "carriedStepCount", skip_serializing_if = "Option::is_none")]
    pub carried_step_count: Option<u64>,
    #[serde(rename = "workflowSources", skip_serializing_if = "Option::is_none")]
    pub workflow_sources: Option<Vec<Value>>,
    #[serde(rename = "definitionDigest", skip_serializing_if = "Option::is_none")]
    pub definition_digest: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub status: RunStatus,
    pub input: Value,
    pub outputs: BTreeMap<String, Value>,
    pub results: BTreeMap<String, NodeResult>,
    pub steps: Vec<StepRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates: Option<Vec<Value>>,
    #[serde(rename = "currentNode", skip_serializing_if = "Option::is_none")]
    pub current_node: Option<String>,
    #[serde(rename = "currentAttemptId", skip_serializing_if = "Option::is_none")]
    pub current_attempt_id: Option<String>,
    #[serde(
        rename = "currentNodeStartedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_node_started_at: Option<String>,
    #[serde(
        rename = "currentSettingsScopeId",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_settings_scope_id: Option<String>,
    #[serde(
        rename = "currentSettingsChangeNumber",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_settings_change_number: Option<u64>,
    #[serde(
        rename = "currentSettingsHash",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_settings_hash: Option<String>,
    #[serde(rename = "statusDetail", skip_serializing_if = "Option::is_none")]
    pub status_detail: Option<String>,
    #[serde(rename = "humanDecision", skip_serializing_if = "Option::is_none")]
    pub human_decision: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(rename = "waitingOn", skip_serializing_if = "Option::is_none")]
    pub waiting_on: Option<String>,
    #[serde(rename = "finalOutput", skip_serializing_if = "Option::is_none")]
    pub final_output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeResult {
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "nodeType")]
    pub node_type: String,
    pub outcome: NodeOutcome,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepRecord {
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "nodeType")]
    pub node_type: String,
    pub outcome: NodeOutcome,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: String,
    /// Full prompt for agent steps (`null` otherwise); may be an
    /// externalized `$artifact` object in persisted form.
    pub prompt: Value,
    pub output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionReceipt>,
    #[serde(rename = "assistantMessage", skip_serializing_if = "Option::is_none")]
    pub assistant_message: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationRange>,
    #[serde(rename = "settingsScopeId", skip_serializing_if = "Option::is_none")]
    pub settings_scope_id: Option<String>,
    #[serde(
        rename = "settingsChangeNumber",
        skip_serializing_if = "Option::is_none"
    )]
    pub settings_change_number: Option<u64>,
    #[serde(rename = "settingsHash", skip_serializing_if = "Option::is_none")]
    pub settings_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionReceipt {
    #[serde(rename = "actionType")]
    pub action_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<Value>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationRange {
    #[serde(rename = "firstEntryId")]
    pub first_entry_id: String,
    #[serde(rename = "lastEntryId")]
    pub last_entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceEvent {
    pub seq: u64,
    pub at: String,
    pub scope: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "nodeId", skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(rename = "attemptId", skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionBinding {
    pub schema: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "piSessionId")]
    pub pi_session_id: String,
    #[serde(rename = "piSessionFile", skip_serializing_if = "Option::is_none")]
    pub pi_session_file: Option<String>,
    pub cwd: String,
    #[serde(rename = "boundAt")]
    pub bound_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEntryRecord {
    pub seq: u64,
    pub at: String,
    pub entry: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEventRecord {
    pub seq: u64,
    pub at: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCaptureStatus {
    Recording,
    Complete,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCaptureFailure {
    #[serde(rename = "failedAt")]
    pub failed_at: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCapture {
    pub schema: String,
    #[serde(rename = "eventSchema")]
    pub event_schema: String,
    pub status: SessionCaptureStatus,
    #[serde(rename = "eventCount")]
    pub event_count: u64,
    #[serde(rename = "entryCount")]
    pub entry_count: u64,
    #[serde(rename = "lastEventSeq")]
    pub last_event_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SessionCaptureFailure>,
}

// --- Definition snapshot ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefinitionSnapshot {
    pub schema: String,
    pub name: String,
    #[serde(rename = "startAt")]
    pub start_at: String,
    /// Insertion order matters (BFS fallback order, display order), so the
    /// map preserves the document order of the JSON object.
    pub nodes: serde_json::Map<String, Value>,
    pub edges: Vec<EdgeDef>,
}

impl DefinitionSnapshot {
    pub fn node_type(&self, node_id: &str) -> Option<&str> {
        self.nodes
            .get(node_id)?
            .get("nodeType")
            .and_then(Value::as_str)
    }

    pub fn node_action_execution(&self, node_id: &str) -> Option<&str> {
        self.nodes
            .get(node_id)?
            .get("actionExecution")
            .and_then(Value::as_str)
    }

    pub fn node_ids(&self) -> impl Iterator<Item = &str> {
        self.nodes.keys().map(String::as_str)
    }
}

/// A workflow edge: either a simple `from -> to` or a labelled switch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EdgeDef {
    Simple { from: String, to: String },
    Switch { from: String, switch: SwitchDef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SwitchDef {
    pub on: String,
    /// Case order matters for edge expansion; preserve document order.
    pub cases: serde_json::Map<String, Value>,
}

/// An artifact reference extracted from a `{"$artifact": …}` sentinel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub path: String,
    #[serde(rename = "mediaType")]
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Detect the `$artifact` sentinel: an object whose only key is `$artifact`.
pub fn as_artifact_ref(value: &Value) -> Option<ArtifactRef> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    serde_json::from_value(object.get("$artifact")?.clone()).ok()
}

/// Unwrap one level of `{"$escaped": …}` if present.
pub fn as_escaped(value: &Value) -> Option<&Value> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get("$escaped")
}
