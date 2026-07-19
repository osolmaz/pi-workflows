import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowStepRecord,
} from "../workflows/types.js";
import { ansi, sanitizeText } from "./ansi.js";
import { CharCanvas, type CanvasStyle } from "./canvas.js";
import { formatDuration } from "./format.js";
import {
  layoutGraph,
  type GraphCell,
  type GraphEdge,
  type GraphLayout,
  type GraphSegment,
} from "./graph.js";

/**
 * Renders the workflow DAG as text, mirroring the acpx replay viewer's graph
 * pane: statuses derive from the steps visible up to the selected step, taken
 * transitions highlight, switch branches carry case labels, and loop edges
 * route through a right-hand gutter.
 */

/** Everything the graph needs; a LoadedRunBundle satisfies this shape. */
export type GraphView = {
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot | null;
};

type NodeStatus = "completed" | "failed" | "active" | "waiting" | "queued" | "cancelled";

const STATUS_GLYPHS: Record<NodeStatus, string> = {
  completed: "✓",
  failed: "✗",
  active: "◐",
  waiting: "⏸",
  cancelled: "~",
  queued: "·",
};

const STATUS_STYLES: Record<NodeStatus, CanvasStyle> = {
  completed: "ok",
  failed: "fail",
  active: "active",
  waiting: "warn",
  cancelled: "warn",
  queued: "dim",
};

const CELL_GAP = 4;
const GUTTER_GAP = 2;

/** How node cells are drawn: single text lines or bordered boxes. */
export type GraphNodeStyle = "line" | "box";

export type GraphRenderOptions = {
  nodeStyle?: GraphNodeStyle;
};

/** Rows a node cell occupies: boxes add a border row above and below. */
function cellHeight(nodeStyle: GraphNodeStyle): number {
  return nodeStyle === "box" ? 3 : 1;
}

function paint(text: string, style: CanvasStyle): string {
  switch (style) {
    case "taken":
    case "ok":
      return ansi.green(text);
    case "active":
      return ansi.cyan(text);
    case "back":
    case "warn":
      return ansi.yellow(text);
    case "fail":
      return ansi.red(text);
    case "dim":
      return ansi.dim(text);
    default:
      return text;
  }
}

function latestVisibleAttempt(
  steps: WorkflowStepRecord[],
  nodeId: string,
): WorkflowStepRecord | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.nodeId === nodeId) {
      return steps[index];
    }
  }
  return undefined;
}

function deriveNodeStatus(
  view: GraphView,
  nodeId: string,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
): NodeStatus {
  const state = view.state;
  if (atLatestStep && state.currentNode === nodeId) {
    return "active";
  }
  if (atLatestStep && state.waitingOn === nodeId) {
    return "waiting";
  }
  const attempt = latestVisibleAttempt(visibleSteps, nodeId);
  if (!attempt) {
    return "queued";
  }
  // While scrubbing, the selected step's node reads as the active position.
  if (!atLatestStep && visibleSteps.at(-1)?.nodeId === nodeId) {
    return "active";
  }
  switch (attempt.outcome) {
    case "ok":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

type RenderedCell = {
  cell: GraphCell;
  text: string;
  status: NodeStatus | null;
  width: number;
};

function renderCellText(
  view: GraphView,
  cell: GraphCell,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
  now: Date,
  nodeStyle: GraphNodeStyle,
): RenderedCell {
  if (cell.kind === "virtual") {
    return { cell, text: "", status: null, width: 1 };
  }
  const state = view.state;
  const nodeId = cell.nodeId;
  const status = deriveNodeStatus(view, nodeId, visibleSteps, atLatestStep);
  const nodeType = view.snapshot?.nodes[nodeId]?.nodeType ?? "?";
  const attempt = latestVisibleAttempt(visibleSteps, nodeId);
  const attempts = visibleSteps.filter((step) => step.nodeId === nodeId).length;
  const parts = [`${nodeId} [${nodeType}]`];
  if (atLatestStep && state.currentNode === nodeId) {
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    parts.push(`running ${formatDuration(now.getTime() - startedAt)}`);
    if (state.statusDetail) {
      // statusDetail can be set by workflow authors; keep terminal-safe.
      parts.push(`· ${sanitizeText(state.statusDetail)}`);
    }
  } else if (attempt) {
    const durationMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
    parts.push(formatDuration(durationMs));
  }
  if (attempts > 1) {
    parts.push(`×${attempts}`);
  }
  const text = parts.join(" ");
  // Width includes the status glyph and the space after it; boxes add a
  // border and one padding column on each side.
  const contentWidth = text.length + 2;
  return { cell, text, status, width: nodeStyle === "box" ? contentWidth + 4 : contentWidth };
}

type RankGeometry = {
  cells: RenderedCell[];
  centers: number[];
};

type PlacedRank = RankGeometry & { y: number };

/** A strip segment with final pixel geometry and its assigned track row. */
type GeomSegment = {
  edgeId: string;
  label?: string | undefined;
  fromX: number;
  toX: number;
  track: number;
  targetIsNode: boolean;
};

type StripGeometry = {
  segments: GeomSegment[];
  trackCount: number;
  hasLabels: boolean;
  /** True when every segment is an unlabeled vertical line. */
  straight: boolean;
};

/** Transitions actually taken between the visible steps, as "from->to". */
function takenTransitions(visibleSteps: WorkflowStepRecord[]): Set<string> {
  const transitions = new Set<string>();
  for (let index = 1; index < visibleSteps.length; index += 1) {
    transitions.add(`${visibleSteps[index - 1]?.nodeId}->${visibleSteps[index]?.nodeId}`);
  }
  return transitions;
}

/**
 * Render the graph pane. `selectedStepIndex` scrubs the replay position;
 * pass `steps.length - 1` (or larger) for the live view.
 */
export function renderGraphLines(
  view: GraphView,
  selectedStepIndex: number,
  now: Date = new Date(),
  options: GraphRenderOptions = {},
): string[] {
  const snapshot = view.snapshot;
  if (!snapshot) {
    return [];
  }
  const nodeStyle = options.nodeStyle ?? "line";
  const layout = layoutGraph(snapshot);
  const steps = view.state.steps;
  const boundedIndex = Math.min(Math.max(selectedStepIndex, -1), steps.length - 1);
  const atLatestStep = boundedIndex >= steps.length - 1;
  const visibleSteps = steps.slice(0, boundedIndex + 1);
  const transitions = takenTransitions(visibleSteps);
  const activePair = derivePairInFlight(view, visibleSteps, atLatestStep);

  const rendered = layout.ranks.map((rank) =>
    rank.map((cell) => renderCellText(view, cell, visibleSteps, atLatestStep, now, nodeStyle)),
  );

  // Column positions: pack cells left to right per rank, then center every
  // rank against the widest one so vertical edges stay near-vertical.
  const rankWidths = rendered.map(
    (cells) =>
      cells.reduce((sum, cell) => sum + cell.width, 0) + Math.max(0, cells.length - 1) * CELL_GAP,
  );
  const graphWidth = Math.max(0, ...rankWidths);
  const geometry: RankGeometry[] = rendered.map((cells, rankIndex) => {
    const centers: number[] = [];
    let x = Math.floor((graphWidth - (rankWidths[rankIndex] ?? 0)) / 2);
    for (const cell of cells) {
      // Single-cell ranks share the exact graph center so chains render as
      // straight vertical lines instead of one-column elbows.
      centers.push(
        cells.length === 1 ? Math.floor(graphWidth / 2) : x + Math.floor(cell.width / 2),
      );
      x += cell.width + CELL_GAP;
    }
    return { cells, centers };
  });

  // Horizontal edge geometry (exit/entry columns, pixel-space track rows) is
  // fully decided before vertical placement, so row budgeting is exact.
  const strips = geometry.map((_rank, rankIndex) =>
    computeStripGeometry(layout, rankIndex, geometry),
  );

  const lanes = backEdgeLanes(layout);
  const placed: PlacedRank[] = [];
  // Entry lanes above the first rank need an arrow row of their own.
  const topLanes = lanes.above(0).length;
  let y = topLanes > 0 ? topLanes + 1 : 0;
  for (const [rankIndex, rank] of geometry.entries()) {
    placed.push({ ...rank, y });
    y +=
      cellHeight(nodeStyle) +
      lanes.below(rankIndex).length +
      gapRows(strips[rankIndex] as StripGeometry, rankIndex, layout.ranks.length) +
      lanes.above(rankIndex + 1).length;
  }

  const canvas = new CharCanvas();
  drawNodes(canvas, placed, layout, transitions, nodeStyle);
  const labels = drawSegments(
    canvas,
    placed,
    strips,
    layout,
    transitions,
    activePair,
    graphWidth,
    nodeStyle,
    lanes,
  );
  drawBackEdges(canvas, placed, layout, transitions, graphWidth, nodeStyle, lanes);
  // Labels go on last, once every line is on the canvas: placement can then
  // guarantee no later stroke crosses through a label.
  for (const label of labels) {
    drawSegmentLabel(canvas, label);
  }
  return canvas.render(paint);
}

/**
 * Back edges route through dedicated lane rows: one below their source rank
 * (box bottom to the right gutter) and one above their target rank (gutter
 * to the target's top). Dedicated rows mean a loop line can never collide
 * with node cells or other horizontal runs, no matter where the loop's
 * endpoints sit in their ranks; forward edges merely cross them vertically.
 */
type BackEdgeLanes = {
  edges: GraphEdge[];
  below: (rank: number) => GraphEdge[];
  above: (rank: number) => GraphEdge[];
};

function backEdgeLanes(layout: GraphLayout): BackEdgeLanes {
  const edges = layout.edges.filter((edge) => edge.isBackEdge);
  return {
    edges,
    below: (rank) => edges.filter((edge) => layout.rankOfNode.get(edge.from) === rank),
    above: (rank) => edges.filter((edge) => layout.rankOfNode.get(edge.to) === rank),
  };
}

/** The transition currently in flight, drawn in the active style. */
function derivePairInFlight(
  view: GraphView,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
): string | null {
  const state = view.state;
  if (atLatestStep) {
    if (state.status === "running" && state.currentNode && visibleSteps.length > 0) {
      return `${visibleSteps.at(-1)?.nodeId}->${state.currentNode}`;
    }
    return null;
  }
  if (visibleSteps.length >= 2) {
    return `${visibleSteps.at(-2)?.nodeId}->${visibleSteps.at(-1)?.nodeId}`;
  }
  return null;
}

/** Rows between rank r's cell rows and rank r+1's cell rows. */
function gapRows(strip: StripGeometry, rank: number, rankCount: number): number {
  if (strip.segments.length === 0) {
    return rank < rankCount - 1 ? 1 : 0;
  }
  // Straight unlabeled strips need no track rows: one line row, one arrow row.
  if (strip.straight) {
    return 2;
  }
  // Labelled strips reserve one extra row below the tracks so labels that do
  // not fit on their horizontal run always have a collision-free home.
  return 2 + strip.trackCount + (strip.hasLabels ? 1 : 0);
}

/**
 * Resolve a strip (all segments between rank r and rank r+1) to final pixel
 * geometry: exit and entry columns, and a horizontal track row per segment.
 *
 * Two rules make the drawing collision-free by construction. First, when
 * several edges leave or enter one cell, they fan out over separate columns
 * (ordered by the far end so lines inside a fan never cross), so corner
 * characters cannot merge into fake junctions. Second, tracks are assigned
 * from the final pixel spans, so two horizontal runs share a row only when
 * they cannot touch, corners included.
 */
function computeStripGeometry(
  layout: GraphLayout,
  rank: number,
  geometry: RankGeometry[],
): StripGeometry {
  const strip = layout.segments.filter((segment) => segment.rank === rank);
  const top = geometry[rank];
  const bottom = geometry[rank + 1];
  if (strip.length === 0 || !top || !bottom) {
    return { segments: [], trackCount: 1, hasLabels: false, straight: true };
  }
  const exitOffsets = fanOffsets(strip, "from", top, bottom);
  const entryOffsets = fanOffsets(strip, "to", top, bottom);
  const resolved = strip.map((segment) => {
    const fromX =
      (top.centers[segment.fromCell] as number) + (exitOffsets.get(segment.edgeId) ?? 0);
    let toX = (bottom.centers[segment.toCell] as number) + (entryOffsets.get(segment.edgeId) ?? 0);
    const targetIsNode = (bottom.cells[segment.toCell] as RenderedCell).cell.kind === "node";
    // A one-column jog reads as noise; draw it straight into the target,
    // whose rendered cell is wide enough to absorb the offset. Virtual
    // cells are exactly one column wide, so they must never be snapped.
    if (targetIsNode && Math.abs(toX - fromX) <= 1) {
      toX = fromX;
    }
    return { edgeId: segment.edgeId, label: segment.label, fromX, toX, targetIsNode };
  });

  // First-fit track assignment over pixel spans; straight unlabeled
  // segments draw a plain vertical line and need no track row.
  const segments: GeomSegment[] = [];
  const trackRanges: [number, number][][] = [];
  for (const segment of resolved.toSorted((a, b) => a.fromX - b.fromX)) {
    let track = 0;
    if (segment.fromX !== segment.toX || segment.label !== undefined) {
      const span: [number, number] = [
        Math.min(segment.fromX, segment.toX),
        Math.max(segment.fromX, segment.toX),
      ];
      track = trackRanges.findIndex((ranges) =>
        ranges.every(([start, end]) => span[1] < start || span[0] > end),
      );
      if (track === -1) {
        track = trackRanges.length;
        trackRanges.push([]);
      }
      (trackRanges[track] as [number, number][]).push(span);
    }
    segments.push({ ...segment, track });
  }
  return {
    segments,
    trackCount: Math.max(1, trackRanges.length),
    hasLabels: segments.some((segment) => segment.label !== undefined),
    straight: segments.every(
      (segment) => segment.fromX === segment.toX && segment.label === undefined,
    ),
  };
}

/**
 * Fan columns for edges sharing a cell: segment i (ordered by the far
 * end's x) gets column center - 2*(n-1-i), clamped to the cell, never
 * right of center. Forward fans stay at or left of center while back-edge
 * anchors sit right of center, so the two can never collide.
 */
function fanOffsets(
  strip: GraphSegment[],
  side: "from" | "to",
  top: RankGeometry,
  bottom: RankGeometry,
): Map<string, number> {
  const [ownRank, ownCell, farRank, farCell] =
    side === "from"
      ? ([top, (s: GraphSegment) => s.fromCell, bottom, (s: GraphSegment) => s.toCell] as const)
      : ([bottom, (s: GraphSegment) => s.toCell, top, (s: GraphSegment) => s.fromCell] as const);
  const offsets = new Map<string, number>();
  const groups = new Map<number, GraphSegment[]>();
  for (const segment of strip) {
    // Virtual cells are one column wide and always have one edge per side.
    if ((ownRank.cells[ownCell(segment)] as RenderedCell).cell.kind === "node") {
      groups.set(ownCell(segment), [...(groups.get(ownCell(segment)) ?? []), segment]);
    }
  }
  for (const [cellIndex, group] of groups) {
    if (group.length < 2) {
      continue;
    }
    const cell = ownRank.cells[cellIndex] as RenderedCell;
    const maxOffset = Math.max(1, Math.floor(cell.width / 2) - 1);
    const ordered = group.toSorted(
      (a, b) => (farRank.centers[farCell(a)] as number) - (farRank.centers[farCell(b)] as number),
    );
    for (const [index, segment] of ordered.entries()) {
      const offset = -2 * (ordered.length - 1 - index);
      offsets.set(segment.edgeId, Math.max(-maxOffset, offset));
    }
  }
  return offsets;
}

const BOX_CHARS = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
} as const;

function drawNodes(
  canvas: CharCanvas,
  placed: PlacedRank[],
  layout: GraphLayout,
  transitions: Set<string>,
  nodeStyle: GraphNodeStyle,
): void {
  for (const rank of placed) {
    for (const [index, rendered] of rank.cells.entries()) {
      const center = rank.centers[index] as number;
      const cell = rendered.cell;
      if (cell.kind === "virtual") {
        const edge = layout.edges.find((candidate) => candidate.edgeId === cell.edgeId);
        const taken = edge ? transitions.has(`${edge.from}->${edge.to}`) : false;
        // Pass-through cells span the full cell height so the edge stays
        // visually continuous across the rank row(s).
        canvas.vline(center, rank.y, rank.y + cellHeight(nodeStyle) - 1, taken ? "taken" : "dim");
        continue;
      }
      const status = rendered.status ?? "queued";
      const startX = center - Math.floor(rendered.width / 2);
      if (nodeStyle === "box") {
        drawNodeBox(canvas, startX, rank.y, rendered, status);
      } else {
        canvas.put(startX, rank.y, STATUS_GLYPHS[status], STATUS_STYLES[status]);
        canvas.text(startX + 2, rank.y, rendered.text, status === "queued" ? "dim" : "plain");
      }
    }
  }
}

/**
 * A bordered node cell. Edge geometry keeps lines outside the border rows,
 * so borders stay unbroken; the active node gets a heavy border so the
 * current position stands out.
 */
function drawNodeBox(
  canvas: CharCanvas,
  startX: number,
  y: number,
  rendered: RenderedCell,
  status: NodeStatus,
): void {
  const chars = status === "active" ? BOX_CHARS.heavy : BOX_CHARS.light;
  const style = STATUS_STYLES[status];
  const innerWidth = rendered.width - 2;
  canvas.text(startX, y, `${chars.tl}${chars.h.repeat(innerWidth)}${chars.tr}`, style);
  canvas.text(startX, y + 1, chars.v, style);
  canvas.put(startX + 2, y + 1, STATUS_GLYPHS[status], style);
  canvas.text(startX + 4, y + 1, rendered.text, status === "queued" ? "dim" : "plain");
  canvas.text(startX + rendered.width - 1, y + 1, chars.v, style);
  canvas.text(startX, y + 2, `${chars.bl}${chars.h.repeat(innerWidth)}${chars.br}`, style);
}

function edgeStyle(
  pairKey: string,
  transitions: Set<string>,
  activePair: string | null,
): CanvasStyle {
  if (activePair === pairKey) {
    return "active";
  }
  if (transitions.has(pairKey)) {
    return "taken";
  }
  return "dim";
}

function drawSegments(
  canvas: CharCanvas,
  placed: PlacedRank[],
  strips: StripGeometry[],
  layout: GraphLayout,
  transitions: Set<string>,
  activePair: string | null,
  graphWidth: number,
  nodeStyle: GraphNodeStyle,
  lanes: BackEdgeLanes,
): PendingLabel[] {
  const labels: PendingLabel[] = [];
  for (let rank = 0; rank < placed.length - 1; rank += 1) {
    const strip = strips[rank] as StripGeometry;
    if (strip.segments.length === 0) {
      continue;
    }
    const top = placed[rank] as PlacedRank;
    const bottom = placed[rank + 1] as PlacedRank;
    // Forward lines start right below the source cell, cross any back-edge
    // lane rows (as ┼ crossings), run their strip tracks, then cross the
    // entry lanes to the arrow row directly above the target cell.
    const stubTop = top.y + cellHeight(nodeStyle);
    const stripTop = stubTop + lanes.below(rank).length;
    const arrowY = bottom.y - 1;
    const stripBottom = arrowY - 1 - lanes.above(rank + 1).length;
    for (const segment of strip.segments) {
      const edge = layout.edges.find((candidate) => candidate.edgeId === segment.edgeId);
      if (!edge) {
        continue;
      }
      const style = edgeStyle(`${edge.from}->${edge.to}`, transitions, activePair);
      const { fromX, toX } = segment;
      const trackY = stripTop + segment.track;
      if (fromX === toX) {
        canvas.vline(fromX, stubTop, arrowY, style);
      } else {
        if (trackY > stubTop) {
          canvas.vline(fromX, stubTop, trackY - 1, style);
        }
        canvas.put(fromX, trackY, toX > fromX ? "└" : "┘", style);
        canvas.hline(trackY, Math.min(fromX, toX) + 1, Math.max(fromX, toX) - 1, style);
        canvas.put(toX, trackY, toX > fromX ? "┐" : "┌", style);
        if (arrowY > trackY) {
          canvas.vline(toX, trackY + 1, arrowY, style);
        }
      }
      if (segment.targetIsNode) {
        canvas.put(toX, arrowY, "▼", style);
      }
      if (segment.label !== undefined) {
        labels.push({
          text: segment.label,
          style,
          fromX,
          toX,
          trackY,
          labelRow: Math.min(stripTop + strip.trackCount, stripBottom),
          graphWidth,
        });
      }
    }
  }
  return labels;
}

type PendingLabel = {
  text: string;
  style: CanvasStyle;
  fromX: number;
  toX: number;
  trackY: number;
  labelRow: number;
  graphWidth: number;
};

/**
 * Place a branch label. Labels are drawn after every line is on the canvas,
 * so a spot that is free now stays free: first try writing over the
 * segment's own horizontal run (only plain `─` cells may be replaced), then
 * the strip's reserved label row beside the descending line, trying the
 * side facing the graph center first.
 */
function drawSegmentLabel(canvas: CharCanvas, label: PendingLabel): void {
  const { text, style, fromX, toX, trackY, labelRow, graphWidth } = label;
  const padded = ` ${text} `;
  if (fromX !== toX) {
    const runStart = Math.min(fromX, toX) + 1;
    const runEnd = Math.max(fromX, toX) - 1;
    const center = Math.floor((runStart + runEnd) / 2) - Math.floor(padded.length / 2);
    if (
      runEnd - runStart + 1 >= padded.length + 2 &&
      canvas.textOverRun(center, trackY, padded, style)
    ) {
      return;
    }
  }
  const candidates: [number, number][] =
    toX >= Math.floor(graphWidth / 2)
      ? [
          [toX - text.length - 1, labelRow],
          [toX + 2, labelRow],
        ]
      : [
          [toX + 2, labelRow],
          [toX - text.length - 1, labelRow],
        ];
  for (const [x, y] of candidates) {
    if (canvas.textIfEmpty(x, y, text, style)) {
      return;
    }
  }
  // Last resort: beside the source corner on the track row.
  canvas.textIfEmpty(fromX + 2, trackY, text, style);
}

/**
 * Each back edge leaves its source cell downward into its own lane row,
 * runs right to a private gutter column, climbs the gutter, and re-enters
 * through its target's entry lane and arrow row from above. Every lane row
 * and gutter column is exclusive to one edge, so loop lines can only ever
 * cross other lines (merging into ┼), never run along them.
 */
function drawBackEdges(
  canvas: CharCanvas,
  placed: PlacedRank[],
  layout: GraphLayout,
  transitions: Set<string>,
  graphWidth: number,
  nodeStyle: GraphNodeStyle,
  lanes: BackEdgeLanes,
): void {
  let gutterX = graphWidth + GUTTER_GAP;
  for (const edge of lanes.edges) {
    const fromRank = layout.rankOfNode.get(edge.from);
    const toRank = layout.rankOfNode.get(edge.to);
    if (fromRank === undefined || toRank === undefined) {
      continue;
    }
    const from = placed[fromRank] as PlacedRank;
    const to = placed[toRank] as PlacedRank;
    const exit = cellAnchor(from, edge.from, lanes.below(fromRank), edge);
    const entry = cellAnchor(to, edge.to, lanes.above(toRank), edge);
    if (!exit || !entry) {
      continue;
    }
    const style: CanvasStyle = transitions.has(`${edge.from}->${edge.to}`) ? "taken" : "back";
    const exitLaneY = from.y + cellHeight(nodeStyle) + exit.lane;
    const aboveCount = lanes.above(toRank).length;
    const arrowY = to.y - 1;
    const entryLaneY = arrowY - aboveCount + entry.lane;

    // Downward stub out of the source cell, then right along the exit lane.
    if (exitLaneY > from.y + cellHeight(nodeStyle)) {
      canvas.vline(exit.x, from.y + cellHeight(nodeStyle), exitLaneY - 1, style);
    }
    canvas.put(exit.x, exitLaneY, "└", style);
    canvas.hline(exitLaneY, exit.x + 1, gutterX - 1, style);
    canvas.put(gutterX, exitLaneY, "┘", style);
    // Up the gutter, then left along the entry lane into the target.
    canvas.put(gutterX, entryLaneY, "┐", style);
    if (exitLaneY - entryLaneY > 1) {
      canvas.vline(gutterX, entryLaneY + 1, exitLaneY - 1, style);
    }
    canvas.hline(entryLaneY, entry.x + 1, gutterX - 1, style);
    canvas.put(entry.x, entryLaneY, "┌", style);
    if (arrowY - entryLaneY > 1) {
      canvas.vline(entry.x, entryLaneY + 1, arrowY - 1, style);
    }
    canvas.put(entry.x, arrowY, "▼", style);
    if (edge.label !== undefined) {
      canvas.text(gutterX + 2, entryLaneY, edge.label, style);
    }
    // Reserve horizontal room for this gutter and its label before the next.
    gutterX += 2 + (edge.label === undefined ? 0 : edge.label.length + 1);
  }
}

/**
 * Where a back edge touches a node cell: offset right of center so the
 * stub can never collide with forward-edge lines at the center column,
 * clamped inside the cell.
 */
function cellAnchor(
  rank: PlacedRank,
  nodeId: string,
  laneEdges: GraphEdge[],
  edge: GraphEdge,
): { x: number; lane: number } | null {
  const index = rank.cells.findIndex(
    (cell) => cell.cell.kind === "node" && cell.cell.nodeId === nodeId,
  );
  const lane = laneEdges.findIndex((candidate) => candidate.edgeId === edge.edgeId);
  if (index === -1 || lane === -1) {
    return null;
  }
  const cell = rank.cells[index] as RenderedCell;
  const center = rank.centers[index] as number;
  const rightmost = center + Math.floor(cell.width / 2) - 1;
  return { x: Math.min(center + 2 + lane * 2, rightmost), lane };
}
