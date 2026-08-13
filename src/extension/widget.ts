import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansi, stripAnsi } from "../render/ansi.js";
import { renderGraphLines } from "../render/graph-render.js";
import { sanitizeText } from "../workflows/text.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowRunStatus,
} from "../workflows/types.js";

const STATUS_GLYPHS: Record<WorkflowRunStatus, string> = {
  running: "◐",
  waiting: "⏸",
  completed: "✓",
  failed: "✗",
  timed_out: "✗",
  cancelled: "✗",
};

/**
 * pi renders at most this many widget lines (InteractiveMode.MAX_WIDGET_LINES)
 * and appends its own "(widget truncated)" marker beyond it. Stay inside the
 * budget and choose which graph rows to show instead of losing the bottom.
 */
const PI_MAX_WIDGET_LINES = 10;

export function nodeGlyph(state: WorkflowRunState, nodeId: string): string {
  if (state.currentNode === nodeId) {
    return "◐";
  }
  const result = state.results[nodeId];
  if (!result) {
    return "·";
  }
  if (state.waitingOn === nodeId) {
    return "⏸";
  }
  return result.outcome === "ok" ? "✓" : "✗";
}

/** Node ids in a stable display order: definition order from the snapshot. */
export function displayNodeIds(snapshot: WorkflowDefinitionSnapshot): string[] {
  return Object.keys(snapshot.nodes);
}

export type WidgetView = {
  lines: string[];
  layout: "graph" | "compact";
  /** The clamped first visible graph row; feed back in to scroll relatively. */
  scroll: number;
  /** Largest useful scroll value; 0 when the whole graph fits. */
  maxScroll: number;
};

/**
 * Live-progress view for the in-pi widget: a header plus the same boxed
 * graph the standalone viewer draws. When the graph is taller than pi's
 * widget budget, a window is shown with ↑/↓ overflow markers — centered on
 * the active node by default, or at `scroll` when the user scrolled
 * manually. Pure so it can be tested without a TUI.
 */
export function buildWidgetView(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  now: Date = new Date(),
  scroll: number | null = null,
  held = false,
  width = Number.POSITIVE_INFINITY,
): WidgetView {
  const availableWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : width;
  if (availableWidth === 0) return { lines: [], layout: "compact", scroll: 0, maxScroll: 0 };

  // `held` covers pauses the state cannot see yet: an escape-interrupted
  // step or a pause requested while the current node is still finishing.
  const paused = held || state.paused === true;
  const glyph = paused ? "⏸" : STATUS_GLYPHS[state.status];
  const statusText = paused ? "paused" : state.status;
  // Titles, status details, and errors can carry model- or shell-controlled
  // text; never let escape sequences or newlines reach the terminal.
  const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
  const header = `${glyph} workflow ${sanitizeText(state.workflowName)}${title} [${statusText}]`;

  const footer: string[] = [];
  if (state.error) {
    footer.push(`  error: ${truncate(sanitizeText(state.error), 120)}`);
  }
  if (state.status === "waiting" && state.waitingOn) {
    footer.push(`  waiting on checkpoint: ${sanitizeText(state.waitingOn)}`);
  }

  const budget = PI_MAX_WIDGET_LINES - 1 - footer.length;
  const graph = renderGraphLines({ state, snapshot }, state.steps.length - 1, now, {
    nodeStyle: "box",
  });
  if (graph.length > 0) {
    const windowed = windowLines(graph, budget, scroll ?? focusLine(graph, state), scroll !== null);
    const graphLines = windowed.lines.map((line) => `  ${line}`);
    if (graphLines.every((line) => visibleWidth(line) <= availableWidth)) {
      return {
        lines: fitLines([header, ...graphLines, ...footer], availableWidth),
        layout: "graph",
        scroll: windowed.scroll,
        maxScroll: windowed.maxScroll,
      };
    }
  }

  return compactWidgetView(state, snapshot, header, footer, budget, availableWidth, scroll);
}

function compactWidgetView(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  header: string,
  footer: string[],
  budget: number,
  width: number,
  scroll: number | null,
): WidgetView {
  const nodes = displayNodeIds(snapshot).map((nodeId) => compactNodeLine(state, snapshot, nodeId));
  if (nodes.length === 0) {
    return {
      lines: fitLines([header, ...footer], width),
      layout: "compact",
      scroll: 0,
      maxScroll: 0,
    };
  }
  const anchor = scroll ?? compactFocusIndex(state, snapshot);
  const windowed = windowLines(nodes, budget, anchor, scroll !== null);
  return {
    lines: fitLines([header, ...windowed.lines.map((line) => `  ${line}`), ...footer], width),
    layout: "compact",
    scroll: windowed.scroll,
    maxScroll: windowed.maxScroll,
  };
}

function compactFocusIndex(state: WorkflowRunState, snapshot: WorkflowDefinitionSnapshot): number {
  const nodeIds = displayNodeIds(snapshot);
  const focused = state.currentNode ?? state.waitingOn;
  if (focused === undefined) return Math.max(0, nodeIds.length - 1);
  const index = nodeIds.indexOf(focused);
  return index === -1 ? Math.max(0, nodeIds.length - 1) : index;
}

function compactNodeLine(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  nodeId: string,
): string {
  const node = snapshot.nodes[nodeId];
  const type = node?.nodeType === undefined ? "" : ` · ${node.nodeType}`;
  const detail =
    state.currentNode === nodeId && state.statusDetail
      ? ` · ${sanitizeText(state.statusDetail)}`
      : "";
  return `${nodeGlyph(state, nodeId)} ${sanitizeText(nodeId)}${type}${detail}`;
}

function fitLines(lines: string[], width: number): string[] {
  if (!Number.isFinite(width)) return lines;
  return lines.map((line) => truncateToWidth(line, width, width > 1 ? "…" : ""));
}

/** Back-compatible line view following the active node. */
export function buildWidgetLines(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  now: Date = new Date(),
): string[] {
  return buildWidgetView(state, snapshot, now).lines;
}

/** The graph row the window should center on: the active or waiting node. */
function focusLine(graph: string[], state: WorkflowRunState): number {
  const active = graph.findIndex((line) => stripAnsi(line).includes("◐"));
  const focus =
    active !== -1
      ? active
      : state.waitingOn
        ? graph.findIndex((line) => stripAnsi(line).includes(state.waitingOn as string))
        : -1;
  if (focus === -1) {
    return graph.length - 1;
  }
  let top = focus;
  while (top > 0 && !/[┌┏]/u.test(stripAnsi(graph[top] ?? ""))) {
    top -= 1;
  }
  let bottom = focus;
  while (bottom + 1 < graph.length && !/[└┗]/u.test(stripAnsi(graph[bottom] ?? ""))) {
    bottom += 1;
  }
  return Math.floor((top + bottom) / 2);
}

/**
 * Slice `lines` to at most `budget` rows, marking hidden rows at either end.
 * Markers count against the budget. `anchor` is a row to center on (follow
 * mode) or the requested first visible row (manual scroll).
 */
function windowLines(
  lines: string[],
  budget: number,
  anchor: number,
  anchorIsStart: boolean,
): { lines: string[]; scroll: number; maxScroll: number } {
  if (lines.length <= budget) {
    return { lines, scroll: 0, maxScroll: 0 };
  }
  // Reserve one combined overflow row, leaving seven rows for a complete
  // full card even when the widget also has an error footer.
  const inner = Math.max(1, budget - 1);
  const start = clampStart(anchor, inner, lines.length, anchorIsStart);
  const end = start + inner;
  const above = start;
  const below = Math.max(0, lines.length - end);
  const out = lines.slice(start, end);
  const directions = [above > 0 ? `↑ ${above}` : "", below > 0 ? `↓ ${below}` : ""]
    .filter(Boolean)
    .join(" · ");
  out.push(ansi.dim(`${directions} more · shift+↑/↓ scroll`));
  return { lines: out, scroll: start, maxScroll: Math.max(0, lines.length - inner) };
}

function clampStart(anchor: number, inner: number, total: number, anchorIsStart: boolean): number {
  const start = anchorIsStart ? anchor : anchor - Math.floor(inner / 2);
  return Math.max(0, Math.min(start, total - inner));
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
