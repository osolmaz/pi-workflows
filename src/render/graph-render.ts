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
import { nodeTypeBadge } from "./node-type.js";

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
  graphScene?: GraphLayout;
  graphSteps?: WorkflowStepRecord[];
  takenTransitions?: string[];
};

type NodeStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "active"
  | "replay_focus"
  | "waiting"
  | "queued"
  | "cancelled";

const STATUS_GLYPHS: Record<NodeStatus, string> = {
  completed: "✓",
  failed: "✗",
  timed_out: "×",
  active: "◐",
  replay_focus: "◆",
  waiting: "⏸",
  cancelled: "~",
  queued: "·",
};

const STATUS_LABELS: Record<NodeStatus, string> = {
  completed: "completed",
  failed: "failed",
  timed_out: "timed out",
  active: "running",
  replay_focus: "replay focus",
  waiting: "waiting",
  cancelled: "cancelled",
  queued: "queued",
};

const STATUS_STYLES: Record<NodeStatus, CanvasStyle> = {
  completed: "ok",
  failed: "fail",
  timed_out: "fail",
  active: "active",
  replay_focus: "active",
  waiting: "warn",
  cancelled: "warn",
  queued: "dim",
};

const CELL_GAP = 6;
const GUTTER_GAP = 2;
const GRAPH_SIDE_MARGIN = 2;
const CARD_MIN_CONTENT_WIDTH = 20;
const CARD_MAX_CONTENT_WIDTH = 28;
const CARD_CORE_HEIGHT = 7;
const CARD_MAX_BRANCH_ROWS = 3;

function nodeTypeStyle(nodeType: string): CanvasStyle {
  switch (nodeType) {
    case "agent":
    case "compute":
    case "notify":
      return nodeType === "notify" ? "action" : nodeType;
    case "action":
    case "checkpoint":
      return nodeType;
    default:
      return "dim";
  }
}

function fitText(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return width <= 1 ? chars.slice(0, width).join("") : `${chars.slice(0, width - 1).join("")}…`;
}

function centeredText(text: string, width: number): string {
  const fitted = fitText(text, width);
  const left = Math.max(0, Math.floor((width - [...fitted].length) / 2));
  return `${" ".repeat(left)}${fitted}`;
}

/** How node cells are drawn: single text lines or bordered boxes. */
export type GraphNodeStyle = "line" | "box";

export type GraphRenderOptions = {
  nodeStyle?: GraphNodeStyle;
};

type CardShape = {
  width: number;
  height: number;
};

function cellHeight(nodeStyle: GraphNodeStyle, cell: RenderedCell): number {
  return nodeStyle === "box" ? cell.height : 1;
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
    case "action":
      return ansi.yellow(text);
    case "fail":
      return ansi.red(text);
    case "agent":
      return ansi.green(text);
    case "compute":
      return ansi.blue(text);
    case "checkpoint":
      return ansi.magenta(text);
    case "branch":
      return ansi.cyan(text);
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
  if (!atLatestStep && visibleSteps.at(-1)?.nodeId === nodeId) {
    return "replay_focus";
  }
  switch (attempt.outcome) {
    case "ok":
      return "completed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function nodeBranchLabels(view: GraphView, nodeId: string): string[] {
  return (
    view.snapshot?.edges.flatMap((edge) =>
      edge.from === nodeId && "switch" in edge ? Object.keys(edge.switch.cases) : [],
    ) ?? []
  ).map(sanitizeText);
}

function cardShape(view: GraphView, nodeId: string): CardShape {
  const node = view.snapshot?.nodes[nodeId];
  const labels = nodeBranchLabels(view, nodeId);
  const branchRows = Math.min(labels.length, CARD_MAX_BRANCH_ROWS);
  const actionExecution = "actionExecution" in (node ?? {}) ? node?.actionExecution : undefined;
  const humanAudience = node && "humanDecision" in node ? node.humanDecision.audience : undefined;
  const configuredDetail = node?.statusDetail ?? node?.summary;
  const assistantDetail =
    node?.nodeType === "agent" &&
    typeof node.expectedOutput === "object" &&
    node.expectedOutput.kind === "assistant-message"
      ? "assistant response"
      : undefined;
  const cardDetail = [assistantDetail, configuredDetail].filter(Boolean).join(" · ");
  const candidates = [
    hierarchicalNodeLabel(nodeId, node),
    node ? nodeTypeBadge(node.nodeType, actionExecution) : "? unknown",
    ...(humanAudience === undefined ? [] : [`… human decision · ${humanAudience}`]),
    ...(cardDetail === "" ? [] : [`… ${cardDetail}`]),
    ...boundedBranchLines(labels),
  ];
  const desiredWidth = Math.max(...candidates.map((value) => [...value].length));
  const contentWidth = Math.max(
    CARD_MIN_CONTENT_WIDTH,
    Math.min(CARD_MAX_CONTENT_WIDTH, desiredWidth),
  );
  return {
    width: contentWidth + 4,
    height: CARD_CORE_HEIGHT + branchRows,
  };
}

/** Canonical bounded outer dimensions for one boxed node card. */
export function graphCardSize(view: GraphView, nodeId: string): { width: number; height: number } {
  return cardShape(view, nodeId);
}

function boundedNodeLabel(
  nodeId: string,
  node: WorkflowDefinitionSnapshot["nodes"][string] | undefined,
  contentWidth: number,
): string {
  const full = hierarchicalNodeLabel(nodeId, node);
  if ([...full].length <= contentWidth) return full;
  const local = sanitizeText(node?.localNodeId ?? nodeId);
  const suffix =
    node?.includeTransition === "entry"
      ? "enter"
      : node?.includeTransition === "exit"
        ? `${local} exit`
        : local;
  const candidate = `… › ${suffix}`;
  return [...candidate].length <= contentWidth ? candidate : fitText(suffix, contentWidth);
}

function boundedBranchLines(labels: string[]): string[] {
  if (labels.length <= CARD_MAX_BRANCH_ROWS) return labels.map((label) => `◇ ${label}`);
  return [`◇ ${labels[0]}`, `◇ ${labels[1]}`, `+${labels.length - 2} branches`];
}

type RenderedCell = {
  cell: GraphCell;
  text: string;
  nodeId: string;
  nodeType: string;
  typeBadge: string;
  status: NodeStatus | null;
  attempts: number;
  elapsed: string;
  detail: string;
  branchLines: string[];
  isStart: boolean;
  isEnd: boolean;
  width: number;
  height: number;
};

function renderCellText(
  view: GraphView,
  cell: GraphCell,
  visibleSteps: WorkflowStepRecord[],
  atLatestStep: boolean,
  now: Date,
  nodeStyle: GraphNodeStyle,
  shape: CardShape,
): RenderedCell {
  if (cell.kind === "virtual") {
    return {
      cell,
      text: "",
      nodeId: "",
      nodeType: "",
      typeBadge: "",
      status: null,
      attempts: 0,
      elapsed: "",
      detail: "",
      branchLines: [],
      isStart: false,
      isEnd: false,
      width: 1,
      height: 1,
    };
  }
  const state = view.state;
  const nodeId = cell.nodeId;
  const status = deriveNodeStatus(view, nodeId, visibleSteps, atLatestStep);
  const node = view.snapshot?.nodes[nodeId];
  const nodeType = node?.nodeType ?? "?";
  const attempt = latestVisibleAttempt(visibleSteps, nodeId);
  const attempts = visibleSteps.filter((step) => step.nodeId === nodeId).length;
  const labels = nodeBranchLabels(view, nodeId);
  const outgoing =
    view.snapshot?.edges
      .filter((edge) => edge.from === nodeId)
      .reduce(
        (count, edge) => count + ("to" in edge ? 1 : Object.keys(edge.switch.cases).length),
        0,
      ) ?? 0;
  const isStart = view.snapshot?.startAt === nodeId;
  const isEnd = outgoing === 0;
  let elapsed = "—";
  if (atLatestStep && state.currentNode === nodeId) {
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    elapsed = formatDuration(now.getTime() - startedAt);
  } else if (attempt) {
    const durationMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
    elapsed = formatDuration(durationMs);
  }
  const human = node?.humanDecision;
  const waitingSchema =
    state.waitingOn === nodeId &&
    state.finalOutput !== null &&
    typeof state.finalOutput === "object"
      ? (state.finalOutput as { schema?: unknown }).schema
      : undefined;
  const waitingRequest =
    waitingSchema === "pi-workflows.human-decision-request.v1"
      ? (state.finalOutput as {
          audience?: unknown;
          presentationDigest?: unknown;
          presentation?: { summary?: unknown };
        })
      : undefined;
  const selected =
    human !== undefined &&
    state.humanDecision !== undefined &&
    state.humanDecision.nodeId === nodeId
      ? human.choices[state.humanDecision.response.choice]
      : undefined;
  const humanDetail =
    human === undefined
      ? undefined
      : state.waitingOn === nodeId
        ? `human decision · ${sanitizeText(typeof waitingRequest?.audience === "string" ? waitingRequest.audience : human.audience)}`
        : selected !== undefined
          ? `human: ${sanitizeText(selected.label)}`
          : undefined;
  const configuredDetail =
    atLatestStep && state.currentNode === nodeId && state.statusDetail
      ? sanitizeText(state.statusDetail)
      : node?.statusDetail
        ? sanitizeText(node.statusDetail)
        : node?.summary
          ? sanitizeText(node.summary)
          : "";
  const assistantDetail =
    node?.nodeType === "agent" &&
    typeof node.expectedOutput === "object" &&
    node.expectedOutput.kind === "assistant-message"
      ? "assistant response"
      : "";
  const nodeDetail = [assistantDetail, configuredDetail].filter(Boolean).join(" · ");
  const detail = humanDetail ?? nodeDetail;
  const branchLines = boundedBranchLines(labels);
  const count = atLatestStep && state.currentNode === nodeId ? Math.max(attempts, 1) : attempts;
  const timing =
    attempt || count > 0 ? `${count} attempt${count === 1 ? "" : "s"} · ${elapsed}` : "not visited";
  const displayNodeId = boundedNodeLabel(nodeId, node, shape.width - 4);
  const text = `${displayNodeId} [${nodeType}] ${timing}`;
  return {
    cell,
    text,
    nodeId: sanitizeText(displayNodeId),
    nodeType,
    typeBadge: node ? nodeTypeBadge(node.nodeType, node.actionExecution) : "? unknown",
    status,
    attempts: count,
    elapsed,
    detail,
    branchLines,
    isStart,
    isEnd,
    width: nodeStyle === "box" ? shape.width : text.length + 2,
    height: nodeStyle === "box" ? shape.height : 1,
  };
}

function hierarchicalNodeLabel(
  nodeId: string,
  node: WorkflowDefinitionSnapshot["nodes"][string] | undefined,
): string {
  if (node?.mountPath === undefined || node.localNodeId === undefined) return nodeId;
  const path = node.mountPath.join(" › ");
  if (node.includeTransition === "entry") return `${path} · enter`;
  if (node.includeTransition === "exit") return `${path} · ${node.localNodeId} exit`;
  return `${path} › ${node.localNodeId}`;
}

type RankGeometry = {
  cells: RenderedCell[];
  centers: number[];
};

type PlacedRank = RankGeometry & { y: number; height: number };

/** A strip segment with final pixel geometry and its assigned track row. */
type GeomSegment = {
  edgeId: string;
  label?: string | undefined;
  fromCell: number;
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
  const layout = view.graphScene ?? layoutGraph(snapshot);
  const stateSteps = view.state.steps;
  const steps = view.graphSteps ?? stateSteps;
  const boundedIndex = Math.min(Math.max(selectedStepIndex, -1), steps.length - 1);
  const atLatestStep = boundedIndex >= steps.length - 1;
  const visibleSteps = steps.slice(0, boundedIndex + 1);
  const transitions = new Set(view.takenTransitions ?? takenTransitions(visibleSteps));
  const activePair = derivePairInFlight(view, visibleSteps, atLatestStep);

  const rendered = layout.ranks.map((rank) =>
    rank.map((cell) =>
      renderCellText(
        view,
        cell,
        visibleSteps,
        atLatestStep,
        now,
        nodeStyle,
        cell.kind === "node" ? cardShape(view, cell.nodeId) : { width: 1, height: 1 },
      ),
    ),
  );

  // Column positions: pack cells left to right per rank, then center every
  // rank against the widest one so vertical edges stay near-vertical.
  const rankWidths = rendered.map(
    (cells) =>
      cells.reduce((sum, cell) => sum + cell.width, 0) + Math.max(0, cells.length - 1) * CELL_GAP,
  );
  const graphWidth = Math.max(0, ...rankWidths) + GRAPH_SIDE_MARGIN * 2;
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
    const height = Math.max(1, ...rank.cells.map((cell) => cellHeight(nodeStyle, cell)));
    placed.push({ ...rank, y, height });
    y +=
      height +
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
  drawBackEdges(canvas, placed, layout, transitions, graphWidth, lanes);
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
    return {
      edgeId: segment.edgeId,
      label: segment.label,
      fromCell: segment.fromCell,
      fromX,
      toX,
      targetIsNode,
    };
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
  light: { tl: "┌", tr: "┐", ml: "├", mr: "┤", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", ml: "┣", mr: "┫", bl: "┗", br: "┛", h: "━", v: "┃" },
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
        canvas.vline(center, rank.y, rank.y + rank.height - 1, taken ? "taken" : "dim");
        continue;
      }
      const status = rendered.status ?? "queued";
      const startX = center - Math.floor(rendered.width / 2);
      if (nodeStyle === "box") {
        drawNodeBox(canvas, startX, rank.y, rendered, status);
      } else {
        if (rendered.isStart) canvas.put(startX - 2, rank.y, "▶", STATUS_STYLES[status]);
        canvas.put(startX, rank.y, STATUS_GLYPHS[status], STATUS_STYLES[status]);
        canvas.text(startX + 2, rank.y, rendered.text, status === "queued" ? "dim" : "plain");
        if (rendered.isEnd) {
          canvas.put(startX + rendered.width + 1, rank.y, "■", STATUS_STYLES[status]);
        }
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
  const chars =
    status === "active" || status === "replay_focus" ? BOX_CHARS.heavy : BOX_CHARS.light;
  const borderStyle = STATUS_STYLES[status];
  const typeStyle = nodeTypeStyle(rendered.nodeType);
  const contentStyle = status === "queued" ? "dim" : "plain";
  const innerWidth = rendered.width - 2;
  const height = 7 + rendered.branchLines.length;
  const rightX = startX + rendered.width - 1;
  const horizontal = chars.h.repeat(innerWidth);
  const rowBorder = (row: number) => {
    canvas.text(startX, row, chars.v, borderStyle);
    canvas.text(rightX, row, chars.v, borderStyle);
  };
  const pairedRow = (
    row: number,
    left: string,
    leftStyle: CanvasStyle,
    right: string,
    rightStyle: CanvasStyle,
  ) => {
    rowBorder(row);
    canvas.text(startX + 2, row, fitText(left, innerWidth - 2), leftStyle);
    const rightText = fitText(right, innerWidth - 2);
    canvas.text(rightX - 1 - [...rightText].length, row, rightText, rightStyle);
  };

  canvas.text(startX, y, `${chars.tl}${horizontal}${chars.tr}`, borderStyle);
  rowBorder(y + 1);
  canvas.text(startX + 1, y + 1, centeredText(rendered.nodeId, innerWidth), contentStyle);
  canvas.text(startX, y + 2, `${chars.ml}${horizontal}${chars.mr}`, borderStyle);
  pairedRow(
    y + 3,
    rendered.typeBadge,
    typeStyle,
    `${STATUS_GLYPHS[status]} ${STATUS_LABELS[status]}`,
    borderStyle,
  );
  pairedRow(y + 4, `↻ ${rendered.attempts}`, contentStyle, `◷ ${rendered.elapsed}`, contentStyle);
  for (const [index, branch] of rendered.branchLines.entries()) {
    const row = y + 5 + index;
    rowBorder(row);
    canvas.text(startX + 2, row, fitText(branch, innerWidth - 2), "branch");
  }
  const detailRow = y + 5 + rendered.branchLines.length;
  rowBorder(detailRow);
  if (rendered.detail) {
    canvas.text(
      startX + 2,
      detailRow,
      fitText(`… ${rendered.detail}`, innerWidth - 2),
      contentStyle,
    );
  }
  canvas.text(startX, y + height - 1, `${chars.bl}${horizontal}${chars.br}`, borderStyle);
  if (rendered.isStart) canvas.put(startX - 2, y + 1, "▶", borderStyle);
  if (rendered.isEnd) canvas.put(startX + rendered.width + 1, y + 1, "■", borderStyle);
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
    const stripTop = top.y + top.height + lanes.below(rank).length;
    const arrowY = bottom.y - 1;
    const stripBottom = arrowY - 1 - lanes.above(rank + 1).length;
    for (const segment of strip.segments) {
      const source = top.cells[segment.fromCell];
      const stubTop =
        source?.cell.kind === "node" ? top.y + cellHeight(nodeStyle, source) : top.y + top.height;
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
    const exitLaneY = from.y + from.height + exit.lane;
    const aboveCount = lanes.above(toRank).length;
    const arrowY = to.y - 1;
    const entryLaneY = arrowY - aboveCount + entry.lane;

    // Downward stub out of the source cell, through any rank padding, then
    // right below the tallest card. A short card must not route an edge
    // through a taller card in the same rank.
    if (exitLaneY > from.y + exit.height) {
      canvas.vline(exit.x, from.y + exit.height, exitLaneY - 1, style);
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
): { x: number; lane: number; height: number } | null {
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
  return { x: Math.min(center + 2 + lane * 2, rightmost), lane, height: cell.height };
}
