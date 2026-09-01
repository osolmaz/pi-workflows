import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SqliteControllerStore } from "../controllers/sqlite.js";
import { workflowStatePath } from "../state/database.js";
import { WorkflowRunStore, type LoadedWorkflowRun } from "../workflows/store.js";
import { buildWidgetView } from "./widget.js";

const WIDGET_KEY = "pi-workflows";
const WIDGET_SCROLL_STEP = 3;

/** Read-only projection of the host-owned run into the origin Pi session. */
export class SessionWorkflowView {
  private loaded: LoadedWorkflowRun | undefined;
  private scroll: number | null = null;
  private shownScroll = 0;
  private maxScroll = 0;
  private stepCount = 0;
  private visible = false;

  refresh(ctx: ExtensionContext): void {
    const loaded = loadSessionRun(ctx.sessionManager.getSessionId());
    if (loaded === undefined) {
      this.clear(ctx);
      return;
    }
    if (this.loaded?.runId !== loaded.runId || this.stepCount !== loaded.state.steps.length) {
      this.scroll = null;
      this.stepCount = loaded.state.steps.length;
    }
    this.loaded = loaded;
    this.render(ctx);
  }

  scrollUp(ctx: ExtensionContext): void {
    this.scrollBy(ctx, -WIDGET_SCROLL_STEP);
  }

  scrollDown(ctx: ExtensionContext): void {
    this.scrollBy(ctx, WIDGET_SCROLL_STEP);
  }

  clear(ctx: ExtensionContext): void {
    this.loaded = undefined;
    this.scroll = null;
    this.shownScroll = 0;
    this.maxScroll = 0;
    this.stepCount = 0;
    if (!this.visible) return;
    this.visible = false;
    safelyUpdateUi(ctx, () => {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
    });
  }

  private scrollBy(ctx: ExtensionContext, delta: number): void {
    if (this.loaded === undefined) return;
    const current = this.scroll ?? this.shownScroll;
    this.scroll = Math.max(0, Math.min(this.maxScroll, current + delta));
    this.render(ctx);
  }

  private render(ctx: ExtensionContext): void {
    const loaded = this.loaded;
    if (loaded === undefined) return;
    const render = (
      width = Number.POSITIVE_INFINITY,
      theme?: Parameters<typeof buildWidgetView>[6],
    ) => {
      const view = buildWidgetView(
        loaded.state,
        loaded.snapshot,
        new Date(),
        this.scroll,
        loaded.state.paused === true,
        width,
        theme,
        undefined,
      );
      this.shownScroll = view.scroll;
      this.maxScroll = view.maxScroll;
      if (this.scroll !== null) this.scroll = view.scroll;
      return view.lines;
    };
    safelyUpdateUi(ctx, () => {
      if (ctx.mode === "tui") {
        ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
          render: (width) => render(width, theme),
          invalidate() {},
        }));
      } else {
        ctx.ui.setWidget(WIDGET_KEY, render());
      }
      const label = loaded.state.paused === true ? "paused" : loaded.state.status;
      ctx.ui.setStatus(WIDGET_KEY, `${loaded.state.workflowName} [${label}]`);
      this.visible = true;
    });
  }
}

function loadSessionRun(sessionId: string): LoadedWorkflowRun | undefined {
  try {
    const queue = new SqliteControllerStore(workflowStatePath(), {
      readOnly: true,
      global: true,
    });
    let runId: string | undefined;
    try {
      runId = queue.findSessionReservation(sessionId)?.runId;
    } finally {
      queue.close();
    }
    if (runId === undefined) return undefined;

    const runs = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
    try {
      return runs.readRun(runId) ?? undefined;
    } finally {
      runs.close();
    }
  } catch {
    return undefined;
  }
}

function safelyUpdateUi(ctx: ExtensionContext, update: () => void): void {
  try {
    if (ctx.hasUI) update();
  } catch {
    // A session replacement can make a captured context stale between polls.
  }
}
