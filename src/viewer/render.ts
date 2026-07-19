import type { LoadedRunBundle } from "../workflows/store.js";
import type { WorkflowRunStatus, WorkflowStepRecord } from "../workflows/types.js";
import { ansi, fitWidth, sanitizeText } from "./ansi.js";
import { formatDuration, runElapsedMs } from "./format.js";
import { renderGraphLines } from "./graph-render.js";

export { formatDuration, runElapsedMs };

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

function previewValue(value: unknown, maxLength: number): string {
  if (value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Model-controlled values must not carry escape sequences into the terminal.
  const singleLine = sanitizeText(text ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
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
    const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
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

function stepLine(
  step: WorkflowStepRecord,
  index: number,
  selectedStepIndex: number,
  width: number,
): string {
  const durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  const glyph = step.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
  const marker = index === selectedStepIndex ? ansi.cyan("›") : " ";
  const preview =
    step.error !== undefined
      ? ansi.red(previewValue(step.error, 60))
      : ansi.dim(previewValue(step.output, 60));
  return fitWidth(
    ` ${marker}${glyph} ${step.nodeId} ${ansi.dim(`(${step.nodeType}, ${formatDuration(durationMs)})`)} ${preview}`,
    width,
  );
}

/** Fallback node status list for bundles without a definition snapshot. */
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
    const detail = state.statusDetail ? ` · ${sanitizeText(state.statusDetail)}` : "";
    suffix = ansi.cyan(` running ${formatDuration(now.getTime() - startedAt)}${detail}`);
  } else if (state.waitingOn === nodeId) {
    glyph = ansi.yellow("⏸");
    suffix = ansi.yellow(" waiting");
  } else if (result) {
    glyph = result.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
    suffix = ansi.dim(` ${formatDuration(result.durationMs)}`);
  }
  return fitWidth(`  ${glyph} ${nodeId} ${ansi.dim(`[${nodeType}]`)}${suffix}`, width);
}

/** Pretty-printed JSON body of the selected step for the inspector pane. */
function inspectorLines(step: WorkflowStepRecord, width: number): string[] {
  const lines: string[] = [];
  const body = step.error !== undefined ? step.error : step.output;
  const rendered =
    typeof body === "string" && step.error !== undefined ? body : JSON.stringify(body, null, 2);
  for (const raw of (rendered ?? "null").split("\n")) {
    lines.push(fitWidth(`  ${sanitizeText(raw)}`, width));
  }
  if (step.action) {
    const receipt = [
      step.action.actionType,
      step.action.command,
      ...(step.action.args ?? []),
      step.action.exitCode !== undefined ? `→ exit ${step.action.exitCode}` : "",
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    lines.push(fitWidth(ansi.dim(`  ${sanitizeText(receipt)}`), width));
  }
  return lines;
}

/**
 * Full-run detail view: header, graph pane, step timeline, inspector.
 * `scroll` shifts the viewport down over the full body; `selectedStepIndex`
 * scrubs the replay position (defaults to the latest step, i.e. live).
 */
export function renderRunDetailLines(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  now: Date = new Date(),
  scroll = 0,
  selectedStepIndex: number | null = null,
): string[] {
  const state = bundle.state;
  const steps = state.steps;
  const selected = selectedStepIndex === null ? steps.length - 1 : selectedStepIndex;
  const lines: string[] = [];
  const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
  lines.push(
    fitWidth(`${ansi.bold(`workflow ${sanitizeText(state.workflowName)}`)}${title}`, size.width),
  );
  const position =
    selectedStepIndex === null || steps.length === 0
      ? ""
      : ` · step ${Math.min(selected, steps.length - 1) + 1}/${steps.length}`;
  lines.push(
    fitWidth(
      `${statusLabel(state.status)} · run ${state.runId} · elapsed ${formatDuration(runElapsedMs(state, now))}${position}`,
      size.width,
    ),
  );
  lines.push(ansi.dim("q back · r refresh · ↑/↓ scroll · ←/→ replay steps"));
  lines.push("");

  const graph = renderGraphLines(bundle, selected, now).map((line) => fitWidth(line, size.width));
  if (graph.length > 0) {
    lines.push(...graph);
  } else {
    // No definition snapshot: fall back to a flat executed-node list.
    for (const nodeId of Object.keys(state.results)) {
      lines.push(nodeStatusLine(bundle, nodeId, size.width, now));
    }
  }

  if (steps.length > 0) {
    lines.push("");
    lines.push(ansi.bold("steps"));
    for (const [index, step] of steps.entries()) {
      lines.push(stepLine(step, index, Math.min(selected, steps.length - 1), size.width));
    }
    const inspected = steps[Math.min(Math.max(selected, 0), steps.length - 1)];
    if (inspected) {
      lines.push("");
      lines.push(
        ansi.bold(`step output — ${sanitizeText(inspected.nodeId)} (${inspected.outcome})`),
      );
      lines.push(...inspectorLines(inspected, size.width));
    }
  }

  if (state.error) {
    lines.push("");
    lines.push(fitWidth(ansi.red(`error: ${sanitizeText(state.error)}`), size.width));
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
  const start = Math.max(0, Math.min(scroll, lines.length - size.height));
  return lines.slice(start, start + size.height);
}

/** Highest useful `scroll` value for the detail view of `bundle`. */
export function maxDetailScroll(
  bundle: LoadedRunBundle,
  size: ViewportSize,
  selectedStepIndex: number | null = null,
): number {
  const total = renderRunDetailLines(
    bundle,
    { width: size.width, height: Number.MAX_SAFE_INTEGER },
    new Date(),
    0,
    selectedStepIndex,
  ).length;
  return Math.max(0, total - size.height);
}
