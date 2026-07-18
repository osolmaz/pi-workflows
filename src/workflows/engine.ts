import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CancelledError, errorMessage, isAbortLikeError, TimeoutError } from "./errors.js";
import { resolveNext, resolveNextForOutcome, validateWorkflowDefinition } from "./graph.js";
import { extractJsonValue } from "./json.js";
import { runShellAction, shellResultFromError } from "./shell.js";
import { WorkflowRunStore, createRunId } from "./store.js";
import type {
  AgentNodeDefinition,
  AgentStepExecutor,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ShellActionNodeDefinition,
  ShellActionResult,
  WorkflowActionReceipt,
  WorkflowDefinition,
  WorkflowEngineOptions,
  WorkflowNodeContext,
  WorkflowNodeDefinition,
  WorkflowNodeOutcome,
  WorkflowNodeResult,
  WorkflowRunResult,
  WorkflowRunState,
  WorkflowStepRecord,
  WorkflowTraceEventDraft,
} from "./types.js";

const DEFAULT_NODE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS = 100;
const TITLE_TIMEOUT_MS = 30_000;
// Covers the shell SIGTERM → SIGKILL escalation (1s) plus stdio close.
const ABORT_CLEANUP_GRACE_MS = 2_000;

type NodeExecution = {
  output: unknown;
  promptText: string | null;
  action?: WorkflowActionReceipt;
};

/**
 * Metadata collected while a node runs, so a failing node still persists the
 * agent prompt it sent and the shell action it executed.
 */
type NodeExecutionMeta = {
  promptText: string | null;
  action?: WorkflowActionReceipt;
};

type NodeAttempt = {
  result: WorkflowNodeResult;
  execution: NodeExecution | null;
  error?: unknown;
};

/**
 * Executes a workflow graph step by step. Agent steps are delegated to the
 * configured executor; compute/action/checkpoint nodes run inline. Every
 * state transition is persisted to the run bundle before the engine moves on,
 * so a live viewer can follow along by watching the bundle directory.
 */
export class WorkflowEngine {
  private readonly executor: AgentStepExecutor;
  private readonly store: WorkflowRunStore;
  private readonly defaultNodeTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly onEvent?: WorkflowEngineOptions["onEvent"];
  private activeAbort: AbortController | null = null;
  private cancelled = false;

  constructor(options: WorkflowEngineOptions) {
    this.executor = options.executor;
    this.store = new WorkflowRunStore(options.outputRoot);
    this.defaultNodeTimeoutMs = options.defaultNodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.onEvent = options.onEvent;
  }

  get outputRoot(): string {
    return this.store.outputRoot;
  }

  /** Abort the currently running node and mark the run cancelled. */
  cancel(): void {
    this.cancelled = true;
    this.activeAbort?.abort(new CancelledError());
  }

  async run(
    workflow: WorkflowDefinition,
    input: unknown,
    options: { workflowPath?: string } = {},
  ): Promise<WorkflowRunResult> {
    validateWorkflowDefinition(workflow);
    // Fail before any bundle exists so bad input cannot leave a partial run
    // on disk or silently change shape when state.json round-trips.
    const normalizedInput = input === undefined ? null : input;
    assertJsonSerializable(normalizedInput, "Workflow run input");
    this.cancelled = false;

    const state = await this.createRunState(workflow, normalizedInput, options.workflowPath);
    const runDir = await this.store.initializeRunBundle(workflow, state);
    await this.persist(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: {
        workflowName: workflow.name,
        ...(state.runTitle ? { runTitle: state.runTitle } : {}),
      },
    });

    try {
      await this.executeGraph(workflow, state, runDir);
    } catch (error) {
      const cancelled = this.cancelled || isAbortLikeError(error);
      await this.finishRun(runDir, state, cancelled ? "cancelled" : "failed", {
        error: errorMessage(error),
      });
      return { runDir, state };
    }
    return { runDir, state };
  }

  /**
   * Resolve the run title inside a cancellation and timeout boundary. This
   * runs before any node abort controller exists, so without it a hung async
   * `title` callback would leave the session permanently occupied.
   */
  private async resolveTitleBounded(
    workflow: WorkflowDefinition,
    input: unknown,
  ): Promise<{ runTitle?: string }> {
    if (typeof workflow.title !== "function") {
      return resolveRunTitle(workflow, input);
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    const timer = setTimeout(
      () => abort.abort(new TimeoutError(TITLE_TIMEOUT_MS)),
      TITLE_TIMEOUT_MS,
    );
    try {
      return await Promise.race([resolveRunTitle(workflow, input), abortRejection(abort.signal)]);
    } finally {
      clearTimeout(timer);
      this.activeAbort = null;
    }
  }

  private async createRunState(
    workflow: WorkflowDefinition,
    input: unknown,
    workflowPath: string | undefined,
  ): Promise<WorkflowRunState> {
    const now = new Date().toISOString();
    return {
      runId: createRunId(workflow.name),
      workflowName: workflow.name,
      ...(await this.resolveTitleBounded(workflow, input)),
      ...(workflowPath !== undefined ? { workflowPath } : {}),
      startedAt: now,
      updatedAt: now,
      status: "running",
      input,
      outputs: {},
      results: {},
      steps: [],
    };
  }

  private async executeGraph(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
  ): Promise<void> {
    const maxSteps = workflow.maxSteps ?? this.maxSteps;
    let currentNodeId: string | null = workflow.startAt;
    let executedSteps = 0;
    let lastOutput: unknown;

    while (currentNodeId !== null) {
      executedSteps += 1;
      if (executedSteps > maxSteps) {
        throw new Error(
          `Workflow exceeded maxSteps=${maxSteps}; aborting to avoid an unbounded loop`,
        );
      }

      const node = workflow.nodes[currentNodeId];
      if (!node) {
        throw new Error(`Workflow node is missing: ${currentNodeId}`);
      }

      const attempt = await this.executeNode(workflow, state, runDir, currentNodeId, node);
      this.recordAttempt(state, attempt);
      await this.persist(runDir, state, {
        scope: "node",
        type: attempt.result.outcome === "ok" ? "node_finished" : "node_failed",
        nodeId: attempt.result.nodeId,
        attemptId: attempt.result.attemptId,
        payload: {
          outcome: attempt.result.outcome,
          durationMs: attempt.result.durationMs,
          ...(attempt.result.error !== undefined ? { error: attempt.result.error } : {}),
        },
      });

      if (attempt.result.outcome !== "ok") {
        currentNodeId = this.routeAfterFailure(workflow, state, attempt);
        continue;
      }

      lastOutput = attempt.result.output;
      if (node.nodeType === "checkpoint") {
        await this.finishRun(runDir, state, "waiting", {
          waitingOn: attempt.result.nodeId,
          finalOutput: lastOutput,
        });
        return;
      }
      currentNodeId = resolveNext(
        workflow.edges,
        attempt.result.nodeId,
        attempt.result.output,
        attempt.result,
      );
    }

    await this.finishRun(runDir, state, "completed", { finalOutput: lastOutput });
  }

  private routeAfterFailure(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    attempt: NodeAttempt,
  ): string | null {
    const next = resolveNextForOutcome(workflow.edges, attempt.result.nodeId, attempt.result);
    if (next !== null) {
      return next;
    }
    if (attempt.result.outcome === "cancelled" || this.cancelled) {
      throw new CancelledError();
    }
    if (attempt.result.outcome === "timed_out") {
      state.status = "timed_out";
    }
    throw attempt.error instanceof Error
      ? attempt.error
      : new Error(attempt.result.error ?? `Workflow node failed: ${attempt.result.nodeId}`);
  }

  private recordAttempt(state: WorkflowRunState, attempt: NodeAttempt): void {
    state.results[attempt.result.nodeId] = attempt.result;
    if (attempt.result.outcome === "ok") {
      state.outputs[attempt.result.nodeId] = attempt.result.output;
    } else {
      // A failed repeat attempt supersedes an earlier success; stale output
      // must not survive next to a non-ok latest result.
      delete state.outputs[attempt.result.nodeId];
    }
    const step: WorkflowStepRecord = {
      attemptId: attempt.result.attemptId,
      nodeId: attempt.result.nodeId,
      nodeType: attempt.result.nodeType,
      outcome: attempt.result.outcome,
      startedAt: attempt.result.startedAt,
      finishedAt: attempt.result.finishedAt,
      promptText: attempt.execution?.promptText ?? null,
      // `undefined` would drop the required field during JSON serialization.
      output: attempt.result.output ?? null,
      ...(attempt.result.error !== undefined ? { error: attempt.result.error } : {}),
      ...(attempt.execution?.action !== undefined ? { action: attempt.execution.action } : {}),
    };
    state.steps.push(step);
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeType;
    delete state.currentNodeStartedAt;
    delete state.statusDetail;
  }

  private async executeNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    nodeId: string,
    node: WorkflowNodeDefinition,
  ): Promise<NodeAttempt> {
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    state.currentNode = nodeId;
    state.currentAttemptId = attemptId;
    state.currentNodeType = node.nodeType;
    state.currentNodeStartedAt = startedAt;
    if (node.statusDetail !== undefined) {
      state.statusDetail = node.statusDetail;
    }
    await this.persist(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId,
      attemptId,
      payload: { nodeType: node.nodeType },
    });

    const meta: NodeExecutionMeta = { promptText: null };
    try {
      const execution = await this.runNodeWithTimeout(
        workflow,
        state,
        runDir,
        nodeId,
        attemptId,
        node,
        meta,
      );
      return {
        result: this.createNodeResult(nodeId, node, attemptId, startedAt, "ok", execution.output),
        execution,
      };
    } catch (error) {
      const outcome = this.outcomeForError(error);
      return {
        result: {
          ...this.createNodeResult(nodeId, node, attemptId, startedAt, outcome, undefined),
          error: errorMessage(error),
        },
        // Keep whatever metadata the node produced before failing so the
        // audit history retains the agent prompt and action receipt.
        execution: {
          output: null,
          promptText: meta.promptText,
          ...(meta.action !== undefined ? { action: meta.action } : {}),
        },
        error,
      };
    }
  }

  private outcomeForError(error: unknown): WorkflowNodeOutcome {
    if (error instanceof TimeoutError) {
      return "timed_out";
    }
    if (this.cancelled || isAbortLikeError(error)) {
      return "cancelled";
    }
    return "failed";
  }

  private createNodeResult(
    nodeId: string,
    node: WorkflowNodeDefinition,
    attemptId: string,
    startedAt: string,
    outcome: WorkflowNodeOutcome,
    output: unknown,
  ): WorkflowNodeResult {
    const finishedAt = new Date().toISOString();
    return {
      attemptId,
      nodeId,
      nodeType: node.nodeType,
      outcome,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      ...(output !== undefined ? { output } : {}),
    };
  }

  private async runNodeWithTimeout(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    nodeId: string,
    attemptId: string,
    node: WorkflowNodeDefinition,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    const timeoutMs = node.timeoutMs ?? this.defaultNodeTimeoutMs;
    const abort = new AbortController();
    this.activeAbort = abort;
    if (this.cancelled) {
      throw new CancelledError();
    }

    const timer = setTimeout(() => {
      abort.abort(new TimeoutError(timeoutMs));
    }, timeoutMs);
    const dispatched = this.dispatchNode(
      workflow,
      state,
      runDir,
      nodeId,
      attemptId,
      node,
      abort.signal,
      meta,
    );
    const dispatchSettled = dispatched.then(
      () => undefined,
      () => undefined,
    );
    try {
      // Race the dispatch against the abort signal so timeouts and cancel
      // take effect even for node callbacks that never observe the signal.
      const execution = await Promise.race([dispatched, abortRejection(abort.signal)]);
      if (execution.output === undefined) {
        // JSON cannot represent undefined; normalize so the in-memory state
        // matches what the persisted bundle round-trips to.
        execution.output = null;
      }
      assertJsonSerializable(execution.output, `Node ${nodeId} output`);
      return execution;
    } catch (error) {
      if (node.nodeType === "action" && "exec" in node) {
        // Give the killed shell command a short grace period to close so its
        // action receipt lands in `meta` before the failed attempt persists.
        await Promise.race([
          dispatchSettled,
          new Promise((resolve) => setTimeout(resolve, ABORT_CLEANUP_GRACE_MS)),
        ]);
      }
      const reason: unknown = abort.signal.aborted ? abort.signal.reason : undefined;
      throw reason instanceof TimeoutError || reason instanceof CancelledError ? reason : error;
    } finally {
      clearTimeout(timer);
      this.activeAbort = null;
    }
  }

  private async dispatchNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    nodeId: string,
    attemptId: string,
    node: WorkflowNodeDefinition,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    const context = this.createNodeContext(state, signal);
    switch (node.nodeType) {
      case "agent":
        return await this.runAgentNode(
          workflow,
          state,
          runDir,
          nodeId,
          attemptId,
          node,
          context,
          signal,
          meta,
        );
      case "compute":
        return { output: await node.run(context), promptText: null };
      case "action":
        return await this.runActionNode(node, context, signal, meta);
      case "checkpoint":
        return await runCheckpointNode(node, context);
    }
  }

  private createNodeContext(state: WorkflowRunState, signal: AbortSignal): WorkflowNodeContext {
    return {
      input: state.input,
      outputs: state.outputs,
      results: state.results,
      state,
      signal,
    };
  }

  private async runAgentNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    nodeId: string,
    attemptId: string,
    node: AgentNodeDefinition,
    context: WorkflowNodeContext,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    const basePrompt = await node.prompt(context);
    const prompt = appendStepContract(
      basePrompt,
      workflow.name,
      nodeId,
      attemptId,
      node.expectedOutput,
    );
    meta.promptText = prompt;
    await this.persist(runDir, state, {
      scope: "agent",
      type: "agent_prompt_sent",
      nodeId,
      attemptId,
      payload: { prompt },
    });

    const submission = await this.executor.runAgentStep(
      {
        contract: {
          runId: state.runId,
          workflowName: workflow.name,
          nodeId,
          attemptId,
          ...(node.expectedOutput !== undefined ? { expectedOutput: node.expectedOutput } : {}),
        },
        prompt,
        accept: async (output) => await this.acceptSubmission(node, context, output),
      },
      signal,
    );
    return { output: submission.output, promptText: prompt };
  }

  private async acceptSubmission(
    node: AgentNodeDefinition,
    context: WorkflowNodeContext,
    output: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    try {
      const normalized = normalizeAgentOutput(output);
      const validated = node.validate ? await node.validate(normalized, context) : normalized;
      const value = validated === undefined ? null : validated;
      // Check here rather than after acceptance so a non-JSON validator
      // result comes back as a validation error the model can retry.
      assertJsonSerializable(value, "Step output");
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private async runActionNode(
    node: ActionNodeDefinition,
    context: WorkflowNodeContext,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    if ("exec" in node) {
      return await runShellActionNode(node, context, signal, meta);
    }
    meta.action = { actionType: "function" };
    const output = await node.run(context);
    return { output, promptText: null, action: { actionType: "function" } };
  }

  private async persist(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<void> {
    const traceEvent = await this.store.writeSnapshot(runDir, state, event);
    this.onEvent?.(traceEvent, state);
  }

  private async finishRun(
    runDir: string,
    state: WorkflowRunState,
    status: WorkflowRunState["status"],
    fields: { error?: string; waitingOn?: string; finalOutput?: unknown },
  ): Promise<void> {
    if (status === "failed" && state.status === "timed_out") {
      status = "timed_out";
    }
    state.status = status;
    state.finishedAt = new Date().toISOString();
    if (fields.error !== undefined) {
      state.error = fields.error;
    }
    if (fields.waitingOn !== undefined) {
      state.waitingOn = fields.waitingOn;
    }
    if (fields.finalOutput !== undefined) {
      state.finalOutput = fields.finalOutput;
    }
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeType;
    delete state.currentNodeStartedAt;
    await this.persist(runDir, state, {
      scope: "run",
      type: `run_${status}`,
      payload: {
        status,
        ...(fields.error !== undefined ? { error: fields.error } : {}),
        ...(fields.waitingOn !== undefined ? { waitingOn: fields.waitingOn } : {}),
      },
    });
  }
}

async function runCheckpointNode(
  node: CheckpointNodeDefinition,
  context: WorkflowNodeContext,
): Promise<NodeExecution> {
  const output = node.run ? await node.run(context) : { summary: node.summary ?? "checkpoint" };
  return { output, promptText: null };
}

function shellReceipt(result: ShellActionResult): WorkflowActionReceipt {
  return {
    actionType: "shell",
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
  };
}

async function runShellActionNode(
  node: ShellActionNodeDefinition,
  context: WorkflowNodeContext,
  signal: AbortSignal,
  meta: NodeExecutionMeta,
): Promise<NodeExecution> {
  const spec = await node.exec(context);
  let result: ShellActionResult;
  try {
    result = await runShellAction(spec, signal);
  } catch (error) {
    const failed = shellResultFromError(error);
    if (failed) {
      meta.action = shellReceipt(failed);
    }
    throw error;
  }
  meta.action = shellReceipt(result);
  const output = node.parse ? await node.parse(result, context) : result;
  return { output, promptText: null, action: shellReceipt(result) };
}

/** Rejects with the abort reason once the signal fires; never resolves. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const reason: unknown = signal.reason ?? new CancelledError();
      reject(reason instanceof Error ? reason : new CancelledError(String(reason)));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Outputs are persisted to the run bundle, so they must be JSON-serializable.
 * Failing here turns a bad callback return value into a normal node failure
 * instead of corrupting the run state.
 */
function assertJsonSerializable(value: unknown, what: string): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${what} is non-JSON-serializable: ${errorMessage(error)}`);
  }
  if (encoded === undefined || !isDeepStrictEqual(JSON.parse(encoded), value)) {
    throw new Error(
      `${what} does not survive a JSON round-trip. ` +
        `Use plain JSON values (no functions, dates, NaN, or undefined properties).`,
    );
  }
}

/**
 * Models occasionally submit the step output as a JSON-encoded string. Accept
 * that by parsing tolerantly, falling back to the raw string.
 */
function normalizeAgentOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  try {
    return extractJsonValue(output);
  } catch {
    return output;
  }
}

/**
 * The step contract appended to every agent-node prompt. This is the
 * documented standard for how the model completes a workflow step.
 */
export function appendStepContract(
  prompt: string,
  workflowName: string,
  nodeId: string,
  attemptId: string,
  expectedOutput: string | undefined,
): string {
  return [
    prompt.trimEnd(),
    "",
    "---",
    `Workflow step contract (workflow: ${workflowName}, step: ${nodeId}, attempt: ${attemptId})`,
    "",
    "Complete this step by calling the `workflow` tool exactly once with:",
    `{"step": ${JSON.stringify(nodeId)}, "attempt": ${JSON.stringify(attemptId)}, "output": <your result>}`,
    `Expected output: ${expectedOutput ?? "a JSON object with your result"}`,
    "The step is complete only after the workflow tool accepts the output.",
    "If the tool reports a validation error, correct the output and call it again.",
  ].join("\n");
}

async function resolveRunTitle(
  workflow: WorkflowDefinition,
  input: unknown,
): Promise<{ runTitle?: string }> {
  if (typeof workflow.title === "string") {
    return { runTitle: workflow.title };
  }
  if (typeof workflow.title === "function") {
    const title = await workflow.title({ input, workflowName: workflow.name });
    return title !== undefined ? { runTitle: title } : {};
  }
  return {};
}
