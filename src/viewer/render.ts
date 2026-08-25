import { ansi, fitWidth, sanitizeText } from "../render/ansi.js";
import { formatDuration, runElapsedMs } from "../render/format.js";
import { renderGraphLines } from "../render/graph-render.js";
import {
  decisionDocumentSegments,
  decisionPresentationFingerprint,
  humanDecisionChannelRequest,
} from "../workflows/decision-presentation.js";
import {
  formatProgressLine,
  progressRecordsFromTrace,
  progressTracksFromRecords,
} from "../workflows/progress.js";
import type { LoadedWorkflowRun } from "../workflows/store.js";
import type {
  HumanDecisionRequest,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from "../workflows/types.js";

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

function previewValue(rawValue: unknown, maxLength: number): string {
  if (rawValue === undefined) {
    return "";
  }
  const value = rawValue;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Model-controlled values must not carry escape sequences into the terminal.
  const singleLine = sanitizeText(text ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

/** One line per run for the run picker. */
export function renderRunListLines(
  bundles: LoadedWorkflowRun[],
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
  const settings =
    step.settingsChangeNumber === undefined ? "" : `, settings ${step.settingsChangeNumber}`;
  return fitWidth(
    ` ${marker}${glyph} ${step.nodeId} ${ansi.dim(`(${step.nodeType}, ${formatDuration(durationMs)}${settings})`)} ${preview}`,
    width,
  );
}

/** Fallback node status list for bundles without a definition snapshot. */
function nodeStatusLine(
  bundle: LoadedWorkflowRun,
  nodeId: string,
  width: number,
  now: Date,
): string {
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
    const human = bundle.snapshot?.nodes[nodeId]?.humanDecision;
    const request = humanDecisionRequest(state.finalOutput);
    const requestAudience = request?.audience ?? human?.audience;
    suffix = ansi.yellow(
      human === undefined
        ? " waiting"
        : ` waiting for human · ${sanitizeText(requestAudience ?? "operator")}${request === null ? "" : ` · ${sanitizeText(request.presentation.summary)}`} · ${Object.values(
            human.choices,
          )
            .map((choice) => sanitizeText(choice.label))
            .join(
              " / ",
            )}${request === null ? "" : ` · ${request.presentationDigest.slice(7, 19)}`}`,
    );
  } else if (result) {
    glyph = result.outcome === "ok" ? ansi.green("✓") : ansi.red("✗");
    const human = bundle.snapshot?.nodes[nodeId]?.humanDecision;
    const accepted = state.humanDecision;
    const selected =
      human !== undefined && accepted !== undefined && accepted.nodeId === nodeId
        ? human.choices[accepted.response.choice]
        : undefined;
    suffix = ansi.dim(
      ` ${formatDuration(result.durationMs)}${selected === undefined ? "" : ` · human: ${sanitizeText(selected.label)}`}`,
    );
  }
  return fitWidth(`  ${glyph} ${nodeId} ${ansi.dim(`[${nodeType}]`)}${suffix}`, width);
}

/** Pretty-printed JSON body of the selected step for the inspector pane. */
function inspectorLines(step: WorkflowStepRecord, width: number): string[] {
  const lines: string[] = [];
  const request = step.error === undefined ? humanDecisionRequest(step.output) : null;
  if (request !== null) {
    const channelRequest = humanDecisionChannelRequest(request);
    for (const segment of decisionDocumentSegments(channelRequest)) {
      for (const raw of segment.text.split("\n")) {
        lines.push(fitWidth(`  ${sanitizeText(raw)}`, width));
      }
      lines.push("");
    }
    lines.push(
      fitWidth(ansi.dim(`  decision ${decisionPresentationFingerprint(channelRequest)}`), width),
    );
    return lines;
  }
  const body = step.error !== undefined ? step.error : step.output;
  const rendered =
    typeof body === "string" && step.error !== undefined ? body : JSON.stringify(body, null, 2);
  for (const raw of (rendered ?? "null").split("\n")) {
    lines.push(fitWidth(`  ${sanitizeText(raw)}`, width));
  }
  if (step.settingsScopeId !== undefined) {
    lines.push(
      fitWidth(
        ansi.dim(
          `  settings ${step.settingsChangeNumber ?? 0} · ${sanitizeText(step.settingsScopeId)} · ${step.settingsHash?.slice(0, 12) ?? "unknown hash"}`,
        ),
        width,
      ),
    );
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

function humanDecisionRequest(value: unknown): HumanDecisionRequest | null {
  if (value === null || typeof value !== "object") return null;
  const schema = (value as { schema?: unknown }).schema;
  return schema === "pi-workflows.human-decision-request.v1"
    ? (value as HumanDecisionRequest)
    : null;
}

/**
 * Full-run detail view: header, graph pane, step timeline, inspector.
 * `scroll` shifts the viewport down over the full body; `selectedStepIndex`
 * scrubs the replay position (defaults to the latest step, i.e. live).
 */
export function renderRunDetailLines(
  bundle: LoadedWorkflowRun,
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
  const paused = state.paused ? ` · ${ansi.yellow("paused")}` : "";
  lines.push(
    fitWidth(
      `${statusLabel(state.status)}${paused} · run ${state.runId} · elapsed ${formatDuration(runElapsedMs(state, now))}${position}`,
      size.width,
    ),
  );
  lines.push(ansi.dim("q back · r refresh · ↑/↓ scroll · ←/→ replay steps"));
  lines.push("");

  const graph = renderGraphLines(bundle, selected, now, { nodeStyle: "box" }).map((line) =>
    fitWidth(line, size.width),
  );
  if (graph.length > 0) {
    lines.push(...graph);
  } else {
    // No definition snapshot: fall back to a flat executed-node list.
    for (const nodeId of Object.keys(state.results)) {
      lines.push(nodeStatusLine(bundle, nodeId, size.width, now));
    }
  }

  const progressRecords =
    bundle.traceEvents === undefined
      ? (state.updates ?? []).filter((update) => update.type === "progress")
      : progressRecordsFromTrace(bundle.traceEvents);
  const progress = progressTracksFromRecords(progressRecords, now);
  if (progress.length > 0) {
    lines.push("");
    lines.push(ansi.bold("progress"));
    for (const track of progress) {
      const depth = track.key.startsWith("agents/") ? track.key.split("/").length - 2 : 0;
      const indentation = "  ".repeat(Math.max(0, depth));
      lines.push(fitWidth(`${indentation}${formatProgressLine(track.estimate, now)}`, size.width));
      const latest = track.samples.at(-1);
      lines.push(
        fitWidth(
          ansi.dim(
            `${indentation}  ${track.estimate.sampleCount} samples · ${track.estimate.confidence ?? "no"} confidence · updated ${latest?.at ?? "unknown"}`,
          ),
          size.width,
        ),
      );
    }
  }

  if ((bundle.settingsScopes?.length ?? 0) > 0) {
    lines.push("");
    lines.push(ansi.bold("workflow settings"));
    for (const scope of bundle.settingsScopes ?? []) {
      lines.push(
        fitWidth(
          `  ${sanitizeText(scope.mountPath || "root")} #${scope.invocation} · change ${scope.changeNumber} · ${scope.settingsHash.slice(0, 12)}`,
          size.width,
        ),
      );
    }
  }

  if ((bundle.followUpQueue?.followUps.length ?? 0) > 0) {
    lines.push("");
    lines.push(
      ansi.bold(
        `follow-ups · presentation ${bundle.followUpQueue?.presentationState ?? "unknown"}`,
      ),
    );
    for (const followUp of bundle.followUpQueue?.followUps ?? []) {
      lines.push(
        fitWidth(
          `  ${followUp.order}. ${followUp.state} · ${followUp.followUpId} · ${sanitizeText(followUp.source)}`,
          size.width,
        ),
      );
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
  bundle: LoadedWorkflowRun,
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
