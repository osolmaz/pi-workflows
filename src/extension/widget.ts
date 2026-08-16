import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "../render/format.js";
import { nodeTypeGlyph } from "../render/node-type.js";
import {
  estimateProgress,
  formatProgressLine,
  formatRemaining,
  progressTracksFromRecords,
  type ProgressEstimate,
} from "../workflows/progress.js";
import { sanitizeText } from "../workflows/text.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowUpdateRecord,
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
const MAX_NODE_ERROR_CHARS = 120;

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

export type WidgetTheme = Pick<Theme, "bold" | "fg">;

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
  theme?: WidgetTheme,
  updateHistory?: WorkflowUpdateRecord[],
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
  const headerTone = statusTone(paused ? "waiting" : state.status);
  const header = `${paint(theme, headerTone, glyph)} workflow ${sanitizeText(state.workflowName)}${title} ${paint(theme, headerTone, `[${statusText}]`)}`;

  const footer: string[] = [];
  if (state.error) {
    footer.push(paint(theme, "error", `  error: ${truncate(sanitizeText(state.error), 120)}`));
  }
  if (state.status === "waiting" && state.waitingOn) {
    footer.push(
      paint(theme, "warning", `  waiting on checkpoint: ${sanitizeText(state.waitingOn)}`),
    );
  }

  const progress = progressLines(state, now, updateHistory).slice(0, 4);
  const budget = PI_MAX_WIDGET_LINES - 1 - footer.length - progress.length;
  const nodes = displayNodeIds(snapshot).map((nodeId) =>
    compactNodeLine(state, snapshot, nodeId, now, paused, theme),
  );
  if (nodes.length === 0 || budget <= 0) {
    return {
      lines: fitLines(
        [header, ...progress, ...footer].slice(0, PI_MAX_WIDGET_LINES),
        availableWidth,
      ),
      scroll: 0,
      maxScroll: 0,
    };
  }

  const anchor = scroll ?? compactFocusIndex(state, snapshot);
  const windowed = windowLines(nodes, budget, anchor, scroll !== null, theme);
  const indentation = availableWidth >= 3 ? "  " : "";
  return {
    lines: fitLines(
      [
        header,
        ...windowed.lines.map((line) => `${indentation}${line}`),
        ...progress.map((line) => `${indentation}${line}`),
        ...footer,
      ],
      availableWidth,
    ),
    scroll: windowed.scroll,
    maxScroll: windowed.maxScroll,
  };
}

function progressLines(
  state: WorkflowRunState,
  now: Date,
  updateHistory?: WorkflowUpdateRecord[],
): string[] {
  const measured =
    updateHistory === undefined
      ? undefined
      : progressTracksFromRecords(updateHistory, now).map((track) => track.estimate);
  const estimates =
    monitorEstimates(state) ??
    (measured !== undefined && measured.length > 0
      ? measured
      : latestProgressEstimates(state, now));
  const lines = estimates.map((estimate) => formatProgressLine(estimate, now));
  const schedule = (state.updates ?? []).find(
    (record) => record.type === "monitor.schedule" && record.key === "next-check",
  );
  if (schedule !== undefined && typeof schedule.data.nextCheckAt === "string") {
    const next = Date.parse(schedule.data.nextCheckAt);
    if (Number.isFinite(next)) {
      const age = Math.max(0, now.getTime() - Date.parse(schedule.at));
      lines.push(
        `Last update ${formatRemaining(age)} ago  next check ${formatRemaining(next - now.getTime())}`,
      );
    }
  }
  return lines;
}

function monitorEstimates(state: WorkflowRunState): ProgressEstimate[] | undefined {
  const output = state.outputs.estimate;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const tracks = (output as { tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) return undefined;
  const estimates = tracks
    .map((track) =>
      track !== null && typeof track === "object" && !Array.isArray(track)
        ? (track as { estimate?: ProgressEstimate }).estimate
        : undefined,
    )
    .filter((estimate): estimate is ProgressEstimate => estimate !== undefined);
  return estimates.length > 0 ? estimates : undefined;
}

function latestProgressEstimates(state: WorkflowRunState, now: Date): ProgressEstimate[] {
  const estimates: ProgressEstimate[] = [];
  for (const record of state.updates ?? []) {
    if (record.type !== "progress") continue;
    try {
      estimates.push(
        estimateProgress(record.key, [{ at: record.at, data: record.data as never }], now),
      );
    } catch {
      // A malformed historical update must not break the workflow widget.
    }
  }
  return estimates;
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
  paused: boolean,
  theme?: WidgetTheme,
): string {
  const node = snapshot.nodes[nodeId];
  const glyph = nodeGlyph(state, nodeId);
  const typeGlyph = node ? nodeTypeGlyph(node.nodeType, node.actionExecution) : "?";
  const name = sanitizeText(nodeId);
  const segments = nodeRuntimeSegments(state, snapshot, nodeId, now);
  const isCurrent = state.currentNode === nodeId;
  const isWaiting = state.waitingOn === nodeId;

  if (isCurrent || isWaiting) {
    const tone = paused || isWaiting ? "warning" : "accent";
    const focusedName = theme ? theme.bold(name) : name;
    const detail = segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
    return paint(theme, tone, `${glyph} ${typeGlyph} ${focusedName}${detail}`);
  }

  const result = state.results[nodeId];
  if (!result) {
    const detail = segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
    return paint(theme, "dim", `${glyph} ${typeGlyph} ${name}${detail}`);
  }

  const styledGlyph = paint(theme, result.outcome === "ok" ? "success" : "error", glyph);
  const styledType = paint(theme, "dim", typeGlyph);
  const styledSegments = segments.map((segment, index) =>
    paint(
      theme,
      result.outcome !== "ok" && index === segments.length - 1 ? "error" : "dim",
      segment,
    ),
  );
  const detail = styledSegments.length > 0 ? ` · ${styledSegments.join(" · ")}` : "";
  return `${styledGlyph} ${styledType} ${name}${detail}`;
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
    segments.push(
      result.error
        ? truncate(sanitizeText(result.error), MAX_NODE_ERROR_CHARS)
        : result.outcome.replaceAll("_", " "),
    );
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

function statusTone(status: WorkflowRunStatus): ThemeColor {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "timed_out":
    case "cancelled":
      return "error";
    case "waiting":
      return "warning";
    case "running":
      return "accent";
  }
}

function paint(theme: WidgetTheme | undefined, color: ThemeColor, text: string): string {
  return theme ? theme.fg(color, text) : text;
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
  theme?: WidgetTheme,
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
  out.push(paint(theme, "dim", `${directions} more · shift+↑/↓ scroll`));
  return { lines: out, scroll: start, maxScroll: Math.max(0, lines.length - inner) };
}

function clampStart(anchor: number, inner: number, total: number, anchorIsStart: boolean): number {
  const start = anchorIsStart ? anchor : anchor - Math.floor(inner / 2);
  return Math.max(0, Math.min(start, total - inner));
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
