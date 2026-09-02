import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowSessionView } from "../client/view.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunState,
  WorkflowUpdateRecord,
} from "../workflows/types.js";
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
  private lastNoticeKey: string | null = null;

  update(session: WorkflowSessionView, ctx: ExtensionContext): void {
    const run = session.run;
    if (
      run === null ||
      !isWorkflowRunState(run.state) ||
      !isWorkflowDefinitionSnapshot(run.workflow)
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
    this.notifyTransition(previousRun, session, ctx);
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
    this.lastNoticeKey = null;
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
    if (!isWorkflowRunState(run.state) || !isWorkflowDefinitionSnapshot(run.workflow)) return;
    const state = run.state;
    const snapshot = run.workflow;
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
        workflowUpdates(run.updates),
        this.actionHint,
        run.display.status,
        run.display.reason,
        run.display.controls,
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
      const focus = state.currentNode ?? state.waitingOn;
      ctx.ui.setStatus(
        WIDGET_KEY,
        `${state.workflowName} [${run.display.status}]${focus === undefined ? "" : ` ${focus}`}`,
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
    if (run === null || !isWorkflowRunState(run.state)) return;
    const status = run.display.status;
    const decision = session.pendingInteractions.some(
      (value) => isRecord(value) && value.kind === "decision" && value.status === "pending",
    );
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
      ? `Workflow ${run.state.workflowName} needs a human decision.`
      : reason && reason.length > 0
        ? reason
        : `Workflow ${run.state.workflowName} ${status.replace("_", " ")}.`;
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

function workflowUpdates(values: readonly unknown[]): WorkflowUpdateRecord[] {
  return values.filter(isWorkflowUpdateRecord);
}

function isWorkflowUpdateRecord(value: unknown): value is WorkflowUpdateRecord {
  return (
    isRecord(value) &&
    typeof value.updateId === "string" &&
    typeof value.seq === "number" &&
    typeof value.at === "string" &&
    typeof value.runId === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.type === "string" &&
    typeof value.key === "string" &&
    isRecord(value.data)
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

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "ambiguous"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safelyUpdateUi(ctx: ExtensionContext, update: () => void): void {
  try {
    if (ctx.hasUI) update();
  } catch {
    // A session replacement can make a captured context stale between updates.
  }
}
