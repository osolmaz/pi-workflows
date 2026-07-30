//! Port of `src/render/canvas.ts`: a sparse character grid where box-drawing
//! characters merge by connectivity (│ crossing ─ becomes ┼).

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CanvasStyle {
    Plain,
    Dim,
    Taken,
    ActiveEdge,
    Back,
    NodeText,
    NodeDim,
    NodeFocusText,
    NodeHeader,
    NodeBorderDim,
    NodeBorderActive,
    NodeBorderReplay,
    NodeBorderOk,
    NodeBorderFail,
    NodeBorderTimedOut,
    NodeBorderWarn,
    NodeBorderCancelled,
    Active,
    Replay,
    Ok,
    Fail,
    TimedOut,
    Warn,
    Cancelled,
    Branch,
    BranchFocus,
    Agent,
    AgentFocus,
    Compute,
    ComputeFocus,
    Action,
    ActionFocus,
    Checkpoint,
    CheckpointFocus,
}

impl CanvasStyle {
    /// Styles later in the priority order win when merged lines overlap.
    fn priority(self) -> u8 {
        match self {
            CanvasStyle::Plain => 0,
            CanvasStyle::Dim => 1,
            CanvasStyle::Back => 2,
            CanvasStyle::Taken => 3,
            CanvasStyle::ActiveEdge => 4,
            CanvasStyle::NodeText
            | CanvasStyle::NodeDim
            | CanvasStyle::NodeFocusText
            | CanvasStyle::NodeHeader => 5,
            CanvasStyle::NodeBorderDim
            | CanvasStyle::NodeBorderActive
            | CanvasStyle::NodeBorderReplay
            | CanvasStyle::NodeBorderOk
            | CanvasStyle::NodeBorderFail
            | CanvasStyle::NodeBorderTimedOut
            | CanvasStyle::NodeBorderWarn
            | CanvasStyle::NodeBorderCancelled
            | CanvasStyle::Warn
            | CanvasStyle::Cancelled => 6,
            CanvasStyle::Ok => 7,
            CanvasStyle::Fail | CanvasStyle::TimedOut => 8,
            CanvasStyle::Branch
            | CanvasStyle::BranchFocus
            | CanvasStyle::Agent
            | CanvasStyle::AgentFocus
            | CanvasStyle::Compute
            | CanvasStyle::ComputeFocus
            | CanvasStyle::Action
            | CanvasStyle::ActionFocus
            | CanvasStyle::Checkpoint
            | CanvasStyle::CheckpointFocus => 9,
            CanvasStyle::Replay => 10,
            CanvasStyle::Active => 11,
        }
    }
}

fn merge_styles(a: CanvasStyle, b: CanvasStyle) -> CanvasStyle {
    if a.priority() >= b.priority() {
        a
    } else {
        b
    }
}

pub const UP: u8 = 1;
pub const DOWN: u8 = 2;
pub const LEFT: u8 = 4;
pub const RIGHT: u8 = 8;

/// Which sides each box-drawing character connects to.
pub fn char_to_mask(char: char) -> Option<u8> {
    Some(match char {
        '─' => LEFT | RIGHT,
        '│' => UP | DOWN,
        '┌' => DOWN | RIGHT,
        '┐' => DOWN | LEFT,
        '└' => UP | RIGHT,
        '┘' => UP | LEFT,
        '├' => UP | DOWN | RIGHT,
        '┤' => UP | DOWN | LEFT,
        '┬' => DOWN | LEFT | RIGHT,
        '┴' => UP | LEFT | RIGHT,
        '┼' => UP | DOWN | LEFT | RIGHT,
        _ => return None,
    })
}

fn mask_to_char(mask: u8) -> Option<char> {
    Some(match mask {
        m if m == (LEFT | RIGHT) => '─',
        m if m == (UP | DOWN) => '│',
        m if m == (DOWN | RIGHT) => '┌',
        m if m == (DOWN | LEFT) => '┐',
        m if m == (UP | RIGHT) => '└',
        m if m == (UP | LEFT) => '┘',
        m if m == (UP | DOWN | RIGHT) => '├',
        m if m == (UP | DOWN | LEFT) => '┤',
        m if m == (DOWN | LEFT | RIGHT) => '┬',
        m if m == (UP | LEFT | RIGHT) => '┴',
        m if m == (UP | DOWN | LEFT | RIGHT) => '┼',
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy)]
struct CanvasChar {
    char: char,
    style: CanvasStyle,
}

/// A styled run of consecutive characters on one canvas row.
pub type StyledRun = (String, CanvasStyle);

#[derive(Default)]
pub struct CharCanvas {
    cells: HashMap<i64, HashMap<i64, CanvasChar>>,
    max_x: i64,
    max_y: i64,
}

impl CharCanvas {
    pub fn new() -> Self {
        Self::default()
    }

    fn row(&mut self, y: i64) -> &mut HashMap<i64, CanvasChar> {
        self.max_y = self.max_y.max(y);
        self.cells.entry(y).or_default()
    }

    /// Place a single character, merging box-drawing connectivity.
    pub fn put(&mut self, x: i64, y: i64, char: char, style: CanvasStyle) {
        if x < 0 || y < 0 {
            return;
        }
        self.max_y = self.max_y.max(y);
        self.max_x = self.max_x.max(x);
        let row = self.cells.entry(y).or_default();
        // Spaces never occupy cells; text_over_run handles deliberate padding.
        if char == ' ' {
            return;
        }
        if let Some(existing) = row.get(&x).copied() {
            if existing.char == ' ' {
                row.insert(x, CanvasChar { char, style });
                return;
            }
            let existing_mask = char_to_mask(existing.char);
            let incoming_mask = char_to_mask(char);
            if let (Some(existing_mask), Some(incoming_mask)) = (existing_mask, incoming_mask) {
                row.insert(
                    x,
                    CanvasChar {
                        char: mask_to_char(existing_mask | incoming_mask).unwrap_or(char),
                        style: merge_styles(existing.style, style),
                    },
                );
                return;
            }
            // Non-line characters (labels, glyphs, arrows) win over lines;
            // between two non-line characters the newest wins.
            if existing_mask.is_none() && incoming_mask.is_some() {
                return;
            }
        }
        row.insert(x, CanvasChar { char, style });
    }

    /// Write a text run left to right (labels, node lines).
    pub fn text(&mut self, x: i64, y: i64, value: &str, style: CanvasStyle) {
        for (index, char) in value.chars().enumerate() {
            self.put(x + index as i64, y, char, style);
        }
    }

    /// Write text only when every target cell is empty. Returns whether the
    /// text was written.
    pub fn text_if_empty(&mut self, x: i64, y: i64, value: &str, style: CanvasStyle) -> bool {
        if x < 0 || y < 0 {
            return false;
        }
        let width = value.chars().count() as i64;
        if let Some(row) = self.cells.get(&y) {
            for index in 0..width {
                if row.contains_key(&(x + index)) {
                    return false;
                }
            }
        }
        self.text(x, y, value, style);
        true
    }

    /// Write text over a plain horizontal run, replacing `─` cells only.
    /// Refuses unless every target cell and both flanking cells are exactly
    /// `─`. Spaces in `value` become real blanks on purpose.
    pub fn text_over_run(&mut self, x: i64, y: i64, value: &str, style: CanvasStyle) -> bool {
        if x < 1 || y < 0 {
            return false;
        }
        let chars: Vec<char> = value.chars().collect();
        let row = self.cells.get(&y);
        for index in -1..=(chars.len() as i64) {
            let is_dash = row
                .and_then(|row| row.get(&(x + index)))
                .is_some_and(|cell| cell.char == '─');
            if !is_dash {
                return false;
            }
        }
        let row = self.row(y);
        for (index, &char) in chars.iter().enumerate() {
            row.insert(x + index as i64, CanvasChar { char, style });
        }
        self.max_x = self.max_x.max(x + chars.len() as i64 - 1);
        true
    }

    /// Fill a rectangle with intentional styled spaces. Unlike `put`, this
    /// preserves spaces so node cards can carry a background color.
    pub fn fill_rect(&mut self, x: i64, y: i64, width: i64, height: i64, style: CanvasStyle) {
        if x < 0 || y < 0 || width <= 0 || height <= 0 {
            return;
        }
        self.max_x = self.max_x.max(x + width - 1);
        self.max_y = self.max_y.max(y + height - 1);
        for row_y in y..y + height {
            let row = self.cells.entry(row_y).or_default();
            for column_x in x..x + width {
                row.insert(column_x, CanvasChar { char: ' ', style });
            }
        }
    }

    pub fn hline(&mut self, y: i64, x1: i64, x2: i64, style: CanvasStyle) {
        let (start, end) = if x1 <= x2 { (x1, x2) } else { (x2, x1) };
        for x in start..=end {
            self.put(x, y, '─', style);
        }
    }

    pub fn vline(&mut self, x: i64, y1: i64, y2: i64, style: CanvasStyle) {
        let (start, end) = if y1 <= y2 { (y1, y2) } else { (y2, y1) };
        for y in start..=end {
            self.put(x, y, '│', style);
        }
    }

    /// Render to rows of styled runs, gaps filled with plain spaces.
    /// Trailing whitespace is trimmed from every row.
    pub fn render_runs(&self) -> Vec<Vec<StyledRun>> {
        let mut lines = Vec::new();
        for y in 0..=self.max_y {
            let Some(row) = self.cells.get(&y).filter(|row| !row.is_empty()) else {
                lines.push(Vec::new());
                continue;
            };
            // Trim trailing whitespace: find the last occupied x.
            let last_x = row.keys().copied().max().unwrap_or(-1);
            let mut runs: Vec<StyledRun> = Vec::new();
            let mut run_text = String::new();
            let mut run_style = CanvasStyle::Plain;
            for x in 0..=last_x.min(self.max_x) {
                let (char, style) = match row.get(&x) {
                    Some(cell) => (cell.char, cell.style),
                    None => (' ', CanvasStyle::Plain),
                };
                if style != run_style {
                    if !run_text.is_empty() {
                        runs.push((std::mem::take(&mut run_text), run_style));
                    }
                    run_style = style;
                }
                run_text.push(char);
            }
            if !run_text.is_empty() {
                runs.push((run_text, run_style));
            }
            lines.push(runs);
        }
        lines
    }

    /// Render to plain text lines (trailing whitespace trimmed), matching the
    /// TypeScript renderer with colors disabled.
    pub fn render_plain(&self) -> Vec<String> {
        self.render_runs()
            .into_iter()
            .map(|runs| {
                let line: String = runs.into_iter().map(|(text, _)| text).collect();
                line.trim_end().to_string()
            })
            .collect()
    }
}
