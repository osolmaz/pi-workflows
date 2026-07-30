use crate::theme::Palette;
use ratatui::style::{Modifier, Style};

/// Render every clickable text control with the same bracketed button shape.
pub fn button_label(symbol: &str, text: &str) -> String {
    format!("[{symbol} {text}]")
}

pub fn button_style(palette: &Palette, active: bool) -> Style {
    if active {
        Style::default()
            .fg(palette.panel_bg)
            .bg(palette.accent)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(palette.subtext)
            .bg(palette.selection_bg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_labels_have_a_consistent_visible_shape() {
        assert_eq!(button_label("◆", "Steps"), "[◆ Steps]");
        assert_eq!(button_label("▶", "Play"), "[▶ Play]");
        assert_eq!(button_label("✓", "Apply"), "[✓ Apply]");
    }
}
