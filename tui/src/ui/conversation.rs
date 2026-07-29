//! Conversation pane: formats verbatim Pi session entries (see
//! docs/run-bundles.md, `session/entries.ndjson`) into display lines, with
//! progressive reveal while replaying and highlighting of the entry range
//! that belongs to the selected step.

use crate::bundle::types::{ConversationRange, StepRecord};
use crate::format::sanitize_text;
use crate::theme::Palette;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

/// A session entry record: `{ seq, at, entry }` with the verbatim Pi entry.
fn entry_id(record: &Value) -> Option<&str> {
    record.pointer("/entry/id").and_then(Value::as_str)
}

fn entry_role(record: &Value) -> String {
    let entry = record.get("entry").unwrap_or(&Value::Null);
    let entry_type = entry.get("type").and_then(Value::as_str).unwrap_or("?");
    if entry_type == "message" {
        entry
            .pointer("/message/role")
            .and_then(Value::as_str)
            .unwrap_or("message")
            .to_string()
    } else {
        entry_type.to_string()
    }
}

/// Best-effort text extraction from a Pi message entry: string content is
/// used as-is; array content concatenates `text` parts and summarizes tool
/// calls and results.
fn entry_text(record: &Value) -> String {
    let entry = record.get("entry").unwrap_or(&Value::Null);
    let content = entry.pointer("/message/content");
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let mut pieces: Vec<String> = Vec::new();
            for part in parts {
                let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
                match part_type {
                    "text" | "thinking" => {
                        if let Some(text) = part
                            .get("text")
                            .or_else(|| part.get("thinking"))
                            .and_then(Value::as_str)
                        {
                            pieces.push(text.to_string());
                        }
                    }
                    "toolCall" | "tool_use" | "toolUse" => {
                        let name = part
                            .get("name")
                            .or_else(|| part.get("toolName"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let arguments = part
                            .get("arguments")
                            .or_else(|| part.get("input"))
                            .map(compact_json_preview)
                            .filter(|value| !value.is_empty())
                            .map(|value| format!(" {value}"))
                            .unwrap_or_default();
                        pieces.push(format!("[tool call: {name}]{arguments}"));
                    }
                    "toolResult" | "tool_result" => {
                        let failed = part
                            .get("isError")
                            .or_else(|| part.get("is_error"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let status = if failed { "failed" } else { "completed" };
                        let preview = part
                            .get("content")
                            .or_else(|| part.get("output"))
                            .map(compact_json_preview)
                            .filter(|value| !value.is_empty())
                            .map(|value| format!(": {value}"))
                            .unwrap_or_default();
                        pieces.push(format!("[tool result: {status}]{preview}"));
                    }
                    _ => {}
                }
            }
            pieces.join(" ")
        }
        _ => serde_json::to_string(entry).unwrap_or_default(),
    }
}

fn compact_json_preview(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    let sanitized = sanitize_text(&text);
    let mut chars = sanitized.chars();
    let preview: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

fn role_style(role: &str, palette: &Palette) -> Style {
    match role {
        "user" => Style::default()
            .fg(palette.user)
            .add_modifier(Modifier::BOLD),
        "assistant" => Style::default()
            .fg(palette.assistant)
            .add_modifier(Modifier::BOLD),
        "toolResult" | "tool" => Style::default().fg(palette.tool),
        _ => Style::default().fg(palette.muted),
    }
}

/// The inclusive index range of `entries` covered by a conversation range,
/// resolved by Pi entry id as the spec requires.
fn range_indices(entries: &[Value], range: &ConversationRange) -> Option<(usize, usize)> {
    let first = entries
        .iter()
        .position(|record| entry_id(record) == Some(range.first_entry_id.as_str()))?;
    let last = entries
        .iter()
        .position(|record| entry_id(record) == Some(range.last_entry_id.as_str()))?;
    Some((first.min(last), first.max(last)))
}

/// Build conversation lines. `visible_steps` controls progressive reveal:
/// when the replay position is before the end, entries past the last visible
/// step's conversation range stay hidden. The selected step's range is
/// marked in the gutter.
pub struct ConversationRenderOptions<'a> {
    pub at_latest_step: bool,
    pub width: usize,
    pub palette: &'a Palette,
    pub selected_entry: Option<usize>,
    pub payload_expanded: bool,
}

pub fn conversation_lines(
    entries: &[Value],
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    options: ConversationRenderOptions<'_>,
) -> Vec<Line<'static>> {
    let ConversationRenderOptions {
        at_latest_step,
        width,
        palette,
        selected_entry,
        payload_expanded,
    } = options;
    let reveal_until = if at_latest_step {
        entries.len()
    } else {
        visible_steps
            .iter()
            .rev()
            .find_map(|step| step.conversation.as_ref())
            .and_then(|range| range_indices(entries, range))
            .map(|(_, last)| last + 1)
            .unwrap_or(0)
    };
    let highlight = selected_step
        .and_then(|step| step.conversation.as_ref())
        .and_then(|range| range_indices(entries, range));

    let selected_entry =
        selected_entry.map(|selected| selected.min(reveal_until.saturating_sub(1)));
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (index, record) in entries.iter().take(reveal_until).enumerate() {
        let highlighted = highlight.is_some_and(|(first, last)| index >= first && index <= last);
        let gutter = if selected_entry == Some(index) {
            "▶"
        } else if highlighted {
            "▌"
        } else {
            " "
        };
        let gutter_style = Style::default().fg(palette.replay_focus);
        let role = sanitize_text(&entry_role(record));
        let text = sanitize_text(&entry_text(record));
        let header = format!("{role}:");
        lines.push(Line::from(vec![
            Span::styled(gutter.to_string(), gutter_style),
            Span::styled(header, role_style(&role, palette)),
        ]));
        let body_width = width.saturating_sub(3).max(20);
        for chunk in wrap_text(&text, body_width) {
            lines.push(Line::from(vec![
                Span::styled(gutter.to_string(), gutter_style),
                Span::raw("  "),
                Span::raw(chunk),
            ]));
        }
        if selected_entry == Some(index) && payload_expanded {
            let raw = serde_json::to_string_pretty(record).unwrap_or_else(|_| record.to_string());
            for logical_line in raw.lines() {
                for chunk in wrap_text(&sanitize_text(logical_line), body_width) {
                    lines.push(Line::from(vec![
                        Span::styled(gutter.to_string(), gutter_style),
                        Span::styled("  raw: ", Style::default().fg(palette.tool)),
                        Span::styled(chunk, Style::default().fg(palette.subtext)),
                    ]));
                }
            }
        }
        lines.push(Line::from(""));
    }
    if reveal_until < entries.len() {
        lines.push(Line::from(Span::styled(
            format!(
                "… {} more entries past this step",
                entries.len() - reveal_until
            ),
            Style::default().fg(palette.muted),
        )));
    }
    lines
}

/// Simple character wrap; conversation text is already sanitized to a single
/// logical line per entry.
fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(width.max(1))
        .map(|chunk| chunk.iter().collect())
        .collect()
}
