import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowEngine } from "../workflows/engine.js";
import { errorMessage } from "../workflows/errors.js";
import { discoverWorkflows, loadWorkflowFile, resolveWorkflowRef } from "../workflows/loader.js";
import { createDefinitionSnapshot } from "../workflows/store.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowRunResult,
  WorkflowRunState,
} from "../workflows/types.js";
import { ConversationStepExecutor } from "./executor.js";
import { buildWidgetView } from "./widget.js";

const WIDGET_KEY = "pi-workflows";
const FINAL_WIDGET_TTL_MS = 60_000;
const WIDGET_SCROLL_STEP = 3;

type ActiveRun = {
  runId: string | null;
  workflowName: string;
  engine: WorkflowEngine;
  executor: ConversationStepExecutor;
  snapshot: WorkflowDefinitionSnapshot;
  lastState: WorkflowRunState | null;
};

export type ParsedWorkflowArgs =
  | { kind: "list" }
  | { kind: "cancel" }
  | { kind: "run"; ref: string; input: unknown };

/** Parse `/workflow` arguments. Exported for tests. */
export function parseWorkflowArgs(args: string): ParsedWorkflowArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { kind: "list" };
  }
  if (trimmed === "cancel") {
    return { kind: "cancel" };
  }
  const spaceIndex = trimmed.search(/\s/);
  const ref = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  // Match the option as a complete token so task text such as
  // "--input-jsonschema help" is not misparsed as the JSON option.
  const inputJsonMatch = rest.match(/^--input-json(?:\s+|$)([\s\S]*)$/);
  if (inputJsonMatch) {
    const json = (inputJsonMatch[1] as string).trim();
    if (!json) {
      throw new Error("--input-json requires a JSON value");
    }
    return { kind: "run", ref, input: JSON.parse(json) as unknown };
  }
  return { kind: "run", ref, input: rest.length > 0 ? { task: rest } : {} };
}

type WidgetSource = {
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot;
};

export default function piWorkflows(pi: ExtensionAPI) {
  let activeRun: ActiveRun | null = null;
  let widgetTimer: NodeJS.Timeout | null = null;
  let widgetTicker: NodeJS.Timeout | null = null;
  // Manual widget scroll: null follows the active node; a number is the
  // first visible graph row, set by shift+↑/↓ and reset on step advance.
  let widgetSource: WidgetSource | null = null;
  let widgetScroll: number | null = null;
  let widgetShownScroll = 0;
  let widgetMaxScroll = 0;
  let widgetStepCount = 0;

  // UI updates are best-effort: a captured ctx becomes stale after session
  // replacement or shutdown, and pi throws on any access (even `ctx.hasUI`).
  // A workflow finishing right as the session goes away must not crash pi.
  const notify = (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => {
    try {
      if (ctx.hasUI) {
        ctx.ui.notify(message, type);
      }
    } catch {
      // Stale ctx; the notification has nowhere to go.
    }
  };

  const setWidget = (ctx: ExtensionContext, lines: string[] | undefined) => {
    try {
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, lines);
      }
    } catch {
      // Stale ctx; the widget no longer exists.
    }
  };

  const renderWidget = (ctx: ExtensionContext) => {
    if (!widgetSource) {
      return;
    }
    const view = buildWidgetView(
      widgetSource.state,
      widgetSource.snapshot,
      new Date(),
      widgetScroll,
    );
    widgetShownScroll = view.scroll;
    widgetMaxScroll = view.maxScroll;
    if (widgetScroll !== null) {
      widgetScroll = view.scroll;
    }
    setWidget(ctx, view.lines);
  };

  const updateWidget = (
    ctx: ExtensionContext,
    state: WorkflowRunState,
    snapshot: WorkflowDefinitionSnapshot,
  ) => {
    if (state.steps.length !== widgetStepCount) {
      widgetStepCount = state.steps.length;
      // The workflow moved on; resume following the active node.
      widgetScroll = null;
    }
    widgetSource = { state, snapshot };
    renderWidget(ctx);
  };

  const clearWidget = (ctx: ExtensionContext) => {
    widgetSource = null;
    widgetScroll = null;
    setWidget(ctx, undefined);
  };

  const scrollWidget = (ctx: ExtensionContext, delta: number) => {
    if (!widgetSource || widgetMaxScroll === 0) {
      return;
    }
    widgetScroll = Math.max(0, Math.min(widgetShownScroll + delta, widgetMaxScroll));
    renderWidget(ctx);
  };

  const clearWidgetTimer = () => {
    if (widgetTimer) {
      clearTimeout(widgetTimer);
      widgetTimer = null;
    }
  };

  const stopWidgetTicker = () => {
    if (widgetTicker) {
      clearInterval(widgetTicker);
      widgetTicker = null;
    }
  };

  /** Keep the elapsed timers in the widget graph counting between events. */
  const startWidgetTicker = (ctx: ExtensionContext, run: ActiveRun) => {
    stopWidgetTicker();
    widgetTicker = setInterval(() => {
      if (activeRun !== run || !run.lastState) {
        stopWidgetTicker();
        return;
      }
      renderWidget(ctx);
    }, 1_000);
    widgetTicker.unref?.();
  };

  const finishRun = (ctx: ExtensionContext, run: ActiveRun, result: WorkflowRunResult) => {
    if (activeRun === run) {
      activeRun = null;
    }
    stopWidgetTicker();
    const { state } = result;
    updateWidget(ctx, state, run.snapshot);
    clearWidgetTimer();
    // A waiting run is parked at a checkpoint for a human; keep its widget up
    // until a new workflow replaces it. Terminal runs fade after a grace TTL.
    if (state.status !== "waiting") {
      widgetTimer = setTimeout(() => clearWidget(ctx), FINAL_WIDGET_TTL_MS);
      widgetTimer.unref?.();
    }
    const summary =
      state.status === "waiting" && state.waitingOn
        ? `Workflow ${state.workflowName} parked at checkpoint ${state.waitingOn} — run ended, awaiting your decision (run ${state.runId})`
        : `Workflow ${state.workflowName} ${state.status} (run ${state.runId})`;
    notify(ctx, summary, state.status === "completed" ? "info" : "warning");
  };

  const startRun = async (ctx: ExtensionCommandContext, ref: string, input: unknown) => {
    if (activeRun) {
      notify(
        ctx,
        `A workflow is already running: ${activeRun.workflowName}. Use /workflow cancel first.`,
        "error",
      );
      return;
    }
    const resolved = await resolveWorkflowRef(ref, { cwd: ctx.cwd });
    const workflow = await loadWorkflowFile(resolved.path);
    const snapshot = createDefinitionSnapshot(workflow);

    const executor = new ConversationStepExecutor({
      sendPrompt: ({ prompt, streaming }) => {
        pi.sendUserMessage(prompt, streaming ? { deliverAs: "steer" } : undefined);
      },
    });
    const engine = new WorkflowEngine({
      executor,
      onEvent: (_event, state: WorkflowRunState) => {
        if (run.runId === null) {
          run.runId = state.runId;
        }
        run.lastState = state;
        updateWidget(ctx, state, snapshot);
      },
    });
    const run: ActiveRun = {
      runId: null,
      workflowName: workflow.name,
      engine,
      executor,
      snapshot,
      lastState: null,
    };
    activeRun = run;
    clearWidgetTimer();
    startWidgetTicker(ctx, run);
    notify(ctx, `Workflow ${workflow.name} started. Follow it live with: pi-workflows view`);

    engine
      .run(workflow, input, { workflowPath: resolved.path })
      .then((result) => finishRun(ctx, run, result))
      .catch((error: unknown) => {
        if (activeRun === run) {
          activeRun = null;
        }
        stopWidgetTicker();
        clearWidget(ctx);
        notify(ctx, `Workflow ${workflow.name} crashed: ${errorMessage(error)}`, "error");
      });
  };

  const listWorkflows = async (ctx: ExtensionCommandContext) => {
    const discovered = await discoverWorkflows({ cwd: ctx.cwd });
    if (discovered.length === 0) {
      notify(
        ctx,
        "No workflows found. Put *.workflow.ts files in .pi/workflows/ or ~/.pi/agent/workflows/, or pass a path.",
        "warning",
      );
      return;
    }
    const names = discovered.map((workflow) => `${workflow.name} (${workflow.source})`).join(", ");
    notify(ctx, `Workflows: ${names}. Run one with /workflow <name> [task].`);
  };

  pi.registerCommand("workflow", {
    description:
      "Run a workflow: /workflow <name-or-path> [task | --input-json {…}]; /workflow cancel stops the run or clears the widget",
    getArgumentCompletions: async (prefix: string) => {
      const discovered = await discoverWorkflows({ cwd: process.cwd() });
      const items = [
        ...discovered.map((workflow) => ({ value: workflow.name, label: workflow.name })),
        { value: "cancel", label: "cancel" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      let parsed: ParsedWorkflowArgs;
      try {
        parsed = parseWorkflowArgs(args);
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
        return;
      }
      if (parsed.kind === "list") {
        await listWorkflows(ctx);
        return;
      }
      if (parsed.kind === "cancel") {
        if (activeRun) {
          activeRun.engine.cancel();
          notify(ctx, `Cancelling workflow ${activeRun.workflowName}…`);
          return;
        }
        // No live run, but a parked (waiting) or recently finished run may
        // still occupy the widget; cancel clears it.
        if (widgetSource) {
          const { state } = widgetSource;
          clearWidgetTimer();
          clearWidget(ctx);
          const detail =
            state.status === "waiting" && state.waitingOn
              ? `already ended at checkpoint ${state.waitingOn}`
              : `already ${state.status}`;
          notify(ctx, `Workflow ${state.workflowName} ${detail}; cleared its widget.`);
          return;
        }
        notify(ctx, "No workflow is running.", "warning");
        return;
      }
      try {
        await startRun(ctx, parsed.ref, parsed.input);
      } catch (error) {
        notify(ctx, `Could not start workflow: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact step id from the contract and your result as the output.",
    ].join(" "),
    parameters: Type.Object({
      step: Type.String({ description: "The step id from the workflow step contract" }),
      attempt: Type.String({ description: "The attempt id from the workflow step contract" }),
      output: Type.Unknown({ description: "The step output, matching the expected output shape" }),
    }),
    async execute(_toolCallId, params) {
      if (!activeRun) {
        throw new Error(
          "No workflow is running. Do not call the workflow tool outside a workflow.",
        );
      }
      const result = await activeRun.executor.submit(params.step, params.attempt, params.output);
      if (!result.accepted) {
        throw new Error(result.message);
      }
      return {
        content: [{ type: "text", text: result.message }],
        details: { step: params.step, accepted: true },
      };
    },
  });

  pi.registerShortcut("shift+up", {
    description: "Scroll the workflow widget up",
    handler: (ctx) => scrollWidget(ctx, -WIDGET_SCROLL_STEP),
  });

  pi.registerShortcut("shift+down", {
    description: "Scroll the workflow widget down",
    handler: (ctx) => scrollWidget(ctx, WIDGET_SCROLL_STEP),
  });

  pi.on("agent_start", () => {
    activeRun?.executor.setStreaming(true);
  });

  pi.on("agent_settled", () => {
    if (!activeRun) {
      return;
    }
    activeRun.executor.setStreaming(false);
    activeRun.executor.handleAgentSettled();
  });

  pi.on("session_shutdown", () => {
    activeRun?.engine.cancel();
    activeRun = null;
    clearWidgetTimer();
    stopWidgetTicker();
    widgetSource = null;
    widgetScroll = null;
  });
}
