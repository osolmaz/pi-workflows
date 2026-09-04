#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { builtinWorkflowCatalog } from "../builtins/catalog.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import { compositionMetadata } from "../workflows/composition.js";
import { WorkflowEngine } from "../workflows/engine.js";
import {
  ClaimLostError,
  RunParkedError,
  WorkflowSourceChangedError,
  errorMessage,
} from "../workflows/errors.js";
import { hashWorkflowSource, resolveWorkflowSource } from "../workflows/loader.js";
import type {
  AgentStepContract,
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedHumanDecision,
  WorkflowDefinition,
  WorkflowMountedSource,
  WorkflowRunState,
  WorkflowSource,
} from "../workflows/types.js";
import { RpcStepExecutor } from "./rpc-executor.js";
import type { WorkflowRunnerLaunchEnvelope } from "./state.js";
import { materializeRunnerContent } from "./workflow-runner-content.js";
import {
  MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
  encodeRunnerLine,
  isRunnerContentChunk,
  isRunnerContentReference,
  parseRunnerResponse,
  type WorkflowRunnerMessage,
  type WorkflowRunnerResponse,
  type WorkflowRunnerCommand,
} from "./workflow-runner-protocol.js";
import {
  ServerBackedWorkflowStore,
  type WorkflowRunnerStoreTransport,
} from "./workflow-runner-store.js";

const STARTUP_ENV = "PI_WORKFLOWS_WORKFLOW_RUNNER_LAUNCH";
const PRESENTATION_TIMEOUT_MS = 30_000;

type WorkflowRunnerBootstrap = {
  command: WorkflowRunnerCommand;
  originSessionId: string | null;
  stateDirectory: string;
  piArgs?: string[];
  candidateInteraction?: {
    requestId: string;
    attemptId: string;
    nodeId: string;
    submissionId: string;
    payload: JsonValue;
  };
};

class StdioRunnerTransport implements WorkflowRunnerStoreTransport {
  private readonly pending = new Map<
    string,
    { resolve: (response: WorkflowRunnerResponse) => void; reject: (error: Error) => void }
  >();
  private buffered = Buffer.alloc(0);

  constructor(private readonly launch: WorkflowRunnerLaunchEnvelope) {
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("error", (error) => this.failAll(error));
    process.stdin.resume();
  }

  async request(options: Parameters<WorkflowRunnerStoreTransport["request"]>[0]) {
    const message: WorkflowRunnerMessage = {
      schema: "pi-workflows.worker-message.v1",
      launchSchema: this.launch.schema,
      messageId: options.messageId,
      kind: options.kind,
      operation: options.operation,
      runId: this.launch.runId,
      generation: this.launch.generation,
      runnerEpoch: this.launch.runnerEpoch,
      expectedRevision: options.expectedRevision,
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      payload: options.payload,
    };
    const response = await this.sendResolved(message);
    if (response.outcome === "claimLost") {
      throw new ClaimLostError(this.launch.runId, "ownerChanged");
    }
    if (response.outcome === "rejected") {
      throw new Error(response.error ?? "Workflow runner message was rejected");
    }
    return {
      ...(response.result === undefined ? {} : { result: response.result }),
      ...(response.revision === undefined ? {} : { revision: response.revision }),
    };
  }

  async control(
    operation: "runner.ready" | "runner.exiting",
    payload: JsonValue,
  ): Promise<WorkflowRunnerResponse> {
    return await this.sendResolved({
      schema: "pi-workflows.worker-message.v1",
      launchSchema: this.launch.schema,
      messageId: randomUUID(),
      kind: operation,
      operation,
      runId: this.launch.runId,
      generation: this.launch.generation,
      runnerEpoch: this.launch.runnerEpoch,
      expectedRevision: 0,
      payload,
    });
  }

  close(): void {
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("error");
    this.failAll(new Error("Workflow runner transport closed"));
  }

  private async sendResolved(message: WorkflowRunnerMessage): Promise<WorkflowRunnerResponse> {
    const response = await this.send(message);
    if (!isRunnerContentReference(response.result)) return response;
    const reference = response.result;
    const expectedRevision = response.revision ?? message.expectedRevision;
    return {
      ...response,
      result: await materializeRunnerContent(reference, async (offset) => {
        const chunkResponse = await this.send({
          schema: "pi-workflows.worker-message.v1",
          launchSchema: this.launch.schema,
          messageId: randomUUID(),
          kind: "runner.progress",
          operation: "content.read",
          runId: this.launch.runId,
          generation: this.launch.generation,
          runnerEpoch: this.launch.runnerEpoch,
          expectedRevision,
          payload: { sha256: reference.sha256, offset },
        });
        if (chunkResponse.outcome === "claimLost") {
          throw new ClaimLostError(this.launch.runId, "ownerChanged");
        }
        if (chunkResponse.outcome !== "accepted" || !isRunnerContentChunk(chunkResponse.result)) {
          throw new Error(chunkResponse.error ?? "Workflow runner content read was rejected");
        }
        return chunkResponse.result;
      }),
    };
  }

  private async send(message: WorkflowRunnerMessage): Promise<WorkflowRunnerResponse> {
    const response = new Promise<WorkflowRunnerResponse>((resolve, reject) => {
      this.pending.set(message.messageId, { resolve, reject });
    });
    if (!process.stdout.write(encodeRunnerLine(message))) await once(process.stdout, "drain");
    return await response;
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (
      this.buffered.byteLength > MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES &&
      !this.buffered.includes(0x0a)
    ) {
      this.failAll(new Error("Runner response exceeds 1 MiB"));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      try {
        const response = parseRunnerResponse(frame);
        const pending = this.pending.get(response.messageId);
        if (pending === undefined) throw new Error("Runner response has no pending request");
        this.pending.delete(response.messageId);
        pending.resolve(response);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class InteractiveExecutor implements AgentStepExecutor {
  readonly assistantMessageMode = "visible" as const;
  readonly preservesDeadlineWhileParked = true;

  constructor(
    private readonly store: ServerBackedWorkflowStore,
    private readonly candidate:
      | {
          requestId: string;
          submissionId: string;
          attemptId: string;
          nodeId: string;
          payload: JsonValue;
        }
      | undefined,
  ) {}

  async runAgentStep(request: AgentStepRequest): Promise<AgentStepSubmission> {
    if (
      this.candidate?.nodeId === request.contract.nodeId &&
      this.candidate.attemptId === request.contract.attemptId
    ) {
      const submission = interactionSubmission(this.candidate.payload);
      let value: AgentStepSubmission;
      if (request.contract.completion === "assistant") {
        const accepted = validateAcceptedAssistantSubmission(submission, request.contract);
        if (!accepted.ok) return await this.rejectCandidate(accepted.error);
        value = accepted.value;
      } else {
        const accepted = await request.accept(submission.output);
        if (!accepted.ok) return await this.rejectCandidate(accepted.error);
        value = { ...submission, output: accepted.value };
      }
      await this.store.acceptInteraction({
        requestId: this.candidate.requestId,
        submissionId: this.candidate.submissionId,
        attemptId: this.candidate.attemptId,
        value: value as unknown as JsonValue,
      });
      return value;
    }
    await this.store.requestInteraction({
      attemptId: request.contract.attemptId,
      kind: request.contract.completion === "assistant" ? "assistant" : "agent",
      contract: {
        contract: request.contract,
        prompt: request.prompt,
        ...(request.presentation === undefined ? {} : { presentation: request.presentation }),
      } as JsonValue,
    });
    throw new RunParkedError();
  }

  private async rejectCandidate(error: string): Promise<never> {
    if (this.candidate === undefined) throw new RunParkedError();
    await this.store.rejectInteraction({
      requestId: this.candidate.requestId,
      submissionId: this.candidate.submissionId,
      attemptId: this.candidate.attemptId,
      error,
    });
    throw new RunParkedError();
  }
}

function interactionSubmission(payload: JsonValue): AgentStepSubmission {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, "output")
  ) {
    return payload as unknown as AgentStepSubmission;
  }
  return { output: payload };
}

export function validateAcceptedAssistantSubmission(
  submission: AgentStepSubmission,
  contract: AgentStepContract,
): { ok: true; value: AgentStepSubmission } | { ok: false; error: string } {
  if (contract.completion !== "assistant") {
    return { ok: false, error: "The interaction is not an assistant response" };
  }
  if (typeof submission.output !== "string" || submission.output.trim().length === 0) {
    return { ok: false, error: "Assistant response has no visible text" };
  }
  if (contract.maxOutputChars !== undefined && submission.output.length > contract.maxOutputChars) {
    return {
      ok: false,
      error: `Assistant response has ${submission.output.length} characters, above the configured limit of ${contract.maxOutputChars}`,
    };
  }
  const receipt = submission.assistantMessage;
  const conversation = submission.conversation;
  const digest = createHash("sha256").update(submission.output).digest("hex");
  if (
    receipt === undefined ||
    receipt.sha256 !== digest ||
    typeof receipt.entryId !== "string" ||
    receipt.entryId.length === 0 ||
    receipt.recovered !== true ||
    receipt.maxChars !== contract.maxOutputChars ||
    conversation === undefined ||
    typeof conversation.firstEntryId !== "string" ||
    conversation.firstEntryId.length === 0 ||
    conversation.lastEntryId !== receipt.entryId
  ) {
    return { ok: false, error: "Assistant response receipt is invalid" };
  }
  return {
    ok: true,
    value: {
      output: submission.output,
      assistantMessage: receipt,
      conversation,
    },
  };
}

export async function executeRunnerRunCommand(
  engine: Pick<WorkflowEngine, "run" | "resumeRun" | "continueRun">,
  workflow: WorkflowDefinition,
  runId: string,
  workflowSource: WorkflowSource,
  command: WorkflowRunnerCommand,
) {
  switch (command.kind) {
    case "start":
    case "restart":
      return await engine.run(workflow, command.input, { runId, workflowSource });
    case "resume":
      return await engine.resumeRun(workflow, runId, {
        workflowSource,
        ...(command.resumeInteractionAttemptId === undefined
          ? {}
          : { resumeInteractionAttemptId: command.resumeInteractionAttemptId }),
      });
    case "continue":
      return await engine.continueRun(workflow, command.parentRunId, command.input, {
        runId,
        workflowSource,
        ...(command.humanDecision === undefined
          ? {}
          : { humanDecision: command.humanDecision as ResolvedHumanDecision }),
      });
  }
}

export async function runWorkflowRunner(): Promise<number> {
  const launch = readLaunchEnvelope();
  const transport = new StdioRunnerTransport(launch);
  try {
    const ready = await transport.control("runner.ready", {});
    if (ready.outcome !== "accepted" || ready.result === undefined) {
      throw new Error(ready.error ?? "Workflow server rejected runner startup");
    }
    const bootstrap = ready.result as unknown as WorkflowRunnerBootstrap;
    const workflowSource = parseRunnerWorkflowSources(launch.workflowSource);
    let workflow: WorkflowDefinition;
    try {
      workflow = await resolveVerifiedWorkflow(launch.runId, workflowSource);
    } catch (error) {
      const response = await transport.control("runner.exiting", {
        status: "workflowLoadFailed",
        error: errorMessage(error),
      });
      if (response.outcome !== "accepted") {
        throw new Error(response.error ?? "Workflow server rejected the load-failure report");
      }
      return 1;
    }
    const store = new ServerBackedWorkflowStore(launch.runId, transport, ready.revision ?? 0);
    let executor: AgentStepExecutor;
    let closeExecutor: (() => Promise<void>) | undefined;
    if (bootstrap.originSessionId !== null) {
      executor = new InteractiveExecutor(store, bootstrap.candidateInteraction);
    } else {
      const rpc = new RpcStepExecutor({
        cwd: launch.projectPath,
        processGroup: "own",
        abortGraceMs: 1_000,
        registry: {
          register: async (pid) => {
            await transport.request({
              messageId: randomUUID(),
              operation: "process.register",
              kind: "runner.progress",
              expectedRevision: 0,
              payload: { pid },
            });
          },
          unregister: async (pid) => {
            await transport.request({
              messageId: randomUUID(),
              operation: "process.unregister",
              kind: "runner.progress",
              expectedRevision: 0,
              payload: { pid },
            });
          },
        },
        ...(bootstrap.piArgs === undefined ? {} : { piArgs: bootstrap.piArgs }),
      });
      const closeRpc = async () => await rpc.close();
      const onShutdown = () => {
        void closeRpc().catch((error: unknown) => {
          process.stderr.write(`Headless pi shutdown failed: ${errorMessage(error)}\n`);
        });
      };
      process.on("SIGTERM", onShutdown);
      process.on("SIGINT", onShutdown);
      executor = rpc;
      closeExecutor = async () => {
        process.removeListener("SIGTERM", onShutdown);
        process.removeListener("SIGINT", onShutdown);
        await closeRpc();
      };
    }
    const engine = new WorkflowEngine({
      store,
      executor,
      notificationSink: {
        notify: async (request) => await store.requestNotification(request),
      },
      onRunFinishing: async (_runId, state) => {
        if (state.status !== "completed" || workflow.presentationPrompt === undefined) return;
        const instructions = await resolvePresentationInstructions(workflow, state);
        await store.requestPresentation(instructions);
      },
    });
    try {
      const result = await executeRunnerRunCommand(
        engine,
        workflow,
        launch.runId,
        workflowSource.root,
        bootstrap.command,
      );
      await transport.control("runner.exiting", {
        status: result.state.status,
        traceSeq: result.state.traceSeq,
      });
      return 0;
    } finally {
      await closeExecutor?.();
    }
  } finally {
    transport.close();
  }
}

async function resolvePresentationInstructions(
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
): Promise<string> {
  const fallback = "Summarize the completed workflow result for the user in a normal response.";
  if (typeof workflow.presentationPrompt === "string") {
    return workflow.presentationPrompt.trim() || fallback;
  }
  if (workflow.presentationPrompt === undefined) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Workflow presentation prompt timed out")),
    PRESENTATION_TIMEOUT_MS,
  );
  timer.unref?.();
  const snapshot = structuredClone(state);
  try {
    const instructions = await Promise.race([
      workflow.presentationPrompt({
        state: snapshot,
        finalOutput: snapshot.finalOutput,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      }),
    ]);
    return instructions?.trim() || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

type WorkflowRunnerSources = {
  root: WorkflowSource;
  mounted: WorkflowMountedSource[];
};

function parseRunnerWorkflowSources(value: JsonValue): WorkflowRunnerSources {
  if (!isRecord(value) || !isWorkflowSource(value.root) || !Array.isArray(value.mounted)) {
    throw new Error("Workflow runner source identity is invalid");
  }
  const mounted = value.mounted;
  if (!mounted.every(isMountedWorkflowSource)) {
    throw new Error("Workflow runner mounted source identity is invalid");
  }
  return { root: value.root, mounted };
}

async function resolveVerifiedWorkflow(
  runId: string,
  sources: WorkflowRunnerSources,
): Promise<WorkflowDefinition> {
  for (const source of [sources.root, ...sources.mounted.map((mounted) => mounted.source)]) {
    if (source.kind === "file") {
      if ((await hashWorkflowSource(source.path)) !== source.hash) {
        throw new WorkflowSourceChangedError(runId);
      }
    } else {
      builtinWorkflowCatalog.resolve(source, runId);
    }
  }
  const workflow = await resolveWorkflowSource(sources.root, builtinWorkflowCatalog, runId);
  const observed = compositionMetadata(workflow)?.sources ?? [];
  if (
    canonicalJson(sortMountedSources(observed)) !==
    canonicalJson(sortMountedSources(sources.mounted))
  ) {
    throw new WorkflowSourceChangedError(runId);
  }
  return workflow;
}

function sortMountedSources(sources: WorkflowMountedSource[]): WorkflowMountedSource[] {
  return [...sources].sort((left, right) =>
    left.mountPath.join("/").localeCompare(right.mountPath.join("/")),
  );
}

function isWorkflowSource(value: unknown): value is WorkflowSource {
  return (
    isRecord(value) &&
    ((value.kind === "builtin" &&
      typeof value.id === "string" &&
      typeof value.revision === "string") ||
      (value.kind === "file" && typeof value.path === "string" && typeof value.hash === "string"))
  );
}

function isMountedWorkflowSource(value: unknown): value is WorkflowMountedSource {
  return (
    isRecord(value) &&
    Array.isArray(value.mountPath) &&
    value.mountPath.every((part) => typeof part === "string") &&
    typeof value.workflowName === "string" &&
    isWorkflowSource(value.source)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLaunchEnvelope(): WorkflowRunnerLaunchEnvelope {
  const encoded = process.env[STARTUP_ENV];
  if (encoded === undefined) throw new Error("Workflow runner launch envelope is missing");
  const value = parseJson(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== "pi-workflows.worker-launch.v1"
  ) {
    throw new Error("Workflow runner launch envelope is invalid");
  }
  return value as unknown as WorkflowRunnerLaunchEnvelope;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runWorkflowRunner();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
