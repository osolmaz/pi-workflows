import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_WORKFLOW_METADATA } from "../builtins/metadata.js";
import { SqliteControllerStore, type WorkflowRunQueueRecord } from "../controllers/sqlite.js";
import { WorkflowHostClient } from "../host/client.js";
import type { HostResponse } from "../host/protocol.js";
import { HostStateStore, type InteractiveRequestRecord } from "../host/state.js";
import { workflowStatePath } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import { errorMessage } from "../workflows/errors.js";
import { discoverWorkflows } from "../workflows/loader.js";
import { createRunId } from "../workflows/store.js";
import type { AgentStepContract, HumanDecisionResponse } from "../workflows/types.js";
import { parseControllerArgs, type ParsedControllerArgs } from "./controller-command.js";
import {
  recoverAssistantStep,
  registerWorkflowAgentStepMessageRenderer,
  WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA,
  WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
  type WorkflowAgentStepMessageDetails,
} from "./step-message.js";
import { parseWorkflowToolInput, WorkflowToolParameters } from "./workflow-tool.js";

export { parseControllerArgs, type ParsedControllerArgs } from "./controller-command.js";

export {
  PiDecisionChannel,
  TelegramDecisionChannel,
  audienceChannels,
  createTelegramChannels,
  decisionConfigDir,
  loadDecisionChannelConfig,
  verifyTelegramTokenFile,
  writeDecisionChannelProfile,
  type DecisionChannelConfig,
  type DecisionCredentialConfig,
  type HumanDecisionChannel,
  type HumanDecisionChannelAnswer,
  type HumanDecisionDeliveryResult,
  type LoadedDecisionChannelConfig,
  type PiDecisionUi,
  type SettledHumanDecision,
  type TelegramFetch,
} from "./decision-channels.js";

const INTERACTION_POLL_MS = 1_000;
const WORKFLOW_INTERACTION_MESSAGE_TYPE = "pi-workflows-interaction";

export type ParsedWorkflowArgs =
  | { kind: "list" }
  | { kind: "cancel"; runId?: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status"; runId?: string }
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
  if (/^(?:restart|change-settings|queue-follow-up|remove-follow-up)(?:\s|$)/u.test(trimmed)) {
    throw new Error("This command is not part of the hosted workflow protocol");
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
  const client = new WorkflowHostClient({ clientId: `pi-extension-${randomUUID()}` });
  let sessionContext: ExtensionContext | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let presentationTail = Promise.resolve();
  let toolTail = Promise.resolve();

  const presentInOrder = async (ctx: ExtensionContext): Promise<void> => {
    const prior = presentationTail;
    let release: (() => void) | undefined;
    presentationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await presentPendingInteraction(pi, client, ctx);
    } finally {
      release?.();
    }
  };

  const runToolInOrder = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = toolTail;
    let release: (() => void) | undefined;
    toolTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    await presentationTail;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  pi.registerCommand("workflow", {
    description:
      "Start or control a hosted workflow: /workflow <name-or-path> [task | --input-json {…}]; also: status, pause, resume, cancel, answer",
    getArgumentCompletions: async (prefix: string) => {
      const workflows = await listWorkflowMetadata(process.cwd());
      const items = [
        ...workflows.map((workflow) => ({ value: workflow.name, label: workflow.name })),
        ...["status", "pause", "resume", "cancel", "answer"].map((value) => ({
          value,
          label: value,
        })),
      ].filter((item) => item.value.startsWith(prefix));
      return items.length === 0 ? null : items;
    },
    handler: async (args, ctx) => {
      try {
        const parsed = parseWorkflowArgs(args);
        const result = await executeCommand(client, ctx, parsed);
        ctx.ui.notify(result.message, result.level ?? "info");
        await presentInOrder(ctx);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
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
      "List, start, inspect, pause, resume, cancel, answer, update, or complete hosted workflow runs.",
      "When the user asks to continue or resume the active workflow, call workflow resume immediately.",
      "Use update or submit only when a workflow step contract asks for it, and pass the exact step and attempt ids.",
      "Do not start repeated work without the user's request.",
    ].join(" "),
    parameters: WorkflowToolParameters,
    async execute(toolCallId, rawParams, _signal, _onUpdate, ctx) {
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
          const response = await requestAccepted(client, {
            operation: params.action === "update" ? "interaction.update" : "interaction.submit",
            requestId: `${params.action}-${toolCallId}`,
            idempotencyKey: toolCallId,
            runId: interaction.runId,
            expectedRevision: interaction.revision,
            payload: jsonValue({
              requestId: interaction.requestId,
              submissionId: toolCallId,
              step: params.step,
              attempt: params.attempt,
              value:
                params.action === "update" ? { update: params.update } : { output: params.output },
            }),
          });
          await presentInOrder(ctx);
          return toolResult(
            params.action === "update"
              ? "Workflow update accepted; the step remains active."
              : "Workflow step output accepted.",
            { action: params.action, response: response.receipt ?? null },
          );
        }
        const parsed = toolInputToCommand(params);
        const result = await executeCommand(client, ctx, parsed, toolCallId);
        await presentInOrder(ctx);
        return toolResult(result.message, result.details);
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    try {
      await client.ensureRunning();
      await presentInOrder(ctx);
    } catch (error) {
      ctx.ui.notify(`Workflow host is unavailable: ${errorMessage(error)}`, "warning");
    }
    pollTimer = setInterval(() => {
      if (sessionContext !== null) void presentInOrder(sessionContext).catch(() => undefined);
    }, INTERACTION_POLL_MS);
    pollTimer.unref?.();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await submitVisibleAssistantResponse(client, ctx).catch(() => undefined);
    await presentInOrder(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    sessionContext = null;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  });
}

type CommandResult = {
  message: string;
  details: Record<string, unknown>;
  level?: "info" | "warning" | "error";
};

async function executeCommand(
  client: WorkflowHostClient,
  ctx: ExtensionContext,
  command: ParsedWorkflowArgs,
  idempotencyKey: string = randomUUID(),
): Promise<CommandResult> {
  switch (command.kind) {
    case "list": {
      const workflows = await listWorkflowMetadata(ctx.cwd);
      return {
        message:
          workflows.length === 0
            ? "No workflows found."
            : `Workflows: ${workflows.map((item) => `${item.name} (${item.source})`).join(", ")}.`,
        details: { workflows },
        ...(workflows.length === 0 ? { level: "warning" as const } : {}),
      };
    }
    case "run": {
      await client.ensureRunning();
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
      if (interaction === undefined)
        throw new Error("No human decision is waiting in this session");
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
        details: { action: "answer", runId: interaction.runId, response: response.receipt ?? null },
      };
    }
  }
}

async function executeControllerCommand(
  client: WorkflowHostClient,
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

async function presentPendingInteraction(
  pi: ExtensionAPI,
  client: WorkflowHostClient,
  ctx: ExtensionContext,
): Promise<void> {
  const interaction = pendingInteractionForSession(ctx.sessionManager.getSessionId());
  if (interaction === undefined) return;
  const entries = ctx.sessionManager.getBranch();
  const existing = entries.find((entry) => interactionRequestId(entry) === interaction.requestId);
  if (existing !== undefined) {
    const entryId = entryIdentifier(existing);
    if (entryId !== undefined && interaction.presentationSessionEntryId !== entryId) {
      await requestAccepted(client, {
        operation: "interaction.update",
        requestId: `present-${interaction.requestId}-${entryId}`,
        idempotencyKey: `present-${interaction.requestId}-${entryId}`,
        runId: interaction.runId,
        expectedRevision: interaction.revision,
        payload: { requestId: interaction.requestId, sessionEntryId: entryId },
      });
    }
    return;
  }
  if (interaction.presentationSessionEntryId !== null) return;
  const claim = await requestAccepted(client, {
    operation: "interaction.update",
    requestId: `claim-presentation-${interaction.requestId}-${interaction.revision}-${client.clientId}`,
    idempotencyKey: `claim-presentation-${interaction.requestId}-${interaction.revision}-${client.clientId}`,
    runId: interaction.runId,
    expectedRevision: interaction.revision,
    payload: { requestId: interaction.requestId, claimPresentation: true },
  });
  if (claim.revision === undefined) throw new Error("Presentation claim has no revision");
  const presentationRevision = claim.revision;
  const contract = interactionContract(interaction);
  if (interaction.kind === "decision") {
    pi.sendMessage(
      {
        customType: WORKFLOW_INTERACTION_MESSAGE_TYPE,
        content: decisionPrompt(contract),
        display: true,
        details: { requestId: interaction.requestId, runId: interaction.runId, kind: "decision" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } else {
    const agent = agentContract(interaction);
    if (agent === undefined) throw new Error("Stored workflow agent contract is invalid");
    const details: WorkflowAgentStepMessageDetails & { requestId: string } = {
      schema: WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA,
      kind: "step",
      contract: agent,
      requestId: interaction.requestId,
      ...(isRecord(contract.presentation) ? { presentation: contract.presentation as never } : {}),
    };
    pi.sendMessage(
      {
        customType: WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
        content:
          typeof contract.prompt === "string" ? contract.prompt : "Continue the workflow step.",
        display: true,
        details,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
  const inserted = ctx.sessionManager
    .getBranch()
    .find((entry) => interactionRequestId(entry) === interaction.requestId);
  const entryId = entryIdentifier(inserted);
  if (entryId === undefined) return;
  await requestAccepted(client, {
    operation: "interaction.update",
    requestId: `present-${interaction.requestId}-${entryId}`,
    idempotencyKey: `present-${interaction.requestId}-${entryId}`,
    runId: interaction.runId,
    expectedRevision: presentationRevision,
    payload: { requestId: interaction.requestId, sessionEntryId: entryId },
  });
}

async function submitVisibleAssistantResponse(
  client: WorkflowHostClient,
  ctx: ExtensionContext,
): Promise<void> {
  const interaction = pendingInteractionForSession(ctx.sessionManager.getSessionId());
  if (interaction === undefined || interaction.kind !== "assistant") return;
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

function pendingInteractionForSession(sessionId: string): InteractiveRequestRecord | undefined {
  try {
    const store = new HostStateStore(workflowStatePath(), { readOnly: true });
    try {
      return store.listPendingInteractions(sessionId)[0];
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

function pendingDecision(sessionId: string, runId?: string): InteractiveRequestRecord | undefined {
  try {
    const store = new HostStateStore(workflowStatePath(), { readOnly: true });
    try {
      return store
        .listPendingInteractions(sessionId)
        .find(
          (request) =>
            request.kind === "decision" && (runId === undefined || request.runId === runId),
        );
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

function activeSessionRun(ctx: ExtensionContext): WorkflowRunQueueRecord | undefined {
  try {
    const store = new SqliteControllerStore(workflowStatePath(), { readOnly: true, global: true });
    try {
      return store.findSessionReservation(ctx.sessionManager.getSessionId());
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
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
      return { kind: "list" };
    case "start":
      return { kind: "run", ref: params.workflow, input: params.input ?? {} };
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
  client: WorkflowHostClient,
  options: Parameters<WorkflowHostClient["request"]>[0],
): Promise<HostResponse> {
  await client.ensureRunning();
  const response = await client.request(options);
  if (response.outcome !== "accepted" && response.outcome !== "adopted") {
    throw new Error(response.error ?? `Workflow host rejected ${options.operation}`);
  }
  return response;
}

function interactionContract(interaction: InteractiveRequestRecord): Record<string, unknown> {
  if (!isRecord(interaction.contract)) throw new Error("Stored interaction contract is invalid");
  return interaction.contract;
}

function agentContract(interaction: InteractiveRequestRecord): AgentStepContract | undefined {
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

function interactionRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "custom_message" || !isRecord(value.details)) {
    return undefined;
  }
  return typeof value.details.requestId === "string" ? value.details.requestId : undefined;
}

function entryIdentifier(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function decisionPrompt(contract: Record<string, unknown>): string {
  const title = typeof contract.title === "string" ? contract.title : "Workflow decision";
  const choices = isRecord(contract.choices) ? Object.keys(contract.choices).join(", ") : "";
  return [
    title,
    choices.length === 0 ? "" : `Choices: ${choices}`,
    "Answer with the workflow tool action `answer`.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const status = typeof value.status === "string" ? value.status : "unknown";
  return `Workflow ${runId} is ${status}.`;
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

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
