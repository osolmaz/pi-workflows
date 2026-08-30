#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { builtinWorkflowCatalog } from "../builtins/catalog.js";
import { parseJson, type JsonValue } from "../state/json.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ClaimLostError, RunParkedError, errorMessage } from "../workflows/errors.js";
import { resolveWorkflowSource } from "../workflows/loader.js";
import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
  ResolvedHumanDecision,
} from "../workflows/types.js";
import { RpcStepExecutor } from "./rpc-executor.js";
import type { WorkerLaunchEnvelope } from "./state.js";
import {
  encodeWorkerLine,
  parseWorkerResponse,
  type WorkerMessage,
  type WorkerResponse,
} from "./worker-protocol.js";
import { HostBackedWorkflowStore, type WorkerStoreTransport } from "./worker-store.js";

const STARTUP_ENV = "PI_WORKFLOWS_WORKER_LAUNCH";

type WorkerBootstrap = {
  initialized: boolean;
  input: JsonValue;
  launchOptions: JsonValue;
  parentRunId: string | null;
  originSessionId: string | null;
  stateDirectory: string;
  piArgs?: string[];
  acceptedInteraction?: {
    requestId: string;
    attemptId: string;
    nodeId: string;
    submissionId: string;
    payload: JsonValue;
  };
};

class StdioWorkerTransport implements WorkerStoreTransport {
  private readonly pending = new Map<
    string,
    { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void }
  >();
  private buffered = Buffer.alloc(0);

  constructor(private readonly launch: WorkerLaunchEnvelope) {
    process.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
    process.stdin.on("error", (error) => this.failAll(error));
    process.stdin.resume();
  }

  async request(options: Parameters<WorkerStoreTransport["request"]>[0]) {
    const message: WorkerMessage = {
      schema: "pi-workflows.worker-message.v1",
      launchSchema: this.launch.schema,
      messageId: options.messageId,
      kind: options.kind,
      operation: options.operation,
      runId: this.launch.runId,
      generation: this.launch.generation,
      workerEpoch: this.launch.workerEpoch,
      expectedRevision: options.expectedRevision,
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      payload: options.payload,
    };
    const response = await this.send(message);
    if (response.outcome === "claimLost") {
      throw new ClaimLostError(this.launch.runId, "ownerChanged");
    }
    if (response.outcome === "rejected") {
      throw new Error(response.error ?? "Workflow worker message was rejected");
    }
    return {
      ...(response.result === undefined ? {} : { result: response.result }),
      ...(response.revision === undefined ? {} : { revision: response.revision }),
    };
  }

  async control(
    operation: "worker.ready" | "worker.exiting",
    payload: JsonValue,
  ): Promise<WorkerResponse> {
    return await this.send({
      schema: "pi-workflows.worker-message.v1",
      launchSchema: this.launch.schema,
      messageId: randomUUID(),
      kind: operation,
      operation,
      runId: this.launch.runId,
      generation: this.launch.generation,
      workerEpoch: this.launch.workerEpoch,
      expectedRevision: 0,
      payload,
    });
  }

  close(): void {
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("error");
    this.failAll(new Error("Workflow worker transport closed"));
  }

  private async send(message: WorkerMessage): Promise<WorkerResponse> {
    const response = new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(message.messageId, { resolve, reject });
    });
    if (!process.stdout.write(encodeWorkerLine(message))) await once(process.stdout, "drain");
    return await response;
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.byteLength > 1024 * 1024 && !this.buffered.includes(0x0a)) {
      this.failAll(new Error("Worker response exceeds 1 MiB"));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      try {
        const response = parseWorkerResponse(frame);
        const pending = this.pending.get(response.messageId);
        if (pending === undefined) throw new Error("Worker response has no pending request");
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

  constructor(
    private readonly store: HostBackedWorkflowStore,
    private readonly accepted:
      | { attemptId: string; nodeId: string; payload: JsonValue }
      | undefined,
  ) {}

  async runAgentStep(request: AgentStepRequest): Promise<AgentStepSubmission> {
    if (
      this.accepted?.nodeId === request.contract.nodeId &&
      this.accepted.attemptId === request.contract.attemptId
    ) {
      const submission = interactionSubmission(this.accepted.payload);
      const accepted = await request.accept(submission.output);
      if (accepted.ok) return { ...submission, output: accepted.value };
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

export async function runWorkflowWorker(): Promise<number> {
  const launch = readLaunchEnvelope();
  const transport = new StdioWorkerTransport(launch);
  try {
    const ready = await transport.control("worker.ready", {});
    if (ready.outcome !== "accepted" || ready.result === undefined) {
      throw new Error(ready.error ?? "Workflow host rejected worker startup");
    }
    const bootstrap = ready.result as unknown as WorkerBootstrap;
    const workflowSource = launch.workflowSource as never;
    const workflow = await resolveWorkflowSource(
      workflowSource,
      builtinWorkflowCatalog,
      launch.runId,
    );
    const store = new HostBackedWorkflowStore(launch.runId, transport, ready.revision ?? 0);
    let executor: AgentStepExecutor;
    let closeExecutor: (() => Promise<void>) | undefined;
    if (bootstrap.originSessionId !== null) {
      executor = new InteractiveExecutor(store, bootstrap.acceptedInteraction);
    } else {
      const rpc = new RpcStepExecutor({
        cwd: launch.projectPath,
        processGroup: "inherit",
        ...(bootstrap.piArgs === undefined ? {} : { piArgs: bootstrap.piArgs }),
      });
      executor = rpc;
      closeExecutor = async () => await rpc.close();
    }
    const engine = new WorkflowEngine({ store, executor });
    const launchOptions =
      typeof bootstrap.launchOptions === "object" &&
      bootstrap.launchOptions !== null &&
      !Array.isArray(bootstrap.launchOptions)
        ? (bootstrap.launchOptions as Record<string, unknown>)
        : {};
    try {
      const result = bootstrap.initialized
        ? await engine.resumeRun(workflow, launch.runId, {
            workflowSource,
            ...(bootstrap.acceptedInteraction === undefined
              ? {}
              : { acceptedInteractionAttemptId: bootstrap.acceptedInteraction.attemptId }),
          })
        : bootstrap.parentRunId === null
          ? await engine.run(workflow, bootstrap.input, { runId: launch.runId, workflowSource })
          : await engine.continueRun(workflow, bootstrap.parentRunId, bootstrap.input, {
              runId: launch.runId,
              workflowSource,
              ...(launchOptions.humanDecision === undefined
                ? {}
                : { humanDecision: launchOptions.humanDecision as ResolvedHumanDecision }),
            });
      await transport.control("worker.exiting", {
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

function readLaunchEnvelope(): WorkerLaunchEnvelope {
  const encoded = process.env[STARTUP_ENV];
  if (encoded === undefined) throw new Error("Workflow worker launch envelope is missing");
  const value = parseJson(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== "pi-workflows.worker-launch.v1"
  ) {
    throw new Error("Workflow worker launch envelope is invalid");
  }
  return value as unknown as WorkerLaunchEnvelope;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runWorkflowWorker();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
