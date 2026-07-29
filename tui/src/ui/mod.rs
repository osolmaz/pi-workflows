//! The interactive TUI (see docs/tui-viewer.md): a runs sidebar, the graph
//! pane, an inspector with steps/trace/conversation/info tabs, and a replay
//! transport. Works against a local runs directory, a single bundle, or a
//! `piw serve` WebSocket server; all three feed the same view model.

mod conversation;
mod graph;

use crate::bundle::reader::with_artifact_placeholders;
use crate::bundle::types::{DefinitionSnapshot, NodeOutcome, RunState, RunStatus, StepRecord};
use crate::client::RemoteRuns;
use crate::format::{format_duration, parse_timestamp_ms, sanitize_text};
use crate::render::{render_graph_canvas, GraphNodeStyle, GraphView};
use crate::source::RunSource;
use anyhow::Result;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

const LOCAL_REFRESH_INTERVAL: Duration = Duration::from_millis(300);
const PLAY_STEP_INTERVAL: Duration = Duration::from_millis(700);

pub struct RunSummary {
    pub run_id: String,
    pub workflow_name: String,
    pub run_title: Option<String>,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub live: bool,
    pub possibly_interrupted: bool,
}

/// Borrowed view of one run, identical for local and remote providers.
pub struct RunData<'a> {
    pub state: &'a RunState,
    pub snapshot: Option<&'a DefinitionSnapshot>,
    pub events: &'a [Value],
    pub session_entries: &'a [Value],
    pub live: bool,
    pub possibly_interrupted: bool,
    /// Bundle directory when reading the filesystem directly; lets previews
    /// inline small artifacts instead of showing placeholders.
    pub bundle_dir: Option<&'a std::path::Path>,
}

pub enum Provider {
    Local {
        source: RunSource,
        last_refresh: Instant,
    },
    Remote(RemoteRuns),
}

impl Provider {
    fn tick(&mut self) {
        if let Provider::Local {
            source,
            last_refresh,
        } = self
        {
            if last_refresh.elapsed() >= LOCAL_REFRESH_INTERVAL {
                source.refresh_all();
                *last_refresh = Instant::now();
            }
        }
    }

    fn ensure_watch(&mut self, run_id: &str) {
        if let Provider::Remote(remote) = self {
            remote.watch(run_id);
        }
    }

    fn summaries(&self) -> Vec<RunSummary> {
        match self {
            Provider::Local { source, .. } => source
                .ordered_run_ids()
                .iter()
                .filter_map(|id| source.get(id))
                .map(|entry| RunSummary {
                    run_id: entry.manifest.run_id.clone(),
                    workflow_name: entry.manifest.workflow_name.clone(),
                    run_title: entry.manifest.run_title.clone(),
                    status: entry.manifest.status,
                    started_at: entry.manifest.started_at.clone(),
                    finished_at: entry.manifest.finished_at.clone(),
                    live: entry.live,
                    possibly_interrupted: entry.possibly_interrupted,
                })
                .collect(),
            Provider::Remote(remote) => remote
                .summaries()
                .iter()
                .filter_map(|summary| {
                    let manifest: crate::bundle::types::Manifest =
                        serde_json::from_value(summary.get("manifest")?.clone()).ok()?;
                    Some(RunSummary {
                        run_id: manifest.run_id,
                        workflow_name: manifest.workflow_name,
                        run_title: manifest.run_title,
                        status: manifest.status,
                        started_at: manifest.started_at,
                        finished_at: manifest.finished_at,
                        live: summary
                            .get("live")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        possibly_interrupted: summary
                            .get("possiblyInterrupted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect(),
        }
    }

    fn data(&mut self, run_id: &str) -> Option<RunData<'_>> {
        match self {
            Provider::Local { source, .. } => {
                let entry = source.get(run_id)?;
                Some(RunData {
                    state: &entry.state,
                    snapshot: entry.snapshot.as_ref(),
                    events: &entry.events,
                    session_entries: &entry.session_entries,
                    live: entry.live,
                    possibly_interrupted: entry.possibly_interrupted,
                    bundle_dir: Some(&entry.dir),
                })
            }
            Provider::Remote(remote) => {
                let view = remote.view(run_id)?;
                Some(RunData {
                    state: &view.state,
                    snapshot: view.snapshot.as_ref(),
                    events: &view.events,
                    session_entries: &view.session_entries,
                    live: view.live,
                    possibly_interrupted: view.possibly_interrupted,
                    bundle_dir: None,
                })
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Runs,
    Graph,
    Inspector,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InspectorTab {
    Steps,
    Trace,
    Conversation,
    Info,
}

impl InspectorTab {
    fn next(self) -> Self {
        match self {
            InspectorTab::Steps => InspectorTab::Trace,
            InspectorTab::Trace => InspectorTab::Conversation,
            InspectorTab::Conversation => InspectorTab::Info,
            InspectorTab::Info => InspectorTab::Steps,
        }
    }

    fn title(self) -> &'static str {
        match self {
            InspectorTab::Steps => "Steps",
            InspectorTab::Trace => "Trace",
            InspectorTab::Conversation => "Conversation",
            InspectorTab::Info => "Info",
        }
    }
}

struct App {
    provider: Provider,
    /// Whether the sidebar is shown (single-bundle mode hides it).
    show_sidebar: bool,
    selected_run: Option<String>,
    runs_scroll: usize,
    focus: Focus,
    /// Replay position: `None` = live/latest; `Some(i)` = after step i
    /// (`-1` = before any step).
    replay: Option<i64>,
    playing: bool,
    last_play_step: Instant,
    node_style: GraphNodeStyle,
    follow: bool,
    graph_offset: (usize, usize),
    dragging: Option<(u16, u16, usize, usize)>,
    tab: InspectorTab,
    inspector_scroll: usize,
    /// Pane rectangles from the last draw, for mouse routing.
    runs_rect: Rect,
    graph_rect: Rect,
    inspector_rect: Rect,
    quit: bool,
}

pub fn run_local(runs_dir: &Path) -> Result<()> {
    let source = RunSource::new(runs_dir);
    run_app(
        Provider::Local {
            source,
            last_refresh: Instant::now(),
        },
        true,
    )
}

pub fn run_single(bundle_dir: &Path) -> Result<()> {
    let source = RunSource::single(bundle_dir)?;
    run_app(
        Provider::Local {
            source,
            last_refresh: Instant::now(),
        },
        false,
    )
}

pub fn run_remote(url: &str) -> Result<()> {
    let remote = RemoteRuns::connect(url)?;
    run_app(Provider::Remote(remote), true)
}

fn run_app(provider: Provider, show_sidebar: bool) -> Result<()> {
    let mut terminal = ratatui::init();
    crossterm::execute!(std::io::stdout(), EnableMouseCapture)?;
    let result = event_loop(&mut terminal, provider, show_sidebar);
    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    provider: Provider,
    show_sidebar: bool,
) -> Result<()> {
    let mut app = App {
        provider,
        show_sidebar,
        selected_run: None,
        runs_scroll: 0,
        focus: if show_sidebar {
            Focus::Runs
        } else {
            Focus::Graph
        },
        replay: None,
        playing: false,
        last_play_step: Instant::now(),
        node_style: GraphNodeStyle::Line,
        follow: true,
        graph_offset: (0, 0),
        dragging: None,
        tab: InspectorTab::Steps,
        inspector_scroll: 0,
        runs_rect: Rect::default(),
        graph_rect: Rect::default(),
        inspector_rect: Rect::default(),
        quit: false,
    };

    while !app.quit {
        app.provider.tick();
        let summaries = app.provider.summaries();
        if app.selected_run.is_none()
            || !summaries
                .iter()
                .any(|summary| Some(&summary.run_id) == app.selected_run.as_ref())
        {
            app.selected_run = summaries.first().map(|summary| summary.run_id.clone());
        }
        if let Some(run_id) = app.selected_run.clone() {
            app.provider.ensure_watch(&run_id);
        }
        app.advance_playback();
        terminal.draw(|frame| draw(frame, &mut app, &summaries))?;

        if crossterm::event::poll(Duration::from_millis(120))? {
            match crossterm::event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    handle_key(&mut app, &summaries, key);
                }
                Event::Mouse(mouse) => handle_mouse(&mut app, &summaries, mouse),
                _ => {}
            }
        }
    }
    Ok(())
}

impl App {
    fn step_count(&mut self) -> i64 {
        let Some(run_id) = self.selected_run.clone() else {
            return 0;
        };
        self.provider
            .data(&run_id)
            .map(|data| data.state.steps.len() as i64)
            .unwrap_or(0)
    }

    fn advance_playback(&mut self) {
        if !self.playing || self.last_play_step.elapsed() < PLAY_STEP_INTERVAL {
            return;
        }
        self.last_play_step = Instant::now();
        let steps = self.step_count();
        match self.replay {
            Some(position) if position + 1 < steps => {
                self.replay = Some(position + 1);
            }
            _ => {
                // Past the final recorded step: rejoin the live view and stop.
                self.replay = None;
                self.playing = false;
            }
        }
    }

    fn step_back(&mut self) {
        let steps = self.step_count();
        let current = self.replay.unwrap_or(steps - 1);
        self.replay = Some((current - 1).max(-1));
        self.playing = false;
    }

    fn step_forward(&mut self) {
        let steps = self.step_count();
        match self.replay {
            // The final recorded step is a valid detached position (on a
            // live run it differs from the live view); rejoin only when
            // stepping past it.
            Some(position) if position + 1 >= steps => {
                self.replay = None;
            }
            Some(position) => self.replay = Some(position + 1),
            None => {}
        }
    }

    fn select_run(&mut self, summaries: &[RunSummary], delta: i64) {
        if summaries.is_empty() {
            return;
        }
        let current = summaries
            .iter()
            .position(|summary| Some(&summary.run_id) == self.selected_run.as_ref())
            .unwrap_or(0) as i64;
        let next = (current + delta).clamp(0, summaries.len() as i64 - 1) as usize;
        if summaries[next].run_id != self.selected_run.clone().unwrap_or_default() {
            self.selected_run = Some(summaries[next].run_id.clone());
            self.replay = None;
            self.playing = false;
            self.inspector_scroll = 0;
            self.graph_offset = (0, 0);
            self.follow = true;
        }
    }
}

fn handle_key(app: &mut App, summaries: &[RunSummary], key: KeyEvent) {
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.quit = true;
        return;
    }
    match key.code {
        KeyCode::Char('q') => app.quit = true,
        KeyCode::Tab => {
            app.focus = match (app.focus, app.show_sidebar) {
                (Focus::Runs, _) => Focus::Graph,
                (Focus::Graph, _) => Focus::Inspector,
                (Focus::Inspector, true) => Focus::Runs,
                (Focus::Inspector, false) => Focus::Graph,
            };
        }
        // Replay transport (global).
        KeyCode::Char('[') => app.step_back(),
        KeyCode::Char(']') => app.step_forward(),
        KeyCode::Char(' ') => {
            if app.replay.is_none() {
                // Start playback from the beginning of the run.
                app.replay = Some(-1);
            }
            app.playing = !app.playing;
            app.last_play_step = Instant::now();
        }
        KeyCode::Home | KeyCode::Char('g') => {
            app.replay = Some(-1);
            app.playing = false;
        }
        KeyCode::End | KeyCode::Char('G') | KeyCode::Char('L') => {
            app.replay = None;
            app.playing = false;
        }
        KeyCode::Char('z') | KeyCode::Char('+') | KeyCode::Char('-') => {
            app.node_style = match app.node_style {
                GraphNodeStyle::Line => GraphNodeStyle::Box,
                GraphNodeStyle::Box => GraphNodeStyle::Line,
            };
        }
        KeyCode::Char('f') => app.follow = !app.follow,
        KeyCode::Char('t') => app.tab = app.tab.next(),
        KeyCode::Char('1') => app.tab = InspectorTab::Steps,
        KeyCode::Char('2') => app.tab = InspectorTab::Trace,
        KeyCode::Char('3') => app.tab = InspectorTab::Conversation,
        KeyCode::Char('4') => app.tab = InspectorTab::Info,
        _ => match app.focus {
            Focus::Runs => match key.code {
                KeyCode::Up | KeyCode::Char('k') => app.select_run(summaries, -1),
                KeyCode::Down | KeyCode::Char('j') => app.select_run(summaries, 1),
                _ => {}
            },
            Focus::Graph => {
                let (x, y) = app.graph_offset;
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        app.graph_offset = (x, y.saturating_sub(2));
                        app.follow = false;
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        app.graph_offset = (x, y + 2);
                        app.follow = false;
                    }
                    KeyCode::Left | KeyCode::Char('h') => {
                        app.graph_offset = (x.saturating_sub(4), y);
                        app.follow = false;
                    }
                    KeyCode::Right | KeyCode::Char('l') => {
                        app.graph_offset = (x + 4, y);
                        app.follow = false;
                    }
                    KeyCode::Char('0') => {
                        app.graph_offset = (0, 0);
                        app.follow = true;
                    }
                    _ => {}
                }
            }
            Focus::Inspector => match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    if app.tab == InspectorTab::Steps {
                        app.step_back();
                    } else {
                        app.inspector_scroll = app.inspector_scroll.saturating_sub(1);
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if app.tab == InspectorTab::Steps {
                        app.step_forward();
                    } else {
                        app.inspector_scroll += 1;
                    }
                }
                KeyCode::PageUp => app.inspector_scroll = app.inspector_scroll.saturating_sub(10),
                KeyCode::PageDown => app.inspector_scroll += 10,
                _ => {}
            },
        },
    }
}

fn contains(rect: Rect, x: u16, y: u16) -> bool {
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

fn handle_mouse(app: &mut App, summaries: &[RunSummary], mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let delta: i64 = if mouse.kind == MouseEventKind::ScrollUp {
                -3
            } else {
                3
            };
            if contains(app.graph_rect, mouse.column, mouse.row) {
                let (x, y) = app.graph_offset;
                app.graph_offset = (x, (y as i64 + delta).max(0) as usize);
                app.follow = false;
            } else if contains(app.runs_rect, mouse.column, mouse.row) {
                app.select_run(summaries, delta.signum());
            } else if contains(app.inspector_rect, mouse.column, mouse.row) {
                app.inspector_scroll = (app.inspector_scroll as i64 + delta).max(0) as usize;
            }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            if contains(app.graph_rect, mouse.column, mouse.row) {
                app.focus = Focus::Graph;
                app.dragging = Some((
                    mouse.column,
                    mouse.row,
                    app.graph_offset.0,
                    app.graph_offset.1,
                ));
            } else if contains(app.runs_rect, mouse.column, mouse.row) {
                app.focus = Focus::Runs;
                // Row 0 of the pane is the border/title.
                let row = mouse.row.saturating_sub(app.runs_rect.y + 1) as usize;
                let index = app.runs_scroll + row;
                if index < summaries.len() {
                    let target = summaries[index].run_id.clone();
                    if Some(&target) != app.selected_run.as_ref() {
                        app.selected_run = Some(target);
                        app.replay = None;
                        app.playing = false;
                        app.graph_offset = (0, 0);
                        app.follow = true;
                    }
                }
            } else if contains(app.inspector_rect, mouse.column, mouse.row) {
                app.focus = Focus::Inspector;
            }
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some((start_x, start_y, offset_x, offset_y)) = app.dragging {
                let dx = start_x as i64 - mouse.column as i64;
                let dy = start_y as i64 - mouse.row as i64;
                app.graph_offset = (
                    (offset_x as i64 + dx).max(0) as usize,
                    (offset_y as i64 + dy).max(0) as usize,
                );
                app.follow = false;
            }
        }
        MouseEventKind::Up(MouseButton::Left) => app.dragging = None,
        _ => {}
    }
}

fn status_style(status: RunStatus) -> Style {
    match status {
        RunStatus::Running => Style::default().fg(Color::Cyan),
        RunStatus::Waiting => Style::default().fg(Color::Yellow),
        RunStatus::Completed => Style::default().fg(Color::Green),
        RunStatus::Failed | RunStatus::TimedOut => Style::default().fg(Color::Red),
        RunStatus::Cancelled => Style::default().fg(Color::Yellow),
    }
}

fn status_glyph(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "◐",
        RunStatus::Waiting => "⏸",
        RunStatus::Completed => "✓",
        RunStatus::Failed | RunStatus::TimedOut => "✗",
        RunStatus::Cancelled => "~",
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn draw(frame: &mut Frame, app: &mut App, summaries: &[RunSummary]) {
    let area = frame.area();
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(4), Constraint::Length(1)])
        .split(area);
    let body = vertical[0];
    let transport = vertical[1];

    let (runs_area, main_area) = if app.show_sidebar {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(34), Constraint::Min(20)])
            .split(body);
        (Some(columns[0]), columns[1])
    } else {
        (None, body)
    };

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main_area);
    app.graph_rect = rows[0];
    app.inspector_rect = rows[1];
    app.runs_rect = runs_area.unwrap_or_default();

    if let Some(runs_area) = runs_area {
        draw_runs(frame, app, summaries, runs_area);
    }

    let Some(run_id) = app.selected_run.clone() else {
        // In remote mode an empty screen is ambiguous: say whether we are
        // still connecting, failed, or genuinely see no runs.
        let message = match &app.provider {
            Provider::Remote(remote) => match remote.error() {
                Some(error) => format!("Connection failed: {}", sanitize_text(&error)),
                None if !remote.connected() => "Connecting…".to_string(),
                None => "No runs found.".to_string(),
            },
            _ => "No runs found.".to_string(),
        };
        frame.render_widget(
            Paragraph::new(message).block(Block::default().borders(Borders::ALL).title(" piw ")),
            main_area,
        );
        draw_transport(frame, transport, None, app.playing);
        return;
    };
    let replay = app.replay;
    let node_style = app.node_style;
    let follow = app.follow;
    let graph_rect = app.graph_rect;
    let inspector_rect = app.inspector_rect;
    let tab = app.tab;
    let inspector_scroll = app.inspector_scroll;
    let focus = app.focus;
    let playing = app.playing;
    // Captured before `data` takes the mutable borrow: a dead remote
    // connection must be visible while a cached run is still displayed.
    let disconnected = match &app.provider {
        Provider::Remote(remote) => !remote.connected(),
        _ => false,
    };

    let Some(data) = app.provider.data(&run_id) else {
        frame.render_widget(
            Paragraph::new("Loading run…")
                .block(Block::default().borders(Borders::ALL).title(" piw ")),
            main_area,
        );
        draw_transport(frame, transport, None, app.playing);
        return;
    };

    let steps = &data.state.steps;
    let selected_index = replay.unwrap_or(steps.len() as i64 - 1);
    let bounded_index = selected_index.max(-1).min(steps.len() as i64 - 1);
    let at_latest = replay.is_none();
    let visible_steps = &steps[0..(bounded_index + 1).max(0) as usize];
    let selected_step = if bounded_index >= 0 {
        steps.get(bounded_index as usize)
    } else {
        None
    };

    // Graph pane.
    let view = GraphView {
        state: data.state,
        snapshot: data.snapshot,
    };
    let render_index = if at_latest {
        steps.len() as i64 - 1
    } else {
        bounded_index
    };
    let rows_runs = render_graph_canvas(&view, render_index, now_ms(), node_style)
        .map(|canvas| canvas.render_runs())
        .unwrap_or_default();
    let inner_width = graph_rect.width.saturating_sub(2) as usize;
    let inner_height = graph_rect.height.saturating_sub(2) as usize;
    let (content_width, content_height) = graph::content_size(&rows_runs);
    let mut offset = app.graph_offset;
    if follow {
        if let Some((row, column)) = graph::find_active(&rows_runs) {
            offset = (
                column.saturating_sub(inner_width / 2),
                row.saturating_sub(inner_height / 2),
            );
        } else {
            offset = (0, 0);
        }
    }
    offset.0 = offset.0.min(content_width.saturating_sub(inner_width));
    offset.1 = offset.1.min(content_height.saturating_sub(inner_height));
    app.graph_offset = offset;
    let lines: Vec<Line> = rows_runs
        .iter()
        .skip(offset.1)
        .take(inner_height)
        .map(|runs| graph::viewport_line(runs, offset.0, inner_width))
        .collect();
    let graph_title = format!(
        " {} {}{} ",
        sanitize_text(&data.state.workflow_name),
        if at_latest { "(live)" } else { "(replay)" },
        if disconnected {
            " — DISCONNECTED"
        } else {
            ""
        }
    );
    let graph_block = Block::default()
        .borders(Borders::ALL)
        .title(graph_title)
        .border_style(pane_border(focus == Focus::Graph));
    frame.render_widget(Paragraph::new(lines).block(graph_block), graph_rect);

    // Inspector pane.
    let inspector_lines = match tab {
        InspectorTab::Steps => steps_lines(&data, visible_steps, selected_step, bounded_index),
        InspectorTab::Trace => trace_lines(data.events),
        InspectorTab::Conversation => conversation::conversation_lines(
            data.session_entries,
            visible_steps,
            at_latest,
            selected_step,
            inspector_rect.width.saturating_sub(2) as usize,
        ),
        InspectorTab::Info => info_lines(&data, &run_id),
    };
    let inspector_height = inspector_rect.height.saturating_sub(2) as usize;
    let max_scroll = inspector_lines.len().saturating_sub(inspector_height);
    let scroll = if tab == InspectorTab::Trace && at_latest {
        // Tail the trace while live.
        max_scroll
    } else {
        inspector_scroll.min(max_scroll)
    };
    app.inspector_scroll = scroll;
    let shown: Vec<Line> = inspector_lines
        .into_iter()
        .skip(scroll)
        .take(inspector_height)
        .collect();
    let tabs_title = format!(
        " {} (t to switch) ",
        [
            InspectorTab::Steps,
            InspectorTab::Trace,
            InspectorTab::Conversation,
            InspectorTab::Info,
        ]
        .iter()
        .map(|candidate| {
            if *candidate == tab {
                format!("[{}]", candidate.title())
            } else {
                candidate.title().to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
    );
    let inspector_block = Block::default()
        .borders(Borders::ALL)
        .title(tabs_title)
        .border_style(pane_border(focus == Focus::Inspector));
    frame.render_widget(Paragraph::new(shown).block(inspector_block), inspector_rect);

    draw_transport(
        frame,
        transport,
        Some((&data, bounded_index, at_latest)),
        playing,
    );
}

fn pane_border(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn draw_runs(frame: &mut Frame, app: &mut App, summaries: &[RunSummary], area: Rect) {
    let height = area.height.saturating_sub(2) as usize;
    let selected = summaries
        .iter()
        .position(|summary| Some(&summary.run_id) == app.selected_run.as_ref())
        .unwrap_or(0);
    if selected < app.runs_scroll {
        app.runs_scroll = selected;
    } else if height > 0 && selected >= app.runs_scroll + height {
        app.runs_scroll = selected + 1 - height;
    }
    let lines: Vec<Line> = summaries
        .iter()
        .enumerate()
        .skip(app.runs_scroll)
        .take(height.max(1))
        .map(|(index, summary)| {
            let marker = if index == selected { "▶ " } else { "  " };
            let name = summary
                .run_title
                .clone()
                .unwrap_or_else(|| summary.workflow_name.clone());
            let interrupted = if summary.possibly_interrupted {
                " ?"
            } else {
                ""
            };
            let end = summary
                .finished_at
                .as_deref()
                .and_then(parse_timestamp_ms)
                .unwrap_or_else(now_ms);
            let elapsed = parse_timestamp_ms(&summary.started_at)
                .map(|start| format!(" {}", format_duration((end - start).max(0))))
                .unwrap_or_default();
            let mut spans = vec![
                Span::raw(marker.to_string()),
                Span::styled(
                    format!("{} ", status_glyph(summary.status)),
                    status_style(summary.status),
                ),
                Span::raw(sanitize_text(&name)),
                Span::styled(elapsed, Style::default().fg(Color::DarkGray)),
                Span::styled(interrupted.to_string(), Style::default().fg(Color::Yellow)),
            ];
            if index == selected {
                spans = spans
                    .into_iter()
                    .map(|span| span.add_modifier(Modifier::BOLD))
                    .collect();
            }
            Line::from(spans)
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" Runs ({}) ", summaries.len()))
        .border_style(pane_border(app.focus == Focus::Runs));
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn outcome_glyph(outcome: NodeOutcome) -> (&'static str, Style) {
    match outcome {
        NodeOutcome::Ok => ("✓", Style::default().fg(Color::Green)),
        NodeOutcome::Failed => ("✗", Style::default().fg(Color::Red)),
        NodeOutcome::TimedOut => ("✗", Style::default().fg(Color::Red)),
        NodeOutcome::Cancelled => ("~", Style::default().fg(Color::Yellow)),
    }
}

fn step_duration(step: &StepRecord) -> String {
    let duration = parse_timestamp_ms(&step.finished_at).unwrap_or(0)
        - parse_timestamp_ms(&step.started_at).unwrap_or(0);
    format_duration(duration)
}

/// Small artifacts are inlined into previews when reading the filesystem
/// directly; larger ones (and remote mode) show placeholders.
const PREVIEW_ARTIFACT_MAX_BYTES: u64 = 64 * 1024;

/// Compact single-line preview of a persisted value. With a bundle
/// directory, artifact references resolve to their contents; otherwise they
/// render as placeholders.
fn preview_value(value: &Value, bundle_dir: Option<&std::path::Path>) -> String {
    let decoded = match bundle_dir {
        Some(dir) => {
            crate::bundle::reader::resolve_artifacts(value, dir, PREVIEW_ARTIFACT_MAX_BYTES)
        }
        None => with_artifact_placeholders(value),
    };
    let text = match decoded {
        Value::String(text) => text,
        Value::Null => return "—".to_string(),
        other => serde_json::to_string(&other).unwrap_or_default(),
    };
    let sanitized = sanitize_text(&text);
    let chars: Vec<char> = sanitized.chars().collect();
    if chars.len() > 200 {
        format!("{}…", chars[..200].iter().collect::<String>())
    } else {
        sanitized
    }
}

fn steps_lines(
    data: &RunData,
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    bounded_index: i64,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    // Only the steps visible at the replay position: while scrubbing, the
    // pane must not reveal outcomes the graph does not show yet.
    for (index, step) in visible_steps.iter().enumerate() {
        let (glyph, style) = outcome_glyph(step.outcome);
        let selected = bounded_index >= 0 && index == bounded_index as usize;
        let marker = if selected { "▶" } else { " " };
        let mut line = vec![
            Span::raw(format!("{marker} ")),
            Span::styled(glyph.to_string(), style),
            Span::raw(sanitize_text(&format!(
                " {} [{}] {}",
                step.node_id,
                step.node_type,
                step_duration(step)
            ))),
        ];
        if step.conversation.is_some() {
            line.push(Span::styled(
                " ◆".to_string(),
                Style::default().fg(Color::Magenta),
            ));
        }
        if selected {
            line = line
                .into_iter()
                .map(|span| span.add_modifier(Modifier::BOLD))
                .collect();
        }
        lines.push(Line::from(line));
    }
    if let Some(step) = selected_step {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            sanitize_text(&format!(
                "── step {} ({}) ──",
                step.node_id, step.attempt_id
            )),
            Style::default().fg(Color::DarkGray),
        )));
        if !step.prompt.is_null() {
            lines.push(Line::from(vec![
                Span::styled("prompt: ", Style::default().fg(Color::Cyan)),
                Span::raw(preview_value(&step.prompt, data.bundle_dir)),
            ]));
        }
        lines.push(Line::from(vec![
            Span::styled("output: ", Style::default().fg(Color::Cyan)),
            Span::raw(preview_value(&step.output, data.bundle_dir)),
        ]));
        if let Some(action) = &step.action {
            let command = action.command.clone().unwrap_or_default();
            lines.push(Line::from(vec![
                Span::styled("action: ", Style::default().fg(Color::Cyan)),
                Span::raw(sanitize_text(&format!(
                    "{} {}",
                    action.action_type, command
                ))),
            ]));
        }
        if let Some(error) = &step.error {
            lines.push(Line::from(vec![
                Span::styled("error: ", Style::default().fg(Color::Red)),
                Span::raw(sanitize_text(error)),
            ]));
        }
    }
    lines
}

fn trace_lines(events: &[Value]) -> Vec<Line<'static>> {
    events
        .iter()
        .map(|event| {
            let seq = event.get("seq").and_then(Value::as_u64).unwrap_or(0);
            // Event types and node ids are bundle-derived strings; scrub
            // them so the trace pane cannot emit terminal escapes.
            let event_type =
                sanitize_text(event.get("type").and_then(Value::as_str).unwrap_or("?"));
            let node = event
                .get("nodeId")
                .and_then(Value::as_str)
                .map(|node| format!(" {}", sanitize_text(node)))
                .unwrap_or_default();
            let style = match event_type.as_str() {
                "node_failed" | "run_failed" => Style::default().fg(Color::Red),
                "run_completed" => Style::default().fg(Color::Green),
                "node_started" => Style::default().fg(Color::Cyan),
                _ => Style::default(),
            };
            Line::from(vec![
                Span::styled(format!("{seq:>5} "), Style::default().fg(Color::DarkGray)),
                Span::styled(event_type, style),
                Span::raw(node),
            ])
        })
        .collect()
}

fn info_lines(data: &RunData, run_id: &str) -> Vec<Line<'static>> {
    let state = data.state;
    let label = |text: &str| Span::styled(format!("{text:<14}"), Style::default().fg(Color::Cyan));
    // Everything below except the derived counts is bundle-derived text.
    let mut lines = vec![
        Line::from(vec![label("run"), Span::raw(sanitize_text(run_id))]),
        Line::from(vec![
            label("workflow"),
            Span::raw(sanitize_text(&state.workflow_name)),
        ]),
        Line::from(vec![
            label("status"),
            Span::styled(state.status.label().to_string(), status_style(state.status)),
        ]),
        Line::from(vec![
            label("started"),
            Span::raw(sanitize_text(&state.started_at)),
        ]),
    ];
    if let Some(finished) = &state.finished_at {
        lines.push(Line::from(vec![
            label("finished"),
            Span::raw(sanitize_text(finished)),
        ]));
    }
    if let Some(path) = &state.workflow_path {
        lines.push(Line::from(vec![
            label("source"),
            Span::raw(sanitize_text(path)),
        ]));
    }
    if let Some(detail) = &state.status_detail {
        lines.push(Line::from(vec![
            label("detail"),
            Span::raw(sanitize_text(detail)),
        ]));
    }
    if let Some(error) = &state.error {
        lines.push(Line::from(vec![
            label("error"),
            Span::styled(sanitize_text(error), Style::default().fg(Color::Red)),
        ]));
    }
    lines.push(Line::from(vec![
        label("trace"),
        Span::raw(format!(
            "{} events (seq {})",
            data.events.len(),
            state.trace_seq
        )),
    ]));
    lines.push(Line::from(vec![
        label("session"),
        Span::raw(if data.session_entries.is_empty() {
            "no conversation captured".to_string()
        } else {
            format!("{} entries", data.session_entries.len())
        }),
    ]));
    if data.possibly_interrupted {
        lines.push(Line::from(Span::styled(
            "run may have been interrupted (no writes for 60s)",
            Style::default().fg(Color::Yellow),
        )));
    }
    if let Some(output) = &state.final_output {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            label("final output"),
            Span::raw(preview_value(output, data.bundle_dir)),
        ]));
    }
    lines
}

fn draw_transport(
    frame: &mut Frame,
    area: Rect,
    data: Option<(&RunData, i64, bool)>,
    playing: bool,
) {
    let mut spans: Vec<Span> = Vec::new();
    if let Some((data, bounded_index, at_latest)) = data {
        let state = data.state;
        spans.push(Span::styled(
            format!(" {} {} ", status_glyph(state.status), state.status.label()),
            status_style(state.status).add_modifier(Modifier::BOLD),
        ));
        let elapsed = {
            let end = state
                .finished_at
                .as_deref()
                .and_then(parse_timestamp_ms)
                .unwrap_or_else(now_ms);
            let start = parse_timestamp_ms(&state.started_at).unwrap_or(end);
            format_duration((end - start).max(0))
        };
        spans.push(Span::raw(format!("{elapsed}  ")));
        let steps = state.steps.len() as i64;
        let position = if at_latest {
            if data.live {
                "LIVE".to_string()
            } else {
                format!("step {steps}/{steps}")
            }
        } else {
            format!("step {}/{}", bounded_index + 1, steps)
        };
        spans.push(Span::styled(
            position,
            if at_latest && data.live {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().add_modifier(Modifier::BOLD)
            },
        ));
        if playing {
            spans.push(Span::styled(
                " ▶".to_string(),
                Style::default().fg(Color::Green),
            ));
        }
        spans.push(Span::raw("  "));
    }
    spans.push(Span::styled(
        "[/]: scrub  space: play  g/G: start/live  z: zoom  f: follow  t: tab  Tab: focus  q: quit",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}
