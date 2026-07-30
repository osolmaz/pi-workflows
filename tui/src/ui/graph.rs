//! Graph pane: converts the rendered `CharCanvas` into ratatui lines and
//! applies a scroll/zoom viewport.

use crate::canvas::{CanvasStyle, StyledRun};
use crate::theme::Palette;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

pub fn style_for(style: CanvasStyle, palette: &Palette) -> Style {
    match style {
        CanvasStyle::Plain => Style::default().fg(palette.text),
        CanvasStyle::Dim => Style::default().fg(palette.muted),
        CanvasStyle::Taken => Style::default().fg(palette.success),
        CanvasStyle::ActiveEdge => Style::default()
            .fg(palette.running)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Back => Style::default().fg(palette.warning),
        CanvasStyle::NodeText => Style::default().fg(palette.text).bg(palette.node_bg),
        CanvasStyle::NodeDim => Style::default().fg(palette.muted).bg(palette.node_bg),
        CanvasStyle::NodeFocusText => Style::default().fg(palette.text).bg(palette.node_focus_bg),
        CanvasStyle::NodeHeader => Style::default()
            .fg(palette.text)
            .bg(palette.panel_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::NodeBorderDim => Style::default().fg(palette.muted).bg(palette.canvas_bg),
        CanvasStyle::NodeBorderActive => Style::default()
            .fg(palette.running)
            .bg(palette.canvas_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::NodeBorderReplay => Style::default()
            .fg(palette.replay_focus)
            .bg(palette.canvas_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::NodeBorderOk => Style::default().fg(palette.success).bg(palette.canvas_bg),
        CanvasStyle::NodeBorderFail => Style::default().fg(palette.error).bg(palette.canvas_bg),
        CanvasStyle::NodeBorderTimedOut => {
            Style::default().fg(palette.timed_out).bg(palette.canvas_bg)
        }
        CanvasStyle::NodeBorderWarn => Style::default().fg(palette.warning).bg(palette.canvas_bg),
        CanvasStyle::NodeBorderCancelled => {
            Style::default().fg(palette.cancelled).bg(palette.canvas_bg)
        }
        CanvasStyle::Active => Style::default()
            .fg(palette.running)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Replay => Style::default()
            .fg(palette.replay_focus)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Ok => Style::default().fg(palette.success).bg(palette.node_bg),
        CanvasStyle::Fail => Style::default().fg(palette.error).bg(palette.node_bg),
        CanvasStyle::TimedOut => Style::default().fg(palette.timed_out).bg(palette.node_bg),
        CanvasStyle::Warn => Style::default().fg(palette.warning).bg(palette.node_bg),
        CanvasStyle::Cancelled => Style::default().fg(palette.cancelled).bg(palette.node_bg),
        CanvasStyle::Branch => Style::default().fg(palette.branch).bg(palette.node_bg),
        CanvasStyle::BranchFocus => Style::default()
            .fg(palette.branch)
            .bg(palette.node_focus_bg),
        CanvasStyle::Agent => Style::default()
            .fg(palette.assistant)
            .bg(palette.node_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::AgentFocus => Style::default()
            .fg(palette.assistant)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Compute => Style::default()
            .fg(palette.accent)
            .bg(palette.node_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::ComputeFocus => Style::default()
            .fg(palette.accent)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Action => Style::default()
            .fg(palette.tool)
            .bg(palette.node_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::ActionFocus => Style::default()
            .fg(palette.tool)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Checkpoint => Style::default()
            .fg(palette.replay_focus)
            .bg(palette.node_bg)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::CheckpointFocus => Style::default()
            .fg(palette.replay_focus)
            .bg(palette.node_focus_bg)
            .add_modifier(Modifier::BOLD),
    }
}

/// Cut a row of styled runs to the viewport columns `[offset, offset+width)`
/// (measured in characters) and convert to a ratatui line.
pub fn viewport_line(
    runs: &[StyledRun],
    origin_x: i64,
    width: usize,
    palette: &Palette,
) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let leading = if origin_x < 0 {
        (-origin_x).min(width as i64) as usize
    } else {
        0
    };
    if leading > 0 {
        spans.push(Span::raw(" ".repeat(leading)));
    }
    let offset_x = origin_x.max(0) as usize;
    let available = width.saturating_sub(leading);
    let mut position = 0usize;
    let end = offset_x.saturating_add(available);
    for (text, style) in runs {
        let run_len = text.chars().count();
        let run_start = position;
        let run_end = position + run_len;
        position = run_end;
        if run_end <= offset_x {
            continue;
        }
        if run_start >= end {
            break;
        }
        let skip = offset_x.saturating_sub(run_start);
        let take = (run_end.min(end)) - (run_start + skip);
        let slice: String = text.chars().skip(skip).take(take).collect();
        if !slice.is_empty() {
            spans.push(Span::styled(slice, style_for(*style, palette)));
        }
    }
    Line::from(spans)
}

/// The canvas dimensions of rendered rows: (max line width, row count).
pub fn content_size(rows: &[Vec<StyledRun>]) -> (usize, usize) {
    let width = rows
        .iter()
        .map(|runs| runs.iter().map(|(text, _)| text.chars().count()).sum())
        .max()
        .unwrap_or(0);
    (width, rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_roles_use_a_surface_distinct_from_the_canvas() {
        let palette = Palette::catppuccin();
        assert_ne!(palette.node_bg, palette.canvas_bg);
        assert_eq!(
            style_for(CanvasStyle::NodeText, &palette).bg,
            Some(palette.node_bg)
        );
        assert_eq!(
            style_for(CanvasStyle::NodeFocusText, &palette).bg,
            Some(palette.node_focus_bg)
        );
        assert_eq!(
            style_for(CanvasStyle::NodeHeader, &palette).bg,
            Some(palette.panel_bg)
        );
        assert_eq!(
            style_for(CanvasStyle::NodeBorderActive, &palette).bg,
            Some(palette.canvas_bg)
        );
        assert_eq!(
            style_for(CanvasStyle::AgentFocus, &palette).bg,
            Some(palette.node_focus_bg)
        );
        assert_ne!(palette.panel_bg, palette.node_bg);
        assert_ne!(palette.panel_bg, palette.node_focus_bg);
    }

    #[test]
    fn node_types_have_distinct_semantic_accents() {
        let palette = Palette::catppuccin();
        let colors = [
            style_for(CanvasStyle::Agent, &palette).fg,
            style_for(CanvasStyle::Compute, &palette).fg,
            style_for(CanvasStyle::Action, &palette).fg,
            style_for(CanvasStyle::Checkpoint, &palette).fg,
        ];
        for (index, color) in colors.iter().enumerate() {
            assert!(!colors[..index].contains(color));
        }
    }

    #[test]
    fn viewport_supports_negative_origins_for_real_centering() {
        let palette = Palette::catppuccin();
        let line = viewport_line(&[("abc".to_string(), CanvasStyle::Plain)], -2, 5, &palette);
        assert_eq!(line.to_string(), "  abc");
    }
}
