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
    }
}

/// Cut a row of styled runs to the viewport columns `[offset, offset+width)`
/// (measured in characters) and convert to a ratatui line.
pub fn viewport_line(
    runs: &[StyledRun],
    offset_x: usize,
    width: usize,
    palette: &Palette,
) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut position = 0usize;
    let end = offset_x + width;
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

/// Find the row/column of the running or replay-focused node.
pub fn find_focus(rows: &[Vec<StyledRun>]) -> Option<(usize, usize)> {
    for (y, runs) in rows.iter().enumerate() {
        let mut x = 0usize;
        for (text, style) in runs {
            let len = text.chars().count();
            if matches!(style, CanvasStyle::Active | CanvasStyle::Replay) {
                return Some((y, x));
            }
            x += len;
        }
    }
    None
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
    }
}
