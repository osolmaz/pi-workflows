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

    let mut lines = vec![Line::from(vec![
        Span::styled(" ↑↓", Style::default().fg(palette.accent)),
        Span::styled(" preview  ", Style::default().fg(palette.subtext)),
        Span::styled("Enter", Style::default().fg(palette.accent)),
        Span::styled(" apply  ", Style::default().fg(palette.subtext)),
        Span::styled("Esc", Style::default().fg(palette.accent)),
        Span::styled(" cancel", Style::default().fg(palette.subtext)),
    ])];
    if let Some(error) = &picker.error {
        lines.push(Line::from(Span::styled(
            format!(" {error}"),
            Style::default().fg(palette.error),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(palette.panel_bg)),
        footer_area,
    );
}
