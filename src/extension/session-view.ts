import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowSessionView } from "../client/view.js";
import { widgetRunInput } from "./session-run-adapter.js";
import { buildWidgetView } from "./widget.js";

const WIDGET_KEY = "pi-workflows";
const WIDGET_SCROLL_STEP = 3;

/** Client-backed projection of the server-owned run into the origin Pi session. */
export class SessionWorkflowView {
  private session: WorkflowSessionView | null = null;
  private scroll: number | null = null;
  private shownScroll = 0;
  private maxScroll = 0;
  private focus: string | undefined;
  private staleReason: string | null = null;
  private visible = false;
  private actionHint: string | undefined;
  private lastNoticeKey: string | null = null;
  private pageNodes: ((cursor: number | null) => Promise<void> | void) | undefined;
  /** Window the widget already asked for, so repeated key presses ask once. */
  private requestedNodeCursor: number | null = null;

  /** `scrollHint` is the effective scroll key label resolved from the configuration file. */
  constructor(private readonly scrollHint?: string) {}

  /**
   * Serve a node window that starts at `cursor`. The session view holds one
   * bounded window, so scrolling past an edge asks the server for the adjacent
   * window instead of keeping the complete node history.
   */
  setNodePager(pageNodes: (cursor: number | null) => Promise<void> | void): void {
    this.pageNodes = pageNodes;
  }

  update(session: WorkflowSessionView, ctx: ExtensionContext): void {
    const run = session.run;
    if (run === null) {
      this.session = session;
      this.clearWidget(ctx);
      return;
    }
    const previousRun = this.session?.run;
    const focus = run.currentNode ?? run.waitingOn ?? undefined;
    if (previousRun?.runId !== run.runId || this.focus !== focus) {
      this.scroll = null;
      this.focus = focus;
      // A new run follows its own focus again, so the next request is new too.
      if (previousRun?.runId !== run.runId) this.requestedNodeCursor = null;
    }
    this.session = session;
    this.staleReason = null;
    this.notifyTransition(previousRun, session, ctx);
    this.render(ctx);
  }

  /**
   * Keep the last view for display while the connection is lost. Every state
   * change needs a fresh snapshot, so this view no longer authorizes commands.
   */
  markStale(message: string, ctx: ExtensionContext): void {
    if (this.session === null) return;
    this.staleReason = message;
    this.render(ctx);
  }

  setActionHint(hint: string | undefined, ctx: ExtensionContext): void {
    this.actionHint = hint;
    if (this.session?.run !== null) this.render(ctx);
  }

  refresh(ctx: ExtensionContext): void {
    if (this.session?.run === null || this.session === null) {
      this.clearWidget(ctx);
      return;
    }
    this.render(ctx);
  }

  scrollUp(ctx: ExtensionContext): void {
    this.scrollBy(ctx, -WIDGET_SCROLL_STEP);
  }

  scrollDown(ctx: ExtensionContext): void {
    this.scrollBy(ctx, WIDGET_SCROLL_STEP);
  }

  clear(ctx: ExtensionContext): void {
    this.session = null;
    this.scroll = null;
    this.shownScroll = 0;
    this.maxScroll = 0;
    this.focus = undefined;
    this.staleReason = null;
    this.lastNoticeKey = null;
    this.requestedNodeCursor = null;
    this.clearWidget(ctx);
  }

  /**
   * Ask for one node window. A failed request stays retryable, so the same edge
   * can ask again instead of leaving the loaded window stuck.
   */
  private requestWindow(cursor: number): void {
    this.requestedNodeCursor = cursor;
    const asked = this.pageNodes?.(cursor) as Promise<void> | void;
    if (asked === undefined || typeof asked.then !== "function") return;
    void asked.catch(() => {
      if (this.requestedNodeCursor === cursor) this.requestedNodeCursor = null;
    });
  }

  private scrollBy(ctx: ExtensionContext, delta: number): void {
    const run = this.session?.run;
    if (this.session === null || run === null || run === undefined) return;
    const current = this.scroll ?? this.shownScroll;
    const next = Math.max(0, Math.min(this.maxScroll, current + delta));
    // Scrolling past an edge of the loaded window asks for the adjacent window.
    // Down shows the top of the next window, which continues where the last one
    // ended. Up shows the bottom of the previous window, where the user was.
    const end = run.nodeStart + run.nodes.length;
    if (delta > 0 && next >= this.maxScroll && end < run.nodeTotal) {
      if (this.requestedNodeCursor !== end) {
        this.scroll = 0;
        this.requestWindow(end);
      }
      return;
    }
    if (delta < 0 && next <= 0 && run.nodeStart > 0) {
      const start = Math.max(0, run.nodeStart - run.nodes.length);
      if (this.requestedNodeCursor !== start) {
        this.scroll = Number.MAX_SAFE_INTEGER;
        this.requestWindow(start);
      }
      return;
    }
    this.scroll = next;
    this.render(ctx);
  }

  private clearWidget(ctx: ExtensionContext): void {
    if (!this.visible) return;
    this.visible = false;
    safelyUpdateUi(ctx, () => {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
    });
  }

  private render(ctx: ExtensionContext): void {
    const run = this.session?.run;
    if (run === null || run === undefined) return;
    const input = widgetRunInput(run);
    const render = (
      width = Number.POSITIVE_INFINITY,
      theme?: Parameters<typeof buildWidgetView>[6],
    ) => {
      const view = buildWidgetView(
        input.state,
        input.snapshot,
        new Date(),
        this.scroll,
        run.display.status === "paused",
        width,
        theme,
        input.updates,
        this.actionHint,
        run.display.status,
        this.staleReason ?? run.display.reason,
        run.display.controls,
        this.scrollHint,
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
      const focus = run.currentNode ?? run.waitingOn;
      ctx.ui.setStatus(
        WIDGET_KEY,
        `${run.workflowName} [${run.display.status}]${focus === null ? "" : ` ${focus}`}${this.staleReason === null ? "" : " · stale"}`,
      );
      this.visible = true;
    });
  }

  private notifyTransition(
    previousRun: WorkflowSessionView["run"] | undefined,
    session: WorkflowSessionView,
    ctx: ExtensionContext,
  ): void {
    const run = session.run;
    if (run === null) return;
    const status = run.display.status;
    const decision = session.interaction?.kind === "decision";
    const shouldNotify =
      isTerminalStatus(status) ||
      (status === "waiting" && (decision || previousRun?.display.status !== "waiting")) ||
      (status === "paused" && previousRun?.display.status !== "paused");
    if (!shouldNotify) return;
    const key = `${run.runId}:${status}:${decision ? "decision" : "workflow"}`;
    if (key === this.lastNoticeKey) return;
    this.lastNoticeKey = key;
    const reason = run.display.reason?.trim();
    const message = decision
      ? `Workflow ${run.workflowName} needs a human decision.`
      : reason && reason.length > 0
        ? reason
        : `Workflow ${run.workflowName} ${status.replace("_", " ")}.`;
    safelyUpdateUi(ctx, () => {
      ctx.ui.notify(
        message,
        status === "failed" || status === "timed_out" || status === "ambiguous"
          ? "error"
          : status === "waiting" || status === "paused"
            ? "warning"
            : "info",
      );
    });
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "ambiguous"
  );
}

function safelyUpdateUi(ctx: ExtensionContext, update: () => void): void {
  try {
    if (ctx.hasUI) update();
  } catch {
    // A session replacement can make a captured context stale between updates.
  }
}
