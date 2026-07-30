//! Deterministic reducer for `session/events.ndjson`.

use crate::bundle::types::{
    SessionCapture, SessionCaptureStatus, SessionEntryRecord, SessionEventRecord,
    SESSION_CAPTURE_SCHEMA, SESSION_EVENT_SCHEMA,
};
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
    for (index, event) in events.iter().enumerate() {
        if event.seq != index as u64 + 1 {
            diagnostics.push(format!("session event sequence gap at {}", index + 1));
            break;
        }
    }
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

pub fn reduce_session_events(
    entries: &[SessionEntryRecord],
    events: &[SessionEventRecord],
    through_seq: u64,
) -> TemporalSessionState {
    let known_entries: HashSet<String> = entries
        .iter()
        .filter_map(|record| record.entry.get("id")?.as_str().map(str::to_string))
        .collect();
    let mut messages: HashMap<String, MutableMessage> = HashMap::new();
    let mut message_order: Vec<String> = Vec::new();
    let mut tools: HashMap<String, TemporalTool> = HashMap::new();
    let mut tool_order: Vec<String> = Vec::new();
    let mut settled_entry_ids = Vec::new();
    let mut diagnostics = Vec::new();
    let mut expected_seq = 1;
    let mut last_seq = 0;

    for event in events.iter().filter(|event| event.seq <= through_seq) {
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
