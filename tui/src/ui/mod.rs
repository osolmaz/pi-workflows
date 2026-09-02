//! The interactive TUI (see docs/tui-viewer.md): a runs sidebar, the graph
//! pane, an inspector with steps/trace/conversation/info tabs, and a replay
//! transport. Works against a local runs directory, a single run, or a
//! `piw serve` WebSocket server; all three feed the same view model.

mod controls;
mod conversation;
mod graph;
mod theme_picker;
mod timeline;

use crate::client::RemoteRuns;
use crate::format::{format_duration, parse_timestamp_ms, sanitize_text};
use crate::layout::GraphLayout;
use crate::protocol::PageKind;
use crate::render::{
    render_graph, render_graph_with_layout, GraphNodeStyle, GraphView, NodeBounds, RenderedGraph,
};
use crate::session::{assess_capture, CaptureIntegrity};
use crate::state::types::{
    DefinitionSnapshot, EdgeDef, NodeOutcome, RunState, RunStatus, SessionCapture,
    SessionEntryRecord, SessionEventRecord, StepRecord, SESSION_BINDING_SCHEMA,
};
use crate::theme::{self, Palette, ThemeConfig};
use anyhow::Result;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::backend::TestBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::{Frame, Terminal};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

const PLAY_STEP_INTERVAL: Duration = Duration::from_millis(700);
const DEFAULT_NODE_STYLE: GraphNodeStyle = GraphNodeStyle::Box;
const DEFAULT_SIDEBAR_WIDTH: u16 = 34;
const MIN_SIDEBAR_WIDTH: u16 = 12;
const MIN_MAIN_WIDTH: u16 = 24;
const MIN_GRAPH_HEIGHT: u16 = 5;
const MIN_INSPECTOR_HEIGHT: u16 = 5;
const ONCE_WIDTH: u16 = 120;
const ONCE_HEIGHT: u16 = 40;
const ONCE_TIMEOUT: Duration = Duration::from_secs(10);

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
    pub graph_revision: u64,
    pub state: &'a RunState,
    pub graph_steps: &'a [crate::state::types::StepRecord],
    pub taken_transitions: &'a [String],
    pub graph_cursor: u64,
    pub step_start: u64,
    pub step_total: u64,
    pub snapshot: Option<&'a DefinitionSnapshot>,
    pub graph_layout: Option<&'a GraphLayout>,
    pub events: &'a [Value],
    pub trace_start: u64,
    pub trace_total: u64,
    pub session_bound: bool,
    pub session_entries: &'a [Value],
    pub session_entry_start: u64,
    pub session_entry_total: u64,
    pub session_events: &'a [Value],
    pub session_event_start: u64,
    pub session_event_total: u64,
    pub session_events_malformed: bool,
    pub session_events_torn_tail: bool,
    pub session_capture: Option<&'a Value>,
    pub session_replay_checkpoint: Option<&'a Value>,
    pub settings_scopes: &'a [Value],
    pub settings_start: u64,
    pub settings_total: u64,
    pub follow_up_queue: Option<&'a Value>,
    pub follow_up_start: u64,
    pub follow_up_total: u64,
    pub update_start: u64,
    pub update_total: u64,
    pub live: bool,
    pub possibly_interrupted: bool,
    /// Bundle directory when reading the filesystem directly; lets previews
    /// inline small artifacts instead of showing placeholders.
    pub run_dir: Option<&'a std::path::Path>,
    pub remote_artifacts: HashMap<String, std::result::Result<String, String>>,
}

pub enum Provider {
    Remote(RemoteRuns),
}

fn valid_session_binding(binding: Option<&Value>) -> bool {
    binding
        .and_then(|value| value.get("schema"))
        .and_then(Value::as_str)
        == Some(SESSION_BINDING_SCHEMA)
}

fn parse_run_summary(summary: &Value) -> Option<RunSummary> {
    let manifest: crate::state::types::Manifest =
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
}

impl Provider {
    fn tick(&mut self) {}

    fn ensure_watch(&mut self, run_id: &str) {
        let Provider::Remote(remote) = self;
        remote.watch(run_id);
    }

    fn summaries(&self) -> Vec<RunSummary> {
        let Provider::Remote(remote) = self;
        remote
            .summaries()
            .iter()
            .filter_map(parse_run_summary)
            .collect()
    }

    fn data(&mut self, run_id: &str) -> Option<RunData<'_>> {
        let Provider::Remote(remote) = self;
        let remote_artifacts = remote.artifact_snapshot(run_id);
        let view = remote.view(run_id)?;
        Some(RunData {
            graph_revision: view.graph_revision,
            state: &view.state,
            graph_steps: &view.graph_steps,
            taken_transitions: &view.taken_transitions,
            graph_cursor: view.graph_cursor,
            step_start: view.step_start,
            step_total: view.step_total,
            snapshot: view.snapshot.as_ref(),
            graph_layout: view.graph_layout.as_ref(),
            events: &view.events,
            trace_start: view.trace_start,
            trace_total: view.trace_total,
            session_bound: valid_session_binding(view.session_binding.as_ref()),
            session_entries: &view.session_entries,
            session_entry_start: view.session_entry_start,
            session_entry_total: view.session_entry_total,
            session_events: &view.session_events,
            session_event_start: view.session_event_start,
            session_event_total: view.session_event_total,
            session_events_malformed: view.session_events_malformed,
            session_events_torn_tail: view.session_events_torn_tail,
            session_capture: view.session_capture.as_ref(),
            session_replay_checkpoint: view.session_replay_checkpoint.as_ref(),
            settings_scopes: &view.settings_scopes,
            settings_start: view.settings_start,
            settings_total: view.settings_total,
            follow_up_queue: view.follow_up_queue.as_ref(),
            follow_up_start: view.follow_up_start,
            follow_up_total: view.follow_up_total,
            update_start: view.update_start,
            update_total: view.update_total,
            live: view.live,
            possibly_interrupted: view.possibly_interrupted,
            run_dir: None,
            remote_artifacts,
        })
    }

    fn request_window(
        &mut self,
        run_id: &str,
        step: Option<u64>,
        trace: Option<u64>,
        session_entry: Option<u64>,
        session_event: Option<u64>,
    ) {
        let Provider::Remote(remote) = self;
        if let Some(cursor) = step {
            remote.request_page(run_id, PageKind::Steps, cursor);
            remote.request_page(run_id, PageKind::TraceAtStep, cursor);
        }
        if let Some(cursor) = trace {
            remote.request_page(run_id, PageKind::Trace, cursor);
        }
        if let Some(cursor) = session_entry {
            remote.request_page(run_id, PageKind::SessionEntries, cursor);
        }
        if let Some(cursor) = session_event {
            remote.request_page(run_id, PageKind::SessionEvents, cursor);
        }
    }

    fn request_info_window(
        &mut self,
        run_id: &str,
        settings: Option<u64>,
        follow_ups: Option<u64>,
        updates: Option<u64>,
    ) {
        let Provider::Remote(remote) = self;
        if let Some(cursor) = settings {
            remote.request_page(run_id, PageKind::Settings, cursor);
        }
        if let Some(cursor) = follow_ups {
            remote.request_page(run_id, PageKind::FollowUps, cursor);
        }
        if let Some(cursor) = updates {
            remote.request_page(run_id, PageKind::Updates, cursor);
        }
    }

    fn request_artifacts(&mut self, run_id: &str, paths: &[String]) {
        let Provider::Remote(remote) = self;
        for path in paths {
            remote.request_artifact(run_id, path);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Runs,
    Graph,
    Inspector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    const ALL: [Self; 4] = [Self::Steps, Self::Trace, Self::Conversation, Self::Info];

    fn title(self) -> &'static str {
        match self {
            InspectorTab::Steps => "Steps",
            InspectorTab::Trace => "Trace",
            InspectorTab::Conversation => "Conversation",
            InspectorTab::Info => "Info",
        }
    }

    fn symbol(self) -> &'static str {
        match self {
            InspectorTab::Steps => "◆",
            InspectorTab::Trace => "≡",
            InspectorTab::Conversation => "●",
            InspectorTab::Info => "ⓘ",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct InspectorTabHit {
    rect: Rect,
    tab: InspectorTab,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TraceScope {
    SelectedAttempt,
    ReplayVisible,
    LoadedPage,
}

impl TraceScope {
    fn next(self) -> Self {
        match self {
            Self::SelectedAttempt => Self::ReplayVisible,
            Self::ReplayVisible => Self::LoadedPage,
            Self::LoadedPage => Self::SelectedAttempt,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::SelectedAttempt => "selected attempt",
            Self::ReplayVisible => "replay visible",
            Self::LoadedPage => "loaded page",
        }
    }
}

#[derive(Clone, Copy)]
enum DragTarget {
    Graph {
        start_x: u16,
        start_y: u16,
        origin_x: i64,
        origin_y: i64,
    },
    Sidebar,
    Inspector,
}

#[derive(Clone, PartialEq, Eq)]
struct GraphCacheKey {
    run_id: String,
    graph_revision: u64,
    replay_position: i64,
    graph_cursor: u64,
    at_latest: bool,
    node_style: GraphNodeStyle,
    elapsed_second: i64,
}

struct GraphCache {
    key: GraphCacheKey,
    rendered: Option<RenderedGraph>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemporalDelay {
    Ready(Duration),
    Pending(u64),
    Invalid,
}

struct App {
    provider: Provider,
    /// Whether the sidebar is shown (single-run mode hides it).
    show_sidebar: bool,
    sidebar_collapsed: bool,
    sidebar_explicit: bool,
    sidebar_width: u16,
    inspector_height: Option<u16>,
    selected_run: Option<String>,
    runs_scroll: usize,
    focus: Focus,
    /// Workflow replay position: `None` = live/latest; `Some(i)` = after step i.
    replay: Option<i64>,
    /// Temporal replay position: `None` = newest event; `Some(-1)` = before
    /// capture; other values are zero-based session-event indices.
    temporal_replay: Option<i64>,
    playing: bool,
    last_play_step: Instant,
    playback_speed_index: usize,
    node_style: GraphNodeStyle,
    follow: bool,
    /// Canvas coordinate shown at the viewport's top-left. Negative origins
    /// provide the padding needed to truly center edge nodes and small graphs.
    graph_offset: (i64, i64),
    graph_nodes: Vec<NodeBounds>,
    graph_cache: Option<GraphCache>,
    dragging: Option<DragTarget>,
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
    main_rect: Rect,
    runs_rect: Rect,
    timeline: timeline::TimelineGeometry,
    graph_rect: Rect,
    inspector_rect: Rect,
    inspector_tab_hits: Vec<InspectorTabHit>,
    quit: bool,
}

pub fn run_local(socket_path: &Path, cli_theme: Option<&str>) -> Result<()> {
    let remote = RemoteRuns::connect_local(socket_path)?;
    run_app(Provider::Remote(remote), true, None, cli_theme)
}

pub fn run_single(socket_path: &Path, run_id: &str, cli_theme: Option<&str>) -> Result<()> {
    let mut remote = RemoteRuns::connect_local(socket_path)?;
    remote.watch(run_id);
    run_app(
        Provider::Remote(remote),
        false,
        Some(run_id.to_owned()),
        cli_theme,
    )
}

/// Render one complete run view without taking over the terminal.
pub fn render_single_once(
    socket_path: &Path,
    run_id: &str,
    cli_theme: Option<&str>,
) -> Result<String> {
    let mut remote = RemoteRuns::connect_local(socket_path)?;
    remote.watch(run_id);
    let deadline = Instant::now() + ONCE_TIMEOUT;
    loop {
        if remote.view(run_id).is_some() {
            break;
        }
        if let Some(error) = remote.error() {
            anyhow::bail!(error);
        }
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for workflow run {run_id}");
        }
        thread::sleep(Duration::from_millis(50));
    }

    let resolved_theme = theme::resolve(cli_theme);
    let app = create_app(
        Provider::Remote(remote),
        false,
        Some(run_id.to_owned()),
        resolved_theme,
    );
    render_app_once(app, ONCE_WIDTH, ONCE_HEIGHT)
}

pub fn run_remote(url: &str, cli_theme: Option<&str>) -> Result<()> {
    let remote = RemoteRuns::connect(url)?;
    run_app(Provider::Remote(remote), true, None, cli_theme)
}

fn run_app(
    provider: Provider,
    show_sidebar: bool,
    initial_run: Option<String>,
    cli_theme: Option<&str>,
) -> Result<()> {
    let resolved_theme = theme::resolve(cli_theme);
    let mut terminal = ratatui::init();
    if let Err(error) = crossterm::execute!(std::io::stdout(), EnableMouseCapture) {
        ratatui::restore();
        return Err(error.into());
    }
    let result = event_loop(
        &mut terminal,
        provider,
        show_sidebar,
        initial_run,
        resolved_theme,
    );
    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    provider: Provider,
    show_sidebar: bool,
    initial_run: Option<String>,
    resolved_theme: theme::ResolvedTheme,
) -> Result<()> {
    let mut app = create_app(provider, show_sidebar, initial_run, resolved_theme);

    while !app.quit {
        app.provider.tick();
        let summaries = app.provider.summaries();
        let selected_available = summaries
            .iter()
            .any(|summary| Some(&summary.run_id) == app.selected_run.as_ref());
        app.selected_run = reconcile_selected_run(
            app.selected_run.take(),
            summaries.first().map(|summary| summary.run_id.as_str()),
            selected_available,
            app.show_sidebar,
        );
        if let Some(run_id) = app.selected_run.clone() {
            app.provider.ensure_watch(&run_id);
        }
        app.ensure_step_window();
        app.ensure_replay_window();
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

fn create_app(
    provider: Provider,
    show_sidebar: bool,
    initial_run: Option<String>,
    resolved_theme: theme::ResolvedTheme,
) -> App {
    let sidebar_width = resolved_theme
        .ui
        .sidebar_width
        .unwrap_or(DEFAULT_SIDEBAR_WIDTH);
    let inspector_height = resolved_theme.ui.inspector_height;
    App {
        provider,
        show_sidebar,
        sidebar_collapsed: false,
        sidebar_explicit: false,
        sidebar_width,
        inspector_height,
        selected_run: initial_run,
        runs_scroll: 0,
        focus: if show_sidebar {
            Focus::Runs
        } else {
            Focus::Graph
        },
        replay: None,
        temporal_replay: None,
        playing: false,
        last_play_step: Instant::now(),
        playback_speed_index: 0,
        node_style: DEFAULT_NODE_STYLE,
        follow: true,
        graph_offset: (0, 0),
        graph_nodes: Vec::new(),
        graph_cache: None,
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
        main_rect: Rect::default(),
        runs_rect: Rect::default(),
        timeline: timeline::TimelineGeometry::default(),
        graph_rect: Rect::default(),
        inspector_rect: Rect::default(),
        inspector_tab_hits: Vec::new(),
        quit: false,
    }
}

fn render_app_once(mut app: App, width: u16, height: u16) -> Result<String> {
    app.provider.tick();
    let summaries = app.provider.summaries();
    if let Some(run_id) = app.selected_run.clone() {
        app.provider.ensure_watch(&run_id);
    }
    app.ensure_step_window();
    app.ensure_replay_window();

    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| draw(frame, &mut app, &summaries))?;
    let lines = terminal
        .backend()
        .buffer()
        .content
        .chunks(width as usize)
        .map(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>();
    Ok(lines.join("\n").trim_end().to_owned())
}

fn reconcile_selected_run(
    selected_run: Option<String>,
    first_available_run: Option<&str>,
    selected_available: bool,
    allow_reselection: bool,
) -> Option<String> {
    if allow_reselection && (selected_run.is_none() || !selected_available) {
        first_available_run.map(str::to_owned)
    } else {
        selected_run
    }
}

impl App {
    fn ensure_step_window(&mut self) {
        let (Some(run_id), Some(position)) = (
            self.selected_run.clone(),
            self.replay.filter(|value| *value >= 0),
        ) else {
            return;
        };
        let cursor = position as u64;
        let loaded = self.provider.data(&run_id).is_some_and(|data| {
            step_projection_contains(
                cursor,
                data.graph_cursor,
                data.step_start,
                data.state.steps.len(),
            )
        });
        if !loaded {
            self.provider
                .request_window(&run_id, Some(cursor), None, None, None);
        }
    }

    fn ensure_replay_window(&mut self) {
        let (Some(run_id), Some(position)) = (
            self.selected_run.clone(),
            self.temporal_replay.filter(|value| *value >= 0),
        ) else {
            return;
        };
        let cursor = position as u64;
        let loaded = self.provider.data(&run_id).is_some_and(|data| {
            cursor >= data.session_event_start
                && cursor < data.session_event_start + data.session_events.len() as u64
        });
        if loaded {
            self.sync_step_to_temporal();
        } else {
            self.provider
                .request_window(&run_id, None, None, Some(cursor), Some(cursor));
        }
    }

    fn replay_counts(&mut self) -> (i64, i64, bool) {
        let Some(run_id) = self.selected_run.clone() else {
            return (0, 0, false);
        };
        self.provider
            .data(&run_id)
            .map(|data| {
                (
                    data.step_total as i64,
                    data.session_event_total as i64,
                    data.live,
                )
            })
            .unwrap_or((0, 0, false))
    }

    fn temporal_delay(&mut self, current: i64, speed: u32) -> TemporalDelay {
        let Some(run_id) = self.selected_run.clone() else {
            return TemporalDelay::Invalid;
        };
        let delay = self
            .provider
            .data(&run_id)
            .map_or(TemporalDelay::Invalid, |data| {
                temporal_delay_from_page(
                    data.session_events,
                    data.session_event_start,
                    current,
                    speed,
                )
            });
        if let TemporalDelay::Pending(cursor) = delay {
            self.provider
                .request_window(&run_id, None, None, Some(cursor), Some(cursor));
        }
        delay
    }

    fn sync_step_to_temporal(&mut self) {
        let Some(position) = self.temporal_replay else {
            return;
        };
        if position < 0 {
            self.replay = Some(-1);
            return;
        }
        let Some(run_id) = self.selected_run.clone() else {
            return;
        };
        let selected = {
            let Some(data) = self.provider.data(&run_id) else {
                return;
            };
            let Ok(position) = u64::try_from(position) else {
                return;
            };
            let Some(local) = position.checked_sub(data.session_event_start) else {
                return;
            };
            let Some(event) = data.session_events.get(local as usize) else {
                return;
            };
            event
                .get("stepIndex")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| {
                    event
                        .get("at")
                        .and_then(Value::as_str)
                        .and_then(parse_timestamp_ms)
                        .map_or(-1, |event_at| {
                            let local = completed_step_at(&data.state.steps, event_at);
                            if local < 0 {
                                -1
                            } else {
                                data.step_start as i64 + local
                            }
                        })
                })
        };
        self.replay = Some(selected);
    }

    fn advance_playback(&mut self) {
        if !self.playing {
            return;
        }
        let speed = u32::from(timeline::PLAYBACK_SPEEDS[self.playback_speed_index]);
        let (steps, temporal_events, live) = self.replay_counts();
        if temporal_events > 0 {
            // Consume every event due on the timestamp clock, including ties,
            // without letting one UI frame monopolize the terminal.
            for _ in 0..256 {
                let current = self.temporal_replay.unwrap_or(-1);
                if current + 1 >= temporal_events {
                    if !live {
                        self.rejoin_live();
                    }
                    return;
                }
                let interval = match self.temporal_delay(current, speed) {
                    TemporalDelay::Ready(interval) => interval,
                    TemporalDelay::Pending(_) => return,
                    TemporalDelay::Invalid => {
                        self.playing = false;
                        return;
                    }
                };
                if self.last_play_step.elapsed() < interval {
                    return;
                }
                self.last_play_step += interval;
                self.temporal_replay = Some(current + 1);
                self.sync_step_to_temporal();
            }
            return;
        }
        let interval = PLAY_STEP_INTERVAL / speed;
        if self.last_play_step.elapsed() < interval {
            return;
        }
        self.last_play_step = Instant::now();
        match self.replay {
            Some(position) if position + 1 < steps => self.replay = Some(position + 1),
            _ => self.rejoin_live(),
        }
    }

    fn rejoin_live(&mut self) {
        self.replay = None;
        self.temporal_replay = None;
        self.playing = false;
        self.follow = true;
        self.conversation_follow = true;
    }

    fn slower_playback(&mut self) {
        self.playback_speed_index = self.playback_speed_index.saturating_sub(1);
    }

    fn faster_playback(&mut self) {
        self.playback_speed_index =
            (self.playback_speed_index + 1).min(timeline::PLAYBACK_SPEEDS.len() - 1);
    }

    fn move_to_start(&mut self) {
        self.replay = Some(-1);
        let (_, temporal_events, _) = self.replay_counts();
        self.temporal_replay = (temporal_events > 0).then_some(-1);
        self.playing = false;
        self.follow = true;
    }

    fn apply_timeline_action(&mut self, action: timeline::TimelineAction) {
        match action {
            timeline::TimelineAction::Start => self.move_to_start(),
            timeline::TimelineAction::Previous => self.step_back(),
            timeline::TimelineAction::TogglePlayback => {
                if self.replay.is_none() && self.temporal_replay.is_none() {
                    self.move_to_start();
                }
                self.playing = !self.playing;
                self.last_play_step = Instant::now();
            }
            timeline::TimelineAction::Next => self.step_forward(),
            timeline::TimelineAction::Live => self.rejoin_live(),
            timeline::TimelineAction::Slower => self.slower_playback(),
            timeline::TimelineAction::Faster => self.faster_playback(),
        }
    }

    fn step_back(&mut self) {
        let (steps, temporal_events, _) = self.replay_counts();
        if temporal_events > 0 {
            let current = self.temporal_replay.unwrap_or(temporal_events - 1);
            self.temporal_replay = Some((current - 1).max(-1));
            self.sync_step_to_temporal();
        } else {
            let current = self.replay.unwrap_or(steps - 1);
            self.replay = Some((current - 1).max(-1));
        }
        self.playing = false;
    }

    fn step_forward(&mut self) {
        let (steps, temporal_events, _) = self.replay_counts();
        if temporal_events > 0 {
            match self.temporal_replay {
                Some(position) if position + 1 >= temporal_events => self.rejoin_live(),
                Some(position) => {
                    self.temporal_replay = Some(position + 1);
                    self.sync_step_to_temporal();
                }
                None => {}
            }
        } else {
            match self.replay {
                Some(position) if position + 1 >= steps => self.rejoin_live(),
                Some(position) => self.replay = Some(position + 1),
                None => {}
            }
        }
        self.playing = false;
    }

    fn select_inspector_tab(&mut self, tab: InspectorTab) {
        self.inspector_scrolls[self.tab.index()] = self.inspector_scroll;
        self.tab = tab;
        self.inspector_scroll = self.inspector_scrolls[tab.index()];
    }

    fn page_info(&mut self, direction: i64) {
        let Some(run_id) = self.selected_run.clone() else {
            return;
        };
        let cursors = {
            let Some(data) = self.provider.data(&run_id) else {
                return;
            };
            let follow_up_len = data
                .follow_up_queue
                .and_then(|queue| queue.get("items"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let settings = next_page_cursor(
                data.settings_start,
                data.settings_total,
                data.settings_scopes.len(),
                direction,
            );
            let follow_ups = next_page_cursor(
                data.follow_up_start,
                data.follow_up_total,
                follow_up_len,
                direction,
            );
            let updates = next_page_cursor(
                data.update_start,
                data.update_total,
                data.state.updates.as_ref().map_or(0, Vec::len),
                direction,
            );
            (settings, follow_ups, updates)
        };
        if cursors.0.is_some() || cursors.1.is_some() || cursors.2.is_some() {
            self.provider
                .request_info_window(&run_id, cursors.0, cursors.1, cursors.2);
            self.inspector_scroll = 0;
        }
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
            let index = replay.unwrap_or(data.step_total as i64 - 1) - data.step_start as i64;
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

    fn request_conversation_artifacts(&mut self) {
        let Some(run_id) = self.selected_run.clone() else {
            return;
        };
        let paths = {
            let Some(data) = self.provider.data(&run_id) else {
                return;
            };
            let mut paths = Vec::new();
            for value in data.session_events.iter().chain(data.session_entries) {
                collect_artifact_paths(value, &mut paths);
            }
            if let Some(checkpoint) = data.session_replay_checkpoint.as_ref() {
                collect_artifact_paths(checkpoint, &mut paths);
            }
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
            let upper = replay.unwrap_or(data.step_total as i64 - 1) - data.step_start as i64;
            data.state
                .steps
                .iter()
                .enumerate()
                .rev()
                .find(|(index, step)| *index as i64 <= upper && step.node_id == node_id)
                .map(|(index, step)| {
                    let temporal = data
                        .session_events
                        .iter()
                        .rposition(|event| {
                            event.get("attemptId").and_then(Value::as_str)
                                == Some(step.attempt_id.as_str())
                        })
                        .map(|index| data.session_event_start as i64 + index as i64);
                    (data.step_start as i64 + index as i64, temporal)
                })
        };
        if let Some((index, temporal)) = selected {
            self.temporal_replay = temporal;
            if temporal.is_some() {
                self.sync_step_to_temporal();
            } else {
                self.replay = Some(index);
            }
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
        self.temporal_replay = None;
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

    fn resize_sidebar(&mut self, divider_column: u16) {
        self.sidebar_width = sidebar_width_for_drag(self.frame_rect, divider_column);
        self.sidebar_collapsed = false;
        self.sidebar_explicit = true;
    }

    fn resize_inspector(&mut self, divider_row: u16) {
        self.inspector_height = Some(inspector_height_for_drag(self.main_rect, divider_row));
    }

    fn persist_layout(&mut self) {
        if let Err(error) = theme::save_layout(
            &self.theme_config_path,
            self.sidebar_width,
            self.inspector_height,
        ) {
            self.theme_diagnostic = Some(sanitize_text(&format!("layout not saved: {error}")));
        }
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
        KeyCode::Char(' ') => app.apply_timeline_action(timeline::TimelineAction::TogglePlayback),
        KeyCode::Home | KeyCode::Char('g') => app.move_to_start(),
        KeyCode::End | KeyCode::Char('G') | KeyCode::Char('L') => app.rejoin_live(),
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
                        app.graph_offset = (x, y - 2);
                        app.follow = false;
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        app.graph_offset = (x, y + 2);
                        app.follow = false;
                    }
                    KeyCode::Left | KeyCode::Char('h') => {
                        app.graph_offset = (x - 4, y);
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
                        app.conversation_payload_expanded = !app.conversation_payload_expanded;
                        if app.conversation_payload_expanded {
                            app.request_conversation_artifacts();
                        }
                    }
                    InspectorTab::Info => {}
                },
                KeyCode::Char('v') if app.tab == InspectorTab::Trace => {
                    app.trace_scope = app.trace_scope.next();
                    app.trace_selected = 0;
                    app.trace_payload_expanded = false;
                    app.inspector_scroll = 0;
                }
                KeyCode::Char('<') if app.tab == InspectorTab::Info => app.page_info(-1),
                KeyCode::Char('>') if app.tab == InspectorTab::Info => app.page_info(1),
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

fn inspector_tab_label(tab: InspectorTab, available_width: u16) -> String {
    if available_width >= 48 {
        controls::button_label(tab.symbol(), tab.title())
    } else if available_width >= 39 {
        let title = if tab == InspectorTab::Conversation {
            "Chat"
        } else {
            tab.title()
        };
        controls::button_label(tab.symbol(), title)
    } else {
        format!("[{}]", tab.symbol())
    }
}

fn inspector_tab_layout(area: Rect) -> Vec<InspectorTabHit> {
    let mut hits = Vec::with_capacity(InspectorTab::ALL.len());
    let mut x = area.x;
    let right = area.right();
    for tab in InspectorTab::ALL {
        let label = inspector_tab_label(tab, area.width);
        let width = label.chars().count() as u16;
        if width == 0 || x.saturating_add(width) > right {
            break;
        }
        hits.push(InspectorTabHit {
            rect: Rect::new(x, area.y, width, area.height.min(1)),
            tab,
        });
        x = x.saturating_add(width).saturating_add(1);
    }
    hits
}

fn render_inspector_tabs(
    frame: &mut Frame,
    area: Rect,
    selected: InspectorTab,
    palette: &Palette,
) -> Vec<InspectorTabHit> {
    frame.render_widget(
        Paragraph::new("").style(Style::default().bg(palette.panel_bg)),
        area,
    );
    let hits = inspector_tab_layout(area);
    for hit in &hits {
        let label = inspector_tab_label(hit.tab, area.width);
        frame.render_widget(
            Paragraph::new(label).style(controls::button_style(palette, hit.tab == selected)),
            hit.rect,
        );
    }
    hits
}

fn sidebar_width_for_drag(frame: Rect, divider_column: u16) -> u16 {
    let requested = divider_column.saturating_sub(frame.x).saturating_add(1);
    let max_width = frame.width.saturating_sub(MIN_MAIN_WIDTH);
    requested.clamp(MIN_SIDEBAR_WIDTH, max_width.max(MIN_SIDEBAR_WIDTH))
}

fn inspector_height_for_drag(main: Rect, divider_row: u16) -> u16 {
    let requested = main.bottom().saturating_sub(divider_row);
    let max_height = main.height.saturating_sub(MIN_GRAPH_HEIGHT);
    requested.clamp(MIN_INSPECTOR_HEIGHT.min(max_height), max_height)
}

fn resolved_inspector_height(total: u16, requested: Option<u16>) -> u16 {
    let available = total.saturating_sub(MIN_GRAPH_HEIGHT);
    if available == 0 {
        return 0;
    }
    let default = total.saturating_mul(40) / 100;
    requested
        .unwrap_or(default)
        .clamp(MIN_INSPECTOR_HEIGHT.min(available), available)
}

fn clamp_camera_axis(origin: i64, content: usize, viewport: usize) -> i64 {
    if viewport == 0 {
        return 0;
    }
    let half = viewport as i64 / 2;
    origin.clamp(-half, content as i64 - half)
}

fn centered_camera(
    node: Option<&NodeBounds>,
    content: (usize, usize),
    viewport: (usize, usize),
) -> (i64, i64) {
    let (center_x, center_y) = node
        .map_or((content.0 as i64 / 2, content.1 as i64 / 2), |bounds| {
            (bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        });
    (
        center_x - viewport.0 as i64 / 2,
        center_y - viewport.1 as i64 / 2,
    )
}

fn on_sidebar_divider(app: &App, column: u16, row: u16) -> bool {
    app.show_sidebar
        && app.runs_rect.width > 0
        && column == app.runs_rect.x + app.runs_rect.width - 1
        && row >= app.runs_rect.y
        && row < app.runs_rect.y + app.runs_rect.height
}

fn on_inspector_divider(app: &App, column: u16, row: u16) -> bool {
    let on_boundary = row == app.inspector_rect.y
        || (app.graph_rect.height > 0
            && row == app.graph_rect.y + app.graph_rect.height.saturating_sub(1));
    on_boundary && column >= app.main_rect.x && column < app.main_rect.x + app.main_rect.width
}

fn handle_mouse(app: &mut App, summaries: &[RunSummary], mouse: MouseEvent) {
    if app.theme_picker.is_some() {
        handle_theme_picker_mouse(app, mouse);
        return;
    }
    if app.dragging.is_none()
        && matches!(
            mouse.kind,
            MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Drag(MouseButton::Left)
        )
        && contains(app.timeline.track, mouse.column, mouse.row)
    {
        let (steps, temporal_events, _) = app.replay_counts();
        let item_count = if temporal_events > 0 {
            temporal_events
        } else {
            steps
        } as usize;
        let column = mouse.column.saturating_sub(app.timeline.track.x) as usize;
        let position =
            timeline::position_from_column(item_count, column, app.timeline.track.width as usize);
        if position.is_none() {
            app.rejoin_live();
        } else if temporal_events > 0 {
            app.temporal_replay = position;
            app.sync_step_to_temporal();
            app.playing = false;
        } else {
            app.replay = position;
            app.playing = false;
        }
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
        if let Some(tab) = app
            .inspector_tab_hits
            .iter()
            .find(|hit| contains(hit.rect, mouse.column, mouse.row))
            .map(|hit| hit.tab)
        {
            app.focus = Focus::Inspector;
            app.select_inspector_tab(tab);
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
                app.graph_offset = (x, y + delta);
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
            if on_sidebar_divider(app, mouse.column, mouse.row) {
                app.dragging = Some(DragTarget::Sidebar);
                app.resize_sidebar(mouse.column);
            } else if on_inspector_divider(app, mouse.column, mouse.row) {
                app.dragging = Some(DragTarget::Inspector);
                app.resize_inspector(mouse.row);
            } else if contains(app.graph_rect, mouse.column, mouse.row) {
                app.focus = Focus::Graph;
                app.dragging = Some(DragTarget::Graph {
                    start_x: mouse.column,
                    start_y: mouse.row,
                    origin_x: app.graph_offset.0,
                    origin_y: app.graph_offset.1,
                });
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
        MouseEventKind::Drag(MouseButton::Left) => match app.dragging {
            Some(DragTarget::Graph {
                start_x,
                start_y,
                origin_x,
                origin_y,
            }) => {
                let dx = start_x as i64 - mouse.column as i64;
                let dy = start_y as i64 - mouse.row as i64;
                app.graph_offset = (origin_x + dx, origin_y + dy);
                app.follow = false;
            }
            Some(DragTarget::Sidebar) => app.resize_sidebar(mouse.column),
            Some(DragTarget::Inspector) => app.resize_inspector(mouse.row),
            None => {}
        },
        MouseEventKind::Up(MouseButton::Left) => match app.dragging.take() {
            Some(DragTarget::Graph {
                start_x, start_y, ..
            }) => {
                let moved = start_x.abs_diff(mouse.column) + start_y.abs_diff(mouse.row);
                if moved <= 1 && contains(app.graph_rect, mouse.column, mouse.row) {
                    let canvas_x = i64::from(
                        mouse
                            .column
                            .saturating_sub(app.graph_rect.x.saturating_add(1)),
                    ) + app.graph_offset.0;
                    let canvas_y =
                        i64::from(mouse.row.saturating_sub(app.graph_rect.y.saturating_add(1)))
                            + app.graph_offset.1;
                    let node_id = app
                        .graph_nodes
                        .iter()
                        .find(|node| {
                            canvas_x >= node.x
                                && canvas_x < node.x + node.width
                                && canvas_y >= node.y
                                && canvas_y < node.y + node.height
                        })
                        .map(|node| node.node_id.clone());
                    if let Some(node_id) = node_id {
                        app.select_graph_node(&node_id);
                    }
                }
            }
            Some(DragTarget::Sidebar | DragTarget::Inspector) => app.persist_layout(),
            None => {}
        },
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
    } else if let Some(action) =
        theme_picker::action_at(app.frame_rect, footer_height == 3, mouse.column, mouse.row)
    {
        match action {
            theme_picker::ThemeAction::Apply => app.apply_theme_picker(),
            theme_picker::ThemeAction::Cancel => app.cancel_theme_picker(),
        }
    }
}

fn status_style(status: RunStatus, palette: &Palette) -> Style {
    let color = match status {
        RunStatus::Queued => palette.muted,
        RunStatus::Running => palette.running,
        RunStatus::Waiting | RunStatus::Paused => palette.warning,
        RunStatus::Completed => palette.success,
        RunStatus::Failed => palette.error,
        RunStatus::TimedOut => palette.timed_out,
        RunStatus::Cancelled => palette.cancelled,
        RunStatus::Ambiguous => palette.error,
    };
    Style::default().fg(color)
}

fn status_glyph(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Queued => "·",
        RunStatus::Running => "◐",
        RunStatus::Waiting => "⏸",
        RunStatus::Paused => "Ⅱ",
        RunStatus::Completed => "✓",
        RunStatus::Failed => "✗",
        RunStatus::TimedOut => "×",
        RunStatus::Cancelled => "~",
        RunStatus::Ambiguous => "?",
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn draw(frame: &mut Frame, app: &mut App, summaries: &[RunSummary]) {
    let area = frame.area();
    app.frame_rect = area;
    app.inspector_tab_hits.clear();
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
        let max_sidebar = body.width.saturating_sub(MIN_MAIN_WIDTH);
        let sidebar_width = if sidebar_collapsed {
            8
        } else {
            app.sidebar_width
                .clamp(MIN_SIDEBAR_WIDTH, max_sidebar.max(MIN_SIDEBAR_WIDTH))
        };
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(sidebar_width),
                Constraint::Min(MIN_MAIN_WIDTH),
            ])
            .split(body);
        (Some(columns[0]), columns[1])
    } else {
        (None, body)
    };

    let inspector_height = resolved_inspector_height(main_area.height, app.inspector_height);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(MIN_GRAPH_HEIGHT),
            Constraint::Length(inspector_height),
        ])
        .split(main_area);
    app.main_rect = main_area;
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
            TransportOptions {
                temporal_replay: None,
                playing: app.playing,
                speed: timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
                diagnostic: app.theme_diagnostic.as_deref(),
            },
            &palette,
        );
        if let Some(picker) = &app.theme_picker {
            theme_picker::render(frame, area, picker, &palette);
        }
        return;
    };
    let replay = app.replay;
    let temporal_replay = app.temporal_replay;
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
    let Provider::Remote(remote) = &app.provider;
    let remote_status = (!remote.connected()).then(|| remote.status_label());
    let load_error = remote.error();
    let local_stale = false;

    let Some(data) = app.provider.data(&run_id) else {
        frame.render_widget(
            Paragraph::new(load_error.as_deref().unwrap_or("Loading run…"))
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
            TransportOptions {
                temporal_replay: None,
                playing: app.playing,
                speed: timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
                diagnostic: app.theme_diagnostic.as_deref(),
            },
            &palette,
        );
        if let Some(picker) = &app.theme_picker {
            theme_picker::render(frame, area, picker, &palette);
        }
        return;
    };

    let steps = &data.state.steps;
    let selected_index = replay.unwrap_or(data.step_total as i64 - 1);
    let bounded_index = (selected_index - data.step_start as i64)
        .max(-1)
        .min(steps.len() as i64 - 1);
    let at_latest = replay.is_none() && temporal_replay.is_none();
    let through_event_seq = temporal_replay.map(|position| {
        let local = position - data.session_event_start as i64;
        temporal_through_seq(data.session_events, local)
    });
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
        graph_steps: Some(data.graph_steps),
        taken_transitions: Some(data.taken_transitions),
    };
    let render_index = if at_latest {
        steps.len() as i64 - 1
    } else {
        bounded_index
    };
    let temporal_node_id = temporal_replay.and_then(|position| {
        usize::try_from(position - data.session_event_start as i64)
            .ok()
            .and_then(|index| data.session_events.get(index))
            .and_then(|event| event.get("nodeId"))
            .and_then(Value::as_str)
    });
    let followed_node_id = if at_latest {
        data.state
            .current_node
            .as_deref()
            .or(data.state.waiting_on.as_deref())
            .or_else(|| selected_step.map(|step| step.node_id.as_str()))
    } else {
        temporal_node_id.or_else(|| selected_step.map(|step| step.node_id.as_str()))
    };
    let rendered_at = now_ms();
    let graph_projection_ready = selected_index < 0 || data.graph_cursor == selected_index as u64;
    let cache_key = GraphCacheKey {
        run_id: run_id.clone(),
        graph_revision: data.graph_revision,
        replay_position: selected_index,
        graph_cursor: data.graph_cursor,
        at_latest,
        node_style,
        elapsed_second: if at_latest && data.state.current_node.is_some() {
            rendered_at / 1_000
        } else {
            0
        },
    };
    if app
        .graph_cache
        .as_ref()
        .is_none_or(|cache| cache.key != cache_key)
    {
        let rendered = graph_projection_ready
            .then(|| {
                data.graph_layout.map_or_else(
                    || render_graph(&view, render_index, at_latest, rendered_at, node_style),
                    |layout| {
                        render_graph_with_layout(
                            &view,
                            layout,
                            render_index,
                            at_latest,
                            rendered_at,
                            node_style,
                        )
                    },
                )
            })
            .flatten();
        app.graph_cache = Some(GraphCache {
            key: cache_key,
            rendered,
        });
    }
    let rendered_graph = app
        .graph_cache
        .as_ref()
        .and_then(|cache| cache.rendered.as_ref());
    app.graph_nodes = rendered_graph
        .map(|rendered| rendered.node_bounds.clone())
        .unwrap_or_default();
    let inner_width = graph_rect.width.saturating_sub(2) as usize;
    let inner_height = graph_rect.height.saturating_sub(2) as usize;
    let content_size = rendered_graph
        .map(|rendered| rendered.canvas.size())
        .unwrap_or_default();
    let mut offset = app.graph_offset;
    if follow {
        let focused = followed_node_id
            .and_then(|node_id| app.graph_nodes.iter().find(|node| node.node_id == node_id));
        offset = centered_camera(focused, content_size, (inner_width, inner_height));
    }
    offset.0 = clamp_camera_axis(offset.0, content_size.0, inner_width);
    offset.1 = clamp_camera_axis(offset.1, content_size.1, inner_height);
    app.graph_offset = offset;
    let rows_runs = rendered_graph
        .map(|rendered| {
            rendered
                .canvas
                .render_runs_window(offset.0, offset.1, inner_width, inner_height)
        })
        .unwrap_or_else(|| vec![Vec::new(); inner_height]);
    let lines: Vec<Line> = rows_runs
        .iter()
        .map(|runs| graph::viewport_line(runs, 0, inner_width, &palette))
        .collect();
    let capture = capture_integrity(&data);
    let mut graph_flags = Vec::new();
    if follow {
        graph_flags.push("FOLLOW");
    }
    if data.state.paused == Some(true) {
        graph_flags.push("PAUSED");
    }
    if capture.status == "failed" {
        graph_flags.push("CAPTURE FAILED");
    } else if capture.status == "invalid" {
        graph_flags.push("CAPTURE INVALID");
    }
    if !graph_projection_ready {
        graph_flags.push("LOADING REPLAY");
    }
    if local_stale {
        graph_flags.push("STALE DATA");
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

    // Inspector pane. Tabs get their own control row so their complete visual
    // labels are also their complete mouse targets.
    let inspector_block = Block::default()
        .borders(Borders::ALL)
        .title(" Inspector · click a tab ")
        .style(Style::default().bg(palette.panel_bg))
        .border_style(pane_border(&palette, focus == Focus::Inspector));
    let inspector_inner = inspector_block.inner(inspector_rect);
    frame.render_widget(inspector_block, inspector_rect);
    let tabs_height = inspector_inner.height.min(1);
    let separator_height = u16::from(inspector_inner.height >= 3);
    let tabs_rect = Rect::new(
        inspector_inner.x,
        inspector_inner.y,
        inspector_inner.width,
        tabs_height,
    );
    let separator_rect = Rect::new(
        inspector_inner.x,
        inspector_inner.y.saturating_add(tabs_height),
        inspector_inner.width,
        separator_height,
    );
    let content_rect = Rect::new(
        inspector_inner.x,
        separator_rect.y.saturating_add(separator_height),
        inspector_inner.width,
        inspector_inner
            .height
            .saturating_sub(tabs_height)
            .saturating_sub(separator_height),
    );
    app.inspector_tab_hits = render_inspector_tabs(frame, tabs_rect, tab, &palette);
    if separator_height > 0 {
        frame.render_widget(
            Paragraph::new("─".repeat(separator_rect.width as usize))
                .style(Style::default().fg(palette.border).bg(palette.panel_bg)),
            separator_rect,
        );
    }

    let inspector_lines = match tab {
        InspectorTab::Steps => steps_lines(
            &data,
            visible_steps,
            selected_step,
            bounded_index,
            inspector_expanded,
            content_rect.width as usize,
            &palette,
        ),
        InspectorTab::Trace => trace_lines(
            data.events,
            visible_steps,
            selected_step,
            trace_scope,
            trace_selected,
            trace_payload_expanded,
            content_rect.width as usize,
            &palette,
        ),
        InspectorTab::Conversation => conversation::conversation_lines(
            data.session_entries,
            data.session_events,
            visible_steps,
            selected_step,
            conversation::ConversationRenderOptions {
                at_latest_step: at_latest,
                through_event_seq,
                width: content_rect.width as usize,
                palette: &palette,
                run_dir: data.run_dir,
                remote_artifacts: &data.remote_artifacts,
                selected_entry: Some(conversation_selected),
                payload_expanded: conversation_payload_expanded,
                replay_checkpoint: data.session_replay_checkpoint,
            },
        ),
        InspectorTab::Info => info_lines(&data, &run_id, &palette),
    };
    let inspector_height = content_rect.height as usize;
    let max_scroll = inspector_lines.len().saturating_sub(inspector_height);
    let scroll =
        if (tab == InspectorTab::Trace && at_latest && trace_scope == TraceScope::LoadedPage)
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
    frame.render_widget(
        Paragraph::new(shown).style(Style::default().fg(palette.text).bg(palette.panel_bg)),
        content_rect,
    );

    let capture_diagnostic = matches!(capture.status, "failed" | "invalid").then(|| {
        capture
            .diagnostics
            .first()
            .cloned()
            .unwrap_or_else(|| format!("session capture {}", capture.status))
    });
    app.timeline = draw_transport(
        frame,
        transport,
        Some((&data, selected_index, at_latest)),
        TransportOptions {
            temporal_replay,
            playing,
            speed: timeline::PLAYBACK_SPEEDS[app.playback_speed_index],
            diagnostic: app
                .theme_diagnostic
                .as_deref()
                .or(capture_diagnostic.as_deref()),
        },
        &palette,
    );
    if let Some(picker) = &app.theme_picker {
        theme_picker::render(frame, area, picker, &palette);
    }
}

fn temporal_delay_from_page(
    events: &[Value],
    page_start: u64,
    current: i64,
    speed: u32,
) -> TemporalDelay {
    let Ok(next_cursor) = u64::try_from(current + 1) else {
        return TemporalDelay::Invalid;
    };
    let Some(next_index) = next_cursor.checked_sub(page_start) else {
        return TemporalDelay::Pending(next_cursor);
    };
    let Some(next_at) = events
        .get(next_index as usize)
        .and_then(|event| event.get("at"))
        .and_then(Value::as_str)
        .and_then(parse_timestamp_ms)
    else {
        return if next_index as usize >= events.len() {
            TemporalDelay::Pending(next_cursor)
        } else {
            TemporalDelay::Invalid
        };
    };
    if current < 0 {
        return TemporalDelay::Ready(Duration::ZERO);
    }
    let Ok(current_cursor) = u64::try_from(current) else {
        return TemporalDelay::Invalid;
    };
    let Some(current_index) = current_cursor.checked_sub(page_start) else {
        return TemporalDelay::Pending(current_cursor);
    };
    let Some(current_at) = events
        .get(current_index as usize)
        .and_then(|event| event.get("at"))
        .and_then(Value::as_str)
        .and_then(parse_timestamp_ms)
    else {
        return if current_index as usize >= events.len() {
            TemporalDelay::Pending(current_cursor)
        } else {
            TemporalDelay::Invalid
        };
    };
    let scaled = (next_at - current_at).max(0) as u64 / u64::from(speed.max(1));
    TemporalDelay::Ready(Duration::from_millis(scaled.max(1)))
}

fn next_page_cursor(start: u64, total: u64, length: usize, direction: i64) -> Option<u64> {
    if total == 0 || length == 0 {
        return None;
    }
    if direction > 0 && start.saturating_add(length as u64) < total {
        return Some(start.saturating_add(length as u64));
    }
    if direction < 0 && start > 0 {
        return Some(start - 1);
    }
    Some(start.saturating_add(length as u64 / 2).min(total - 1))
}

fn step_projection_contains(
    cursor: u64,
    graph_cursor: u64,
    page_start: u64,
    page_len: usize,
) -> bool {
    graph_cursor == cursor
        && cursor >= page_start
        && cursor < page_start.saturating_add(page_len as u64)
}

fn temporal_through_seq(events: &[Value], position: i64) -> u64 {
    usize::try_from(position)
        .ok()
        .and_then(|index| events.get(index))
        .and_then(|event| event.get("seq"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn completed_step_at(steps: &[StepRecord], event_at: i64) -> i64 {
    steps
        .iter()
        .enumerate()
        .rfind(|(_, step)| {
            parse_timestamp_ms(&step.finished_at).is_some_and(|finished| finished <= event_at)
        })
        .map(|(index, _)| index as i64)
        .unwrap_or(-1)
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
            format!(" Runs ({}) ↔ ", summaries.len())
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

/// Collect artifact references from the current host-owned run view.
fn collect_artifact_paths(value: &Value, paths: &mut Vec<String>) {
    if let Some(artifact) = crate::state::types::as_artifact_ref(value) {
        paths.push(artifact.path);
        return;
    }
    if let Some(escaped) = crate::state::types::as_escaped(value) {
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
    if let Some(artifact) = crate::state::types::as_artifact_ref(value) {
        return match artifacts.get(&artifact.path) {
            Some(Ok(content)) if artifact.media_type == "application/json" => {
                serde_json::from_str(content).unwrap_or_else(|error| {
                    Value::String(format!("«artifact error: invalid JSON: {error}»"))
                })
            }
            Some(Ok(content)) => Value::String(content.clone()),
            Some(Err(error)) => Value::String(format!("«artifact error: {error}»")),
            None => value.clone(),
        };
    }
    if let Some(escaped) = crate::state::types::as_escaped(value) {
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

fn resolve_detail_value(
    value: &Value,
    _run_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
) -> Value {
    resolve_remote_artifacts(value, remote_artifacts)
}

/// Compact single-line preview of a persisted value. Artifact references use
/// local checked reads or the bounded remote artifact cache.
fn preview_value(
    value: &Value,
    run_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
) -> String {
    let _ = run_dir;
    let decoded = resolve_remote_artifacts(value, remote_artifacts);
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

fn resolved_detail_value(
    value: &Value,
    _run_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
) -> Value {
    resolve_remote_artifacts(value, remote_artifacts)
}

fn push_value_lines(
    lines: &mut Vec<Line<'static>>,
    label: &str,
    value: &Value,
    run_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
    width: usize,
    palette: &Palette,
) {
    let decoded = resolved_detail_value(value, run_dir, remote_artifacts);
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

fn push_human_decision_presentation(
    lines: &mut Vec<Line<'static>>,
    value: &Value,
    run_dir: Option<&std::path::Path>,
    remote_artifacts: &HashMap<String, std::result::Result<String, String>>,
    width: usize,
    palette: &Palette,
) -> bool {
    let decoded = resolved_detail_value(value, run_dir, remote_artifacts);
    if decoded.get("schema").and_then(Value::as_str)
        != Some("pi-workflows.human-decision-request.v1")
    {
        return false;
    }
    let Some(presentation) = decoded.get("presentation") else {
        push_detail_line(
            lines,
            "decision",
            "Invalid readable presentation",
            width,
            palette,
        );
        return true;
    };
    if let Some(title) = decoded.get("title").and_then(Value::as_str) {
        push_detail_line(lines, "decision", title, width, palette);
    }
    if let Some(summary) = presentation.get("summary").and_then(Value::as_str) {
        push_detail_line(lines, "summary", summary, width, palette);
    }
    if let Some(blocks) = presentation.get("blocks").and_then(Value::as_array) {
        for block in blocks {
            match block.get("kind").and_then(Value::as_str) {
                Some("section") => {
                    if let Some(title) = block.get("title").and_then(Value::as_str) {
                        push_detail_line(lines, "section", title, width, palette);
                    }
                }
                Some("paragraph") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        push_detail_line(lines, "details", text, width, palette);
                    }
                }
                Some("preformatted") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        for (index, logical_line) in text.lines().enumerate() {
                            push_detail_line(
                                lines,
                                if index == 0 { "text" } else { "" },
                                logical_line,
                                width,
                                palette,
                            );
                        }
                    }
                }
                Some("bullets") => {
                    if let Some(items) = block.get("items").and_then(Value::as_array) {
                        for item in items.iter().filter_map(Value::as_str) {
                            push_detail_line(lines, "", &format!("• {item}"), width, palette);
                        }
                    }
                }
                Some("fields") => {
                    if let Some(items) = block.get("items").and_then(Value::as_array) {
                        for item in items {
                            if let (Some(label), Some(value)) = (
                                item.get("label").and_then(Value::as_str),
                                item.get("value").and_then(Value::as_str),
                            ) {
                                push_detail_line(lines, label, value, width, palette);
                            }
                        }
                    }
                }
                _ => push_detail_line(
                    lines,
                    "decision",
                    "Unsupported presentation block",
                    width,
                    palette,
                ),
            }
        }
    }
    if let Some(choices) = decoded.get("choices").and_then(Value::as_object) {
        for choice in choices.values() {
            if let Some(label) = choice.get("label").and_then(Value::as_str) {
                push_detail_line(lines, "choice", label, width, palette);
            }
            if let Some(prompt) = choice.pointer("/input/prompt").and_then(Value::as_str) {
                push_detail_line(lines, "input", prompt, width, palette);
            }
        }
    }
    if let Some(digest) = decoded.get("presentationDigest").and_then(Value::as_str) {
        push_detail_line(lines, "presentation", digest, width, palette);
    }
    if let Some(digest) = decoded.get("subjectDigest").and_then(Value::as_str) {
        push_detail_line(lines, "subject", digest, width, palette);
    }
    if let Some(revision) = decoded.get("revision").and_then(Value::as_u64) {
        push_detail_line(lines, "revision", &revision.to_string(), width, palette);
    }
    true
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
        if let Some(snapshot) = data.snapshot {
            for edge in &snapshot.edges {
                if let EdgeDef::Switch { from, switch } = edge {
                    if from == &step.node_id {
                        for (case, target) in &switch.cases {
                            push_detail_line(
                                &mut lines,
                                "branch",
                                &format!(
                                    "{} -> {}",
                                    sanitize_text(case),
                                    target.as_str().map(sanitize_text).unwrap_or_default()
                                ),
                                width,
                                palette,
                            );
                        }
                    }
                }
            }
        }
        if expanded {
            if !step.prompt.is_null() {
                push_value_lines(
                    &mut lines,
                    "prompt",
                    &step.prompt,
                    data.run_dir,
                    &data.remote_artifacts,
                    width,
                    palette,
                );
            }
            if !push_human_decision_presentation(
                &mut lines,
                &step.output,
                data.run_dir,
                &data.remote_artifacts,
                width,
                palette,
            ) {
                push_value_lines(
                    &mut lines,
                    "output",
                    &step.output,
                    data.run_dir,
                    &data.remote_artifacts,
                    width,
                    palette,
                );
            }
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
            if let Some(scope_id) = &step.settings_scope_id {
                push_detail_line(&mut lines, "settings scope", scope_id, width, palette);
                push_detail_line(
                    &mut lines,
                    "settings change",
                    &step.settings_change_number.unwrap_or(0).to_string(),
                    width,
                    palette,
                );
                if let Some(hash) = &step.settings_hash {
                    push_detail_line(&mut lines, "settings hash", hash, width, palette);
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
                        data.run_dir,
                        &data.remote_artifacts,
                    )),
                ]));
            }
            lines.push(Line::from(vec![
                Span::styled("output: ", Style::default().fg(palette.accent)),
                Span::raw(preview_value(
                    &step.output,
                    data.run_dir,
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
            if let Some(change) = step.settings_change_number {
                lines.push(Line::from(vec![
                    Span::styled("settings: ", Style::default().fg(palette.accent)),
                    Span::raw(change.to_string()),
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
        TraceScope::LoadedPage => events.iter().collect(),
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

fn capture_integrity(data: &RunData) -> CaptureIntegrity {
    if data.session_entry_total != data.session_entries.len() as u64
        || data.session_event_total != data.session_events.len() as u64
    {
        return CaptureIntegrity {
            status: "paged",
            diagnostics: vec!["integrity applies to the complete durable capture".into()],
        };
    }
    let entries: Result<Vec<SessionEntryRecord>, _> = data
        .session_entries
        .iter()
        .cloned()
        .map(serde_json::from_value)
        .collect();
    let events: Result<Vec<SessionEventRecord>, _> = data
        .session_events
        .iter()
        .cloned()
        .map(serde_json::from_value)
        .collect();
    let capture: Result<Option<SessionCapture>, _> = data
        .session_capture
        .cloned()
        .map(serde_json::from_value)
        .transpose();
    let (Ok(entries), Ok(events), Ok(capture)) = (entries, events, capture) else {
        return CaptureIntegrity {
            status: "invalid",
            diagnostics: vec!["invalid temporal session record".into()],
        };
    };
    assess_capture(
        data.session_bound,
        &entries,
        &events,
        capture.as_ref(),
        data.session_events_malformed,
        data.session_events_torn_tail,
        data.state.status.is_terminal(),
    )
}

fn page_range(start: u64, length: usize, total: u64) -> String {
    if total == 0 || length == 0 {
        "empty".to_string()
    } else {
        format!("showing {}-{}", start + 1, start + length as u64)
    }
}

fn info_lines(data: &RunData, run_id: &str, palette: &Palette) -> Vec<Line<'static>> {
    let state = data.state;
    let label =
        |text: &str| Span::styled(format!("{text:<14}"), Style::default().fg(palette.accent));
    // Everything below except the derived counts is run-derived text.
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
    if let Some(source) = &state.workflow_source {
        lines.push(Line::from(vec![
            label("source"),
            Span::raw(sanitize_text(&source.display())),
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
            data.trace_total, state.trace_seq
        )),
    ]));
    lines.extend(progress_info_lines(data.events, palette));
    if !data.settings_scopes.is_empty() {
        lines.push(Line::from(vec![
            label("settings"),
            Span::raw(format!(
                "{} scope(s) · {}",
                data.settings_total,
                page_range(
                    data.settings_start,
                    data.settings_scopes.len(),
                    data.settings_total
                )
            )),
        ]));
        for scope in data.settings_scopes {
            let mount = scope
                .get("mountPath")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("root");
            let invocation = scope.get("invocation").and_then(Value::as_u64).unwrap_or(0);
            let change = scope
                .get("changeNumber")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            lines.push(Line::from(vec![
                label("settings scope"),
                Span::raw(format!(
                    "{} #{} · change {}",
                    sanitize_text(mount),
                    invocation,
                    change
                )),
            ]));
        }
    }
    if let Some(queue) = data.follow_up_queue {
        let presentation = queue
            .get("presentationState")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let items = queue
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        lines.push(Line::from(vec![
            label("follow-ups"),
            Span::raw(format!(
                "{} item(s) · {} · presentation {}",
                data.follow_up_total,
                page_range(data.follow_up_start, items.len(), data.follow_up_total),
                sanitize_text(presentation)
            )),
        ]));
        for item in items {
            let order = item.get("order").and_then(Value::as_u64).unwrap_or(0);
            let state = item
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            lines.push(Line::from(vec![
                label("follow-up"),
                Span::raw(format!("{} · {}", order, sanitize_text(state))),
            ]));
        }
    }
    if let Some(updates) = &state.updates {
        lines.push(Line::from(vec![
            label("updates"),
            Span::raw(format!(
                "{} current key(s) · {}",
                data.update_total,
                page_range(data.update_start, updates.len(), data.update_total)
            )),
        ]));
    }
    if data.settings_total > data.settings_scopes.len() as u64
        || data.follow_up_total
            > data
                .follow_up_queue
                .and_then(|queue| queue.get("items"))
                .and_then(Value::as_array)
                .map_or(0, |items| items.len() as u64)
        || data.update_total
            > state
                .updates
                .as_ref()
                .map_or(0, |updates| updates.len() as u64)
    {
        lines.push(Line::from(Span::styled(
            "< previous inspector page · > next inspector page",
            Style::default().fg(palette.muted),
        )));
    }
    let capture = capture_integrity(data);
    lines.push(Line::from(vec![
        label("session"),
        Span::raw(if data.session_bound {
            format!(
                "{} entries · {} events",
                data.session_entry_total, data.session_event_total
            )
        } else {
            "not bound".to_string()
        }),
    ]));
    lines.push(Line::from(vec![
        label("capture"),
        Span::styled(
            capture.status.to_string(),
            if matches!(capture.status, "failed" | "invalid") {
                Style::default().fg(palette.error)
            } else {
                Style::default().fg(palette.subtext)
            },
        ),
    ]));
    for diagnostic in capture.diagnostics {
        lines.push(Line::from(vec![
            label("capture issue"),
            Span::styled(
                sanitize_text(&diagnostic),
                Style::default().fg(palette.warning),
            ),
        ]));
    }
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
            Span::raw(preview_value(output, data.run_dir, &data.remote_artifacts)),
        ]));
    }
    lines
}

fn progress_info_lines(events: &[Value], palette: &Palette) -> Vec<Line<'static>> {
    let mut tracks: HashMap<String, Vec<(i64, Value)>> = HashMap::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("update_published")
            || event.pointer("/payload/type").and_then(Value::as_str) != Some("progress")
        {
            continue;
        }
        let Some(key) = event.pointer("/payload/key").and_then(Value::as_str) else {
            continue;
        };
        let Some(data) = event
            .pointer("/payload/data")
            .filter(|value| value.is_object())
        else {
            continue;
        };
        let Some(at) = event
            .get("at")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_ms)
        else {
            continue;
        };
        tracks
            .entry(key.to_string())
            .or_default()
            .push((at, data.clone()));
    }
    let mut keys: Vec<String> = tracks.keys().cloned().collect();
    keys.sort_by_key(|key| (key != "overall", key.clone()));
    if keys.is_empty() {
        return Vec::new();
    }
    let label =
        |text: &str| Span::styled(format!("{text:<14}"), Style::default().fg(palette.accent));
    let mut lines = vec![Line::from("")];
    for key in keys {
        let samples = tracks.get(&key).expect("progress key exists");
        let Some((latest_at, latest)) = samples.last() else {
            continue;
        };
        let name = latest.get("label").and_then(Value::as_str).unwrap_or(&key);
        let status = latest
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let completed = latest.get("completed").and_then(Value::as_f64);
        let total = latest.get("total").and_then(Value::as_f64);
        let unit = latest.get("unit").and_then(Value::as_str).unwrap_or("");
        let count = match (completed, total) {
            (Some(done), Some(all)) => format!(
                "{} / {} {}",
                compact_number(done),
                compact_number(all),
                sanitize_text(unit)
            ),
            (Some(done), None) => format!("{} {}", compact_number(done), sanitize_text(unit)),
            _ => status.to_string(),
        };
        lines.push(Line::from(vec![
            label("progress"),
            Span::raw(format!("{} · {}", sanitize_text(name), count.trim())),
        ]));

        let mut detail = Vec::new();
        let source_at = latest
            .get("sourceUpdatedAt")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_ms)
            .unwrap_or(*latest_at);
        let source_eta = latest
            .get("sourceEstimatedFinishAt")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_ms)
            .filter(|finish| *finish > source_at && *finish > now_ms());
        let terminal = matches!(status, "completed" | "failed" | "cancelled");
        if !terminal {
            if let Some(finish) = source_eta {
                detail.push(format!("source ETA {}", format_eta_ms(finish - now_ms())));
            } else if !matches!(status, "waiting" | "blocked") {
                let rates = progress_rates(current_progress_epoch(samples));
                if let (Some(all), Some(done), Some(median)) =
                    (total, completed, median_value(&rates))
                {
                    if median > 0.0 {
                        detail.push(format!(
                            "ETA {}",
                            format_eta_ms(((all - done).max(0.0) / median) as i64)
                        ));
                        detail.push(format!("rate {}/min", compact_number(median * 60_000.0)));
                        detail.push(format!("{} confidence", progress_confidence(&rates)));
                    } else {
                        detail.push("ETA unavailable".to_string());
                    }
                } else {
                    detail.push("ETA unavailable".to_string());
                }
            }
        }
        detail.push(format!("{} samples", current_progress_epoch(samples).len()));
        detail.push(format!(
            "updated {}",
            format_eta_ms((now_ms() - *latest_at).max(0))
        ));
        lines.push(Line::from(vec![
            label("estimate"),
            Span::styled(detail.join(" · "), Style::default().fg(palette.subtext)),
        ]));
    }
    lines
}

fn current_progress_epoch(samples: &[(i64, Value)]) -> &[(i64, Value)] {
    let mut start = 0;
    for index in 1..samples.len() {
        if progress_resets(&samples[index - 1].1, &samples[index].1) {
            start = index;
        }
    }
    &samples[start..]
}

fn progress_resets(previous: &Value, current: &Value) -> bool {
    let changed_identity = previous.get("phase") != current.get("phase")
        || previous.get("unit") != current.get("unit")
        || previous.get("total") != current.get("total");
    let decreased = match (
        previous.get("completed").and_then(Value::as_f64),
        current.get("completed").and_then(Value::as_f64),
    ) {
        (Some(before), Some(after)) => after < before,
        _ => false,
    };
    let previous_status = previous
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let current_status = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    changed_identity
        || decreased
        || (matches!(previous_status, "completed" | "failed" | "cancelled")
            && !matches!(current_status, "completed" | "failed" | "cancelled"))
}

fn progress_rates(samples: &[(i64, Value)]) -> Vec<f64> {
    let start = samples.len().saturating_sub(9);
    let mut rates = Vec::new();
    for pair in samples[start..].windows(2) {
        let (previous_at, previous) = &pair[0];
        let (current_at, current) = &pair[1];
        let elapsed = current_at - previous_at;
        let before = previous.get("completed").and_then(Value::as_f64);
        let after = current.get("completed").and_then(Value::as_f64);
        if elapsed > 0 && before.is_some() && after.is_some() {
            rates.push((after.unwrap_or(0.0) - before.unwrap_or(0.0)) / elapsed as f64);
        }
    }
    rates.sort_by(f64::total_cmp);
    rates
}

fn median_value(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

fn progress_confidence(rates: &[f64]) -> &'static str {
    if rates.len() < 2 {
        return "low";
    }
    let median = median_value(rates).unwrap_or(0.0);
    if median <= 0.0 {
        return "low";
    }
    let p25 = rates[((rates.len() - 1) as f64 * 0.25).round() as usize];
    let p75 = rates[((rates.len() - 1) as f64 * 0.75).round() as usize];
    let spread = (p75 - p25) / median;
    if rates.len() >= 5 && spread <= 0.25 {
        "high"
    } else if spread <= 0.5 {
        "medium"
    } else {
        "low"
    }
}

fn compact_number(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn format_eta_ms(ms: i64) -> String {
    let seconds = ms.max(0) / 1_000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m", (seconds + 59) / 60)
    } else if seconds < 86_400 {
        format!("{:.1}h", seconds as f64 / 3_600.0)
    } else {
        format!("{:.1}d", seconds as f64 / 86_400.0)
    }
}

struct TransportOptions<'a> {
    temporal_replay: Option<i64>,
    playing: bool,
    speed: u16,
    diagnostic: Option<&'a str>,
}

fn draw_transport(
    frame: &mut Frame,
    area: Rect,
    data: Option<(&RunData, i64, bool)>,
    options: TransportOptions<'_>,
    palette: &Palette,
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
    let view = data.map(|(data, bounded_index, at_latest)| {
        let temporal = data.session_event_total > 0;
        timeline::TimelineView {
            status: data.state.status,
            paused: data.state.paused == Some(true),
            elapsed: elapsed.as_deref().unwrap_or("0ms"),
            steps: if temporal {
                data.session_event_total as usize
            } else {
                data.step_total as usize
            },
            position: if temporal {
                options
                    .temporal_replay
                    .unwrap_or(data.session_event_total as i64 - 1)
            } else {
                bounded_index
            },
            temporal,
            at_latest,
            live: data.live,
            playing: options.playing,
            speed: options.speed,
            diagnostic: options.diagnostic,
        }
    });
    timeline::render(frame, area, view, palette)
}

#[cfg(test)]
mod tests {
    use super::{
        centered_camera, clamp_camera_axis, collect_artifact_paths, completed_step_at, contains,
        current_progress_epoch, graph_position_label, inspector_height_for_drag,
        inspector_tab_label, inspector_tab_layout, next_page_cursor, page_range, progress_rates,
        push_human_decision_presentation, reconcile_selected_run, resolve_remote_artifacts,
        resolved_inspector_height, sidebar_width_for_drag, step_projection_contains,
        temporal_delay_from_page, temporal_through_seq, trace_events_for_scope,
        valid_session_binding, GraphNodeStyle, InspectorTab, NodeBounds, Palette, Rect, StepRecord,
        TemporalDelay, TraceScope, DEFAULT_NODE_STYLE,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::Duration;

    #[test]
    fn progress_estimation_resets_on_phase_change() {
        let samples = vec![
            (
                0,
                json!({ "status": "running", "phase": "one", "completed": 0, "total": 100, "unit": "rows" }),
            ),
            (
                1_000,
                json!({ "status": "running", "phase": "one", "completed": 10, "total": 100, "unit": "rows" }),
            ),
            (
                2_000,
                json!({ "status": "running", "phase": "two", "completed": 0, "total": 50, "unit": "rows" }),
            ),
            (
                3_000,
                json!({ "status": "running", "phase": "two", "completed": 5, "total": 50, "unit": "rows" }),
            ),
        ];
        let epoch = current_progress_epoch(&samples);
        assert_eq!(epoch.len(), 2);
        assert_eq!(progress_rates(epoch), vec![0.005]);
    }

    #[test]
    fn single_run_selection_stays_on_the_requested_run() {
        assert_eq!(
            reconcile_selected_run(
                Some("requested-run".to_owned()),
                Some("newer-run"),
                false,
                false,
            ),
            Some("requested-run".to_owned())
        );
        assert_eq!(
            reconcile_selected_run(
                Some("missing-run".to_owned()),
                Some("newer-run"),
                false,
                true,
            ),
            Some("newer-run".to_owned())
        );
    }

    #[test]
    fn bordered_nodes_are_the_default() {
        assert_eq!(DEFAULT_NODE_STYLE, GraphNodeStyle::Box);
    }

    #[test]
    fn inspector_tabs_are_visible_full_label_mouse_targets() {
        let area = Rect::new(10, 4, 80, 1);
        let hits = inspector_tab_layout(area);
        assert_eq!(hits.len(), InspectorTab::ALL.len());
        for hit in &hits {
            let label = inspector_tab_label(hit.tab, area.width);
            assert_eq!(hit.rect.width, label.chars().count() as u16);
            assert_eq!(
                hits.iter()
                    .find(|candidate| { contains(candidate.rect, hit.rect.x, hit.rect.y) })
                    .map(|candidate| candidate.tab),
                Some(hit.tab)
            );
        }
        for pair in hits.windows(2) {
            assert_eq!(pair[1].rect.x, pair[0].rect.right() + 1);
            assert!(!contains(
                pair[0].rect,
                pair[0].rect.right(),
                pair[0].rect.y
            ));
        }
    }

    #[test]
    fn inspector_tabs_keep_all_icon_buttons_on_narrow_panes() {
        let hits = inspector_tab_layout(Rect::new(0, 0, 20, 1));
        assert_eq!(hits.len(), InspectorTab::ALL.len());
        assert!(hits.iter().all(|hit| hit.rect.width == 3));
    }

    #[test]
    fn session_binding_requires_the_supported_schema() {
        assert!(valid_session_binding(Some(&json!({
            "schema": "pi-workflows.session-binding.v1"
        }))));
        assert!(!valid_session_binding(Some(&json!({ "schema": "future" }))));
        assert!(!valid_session_binding(Some(&json!("binding"))));
        assert!(!valid_session_binding(None));
    }

    #[test]
    fn temporal_playback_waits_for_missing_pages() {
        let tail = vec![serde_json::json!({"at": "2026-01-01T00:12:24.000Z"})];
        assert_eq!(
            temporal_delay_from_page(&tail, 744, -1, 1),
            TemporalDelay::Pending(0)
        );
        let first = vec![serde_json::json!({"at": "2026-01-01T00:00:00.000Z"})];
        assert_eq!(
            temporal_delay_from_page(&first, 0, -1, 1),
            TemporalDelay::Ready(Duration::ZERO)
        );
        let page = (0..256)
            .map(|second| {
                serde_json::json!({"at": format!("2026-01-01T00:{:02}:{:02}.000Z", second / 60, second % 60)})
            })
            .collect::<Vec<_>>();
        assert_eq!(
            temporal_delay_from_page(&page, 0, 255, 1),
            TemporalDelay::Pending(256)
        );
    }

    #[test]
    fn inspector_pages_keep_a_complete_navigation_path() {
        assert_eq!(next_page_cursor(0, 600, 256, 1), Some(256));
        assert_eq!(next_page_cursor(256, 600, 256, -1), Some(255));
        assert_eq!(next_page_cursor(344, 600, 256, 1), Some(472));
        assert_eq!(page_range(256, 256, 600), "showing 257-512");
    }

    #[test]
    fn replay_requires_graph_state_for_the_exact_cursor() {
        assert!(step_projection_contains(130, 130, 0, 256));
        assert!(!step_projection_contains(129, 130, 0, 256));
        assert!(!step_projection_contains(300, 300, 0, 256));
    }

    #[test]
    fn pre_capture_temporal_position_maps_to_sequence_zero() {
        let events = vec![serde_json::json!({ "seq": 1 })];
        assert_eq!(temporal_through_seq(&events, -1), 0);
        assert_eq!(temporal_through_seq(&events, 0), 1);
    }

    #[test]
    fn temporal_replay_hides_attempts_until_their_finish_time() {
        let steps = vec![StepRecord {
            attempt_id: "a1".into(),
            node_id: "agent".into(),
            node_type: "agent".into(),
            outcome: crate::state::types::NodeOutcome::Ok,
            started_at: "2026-01-01T00:00:01.000Z".into(),
            finished_at: "2026-01-01T00:00:05.000Z".into(),
            prompt: serde_json::Value::Null,
            output: serde_json::Value::Null,
            error: None,
            conversation: None,
            action: None,
            settings_scope_id: None,
            settings_change_number: None,
            settings_hash: None,
            assistant_message: None,
        }];
        assert_eq!(completed_step_at(&steps, 1_767_225_603_000), -1);
        assert_eq!(completed_step_at(&steps, 1_767_225_605_000), 0);
    }

    #[test]
    fn graph_title_separates_replay_position_from_run_liveness() {
        assert_eq!(graph_position_label(false, true), "(replay)");
        assert_eq!(graph_position_label(false, false), "(replay)");
        assert_eq!(graph_position_label(true, true), "(live)");
        assert_eq!(graph_position_label(true, false), "(latest)");
    }

    #[test]
    fn follow_camera_centers_the_node_even_at_canvas_edges() {
        let node = NodeBounds {
            node_id: "first".into(),
            x: 0,
            y: 0,
            width: 20,
            height: 3,
        };
        assert_eq!(centered_camera(Some(&node), (100, 30), (80, 20)), (-30, -9));
        assert_eq!(clamp_camera_axis(-30, 100, 80), -30);
        assert_eq!(clamp_camera_axis(-9, 30, 20), -9);
    }

    #[test]
    fn manual_panel_sizes_stay_responsive() {
        assert_eq!(resolved_inspector_height(40, None), 16);
        assert_eq!(resolved_inspector_height(40, Some(100)), 35);
        assert_eq!(resolved_inspector_height(8, Some(20)), 3);
        assert_eq!(sidebar_width_for_drag(Rect::new(5, 0, 120, 30), 44), 40);
        assert_eq!(sidebar_width_for_drag(Rect::new(5, 0, 40, 30), 100), 16);
        assert_eq!(inspector_height_for_drag(Rect::new(20, 2, 100, 26), 18), 10);
        assert_eq!(inspector_height_for_drag(Rect::new(20, 2, 100, 8), 2), 3);
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
    fn v2_decision_inspector_shows_presentation_without_subject() {
        let request = json!({
            "schema": "pi-workflows.human-decision-request.v1",
            "title": "Approve readable plan",
            "subject": { "hiddenMachineValue": "do-not-show" },
            "subjectDigest": format!("sha256:{}", "a".repeat(64)),
            "presentationDigest": format!("sha256:{}", "b".repeat(64)),
            "revision": 2,
            "presentation": {
                "summary": "Review the readable plan.",
                "blocks": [
                    { "kind": "section", "title": "Changes" },
                    { "kind": "bullets", "items": ["Apply the safe change."] }
                ]
            },
            "choices": {
                "continue": { "label": "Continue" },
                "replan": {
                    "label": "Replan",
                    "input": { "prompt": "What should change?" }
                }
            }
        });
        let mut lines = Vec::new();
        assert!(push_human_decision_presentation(
            &mut lines,
            &request,
            None,
            &HashMap::new(),
            100,
            &Palette::catppuccin(),
        ));
        let rendered = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("Review the readable plan."));
        assert!(rendered.contains("Apply the safe change."));
        assert!(rendered.contains("What should change?"));
        assert!(!rendered.contains("hiddenMachineValue"));
        assert!(!rendered.contains("do-not-show"));
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
