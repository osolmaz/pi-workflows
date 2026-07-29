//! Graph pane: converts the rendered `CharCanvas` into ratatui lines and
//! applies a scroll/zoom viewport.

use crate::canvas::{CanvasStyle, StyledRun};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

pub fn style_for(style: CanvasStyle) -> Style {
    match style {
        CanvasStyle::Plain => Style::default(),
        CanvasStyle::Dim => Style::default().fg(Color::DarkGray),
        CanvasStyle::Taken | CanvasStyle::Ok => Style::default().fg(Color::Green),
        CanvasStyle::Active => Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
        CanvasStyle::Back | CanvasStyle::Warn => Style::default().fg(Color::Yellow),
        CanvasStyle::Fail => Style::default().fg(Color::Red),
    }
}

/// Cut a row of styled runs to the viewport columns `[offset, offset+width)`
/// (measured in characters) and convert to a ratatui line.
pub fn viewport_line(runs: &[StyledRun], offset_x: usize, width: usize) -> Line<'static> {
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
            spans.push(Span::styled(slice, style_for(*style)));
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

/// Find the row/column of the first cell drawn in the active style, used to
/// keep the camera on the running node while following.
pub fn find_active(rows: &[Vec<StyledRun>]) -> Option<(usize, usize)> {
    for (y, runs) in rows.iter().enumerate() {
        let mut x = 0usize;
        for (text, style) in runs {
            let len = text.chars().count();
            if *style == CanvasStyle::Active {
                return Some((y, x));
            }
            x += len;
        }
    }
    None
}
