import type { LoadedRunBundle } from "../workflows/store.js";
import type {
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from "../workflows/types.js";
import { ansi, fitWidth } from "./ansi.js";

export type ViewportSize = {
  width: number;
  height: number;
};

const STATUS_COLORS: Record<WorkflowRunStatus, (text: string) => string> = {
  running: ansi.cyan,
  waiting: ansi.yellow,
  completed: ansi.green,
  failed: ansi.red,
  timed_out: ansi.red,
  cancelled: ansi.yellow,
};

export function statusLabel(status: WorkflowRunStatus): string {
  return STATUS_COLORS[status](status);
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.max(durationMs, 0)}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

export function runElapsedMs(state: WorkflowRunState, now: Date = new Date()): number {
  const end = state.finishedAt ? Date.parse(state.finishedAt) : now.getTime();
  return Math.max(0, end - Date.parse(state.startedAt));
}

function previewValue(value: unknown, maxLength: number): string {
  if (value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const singleLine = (text ?? "").replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

/** One line per run for the run picker. */
export function renderRunListLines(
  bundles: LoadedRunBundle[],
  selectedIndex: number,
  size: ViewportSize,
  now: Date = new Date(),
): string[] {
  const lines: string[] = [];
  lines.push(ansi.bold("pi-workflows — runs"));
  lines.push(ansi.dim("↑/↓ select · enter open · q quit"));
  lines.push("");
  if (bundles.length === 0) {
    lines.push(ansi.dim("No workflow runs found."));
    return lines.map((line) => fitWidth(line, size.width));
  }
  const visible = Math.max(1, size.height - lines.length - 1);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(visible / 2)),
    Math.max(0, bundles.length - visible),
  );
  for (const [offset, bundle] of bundles.slice(start, start + visible).entries()) {
    const index = start + offset;
    const state = bundle.state;
    const marker = index === selectedIndex ? ansi.cyan("›") : " ";
    const elapsed = formatDuration(runElapsedMs(state, now));
    const title = state.runTitle ? ` — ${state.runTitle}` : "";
    lines.push(
      fitWidth(
        `${marker} ${statusLabel(state.status)}  ${ansi.bold(state.workflowName)}${title}  ${ansi.dim(
          `${state.runId} · ${elapsed}`,
        )}`,
        size.width,
      ),
    );
  }
  return lines;
}

function stepLine(step: WorkflowStepRecord, width: number): string {
  const durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  const glyph = step.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
  const preview =
    step.error !== undefined
      ? ansi.red(previewValue(step.error, 60))
      : ansi.dim(previewValue(step.output, 60));
  return fitWidth(
    `  ${glyph} ${step.nodeId} ${ansi.dim(`(${step.nodeType}, ${formatDuration(durationMs)})`)} ${preview}`,
    width,
  );
}

function nodeStatusLine(bundle: LoadedRunBundle, nodeId: string, width: number, now: Date): string {
  const state = bundle.state;
  const nodeType = bundle.snapshot?.nodes[nodeId]?.nodeType ?? "?";
  const result = state.results[nodeId];
  let glyph = ansi.dim("·");
  let suffix = "";
  if (state.currentNode === nodeId) {
    glyph = ansi.cyan("◐");
    const startedAt = state.currentNodeStartedAt
      ? Date.parse(state.currentNodeStartedAt)
      : now.getTime();
    suffix = ansi.cyan(` running ${formatDuration(now.getTime() - startedAt)}`);
  } else if (state.waitingOn === nodeId) {
    glyph = ansi.yellow("⏸");
    suffix = ansi.yellow(" waiting");
  } else if (result) {
    glyph = result.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
    suffix = ansi.dim(` ${formatDuration(result.durationMs)}`);
  }
  return fitWidth(`  ${glyph} ${nodeId} ${ansi.dim(`[${nodeType}]`)}${suffix}`, width);
}

/** Full-run detail view. */
export function renderRunDetailLines(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  now: Date = new Date(),
): string[] {
  const state = bundle.state;
  const lines: string[] = [];
  const title = state.runTitle ? ` — ${state.runTitle}` : "";
  lines.push(fitWidth(`${ansi.bold(`workflow ${state.workflowName}`)}${title}`, size.width));
  lines.push(
    fitWidth(
      `${statusLabel(state.status)} · run ${state.runId} · elapsed ${formatDuration(runElapsedMs(state, now))}`,
      size.width,
    ),
  );
  lines.push(ansi.dim("q back · r refresh"));
  lines.push("");

  lines.push(ansi.bold("nodes"));
  const nodeIds = bundle.snapshot ? Object.keys(bundle.snapshot.nodes) : Object.keys(state.results);
  for (const nodeId of nodeIds) {
    lines.push(nodeStatusLine(bundle, nodeId, size.width, now));
  }

  if (state.steps.length > 0) {
    lines.push("");
    lines.push(ansi.bold("steps"));
    for (const step of state.steps) {
      lines.push(stepLine(step, size.width));
    }
  }

  if (state.error) {
    lines.push("");
    lines.push(fitWidth(ansi.red(`error: ${state.error}`), size.width));
  }
  if (state.status === "completed" && state.finalOutput !== undefined) {
    lines.push("");
    lines.push(
      fitWidth(
        `${ansi.bold("output")} ${previewValue(state.finalOutput, size.width - 8)}`,
        size.width,
      ),
    );
  }
  return lines.slice(0, size.height);
}
