import type { WorkflowClient } from "../client/client.js";
import { materializeRunView } from "../client/materialize.js";
import { sanitizeText } from "../render/ansi.js";
import type { JsonValue } from "../state/json.js";

const ALT_SCREEN_ON = "\u001b[?1049h\u001b[?25l";
const ALT_SCREEN_OFF = "\u001b[?25h\u001b[?1049l";
const CLEAR = "\u001b[2J\u001b[H";

export type ViewerOptions = {
  client: WorkflowClient;
  runId?: string | undefined;
};

/** Interactive client view. All durable reads stay in the workflow host. */
export async function runViewer(options: ViewerOptions): Promise<void> {
  let value: JsonValue = options.runId === undefined ? [] : null;
  let selected = 0;
  let scroll = 0;
  let mode: "runs" | "run" = options.runId === undefined ? "runs" : "run";
  let unsubscribe: (() => Promise<void>) | undefined;
  let runMaterializationGeneration = 0;

  const draw = () => {
    const width = process.stdout.columns ?? 100;
    const height = Math.max(1, (process.stdout.rows ?? 24) - 1);
    const lines = renderClientView(
      value,
      width,
      height,
      mode === "runs" ? selected : undefined,
      scroll,
    );
    process.stdout.write(`${CLEAR}${lines.join("\n")}`);
  };

  const watchRuns = async () => {
    runMaterializationGeneration += 1;
    await unsubscribe?.();
    mode = "runs";
    scroll = 0;
    unsubscribe = await options.client.watchRuns((event) => {
      value = event.payload;
      selected = Math.min(selected, Math.max(0, arrayLength(value) - 1));
      draw();
    });
  };

  const watchRun = async (runId: string) => {
    runMaterializationGeneration += 1;
    await unsubscribe?.();
    mode = "run";
    scroll = 0;
    unsubscribe = await options.client.watchRun(runId, (event) => {
      const generation = ++runMaterializationGeneration;
      value = event.payload;
      draw();
      void materializeRunView(options.client, event.payload)
        .then((materialized) => {
          if (generation !== runMaterializationGeneration || mode !== "run") return;
          value = materialized;
          draw();
        })
        .catch(() => {
          // A newer revision event retries the complete view from its own stable snapshot.
        });
    });
  };

  process.stdout.write(ALT_SCREEN_ON);
  const rawModeSupported = process.stdin.isTTY === true;
  try {
    if (options.runId === undefined) await watchRuns();
    else await watchRun(options.runId);
    draw();
    if (rawModeSupported) process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise<void>((resolve) => {
      const onKey = (data: Buffer) => {
        const key = data.toString("utf8");
        if (key === "\u0003" || key === "\u001b") {
          resolve();
          return;
        }
        if (key === "q") {
          if (mode === "run" && options.runId === undefined) void watchRuns();
          else resolve();
          return;
        }
        if (mode === "run") {
          const page = Math.max(1, (process.stdout.rows ?? 24) - 2);
          if (key === "\u001b[A" || key === "k") {
            scroll = Math.max(0, scroll - 1);
            draw();
          } else if (key === "\u001b[B" || key === "j") {
            scroll += 1;
            draw();
          } else if (key === "\u001b[5~") {
            scroll = Math.max(0, scroll - page);
            draw();
          } else if (key === "\u001b[6~") {
            scroll += page;
            draw();
          }
        } else if (mode === "runs") {
          if (key === "\u001b[A" || key === "k") {
            selected = Math.max(0, selected - 1);
            draw();
          } else if (key === "\u001b[B" || key === "j") {
            selected = Math.min(Math.max(0, arrayLength(value) - 1), selected + 1);
            draw();
          } else if (key === "\r" || key === "\n") {
            const runId = selectedRunId(value, selected);
            if (runId !== undefined) void watchRun(runId);
          }
        }
      };
      process.stdin.on("data", onKey);
    });
  } finally {
    runMaterializationGeneration += 1;
    await unsubscribe?.();
    if (rawModeSupported) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_SCREEN_OFF);
  }
}

export function renderClientView(
  value: JsonValue,
  width: number,
  height: number,
  selected: number | undefined,
  scroll: number,
): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["No workflow runs found."];
    const selectedIndex = selected ?? 0;
    const start = Math.min(
      Math.max(0, selectedIndex - height + 1),
      Math.max(0, value.length - height),
    );
    return value.slice(start, start + height).map((item, offset) => {
      const index = start + offset;
      const prefix = index === selected ? "> " : "  ";
      return truncate(`${prefix}${summary(item)}`, width);
    });
  }
  const lines = renderRun(value);
  const start = Math.min(scroll, Math.max(0, lines.length - height));
  return lines.slice(start, start + height).map((line) => truncate(line, width));
}

function renderRun(value: JsonValue): string[] {
  if (!isRecord(value) || value.schema !== "pi-workflows.run-view.v1") {
    return JSON.stringify(value, null, 2).split("\n");
  }
  const manifest = isRecord(value.manifest) ? value.manifest : {};
  const state = isRecord(value.state) ? value.state : {};
  const display = isRecord(value.display) ? value.display : {};
  const workflowName =
    typeof manifest.workflowName === "string"
      ? sanitizeText(manifest.workflowName)
      : typeof state.workflowName === "string"
        ? sanitizeText(state.workflowName)
        : "unknown";
  const runId = typeof value.runId === "string" ? sanitizeText(value.runId) : "unknown";
  const status = typeof display.status === "string" ? display.status : "unknown";
  const lines = [
    `workflow ${workflowName}`,
    `${statusGlyph(status)} ${sanitizeText(status)} · run ${runId}`,
  ];
  if (typeof display.reason === "string") lines.push(`reason: ${sanitizeText(display.reason)}`);

  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (steps.length > 0) {
    lines.push("", "steps");
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const nodeId = typeof step.nodeId === "string" ? sanitizeText(step.nodeId) : "unknown";
      const outcome = typeof step.outcome === "string" ? step.outcome : "unknown";
      lines.push(`  ${stepGlyph(outcome)} ${nodeId} · ${sanitizeText(outcome)}`);
    }
  }
  if (status === "completed" && Object.hasOwn(state, "finalOutput")) {
    lines.push("", `output ${JSON.stringify(state.finalOutput)}`);
  } else if (typeof state.error === "string") {
    lines.push("", `error: ${sanitizeText(state.error)}`);
  }
  return lines;
}

function summary(value: JsonValue): string {
  if (!isRecord(value)) return JSON.stringify(value);
  const status = isRecord(value.display) ? value.display.status : undefined;
  const name = typeof value.workflowName === "string" ? value.workflowName : "workflow";
  const runId = typeof value.runId === "string" ? value.runId : "unknown";
  return `${typeof status === "string" ? sanitizeText(status) : "unknown"}  ${sanitizeText(name)}  ${sanitizeText(runId)}`;
}

function statusGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "✗";
  if (status === "paused") return "‖";
  if (status === "waiting") return "○";
  if (status === "queued") return "…";
  if (status === "ambiguous") return "!";
  return "●";
}

function stepGlyph(outcome: string): string {
  return outcome === "ok" ? "✓" : outcome === "failed" || outcome === "timed_out" ? "✗" : "○";
}

function selectedRunId(value: JsonValue, index: number): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const item = value[index];
  return isRecord(item) && typeof item.runId === "string" ? item.runId : undefined;
}

function arrayLength(value: JsonValue): number {
  return Array.isArray(value) ? value.length : 0;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
