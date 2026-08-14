import { truncateToWidth } from "@earendil-works/pi-tui";
import { ansi } from "../render/ansi.js";
import { formatDuration } from "../render/format.js";
import { nodeTypeGlyph } from "../render/node-type.js";
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
 * budget and choose which node rows to show instead of losing the bottom.
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
  /** The clamped first visible node row. */
  scroll: number;
  /** Largest useful scroll value; 0 when the whole list fits. */
  maxScroll: number;
};

/**
 * Compact live-progress view for the in-pi widget. It uses one line per node,
 * follows the active node by default, and never returns a line wider than the
 * width supplied by Pi's component renderer.
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
  if (availableWidth === 0) return { lines: [], scroll: 0, maxScroll: 0 };

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
  const nodes = displayNodeIds(snapshot).map((nodeId) =>
    compactNodeLine(state, snapshot, nodeId, now),
  );
  if (nodes.length === 0) {
    return {
      lines: fitLines([header, ...footer], availableWidth),
      scroll: 0,
      maxScroll: 0,
    };
  }

  const anchor = scroll ?? compactFocusIndex(state, snapshot);
  const windowed = windowLines(nodes, budget, anchor, scroll !== null);
  const indentation = availableWidth >= 3 ? "  " : "";
  return {
    lines: fitLines(
      [header, ...windowed.lines.map((line) => `${indentation}${line}`), ...footer],
      availableWidth,
    ),
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
  now: Date,
): string {
  const node = snapshot.nodes[nodeId];
  const type = node ? ansi.dim(nodeTypeGlyph(node.nodeType, node.actionExecution)) : "?";
  const segments = nodeRuntimeSegments(state, snapshot, nodeId, now);
  const detail = segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
  return `${nodeGlyph(state, nodeId)} ${type} ${sanitizeText(nodeId)}${detail}`;
}

function nodeRuntimeSegments(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  nodeId: string,
  now: Date,
): string[] {
  const segments: string[] = [];
  const completedAttempts = state.steps.filter((step) => step.nodeId === nodeId).length;
  const attempts = completedAttempts + (state.currentNode === nodeId ? 1 : 0);
  if (attempts > 1) {
    segments.push(`↻${attempts}`);
  }

  const result = state.results[nodeId];
  if (state.currentNode === nodeId) {
    if (state.statusDetail) {
      segments.push(sanitizeText(state.statusDetail));
    }
    const elapsed = elapsedSince(state.currentNodeStartedAt, now);
    if (elapsed !== null) {
      segments.push(elapsed);
    }
    return segments;
  }

  if (state.waitingOn === nodeId) {
    const summary = snapshot.nodes[nodeId]?.summary;
    segments.push(summary ? sanitizeText(summary) : "waiting");
    return segments;
  }

  if (!result) {
    return segments;
  }
  if (result.outcome !== "ok") {
    segments.push(result.error ? sanitizeText(result.error) : result.outcome.replaceAll("_", " "));
    return segments;
  }
  if (Number.isFinite(result.durationMs)) {
    segments.push(formatDuration(result.durationMs));
  }
  return segments;
}

function elapsedSince(startedAt: string | undefined, now: Date): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  return formatDuration(Math.max(0, now.getTime() - started));
}

function fitLines(lines: string[], width: number): string[] {
  if (!Number.isFinite(width)) return lines;
  return lines.map((line) => truncateToWidth(line, width, width > 1 ? "…" : ""));
}

/** Compact line view following the active node. */
export function buildWidgetLines(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  now: Date = new Date(),
): string[] {
  return buildWidgetView(state, snapshot, now).lines;
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
