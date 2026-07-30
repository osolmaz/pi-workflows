use crate::bundle::types::RunStatus;
use crate::theme::Palette;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

pub const PLAYBACK_SPEEDS: &[u16] = &[1, 2, 5, 10];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineAction {
    Start,
    Previous,
    TogglePlayback,
    Next,
    Live,
    Slower,
    Faster,
}

#[derive(Debug, Clone, Copy)]
pub struct TimelineHit {
    pub rect: Rect,
    pub action: TimelineAction,
}

#[derive(Debug, Clone, Default)]
pub struct TimelineGeometry {
    pub track: Rect,
    pub hits: Vec<TimelineHit>,
}

pub struct TimelineView<'a> {
    pub status: RunStatus,
    pub paused: bool,
    pub elapsed: &'a str,
    pub steps: usize,
    /// `-1` means before the first step.
    pub position: i64,
    pub temporal: bool,
    pub at_latest: bool,
    pub live: bool,
    pub playing: bool,
    pub speed: u16,
    pub diagnostic: Option<&'a str>,
}

pub fn render(
    frame: &mut Frame,
    area: Rect,
    view: Option<TimelineView<'_>>,
    palette: &Palette,
) -> TimelineGeometry {
    frame.render_widget(
        Paragraph::new("").style(Style::default().fg(palette.text).bg(palette.app_bg)),
        area,
    );
    let Some(view) = view else {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " ,: theme  Tab: focus  q: quit",
                Style::default().fg(palette.muted),
            )))
            .style(Style::default().bg(palette.app_bg)),
            area,
        );
        return TimelineGeometry::default();
    };

    if area.height < 2 || area.width < 60 {
        render_compact(frame, area, &view, palette);
        return TimelineGeometry::default();
    }

    let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);
    let status_width = 24.min(area.width.saturating_sub(24));
    let position_width = 18.min(area.width.saturating_sub(status_width));
    let top = Layout::horizontal([
        Constraint::Length(status_width),
        Constraint::Min(8),
        Constraint::Length(position_width),
    ])
    .split(rows[0]);
    render_status(frame, top[0], &view, palette);
    render_track(frame, top[1], &view, palette);
    render_position(frame, top[2], &view, palette);

    let button_widths = [8, 8, 9, 8, 8, 8, 8];
    let mut constraints: Vec<Constraint> = button_widths
        .iter()
        .copied()
        .map(Constraint::Length)
        .collect();
    constraints.push(Constraint::Min(0));
    let bottom = Layout::horizontal(constraints).split(rows[1]);
    let specs = [
        (TimelineAction::Start, " Home "),
        (TimelineAction::Previous, " [ Prev "),
        (
            TimelineAction::TogglePlayback,
            if view.playing { " Pause " } else { " Play " },
        ),
        (TimelineAction::Next, " Next ] "),
        (TimelineAction::Live, " Live "),
        (TimelineAction::Slower, " { Slow "),
        (TimelineAction::Faster, " Fast } "),
    ];
    let mut hits = Vec::with_capacity(specs.len());
    for (index, (action, label)) in specs.into_iter().enumerate() {
        let rect = bottom[index];
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                label,
                Style::default().fg(palette.text).bg(palette.selection_bg),
            )))
            .style(Style::default().bg(palette.app_bg)),
            rect,
        );
        hits.push(TimelineHit { rect, action });
    }
    let hint = if let Some(diagnostic) = view.diagnostic {
        Span::styled(
            format!(" {diagnostic}"),
            Style::default().fg(palette.warning),
        )
    } else {
        Span::styled(
            format!(" {}x  f: follow  z: density  ,: theme  q: quit", view.speed),
            Style::default().fg(palette.muted),
        )
    };
    frame.render_widget(
        Paragraph::new(Line::from(hint)).style(Style::default().bg(palette.app_bg)),
        bottom[7],
    );

    TimelineGeometry {
        track: top[1],
        hits,
    }
}

fn render_compact(frame: &mut Frame, area: Rect, view: &TimelineView<'_>, palette: &Palette) {
    let status = status_label(view.status, view.paused);
    let position = position_label(view);
    let diagnostic = view
        .diagnostic
        .map(|value| format!("  {value}"))
        .unwrap_or_default();
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!(" {} {status} ", status_glyph(view.status)),
                Style::default()
                    .fg(status_color(view.status, palette))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{}  ", view.elapsed),
                Style::default().fg(palette.subtext),
            ),
            Span::styled(
                position,
                Style::default()
                    .fg(position_color(view, palette))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    "  {}x  [/]: scrub  f: follow  ,: theme{diagnostic}",
                    view.speed
                ),
                Style::default().fg(palette.muted),
            ),
        ]))
        .style(Style::default().bg(palette.app_bg)),
        area,
    );
}

fn render_status(frame: &mut Frame, area: Rect, view: &TimelineView<'_>, palette: &Palette) {
    let label = status_label(view.status, view.paused);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!(" {} {label} ", status_glyph(view.status)),
                Style::default()
                    .fg(status_color(view.status, palette))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(view.elapsed, Style::default().fg(palette.subtext)),
        ]))
        .style(Style::default().bg(palette.app_bg)),
        area,
    );
}

fn render_track(frame: &mut Frame, area: Rect, view: &TimelineView<'_>, palette: &Palette) {
    if area.width == 0 {
        return;
    }
    let width = area.width as usize;
    let cursor = timeline_column(view.steps, view.position, view.at_latest, width);
    let mut spans = Vec::with_capacity(width);
    for column in 0..width {
        let (glyph, color) = if column == cursor {
            ("●", palette.timeline_thumb)
        } else if column < cursor {
            ("━", palette.timeline_fill)
        } else {
            ("─", palette.timeline_track)
        };
        spans.push(Span::styled(glyph, Style::default().fg(color)));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(palette.app_bg)),
        area,
    );
}

fn render_position(frame: &mut Frame, area: Rect, view: &TimelineView<'_>, palette: &Palette) {
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!(" {:>15}", position_label(view)),
            Style::default()
                .fg(position_color(view, palette))
                .add_modifier(Modifier::BOLD),
        )))
        .style(Style::default().bg(palette.app_bg)),
        area,
    );
}

pub fn timeline_column(steps: usize, position: i64, at_latest: bool, width: usize) -> usize {
    if width <= 1 || steps == 0 {
        return 0;
    }
    let completed = if at_latest {
        steps
    } else {
        (position + 1).clamp(0, steps as i64) as usize
    };
    ((completed * (width - 1)) + steps / 2) / steps
}

pub fn position_from_column(steps: usize, column: usize, width: usize) -> Option<i64> {
    if steps == 0 || width <= 1 {
        return None;
    }
    let completed = ((column.min(width - 1) * steps) + (width - 1) / 2) / (width - 1);
    if completed >= steps {
        None
    } else {
        Some(completed as i64 - 1)
    }
}

fn position_label(view: &TimelineView<'_>) -> String {
    let unit = if view.temporal { "event" } else { "step" };
    if view.at_latest && view.live {
        "LIVE".to_string()
    } else if view.at_latest {
        format!("{unit} {0}/{0}", view.steps)
    } else if view.position < 0 {
        format!("before 0/{}", view.steps)
    } else {
        format!("{unit} {}/{}", view.position + 1, view.steps)
    }
}

fn position_color(view: &TimelineView<'_>, palette: &Palette) -> ratatui::style::Color {
    if view.at_latest && view.live {
        palette.running
    } else if !view.at_latest {
        palette.replay_focus
    } else {
        palette.text
    }
}

fn status_label(status: RunStatus, paused: bool) -> &'static str {
    if paused {
        "paused"
    } else {
        status.label()
    }
}

fn status_glyph(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "◐",
        RunStatus::Waiting => "⏸",
        RunStatus::Completed => "✓",
        RunStatus::Failed => "✗",
        RunStatus::TimedOut => "×",
        RunStatus::Cancelled => "~",
    }
}

fn status_color(status: RunStatus, palette: &Palette) -> ratatui::style::Color {
    match status {
        RunStatus::Running => palette.running,
        RunStatus::Waiting => palette.warning,
        RunStatus::Completed => palette.success,
        RunStatus::Failed => palette.error,
        RunStatus::TimedOut => palette.timed_out,
        RunStatus::Cancelled => palette.cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_maps_before_middle_and_latest() {
        assert_eq!(timeline_column(4, -1, false, 9), 0);
        assert_eq!(timeline_column(4, 1, false, 9), 4);
        assert_eq!(timeline_column(4, 3, true, 9), 8);
        assert_eq!(position_from_column(4, 0, 9), Some(-1));
        assert_eq!(position_from_column(4, 4, 9), Some(1));
        assert_eq!(position_from_column(4, 8, 9), None);
    }
}
