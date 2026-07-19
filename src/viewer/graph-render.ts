import type { LoadedRunBundle } from "../workflows/store.js";
import type { WorkflowStepRecord } from "../workflows/types.js";
import { ansi } from "./ansi.js";
import { CharCanvas, type CanvasStyle } from "./canvas.js";
import { formatDuration } from "./format.js";
import { layoutGraph, type GraphCell, type GraphLayout, type GraphSegment } from "./graph.js";

/**
 * Renders the workflow DAG as text, mirroring the acpx replay viewer's graph
 * pane: statuses derive from the steps visible up to the selected step, taken
 * transitions highlight, switch branches carry case labels, and loop edges
 * route through a right-hand gutter.
 */

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
  bundle: LoadedRunBundle,
  nodeId: string,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
): NodeStatus {
  const state = bundle.state;
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
  bundle: LoadedRunBundle,
  cell: GraphCell,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
  now: Date,
): RenderedCell {
  if (cell.kind === "virtual") {
    return { cell, text: "", status: null, width: 1 };
  }
  const state = bundle.state;
  const nodeId = cell.nodeId;
  const status = deriveNodeStatus(bundle, nodeId, visibleSteps, atLatestStep);
  const nodeType = bundle.snapshot?.nodes[nodeId]?.nodeType ?? "?";
  const attempt = latestVisibleAttempt(visibleSteps, nodeId);
  const attempts = visibleSteps.filter((step) => step.nodeId === nodeId).length;
  const parts = [`${nodeId} [${nodeType}]`];
  if (atLatestStep && state.currentNode === nodeId) {
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    parts.push(`running ${formatDuration(now.getTime() - startedAt)}`);
    if (state.statusDetail) {
      parts.push(`· ${state.statusDetail}`);
    }
  } else if (attempt) {
    const durationMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
    parts.push(formatDuration(durationMs));
  }
  if (attempts > 1) {
    parts.push(`×${attempts}`);
  }
  const text = parts.join(" ");
  // Width includes the status glyph and the space after it.
  return { cell, text, status, width: text.length + 2 };
}

type PlacedRank = {
  cells: RenderedCell[];
  centers: number[];
  y: number;
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
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
  now: Date = new Date(),
): string[] {
  const snapshot = bundle.snapshot;
  if (!snapshot) {
    return [];
  }
  const layout = layoutGraph(snapshot);
  const steps = bundle.state.steps;
  const boundedIndex = Math.min(Math.max(selectedStepIndex, -1), steps.length - 1);
  const atLatestStep = boundedIndex >= steps.length - 1;
  const visibleSteps = steps.slice(0, boundedIndex + 1);
  const transitions = takenTransitions(visibleSteps);
  const activePair = derivePairInFlight(bundle, visibleSteps, atLatestStep);

  const rendered = layout.ranks.map((rank) =>
    rank.map((cell) => renderCellText(bundle, cell, visibleSteps, atLatestStep, now)),
  );

  // Column positions: pack cells left to right per rank, then center every
  // rank against the widest one so vertical edges stay near-vertical.
  const rankWidths = rendered.map(
    (cells) =>
      cells.reduce((sum, cell) => sum + cell.width, 0) + Math.max(0, cells.length - 1) * CELL_GAP,
  );
  const graphWidth = Math.max(0, ...rankWidths);
  const placed: PlacedRank[] = [];
  let y = 0;
  for (const [rankIndex, cells] of rendered.entries()) {
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
    placed.push({ cells, centers, y });
    y += 1 + gapRows(layout, rankIndex);
  }

  const canvas = new CharCanvas();
  drawNodes(canvas, placed, layout, transitions);
  drawSegments(canvas, placed, layout, transitions, activePair, graphWidth);
  drawBackEdges(canvas, placed, layout, transitions, graphWidth);
  return canvas.render(paint);
}

/** The transition currently in flight, drawn in the active style. */
function derivePairInFlight(
  bundle: LoadedRunBundle,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
): string | null {
  const state = bundle.state;
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

/** Rows between rank r's node line and rank r+1's node line. */
function gapRows(layout: GraphLayout, rank: number): number {
  const strip = layout.segments.filter((segment) => segment.rank === rank);
  if (strip.length === 0) {
    return rank < layout.ranks.length - 1 ? 1 : 0;
  }
  return 2 + trackAssignments(strip).trackCount;
}

type TrackedSegment = GraphSegment & { track: number };

/**
 * Assign horizontal tracks so overlapping horizontal runs in the same strip
 * get separate rows. Straight unlabeled segments do not occupy a track.
 */
function trackAssignments(strip: GraphSegment[]): {
  tracked: TrackedSegment[];
  trackCount: number;
} {
  const tracked: TrackedSegment[] = [];
  const trackRanges: [number, number][][] = [];
  for (const segment of strip.toSorted((a, b) => a.fromCell - b.fromCell)) {
    const span: [number, number] = [
      Math.min(segment.fromCell, segment.toCell),
      Math.max(segment.fromCell, segment.toCell),
    ];
    let track = 0;
    if (segment.fromCell !== segment.toCell || segment.label !== undefined) {
      track = trackRanges.findIndex((ranges) =>
        ranges.every(([start, end]) => span[1] < start || span[0] > end),
      );
      if (track === -1) {
        track = trackRanges.length;
        trackRanges.push([]);
      }
      (trackRanges[track] as [number, number][]).push(span);
    }
    tracked.push({ ...segment, track });
  }
  return { tracked, trackCount: Math.max(1, trackRanges.length) };
}

function drawNodes(
  canvas: CharCanvas,
  placed: PlacedRank[],
  layout: GraphLayout,
  transitions: Set<string>,
): void {
  for (const rank of placed) {
    for (const [index, rendered] of rank.cells.entries()) {
      const center = rank.centers[index] as number;
      const cell = rendered.cell;
      if (cell.kind === "virtual") {
        const edge = layout.edges.find((candidate) => candidate.edgeId === cell.edgeId);
        const taken = edge ? transitions.has(`${edge.from}->${edge.to}`) : false;
        canvas.put(center, rank.y, "│", taken ? "taken" : "dim");
        continue;
      }
      const status = rendered.status ?? "queued";
      const startX = center - Math.floor(rendered.width / 2);
      canvas.put(startX, rank.y, STATUS_GLYPHS[status], STATUS_STYLES[status]);
      canvas.text(startX + 2, rank.y, rendered.text, status === "queued" ? "dim" : "plain");
    }
  }
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
  layout: GraphLayout,
  transitions: Set<string>,
  activePair: string | null,
  graphWidth: number,
): void {
  for (let rank = 0; rank < placed.length - 1; rank += 1) {
    const strip = layout.segments.filter((segment) => segment.rank === rank);
    if (strip.length === 0) {
      continue;
    }
    const { tracked } = trackAssignments(strip);
    const top = placed[rank] as PlacedRank;
    const bottom = placed[rank + 1] as PlacedRank;
    const stripTop = top.y + 1;
    const arrowY = bottom.y - 1;
    for (const segment of tracked) {
      const edge = layout.edges.find((candidate) => candidate.edgeId === segment.edgeId);
      if (!edge) {
        continue;
      }
      const style = edgeStyle(`${edge.from}->${edge.to}`, transitions, activePair);
      const fromX = top.centers[segment.fromCell] as number;
      let toX = bottom.centers[segment.toCell] as number;
      const trackY = stripTop + segment.track;
      const targetCell = (bottom.cells[segment.toCell] as RenderedCell).cell;
      // A one-column jog reads as noise; draw it straight into the target,
      // whose rendered cell is wide enough to absorb the offset.
      if (Math.abs(toX - fromX) <= 1) {
        toX = fromX;
      }
      if (fromX === toX) {
        canvas.vline(fromX, stripTop, arrowY, style);
      } else {
        if (trackY > stripTop) {
          canvas.vline(fromX, stripTop, trackY - 1, style);
        }
        canvas.put(fromX, trackY, toX > fromX ? "└" : "┘", style);
        canvas.hline(trackY, Math.min(fromX, toX) + 1, Math.max(fromX, toX) - 1, style);
        canvas.put(toX, trackY, toX > fromX ? "┐" : "┌", style);
        if (arrowY > trackY) {
          canvas.vline(toX, trackY + 1, arrowY, style);
        }
      }
      if (targetCell.kind === "node") {
        canvas.put(toX, arrowY, "▼", style);
      }
      if (segment.label !== undefined) {
        const label = ` ${segment.label} `;
        if (fromX === toX) {
          canvas.text(fromX + 2, trackY, label, style);
        } else if (Math.abs(toX - fromX) >= label.length + 4) {
          // Long horizontal run: center the label on the line.
          canvas.text(
            Math.floor((fromX + toX) / 2) - Math.floor(label.length / 2),
            trackY,
            label,
            style,
          );
        } else {
          // Short run: hang the label beside the descending line, on the
          // side facing the graph center so it stays clear of the back-edge
          // gutter at the right margin.
          const labelY = Math.min(trackY + 1, arrowY - 1);
          if (toX >= Math.floor(graphWidth / 2)) {
            canvas.text(toX - label.length, labelY, label, style);
          } else {
            canvas.text(toX + 2, labelY, label, style);
          }
        }
      }
    }
  }
}

function drawBackEdges(
  canvas: CharCanvas,
  placed: PlacedRank[],
  layout: GraphLayout,
  transitions: Set<string>,
  graphWidth: number,
): void {
  const backEdges = layout.edges.filter((edge) => edge.isBackEdge);
  for (const [track, edge] of backEdges.entries()) {
    const fromRank = layout.rankOfNode.get(edge.from);
    const toRank = layout.rankOfNode.get(edge.to);
    if (fromRank === undefined || toRank === undefined) {
      continue;
    }
    const from = placed[fromRank] as PlacedRank;
    const to = placed[toRank] as PlacedRank;
    const fromIndex = from.cells.findIndex(
      (cell) => cell.cell.kind === "node" && cell.cell.nodeId === edge.from,
    );
    const toIndex = to.cells.findIndex(
      (cell) => cell.cell.kind === "node" && cell.cell.nodeId === edge.to,
    );
    if (fromIndex === -1 || toIndex === -1) {
      continue;
    }
    const style: CanvasStyle = transitions.has(`${edge.from}->${edge.to}`) ? "taken" : "back";
    const gutterX = graphWidth + GUTTER_GAP + track * 2;
    const fromCell = from.cells[fromIndex] as RenderedCell;
    const toCell = to.cells[toIndex] as RenderedCell;
    const fromEdgeX = (from.centers[fromIndex] as number) + Math.ceil(fromCell.width / 2) + 1;
    const toEdgeX = (to.centers[toIndex] as number) + Math.ceil(toCell.width / 2) + 1;
    canvas.hline(from.y, fromEdgeX, gutterX - 1, style);
    canvas.hline(to.y, toEdgeX + 1, gutterX - 1, style);
    const [top, bottom] = from.y < to.y ? [from.y, to.y] : [to.y, from.y];
    // The gutter line always turns left toward the nodes at both ends.
    canvas.put(gutterX, top, "┐", style);
    canvas.put(gutterX, bottom, "┘", style);
    if (bottom - top > 1) {
      canvas.vline(gutterX, top + 1, bottom - 1, style);
    }
    canvas.put(toEdgeX, to.y, "◀", style);
    if (edge.label !== undefined) {
      canvas.text(gutterX + 2, Math.floor((from.y + to.y) / 2), edge.label, style);
    }
  }
}
