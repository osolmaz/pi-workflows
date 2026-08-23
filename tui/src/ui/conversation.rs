//! Conversation pane: formats verbatim Pi session entries (see
//! docs/run-database runs.md, `session/entries.ndjson`) into display lines, with
//! progressive reveal while replaying and highlighting of the entry range
//! that belongs to the selected step.

use crate::format::sanitize_text;
use crate::session::{SessionReplayIndex, TemporalMessage, TemporalSessionState};
use crate::state::types::{ConversationRange, SessionEntryRecord, SessionEventRecord, StepRecord};
use crate::theme::Palette;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

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
    /// Inclusive temporal sequence; `None` folds the full event journal.
    pub through_event_seq: Option<u64>,
    pub width: usize,
    pub palette: &'a Palette,
    pub run_dir: Option<&'a Path>,
    pub remote_artifacts: &'a HashMap<String, std::result::Result<String, String>>,
    pub selected_entry: Option<usize>,
    pub payload_expanded: bool,
}

pub fn conversation_lines(
    entries: &[Value],
    events: &[Value],
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    options: ConversationRenderOptions<'_>,
) -> Vec<Line<'static>> {
    let ConversationRenderOptions {
        at_latest_step,
        through_event_seq,
        width,
        palette,
        run_dir,
        remote_artifacts,
        selected_entry,
        payload_expanded,
    } = options;
    if !events.is_empty() {
        return temporal_conversation_lines(
            entries,
            events,
            through_event_seq,
            TemporalRenderContext {
                width,
                palette,
                run_dir,
                remote_artifacts,
                selected_entry,
                payload_expanded,
            },
        );
    }
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

struct TemporalRenderContext<'a> {
    width: usize,
    palette: &'a Palette,
    run_dir: Option<&'a Path>,
    remote_artifacts: &'a HashMap<String, std::result::Result<String, String>>,
    selected_entry: Option<usize>,
    payload_expanded: bool,
}

fn temporal_conversation_lines(
    entries: &[Value],
    events: &[Value],
    through_event_seq: Option<u64>,
    context: TemporalRenderContext<'_>,
) -> Vec<Line<'static>> {
    let parsed_entries: Result<Vec<SessionEntryRecord>, _> = entries
        .iter()
        .cloned()
        .map(serde_json::from_value)
        .collect();
    let parsed_events: Result<Vec<SessionEventRecord>, _> =
        events.iter().cloned().map(serde_json::from_value).collect();
    let (Ok(parsed_entries), Ok(parsed_events)) = (parsed_entries, parsed_events) else {
        return vec![Line::from(Span::styled(
            "invalid temporal session record",
            Style::default().fg(context.palette.error),
        ))];
    };
    let through = through_event_seq.unwrap_or(u64::MAX);
    let index = SessionReplayIndex::new(&parsed_entries, &parsed_events, 256);
    let state = index.state_at_seq(through);
    render_temporal_state(
        entries,
        &state,
        &context,
        parsed_events
            .iter()
            .filter(|event| event.seq > through)
            .count(),
    )
}

fn render_temporal_state(
    entries: &[Value],
    state: &TemporalSessionState,
    context: &TemporalRenderContext<'_>,
    future_events: usize,
) -> Vec<Line<'static>> {
    let selected = context
        .selected_entry
        .map(|index| index.min(state.messages.len().saturating_sub(1)));
    let body_width = context.width.saturating_sub(3).max(20);
    let palette = context.palette;
    let run_dir = context.run_dir;
    let remote_artifacts = context.remote_artifacts;
    let payload_expanded = context.payload_expanded;
    let mut lines = Vec::new();
    for (index, message) in state.messages.iter().enumerate() {
        let gutter = if selected == Some(index) { "▶" } else { " " };
        if let Some(record) = message
            .entry_id
            .as_deref()
            .and_then(|id| entries.iter().find(|record| entry_id(record) == Some(id)))
        {
            push_entry(&mut lines, record, gutter, body_width, palette);
        } else {
            push_temporal_message(
                &mut lines,
                message,
                gutter,
                body_width,
                palette,
                run_dir,
                remote_artifacts,
            );
        }
        for tool in state
            .tools
            .iter()
            .filter(|tool| tool.message_id == message.message_id)
        {
            let summary = format!(
                "tool {} [{}] · {} update{}",
                sanitize_text(&tool.tool_name),
                tool.status,
                tool.updates,
                if tool.updates == 1 { "" } else { "s" }
            );
            lines.push(Line::from(vec![
                Span::styled(
                    gutter.to_string(),
                    Style::default().fg(palette.replay_focus),
                ),
                Span::styled("  ", Style::default()),
                Span::styled(summary, Style::default().fg(palette.tool)),
            ]));
            if let Some(args) = tool.args.as_ref() {
                push_body_line(
                    &mut lines,
                    gutter,
                    &format!(
                        "args: {}",
                        super::preview_value(args, run_dir, remote_artifacts)
                    ),
                    body_width,
                    Style::default().fg(palette.subtext),
                    palette,
                );
            }
            if let Some(result) = tool.result.as_ref() {
                push_body_line(
                    &mut lines,
                    gutter,
                    &format!(
                        "result: {}",
                        super::preview_value(result, run_dir, remote_artifacts)
                    ),
                    body_width,
                    Style::default().fg(palette.subtext),
                    palette,
                );
            }
        }
        if selected == Some(index) && payload_expanded {
            let value = serde_json::to_value(message).unwrap_or(Value::Null);
            let resolved = super::resolve_detail_value(&value, run_dir, remote_artifacts);
            let raw = serde_json::to_string_pretty(&resolved).unwrap_or_default();
            for logical_line in raw.lines() {
                push_body_line(
                    &mut lines,
                    gutter,
                    &format!("raw: {}", sanitize_text(logical_line)),
                    body_width,
                    Style::default().fg(palette.subtext),
                    palette,
                );
            }
        }
        lines.push(Line::from(""));
    }
    if state.messages.is_empty() {
        lines.push(Line::from(Span::styled(
            "before first session event",
            Style::default().fg(palette.muted),
        )));
    }
    if future_events > 0 {
        lines.push(Line::from(Span::styled(
            format!("… {future_events} more session events past this position"),
            Style::default().fg(palette.muted),
        )));
    }
    for diagnostic in &state.diagnostics {
        lines.push(Line::from(Span::styled(
            format!("capture: {}", sanitize_text(diagnostic)),
            Style::default().fg(palette.warning),
        )));
    }
    lines
}

fn push_entry(
    lines: &mut Vec<Line<'static>>,
    record: &Value,
    gutter: &str,
    body_width: usize,
    palette: &Palette,
) {
    let role = sanitize_text(&entry_role(record));
    lines.push(Line::from(vec![
        Span::styled(
            gutter.to_string(),
            Style::default().fg(palette.replay_focus),
        ),
        Span::styled(format!("{role}:"), role_style(&role, palette)),
        Span::styled(" settled", Style::default().fg(palette.muted)),
    ]));
    push_body_line(
        lines,
        gutter,
        &sanitize_text(&entry_text(record)),
        body_width,
        Style::default(),
        palette,
    );
}

fn push_temporal_message(
    lines: &mut Vec<Line<'static>>,
    message: &TemporalMessage,
    gutter: &str,
    body_width: usize,
    palette: &Palette,
    run_dir: Option<&Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
) {
    let role = sanitize_text(&message.role);
    lines.push(Line::from(vec![
        Span::styled(
            gutter.to_string(),
            Style::default().fg(palette.replay_focus),
        ),
        Span::styled(format!("{role}:"), role_style(&role, palette)),
        Span::styled(
            format!(" {}", message.status),
            Style::default().fg(palette.muted),
        ),
    ]));
    if message.blocks.is_empty() {
        push_body_line(
            lines,
            gutter,
            "(waiting for content)",
            body_width,
            Style::default().fg(palette.muted),
            palette,
        );
    }
    for block in &message.blocks {
        let (label, style) = match block.kind.as_str() {
            "thinking" => ("thinking: ", Style::default().fg(palette.muted)),
            "toolCall" => ("tool call: ", Style::default().fg(palette.tool)),
            _ => ("", Style::default()),
        };
        let value = block
            .value
            .as_ref()
            .map(|value| super::preview_value(value, run_dir, remote_artifacts))
            .filter(|value| !value.is_empty());
        let body = match (block.text.is_empty(), value) {
            (false, Some(value)) => format!("{label}{} {value}", sanitize_text(&block.text)),
            (false, None) => format!("{label}{}", sanitize_text(&block.text)),
            (true, Some(value)) => format!("{label}{value}"),
            (true, None) => format!("{label}(streaming…)").trim().to_string(),
        };
        push_body_line(lines, gutter, &body, body_width, style, palette);
    }
}

fn push_body_line(
    lines: &mut Vec<Line<'static>>,
    gutter: &str,
    text: &str,
    body_width: usize,
    style: Style,
    palette: &Palette,
) {
    for chunk in wrap_text(text, body_width) {
        lines.push(Line::from(vec![
            Span::styled(
                gutter.to_string(),
                Style::default().fg(palette.replay_focus),
            ),
            Span::raw("  "),
            Span::styled(chunk, style),
        ]));
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Palette;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/session-events/normal.json")).unwrap()
    }

    fn rendered(through_event_seq: Option<u64>) -> String {
        let fixture = fixture();
        conversation_lines(
            fixture.get("entries").unwrap().as_array().unwrap(),
            fixture.get("events").unwrap().as_array().unwrap(),
            &[],
            None,
            ConversationRenderOptions {
                at_latest_step: through_event_seq.is_none(),
                through_event_seq,
                width: 100,
                palette: &Palette::catppuccin(),
                run_dir: None,
                remote_artifacts: &HashMap::new(),
                selected_entry: None,
                payload_expanded: false,
            },
        )
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n")
    }

    #[test]
    fn temporal_replay_shows_partial_then_verbatim_content() {
        let partial = rendered(Some(7));
        assert!(partial.contains("streaming"));
        assert!(partial.contains("thinking: plan"));
        assert!(partial.contains("hello"));
        assert!(partial.contains("more session events"));

        let settled = rendered(None);
        assert!(settled.contains("assistant: settled"));
        assert!(settled.contains("plan hello"));
        assert!(settled.contains("tool read [finished] · 1 update"));
        assert!(settled.contains("args: {\"path\":\"README.md\"}"));
        assert!(settled.contains("result: {\"content\":\"ok\"}"));
        assert!(!settled.contains("more session events"));
    }

    #[test]
    fn malformed_temporal_records_are_explicit() {
        let lines = conversation_lines(
            &[],
            &[json!({"seq": "bad"})],
            &[],
            None,
            ConversationRenderOptions {
                at_latest_step: true,
                through_event_seq: None,
                width: 80,
                palette: &Palette::catppuccin(),
                run_dir: None,
                remote_artifacts: &HashMap::new(),
                selected_entry: None,
                payload_expanded: false,
            },
        );
        assert!(lines[0]
            .to_string()
            .contains("invalid temporal session record"));
    }
}
