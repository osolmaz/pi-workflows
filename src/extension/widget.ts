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
 * Widgets taller than this fall back to the compact one-line node strip so a
 * large workflow cannot crowd out the conversation.
 */
const MAX_GRAPH_LINES = 24;

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
 * standalone viewer draws, following the latest step. Pure so it can be
 * tested without a TUI.
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

  const graph = renderGraphLines({ state, snapshot }, state.steps.length - 1, now);
  const body =
    graph.length > 0 && graph.length <= MAX_GRAPH_LINES
      ? graph.map((line) => `  ${line}`)
      : [`  ${compactNodeStrip(state, snapshot)}`];

  const lines = [header, ...body];
  if (state.error) {
    lines.push(`  error: ${truncate(sanitizeText(state.error), 120)}`);
  }
  if (state.status === "waiting" && state.waitingOn) {
    lines.push(`  waiting on checkpoint: ${state.waitingOn}`);
  }
  return lines;
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
