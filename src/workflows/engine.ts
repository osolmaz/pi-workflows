import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveArtifacts } from "./artifacts.js";
import {
  CancelledError,
  errorMessage,
  isAbortLikeError,
  isClaimLostError,
  isRunParkedError,
  RunParkedError,
  TimeoutError,
  WorkflowSourceChangedError,
} from "./errors.js";
import { resolveNext, resolveNextForOutcome, validateWorkflowDefinition } from "./graph.js";
import { extractJsonValue } from "./json.js";
import { runShellAction, shellResultFromError } from "./shell.js";
import { RUN_STATE_SCHEMA, WorkflowRunStore, createRunId, readRunBundle } from "./store.js";
import type {
  AgentNodeDefinition,
  AgentStepExecutor,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ConversationRange,
  ShellActionNodeDefinition,
  ShellActionResult,
  WorkflowActionContext,
  WorkflowActionReceipt,
  WorkflowDefinition,
  WorkflowEngineOptions,
  WorkflowNodeContext,
  WorkflowNodeDefinition,
  WorkflowNodeOutcome,
  WorkflowNodeResult,
  WorkflowNotificationSink,
  WorkflowRunResult,
  WorkflowRunState,
  WorkflowSource,
  WorkflowStepRecord,
  WorkflowTraceEventDraft,
  WorkflowUpdateInput,
  WorkflowUpdateReceipt,
} from "./types.js";
import { UpdateRateLimiter, updateReceipt, validateWorkflowUpdate } from "./updates.js";

const DEFAULT_NODE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS = 100;
const TITLE_TIMEOUT_MS = 30_000;
const TIMEOUT_RESOLUTION_TIMEOUT_MS = 30_000;
// Covers the shell SIGTERM → SIGKILL escalation (1s) plus stdio close.
const ABORT_CLEANUP_GRACE_MS = 2_000;

type NodeExecution = {
  output: unknown;
  promptText: string | null;
  action?: WorkflowActionReceipt;
  conversation?: ConversationRange;
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
  private readonly notificationSink: WorkflowNotificationSink | undefined;
  private readonly store: WorkflowRunStore;
  private readonly defaultNodeTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly onEvent?: WorkflowEngineOptions["onEvent"];
  private readonly onRunStarted?: WorkflowEngineOptions["onRunStarted"];
  private readonly onRunFinishing?: WorkflowEngineOptions["onRunFinishing"];
  private activeAbort: AbortController | null = null;
  private activeAttempt:
    | {
        runDir: string;
        state: WorkflowRunState;
        nodeId: string;
        attemptId: string;
        signal: AbortSignal;
      }
    | undefined;
  private readonly updateLimiters = new Map<string, UpdateRateLimiter>();
  private readonly updatePublications = new Map<string, Promise<WorkflowUpdateReceipt>>();
  private cancelled = false;
  private parked = false;
  private paused = false;
  private wakePause: (() => void) | null = null;

  constructor(options: WorkflowEngineOptions) {
    this.executor = options.executor;
    this.notificationSink = options.notificationSink;
    this.store = options.store ?? new WorkflowRunStore(options.outputRoot);
    this.defaultNodeTimeoutMs = options.defaultNodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.onEvent = options.onEvent;
    this.onRunStarted = options.onRunStarted;
    this.onRunFinishing = options.onRunFinishing;
  }

  get outputRoot(): string {
    return this.store.outputRoot;
  }

  /** Publish a durable update for the currently active attempt without completing it. */
  async publishUpdate(
    step: string,
    attempt: string,
    input: WorkflowUpdateInput,
    idempotencyKey?: string,
  ): Promise<WorkflowUpdateReceipt> {
    const active = this.activeAttempt;
    if (
      active === undefined ||
      active.nodeId !== step ||
      active.attemptId !== attempt ||
      active.signal.aborted
    ) {
      throw new Error(
        `Workflow step ${JSON.stringify(step)} attempt ${JSON.stringify(attempt)} is not active`,
      );
    }
    const receiptKey =
      idempotencyKey === undefined
        ? undefined
        : `${active.state.runId}:${active.attemptId}:${idempotencyKey}`;
    if (receiptKey !== undefined) {
      const prior = this.updatePublications.get(receiptKey);
      if (prior !== undefined) return await prior;
    }
    const publication = (async () => {
      const update = validateWorkflowUpdate(input);
      let limiter = this.updateLimiters.get(active.state.runId);
      if (limiter === undefined) {
        limiter = new UpdateRateLimiter();
        this.updateLimiters.set(active.state.runId, limiter);
      }
      limiter.take();
      const { event, record } = await this.store.publishUpdate(
        active.runDir,
        active.state,
        active.nodeId,
        active.attemptId,
        update,
        { signal: active.signal },
      );
      try {
        this.onEvent?.(event, active.state);
      } catch {
        // UI and logging observers never determine workflow correctness.
      }
      return updateReceipt(record);
    })();
    if (receiptKey !== undefined) this.updatePublications.set(receiptKey, publication);
    return await publication;
  }

  /** Abort the currently running node and mark the run cancelled. */
  cancel(): void {
    this.cancelled = true;
    this.activeAbort?.abort(new CancelledError());
    // A run held at a pause boundary has no active node to abort; wake it so
    // it can observe the cancellation.
    this.wakePause?.();
  }

  /**
   * Stop without a terminal event so another runner can claim and resume
   * the run. The active node aborts; its partial attempt is never recorded,
   * so resume reruns that node from its last persisted boundary.
   */
  park(): void {
    this.parked = true;
    this.activeAbort?.abort(new CancelledError());
    this.wakePause?.();
  }

  /**
   * Request a pause. The current step finishes normally; the engine then
   * holds before dispatching the next node until `resume` (or `cancel`).
   */
  pause(): void {
    this.paused = true;
  }

  /** Release a pause requested with `pause`. */
  resume(): void {
    this.paused = false;
    this.wakePause?.();
  }

  /** True when a pause has been requested or the run is already held. */
  get pauseRequested(): boolean {
    return this.paused;
  }

  async run(
    workflow: WorkflowDefinition,
    input: unknown,
    options: { workflowSource?: WorkflowSource; runId?: string } = {},
  ): Promise<WorkflowRunResult> {
    validateWorkflowDefinition(workflow);
    // Fail before any bundle exists so bad input cannot leave a partial run
    // on disk or silently change shape when state.json round-trips.
    const normalizedInput = input === undefined ? null : input;
    assertJsonSerializable(normalizedInput, "Workflow run input");
    if (options.runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(options.runId)) {
      throw new Error(`Invalid workflow run id: ${JSON.stringify(options.runId)}`);
    }
    this.cancelled = false;
    this.paused = false;
    this.parked = false;

    const state = await this.createRunState(
      workflow,
      normalizedInput,
      options.workflowSource,
      options.runId,
    );
    const runDir = await this.store.initializeRunBundle(workflow, state);
    await this.persist(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: {
        workflowName: workflow.name,
        ...(state.runTitle ? { runTitle: state.runTitle } : {}),
        input: state.input,
      },
    });
    // Awaited so anything the hook writes (e.g. a session binding and its
    // `session_bound` event) lands before node events and can never trail
    // the terminal event of a fast run.
    await this.onRunStarted?.(runDir, state);

    try {
      await this.executeGraph(workflow, state, runDir);
    } catch (error) {
      if (isRunParkedError(error) || this.parked) {
        return { runDir, state };
      }
      await this.finishAfterError(runDir, state, error);
      return { runDir, state };
    }
    return { runDir, state };
  }

  /**
   * Resume an interrupted run at the node it stopped on. The caller must
   * hold the run's queue claim. Completed nodes replay from the recorded
   * state; only the interrupted node and everything downstream rerun.
   */
  async resumeRun(
    workflow: WorkflowDefinition,
    runId: string,
    options: { workflowSource?: WorkflowSource; force?: boolean } = {},
  ): Promise<WorkflowRunResult> {
    validateWorkflowDefinition(workflow);
    // Reset before any await: a park or cancel landing during preparation
    // must survive, or a host drain would hang while the run executes.
    this.cancelled = false;
    this.paused = false;
    this.parked = false;
    const bundle = await this.store.prepareRunResume(runId);
    const { runDir } = bundle;
    const state = bundle.state;
    const sourceMismatch = workflowSourceMismatch(state, options.workflowSource);
    if (sourceMismatch && options.force !== true) {
      throw new WorkflowSourceChangedError(runId);
    }

    const point = this.resumePointFor(workflow, state, "wait");
    // A resumed run starts unpaused; the operator can pause again. The
    // interrupted node's stale in-flight markers go away before the resume
    // event so the projection matches what the engine is about to do.
    delete state.paused;
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeStartedAt;
    delete state.statusDetail;
    await this.persist(runDir, state, {
      scope: "run",
      type: "run_resumed",
      payload: {
        ...(point.nodeId !== null ? { resumeAt: point.nodeId } : {}),
        replayedSteps: state.steps.length,
        ...(sourceMismatch ? { workflowSourceMismatch: true, forced: true } : {}),
      },
    });
    await this.onRunStarted?.(runDir, state);

    if (point.nodeId === null) {
      // The last recorded transition already finished the graph; the crash
      // happened before the terminal event was written. A finished
      // checkpoint restores its waiting gate rather than completing.
      if (point.waitingOn !== undefined) {
        await this.finishRun(runDir, state, "waiting", {
          waitingOn: point.waitingOn,
          finalOutput: point.lastOutput,
        });
      } else if (point.failedResult === undefined) {
        await this.finishRun(runDir, state, "completed", { finalOutput: point.lastOutput });
      } else {
        const timedOut = point.failedResult.outcome === "timed_out";
        await this.finishRun(runDir, state, timedOut ? "timed_out" : "failed", {
          error: point.failedResult.error ?? `Workflow node failed: ${point.failedResult.nodeId}`,
        });
      }
      return { runDir, state };
    }

    try {
      await this.executeGraph(
        workflow,
        state,
        runDir,
        point.nodeId,
        state.steps.length,
        point.lastOutput,
      );
    } catch (error) {
      if (isRunParkedError(error) || this.parked) {
        return { runDir, state };
      }
      await this.finishAfterError(runDir, state, error);
      return { runDir, state };
    }
    return { runDir, state };
  }

  /**
   * Start a continuation run from a checkpointed parent. The new run gets a
   * fresh bundle and trace, carries forward the parent's outputs, results,
   * and step accounting, and continues routing after the checkpoint.
   */
  async continueRun(
    workflow: WorkflowDefinition,
    parentRunId: string,
    input: unknown,
    options: { workflowSource?: WorkflowSource; runId?: string; force?: boolean } = {},
  ): Promise<WorkflowRunResult> {
    validateWorkflowDefinition(workflow);
    this.cancelled = false;
    this.paused = false;
    this.parked = false;
    const parent = await readRunBundle(this.store.runDirFor(parentRunId));
    if (parent === null) {
      throw new Error(`Cannot continue from unreadable workflow run: ${parentRunId}`);
    }
    if (parent.state.status !== "waiting" || parent.state.waitingOn === undefined) {
      throw new Error(
        `Cannot continue workflow run ${parentRunId} with status ${parent.state.status}`,
      );
    }
    const sourceMismatch = workflowSourceMismatch(parent.state, options.workflowSource);
    if (sourceMismatch && options.force !== true) {
      throw new WorkflowSourceChangedError(parentRunId);
    }

    const normalizedInput = input === undefined ? null : input;
    assertJsonSerializable(normalizedInput, "Workflow run input");
    if (options.runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(options.runId)) {
      throw new Error(`Invalid workflow run id: ${JSON.stringify(options.runId)}`);
    }

    const state = await this.createRunState(
      workflow,
      normalizedInput,
      options.workflowSource,
      options.runId,
    );
    state.parentRunId = parentRunId;
    // Artifact references point into the parent's bundle, so carried values
    // are fully resolved here and re-externalized into the new bundle.
    state.outputs = (await resolveArtifacts(
      parent.state.outputs,
      parent.runDir,
    )) as WorkflowRunState["outputs"];
    state.results = (await resolveArtifacts(
      parent.state.results,
      parent.runDir,
    )) as WorkflowRunState["results"];
    state.steps = (await resolveArtifacts(
      parent.state.steps,
      parent.runDir,
    )) as WorkflowRunState["steps"];
    state.carriedStepCount = state.steps.length;

    const runDir = await this.store.initializeRunBundle(workflow, state);
    await this.persist(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: {
        workflowName: workflow.name,
        ...(state.runTitle ? { runTitle: state.runTitle } : {}),
        input: state.input,
        continuedFrom: parentRunId,
        checkpoint: parent.state.waitingOn,
        carriedSteps: state.steps.length,
      },
    });
    await this.onRunStarted?.(runDir, state);

    const point = this.resumePointFor(workflow, state, "continue");
    if (point.nodeId === null) {
      // The checkpoint was the final node; the answer completes the chain.
      await this.finishRun(runDir, state, "completed", { finalOutput: point.lastOutput });
      return { runDir, state };
    }
    try {
      await this.executeGraph(
        workflow,
        state,
        runDir,
        point.nodeId,
        state.steps.length,
        point.lastOutput,
      );
    } catch (error) {
      if (isRunParkedError(error) || this.parked) {
        return { runDir, state };
      }
      await this.finishAfterError(runDir, state, error);
      return { runDir, state };
    }
    return { runDir, state };
  }

  /**
   * Find where a resumed run continues. An in-flight node reruns; otherwise
   * routing continues from the last recorded step. A null nodeId means the
   * graph was already done when the crash hit.
   */
  private resumePointFor(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    checkpointBehavior: "wait" | "continue",
  ): {
    nodeId: string | null;
    lastOutput?: unknown;
    failedResult?: WorkflowNodeResult;
    waitingOn?: string;
  } {
    if (state.currentNode !== undefined) {
      if (workflow.nodes[state.currentNode] === undefined) {
        throw new Error(`Resume node is missing from the workflow: ${state.currentNode}`);
      }
      return { nodeId: state.currentNode };
    }
    const lastStep = state.steps.at(-1);
    if (lastStep === undefined) {
      return { nodeId: workflow.startAt };
    }
    const result = state.results[lastStep.nodeId];
    if (result === undefined) {
      return { nodeId: lastStep.nodeId };
    }
    if (result.outcome === "ok") {
      // A recorded checkpoint means the run should be waiting; a crash
      // before the run_waiting persist restores the gate instead of
      // routing past it. The gate applies to this run's own checkpoint
      // only: a continuation's carried steps end with the parent's
      // already-answered checkpoint, and routing must continue from it.
      const isCarriedStep = state.steps.length <= (state.carriedStepCount ?? 0);
      if (
        checkpointBehavior === "wait" &&
        !isCarriedStep &&
        workflow.nodes[lastStep.nodeId]?.nodeType === "checkpoint"
      ) {
        return { nodeId: null, waitingOn: lastStep.nodeId, lastOutput: result.output };
      }
      const next = resolveNext(workflow.edges, lastStep.nodeId, result.output, result);
      return next === null
        ? { nodeId: null, lastOutput: result.output }
        : { nodeId: next, lastOutput: result.output };
    }
    const next = resolveNextForOutcome(workflow.edges, lastStep.nodeId, result);
    return next === null ? { nodeId: null, failedResult: result } : { nodeId: next };
  }

  private async finishAfterError(
    runDir: string,
    state: WorkflowRunState,
    error: unknown,
  ): Promise<void> {
    const cancelled = this.cancelled || isAbortLikeError(error);
    try {
      await this.finishRun(runDir, state, cancelled ? "cancelled" : "failed", {
        error: errorMessage(error),
      });
    } catch (finishError) {
      // A fenced-out runner must not touch the bundle, including terminal
      // projections. Propagate the claim loss instead of the node error.
      if (isClaimLostError(finishError)) {
        throw finishError;
      }
      throw error;
    }
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
    workflowSource: WorkflowSource | undefined,
    runId: string | undefined,
  ): Promise<WorkflowRunState> {
    const now = new Date().toISOString();
    return {
      schema: RUN_STATE_SCHEMA,
      traceSeq: 0,
      runId: runId ?? createRunId(workflow.name),
      workflowName: workflow.name,
      ...(await this.resolveTitleBounded(workflow, input)),
      ...(workflowSource !== undefined ? { workflowSource } : {}),
      startedAt: now,
      updatedAt: now,
      status: "running",
      input,
      outputs: {},
      results: {},
      steps: [],
      updates: [],
    };
  }

  private async executeGraph(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    startNodeId: string | null = workflow.startAt,
    executedStepsBase = 0,
    initialLastOutput?: unknown,
  ): Promise<void> {
    const maxSteps = workflow.maxSteps ?? this.maxSteps;
    let currentNodeId: string | null = startNodeId;
    let executedSteps = executedStepsBase;
    let lastOutput: unknown = initialLastOutput;

    while (currentNodeId !== null) {
      await this.holdWhilePaused(state, runDir);
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
      if (this.parked) {
        // Do not record the aborted attempt: the projection keeps the node
        // as in-flight, and resume reruns it with a fresh attempt.
        throw new RunParkedError();
      }
      this.recordAttempt(state, attempt);
      // The terminal node event carries the output, receipt, and conversation
      // linkage so the trace alone is sufficient to reconstruct the run.
      await this.persist(runDir, state, {
        scope: "node",
        type: attempt.result.outcome === "ok" ? "node_finished" : "node_failed",
        nodeId: attempt.result.nodeId,
        attemptId: attempt.result.attemptId,
        payload: {
          outcome: attempt.result.outcome,
          durationMs: attempt.result.durationMs,
          ...(attempt.result.outcome === "ok" ? { output: attempt.result.output ?? null } : {}),
          ...(attempt.result.error !== undefined ? { error: attempt.result.error } : {}),
          ...(attempt.execution?.action !== undefined ? { action: attempt.execution.action } : {}),
          ...(attempt.execution?.conversation !== undefined
            ? { conversation: attempt.execution.conversation }
            : {}),
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

  /**
   * Hold the run at the step boundary while a pause is in effect. Pausing
   * never interrupts a node mid-flight; it only delays the next dispatch.
   */
  private async holdWhilePaused(state: WorkflowRunState, runDir: string): Promise<void> {
    if (this.parked) {
      throw new RunParkedError();
    }
    if (this.cancelled) {
      throw new CancelledError();
    }
    if (!this.paused) {
      return;
    }
    state.paused = true;
    await this.persist(runDir, state, { scope: "run", type: "run_paused", payload: {} });
    while (this.paused && !this.cancelled && !this.parked) {
      await new Promise<void>((resolve) => {
        this.wakePause = resolve;
      });
    }
    this.wakePause = null;
    if (this.parked) {
      throw new RunParkedError();
    }
    delete state.paused;
    if (this.cancelled) {
      throw new CancelledError();
    }
    await this.persist(runDir, state, { scope: "run", type: "run_resumed", payload: {} });
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
      prompt: attempt.execution?.promptText ?? null,
      // `undefined` would drop the required field during JSON serialization.
      output: attempt.result.output ?? null,
      ...(attempt.result.error !== undefined ? { error: attempt.result.error } : {}),
      ...(attempt.execution?.action !== undefined ? { action: attempt.execution.action } : {}),
      ...(attempt.execution?.conversation !== undefined
        ? { conversation: attempt.execution.conversation }
        : {}),
    };
    state.steps.push(step);
    delete state.currentNode;
    delete state.currentAttemptId;
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
    const abort = new AbortController();
    const context = this.createNodeContext(state, abort.signal);
    let timer: NodeJS.Timeout | undefined;
    let dispatchSettled: Promise<void> | undefined;
    this.activeAbort = abort;
    try {
      if (this.parked) {
        // A park that landed during the node_started persist must not let the
        // node dispatch: its discarded side effects would rerun on resume.
        throw new RunParkedError();
      }
      if (this.cancelled) {
        throw new CancelledError();
      }

      const timeoutMs = await this.resolveNodeTimeout(node, context, abort);
      if (abort.signal.aborted) {
        throw abortError(abort.signal);
      }
      timer = setTimeout(() => {
        abort.abort(new TimeoutError(timeoutMs));
      }, timeoutMs);
      this.activeAttempt = { runDir, state, nodeId, attemptId, signal: abort.signal };
      const dispatched = this.dispatchNode(
        workflow,
        state,
        runDir,
        nodeId,
        attemptId,
        node,
        context,
        abort.signal,
        meta,
      );
      dispatchSettled = dispatched.then(
        () => undefined,
        () => undefined,
      );
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
      if (node.nodeType === "action" && "exec" in node && dispatchSettled !== undefined) {
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
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (!abort.signal.aborted) {
        abort.abort(new Error(`Workflow node ${nodeId} is no longer active`));
      }
      if (this.activeAbort === abort) {
        this.activeAbort = null;
      }
      if (this.activeAttempt?.attemptId === attemptId) {
        this.activeAttempt = undefined;
      }
      const receiptPrefix = `${state.runId}:${attemptId}:`;
      for (const key of this.updatePublications.keys()) {
        if (key.startsWith(receiptPrefix)) this.updatePublications.delete(key);
      }
    }
  }

  private async resolveNodeTimeout(
    node: WorkflowNodeDefinition,
    context: WorkflowNodeContext,
    abort: AbortController,
  ): Promise<number> {
    const configured = node.timeoutMs;
    if (typeof configured !== "function") {
      return assertValidTimeout(configured ?? this.defaultNodeTimeoutMs);
    }
    const timer = setTimeout(
      () => abort.abort(new TimeoutError(TIMEOUT_RESOLUTION_TIMEOUT_MS)),
      TIMEOUT_RESOLUTION_TIMEOUT_MS,
    );
    try {
      const resolved = await Promise.race([
        Promise.resolve(configured(context)),
        abortRejection(abort.signal),
      ]);
      return assertValidTimeout(resolved);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runDir: string,
    nodeId: string,
    attemptId: string,
    node: WorkflowNodeDefinition,
    context: WorkflowNodeContext,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
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
      case "notify": {
        if (this.notificationSink === undefined) {
          throw new Error(`Workflow node ${nodeId} requires a notification sink`);
        }
        const content = await node.message(context);
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new Error(`Workflow node ${nodeId} notification must be a non-empty string`);
        }
        const notificationIndex =
          state.steps.filter(
            (step) => step.nodeId === nodeId && step.nodeType === "notify" && step.outcome === "ok",
          ).length + 1;
        const receipt = await this.notificationSink.notify({
          runId: state.runId,
          workflowName: workflow.name,
          nodeId,
          attemptId,
          notificationIndex,
          kind: node.kind ?? "progress",
          content: content.trim(),
        });
        return { output: receipt, promptText: null };
      }
      case "action":
        return await this.runActionNode(node, context, nodeId, attemptId, signal, meta);
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
    if (signal.aborted) {
      // The node timed out or the run was cancelled while the async prompt
      // builder ran; a late continuation must not write into a bundle that
      // may already be terminal.
      throw abortError(signal);
    }
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
        ...(state.runTitle !== undefined || node.statusDetail !== undefined
          ? {
              presentation: {
                ...(state.runTitle !== undefined ? { runTitle: state.runTitle } : {}),
                ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
              },
            }
          : {}),
        accept: async (output) => await this.acceptSubmission(node, context, output),
        publishUpdate: async (update, idempotencyKey) =>
          await this.publishUpdate(nodeId, attemptId, update, idempotencyKey),
      },
      signal,
    );
    return {
      output: submission.output,
      promptText: prompt,
      ...(submission.conversation !== undefined ? { conversation: submission.conversation } : {}),
    };
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
    nodeId: string,
    attemptId: string,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    const actionContext: WorkflowActionContext = {
      ...context,
      publishUpdate: async (update) => await this.publishUpdate(nodeId, attemptId, update),
    };
    if ("exec" in node) {
      return await runShellActionNode(node, context, actionContext, signal, meta);
    }
    meta.action = { actionType: "function" };
    const output = await node.run(actionContext);
    return { output, promptText: null, action: { actionType: "function" } };
  }

  private async persist(
    runDir: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<void> {
    const traceEvent = await this.store.writeSnapshot(runDir, state, event);
    try {
      this.onEvent?.(traceEvent, state);
    } catch {
      // Observers (UI updates, loggers) must never determine workflow
      // correctness; a throwing observer would otherwise fail the run.
    }
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
    // Let observers (e.g. the session recorder) stop and drain before the
    // terminal event exists, so the bundle is immutable from that point on.
    try {
      await this.onRunFinishing?.(runDir, state);
    } catch {
      // Finishing the run wins over observer failures.
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
    delete state.currentNodeStartedAt;
    await this.persist(runDir, state, {
      scope: "run",
      type: `run_${status}`,
      payload: {
        status,
        ...(fields.error !== undefined ? { error: fields.error } : {}),
        ...(fields.waitingOn !== undefined ? { waitingOn: fields.waitingOn } : {}),
        ...(fields.finalOutput !== undefined ? { finalOutput: fields.finalOutput } : {}),
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
  actionContext: WorkflowActionContext,
  signal: AbortSignal,
  meta: NodeExecutionMeta,
): Promise<NodeExecution> {
  const spec = await node.exec(context);
  const streams = new Set(node.updates?.streams ?? ["stdout"]);
  let result: ShellActionResult;
  try {
    result = await runShellAction(
      spec,
      signal,
      node.updates === undefined
        ? undefined
        : async (line) => {
            if (!streams.has(line.stream)) return;
            const parsed = await node.updates?.parseLine(line, actionContext);
            if (parsed === undefined) return;
            for (const update of Array.isArray(parsed) ? parsed : [parsed]) {
              await actionContext.publishUpdate(update);
            }
          },
    );
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

function assertValidTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Node timeoutMs must resolve to a finite positive number");
  }
  return value;
}

/** The error carried by an aborted signal, normalized to an Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason ?? new CancelledError();
  return reason instanceof Error ? reason : new CancelledError(String(reason));
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
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
function workflowSourceMismatch(
  state: WorkflowRunState,
  source: WorkflowSource | undefined,
): boolean {
  if (source === undefined) return false;
  if (state.workflowSource !== undefined) {
    return !isDeepStrictEqual(state.workflowSource, source);
  }
  // Bounded compatibility check for pre-catalog file runs. Startup normally
  // converts these records with migrateLegacyWorkflowSources first.
  return (
    state.workflowHash !== undefined &&
    (source.kind !== "file" || state.workflowHash !== source.hash)
  );
}

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
    "While this step is active, you may publish non-completing updates with:",
    `{"action": "update", "step": ${JSON.stringify(nodeId)}, "attempt": ${JSON.stringify(attemptId)}, "update": {"type": "...", "key": "...", "data": {...}}}`,
    "Complete this step by calling the `workflow` tool exactly once with:",
    `{"action": "submit", "step": ${JSON.stringify(nodeId)}, "attempt": ${JSON.stringify(attemptId)}, "output": <your result>}`,
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
