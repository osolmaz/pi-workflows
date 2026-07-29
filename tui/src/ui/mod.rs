//! The interactive TUI (see docs/tui-viewer.md): a runs sidebar, the graph
//! pane, an inspector with steps/trace/conversation/info tabs, and a replay
//! transport. Works against a local runs directory, a single bundle, or a
//! `piw serve` WebSocket server; all three feed the same view model.

mod conversation;
mod graph;
mod theme_picker;
mod timeline;

use crate::bundle::reader::with_artifact_placeholders;
use crate::bundle::types::{DefinitionSnapshot, NodeOutcome, RunState, RunStatus, StepRecord};
use crate::client::RemoteRuns;
use crate::format::{format_duration, parse_timestamp_ms, sanitize_text};
use crate::render::{render_graph, GraphNodeStyle, GraphView, NodeBounds};
use crate::source::RunSource;
use crate::theme::{self, Palette, ThemeConfig};
use anyhow::Result;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

const LOCAL_REFRESH_INTERVAL: Duration = Duration::from_millis(300);
const PLAY_STEP_INTERVAL: Duration = Duration::from_millis(700);
const DEFAULT_NODE_STYLE: GraphNodeStyle = GraphNodeStyle::Box;

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
    pub remote_artifacts: HashMap<String, std::result::Result<String, String>>,
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
                    remote_artifacts: HashMap::new(),
                })
            }
            Provider::Remote(remote) => {
                let remote_artifacts = remote.artifact_snapshot(run_id);
                let view = remote.view(run_id)?;
                Some(RunData {
                    state: &view.state,
                    snapshot: view.snapshot.as_ref(),
                    events: &view.events,
                    session_entries: &view.session_entries,
                    live: view.live,
                    possibly_interrupted: view.possibly_interrupted,
                    bundle_dir: None,
                    remote_artifacts,
                })
            }
        }
    }

    fn request_artifacts(&mut self, run_id: &str, paths: &[String]) {
        if let Provider::Remote(remote) = self {
            for path in paths {
                remote.request_artifact(run_id, path);
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

    fn index(self) -> usize {
        match self {
            InspectorTab::Steps => 0,
            InspectorTab::Trace => 1,
            InspectorTab::Conversation => 2,
            InspectorTab::Info => 3,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum TraceScope {
    SelectedAttempt,
    ReplayVisible,
    FullRun,
}

impl TraceScope {
    fn next(self) -> Self {
        match self {
            Self::SelectedAttempt => Self::ReplayVisible,
            Self::ReplayVisible => Self::FullRun,
            Self::FullRun => Self::SelectedAttempt,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::SelectedAttempt => "selected attempt",
            Self::ReplayVisible => "replay visible",
            Self::FullRun => "full run",
        }
    }
}

struct App {
    provider: Provider,
    /// Whether the sidebar is shown (single-bundle mode hides it).
    show_sidebar: bool,
    sidebar_collapsed: bool,
    sidebar_explicit: bool,
    selected_run: Option<String>,
    runs_scroll: usize,
    focus: Focus,
    /// Replay position: `None` = live/latest; `Some(i)` = after step i
    /// (`-1` = before any step).
    replay: Option<i64>,
    playing: bool,
    last_play_step: Instant,
    playback_speed_index: usize,
    node_style: GraphNodeStyle,
    follow: bool,
    graph_offset: (usize, usize),
    graph_nodes: Vec<NodeBounds>,
    dragging: Option<(u16, u16, usize, usize)>,
    tab: InspectorTab,
    inspector_scroll: usize,
    inspector_scrolls: [usize; 4],
    inspector_expanded: bool,
    trace_scope: TraceScope,
    trace_selected: usize,
    trace_payload_expanded: bool,
    conversation_follow: bool,
    conversation_selected: usize,
    conversation_payload_expanded: bool,
    palette: Palette,
    theme_config: ThemeConfig,
    theme_config_path: std::path::PathBuf,
    theme_picker: Option<theme_picker::ThemePicker>,
    theme_diagnostic: Option<String>,
    /// Pane rectangles from the last draw, for mouse routing.
    frame_rect: Rect,
    runs_rect: Rect,
    timeline: timeline::TimelineGeometry,
    graph_rect: Rect,
    inspector_rect: Rect,
    quit: bool,
}

pub fn run_local(runs_dir: &Path, cli_theme: Option<&str>) -> Result<()> {
    let source = RunSource::new(runs_dir);
    run_app(
        Provider::Local {
            source,
            last_refresh: Instant::now(),
        },
        true,
        cli_theme,
    )
}

pub fn run_single(bundle_dir: &Path, cli_theme: Option<&str>) -> Result<()> {
    let source = RunSource::single(bundle_dir)?;
    run_app(
        Provider::Local {
            source,
            last_refresh: Instant::now(),
        },
        false,
        cli_theme,
    )
}

pub fn run_remote(url: &str, cli_theme: Option<&str>) -> Result<()> {
    let remote = RemoteRuns::connect(url)?;
    run_app(Provider::Remote(remote), true, cli_theme)
}

fn run_app(provider: Provider, show_sidebar: bool, cli_theme: Option<&str>) -> Result<()> {
    let resolved_theme = theme::resolve(cli_theme);
    let mut terminal = ratatui::init();
    crossterm::execute!(std::io::stdout(), EnableMouseCapture)?;
    let result = event_loop(&mut terminal, provider, show_sidebar, resolved_theme);
    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    provider: Provider,
    show_sidebar: bool,
    resolved_theme: theme::ResolvedTheme,
) -> Result<()> {
    let mut app = App {
        provider,
        show_sidebar,
        sidebar_collapsed: false,
        sidebar_explicit: false,
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
        playback_speed_index: 0,
        node_style: DEFAULT_NODE_STYLE,
        follow: true,
        graph_offset: (0, 0),
        graph_nodes: Vec::new(),
        dragging: None,
        tab: InspectorTab::Steps,
        inspector_scroll: 0,
        inspector_scrolls: [0; 4],
        inspector_expanded: false,
        trace_scope: TraceScope::SelectedAttempt,
        trace_selected: 0,
        trace_payload_expanded: false,
        conversation_follow: true,
        conversation_selected: 0,
        conversation_payload_expanded: false,
        palette: resolved_theme.palette,
        theme_config: resolved_theme.config,
        theme_config_path: resolved_theme.config_path,
        theme_picker: None,
        theme_diagnostic: resolved_theme.diagnostics.into_iter().next(),
        frame_rect: Rect::default(),
        runs_rect: Rect::default(),
        timeline: timeline::TimelineGeometry::default(),
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
        let speed = u32::from(timeline::PLAYBACK_SPEEDS[self.playback_speed_index]);
        let interval = PLAY_STEP_INTERVAL / speed;
        if !self.playing || self.last_play_step.elapsed() < interval {
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

    fn slower_playback(&mut self) {
        self.playback_speed_index = self.playback_speed_index.saturating_sub(1);
    }

    fn faster_playback(&mut self) {
        self.playback_speed_index =
            (self.playback_speed_index + 1).min(timeline::PLAYBACK_SPEEDS.len() - 1);
    }

    fn apply_timeline_action(&mut self, action: timeline::TimelineAction) {
        match action {
            timeline::TimelineAction::Start => {
                self.replay = Some(-1);
                self.playing = false;
            }
            timeline::TimelineAction::Previous => self.step_back(),
            timeline::TimelineAction::TogglePlayback => {
                if self.replay.is_none() {
                    self.replay = Some(-1);
                }
                self.playing = !self.playing;
                self.last_play_step = Instant::now();
            }
            timeline::TimelineAction::Next => self.step_forward(),
            timeline::TimelineAction::Live => {
                self.replay = None;
                self.playing = false;
            }
            timeline::TimelineAction::Slower => self.slower_playback(),
            timeline::TimelineAction::Faster => self.faster_playback(),
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

    fn select_inspector_tab(&mut self, tab: InspectorTab) {
        self.inspector_scrolls[self.tab.index()] = self.inspector_scroll;
        self.tab = tab;
        self.inspector_scroll = self.inspector_scrolls[tab.index()];
    }

    fn request_selected_artifacts(&mut self) {
        let Some(run_id) = self.selected_run.clone() else {
            return;
        };
        let replay = self.replay;
        let paths = {
            let Some(data) = self.provider.data(&run_id) else {
                return;
            };
            let index = replay.unwrap_or(data.state.steps.len() as i64 - 1);
            let Some(step) = usize::try_from(index)
                .ok()
                .and_then(|index| data.state.steps.get(index))
            else {
                return;
            };
            let mut paths = Vec::new();
            collect_artifact_paths(&step.prompt, &mut paths);
            collect_artifact_paths(&step.output, &mut paths);
            paths.sort();
            paths.dedup();
            paths
        };
        self.provider.request_artifacts(&run_id, &paths);
    }

    fn select_graph_node(&mut self, node_id: &str) {
        let Some(run_id) = self.selected_run.clone() else {
            return;
        };
        let replay = self.replay;
        let selected = {
            let Some(data) = self.provider.data(&run_id) else {
                return;
            };
            let upper = replay.unwrap_or(data.state.steps.len() as i64 - 1);
            data.state
                .steps
                .iter()
                .enumerate()
                .rev()
                .find(|(index, step)| *index as i64 <= upper && step.node_id == node_id)
                .map(|(index, _)| index as i64)
        };
        if let Some(index) = selected {
            self.replay = Some(index);
            self.playing = false;
            self.follow = true;
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
        self.select_run_id(summaries[next].run_id.clone());
    }

    fn select_run_id(&mut self, run_id: String) {
        if self.selected_run.as_deref() == Some(&run_id) {
            return;
        }
        self.selected_run = Some(run_id);
        self.replay = None;
        self.playing = false;
        self.inspector_scroll = 0;
        self.inspector_scrolls = [0; 4];
        self.inspector_expanded = false;
        self.trace_selected = 0;
        self.trace_payload_expanded = false;
        self.conversation_follow = true;
        self.conversation_selected = 0;
        self.conversation_payload_expanded = false;
        self.graph_offset = (0, 0);
        self.follow = true;
    }

    fn open_theme_picker(&mut self) {
        self.theme_picker = Some(theme_picker::ThemePicker::new(&self.palette));
    }

    fn preview_selected_theme(&mut self) {
        let Some(name) = self
            .theme_picker
            .as_ref()
            .map(|picker| picker.selected_name().to_string())
        else {
            return;
        };
        let (palette, diagnostics) = theme::palette_with_config(&name, &self.theme_config);
        self.palette = palette;
        if let Some(picker) = self.theme_picker.as_mut() {
            picker.error = diagnostics.into_iter().next();
        }
    }

    fn cancel_theme_picker(&mut self) {
        if let Some(picker) = self.theme_picker.take() {
            self.palette = picker.original_palette;
        }
    }

    fn apply_theme_picker(&mut self) {
        let Some(name) = self
            .theme_picker
            .as_ref()
            .map(|picker| picker.selected_name().to_string())
        else {
            return;
        };
        match theme::save_theme(&self.theme_config_path, &name) {
            Ok(()) => {
                self.theme_config.name = Some(name);
                self.theme_config.auto_switch = false;
                self.theme_picker = None;
                self.theme_diagnostic = None;
            }
            Err(error) => {
                if let Some(picker) = self.theme_picker.as_mut() {
                    picker.error = Some(sanitize_text(&format!("{error:#}")));
                }
            }
        }
    }
}

fn handle_theme_picker_key(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            if let Some(picker) = app.theme_picker.as_mut() {
                picker.move_previous();
            }
            app.preview_selected_theme();
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if let Some(picker) = app.theme_picker.as_mut() {
                picker.move_next();
            }
            app.preview_selected_theme();
        }
        KeyCode::Enter => app.apply_theme_picker(),
        KeyCode::Esc => app.cancel_theme_picker(),
        _ => {}
    }
}

fn handle_key(app: &mut App, summaries: &[RunSummary], key: KeyEvent) {
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.quit = true;
        return;
    }
    if app.theme_picker.is_some() {
        handle_theme_picker_key(app, key);
        return;
    }
    match key.code {
        KeyCode::Char('q') => app.quit = true,
        KeyCode::Char(',') => app.open_theme_picker(),
        KeyCode::Char('b') if app.show_sidebar => {
            app.sidebar_collapsed = !app.sidebar_collapsed;
            app.sidebar_explicit = true;
        }
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
        KeyCode::Char('{') => app.slower_playback(),
        KeyCode::Char('}') => app.faster_playback(),
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
            app.conversation_follow = true;
        }
        KeyCode::Char('z') | KeyCode::Char('+') | KeyCode::Char('-') => {
            app.node_style = match app.node_style {
                GraphNodeStyle::Line => GraphNodeStyle::Box,
                GraphNodeStyle::Box => GraphNodeStyle::Line,
            };
        }
        KeyCode::Char('f') => app.follow = !app.follow,
        KeyCode::Char('t') => app.select_inspector_tab(app.tab.next()),
        KeyCode::Char('1') => app.select_inspector_tab(InspectorTab::Steps),
        KeyCode::Char('2') => app.select_inspector_tab(InspectorTab::Trace),
        KeyCode::Char('3') => app.select_inspector_tab(InspectorTab::Conversation),
        KeyCode::Char('4') => app.select_inspector_tab(InspectorTab::Info),
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
                KeyCode::Up | KeyCode::Char('k') => match app.tab {
                    InspectorTab::Steps => app.step_back(),
                    InspectorTab::Trace => {
                        app.trace_selected = app.trace_selected.saturating_sub(1);
                        app.trace_payload_expanded = false;
                    }
                    InspectorTab::Conversation => {
                        app.conversation_selected = app.conversation_selected.saturating_sub(1);
                        app.conversation_payload_expanded = false;
                        app.conversation_follow = false;
                    }
                    InspectorTab::Info => {
                        app.inspector_scroll = app.inspector_scroll.saturating_sub(1)
                    }
                },
                KeyCode::Down | KeyCode::Char('j') => match app.tab {
                    InspectorTab::Steps => app.step_forward(),
                    InspectorTab::Trace => {
                        app.trace_selected = app.trace_selected.saturating_add(1);
                        app.trace_payload_expanded = false;
                    }
                    InspectorTab::Conversation => {
                        app.conversation_selected = app.conversation_selected.saturating_add(1);
                        app.conversation_payload_expanded = false;
                        app.conversation_follow = false;
                    }
                    InspectorTab::Info => app.inspector_scroll += 1,
                },
                KeyCode::Enter => match app.tab {
                    InspectorTab::Steps => {
                        app.inspector_expanded = !app.inspector_expanded;
                        if app.inspector_expanded {
                            app.request_selected_artifacts();
                        }
                    }
                    InspectorTab::Trace => app.trace_payload_expanded = !app.trace_payload_expanded,
                    InspectorTab::Conversation => {
                        app.conversation_payload_expanded = !app.conversation_payload_expanded
                    }
                    InspectorTab::Info => {}
                },
                KeyCode::Char('v') if app.tab == InspectorTab::Trace => {
                    app.trace_scope = app.trace_scope.next();
                    app.trace_selected = 0;
                    app.trace_payload_expanded = false;
                    app.inspector_scroll = 0;
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
    if app.theme_picker.is_some() {
        handle_theme_picker_mouse(app, mouse);
        return;
    }
    if matches!(
        mouse.kind,
        MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Drag(MouseButton::Left)
    ) && contains(app.timeline.track, mouse.column, mouse.row)
    {
        let steps = app.step_count() as usize;
        let column = mouse.column.saturating_sub(app.timeline.track.x) as usize;
        app.replay =
            timeline::position_from_column(steps, column, app.timeline.track.width as usize);
        app.playing = false;
        return;
    }
    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
        if let Some(action) = app
            .timeline
            .hits
            .iter()
            .find(|hit| contains(hit.rect, mouse.column, mouse.row))
            .map(|hit| hit.action)
        {
            app.apply_timeline_action(action);
            return;
        }
    }
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
                if app.tab == InspectorTab::Conversation {
                    app.conversation_follow = false;
                }
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
                    app.select_run_id(summaries[index].run_id.clone());
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
        MouseEventKind::Up(MouseButton::Left) => {
            if let Some((start_x, start_y, _, _)) = app.dragging.take() {
                let moved = start_x.abs_diff(mouse.column) + start_y.abs_diff(mouse.row);
                if moved <= 1 && contains(app.graph_rect, mouse.column, mouse.row) {
                    let canvas_x = mouse
                        .column
                        .saturating_sub(app.graph_rect.x.saturating_add(1))
                        as usize
                        + app.graph_offset.0;
                    let canvas_y = mouse.row.saturating_sub(app.graph_rect.y.saturating_add(1))
                        as usize
                        + app.graph_offset.1;
                    let node_id = app
                        .graph_nodes
                        .iter()
                        .find(|node| {
                            (canvas_x as i64) >= node.x
                                && (canvas_x as i64) < node.x + node.width
                                && (canvas_y as i64) >= node.y
                                && (canvas_y as i64) < node.y + node.height
                        })
                        .map(|node| node.node_id.clone());
                    if let Some(node_id) = node_id {
                        app.select_graph_node(&node_id);
                    }
                }
            }
        }
        _ => {}
    }
}

fn handle_theme_picker_mouse(app: &mut App, mouse: MouseEvent) {
    if mouse.kind != MouseEventKind::Down(MouseButton::Left) {
        return;
    }
    let popup = theme_picker::popup_rect(app.frame_rect);
    if !contains(popup, mouse.column, mouse.row) {
        return;
    }
    let inner_y = popup.y.saturating_add(1);
    let footer_height = if app
        .theme_picker
        .as_ref()
        .is_some_and(|picker| picker.error.is_some())
    {
        3
    } else {
        2
    };
    let list_height = popup.height.saturating_sub(2).saturating_sub(footer_height);
    if mouse.row >= inner_y && mouse.row < inner_y.saturating_add(list_height) {
        let index = mouse.row.saturating_sub(inner_y) as usize;
        if index < theme::THEME_NAMES.len() {
            if let Some(picker) = app.theme_picker.as_mut() {
                picker.selected = index;
                picker.error = None;
            }
            app.preview_selected_theme();
        }
    } else if mouse.row >= popup.y + popup.height.saturating_sub(2) {
        let relative = mouse.column.saturating_sub(popup.x);
        if relative < popup.width / 2 {
            app.apply_theme_picker();
        } else {
            app.cancel_theme_picker();
        }
    }
}

fn status_style(status: RunStatus, palette: &Palette) -> Style {
    let color = match status {
        RunStatus::Running => palette.running,
        RunStatus::Waiting => palette.warning,
        RunStatus::Completed => palette.success,
        RunStatus::Failed => palette.error,
        RunStatus::TimedOut => palette.timed_out,
        RunStatus::Cancelled => palette.cancelled,
    };
    Style::default().fg(color)
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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn draw(frame: &mut Frame, app: &mut App, summaries: &[RunSummary]) {
    let area = frame.area();
    app.frame_rect = area;
    let palette = app.palette.clone();
    frame.render_widget(
        Block::default().style(Style::default().fg(palette.text).bg(palette.app_bg)),
        area,
    );
    let transport_height = if area.height >= 18 && area.width >= 60 {
        2
    } else {
        1
    };
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(4), Constraint::Length(transport_height)])
        .split(area);
    let body = vertical[0];
    let transport = vertical[1];

    let sidebar_collapsed = app.sidebar_collapsed || (!app.sidebar_explicit && area.width < 100);
    let (runs_area, main_area) = if app.show_sidebar {
        let sidebar_width = if sidebar_collapsed { 8 } else { 34 };
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(sidebar_width), Constraint::Min(20)])
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
        draw_runs(frame, app, summaries, runs_area, sidebar_collapsed);
    }

    let Some(run_id) = app.selected_run.clone() else {
        // In remote mode an empty screen is ambiguous: say whether we are
        // still connecting, failed, or genuinely see no runs.
        let message = match &app.provider {
            Provider::Remote(remote) if !remote.connected() => {
                let detail = remote
                    .error()
                    .map(|error| format!(": {}", sanitize_text(&error)))
                    .unwrap_or_default();
                format!("{}…{detail}", remote.status_label())
            }
            Provider::Remote(_) => "No runs found.".to_string(),
            _ => "No runs found.".to_string(),
        };
        frame.render_widget(
            Paragraph::new(message)
                .style(Style::default().fg(palette.text).bg(palette.panel_bg))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" piw ")
                        .style(Style::default().bg(palette.panel_bg))
                        .border_style(pane_border(&palette, false)),
                ),
            main_area,
        );
        app.timeline = draw_transport(
            frame,
            transport,
            None,
            app.playing,
            timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
            &palette,
            app.theme_diagnostic.as_deref(),
        );
        if let Some(picker) = &app.theme_picker {
            theme_picker::render(frame, area, picker, &palette);
        }
        return;
    };
    let replay = app.replay;
    let node_style = app.node_style;
    let follow = app.follow;
    let graph_rect = app.graph_rect;
    let inspector_rect = app.inspector_rect;
    let tab = app.tab;
    let inspector_scroll = app.inspector_scroll;
    let inspector_expanded = app.inspector_expanded;
    let trace_scope = app.trace_scope;
    let trace_selected = app.trace_selected;
    let trace_payload_expanded = app.trace_payload_expanded;
    let conversation_follow = app.conversation_follow;
    let conversation_selected = if conversation_follow {
        usize::MAX
    } else {
        app.conversation_selected
    };
    let conversation_payload_expanded = app.conversation_payload_expanded;
    let focus = app.focus;
    let playing = app.playing;
    // Captured before `data` takes the mutable borrow: a dead remote
    // connection must be visible while a cached run is still displayed.
    let remote_status = match &app.provider {
        Provider::Remote(remote) if !remote.connected() => Some(remote.status_label()),
        _ => None,
    };

    let Some(data) = app.provider.data(&run_id) else {
        frame.render_widget(
            Paragraph::new("Loading run…")
                .style(Style::default().fg(palette.text).bg(palette.panel_bg))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" piw ")
                        .style(Style::default().bg(palette.panel_bg))
                        .border_style(pane_border(&palette, false)),
                ),
            main_area,
        );
        app.timeline = draw_transport(
            frame,
            transport,
            None,
            app.playing,
            timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
            &palette,
            app.theme_diagnostic.as_deref(),
        );
        if let Some(picker) = &app.theme_picker {
            theme_picker::render(frame, area, picker, &palette);
        }
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
    let rendered_graph = render_graph(&view, render_index, at_latest, now_ms(), node_style);
    let rows_runs = rendered_graph
        .as_ref()
        .map(|rendered| rendered.canvas.render_runs())
        .unwrap_or_default();
    app.graph_nodes = rendered_graph
        .map(|rendered| rendered.node_bounds)
        .unwrap_or_default();
    let inner_width = graph_rect.width.saturating_sub(2) as usize;
    let inner_height = graph_rect.height.saturating_sub(2) as usize;
    let (content_width, content_height) = graph::content_size(&rows_runs);
    let mut offset = app.graph_offset;
    if follow {
        if let Some((row, column)) = graph::find_focus(&rows_runs) {
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
        .map(|runs| graph::viewport_line(runs, offset.0, inner_width, &palette))
        .collect();
    let mut graph_flags = Vec::new();
    if data.state.paused == Some(true) {
        graph_flags.push("PAUSED");
    }
    if let Some(status) = remote_status {
        graph_flags.push(match status {
            "connecting" => "CONNECTING",
            "reconnecting" => "RECONNECTING",
            _ => "DISCONNECTED",
        });
    }
    let suffix = if graph_flags.is_empty() {
        String::new()
    } else {
        format!(" — {}", graph_flags.join(" · "))
    };
    let graph_title = format!(
        " {} {}{} ",
        sanitize_text(&data.state.workflow_name),
        graph_position_label(at_latest, data.live),
        suffix
    );
    let graph_block = Block::default()
        .borders(Borders::ALL)
        .title(graph_title)
        .style(Style::default().bg(palette.canvas_bg))
        .border_style(pane_border(&palette, focus == Focus::Graph));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(palette.text).bg(palette.canvas_bg))
            .block(graph_block),
        graph_rect,
    );

    // Inspector pane.
    let inspector_lines = match tab {
        InspectorTab::Steps => steps_lines(
            &data,
            visible_steps,
            selected_step,
            bounded_index,
            inspector_expanded,
            inspector_rect.width.saturating_sub(2) as usize,
            &palette,
        ),
        InspectorTab::Trace => trace_lines(
            data.events,
            visible_steps,
            selected_step,
            trace_scope,
            trace_selected,
            trace_payload_expanded,
            inspector_rect.width.saturating_sub(2) as usize,
            &palette,
        ),
        InspectorTab::Conversation => conversation::conversation_lines(
            data.session_entries,
            visible_steps,
            selected_step,
            conversation::ConversationRenderOptions {
                at_latest_step: at_latest,
                width: inspector_rect.width.saturating_sub(2) as usize,
                palette: &palette,
                selected_entry: Some(conversation_selected),
                payload_expanded: conversation_payload_expanded,
            },
        ),
        InspectorTab::Info => info_lines(&data, &run_id, &palette),
    };
    let inspector_height = inspector_rect.height.saturating_sub(2) as usize;
    let max_scroll = inspector_lines.len().saturating_sub(inspector_height);
    let scroll = if (tab == InspectorTab::Trace && at_latest && trace_scope == TraceScope::FullRun)
        || (tab == InspectorTab::Conversation && at_latest && conversation_follow)
    {
        max_scroll
    } else {
        inspector_scroll.min(max_scroll)
    };
    app.inspector_scroll = scroll;
    app.inspector_scrolls[tab.index()] = scroll;
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
        .style(Style::default().bg(palette.panel_bg))
        .border_style(pane_border(&palette, focus == Focus::Inspector));
    frame.render_widget(
        Paragraph::new(shown)
            .style(Style::default().fg(palette.text).bg(palette.panel_bg))
            .block(inspector_block),
        inspector_rect,
    );

    app.timeline = draw_transport(
        frame,
        transport,
        Some((&data, bounded_index, at_latest)),
        playing,
        timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
        &palette,
        app.theme_diagnostic.as_deref(),
    );
    if let Some(picker) = &app.theme_picker {
        theme_picker::render(frame, area, picker, &palette);
    }
}

fn graph_position_label(at_latest: bool, live: bool) -> &'static str {
    match (at_latest, live) {
        (false, _) => "(replay)",
        (true, true) => "(live)",
        (true, false) => "(latest)",
    }
}

fn pane_border(palette: &Palette, focused: bool) -> Style {
    Style::default().fg(if focused {
        palette.border_focused
    } else {
        palette.border
    })
}

fn draw_runs(
    frame: &mut Frame,
    app: &mut App,
    summaries: &[RunSummary],
    area: Rect,
    collapsed: bool,
) {
    let palette = &app.palette;
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
            let mut spans = if collapsed {
                let initial = sanitize_text(&name)
                    .chars()
                    .next()
                    .unwrap_or('?')
                    .to_string();
                vec![
                    Span::raw(if index == selected { "▶" } else { " " }),
                    Span::styled(
                        status_glyph(summary.status),
                        status_style(summary.status, palette),
                    ),
                    Span::raw(initial),
                    Span::styled(
                        if summary.possibly_interrupted {
                            "?"
                        } else {
                            " "
                        },
                        Style::default().fg(palette.timed_out),
                    ),
                ]
            } else {
                vec![
                    Span::raw(marker.to_string()),
                    Span::styled(
                        format!("{} ", status_glyph(summary.status)),
                        status_style(summary.status, palette),
                    ),
                    Span::raw(sanitize_text(&name)),
                    Span::styled(elapsed, Style::default().fg(palette.muted)),
                    Span::styled(
                        interrupted.to_string(),
                        Style::default().fg(palette.timed_out),
                    ),
                ]
            };
            if index == selected {
                spans = spans
                    .into_iter()
                    .map(|span| {
                        span.patch_style(
                            Style::default()
                                .bg(palette.selection_bg)
                                .add_modifier(Modifier::BOLD),
                        )
                    })
                    .collect();
            }
            Line::from(spans)
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(if collapsed {
            " R ".to_string()
        } else {
            format!(" Runs ({}) ", summaries.len())
        })
        .style(Style::default().bg(palette.panel_bg))
        .border_style(pane_border(palette, app.focus == Focus::Runs));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(palette.text).bg(palette.panel_bg))
            .block(block),
        area,
    );
}

fn outcome_glyph(outcome: NodeOutcome, palette: &Palette) -> (&'static str, Style) {
    match outcome {
        NodeOutcome::Ok => ("✓", Style::default().fg(palette.success)),
        NodeOutcome::Failed => ("✗", Style::default().fg(palette.error)),
        NodeOutcome::TimedOut => ("×", Style::default().fg(palette.timed_out)),
        NodeOutcome::Cancelled => ("~", Style::default().fg(palette.cancelled)),
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

fn collect_artifact_paths(value: &Value, paths: &mut Vec<String>) {
    if let Some(artifact) = crate::bundle::types::as_artifact_ref(value) {
        paths.push(artifact.path);
        return;
    }
    if let Some(escaped) = crate::bundle::types::as_escaped(value) {
        if let Some(object) = escaped.as_object() {
            for item in object.values() {
                collect_artifact_paths(item, paths);
            }
        }
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_artifact_paths(item, paths);
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                collect_artifact_paths(item, paths);
            }
        }
        _ => {}
    }
}

fn resolve_remote_artifacts(
    value: &Value,
    artifacts: &HashMap<String, std::result::Result<String, String>>,
) -> Value {
    if let Some(artifact) = crate::bundle::types::as_artifact_ref(value) {
        return match artifacts.get(&artifact.path) {
            Some(Ok(content)) => Value::String(content.clone()),
            Some(Err(error)) => Value::String(format!("«artifact error: {error}»")),
            None => with_artifact_placeholders(value),
        };
    }
    if let Some(escaped) = crate::bundle::types::as_escaped(value) {
        return match escaped.as_object() {
            Some(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| (key.clone(), resolve_remote_artifacts(item, artifacts)))
                    .collect(),
            ),
            None => escaped.clone(),
        };
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve_remote_artifacts(item, artifacts))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, item)| (key.clone(), resolve_remote_artifacts(item, artifacts)))
                .collect(),
        ),
        scalar => scalar.clone(),
    }
}

/// Compact single-line preview of a persisted value. Artifact references use
/// local checked reads or the bounded remote artifact cache.
fn preview_value(
    value: &Value,
    bundle_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
) -> String {
    let decoded = match bundle_dir {
        Some(dir) => {
            crate::bundle::reader::resolve_artifacts(value, dir, PREVIEW_ARTIFACT_MAX_BYTES)
        }
        None => resolve_remote_artifacts(value, remote_artifacts),
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

fn push_detail_line(
    lines: &mut Vec<Line<'static>>,
    label: &str,
    value: &str,
    width: usize,
    palette: &Palette,
) {
    let label_width = 14usize.min(width.saturating_sub(1));
    let body_width = width.saturating_sub(label_width).max(20);
    let text = sanitize_text(value);
    let chars: Vec<char> = text.chars().collect();
    let chunks: Vec<String> = if chars.is_empty() {
        vec!["—".to_string()]
    } else {
        chars
            .chunks(body_width)
            .map(|chunk| chunk.iter().collect())
            .collect()
    };
    for (index, chunk) in chunks.into_iter().enumerate() {
        let label_text = if index == 0 {
            format!("{label:<label_width$}")
        } else {
            " ".repeat(label_width)
        };
        lines.push(Line::from(vec![
            Span::styled(label_text, Style::default().fg(palette.accent)),
            Span::styled(chunk, Style::default().fg(palette.text)),
        ]));
    }
}

fn push_value_lines(
    lines: &mut Vec<Line<'static>>,
    label: &str,
    value: &Value,
    bundle_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
    width: usize,
    palette: &Palette,
) {
    let decoded = match bundle_dir {
        Some(dir) => {
            crate::bundle::reader::resolve_artifacts(value, dir, PREVIEW_ARTIFACT_MAX_BYTES)
        }
        None => resolve_remote_artifacts(value, remote_artifacts),
    };
    let rendered = match decoded {
        Value::String(text) => text,
        other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
    };
    for (index, logical_line) in rendered.lines().enumerate() {
        push_detail_line(
            lines,
            if index == 0 { label } else { "" },
            logical_line,
            width,
            palette,
        );
    }
    if rendered.is_empty() {
        push_detail_line(lines, label, "—", width, palette);
    }
}

fn steps_lines(
    data: &RunData,
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    bounded_index: i64,
    expanded: bool,
    width: usize,
    palette: &Palette,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    // Only the steps visible at the replay position: while scrubbing, the
    // pane must not reveal outcomes the graph does not show yet.
    for (index, step) in visible_steps.iter().enumerate() {
        let (glyph, style) = outcome_glyph(step.outcome, palette);
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
                Style::default().fg(palette.replay_focus),
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
            Style::default().fg(palette.muted),
        )));
        lines.push(Line::from(Span::styled(
            if expanded {
                "expanded details (Enter to collapse)"
            } else {
                "summary (Enter to expand)"
            },
            Style::default().fg(palette.muted),
        )));
        if expanded {
            if !step.prompt.is_null() {
                push_value_lines(
                    &mut lines,
                    "prompt",
                    &step.prompt,
                    data.bundle_dir,
                    &data.remote_artifacts,
                    width,
                    palette,
                );
            }
            push_value_lines(
                &mut lines,
                "output",
                &step.output,
                data.bundle_dir,
                &data.remote_artifacts,
                width,
                palette,
            );
            if let Some(action) = &step.action {
                push_detail_line(
                    &mut lines,
                    "action type",
                    &action.action_type,
                    width,
                    palette,
                );
                if let Some(command) = &action.command {
                    push_detail_line(&mut lines, "command", command, width, palette);
                }
                if let Some(args) = &action.args {
                    push_detail_line(
                        &mut lines,
                        "arguments",
                        &serde_json::to_string(args).unwrap_or_default(),
                        width,
                        palette,
                    );
                }
                if let Some(cwd) = &action.cwd {
                    push_detail_line(&mut lines, "working dir", cwd, width, palette);
                }
                if let Some(exit_code) = &action.exit_code {
                    push_detail_line(
                        &mut lines,
                        "exit code",
                        &exit_code.to_string(),
                        width,
                        palette,
                    );
                }
                if let Some(signal) = &action.signal {
                    push_detail_line(&mut lines, "signal", &signal.to_string(), width, palette);
                }
                if let Some(duration) = action.duration_ms {
                    push_detail_line(
                        &mut lines,
                        "action time",
                        &format_duration(duration as i64),
                        width,
                        palette,
                    );
                }
            }
            if let Some(error) = &step.error {
                push_detail_line(&mut lines, "error", error, width, palette);
            }
            push_detail_line(&mut lines, "started", &step.started_at, width, palette);
            push_detail_line(&mut lines, "finished", &step.finished_at, width, palette);
        } else {
            if !step.prompt.is_null() {
                lines.push(Line::from(vec![
                    Span::styled("prompt: ", Style::default().fg(palette.accent)),
                    Span::raw(preview_value(
                        &step.prompt,
                        data.bundle_dir,
                        &data.remote_artifacts,
                    )),
                ]));
            }
            lines.push(Line::from(vec![
                Span::styled("output: ", Style::default().fg(palette.accent)),
                Span::raw(preview_value(
                    &step.output,
                    data.bundle_dir,
                    &data.remote_artifacts,
                )),
            ]));
            if let Some(action) = &step.action {
                let command = action.command.clone().unwrap_or_default();
                lines.push(Line::from(vec![
                    Span::styled("action: ", Style::default().fg(palette.accent)),
                    Span::raw(sanitize_text(&format!(
                        "{} {}",
                        action.action_type, command
                    ))),
                ]));
            }
            if let Some(error) = &step.error {
                lines.push(Line::from(vec![
                    Span::styled("error: ", Style::default().fg(palette.error)),
                    Span::raw(sanitize_text(error)),
                ]));
            }
        }
    }
    lines
}

fn trace_events_for_scope<'a>(
    events: &'a [Value],
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    scope: TraceScope,
) -> Vec<&'a Value> {
    match scope {
        TraceScope::SelectedAttempt => {
            let Some(attempt_id) = selected_step.map(|step| step.attempt_id.as_str()) else {
                return Vec::new();
            };
            events
                .iter()
                .filter(|event| event.get("attemptId").and_then(Value::as_str) == Some(attempt_id))
                .collect()
        }
        TraceScope::ReplayVisible => {
            let attempts: HashSet<&str> = visible_steps
                .iter()
                .map(|step| step.attempt_id.as_str())
                .collect();
            let cutoff = events
                .iter()
                .filter(|event| {
                    event
                        .get("attemptId")
                        .and_then(Value::as_str)
                        .is_some_and(|attempt| attempts.contains(attempt))
                })
                .filter_map(|event| event.get("seq").and_then(Value::as_u64))
                .max();
            cutoff.map_or_else(Vec::new, |cutoff| {
                events
                    .iter()
                    .filter(|event| event.get("seq").and_then(Value::as_u64).unwrap_or(0) <= cutoff)
                    .collect()
            })
        }
        TraceScope::FullRun => events.iter().collect(),
    }
}

#[allow(clippy::too_many_arguments)]
fn trace_lines(
    events: &[Value],
    visible_steps: &[StepRecord],
    selected_step: Option<&StepRecord>,
    scope: TraceScope,
    selected_index: usize,
    payload_expanded: bool,
    width: usize,
    palette: &Palette,
) -> Vec<Line<'static>> {
    let filtered = trace_events_for_scope(events, visible_steps, selected_step, scope);
    let selected_index = selected_index.min(filtered.len().saturating_sub(1));
    let mut lines = vec![Line::from(vec![
        Span::styled("scope: ", Style::default().fg(palette.accent)),
        Span::styled(scope.label(), Style::default().fg(palette.text)),
        Span::styled(
            "  v: change scope  Enter: payload",
            Style::default().fg(palette.muted),
        ),
    ])];
    for (index, event) in filtered.iter().enumerate() {
        let seq = event.get("seq").and_then(Value::as_u64).unwrap_or(0);
        let event_type = sanitize_text(event.get("type").and_then(Value::as_str).unwrap_or("?"));
        let node = event
            .get("nodeId")
            .and_then(Value::as_str)
            .map(|node| format!(" {}", sanitize_text(node)))
            .unwrap_or_default();
        let style = match event_type.as_str() {
            "node_failed" | "run_failed" => Style::default().fg(palette.error),
            "run_completed" => Style::default().fg(palette.success),
            "node_started" => Style::default().fg(palette.running),
            _ => Style::default().fg(palette.text),
        };
        let marker = if index == selected_index { "▶" } else { " " };
        lines.push(Line::from(vec![
            Span::styled(marker, Style::default().fg(palette.replay_focus)),
            Span::styled(format!("{seq:>5} "), Style::default().fg(palette.muted)),
            Span::styled(event_type, style),
            Span::styled(node, Style::default().fg(palette.subtext)),
        ]));
        if index == selected_index && payload_expanded {
            let payload = event.get("payload").unwrap_or(&Value::Null);
            let rendered =
                serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string());
            for logical_line in rendered.lines() {
                push_detail_line(&mut lines, "", logical_line, width, palette);
            }
        }
    }
    if filtered.is_empty() {
        lines.push(Line::from(Span::styled(
            "No events in this scope.",
            Style::default().fg(palette.muted),
        )));
    }
    lines
}

fn info_lines(data: &RunData, run_id: &str, palette: &Palette) -> Vec<Line<'static>> {
    let state = data.state;
    let label =
        |text: &str| Span::styled(format!("{text:<14}"), Style::default().fg(palette.accent));
    // Everything below except the derived counts is bundle-derived text.
    let mut lines = vec![
        Line::from(vec![label("run"), Span::raw(sanitize_text(run_id))]),
        Line::from(vec![
            label("workflow"),
            Span::raw(sanitize_text(&state.workflow_name)),
        ]),
        Line::from(vec![
            label("status"),
            Span::styled(
                state.status.label().to_string(),
                status_style(state.status, palette),
            ),
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
            Span::styled(sanitize_text(error), Style::default().fg(palette.error)),
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
            Style::default().fg(palette.timed_out),
        )));
    }
    if let Some(output) = &state.final_output {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            label("final output"),
            Span::raw(preview_value(
                output,
                data.bundle_dir,
                &data.remote_artifacts,
            )),
        ]));
    }
    lines
}

fn draw_transport(
    frame: &mut Frame,
    area: Rect,
    data: Option<(&RunData, i64, bool)>,
    playing: bool,
    speed: u16,
    palette: &Palette,
    diagnostic: Option<&str>,
) -> timeline::TimelineGeometry {
    let elapsed = data.map(|(data, _, _)| {
        let state = data.state;
        let end = state
            .finished_at
            .as_deref()
            .and_then(parse_timestamp_ms)
            .unwrap_or_else(now_ms);
        let start = parse_timestamp_ms(&state.started_at).unwrap_or(end);
        format_duration((end - start).max(0))
    });
    let view = data.map(|(data, bounded_index, at_latest)| timeline::TimelineView {
        status: data.state.status,
        paused: data.state.paused == Some(true),
        elapsed: elapsed.as_deref().unwrap_or("0ms"),
        steps: data.state.steps.len(),
        position: bounded_index,
        at_latest,
        live: data.live,
        playing,
        speed,
        diagnostic,
    });
    timeline::render(frame, area, view, palette)
}

#[cfg(test)]
mod tests {
    use super::{
        collect_artifact_paths, graph_position_label, resolve_remote_artifacts,
        trace_events_for_scope, GraphNodeStyle, StepRecord, TraceScope, DEFAULT_NODE_STYLE,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn bordered_nodes_are_the_default() {
        assert_eq!(DEFAULT_NODE_STYLE, GraphNodeStyle::Box);
    }

    #[test]
    fn graph_title_separates_replay_position_from_run_liveness() {
        assert_eq!(graph_position_label(false, true), "(replay)");
        assert_eq!(graph_position_label(false, false), "(replay)");
        assert_eq!(graph_position_label(true, true), "(live)");
        assert_eq!(graph_position_label(true, false), "(latest)");
    }

    #[test]
    fn remote_artifacts_recurse_into_escaped_object_children() {
        let value = json!({
            "$escaped": {
                "nested": {
                    "$artifact": {
                        "path": "artifacts/sha256/a.txt",
                        "mediaType": "text/plain",
                        "bytes": 4,
                        "sha256": "a"
                    }
                }
            }
        });
        let mut paths = Vec::new();
        collect_artifact_paths(&value, &mut paths);
        assert_eq!(paths, vec!["artifacts/sha256/a.txt"]);
        let artifacts =
            HashMap::from([("artifacts/sha256/a.txt".to_string(), Ok("body".to_string()))]);
        assert_eq!(
            resolve_remote_artifacts(&value, &artifacts),
            json!({"nested": "body"})
        );
    }

    #[test]
    fn replay_visible_trace_stops_before_future_attempts() {
        let step: StepRecord = serde_json::from_value(json!({
            "attemptId": "a1",
            "nodeId": "plan",
            "nodeType": "agent",
            "outcome": "ok",
            "startedAt": "2026-01-01T00:00:00Z",
            "finishedAt": "2026-01-01T00:00:01Z",
            "prompt": null,
            "output": null
        }))
        .unwrap();
        let events = vec![
            json!({"seq": 1, "type": "run_started"}),
            json!({"seq": 2, "type": "node_started", "attemptId": "a1"}),
            json!({"seq": 3, "type": "node_completed", "attemptId": "a1"}),
            json!({"seq": 4, "type": "node_started", "attemptId": "a2"}),
        ];
        let visible = trace_events_for_scope(
            &events,
            std::slice::from_ref(&step),
            Some(&step),
            TraceScope::ReplayVisible,
        );
        assert_eq!(visible.len(), 3);
        assert_eq!(visible.last().unwrap()["seq"], 3);
        let selected = trace_events_for_scope(
            &events,
            std::slice::from_ref(&step),
            Some(&step),
            TraceScope::SelectedAttempt,
        );
        assert_eq!(selected.len(), 2);
    }
}
