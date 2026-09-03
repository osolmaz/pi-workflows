import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_WORKFLOW_METADATA } from "../builtins/metadata.js";
import { verifyTelegramTokenFile, writeDecisionChannelProfile } from "../channels/config.js";
import { WorkflowClient } from "../client/client.js";
import { materializeSessionView } from "../client/materialize.js";
import type { ClientResponse } from "../client/protocol.js";
import type {
  ClientInteractiveRequest,
  WorkflowRunQueueView,
  WorkflowSessionView,
} from "../client/view.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import type { WorkflowMessage } from "../state/workflow-messages.js";
import { errorMessage } from "../workflows/errors.js";
import { discoverWorkflows } from "../workflows/loader.js";
import { createRunId } from "../workflows/store.js";
import type { AgentStepContract, HumanDecisionResponse } from "../workflows/types.js";
import { parseControllerArgs, type ParsedControllerArgs } from "./controller-command.js";
import {
  HerdrWorkflowViewer,
  PIW_SHORTCUT,
  PIW_SHORTCUT_HINT,
  VIEWER_PLACEMENTS,
  type ViewerPlacement,
} from "./herdr-viewer.js";
import { SessionRecorder } from "./recorder.js";
import { RemoteSessionRecordingStore } from "./remote-recorder-store.js";
import { SessionWorkflowView } from "./session-view.js";
import { recoverAssistantStep, registerWorkflowAgentStepMessageRenderer } from "./step-message.js";
import { responseEntryId, WorkflowMessageCoordinator } from "./workflow-message-coordinator.js";
import { parseWorkflowToolInput, WorkflowToolParameters } from "./workflow-tool.js";

export { parseControllerArgs, type ParsedControllerArgs } from "./controller-command.js";

export {
  audienceChannels,
  decisionConfigDir,
  loadDecisionChannelConfig,
  verifyTelegramTokenFile,
  writeDecisionChannelProfile,
  type DecisionChannelConfig,
  type DecisionCredentialConfig,
  type LoadedDecisionChannelConfig,
  type TelegramFetch,
} from "../channels/config.js";
export { renderDecisionText, renderTelegramParts } from "../channels/telegram.js";

const INTERACTION_POLL_MS = 1_000;
// Keep one model-facing tool result comfortably below Pi provider message limits.
// The offset keeps every discovered workflow available across pages.
const MAX_WORKFLOW_LIST_ITEMS = 50;
const MAX_WORKFLOW_LIST_NAME_CHARS = 3_500;
const sessionSnapshots = new Map<string, WorkflowSessionView>();

export type ParsedWorkflowArgs =
  | { kind: "list"; offset?: number }
  | { kind: "cancel"; runId?: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status"; runId?: string }
  | { kind: "clear"; runId?: string }
  | { kind: "restart"; runId?: string }
  | {
      kind: "change-settings";
      patch: unknown;
      runId?: string;
      scopeId?: string;
      expectedChangeNumber?: number;
    }
  | { kind: "queue-follow-up"; prompt: string; runId?: string }
  | { kind: "remove-follow-up"; followUpId: string; runId?: string }
  | { kind: "answer"; input: unknown; runId?: string | undefined }
  | { kind: "run"; ref: string; input: unknown };

/** Parse `/workflow` arguments. Exported for tests. */
export function parseWorkflowArgs(args: string): ParsedWorkflowArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "list" };
  if (trimmed === "cancel" || trimmed === "pause" || trimmed === "resume") {
    return { kind: trimmed };
  }
  if (trimmed.startsWith("cancel ")) {
    const runId = trimmed.slice("cancel".length).trim();
    if (!validRunId(runId)) throw new Error("cancel requires one valid run id");
    return { kind: "cancel", runId };
  }
  if (trimmed === "status") return { kind: "status" };
  if (trimmed === "clear") return { kind: "clear" };
  if (trimmed.startsWith("clear ")) {
    const runId = trimmed.slice("clear".length).trim();
    if (!validRunId(runId)) throw new Error("clear requires one valid run id");
    return { kind: "clear", runId };
  }
  if (trimmed === "restart") return { kind: "restart" };
  if (trimmed.startsWith("restart ")) {
    const runId = trimmed.slice("restart".length).trim();
    if (!validRunId(runId)) throw new Error("restart requires one valid run id");
    return { kind: "restart", runId };
  }
  if (trimmed.startsWith("change-settings ")) {
    const text = trimmed.slice("change-settings".length).trim();
    try {
      return { kind: "change-settings", patch: JSON.parse(text) as unknown };
    } catch (error) {
      throw new Error(`change-settings requires a JSON Patch array: ${errorMessage(error)}`);
    }
  }
  if (trimmed.startsWith("queue-follow-up ")) {
    const prompt = trimmed.slice("queue-follow-up".length).trim();
    if (prompt.length === 0) throw new Error("queue-follow-up requires a prompt");
    return { kind: "queue-follow-up", prompt };
  }
  if (trimmed.startsWith("remove-follow-up ")) {
    const followUpId = trimmed.slice("remove-follow-up".length).trim();
    if (!/^follow-up-[a-f0-9]{40}$/u.test(followUpId)) {
      throw new Error("remove-follow-up requires one valid follow-up id");
    }
    return { kind: "remove-follow-up", followUpId };
  }
  if (trimmed.startsWith("status ")) {
    const runId = trimmed.slice("status".length).trim();
    if (!validRunId(runId)) throw new Error("status requires one valid run id");
    return { kind: "status", runId };
  }
  if (trimmed === "answer" || trimmed.startsWith("answer ")) {
    let rest = trimmed === "answer" ? "" : trimmed.slice("answer".length).trim();
    if (rest.length === 0) {
      throw new Error(
        'answer requires a JSON value or text, e.g. /workflow answer {"approved":true}',
      );
    }
    let runId: string | undefined;
    const firstSpace = rest.search(/\s/);
    if (firstSpace > 0) {
      const candidate = rest.slice(0, firstSpace);
      const remainder = rest.slice(firstSpace).trim();
      if (
        validRunId(candidate) &&
        remainder.length > 0 &&
        (remainder.startsWith("{") || remainder.startsWith("["))
      ) {
        runId = candidate;
        rest = remainder;
      }
    }
    try {
      return {
        kind: "answer",
        input: JSON.parse(rest) as unknown,
        ...(runId === undefined ? {} : { runId }),
      };
    } catch {
      if (runId !== undefined) throw new Error("answer with a run id requires a JSON value");
      return { kind: "answer", input: { answer: rest } };
    }
  }
  const spaceIndex = trimmed.search(/\s/);
  const ref = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  const inputJsonMatch = rest.match(/^--input-json(?:\s+|$)([\s\S]*)$/);
  if (inputJsonMatch !== null) {
    const json = (inputJsonMatch[1] as string).trim();
    if (json.length === 0) throw new Error("--input-json requires a JSON value");
    return { kind: "run", ref, input: JSON.parse(json) as unknown };
  }
  return { kind: "run", ref, input: rest.length > 0 ? { task: rest } : {} };
}

export default function piWorkflows(pi: ExtensionAPI): void {
  registerWorkflowAgentStepMessageRenderer(pi);
  let client = new WorkflowClient({ clientId: `pi-extension-${randomUUID()}` });
  const herdrViewer = new HerdrWorkflowViewer(pi.exec);
  let sessionContext: ExtensionContext | null = null;
  let sessionGeneration = 0;
  let sessionUnsubscribe: (() => Promise<void>) | null = null;
  let sessionConnectTask: Promise<void> | null = null;
  let hostUnavailableNotified = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let presentationTail = Promise.resolve();
  let toolTail = Promise.resolve();
  const workflowMessages = new WorkflowMessageCoordinator();
  const sessionView = new SessionWorkflowView();
  const sessionRecorders = new Map<string, SessionRecorder>();
  let agentRunning = false;
  let activeRecorder: SessionRecorder | null = null;
  let activeRecorderMessageId: string | null = null;

  const ensureRecorder = async (
    message: WorkflowMessage,
    ctx: ExtensionContext,
  ): Promise<SessionRecorder> => {
    let recorder = sessionRecorders.get(message.runId);
    if (recorder === undefined) {
      recorder = new SessionRecorder(
        new RemoteSessionRecordingStore(client, () => sessionCommandPayload(ctx)),
        message.runId,
      );
      sessionRecorders.set(message.runId, recorder);
      await recorder.bind(ctx).catch((error) => {
        ctx.ui.notify(`Workflow conversation recording failed: ${errorMessage(error)}`, "warning");
      });
    }
    return recorder;
  };

  const activateRecorder = async (ctx: ExtensionContext): Promise<void> => {
    if (!agentRunning) return;
    const message = workflowMessages.activeTurnMessage();
    if (message === undefined || activeRecorderMessageId === message.workflowMessageId) return;
    const contract = agentContractForWorkflowMessage(message);
    if (contract === undefined && message.kind !== "terminal" && message.kind !== "followUp") {
      return;
    }
    const recorder = await ensureRecorder(message, ctx);
    if (
      !agentRunning ||
      workflowMessages.activeTurnMessage()?.workflowMessageId !== message.workflowMessageId
    ) {
      return;
    }
    if (contract === undefined) {
      recorder.beginWorkflowMessage(
        message.workflowMessageId,
        message.kind as "terminal" | "followUp",
      );
    } else {
      recorder.beginAttempt(contract);
    }
    activeRecorder = recorder;
    activeRecorderMessageId = message.workflowMessageId;
  };

  const presentInOrder = async (ctx: ExtensionContext): Promise<void> => {
    const prior = presentationTail;
    let release: (() => void) | undefined;
    presentationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await workflowMessages.synchronize(pi, client, ctx);
      await activateRecorder(ctx);
    } finally {
      sessionView.refresh(ctx);
      release?.();
    }
  };

  const openPiw = async (
    ctx: ExtensionContext,
    requestedPlacement?: ViewerPlacement,
  ): Promise<void> => {
    const run = sessionSnapshots.get(ctx.sessionManager.getSessionId())?.run;
    if (run === null || run === undefined || !isRecord(run.state)) {
      ctx.ui.notify("No active workflow is available for piw.", "warning");
      return;
    }
    const capability = await herdrViewer.probe();
    if (!capability.available) {
      ctx.ui.notify(capability.reason, "warning");
      return;
    }
    const placement =
      requestedPlacement ??
      ((await ctx.ui.select("Open workflow viewer", [...VIEWER_PLACEMENTS])) as
        | ViewerPlacement
        | undefined);
    if (placement === undefined) return;
    const workflowName =
      typeof run.state.workflowName === "string" ? run.state.workflowName : run.runId;
    const opened = await herdrViewer.open(
      { runId: run.runId, workflowName },
      placement as ViewerPlacement,
      ctx.cwd,
    );
    ctx.ui.notify(
      opened.reused ? "Focused the existing piw view." : "Opened piw in Herdr.",
      "info",
    );
  };

  const runToolInOrder = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = toolTail;
    let release: (() => void) | undefined;
    toolTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await presentationTail;
      const currentContext = sessionContext;
      if (currentContext === null) throw new Error("Workflow session is unavailable");
      await presentInOrder(currentContext);
      return await operation();
    } finally {
      release?.();
    }
  };

  pi.registerCommand("workflow", {
    description:
      "Start or control a hosted workflow: /workflow <name-or-path> [task | --input-json {…}]; also: status, pause, resume, cancel, clear, restart, answer, change-settings, queue-follow-up, remove-follow-up",
    getArgumentCompletions: async (prefix: string) => {
      const workflows = await listWorkflowMetadata(process.cwd());
      const items = [
        ...workflows.map((workflow) => ({ value: workflow.name, label: workflow.name })),
        ...[
          "status",
          "pause",
          "resume",
          "cancel",
          "clear",
          "restart",
          "answer",
          "change-settings",
          "queue-follow-up",
          "remove-follow-up",
        ].map((value) => ({
          value,
          label: value,
        })),
      ].filter((item) => item.value.startsWith(prefix));
      return items.length === 0 ? null : items;
    },
    handler: async (args, ctx) => {
      try {
        await presentInOrder(ctx);
        const parsed = parseWorkflowArgs(args);
        const result = await executeCommand(client, ctx, parsed, randomUUID(), "human");
        ctx.ui.notify(result.message, result.level ?? "info");
        await presentInOrder(ctx);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-channel", {
    description: "Configure, inspect, or reload private human decision channels",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/u).filter(Boolean);
      const action = words[0] ?? "status";
      try {
        if (action === "status") {
          const response = await requestAccepted(client, {
            operation: "channel.status",
            requestId: `channel-status-${randomUUID()}`,
          });
          const receipt = isRecord(response.receipt) ? response.receipt : {};
          const profiles = Array.isArray(receipt.profiles) ? receipt.profiles : [];
          const ambiguous = Array.isArray(receipt.ambiguous) ? receipt.ambiguous : [];
          const channelError = typeof receipt.error === "string" ? receipt.error : null;
          const ambiguousIds = ambiguous.flatMap((item) => {
            if (!isRecord(item) || typeof item.messageId !== "string") return [];
            return [item.messageId];
          });
          const summary =
            profiles.length === 0
              ? "Human decisions use the Pi channel only."
              : `${profiles.length} Telegram profile(s) configured; ${ambiguous.length} ambiguous channel operation(s).`;
          ctx.ui.notify(
            channelError !== null
              ? `${summary}\nChannel configuration error: ${channelError}`
              : ambiguousIds.length === 0
                ? summary
                : `${summary}\nRecover after checking Telegram: /workflow-channel recover <message-id> confirm|retry\n${ambiguousIds.join("\n")}`,
            channelError === null && ambiguousIds.length === 0 ? "info" : "warning",
          );
          return;
        }
        if (action === "reload") {
          await requestAccepted(client, {
            operation: "channel.reload",
            requestId: `channel-reload-${randomUUID()}`,
            idempotencyKey: `channel-reload-${randomUUID()}`,
            payload: sessionCommandPayload(ctx),
          });
          ctx.ui.notify("Human decision channels reloaded.");
          return;
        }
        if (action === "recover") {
          const messageId = words[1];
          const recoveryAction = words[2];
          if (
            messageId === undefined ||
            (recoveryAction !== "confirm" && recoveryAction !== "retry") ||
            words.length !== 3
          ) {
            throw new Error(
              "Use /workflow-channel recover <message-id> confirm|retry after checking Telegram.",
            );
          }
          const recoveryId = `channel-recover-${randomUUID()}`;
          await requestAccepted(client, {
            operation: "channel.recover",
            requestId: recoveryId,
            idempotencyKey: recoveryId,
            payload: {
              ...sessionCommandPayload(ctx),
              messageId,
              action: recoveryAction,
            },
          });
          ctx.ui.notify(
            recoveryAction === "confirm"
              ? "The channel operation is marked confirmed."
              : "A new channel attempt is now allowed. It can duplicate an earlier uncertain effect.",
            recoveryAction === "confirm" ? "info" : "warning",
          );
          return;
        }
        if (action !== "setup") {
          throw new Error("Use /workflow-channel status, setup, reload, or recover.");
        }
        if (!ctx.hasUI || ctx.mode !== "tui") {
          throw new Error("Channel setup requires interactive Pi TUI mode.");
        }
        const tokenFile = await ctx.ui.input(
          "Absolute path to the mode-0600 Telegram token file",
          "",
        );
        if (tokenFile === undefined) return;
        const audience = await ctx.ui.input("Logical audience", "operator");
        if (audience === undefined) return;
        const profile = await ctx.ui.input("Private Telegram profile name", "default");
        if (profile === undefined) return;
        const credential = await ctx.ui.input("Private credential reference name", "telegram");
        if (credential === undefined) return;
        const users = await ctx.ui.input("Allowed numeric Telegram user IDs, comma separated", "");
        if (users === undefined) return;
        const chats = await ctx.ui.input("Allowed numeric Telegram chat IDs, comma separated", "");
        if (chats === undefined) return;
        await verifyTelegramTokenFile(tokenFile.trim());
        await writeDecisionChannelProfile({
          audience: audience.trim(),
          profile: profile.trim(),
          credential: credential.trim(),
          tokenFile: tokenFile.trim(),
          allowedUserIds: users
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          allowedChatIds: chats
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        });
        await requestAccepted(client, {
          operation: "channel.reload",
          requestId: `channel-reload-${randomUUID()}`,
          idempotencyKey: `channel-reload-${randomUUID()}`,
          payload: sessionCommandPayload(ctx),
        });
        ctx.ui.notify("The private human decision channel profile was verified and installed.");
      } catch (error) {
        ctx.ui.notify(`Human decision channel setup failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("controller", {
    description: "Manage hosted controller resources: list, get, apply, reconcile, or delete",
    getArgumentCompletions: (prefix: string) => {
      const items = ["list", "get", "apply", "reconcile", "delete"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length === 0 ? null : items;
    },
    handler: async (args, ctx) => {
      try {
        const result = await executeControllerCommand(client, ctx, parseControllerArgs(args));
        ctx.ui.notify(result.message, result.level ?? "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "List, start, restart, inspect, change settings, queue or remove follow-ups, pause, resume, cancel, answer ordinary checkpoints, update, or complete hosted workflow runs.",
      "Protected human decisions cannot be answered with this model-facing tool.",
      "When the user asks to continue or resume the active workflow, call workflow resume immediately.",
      "Use update or submit only when a workflow step contract asks for it, and pass the exact step and attempt ids.",
      "Do not start repeated work without the user's request.",
    ].join(" "),
    parameters: WorkflowToolParameters,
    async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
      return await runToolInOrder(async () => {
        const params = parseWorkflowToolInput(rawParams);
        if (params.action === "update" || params.action === "submit") {
          const interaction = pendingInteractionForSession(ctx.sessionManager.getSessionId());
          if (interaction === undefined) throw new Error("No workflow step is waiting for output");
          const contract = agentContract(interaction);
          if (contract === undefined)
            throw new Error("The pending interaction is not an agent step");
          if (contract.nodeId !== params.step || contract.attemptId !== params.attempt) {
            throw new Error("Workflow step or attempt does not match the durable request");
          }
          let response: ClientResponse;
          try {
            response = await requestAccepted(client, {
              operation: params.action === "update" ? "interaction.update" : "interaction.submit",
              requestId: `${params.action}-${toolCallId}-${randomUUID()}`,
              idempotencyKey: toolCallId,
              runId: interaction.runId,
              expectedRevision: interaction.revision,
              payload: jsonValue({
                requestId: interaction.requestId,
                submissionId: toolCallId,
                step: params.step,
                attempt: params.attempt,
                value:
                  params.action === "update"
                    ? { update: params.update }
                    : { output: params.output },
              }),
              ...(signal === undefined ? {} : { signal }),
            });
          } catch (error) {
            await presentInOrder(ctx).catch(() => undefined);
            throw error;
          }
          await presentInOrder(ctx);
          return toolResult(
            params.action === "update"
              ? "Workflow update accepted; the step remains active."
              : "Workflow step output accepted.",
            { action: params.action, response: response.receipt ?? null },
          );
        }
        const parsed = toolInputToCommand(params);
        const result = await executeCommand(client, ctx, parsed, toolCallId, "model");
        await presentInOrder(ctx);
        return toolResult(result.message, result.details);
      });
    },
  });

  pi.registerCommand("piw", {
    description: "Open the active workflow in Herdr",
    handler: async (args, ctx) => {
      try {
        const requested = args.trim();
        if (requested.length > 0 && !VIEWER_PLACEMENTS.includes(requested as ViewerPlacement)) {
          throw new Error(`Unknown piw placement: ${requested}`);
        }
        await openPiw(ctx, requested.length === 0 ? undefined : (requested as ViewerPlacement));
      } catch (error) {
        ctx.ui.notify(`Could not open piw: ${errorMessage(error)}`, "warning");
      }
    },
  });

  pi.registerShortcut(PIW_SHORTCUT, {
    description: "Open the active workflow in Herdr",
    handler: async (ctx) => {
      try {
        await openPiw(ctx);
      } catch (error) {
        ctx.ui.notify(`Could not open piw: ${errorMessage(error)}`, "warning");
      }
    },
  });

  pi.registerShortcut("shift+up", {
    description: "Scroll the workflow widget up",
    handler: (ctx) => sessionView.scrollUp(ctx),
  });

  pi.registerShortcut("shift+down", {
    description: "Scroll the workflow widget down",
    handler: (ctx) => sessionView.scrollDown(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    hostUnavailableNotified = false;
    const sessionId = ctx.sessionManager.getSessionId();
    const generation = ++sessionGeneration;
    let snapshotGeneration = 0;
    const sessionClient = client;

    const connectSession = (): void => {
      if (
        generation !== sessionGeneration ||
        sessionContext !== ctx ||
        sessionUnsubscribe !== null ||
        sessionConnectTask !== null
      ) {
        return;
      }
      const task = (async () => {
        try {
          await sessionClient.ensureAvailable();
          const unsubscribe = await sessionClient.watchSession(
            sessionId,
            (event) => {
              if (generation !== sessionGeneration || sessionContext !== ctx) return;
              const currentSnapshotGeneration = ++snapshotGeneration;
              if (event.event === "unavailable") {
                sessionSnapshots.delete(sessionId);
                sessionView.clear(ctx);
                return;
              }
              if (!isWorkflowSessionView(event.payload)) return;
              void materializeSessionView(sessionClient, event.payload)
                .then((session) => {
                  if (
                    generation !== sessionGeneration ||
                    currentSnapshotGeneration !== snapshotGeneration ||
                    sessionContext !== ctx
                  ) {
                    return;
                  }
                  sessionSnapshots.set(sessionId, session);
                  workflowMessages.updateView(session);
                  sessionView.update(session, ctx);
                  const ownedMessageId =
                    session.nextWorkflowMessageId ?? session.openWorkflowMessageId;
                  const ownedMessage = session.workflowMessages.find(
                    (message) => message.workflowMessageId === ownedMessageId,
                  );
                  const prepare =
                    ownedMessage !== undefined &&
                    (ownedMessage.kind === "step" ||
                      ownedMessage.kind === "terminal" ||
                      ownedMessage.kind === "followUp")
                      ? ensureRecorder(ownedMessage, ctx)
                      : Promise.resolve();
                  void prepare.then(async () => await presentInOrder(ctx)).catch(() => undefined);
                })
                .catch(() => {
                  // A newer session revision retries from its own stable snapshot.
                });
            },
            { coordinator: true },
          );
          if (generation !== sessionGeneration || sessionContext !== ctx) {
            await unsubscribe();
            return;
          }
          sessionUnsubscribe = unsubscribe;
          hostUnavailableNotified = false;
          const capability = await herdrViewer.probe();
          if (generation !== sessionGeneration || sessionContext !== ctx) return;
          sessionView.setActionHint(capability.available ? PIW_SHORTCUT_HINT : undefined, ctx);
          await presentInOrder(ctx);
        } catch (error) {
          if (
            generation === sessionGeneration &&
            sessionContext === ctx &&
            !hostUnavailableNotified
          ) {
            hostUnavailableNotified = true;
            ctx.ui.notify(`Workflow host is unavailable: ${errorMessage(error)}`, "warning");
          }
        }
      })();
      sessionConnectTask = task;
      void task.finally(() => {
        if (sessionConnectTask === task) sessionConnectTask = null;
      });
    };

    pollTimer = setInterval(() => {
      connectSession();
      if (sessionContext !== null) void presentInOrder(sessionContext).catch(() => undefined);
    }, INTERACTION_POLL_MS);
    pollTimer.unref?.();
    connectSession();
  });

  pi.on("session_tree", async (_event, ctx) => {
    workflowMessages.branchChanged();
    await presentInOrder(ctx).catch(() => undefined);
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    activeRecorder = null;
    activeRecorderMessageId = null;
    workflowMessages.startTurn();
    await presentInOrder(ctx).catch(() => undefined);
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      await submitVisibleAssistantResponse(client, ctx);
    } catch (error) {
      ctx.ui.notify(`Workflow response was rejected: ${errorMessage(error)}`, "error");
    }
    const finishedMessage = workflowMessages.activeTurnMessage();
    agentRunning = false;
    activeRecorderMessageId = null;
    workflowMessages.endTurn(
      workflowTurnStopReason(event.messages, ctx.signal?.aborted === true),
      responseEntryId(ctx.sessionManager.getBranch()),
    );
    if (
      activeRecorder !== null &&
      finishedMessage !== undefined &&
      (finishedMessage.kind === "terminal" || finishedMessage.kind === "followUp")
    ) {
      const finishedRecorder = activeRecorder;
      activeRecorder = null;
      await finishedRecorder.finish();
      if (sessionRecorders.get(finishedMessage.runId) === finishedRecorder) {
        sessionRecorders.delete(finishedMessage.runId);
      }
    }
    await presentInOrder(ctx).catch((error) => {
      ctx.ui.notify(`Could not record workflow model activity: ${errorMessage(error)}`, "warning");
    });
  });

  pi.on("turn_start", (event) => {
    activeRecorder?.handleTurnStart(event);
  });

  pi.on("turn_end", async (event, ctx) => {
    await activeRecorder?.handleTurnEnd(event, ctx).catch(() => undefined);
  });

  pi.on("message_start", async (event, ctx) => {
    await activeRecorder?.handleMessageStart(event, ctx).catch(() => undefined);
  });

  pi.on("message_update", (event) => {
    activeRecorder?.handleMessageUpdate(event);
  });

  pi.on("message_end", (event) => {
    activeRecorder?.handleMessageEnd(event);
  });

  pi.on("tool_execution_start", (event) => {
    activeRecorder?.handleToolStart(event);
  });

  pi.on("tool_execution_update", (event) => {
    activeRecorder?.handleToolUpdate(event);
  });

  pi.on("tool_execution_end", (event) => {
    activeRecorder?.handleToolEnd(event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    activeRecorder?.settleAttempt();
    try {
      await submitVisibleAssistantResponse(client, ctx);
    } catch (error) {
      ctx.ui.notify(`Workflow response was rejected: ${errorMessage(error)}`, "error");
    }
    await presentInOrder(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionGeneration += 1;
    sessionContext = null;
    agentRunning = false;
    activeRecorder = null;
    activeRecorderMessageId = null;
    await Promise.allSettled(
      [...sessionRecorders.values()].map(async (recorder) => recorder.stop()),
    );
    sessionRecorders.clear();
    workflowMessages.clear();
    sessionView.clear(ctx);
    sessionSnapshots.delete(ctx.sessionManager.getSessionId());
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    if (sessionUnsubscribe !== null) await sessionUnsubscribe().catch(() => undefined);
    sessionUnsubscribe = null;
    sessionConnectTask = null;
    hostUnavailableNotified = false;
    await client.close();
    client = new WorkflowClient({ clientId: `pi-extension-${randomUUID()}` });
  });
}

type CommandResult = {
  message: string;
  details: Record<string, unknown>;
  level?: "info" | "warning" | "error";
};

async function executeCommand(
  client: WorkflowClient,
  ctx: ExtensionContext,
  command: ParsedWorkflowArgs,
  idempotencyKey: string = randomUUID(),
  authority: "human" | "model" = "human",
): Promise<CommandResult> {
  switch (command.kind) {
    case "list": {
      const workflows = await listWorkflowMetadata(ctx.cwd);
      const offset = command.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > workflows.length) {
        throw new Error(
          `Workflow list offset must be an integer from 0 through ${workflows.length}`,
        );
      }
      if (workflows.length === 0) {
        return {
          message:
            "No workflows found. Put *.workflow.ts files in .pi/workflows/ or ~/.pi/agent/workflows/, or pass a path.",
          details: { workflows: [], total: 0, offset: 0, omitted: 0 },
          level: "warning" as const,
        };
      }
      const page: Awaited<ReturnType<typeof listWorkflowMetadata>> = [];
      let nameChars = 0;
      for (const workflow of workflows.slice(offset)) {
        const rendered = `${workflow.name} (${workflow.source})`;
        if (
          page.length >= MAX_WORKFLOW_LIST_ITEMS ||
          nameChars + rendered.length > MAX_WORKFLOW_LIST_NAME_CHARS
        ) {
          break;
        }
        page.push(workflow);
        nameChars += rendered.length;
      }
      const nextOffset = offset + page.length;
      const omitted = workflows.length - nextOffset;
      return {
        message: [
          `Workflows: ${page.map((item) => `${item.name} (${item.source})`).join(", ")}.`,
          omitted > 0 ? `${omitted} more omitted; list again with offset ${nextOffset}.` : "",
          "Run one with /workflow <name> [task].",
        ]
          .filter(Boolean)
          .join(" "),
        details: {
          workflows: page,
          total: workflows.length,
          offset,
          omitted,
          ...(omitted > 0 ? { nextOffset } : {}),
        },
      };
    }
    case "run": {
      await client.ensureAvailable();
      const resolved = await client.resolveWorkflow({ cwd: ctx.cwd, workflowRef: command.ref });
      const runId = createRunId(resolved.workflowName);
      const response = await requestAccepted(client, {
        operation: "run.start",
        requestId: `start-${idempotencyKey}`,
        idempotencyKey,
        runId,
        payload: {
          projectPath: ctx.cwd,
          workflowName: resolved.workflowName,
          workflowSourceRef: resolved.workflowSourceRef,
          workflowSource: resolved.workflowSource,
          definitionDigest: resolved.definitionDigest,
          definitionSnapshot: resolved.definitionSnapshot,
          input: jsonValue(command.input),
          launchOptions: {},
          originSessionId: ctx.sessionManager.getSessionId(),
          executionMode: "interactive",
        },
      });
      return {
        message: `Started hosted workflow ${resolved.workflowName} as ${runId}.`,
        details: { action: "start", runId, response: response.receipt ?? null },
      };
    }
    case "status": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined) {
        return {
          message: "No workflow run is active in this session.",
          details: { active: false },
        };
      }
      const response = await requestAccepted(client, {
        operation: "run.status",
        runId,
        idempotencyKey,
      });
      return {
        message: summarizeRun(response.receipt),
        details: { action: "status", runId, run: response.receipt ?? null },
      };
    }
    case "clear": {
      const session = sessionCommandPayload(ctx);
      const response = await requestAccepted(client, {
        operation: "sessionView.clearTerminal",
        requestId: `clear-${idempotencyKey}`,
        idempotencyKey,
        ...(command.runId === undefined ? {} : { runId: command.runId }),
        payload: session,
      });
      return {
        message: "Cleared the retained workflow result from this session.",
        details: { action: "clear", response: response.receipt ?? null },
      };
    }
    case "restart": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined)
        throw new Error("No workflow terminal result is available to restart");
      const session = sessionCommandPayload(ctx);
      const marker = terminalMessageForSession(ctx, runId);
      const response = await requestAccepted(client, {
        operation: "run.restart",
        requestId: `restart-${idempotencyKey}`,
        idempotencyKey,
        runId,
        payload: {
          ...session,
          workflowMessageId: marker.workflowMessageId,
          ...(marker.workflowTurnId === undefined ? {} : { workflowTurnId: marker.workflowTurnId }),
        },
      });
      return {
        message: `Restarted workflow ${runId}.`,
        details: { action: "restart", runId, response: response.receipt ?? null },
      };
    }
    case "change-settings": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined) throw new Error("No workflow run is active in this session");
      const response = await requestAccepted(client, {
        operation: "run.changeSettings",
        requestId: `settings-${idempotencyKey}`,
        idempotencyKey,
        runId,
        payload: {
          ...sessionCommandPayload(ctx),
          patch: jsonValue(command.patch),
          ...(command.scopeId === undefined ? {} : { scopeId: command.scopeId }),
          ...(command.expectedChangeNumber === undefined
            ? {}
            : { expectedChangeNumber: command.expectedChangeNumber }),
        },
      });
      return {
        message: `Changed workflow settings for ${runId}.`,
        details: { action: "change-settings", runId, response: response.receipt ?? null },
      };
    }
    case "queue-follow-up": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined) throw new Error("No workflow run is active in this session");
      const response = await requestAccepted(client, {
        operation: "followUp.queue",
        requestId: `follow-up-${idempotencyKey}`,
        idempotencyKey,
        runId,
        payload: { ...sessionCommandPayload(ctx), prompt: command.prompt },
      });
      return {
        message: "Queued the workflow follow-up.",
        details: { action: "queue-follow-up", runId, response: response.receipt ?? null },
      };
    }
    case "remove-follow-up": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined) throw new Error("No workflow run is active in this session");
      const response = await requestAccepted(client, {
        operation: "followUp.remove",
        requestId: `remove-follow-up-${idempotencyKey}`,
        idempotencyKey,
        runId,
        payload: { ...sessionCommandPayload(ctx), followUpId: command.followUpId },
      });
      return {
        message: "Removed the workflow follow-up.",
        details: { action: "remove-follow-up", runId, response: response.receipt ?? null },
      };
    }
    case "pause":
    case "resume": {
      const run = activeSessionRun(ctx);
      if (run === undefined) throw new Error("No workflow run is active in this session");
      const response = await requestAccepted(client, {
        operation: `run.${command.kind}`,
        runId: run.runId,
        requestId: `${command.kind}-${idempotencyKey}`,
        idempotencyKey,
      });
      return {
        message: `Workflow ${run.runId} ${command.kind} request accepted.`,
        details: { action: command.kind, runId: run.runId, response: response.receipt ?? null },
      };
    }
    case "cancel": {
      const runId = command.runId ?? activeSessionRun(ctx)?.runId;
      if (runId === undefined) throw new Error("No workflow run is active in this session");
      const session = sessionSnapshots.get(ctx.sessionManager.getSessionId());
      if (session?.run?.runId === runId && isTerminalDisplay(session.run.display.status)) {
        const response = await requestAccepted(client, {
          operation: "sessionView.clearTerminal",
          requestId: `clear-cancel-${idempotencyKey}`,
          idempotencyKey,
          runId,
          payload: sessionCommandPayload(ctx),
        });
        return {
          message: `Cleared terminal workflow ${runId} from this session.`,
          details: { action: "cancel", runId, cleared: true, response: response.receipt ?? null },
        };
      }
      const response = await requestAccepted(client, {
        operation: "run.cancel",
        runId,
        requestId: `cancel-${idempotencyKey}`,
        idempotencyKey,
      });
      return {
        message: `Workflow ${runId} cancel request accepted.`,
        details: { action: "cancel", runId, response: response.receipt ?? null },
      };
    }
    case "answer": {
      const interaction = pendingDecision(ctx.sessionManager.getSessionId(), command.runId);
      if (interaction !== undefined) {
        if (authority !== "human") {
          throw new Error("Protected human decisions cannot be answered by the workflow tool");
        }
        const response = await requestAccepted(client, {
          operation: "decision.answer",
          requestId: `answer-${idempotencyKey}`,
          idempotencyKey,
          runId: interaction.runId,
          expectedRevision: interaction.revision,
          payload: {
            requestId: interaction.requestId,
            submissionId: idempotencyKey,
            response: decisionResponse(command.input),
          },
        });
        return {
          message: "Human decision answer accepted.",
          details: {
            action: "answer",
            runId: interaction.runId,
            response: response.receipt ?? null,
          },
        };
      }
      const parent = sessionRun(ctx, command.runId);
      if (parent === undefined) throw new Error("No checkpoint is waiting in this session");
      const continuationRunId = createRunId(parent.workflowName);
      const response = await requestAccepted(client, {
        operation: "checkpoint.answer",
        requestId: `checkpoint-${idempotencyKey}`,
        idempotencyKey,
        runId: parent.runId,
        payload: {
          continuationRunId,
          input: jsonValue(command.input),
        },
      });
      const receipt = isRecord(response.receipt) ? response.receipt : undefined;
      const actualRunId =
        receipt !== undefined && typeof receipt.runId === "string"
          ? receipt.runId
          : continuationRunId;
      return {
        message:
          receipt?.alreadyAnswered === true
            ? `Checkpoint ${parent.runId} was already answered; continuation ${actualRunId} exists.`
            : `Answered checkpoint ${parent.runId}; continuation ${actualRunId} started.`,
        details: {
          action: "answer",
          parentRunId: parent.runId,
          runId: actualRunId,
          response: response.receipt ?? null,
        },
      };
    }
  }
}

async function executeControllerCommand(
  client: WorkflowClient,
  ctx: ExtensionContext,
  command: ParsedControllerArgs,
): Promise<CommandResult> {
  const projectPath = path.resolve(ctx.cwd);
  if (command.kind === "list") {
    const response = await requestAccepted(client, {
      operation: "controller.list",
      payload: { projectPath },
    });
    return {
      message: summarizeControllerResources(response.receipt),
      details: { action: "list", resources: response.receipt ?? [] },
    };
  }

  const idempotencyKey = randomUUID();
  if (command.kind === "apply") {
    const resolved = await client.resolveControllerInitialization({
      cwd: projectPath,
      controllerName: command.controller,
      spec: command.spec,
    });
    const response = await requestAccepted(client, {
      operation: "controller.apply",
      requestId: `controller-apply-${idempotencyKey}`,
      idempotencyKey,
      payload: {
        projectPath,
        controller: resolved.controllerName,
        key: command.key,
        spec: command.spec,
        initialStatus: resolved.initialStatus,
        controllerPath: resolved.controllerPath,
        sourceHash: resolved.sourceHash,
      },
    });
    return {
      message: `Applied controller resource ${command.controller}/${command.key}.`,
      details: { action: "apply", resource: response.receipt ?? null },
    };
  }

  const response = await requestAccepted(client, {
    operation: `controller.${command.kind}`,
    requestId: `controller-${command.kind}-${idempotencyKey}`,
    idempotencyKey,
    payload: {
      projectPath,
      controller: command.controller,
      key: command.key,
    },
  });
  if (command.kind === "get") {
    return {
      message: JSON.stringify(response.receipt ?? null, null, 2),
      details: { action: "get", resource: response.receipt ?? null },
    };
  }
  return {
    message: `Controller resource ${command.controller}/${command.key} ${command.kind} request accepted.`,
    details: { action: command.kind, resource: response.receipt ?? null },
  };
}

async function submitVisibleAssistantResponse(
  client: WorkflowClient,
  ctx: ExtensionContext,
): Promise<void> {
  const interaction = pendingInteractionForSession(ctx.sessionManager.getSessionId());
  if (
    interaction === undefined ||
    interaction.kind !== "assistant" ||
    workflowRunPaused(interaction.runId)
  ) {
    return;
  }
  const contract = agentContract(interaction);
  if (contract === undefined) return;
  const submission = recoverAssistantStep(ctx.sessionManager.getBranch(), contract);
  if (submission === undefined) return;
  const responseId = submission.conversation?.lastEntryId ?? submission.assistantMessage?.entryId;
  if (responseId === undefined) return;
  await requestAccepted(client, {
    operation: "interaction.submit",
    requestId: `assistant-${interaction.requestId}-${responseId}`,
    idempotencyKey: `assistant-${interaction.requestId}-${responseId}`,
    runId: interaction.runId,
    expectedRevision: interaction.revision,
    payload: {
      requestId: interaction.requestId,
      submissionId: `assistant-${responseId}`,
      step: contract.nodeId,
      attempt: contract.attemptId,
      value: submission as unknown as JsonValue,
    },
  });
}

function pendingInteractionForSession(sessionId: string): ClientInteractiveRequest | undefined {
  return sessionSnapshots
    .get(sessionId)
    ?.pendingInteractions.map(parseInteractiveRequest)
    .find((request): request is ClientInteractiveRequest => request !== undefined);
}

function pendingDecision(sessionId: string, runId?: string): ClientInteractiveRequest | undefined {
  return sessionSnapshots
    .get(sessionId)
    ?.pendingInteractions.map(parseInteractiveRequest)
    .find(
      (request): request is ClientInteractiveRequest =>
        request !== undefined &&
        request.kind === "decision" &&
        (runId === undefined || request.runId === runId),
    );
}

function workflowRunPaused(runId: string): boolean {
  for (const session of sessionSnapshots.values()) {
    if (session.run?.runId === runId) return session.run.display.status === "paused";
  }
  return false;
}

function activeSessionRun(ctx: ExtensionContext): WorkflowRunQueueView | undefined {
  return sessionRun(ctx);
}

function sessionCommandPayload(ctx: ExtensionContext): {
  targetSessionId: string;
  coordinatorEpoch: string;
} {
  const targetSessionId = ctx.sessionManager.getSessionId();
  const session = sessionSnapshots.get(targetSessionId);
  if (
    session === undefined ||
    !session.coordinatorActive ||
    session.coordinatorEpoch === null ||
    session.branchReportRequired
  ) {
    throw new Error("Workflow session coordinator is not ready");
  }
  return { targetSessionId, coordinatorEpoch: session.coordinatorEpoch };
}

function terminalMessageForSession(
  ctx: ExtensionContext,
  runId: string,
): { workflowMessageId: string; workflowTurnId?: string } {
  const session = sessionSnapshots.get(ctx.sessionManager.getSessionId());
  const message = session?.workflowMessages
    .filter((item) => item.kind === "terminal" && item.runId === runId && item.status === "sent")
    .sort((left, right) => right.order - left.order)[0];
  if (message === undefined)
    throw new Error(`Workflow run ${runId} has no current terminal result`);
  const turn = session?.openWorkflowTurn;
  return {
    workflowMessageId: message.workflowMessageId,
    ...(turn?.workflowMessageId === message.workflowMessageId
      ? { workflowTurnId: turn.workflowTurnId }
      : {}),
  };
}

function sessionRun(ctx: ExtensionContext, runId?: string): WorkflowRunQueueView | undefined {
  const session = sessionSnapshots.get(ctx.sessionManager.getSessionId());
  if (session?.run === null || session?.run === undefined || !isRecord(session.run.queue)) {
    return undefined;
  }
  if (runId !== undefined && session.run.runId !== runId) return undefined;
  const queue = session.run.queue;
  return queue.originSessionId === ctx.sessionManager.getSessionId() ? queue : undefined;
}

async function listWorkflowMetadata(cwd: string): Promise<Array<{ name: string; source: string }>> {
  const files = await discoverWorkflows({ cwd });
  const seen = new Set(files.map((item) => item.name));
  return [
    ...files.map((item) => ({ name: item.name, source: item.source })),
    ...BUILTIN_WORKFLOW_METADATA.filter((item) => !seen.has(item.id)).map((item) => ({
      name: item.id,
      source: "builtin",
    })),
  ];
}

function toolInputToCommand(params: ReturnType<typeof parseWorkflowToolInput>): ParsedWorkflowArgs {
  switch (params.action) {
    case "list":
      return { kind: "list", ...(params.offset === undefined ? {} : { offset: params.offset }) };
    case "start":
      return { kind: "run", ref: params.workflow, input: params.input ?? {} };
    case "restart":
      return { kind: "restart", runId: params.runId };
    case "change-settings":
      return {
        kind: "change-settings",
        patch: params.patch,
        ...(params.runId === undefined ? {} : { runId: params.runId }),
        ...(params.scopeId === undefined ? {} : { scopeId: params.scopeId }),
        ...(params.expectedChangeNumber === undefined
          ? {}
          : { expectedChangeNumber: params.expectedChangeNumber }),
      };
    case "queue-follow-up":
      return {
        kind: "queue-follow-up",
        prompt: params.prompt,
        ...(params.runId === undefined ? {} : { runId: params.runId }),
      };
    case "remove-follow-up":
      return {
        kind: "remove-follow-up",
        followUpId: params.followUpId,
        ...(params.runId === undefined ? {} : { runId: params.runId }),
      };
    case "status":
      return { kind: "status", ...(params.runId === undefined ? {} : { runId: params.runId }) };
    case "pause":
    case "resume":
      return { kind: params.action };
    case "cancel":
      return {
        kind: "cancel",
        ...(params.runId === undefined ? {} : { runId: params.runId }),
      };
    case "answer":
      return {
        kind: "answer",
        input: params.input ?? {},
        ...(params.runId === undefined ? {} : { runId: params.runId }),
      };
    case "update":
    case "submit":
      throw new Error("Step operations require a pending interaction");
  }
}

async function requestAccepted(
  client: WorkflowClient,
  options: Parameters<WorkflowClient["request"]>[0],
): Promise<ClientResponse> {
  await client.ensureAvailable();
  const response =
    options.idempotencyKey === undefined
      ? await client.request(options)
      : await client.requestDurable({ ...options, idempotencyKey: options.idempotencyKey });
  if (response.outcome !== "accepted" && response.outcome !== "adopted") {
    throw new Error(response.error ?? `Workflow host rejected ${options.operation}`);
  }
  return response;
}

function interactionContract(interaction: ClientInteractiveRequest): Record<string, unknown> {
  if (!isRecord(interaction.contract)) throw new Error("Stored interaction contract is invalid");
  return interaction.contract;
}

function agentContract(interaction: ClientInteractiveRequest): AgentStepContract | undefined {
  const value = interactionContract(interaction).contract;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.workflowName !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.attemptId !== "string" ||
    (value.completion !== "submit" && value.completion !== "assistant")
  ) {
    return undefined;
  }
  return value as unknown as AgentStepContract;
}

function agentContractForWorkflowMessage(message: WorkflowMessage): AgentStepContract | undefined {
  if (message.kind !== "step" || !isRecord(message.content.details)) return undefined;
  const value = message.content.details.contract;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.workflowName !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.attemptId !== "string" ||
    (value.completion !== "submit" && value.completion !== "assistant")
  ) {
    return undefined;
  }
  return value as unknown as AgentStepContract;
}

function decisionResponse(value: unknown): HumanDecisionResponse {
  if (isRecord(value) && typeof value.choice === "string") {
    return {
      choice: value.choice,
      ...(isRecord(value.input) ? { input: value.input as Record<string, string> } : {}),
    };
  }
  if (isRecord(value) && typeof value.answer === "string") return { choice: value.answer };
  if (typeof value === "string") return { choice: value };
  throw new Error("A human decision answer requires a choice");
}

function summarizeRun(value: JsonValue | undefined): string {
  if (!isRecord(value)) return "Workflow run status is unavailable.";
  const runId = typeof value.runId === "string" ? value.runId : "unknown";
  const display = isRecord(value.display) ? value.display : undefined;
  const state = isRecord(value.state) ? value.state : undefined;
  const status =
    display !== undefined && typeof display.status === "string"
      ? display.status
      : typeof value.status === "string"
        ? value.status
        : "unknown";
  const node =
    state !== undefined && typeof state.currentNode === "string"
      ? state.currentNode
      : state !== undefined && typeof state.waitingOn === "string"
        ? state.waitingOn
        : undefined;
  const reason =
    display !== undefined && typeof display.reason === "string" ? display.reason : undefined;
  const controls =
    display !== undefined && Array.isArray(display.controls)
      ? display.controls.filter((item): item is string => typeof item === "string")
      : [];
  return [
    `Workflow ${runId} is ${status}${node === undefined ? "" : ` at ${node}`}.`,
    reason === undefined ? "" : reason,
    controls.length === 0 ? "" : `Allowed controls: ${controls.join(", ")}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function summarizeControllerResources(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length === 0) return "No controller resources.";
  const resources = value.map((item) => {
    if (!isRecord(item) || !isRecord(item.metadata)) return "unknown";
    const controller =
      typeof item.metadata.controller === "string" ? item.metadata.controller : "unknown";
    const key = typeof item.metadata.key === "string" ? item.metadata.key : "unknown";
    const generation =
      typeof item.metadata.generation === "number" ? item.metadata.generation : "unknown";
    return `${controller}/${key} generation=${generation}`;
  });
  return `Controller resources: ${resources.join(", ")}.`;
}

function jsonValue(value: unknown): JsonValue {
  return parseJson(canonicalJson(value));
}

function toolResult(message: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: message }], details };
}

function isTerminalDisplay(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value);
}

function isWorkflowSessionView(value: unknown): value is WorkflowSessionView {
  return (
    isRecord(value) &&
    value.schema === "pi-workflows.session-view.v1" &&
    typeof value.sessionId === "string" &&
    Array.isArray(value.pendingInteractions) &&
    Array.isArray(value.workflowMessages) &&
    typeof value.coordinatorEpoch === "string" &&
    typeof value.coordinatorActive === "boolean" &&
    typeof value.branchReportRequired === "boolean" &&
    (value.run === null || isRecord(value.run))
  );
}

function parseInteractiveRequest(value: unknown): ClientInteractiveRequest | undefined {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.targetSessionId !== "string" ||
    typeof value.revision !== "number" ||
    (value.kind !== "agent" && value.kind !== "assistant" && value.kind !== "decision")
  ) {
    return undefined;
  }
  return value as unknown as ClientInteractiveRequest;
}

function workflowTurnStopReason(
  messages: readonly unknown[],
  signalAborted: boolean,
): "completed" | "aborted" | "error" {
  if (
    signalAborted ||
    messages.some((message) => isRecord(message) && message.stopReason === "aborted")
  ) {
    return "aborted";
  }
  return messages.some(
    (message) =>
      isRecord(message) &&
      (message.stopReason === "error" ||
        message.stopReason === "length" ||
        typeof message.errorMessage === "string"),
  )
    ? "error"
    : "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
