import { WorkflowRunStore, type LoadedWorkflowRun } from "../workflows/store.js";
import {
  maxDetailScroll,
  renderRunDetailLines,
  renderRunListLines,
  type ViewportSize,
} from "./render.js";
import { watchStateDatabase } from "./watch.js";

const ALT_SCREEN_ON = "\u001b[?1049h\u001b[?25l";
const ALT_SCREEN_OFF = "\u001b[?25h\u001b[?1049l";
const CLEAR = "\u001b[2J\u001b[H";

type ViewerMode = { view: "list" } | { view: "detail"; runId: string };

export type ViewerOptions = {
  databasePath: string;
  runId?: string | undefined;
  /** Redraw interval for elapsed timers while a run is active. */
  tickMs?: number;
};

function viewportSize(): ViewportSize {
  return {
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
  };
}

/**
 * Interactive live viewer. Watches the SQLite database and re-renders after
 * committed run changes. Returns when the user quits.
 */
export async function runViewer(options: ViewerOptions): Promise<void> {
  const store = new WorkflowRunStore(options.databasePath, { readOnly: true });
  let mode: ViewerMode = { view: "list" };
  let bundles: LoadedWorkflowRun[] = [];
  let selectedIndex = 0;
  let detailScroll = 0;
  /** Replay position; null follows the latest step live. */
  let selectedStep: number | null = null;
  let detailStepCount = 0;

  if (options.runId) {
    bundles = store.listRuns();
    const match = bundles.find((bundle) => bundle.state.runId === options.runId);
    if (!match) {
      throw new Error(`Run not found: ${options.runId}`);
    }
    mode = { view: "detail", runId: match.runId };
  }

  const draw = async () => {
    bundles = store.listRuns();
    selectedIndex = Math.min(selectedIndex, Math.max(0, bundles.length - 1));
    const size = viewportSize();
    const lines =
      mode.view === "list"
        ? renderRunListLines(bundles, selectedIndex, size)
        : await renderDetail(mode.runId, size);
    process.stdout.write(CLEAR + lines.join("\n"));
  };

  const renderDetail = async (runId: string, size: ViewportSize): Promise<string[]> => {
    const bundle = store.readRun(runId, { includeTrace: true });
    if (!bundle) {
      return ["SQLite run state disappeared. Press q to go back."];
    }
    detailStepCount = bundle.state.steps.length;
    if (selectedStep !== null && selectedStep >= detailStepCount - 1) {
      // Scrubbed to (or past) the end: snap back to following live updates.
      selectedStep = null;
    }
    detailScroll = Math.min(detailScroll, maxDetailScroll(bundle, size, selectedStep));
    return renderRunDetailLines(bundle, size, new Date(), detailScroll, selectedStep);
  };

  process.stdout.write(ALT_SCREEN_ON);
  const stopWatching = watchStateDatabase(options.databasePath, () => {
    void draw();
  });
  const ticker = setInterval(() => {
    void draw();
  }, options.tickMs ?? 1_000);

  const rawModeSupported = process.stdin.isTTY === true;
  if (rawModeSupported) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  try {
    await new Promise<void>((resolve) => {
      const onKey = (data: Buffer) => {
        const key = data.toString("utf8");
        if (key === "q" || key === "\u0003" || key === "\u001b") {
          if (mode.view === "detail" && key === "q") {
            mode = { view: "list" };
            void draw();
            return;
          }
          resolve();
          return;
        }
        handleNavigationKey(key);
      };

      const handleNavigationKey = (key: string) => {
        if (mode.view !== "list") {
          if (key === "r") {
            void draw();
          } else if (key === "\u001b[A" || key === "k") {
            detailScroll = Math.max(0, detailScroll - 1);
            void draw();
          } else if (key === "\u001b[B" || key === "j") {
            // Clamped against the content height in renderDetail.
            detailScroll += 1;
            void draw();
          } else if (key === "\u001b[D" || key === "h") {
            const current = selectedStep ?? detailStepCount - 1;
            selectedStep = Math.max(0, current - 1);
            void draw();
          } else if (key === "\u001b[C" || key === "l") {
            // renderDetail snaps back to live once this reaches the end.
            selectedStep = selectedStep === null ? null : selectedStep + 1;
            void draw();
          }
          return;
        }
        if (key === "\u001b[A" || key === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          void draw();
        } else if (key === "\u001b[B" || key === "j") {
          selectedIndex = Math.min(Math.max(0, bundles.length - 1), selectedIndex + 1);
          void draw();
        } else if (key === "\r" || key === "\n") {
          const selected = bundles[selectedIndex];
          if (selected) {
            mode = { view: "detail", runId: selected.runId };
            detailScroll = 0;
            selectedStep = null;
            void draw();
          }
        }
      };

      process.stdin.on("data", onKey);
      void draw();
    });
  } finally {
    clearInterval(ticker);
    stopWatching();
    store.close();
    if (rawModeSupported) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(ALT_SCREEN_OFF);
  }
}
