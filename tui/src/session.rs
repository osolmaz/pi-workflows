//! Deterministic reducer for `session/events.ndjson`.

use crate::bundle::types::{
    SessionCapture, SessionCaptureStatus, SessionEntryRecord, SessionEventRecord,
    SESSION_CAPTURE_SCHEMA, SESSION_EVENT_SCHEMA,
};
use crate::format::parse_timestamp_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemporalContentBlock {
    #[serde(rename = "contentIndex")]
    pub content_index: u64,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemporalMessage {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub role: String,
    pub status: String,
    #[serde(rename = "entryId", skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub blocks: Vec<TemporalContentBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemporalTool {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub status: String,
    pub updates: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemporalSessionState {
    #[serde(rename = "throughSeq")]
    pub through_seq: u64,
    pub messages: Vec<TemporalMessage>,
    pub tools: Vec<TemporalTool>,
    #[serde(rename = "settledEntryIds")]
    pub settled_entry_ids: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureIntegrity {
    pub status: &'static str,
    pub diagnostics: Vec<String>,
}

fn event_integrity_diagnostics(
    entries: &[SessionEntryRecord],
    events: &[SessionEventRecord],
) -> Vec<String> {
    let entry_ids: HashSet<&str> = entries
        .iter()
        .filter_map(|record| record.entry.get("id")?.as_str())
        .collect();
    let mut turns: HashSet<&str> = HashSet::new();
    let mut messages: HashSet<&str> = HashSet::new();
    let mut tools: HashSet<&str> = HashSet::new();
    let mut diagnostics = Vec::new();
    for event in events {
        if event.at.is_empty()
            || event.node_id.is_empty()
            || event.attempt_id.is_empty()
            || event.event_type.is_empty()
            || !event.payload.is_object()
        {
            diagnostics.push(format!(
                "session event {} has an invalid envelope",
                event.seq
            ));
            continue;
        }
        let known = matches!(
            event.event_type.as_str(),
            "turn_started"
                | "turn_finished"
                | "message_started"
                | "assistant_event"
                | "message_finished"
                | "tool_execution_started"
                | "tool_execution_updated"
                | "tool_execution_finished"
        );
        if !known {
            continue;
        }
        let Some(turn_id) = event.turn_id.as_deref().filter(|id| !id.is_empty()) else {
            diagnostics.push(format!(
                "{} {} requires turnId",
                event.event_type, event.seq
            ));
            continue;
        };
        match event.event_type.as_str() {
            "turn_started" => {
                turns.insert(turn_id);
            }
            "turn_finished" => {
                if !turns.contains(turn_id) {
                    diagnostics.push(format!("turn_finished {} precedes turn_started", event.seq));
                }
            }
            event_type => {
                let Some(message_id) = event.message_id.as_deref().filter(|id| !id.is_empty())
                else {
                    diagnostics.push(format!("{event_type} {} requires messageId", event.seq));
                    continue;
                };
                match event_type {
                    "message_started" => {
                        if !turns.contains(turn_id) {
                            diagnostics.push(format!(
                                "message_started {} precedes turn_started",
                                event.seq
                            ));
                        }
                        messages.insert(message_id);
                    }
                    "assistant_event" => {
                        if !messages.contains(message_id) {
                            diagnostics.push(format!(
                                "assistant_event {} precedes message_started",
                                event.seq
                            ));
                        }
                    }
                    "message_finished" => {
                        if !messages.contains(message_id) {
                            diagnostics.push(format!(
                                "message_finished {} precedes message_started",
                                event.seq
                            ));
                        }
                        let settled = event
                            .payload
                            .get("settled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let entry_id = event.payload.get("entryId").and_then(Value::as_str);
                        if settled && entry_id.is_none_or(|id| !entry_ids.contains(id)) {
                            diagnostics.push(format!(
                                "message_finished {} references a missing entry",
                                event.seq
                            ));
                        } else if !settled && entry_id.is_some() {
                            diagnostics.push(format!(
                                "message_finished {} has entryId while unsettled",
                                event.seq
                            ));
                        }
                    }
                    "tool_execution_started" => {
                        if !messages.contains(message_id) {
                            diagnostics.push(format!(
                                "tool_execution_started {} precedes message_started",
                                event.seq
                            ));
                        }
                        if let Some(tool_id) =
                            event.tool_call_id.as_deref().filter(|id| !id.is_empty())
                        {
                            tools.insert(tool_id);
                        } else {
                            diagnostics.push(format!(
                                "tool_execution_started {} requires toolCallId",
                                event.seq
                            ));
                        }
                    }
                    "tool_execution_updated" | "tool_execution_finished" => {
                        let Some(tool_id) =
                            event.tool_call_id.as_deref().filter(|id| !id.is_empty())
                        else {
                            diagnostics
                                .push(format!("{event_type} {} requires toolCallId", event.seq));
                            continue;
                        };
                        if !tools.contains(tool_id) {
                            diagnostics.push(format!(
                                "{event_type} {} precedes tool_execution_started",
                                event.seq
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    diagnostics
}

pub fn assess_capture(
    session_bound: bool,
    entries: &[SessionEntryRecord],
    events: &[SessionEventRecord],
    capture: Option<&SessionCapture>,
    run_terminal: bool,
) -> CaptureIntegrity {
    if !session_bound {
        return CaptureIntegrity {
            status: "unavailable",
            diagnostics: Vec::new(),
        };
    }
    let Some(capture) = capture else {
        return CaptureIntegrity {
            status: "invalid",
            diagnostics: vec!["missing session capture status".into()],
        };
    };
    let mut diagnostics = Vec::new();
    if capture.schema != SESSION_CAPTURE_SCHEMA || capture.event_schema != SESSION_EVENT_SCHEMA {
        diagnostics.push("unsupported session capture schema".into());
    }
    if capture.status == SessionCaptureStatus::Failed && capture.failure.is_none() {
        diagnostics.push("failed session capture requires failure details".into());
    } else if capture.status != SessionCaptureStatus::Failed && capture.failure.is_some() {
        diagnostics.push("only failed session capture may contain failure details".into());
    }
    for (index, event) in events.iter().enumerate() {
        if event.seq != index as u64 + 1 {
            diagnostics.push(format!("session event sequence gap at {}", index + 1));
            break;
        }
    }
    diagnostics.extend(event_integrity_diagnostics(entries, events));
    if capture.status != SessionCaptureStatus::Recording {
        let last_seq = events.last().map_or(0, |event| event.seq);
        if capture.event_count != events.len() as u64
            || capture.entry_count != entries.len() as u64
            || capture.last_event_seq != last_seq
        {
            diagnostics.push("session capture counts do not match durable files".into());
        }
    } else if run_terminal {
        diagnostics.push("terminal run still reports recording capture".into());
    }
    if !diagnostics.is_empty() {
        return CaptureIntegrity {
            status: "invalid",
            diagnostics,
        };
    }
    match capture.status {
        SessionCaptureStatus::Recording => CaptureIntegrity {
            status: "recording",
            diagnostics,
        },
        SessionCaptureStatus::Complete => CaptureIntegrity {
            status: "complete",
            diagnostics,
        },
        SessionCaptureStatus::Failed => CaptureIntegrity {
            status: "failed",
            diagnostics: vec![capture
                .failure
                .as_ref()
                .map(|failure| failure.message.clone())
                .unwrap_or_else(|| "session capture failed".into())],
        },
    }
}

#[derive(Clone)]
struct MutableMessage {
    message_id: String,
    role: String,
    status: String,
    entry_id: Option<String>,
    blocks: BTreeMap<u64, TemporalContentBlock>,
}

fn string(payload: &Value, key: &str) -> Option<String> {
    payload.get(key)?.as_str().map(str::to_string)
}

fn index(payload: &Value) -> Option<u64> {
    payload.get("contentIndex")?.as_u64()
}

fn ensure_block<'a>(
    message: &'a mut MutableMessage,
    content_index: u64,
    kind: &str,
) -> &'a mut TemporalContentBlock {
    message
        .blocks
        .entry(content_index)
        .or_insert_with(|| TemporalContentBlock {
            content_index,
            kind: kind.to_string(),
            text: String::new(),
            value: None,
        })
}

fn fold_session_events(
    entries: &[SessionEntryRecord],
    events: &[SessionEventRecord],
    through_seq: u64,
    initial: Option<&TemporalSessionState>,
) -> TemporalSessionState {
    let known_entries: HashSet<String> = entries
        .iter()
        .filter_map(|record| record.entry.get("id")?.as_str().map(str::to_string))
        .collect();
    let mut messages: HashMap<String, MutableMessage> = HashMap::new();
    let mut message_order: Vec<String> = Vec::new();
    for message in initial.into_iter().flat_map(|state| &state.messages) {
        messages.insert(
            message.message_id.clone(),
            MutableMessage {
                message_id: message.message_id.clone(),
                role: message.role.clone(),
                status: message.status.clone(),
                entry_id: message.entry_id.clone(),
                blocks: message
                    .blocks
                    .iter()
                    .map(|block| (block.content_index, block.clone()))
                    .collect(),
            },
        );
        message_order.push(message.message_id.clone());
    }
    let mut tools: HashMap<String, TemporalTool> = HashMap::new();
    let mut tool_order: Vec<String> = Vec::new();
    for tool in initial.into_iter().flat_map(|state| &state.tools) {
        tools.insert(tool.tool_call_id.clone(), tool.clone());
        tool_order.push(tool.tool_call_id.clone());
    }
    let mut settled_entry_ids = initial
        .map(|state| state.settled_entry_ids.clone())
        .unwrap_or_default();
    let mut diagnostics = initial
        .map(|state| state.diagnostics.clone())
        .unwrap_or_default();
    let mut expected_seq = initial.map_or(1, |state| state.through_seq + 1);
    let mut last_seq = initial.map_or(0, |state| state.through_seq);

    for event in events {
        if event.seq <= last_seq {
            continue;
        }
        if event.seq > through_seq {
            break;
        }
        if event.seq != expected_seq {
            diagnostics.push(format!("session event sequence gap at {expected_seq}"));
            expected_seq = event.seq;
        }
        expected_seq += 1;
        last_seq = event.seq;

        match event.event_type.as_str() {
            "message_started" => {
                let Some(message_id) = event.message_id.as_ref() else {
                    diagnostics.push(format!("message_started {} has no messageId", event.seq));
                    continue;
                };
                if !messages.contains_key(message_id) {
                    messages.insert(
                        message_id.clone(),
                        MutableMessage {
                            message_id: message_id.clone(),
                            role: string(&event.payload, "role")
                                .unwrap_or_else(|| "unknown".into()),
                            status: "streaming".into(),
                            entry_id: None,
                            blocks: BTreeMap::new(),
                        },
                    );
                    message_order.push(message_id.clone());
                }
            }
            "assistant_event" => {
                let Some(message_id) = event.message_id.as_ref() else {
                    diagnostics.push(format!("assistant_event {} has no messageId", event.seq));
                    continue;
                };
                let Some(message) = messages.get_mut(message_id) else {
                    diagnostics.push(format!(
                        "assistant_event {} precedes message_started",
                        event.seq
                    ));
                    continue;
                };
                let assistant_type = string(&event.payload, "type").unwrap_or_default();
                let content_index = index(&event.payload);
                match (assistant_type.as_str(), content_index) {
                    ("text_start", Some(i)) => {
                        ensure_block(message, i, "text");
                    }
                    ("thinking_start", Some(i)) => {
                        ensure_block(message, i, "thinking");
                    }
                    ("toolcall_start", Some(i)) => {
                        ensure_block(message, i, "toolCall");
                    }
                    ("text_delta", Some(i))
                    | ("thinking_delta", Some(i))
                    | ("toolcall_delta", Some(i)) => {
                        let kind = match assistant_type.as_str() {
                            "text_delta" => "text",
                            "thinking_delta" => "thinking",
                            _ => "toolCall",
                        };
                        ensure_block(message, i, kind)
                            .text
                            .push_str(&string(&event.payload, "delta").unwrap_or_default());
                    }
                    ("text_end", Some(i)) | ("thinking_end", Some(i)) => {
                        let kind = if assistant_type == "text_end" {
                            "text"
                        } else {
                            "thinking"
                        };
                        let block = ensure_block(message, i, kind);
                        let content = string(&event.payload, "content").unwrap_or_default();
                        if block.text != content {
                            diagnostics
                                .push(format!("{assistant_type} mismatch for {message_id}:{i}"));
                            block.text = content;
                        }
                    }
                    ("toolcall_end", Some(i)) => {
                        ensure_block(message, i, "toolCall").value =
                            event.payload.get("toolCall").cloned();
                    }
                    ("done", _) => message.status = "finished".into(),
                    ("error", _) => message.status = "error".into(),
                    _ => {}
                }
            }
            "message_finished" => {
                let Some(message_id) = event.message_id.as_ref() else {
                    diagnostics.push(format!("message_finished {} has no messageId", event.seq));
                    continue;
                };
                let Some(message) = messages.get_mut(message_id) else {
                    diagnostics.push(format!(
                        "message_finished {} precedes message_started",
                        event.seq
                    ));
                    continue;
                };
                let settled = event
                    .payload
                    .get("settled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let entry_id = string(&event.payload, "entryId");
                if settled {
                    if let Some(entry_id) = entry_id {
                        message.status = "settled".into();
                        message.entry_id = Some(entry_id.clone());
                        settled_entry_ids.push(entry_id.clone());
                        if !known_entries.contains(&entry_id) {
                            diagnostics.push(format!("settled entry {entry_id} is missing"));
                        }
                    } else {
                        message.status = "unsettled".into();
                    }
                } else {
                    message.status = "unsettled".into();
                }
            }
            "tool_execution_started" => {
                let (Some(tool_call_id), Some(message_id)) =
                    (event.tool_call_id.as_ref(), event.message_id.as_ref())
                else {
                    diagnostics.push(format!(
                        "tool_execution_started {} is uncorrelated",
                        event.seq
                    ));
                    continue;
                };
                tools.insert(
                    tool_call_id.clone(),
                    TemporalTool {
                        tool_call_id: tool_call_id.clone(),
                        message_id: message_id.clone(),
                        tool_name: string(&event.payload, "toolName")
                            .unwrap_or_else(|| "tool".into()),
                        status: "running".into(),
                        updates: 0,
                        args: event.payload.get("args").cloned(),
                        result: None,
                    },
                );
                tool_order.push(tool_call_id.clone());
            }
            "tool_execution_updated" => {
                if let Some(tool) = event
                    .tool_call_id
                    .as_ref()
                    .and_then(|tool_call_id| tools.get_mut(tool_call_id))
                {
                    tool.updates += 1;
                } else {
                    diagnostics.push(format!(
                        "tool_execution_updated {} precedes start",
                        event.seq
                    ));
                }
            }
            "tool_execution_finished" => {
                if let Some(tool) = event
                    .tool_call_id
                    .as_ref()
                    .and_then(|tool_call_id| tools.get_mut(tool_call_id))
                {
                    tool.status = if event
                        .payload
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        "failed".into()
                    } else {
                        "finished".into()
                    };
                    tool.result = event.payload.get("result").cloned();
                } else {
                    diagnostics.push(format!(
                        "tool_execution_finished {} precedes start",
                        event.seq
                    ));
                }
            }
            _ => {}
        }
    }

    TemporalSessionState {
        through_seq: last_seq,
        messages: message_order
            .iter()
            .map(|message_id| {
                let message = messages.remove(message_id).unwrap();
                TemporalMessage {
                    message_id: message.message_id,
                    role: message.role,
                    status: message.status,
                    entry_id: message.entry_id,
                    blocks: message.blocks.into_values().collect(),
                }
            })
            .collect(),
        tools: tool_order
            .iter()
            .filter_map(|tool_call_id| tools.remove(tool_call_id))
            .collect(),
        settled_entry_ids,
        diagnostics,
    }
}

pub fn reduce_session_events(
    entries: &[SessionEntryRecord],
    events: &[SessionEventRecord],
    through_seq: u64,
) -> TemporalSessionState {
    fold_session_events(entries, events, through_seq, None)
}

/// Viewer-only checkpoint and timestamp index for efficient temporal seeks.
pub struct SessionReplayIndex<'a> {
    entries: &'a [SessionEntryRecord],
    events: &'a [SessionEventRecord],
    checkpoints: Vec<(u64, TemporalSessionState)>,
    timestamps: Vec<(i64, u64)>,
}

impl<'a> SessionReplayIndex<'a> {
    pub fn new(
        entries: &'a [SessionEntryRecord],
        events: &'a [SessionEventRecord],
        checkpoint_interval: usize,
    ) -> Self {
        let interval = checkpoint_interval.max(1);
        let mut checkpoints = Vec::new();
        let mut state = fold_session_events(entries, events, 0, None);
        checkpoints.push((0, state.clone()));
        for end in ((interval - 1)..events.len()).step_by(interval) {
            let seq = events[end].seq;
            state = fold_session_events(entries, events, seq, Some(&state));
            checkpoints.push((seq, state.clone()));
        }
        let mut last_timestamp = i64::MIN;
        let timestamps = events
            .iter()
            .map(|event| {
                let parsed = parse_timestamp_ms(&event.at).unwrap_or(last_timestamp);
                last_timestamp = last_timestamp.max(parsed);
                (last_timestamp, event.seq)
            })
            .collect();
        Self {
            entries,
            events,
            checkpoints,
            timestamps,
        }
    }

    pub fn state_at_seq(&self, through_seq: u64) -> TemporalSessionState {
        let initial = self
            .checkpoints
            .iter()
            .rev()
            .find(|(seq, _)| *seq <= through_seq)
            .map(|(_, state)| state);
        fold_session_events(self.entries, self.events, through_seq, initial)
    }

    pub fn seq_at_or_before(&self, timestamp_ms: i64) -> u64 {
        let index = self
            .timestamps
            .partition_point(|(at, _)| *at <= timestamp_ms);
        index
            .checked_sub(1)
            .and_then(|index| self.timestamps.get(index))
            .map_or(0, |(_, seq)| *seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capture() -> SessionCapture {
        SessionCapture {
            schema: SESSION_CAPTURE_SCHEMA.into(),
            event_schema: SESSION_EVENT_SCHEMA.into(),
            status: SessionCaptureStatus::Complete,
            event_count: 1,
            entry_count: 0,
            last_event_seq: 1,
            failure: None,
        }
    }

    fn event(event_type: &str) -> SessionEventRecord {
        SessionEventRecord {
            seq: 1,
            at: "2026-01-01T00:00:00.000Z".into(),
            node_id: "node".into(),
            attempt_id: "attempt".into(),
            turn_id: None,
            message_id: None,
            tool_call_id: None,
            event_type: event_type.into(),
            payload: json!({}),
        }
    }

    #[test]
    fn capture_accepts_unknown_events_but_rejects_invalid_known_events() {
        let unknown = event("future_event");
        assert_eq!(
            assess_capture(true, &[], &[unknown], Some(&capture()), true).status,
            "complete"
        );

        let invalid = event("message_finished");
        let integrity = assess_capture(true, &[], &[invalid], Some(&capture()), true);
        assert_eq!(integrity.status, "invalid");
        assert!(integrity
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("requires turnId")));
    }

    #[test]
    fn capture_rejects_failure_details_in_the_wrong_status() {
        let unknown = event("future_event");
        let missing_failure = SessionCapture {
            status: SessionCaptureStatus::Failed,
            ..capture()
        };
        assert_eq!(
            assess_capture(
                true,
                &[],
                std::slice::from_ref(&unknown),
                Some(&missing_failure),
                true,
            )
            .status,
            "invalid"
        );

        let unexpected_failure = SessionCapture {
            failure: Some(crate::bundle::types::SessionCaptureFailure {
                failed_at: "2026-01-01T00:00:00.000Z".into(),
                code: "failed".into(),
                message: "failed".into(),
            }),
            ..capture()
        };
        assert_eq!(
            assess_capture(true, &[], &[unknown], Some(&unexpected_failure), true).status,
            "invalid"
        );
    }
}
