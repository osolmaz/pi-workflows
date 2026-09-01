import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowSessionView } from "../client/view.js";
import type { WorkflowDefinitionSnapshot, WorkflowRunState } from "../workflows/types.js";
import { buildWidgetView } from "./widget.js";

const WIDGET_KEY = "pi-workflows";
const WIDGET_SCROLL_STEP = 3;

/** Client-backed projection of the host-owned run into the origin Pi session. */
export class SessionWorkflowView {
  private session: WorkflowSessionView | null = null;
  private scroll: number | null = null;
  private shownScroll = 0;
  private maxScroll = 0;
  private stepCount = 0;
  private visible = false;
  private actionHint: string | undefined;

  update(session: WorkflowSessionView, ctx: ExtensionContext): void {
    const run = session.run;
    if (
      run === null ||
      !isWorkflowRunState(run.state) ||
      !isWorkflowDefinitionSnapshot(run.snapshot)
    ) {
      this.session = session;
      this.clearWidget(ctx);
      return;
    }
    const previousRun = this.session?.run;
    if (previousRun?.runId !== run.runId || this.stepCount !== run.state.steps.length) {
      this.scroll = null;
      this.stepCount = run.state.steps.length;
    }
    this.session = session;
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
    this.stepCount = 0;
    this.clearWidget(ctx);
  }

  private scrollBy(ctx: ExtensionContext, delta: number): void {
    if (this.session?.run === null || this.session === null) return;
    const current = this.scroll ?? this.shownScroll;
    this.scroll = Math.max(0, Math.min(this.maxScroll, current + delta));
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
    if (!isWorkflowRunState(run.state) || !isWorkflowDefinitionSnapshot(run.snapshot)) return;
    const state = run.state;
    const snapshot = run.snapshot;
    const render = (
      width = Number.POSITIVE_INFINITY,
      theme?: Parameters<typeof buildWidgetView>[6],
    ) => {
      const view = buildWidgetView(
        state,
        snapshot,
        new Date(),
        this.scroll,
        run.display.status === "paused",
        width,
        theme,
        undefined,
        this.actionHint,
        run.display.status,
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
      ctx.ui.setStatus(WIDGET_KEY, `${state.workflowName} [${run.display.status}]`);
      this.visible = true;
    });
  }
}

function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === "pi-workflows.run-state.v1" &&
    typeof (value as { workflowName?: unknown }).workflowName === "string" &&
    Array.isArray((value as { steps?: unknown }).steps)
  );
}

function isWorkflowDefinitionSnapshot(value: unknown): value is WorkflowDefinitionSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === "pi-workflows.definition-snapshot.v1" &&
    typeof (value as { nodes?: unknown }).nodes === "object"
  );
}

function safelyUpdateUi(ctx: ExtensionContext, update: () => void): void {
  try {
    if (ctx.hasUI) update();
  } catch {
    // A session replacement can make a captured context stale between updates.
  }
}
