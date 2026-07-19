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

/**
 * Live-progress lines for the in-pi widget: a header plus the same graph the
 * standalone viewer draws. When the graph is taller than pi's widget budget,
 * a window centered on the active node is shown with ↑/↓ overflow markers.
 * Pure so it can be tested without a TUI.
 */
export function buildWidgetLines(
  state: WorkflowRunState,
  snapshot: WorkflowDefinitionSnapshot,
  now: Date = new Date(),
): string[] {
  const glyph = STATUS_GLYPHS[state.status];
  // Titles, status details, and errors can carry model- or shell-controlled
  // text; never let escape sequences or newlines reach the terminal.
  const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
  const header = `${glyph} workflow ${sanitizeText(state.workflowName)}${title} [${state.status}]`;

  const footer: string[] = [];
  if (state.error) {
    footer.push(`  error: ${truncate(sanitizeText(state.error), 120)}`);
  }
  if (state.status === "waiting" && state.waitingOn) {
    footer.push(`  waiting on checkpoint: ${state.waitingOn}`);
  }

  const budget = PI_MAX_WIDGET_LINES - 1 - footer.length;
  const graph = renderGraphLines({ state, snapshot }, state.steps.length - 1, now);
  const body =
    graph.length > 0
      ? windowAroundFocus(graph, focusLine(graph, state), budget).map((line) => `  ${line}`)
      : [`  ${compactNodeStrip(state, snapshot)}`];

  return [header, ...body, ...footer];
}

/** The graph row the window should center on: the active or waiting node. */
function focusLine(graph: string[], state: WorkflowRunState): number {
  const active = graph.findIndex((line) => stripAnsi(line).includes("◐"));
  if (active !== -1) {
    return active;
  }
  if (state.waitingOn) {
    const waiting = graph.findIndex((line) => stripAnsi(line).includes(state.waitingOn as string));
    if (waiting !== -1) {
      return waiting;
    }
  }
  return graph.length - 1;
}

/**
 * Slice `lines` to at most `budget` rows centered on `focus`, marking hidden
 * rows at either end. Markers count against the budget.
 */
function windowAroundFocus(lines: string[], focus: number, budget: number): string[] {
  if (lines.length <= budget) {
    return lines;
  }
  // First centering pass decides which markers exist; the second recenters
  // within the remaining space. A marker flag can only turn on (never off)
  // in the second pass, so the result stays within budget.
  let inner = budget;
  for (let pass = 0; pass < 2; pass += 1) {
    const start = clampStart(focus, inner, lines.length);
    inner = budget - (start > 0 ? 1 : 0) - (start + inner < lines.length ? 1 : 0);
  }
  const start = clampStart(focus, inner, lines.length);
  const end = start + inner;
  const out: string[] = [];
  if (start > 0) {
    out.push(ansi.dim(`↑ ${start} more`));
  }
  out.push(...lines.slice(start, end));
  if (end < lines.length) {
    out.push(ansi.dim(`↓ ${lines.length - end} more`));
  }
  return out;
}

function clampStart(focus: number, inner: number, total: number): number {
  return Math.max(0, Math.min(focus - Math.floor(inner / 2), total - inner));
}

function compactNodeStrip(state: WorkflowRunState, snapshot: WorkflowDefinitionSnapshot): string {
  return displayNodeIds(snapshot)
    .map((nodeId) => {
      const marker = nodeGlyph(state, nodeId);
      const detail =
        state.currentNode === nodeId && state.statusDetail
          ? ` (${sanitizeText(state.statusDetail)})`
          : "";
      return `${marker} ${nodeId}${detail}`;
    })
    .join("  ");
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
