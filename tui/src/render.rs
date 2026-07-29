//! Port of `src/render/graph-render.ts`: renders the workflow DAG onto a
//! `CharCanvas`. Statuses derive from the steps visible up to the selected
//! step, taken transitions highlight, switch branches carry case labels, and
//! loop edges route through a right-hand gutter. Output is pinned to the
//! TypeScript renderer through the golden fixtures.

use crate::bundle::types::{
    DefinitionSnapshot, EdgeDef, NodeOutcome, RunState, RunStatus, StepRecord,
};
use crate::canvas::{CanvasStyle, CharCanvas};
use crate::format::{format_duration, parse_timestamp_ms, sanitize_text};
use crate::layout::{layout_graph, GraphCell, GraphEdge, GraphLayout, GraphSegment};
use std::collections::HashSet;

/// Everything the graph needs from a loaded bundle.
pub struct GraphView<'a> {
    pub state: &'a RunState,
    pub snapshot: Option<&'a DefinitionSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeStatus {
    Completed,
    Failed,
    TimedOut,
    Active,
    ReplayFocus,
    Waiting,
    Queued,
    Cancelled,
}

impl NodeStatus {
    fn glyph(self) -> char {
        match self {
            NodeStatus::Completed => '✓',
            NodeStatus::Failed => '✗',
            NodeStatus::TimedOut => '×',
            NodeStatus::Active => '◐',
            NodeStatus::ReplayFocus => '◆',
            NodeStatus::Waiting => '⏸',
            NodeStatus::Cancelled => '~',
            NodeStatus::Queued => '·',
        }
    }

    fn style(self) -> CanvasStyle {
        match self {
            NodeStatus::Completed => CanvasStyle::Ok,
            NodeStatus::Failed => CanvasStyle::Fail,
            NodeStatus::TimedOut => CanvasStyle::TimedOut,
            NodeStatus::Active => CanvasStyle::Active,
            NodeStatus::ReplayFocus => CanvasStyle::Replay,
            NodeStatus::Waiting => CanvasStyle::Warn,
            NodeStatus::Cancelled => CanvasStyle::Cancelled,
            NodeStatus::Queued => CanvasStyle::NodeDim,
        }
    }

    fn is_focused(self) -> bool {
        matches!(self, NodeStatus::Active | NodeStatus::ReplayFocus)
    }
}

const CELL_GAP: i64 = 4;
const GUTTER_GAP: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphNodeStyle {
    Line,
    Box,
}

/// Rows a node cell occupies: boxes add a border row above and below.
fn cell_height(node_style: GraphNodeStyle) -> i64 {
    match node_style {
        GraphNodeStyle::Box => 3,
        GraphNodeStyle::Line => 1,
    }
}

/// JS `String.prototype.length` (UTF-16 code units), used for width math.
fn js_len(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

fn latest_visible_attempt<'a>(steps: &'a [StepRecord], node_id: &str) -> Option<&'a StepRecord> {
    steps.iter().rev().find(|step| step.node_id == node_id)
}

fn derive_node_status(
    view: &GraphView,
    node_id: &str,
    visible_steps: &[StepRecord],
    at_latest_step: bool,
) -> NodeStatus {
    let state = view.state;
    if at_latest_step && state.current_node.as_deref() == Some(node_id) {
        return NodeStatus::Active;
    }
    if at_latest_step && state.waiting_on.as_deref() == Some(node_id) {
        return NodeStatus::Waiting;
    }
    let Some(attempt) = latest_visible_attempt(visible_steps, node_id) else {
        return NodeStatus::Queued;
    };
    // While scrubbing, the selected step is a replay cursor, not a live node.
    if !at_latest_step && visible_steps.last().map(|step| step.node_id.as_str()) == Some(node_id) {
        return NodeStatus::ReplayFocus;
    }
    match attempt.outcome {
        NodeOutcome::Ok => NodeStatus::Completed,
        NodeOutcome::TimedOut => NodeStatus::TimedOut,
        NodeOutcome::Cancelled => NodeStatus::Cancelled,
        NodeOutcome::Failed => NodeStatus::Failed,
    }
}

struct RenderedCell {
    cell: GraphCell,
    text: String,
    status: Option<NodeStatus>,
    width: i64,
}

fn render_cell_text(
    view: &GraphView,
    cell: &GraphCell,
    visible_steps: &[StepRecord],
    at_latest_step: bool,
    now_ms: i64,
    node_style: GraphNodeStyle,
) -> RenderedCell {
    let GraphCell::Node { node_id } = cell else {
        return RenderedCell {
            cell: cell.clone(),
            text: String::new(),
            status: None,
            width: 1,
        };
    };
    let state = view.state;
    let status = derive_node_status(view, node_id, visible_steps, at_latest_step);
    let node_type = view
        .snapshot
        .and_then(|snapshot| snapshot.node_type(node_id))
        .unwrap_or("?");
    let attempt = latest_visible_attempt(visible_steps, node_id);
    let attempts = visible_steps
        .iter()
        .filter(|step| step.node_id == *node_id)
        .count();
    let outgoing = view.snapshot.map_or(0, |snapshot| {
        snapshot
            .edges
            .iter()
            .filter_map(|edge| match edge {
                EdgeDef::Simple { from, .. } if from == node_id => Some(1),
                EdgeDef::Switch { from, switch } if from == node_id => Some(switch.cases.len()),
                _ => None,
            })
            .sum::<usize>()
    });
    let mut semantics = Vec::new();
    if view
        .snapshot
        .is_some_and(|snapshot| snapshot.start_at == *node_id)
    {
        semantics.push("▶".to_string());
    }
    if outgoing > 1 {
        semantics.push(format!("◇{outgoing}"));
    }
    if outgoing == 0 {
        semantics.push("■".to_string());
    }
    // Node ids and types come from the bundle's workflow definition; scrub
    // them like statusDetail so untrusted bundles can't emit escapes.
    semantics.push(sanitize_text(&format!("{node_id} [{node_type}]")));
    let mut parts = vec![semantics.join(" ")];
    if at_latest_step && state.current_node.as_deref() == Some(node_id.as_str()) {
        let started_at = state
            .current_node_started_at
            .as_deref()
            .and_then(parse_timestamp_ms)
            .unwrap_or(now_ms);
        parts.push(format!("running {}", format_duration(now_ms - started_at)));
        if let Some(detail) = state.status_detail.as_deref().filter(|d| !d.is_empty()) {
            // statusDetail can be set by workflow authors; keep terminal-safe.
            parts.push(format!("· {}", sanitize_text(detail)));
        }
    } else if let Some(attempt) = attempt {
        let duration_ms = parse_timestamp_ms(&attempt.finished_at).unwrap_or(0)
            - parse_timestamp_ms(&attempt.started_at).unwrap_or(0);
        parts.push(format_duration(duration_ms));
    }
    if attempts > 1 {
        parts.push(format!("×{attempts}"));
    }
    let text = parts.join(" ");
    // Width includes the status glyph and the space after it; boxes add a
    // border and one padding column on each side.
    let content_width = js_len(&text) + 2;
    RenderedCell {
        cell: cell.clone(),
        text,
        status: Some(status),
        width: match node_style {
            GraphNodeStyle::Box => content_width + 4,
            GraphNodeStyle::Line => content_width,
        },
    }
}

struct RankGeometry {
    cells: Vec<RenderedCell>,
    centers: Vec<i64>,
}

struct PlacedRank {
    cells: Vec<RenderedCell>,
    centers: Vec<i64>,
    y: i64,
}

/// A strip segment with final pixel geometry and its assigned track row.
struct GeomSegment {
    edge_id: String,
    label: Option<String>,
    from_x: i64,
    to_x: i64,
    track: i64,
    target_is_node: bool,
}

struct StripGeometry {
    segments: Vec<GeomSegment>,
    track_count: i64,
    has_labels: bool,
    /// True when every segment is an unlabeled vertical line.
    straight: bool,
}

/// Transitions actually taken between the visible steps, as "from->to".
fn taken_transitions(visible_steps: &[StepRecord]) -> HashSet<String> {
    visible_steps
        .windows(2)
        .map(|pair| format!("{}->{}", pair[0].node_id, pair[1].node_id))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeBounds {
    pub node_id: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

pub struct RenderedGraph {
    pub canvas: CharCanvas,
    pub node_bounds: Vec<NodeBounds>,
}

/// Render the graph pane and retain node bounds for camera targeting and hit
/// testing. `selected_step_index` scrubs the replay position;
/// `at_latest_step` says whether the caller is showing the live view.
pub fn render_graph(
    view: &GraphView,
    selected_step_index: i64,
    at_latest_step: bool,
    now_ms: i64,
    node_style: GraphNodeStyle,
) -> Option<RenderedGraph> {
    let snapshot = view.snapshot?;
    let layout = layout_graph(snapshot);
    let steps = &view.state.steps;
    let bounded_index = selected_step_index.max(-1).min(steps.len() as i64 - 1);
    let visible_steps = &steps[0..(bounded_index + 1) as usize];
    let transitions = taken_transitions(visible_steps);
    let active_pair = derive_pair_in_flight(view, visible_steps, at_latest_step);

    let rendered: Vec<Vec<RenderedCell>> = layout
        .ranks
        .iter()
        .map(|rank| {
            rank.iter()
                .map(|cell| {
                    render_cell_text(
                        view,
                        cell,
                        visible_steps,
                        at_latest_step,
                        now_ms,
                        node_style,
                    )
                })
                .collect()
        })
        .collect();

    // Column positions: pack cells left to right per rank, then center every
    // rank against the widest one so vertical edges stay near-vertical.
    let rank_widths: Vec<i64> = rendered
        .iter()
        .map(|cells| {
            cells.iter().map(|cell| cell.width).sum::<i64>()
                + 0.max(cells.len() as i64 - 1) * CELL_GAP
        })
        .collect();
    let graph_width = rank_widths.iter().copied().max().unwrap_or(0).max(0);
    let geometry: Vec<RankGeometry> = rendered
        .into_iter()
        .enumerate()
        .map(|(rank_index, cells)| {
            let mut centers = Vec::with_capacity(cells.len());
            let mut x = (graph_width - rank_widths[rank_index]) / 2;
            for cell in &cells {
                // Single-cell ranks share the exact graph center so chains
                // render as straight vertical lines instead of elbows.
                centers.push(if cells.len() == 1 {
                    graph_width / 2
                } else {
                    x + cell.width / 2
                });
                x += cell.width + CELL_GAP;
            }
            RankGeometry { cells, centers }
        })
        .collect();

    // Horizontal edge geometry (exit/entry columns, pixel-space track rows)
    // is fully decided before vertical placement, so row budgeting is exact.
    let strips: Vec<StripGeometry> = (0..geometry.len())
        .map(|rank_index| compute_strip_geometry(&layout, rank_index, &geometry))
        .collect();

    let lanes = BackEdgeLanes::new(&layout);
    let mut placed: Vec<PlacedRank> = Vec::new();
    // Entry lanes above the first rank need an arrow row of their own.
    let top_lanes = lanes.above(0).len() as i64;
    let mut y = if top_lanes > 0 { top_lanes + 1 } else { 0 };
    let rank_count = geometry.len();
    for (rank_index, rank) in geometry.into_iter().enumerate() {
        placed.push(PlacedRank {
            cells: rank.cells,
            centers: rank.centers,
            y,
        });
        y += cell_height(node_style)
            + lanes.below(rank_index).len() as i64
            + gap_rows(&strips[rank_index], rank_index, rank_count)
            + lanes.above(rank_index + 1).len() as i64;
    }

    let node_bounds = placed
        .iter()
        .flat_map(|rank| {
            rank.cells
                .iter()
                .zip(&rank.centers)
                .filter_map(|(cell, center)| match &cell.cell {
                    GraphCell::Node { node_id } => Some(NodeBounds {
                        node_id: node_id.clone(),
                        x: center - cell.width / 2,
                        y: rank.y,
                        width: cell.width,
                        height: cell_height(node_style),
                    }),
                    GraphCell::Virtual { .. } => None,
                })
        })
        .collect();

    let mut canvas = CharCanvas::new();
    draw_nodes(&mut canvas, &placed, &layout, &transitions, node_style);
    let labels = draw_segments(
        &mut canvas,
        &placed,
        &strips,
        &layout,
        &transitions,
        active_pair.as_deref(),
        graph_width,
        node_style,
        &lanes,
    );
    draw_back_edges(
        &mut canvas,
        &placed,
        &layout,
        &transitions,
        graph_width,
        node_style,
        &lanes,
    );
    // Labels go on last, once every line is on the canvas: placement can then
    // guarantee no later stroke crosses through a label.
    for label in labels {
        draw_segment_label(&mut canvas, &label);
    }
    Some(RenderedGraph {
        canvas,
        node_bounds,
    })
}

/// Render only the graph canvas for callers that do not need hit regions.
pub fn render_graph_canvas(
    view: &GraphView,
    selected_step_index: i64,
    at_latest_step: bool,
    now_ms: i64,
    node_style: GraphNodeStyle,
) -> Option<CharCanvas> {
    render_graph(
        view,
        selected_step_index,
        at_latest_step,
        now_ms,
        node_style,
    )
    .map(|rendered| rendered.canvas)
}

/// Render the graph to plain text lines (parity with the TS renderer with
/// colors disabled). The TS reference infers "at latest" from the index, so
/// this entry point does the same.
pub fn render_graph_lines(
    view: &GraphView,
    selected_step_index: i64,
    now_ms: i64,
    node_style: GraphNodeStyle,
) -> Vec<String> {
    let at_latest_step = selected_step_index >= view.state.steps.len() as i64 - 1;
    match render_graph_canvas(
        view,
        selected_step_index,
        at_latest_step,
        now_ms,
        node_style,
    ) {
        Some(canvas) => canvas.render_plain(),
        None => Vec::new(),
    }
}

/// Back edges route through dedicated lane rows: one below their source rank
/// and one above their target rank.
struct BackEdgeLanes {
    edges: Vec<GraphEdge>,
    rank_of_node: std::collections::HashMap<String, usize>,
}

impl BackEdgeLanes {
    fn new(layout: &GraphLayout) -> Self {
        Self {
            edges: layout
                .edges
                .iter()
                .filter(|edge| edge.is_back_edge)
                .cloned()
                .collect(),
            rank_of_node: layout.rank_of_node.clone(),
        }
    }

    fn below(&self, rank: usize) -> Vec<&GraphEdge> {
        self.edges
            .iter()
            .filter(|edge| self.rank_of_node.get(&edge.from) == Some(&rank))
            .collect()
    }

    fn above(&self, rank: usize) -> Vec<&GraphEdge> {
        self.edges
            .iter()
            .filter(|edge| self.rank_of_node.get(&edge.to) == Some(&rank))
            .collect()
    }
}

/// The transition currently in flight, drawn in the active style.
fn derive_pair_in_flight(
    view: &GraphView,
    visible_steps: &[StepRecord],
    at_latest_step: bool,
) -> Option<String> {
    let state = view.state;
    if at_latest_step {
        if state.status == RunStatus::Running {
            if let (Some(current), Some(last)) = (
                state.current_node.as_deref().filter(|id| !id.is_empty()),
                visible_steps.last(),
            ) {
                return Some(format!("{}->{current}", last.node_id));
            }
        }
        return None;
    }
    if visible_steps.len() >= 2 {
        let previous = &visible_steps[visible_steps.len() - 2];
        let last = &visible_steps[visible_steps.len() - 1];
        return Some(format!("{}->{}", previous.node_id, last.node_id));
    }
    None
}

/// Rows between rank r's cell rows and rank r+1's cell rows.
fn gap_rows(strip: &StripGeometry, rank: usize, rank_count: usize) -> i64 {
    if strip.segments.is_empty() {
        return if rank < rank_count - 1 { 1 } else { 0 };
    }
    // Straight unlabeled strips need no track rows: one line row, one arrow row.
    if strip.straight {
        return 2;
    }
    // Labelled strips reserve one extra row below the tracks so labels that
    // do not fit on their horizontal run always have a collision-free home.
    2 + strip.track_count + if strip.has_labels { 1 } else { 0 }
}

/// Resolve a strip (all segments between rank r and rank r+1) to final pixel
/// geometry: exit and entry columns, and a horizontal track row per segment.
fn compute_strip_geometry(
    layout: &GraphLayout,
    rank: usize,
    geometry: &[RankGeometry],
) -> StripGeometry {
    let strip: Vec<&GraphSegment> = layout
        .segments
        .iter()
        .filter(|segment| segment.rank == rank)
        .collect();
    let (Some(top), Some(bottom)) = (geometry.get(rank), geometry.get(rank + 1)) else {
        return StripGeometry {
            segments: Vec::new(),
            track_count: 1,
            has_labels: false,
            straight: true,
        };
    };
    if strip.is_empty() {
        return StripGeometry {
            segments: Vec::new(),
            track_count: 1,
            has_labels: false,
            straight: true,
        };
    }
    let exit_offsets = fan_offsets(&strip, FanSide::From, top, bottom);
    let entry_offsets = fan_offsets(&strip, FanSide::To, top, bottom);
    struct Resolved {
        edge_id: String,
        label: Option<String>,
        from_x: i64,
        to_x: i64,
        target_is_node: bool,
    }
    let mut resolved: Vec<Resolved> = strip
        .iter()
        .map(|segment| {
            let from_x = top.centers[segment.from_cell]
                + exit_offsets.get(&segment.edge_id).copied().unwrap_or(0);
            let mut to_x = bottom.centers[segment.to_cell]
                + entry_offsets.get(&segment.edge_id).copied().unwrap_or(0);
            let target_is_node = bottom.cells[segment.to_cell].cell.is_node();
            // A one-column jog reads as noise; draw it straight into the
            // target, whose rendered cell is wide enough to absorb the
            // offset. Virtual cells are exactly one column wide, so they
            // must never be snapped.
            if target_is_node && (to_x - from_x).abs() <= 1 {
                to_x = from_x;
            }
            Resolved {
                edge_id: segment.edge_id.clone(),
                label: segment.label.clone(),
                from_x,
                to_x,
                target_is_node,
            }
        })
        .collect();

    // First-fit track assignment over pixel spans; straight unlabeled
    // segments draw a plain vertical line and need no track row.
    resolved.sort_by_key(|segment| segment.from_x);
    let mut segments: Vec<GeomSegment> = Vec::new();
    let mut track_ranges: Vec<Vec<(i64, i64)>> = Vec::new();
    for segment in resolved {
        let mut track = 0i64;
        if segment.from_x != segment.to_x || segment.label.is_some() {
            let span = (
                segment.from_x.min(segment.to_x),
                segment.from_x.max(segment.to_x),
            );
            let found = track_ranges.iter().position(|ranges| {
                ranges
                    .iter()
                    .all(|&(start, end)| span.1 < start || span.0 > end)
            });
            track = match found {
                Some(index) => index as i64,
                None => {
                    track_ranges.push(Vec::new());
                    track_ranges.len() as i64 - 1
                }
            };
            track_ranges[track as usize].push(span);
        }
        segments.push(GeomSegment {
            edge_id: segment.edge_id,
            label: segment.label,
            from_x: segment.from_x,
            to_x: segment.to_x,
            track,
            target_is_node: segment.target_is_node,
        });
    }
    StripGeometry {
        track_count: (track_ranges.len() as i64).max(1),
        has_labels: segments.iter().any(|segment| segment.label.is_some()),
        straight: segments
            .iter()
            .all(|segment| segment.from_x == segment.to_x && segment.label.is_none()),
        segments,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum FanSide {
    From,
    To,
}

/// Fan columns for edges sharing a cell: segment i (ordered by the far
/// end's x) gets column center - 2*(n-1-i), clamped to the cell, never
/// right of center.
fn fan_offsets(
    strip: &[&GraphSegment],
    side: FanSide,
    top: &RankGeometry,
    bottom: &RankGeometry,
) -> std::collections::HashMap<String, i64> {
    let (own_rank, far_rank) = match side {
        FanSide::From => (top, bottom),
        FanSide::To => (bottom, top),
    };
    let own_cell = |segment: &GraphSegment| match side {
        FanSide::From => segment.from_cell,
        FanSide::To => segment.to_cell,
    };
    let far_cell = |segment: &GraphSegment| match side {
        FanSide::From => segment.to_cell,
        FanSide::To => segment.from_cell,
    };
    let mut offsets = std::collections::HashMap::new();
    // Preserve insertion order of groups for determinism.
    let mut group_order: Vec<usize> = Vec::new();
    let mut groups: std::collections::HashMap<usize, Vec<&GraphSegment>> =
        std::collections::HashMap::new();
    for segment in strip {
        // Virtual cells are one column wide and always have one edge per side.
        if own_rank.cells[own_cell(segment)].cell.is_node() {
            let key = own_cell(segment);
            if !groups.contains_key(&key) {
                group_order.push(key);
            }
            groups.entry(key).or_default().push(segment);
        }
    }
    for cell_index in group_order {
        let group = &groups[&cell_index];
        if group.len() < 2 {
            continue;
        }
        let cell = &own_rank.cells[cell_index];
        let max_offset = 1.max(cell.width / 2 - 1);
        let mut ordered: Vec<&&GraphSegment> = group.iter().collect();
        ordered.sort_by_key(|segment| far_rank.centers[far_cell(segment)]);
        let count = ordered.len() as i64;
        for (index, segment) in ordered.into_iter().enumerate() {
            let offset = -2 * (count - 1 - index as i64);
            offsets.insert(segment.edge_id.clone(), offset.max(-max_offset));
        }
    }
    offsets
}

struct BoxChars {
    tl: char,
    tr: char,
    bl: char,
    br: char,
    h: char,
    v: char,
}

const BOX_LIGHT: BoxChars = BoxChars {
    tl: '┌',
    tr: '┐',
    bl: '└',
    br: '┘',
    h: '─',
    v: '│',
};

const BOX_HEAVY: BoxChars = BoxChars {
    tl: '┏',
    tr: '┓',
    bl: '┗',
    br: '┛',
    h: '━',
    v: '┃',
};

fn draw_nodes(
    canvas: &mut CharCanvas,
    placed: &[PlacedRank],
    layout: &GraphLayout,
    transitions: &HashSet<String>,
    node_style: GraphNodeStyle,
) {
    for rank in placed {
        for (index, rendered) in rank.cells.iter().enumerate() {
            let center = rank.centers[index];
            match &rendered.cell {
                GraphCell::Virtual { edge_id } => {
                    let edge = layout
                        .edges
                        .iter()
                        .find(|candidate| candidate.edge_id == *edge_id);
                    let taken = edge.is_some_and(|edge| {
                        transitions.contains(&format!("{}->{}", edge.from, edge.to))
                    });
                    // Pass-through cells span the full cell height so the
                    // edge stays visually continuous across the rank row(s).
                    canvas.vline(
                        center,
                        rank.y,
                        rank.y + cell_height(node_style) - 1,
                        if taken {
                            CanvasStyle::Taken
                        } else {
                            CanvasStyle::Dim
                        },
                    );
                }
                GraphCell::Node { .. } => {
                    let status = rendered.status.unwrap_or(NodeStatus::Queued);
                    let start_x = center - rendered.width / 2;
                    if node_style == GraphNodeStyle::Box {
                        draw_node_box(canvas, start_x, rank.y, rendered, status);
                    } else {
                        canvas.put(start_x, rank.y, status.glyph(), status.style());
                        canvas.text(
                            start_x + 2,
                            rank.y,
                            &rendered.text,
                            if status == NodeStatus::Queued {
                                CanvasStyle::Dim
                            } else {
                                CanvasStyle::Plain
                            },
                        );
                    }
                }
            }
        }
    }
}

/// A bordered node cell; the active node gets a heavy border.
fn draw_node_box(
    canvas: &mut CharCanvas,
    start_x: i64,
    y: i64,
    rendered: &RenderedCell,
    status: NodeStatus,
) {
    let chars = if status.is_focused() {
        &BOX_HEAVY
    } else {
        &BOX_LIGHT
    };
    let style = status.style();
    let content_style = if status.is_focused() {
        CanvasStyle::NodeFocusText
    } else if status == NodeStatus::Queued {
        CanvasStyle::NodeDim
    } else {
        CanvasStyle::NodeText
    };
    canvas.fill_rect(start_x, y, rendered.width, 3, content_style);
    let inner_width = (rendered.width - 2) as usize;
    let horizontal: String = std::iter::repeat_n(chars.h, inner_width).collect();
    canvas.text(
        start_x,
        y,
        &format!("{}{horizontal}{}", chars.tl, chars.tr),
        style,
    );
    canvas.text(start_x, y + 1, &chars.v.to_string(), style);
    canvas.put(start_x + 2, y + 1, status.glyph(), style);
    canvas.text(start_x + 4, y + 1, &rendered.text, content_style);
    canvas.text(
        start_x + rendered.width - 1,
        y + 1,
        &chars.v.to_string(),
        style,
    );
    canvas.text(
        start_x,
        y + 2,
        &format!("{}{horizontal}{}", chars.bl, chars.br),
        style,
    );
}

fn edge_style(
    pair_key: &str,
    transitions: &HashSet<String>,
    active_pair: Option<&str>,
) -> CanvasStyle {
    if active_pair == Some(pair_key) {
        return CanvasStyle::ActiveEdge;
    }
    if transitions.contains(pair_key) {
        return CanvasStyle::Taken;
    }
    CanvasStyle::Dim
}

struct PendingLabel {
    text: String,
    style: CanvasStyle,
    from_x: i64,
    to_x: i64,
    track_y: i64,
    label_row: i64,
    graph_width: i64,
}

#[allow(clippy::too_many_arguments)]
fn draw_segments(
    canvas: &mut CharCanvas,
    placed: &[PlacedRank],
    strips: &[StripGeometry],
    layout: &GraphLayout,
    transitions: &HashSet<String>,
    active_pair: Option<&str>,
    graph_width: i64,
    node_style: GraphNodeStyle,
    lanes: &BackEdgeLanes,
) -> Vec<PendingLabel> {
    let mut labels = Vec::new();
    for rank in 0..placed.len().saturating_sub(1) {
        let strip = &strips[rank];
        if strip.segments.is_empty() {
            continue;
        }
        let top = &placed[rank];
        let bottom = &placed[rank + 1];
        // Forward lines start right below the source cell, cross any
        // back-edge lane rows (as ┼ crossings), run their strip tracks, then
        // cross the entry lanes to the arrow row directly above the target.
        let stub_top = top.y + cell_height(node_style);
        let strip_top = stub_top + lanes.below(rank).len() as i64;
        let arrow_y = bottom.y - 1;
        let strip_bottom = arrow_y - 1 - lanes.above(rank + 1).len() as i64;
        for segment in &strip.segments {
            let Some(edge) = layout
                .edges
                .iter()
                .find(|candidate| candidate.edge_id == segment.edge_id)
            else {
                continue;
            };
            let style = edge_style(
                &format!("{}->{}", edge.from, edge.to),
                transitions,
                active_pair,
            );
            let (from_x, to_x) = (segment.from_x, segment.to_x);
            let track_y = strip_top + segment.track;
            if from_x == to_x {
                canvas.vline(from_x, stub_top, arrow_y, style);
            } else {
                if track_y > stub_top {
                    canvas.vline(from_x, stub_top, track_y - 1, style);
                }
                canvas.put(
                    from_x,
                    track_y,
                    if to_x > from_x { '└' } else { '┘' },
                    style,
                );
                canvas.hline(track_y, from_x.min(to_x) + 1, from_x.max(to_x) - 1, style);
                canvas.put(to_x, track_y, if to_x > from_x { '┐' } else { '┌' }, style);
                if arrow_y > track_y {
                    canvas.vline(to_x, track_y + 1, arrow_y, style);
                }
            }
            if segment.target_is_node {
                canvas.put(to_x, arrow_y, '▼', style);
            }
            if let Some(label) = &segment.label {
                labels.push(PendingLabel {
                    text: label.clone(),
                    style,
                    from_x,
                    to_x,
                    track_y,
                    label_row: (strip_top + strip.track_count).min(strip_bottom),
                    graph_width,
                });
            }
        }
    }
    labels
}

/// Place a branch label: first over the segment's own horizontal run, then
/// the strip's reserved label row beside the descending line (side facing
/// the graph center first), then beside the source corner.
fn draw_segment_label(canvas: &mut CharCanvas, label: &PendingLabel) {
    let padded = format!(" {} ", label.text);
    let padded_len = js_len(&padded);
    let text_len = js_len(&label.text);
    if label.from_x != label.to_x {
        let run_start = label.from_x.min(label.to_x) + 1;
        let run_end = label.from_x.max(label.to_x) - 1;
        let center = (run_start + run_end) / 2 - padded_len / 2;
        if run_end - run_start + 1 >= padded_len + 2
            && canvas.text_over_run(center, label.track_y, &padded, label.style)
        {
            return;
        }
    }
    let left = (label.to_x - text_len - 1, label.label_row);
    let right = (label.to_x + 2, label.label_row);
    let candidates = if label.to_x >= label.graph_width / 2 {
        [left, right]
    } else {
        [right, left]
    };
    for (x, y) in candidates {
        if canvas.text_if_empty(x, y, &label.text, label.style) {
            return;
        }
    }
    // Last resort: beside the source corner on the track row.
    canvas.text_if_empty(label.from_x + 2, label.track_y, &label.text, label.style);
}

/// Each back edge leaves its source cell downward into its own lane row,
/// runs right to a private gutter column, climbs the gutter, and re-enters
/// through its target's entry lane and arrow row from above.
fn draw_back_edges(
    canvas: &mut CharCanvas,
    placed: &[PlacedRank],
    layout: &GraphLayout,
    transitions: &HashSet<String>,
    graph_width: i64,
    node_style: GraphNodeStyle,
    lanes: &BackEdgeLanes,
) {
    let mut gutter_x = graph_width + GUTTER_GAP;
    for edge in &lanes.edges {
        let (Some(&from_rank), Some(&to_rank)) = (
            layout.rank_of_node.get(&edge.from),
            layout.rank_of_node.get(&edge.to),
        ) else {
            continue;
        };
        let from = &placed[from_rank];
        let to = &placed[to_rank];
        let below = lanes.below(from_rank);
        let above = lanes.above(to_rank);
        let (Some(exit), Some(entry)) = (
            cell_anchor(from, &edge.from, &below, edge),
            cell_anchor(to, &edge.to, &above, edge),
        ) else {
            continue;
        };
        let style = if transitions.contains(&format!("{}->{}", edge.from, edge.to)) {
            CanvasStyle::Taken
        } else {
            CanvasStyle::Back
        };
        let exit_lane_y = from.y + cell_height(node_style) + exit.lane;
        let above_count = above.len() as i64;
        let arrow_y = to.y - 1;
        let entry_lane_y = arrow_y - above_count + entry.lane;

        // Downward stub out of the source cell, then right along the exit lane.
        if exit_lane_y > from.y + cell_height(node_style) {
            canvas.vline(
                exit.x,
                from.y + cell_height(node_style),
                exit_lane_y - 1,
                style,
            );
        }
        canvas.put(exit.x, exit_lane_y, '└', style);
        canvas.hline(exit_lane_y, exit.x + 1, gutter_x - 1, style);
        canvas.put(gutter_x, exit_lane_y, '┘', style);
        // Up the gutter, then left along the entry lane into the target.
        canvas.put(gutter_x, entry_lane_y, '┐', style);
        if exit_lane_y - entry_lane_y > 1 {
            canvas.vline(gutter_x, entry_lane_y + 1, exit_lane_y - 1, style);
        }
        canvas.hline(entry_lane_y, entry.x + 1, gutter_x - 1, style);
        canvas.put(entry.x, entry_lane_y, '┌', style);
        if arrow_y - entry_lane_y > 1 {
            canvas.vline(entry.x, entry_lane_y + 1, arrow_y - 1, style);
        }
        canvas.put(entry.x, arrow_y, '▼', style);
        if let Some(label) = &edge.label {
            canvas.text(gutter_x + 2, entry_lane_y, label, style);
        }
        // Reserve horizontal room for this gutter and its label before the next.
        gutter_x += 2 + edge.label.as_deref().map_or(0, |label| js_len(label) + 1);
    }
}

struct Anchor {
    x: i64,
    lane: i64,
}

/// Where a back edge touches a node cell: offset right of center so the
/// stub can never collide with forward-edge lines at the center column,
/// clamped inside the cell.
fn cell_anchor(
    rank: &PlacedRank,
    node_id: &str,
    lane_edges: &[&GraphEdge],
    edge: &GraphEdge,
) -> Option<Anchor> {
    let index = rank
        .cells
        .iter()
        .position(|cell| matches!(&cell.cell, GraphCell::Node { node_id: id } if id == node_id))?;
    let lane = lane_edges
        .iter()
        .position(|candidate| candidate.edge_id == edge.edge_id)? as i64;
    let cell = &rank.cells[index];
    let center = rank.centers[index];
    let rightmost = center + cell.width / 2 - 1;
    Some(Anchor {
        x: (center + 2 + lane * 2).min(rightmost),
        lane,
    })
}
