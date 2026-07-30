use super::controls;
use crate::theme::{Palette, THEME_NAMES};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph};
use ratatui::Frame;

#[derive(Debug, Clone)]
pub struct ThemePicker {
    pub original_palette: Palette,
    pub original_name: String,
    pub selected: usize,
    pub error: Option<String>,
}

impl ThemePicker {
    pub fn new(palette: &Palette) -> Self {
        let selected = THEME_NAMES
            .iter()
            .position(|name| *name == palette.name)
            .unwrap_or(0);
        Self {
            original_palette: palette.clone(),
            original_name: palette.name.clone(),
            selected,
            error: None,
        }
    }

    pub fn selected_name(&self) -> &'static str {
        THEME_NAMES[self.selected]
    }

    pub fn move_previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
        self.error = None;
    }

    pub fn move_next(&mut self) {
        self.selected = (self.selected + 1).min(THEME_NAMES.len() - 1);
        self.error = None;
    }
}

pub fn popup_rect(area: Rect) -> Rect {
    let available_width = area.width.saturating_sub(4);
    let width = if available_width < 20 {
        area.width
    } else {
        available_width.min(52)
    };
    let available_height = area.height.saturating_sub(2);
    let height = if available_height < 8 {
        area.height
    } else {
        available_height.min(THEME_NAMES.len() as u16 + 6)
    };
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeAction {
    Apply,
    Cancel,
}

#[derive(Debug, Clone, Copy)]
struct ThemeHit {
    rect: Rect,
    action: ThemeAction,
}

fn footer_hits(area: Rect) -> Vec<ThemeHit> {
    let apply = controls::button_label("✓", "Apply");
    let cancel = controls::button_label("×", "Cancel");
    let buttons_width = apply.chars().count() as u16 + 1 + cancel.chars().count() as u16;
    let mut x = if area.width >= buttons_width.saturating_add(12) {
        area.x.saturating_add(12)
    } else {
        area.x
    };
    [(ThemeAction::Apply, apply), (ThemeAction::Cancel, cancel)]
        .into_iter()
        .filter_map(|(action, label)| {
            let width = label.chars().count() as u16;
            if x.saturating_add(width) > area.right() {
                return None;
            }
            let hit = ThemeHit {
                rect: Rect::new(x, area.y, width, 1),
                action,
            };
            x = x.saturating_add(width).saturating_add(1);
            Some(hit)
        })
        .collect()
}

pub fn action_at(frame_area: Rect, has_error: bool, column: u16, row: u16) -> Option<ThemeAction> {
    let popup = popup_rect(frame_area);
    let inner = Rect::new(
        popup.x.saturating_add(1),
        popup.y.saturating_add(1),
        popup.width.saturating_sub(2),
        popup.height.saturating_sub(2),
    );
    let footer_height = if has_error { 3 } else { 2 };
    let list_height = inner.height.saturating_sub(footer_height);
    let footer = Rect::new(
        inner.x,
        inner.y.saturating_add(list_height),
        inner.width,
        footer_height,
    );
    footer_hits(footer)
        .into_iter()
        .find(|hit| {
            column >= hit.rect.x
                && column < hit.rect.right()
                && row >= hit.rect.y
                && row < hit.rect.bottom()
        })
        .map(|hit| hit.action)
}

pub fn render(frame: &mut Frame, area: Rect, picker: &ThemePicker, palette: &Palette) {
    let popup = popup_rect(area);
    frame.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Theme ")
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .border_style(Style::default().fg(palette.border_focused));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    if inner.height < 2 {
        return;
    }

    let footer_height = if picker.error.is_some() { 3 } else { 2 };
    let list_height = inner.height.saturating_sub(footer_height);
    let list_area = Rect::new(inner.x, inner.y, inner.width, list_height);
    let footer_area = Rect::new(inner.x, inner.y + list_height, inner.width, footer_height);
    let items: Vec<ListItem> = THEME_NAMES
        .iter()
        .map(|name| {
            let candidate = Palette::from_name(name).unwrap_or_else(Palette::catppuccin);
            let current = if *name == picker.original_name {
                " ✓"
            } else {
                ""
            };
            ListItem::new(Line::from(vec![
                Span::styled("██", Style::default().fg(candidate.accent)),
                Span::styled("██", Style::default().fg(candidate.success)),
                Span::styled("██ ", Style::default().fg(candidate.error)),
                Span::styled(*name, Style::default().fg(palette.text)),
                Span::styled(current, Style::default().fg(palette.success)),
            ]))
        })
        .collect();
    let list = List::new(items)
        .style(Style::default().fg(palette.text).bg(palette.panel_bg))
        .highlight_style(
            Style::default()
                .fg(palette.text)
                .bg(palette.selection_bg)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol(" ▸ ");
    let mut state = ListState::default().with_selected(Some(picker.selected));
    frame.render_stateful_widget(list, list_area, &mut state);

    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(palette.panel_bg)),
        footer_area,
    );
    let hits = footer_hits(footer_area);
    if hits.first().is_some_and(|hit| hit.rect.x > footer_area.x) {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("↑↓", Style::default().fg(palette.accent)),
                Span::styled(" Preview", Style::default().fg(palette.subtext)),
            ]))
            .style(Style::default().bg(palette.panel_bg)),
            Rect::new(footer_area.x, footer_area.y, 10.min(footer_area.width), 1),
        );
    }
    for hit in hits {
        let (symbol, text) = match hit.action {
            ThemeAction::Apply => ("✓", "Apply"),
            ThemeAction::Cancel => ("×", "Cancel"),
        };
        frame.render_widget(
            Paragraph::new(controls::button_label(symbol, text))
                .style(controls::button_style(palette, false)),
            hit.rect,
        );
    }
    if let Some(error) = &picker.error {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!(" {error}"),
                Style::default().fg(palette.error),
            )))
            .style(Style::default().bg(palette.panel_bg)),
            Rect::new(
                footer_area.x,
                footer_area.y.saturating_add(1),
                footer_area.width,
                footer_area.height.saturating_sub(1),
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_actions_only_activate_the_rendered_buttons() {
        let frame = Rect::new(0, 0, 100, 30);
        let popup = popup_rect(frame);
        let inner = Rect::new(popup.x + 1, popup.y + 1, popup.width - 2, popup.height - 2);
        let footer = Rect::new(inner.x, inner.bottom() - 2, inner.width, 2);
        let hits = footer_hits(footer);
        assert_eq!(hits.len(), 2);
        for hit in &hits {
            assert_eq!(
                action_at(frame, false, hit.rect.x, hit.rect.y),
                Some(hit.action)
            );
        }
        assert_eq!(
            action_at(frame, false, hits[0].rect.right(), footer.y),
            None
        );
        assert_eq!(action_at(frame, false, footer.right() - 1, footer.y), None);
    }
}
