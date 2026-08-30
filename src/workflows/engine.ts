import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { StaleResourceError } from "../state/mutation.js";
import {
  compileWorkflowDefinition,
  compositionMetadata,
  isCompiledWorkflow,
} from "./composition.js";
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
import { createHumanDecisionRequest, validateHumanDecisionResponse } from "./human-decision.js";
import { extractJsonValue } from "./json.js";
import {
  parseWorkflowSettingsValue,
  resolveInitialWorkflowSettings,
  type WorkflowSettingsScopeRecord,
} from "./settings.js";
import { runShellAction, shellResultFromError } from "./shell.js";
import {
  RUN_STATE_SCHEMA,
  WorkflowRunStore,
  createDefinitionSnapshot,
  createRunId,
  type WorkflowExecutionStore,
} from "./store.js";
import type {
  ResolvedHumanDecision,
  AgentExpectedOutput,
  AgentNodeDefinition,
  AgentStepExecutor,
  AssistantMessageOutput,
  AssistantMessageReceipt,
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
  HumanDecisionRequest,
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
const MAX_SETTINGS_ROUTE_RETRIES = 16;

type NodeExecution = {
  output: unknown;
  promptText: string | null;
  action?: WorkflowActionReceipt;
  assistantMessage?: AssistantMessageReceipt;
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
  settings?: WorkflowSettingsScopeRecord;
  error?: unknown;
};

type ResumedNodeAttempt = {
  nodeId: string;
  attemptId: string;
  startedAt: string;
  settings?: WorkflowSettingsScopeRecord;
};

/**
 * Executes a workflow graph step by step. Agent steps are delegated to the
 * configured executor; compute/action/checkpoint nodes run inline. Every
 * state transition is persisted to the SQLite run state before the engine moves on,
 * so a live viewer can follow committed SQLite events.
 */
export class WorkflowEngine {
  private readonly executor: AgentStepExecutor;
  private readonly notificationSink: WorkflowNotificationSink | undefined;
  private readonly store: WorkflowExecutionStore;
  private readonly defaultNodeTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly onEvent?: WorkflowEngineOptions["onEvent"];
  private readonly onRunStarted?: WorkflowEngineOptions["onRunStarted"];
  private readonly onRunFinishing?: WorkflowEngineOptions["onRunFinishing"];
  private activeAbort: AbortController | null = null;
  private activeAttempt:
    | {
        runId: string;
        state: WorkflowRunState;
        nodeId: string;
        attemptId: string;
        settingsScopeId?: string;
        signal: AbortSignal;
      }
    | undefined;
  private readonly updateLimiters = new Map<string, UpdateRateLimiter>();
  private readonly updatePublications = new Map<string, Promise<WorkflowUpdateReceipt>>();
  private cancelled = false;
  private parked = false;
  private paused = false;
  private presentationRequired = false;
  private wakePause: (() => void) | null = null;

  constructor(options: WorkflowEngineOptions) {
    this.executor = options.executor;
    this.notificationSink = options.notificationSink;
    this.store = options.store ?? new WorkflowRunStore(options.databasePath);
    this.defaultNodeTimeoutMs = options.defaultNodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.onEvent = options.onEvent;
    this.onRunStarted = options.onRunStarted;
    this.onRunFinishing = options.onRunFinishing;
  }

  get databasePath(): string {
    return this.store.databasePath;
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
        active.runId,
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

  get activeSettingsScopeId(): string | undefined {
    return this.activeAttempt?.settingsScopeId;
  }

  async run(
    workflow: WorkflowDefinition,
    input: unknown,
    options: { workflowSource?: WorkflowSource; runId?: string } = {},
  ): Promise<WorkflowRunResult> {
    workflow = isCompiledWorkflow(workflow) ? workflow : compileWorkflowDefinition(workflow);
    validateWorkflowDefinition(workflow);
    this.presentationRequired = workflow.presentationPrompt !== undefined;
    // Fail before any run row exists so bad input cannot leave partial state.
    const suppliedInput = input === undefined ? null : input;
    const normalizedInput = workflow.input ? await workflow.input(suppliedInput) : suppliedInput;
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
    const initialSettings =
      workflow.settings === undefined
        ? []
        : [
            {
              mountPath: "",
              invocation: 1,
              settings: (await resolveInitialWorkflowSettings(workflow.settings, normalizedInput))
                .json,
            },
          ];
    const runId = await this.store.initializeRun(workflow, state, { initialSettings });
    await this.persist(runId, state, {
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
    await this.onRunStarted?.(runId, state);

    try {
      await this.executeGraph(workflow, state, runId);
    } catch (error) {
      if (isClaimLostError(error)) throw error;
      if (isRunParkedError(error) || this.parked) {
        return { runId, state };
      }
      await this.finishAfterError(runId, state, error);
      return { runId, state };
    }
    return { runId, state };
  }

  /**
   * Resume an interrupted run at the node it stopped on. The caller must
   * hold the run's queue claim. Completed nodes replay from the recorded
   * state; only the interrupted node and everything downstream rerun.
   */
  async resumeRun(
    workflow: WorkflowDefinition,
    runId: string,
    options: {
      workflowSource?: WorkflowSource;
      force?: boolean;
      acceptedInteractionAttemptId?: string;
    } = {},
  ): Promise<WorkflowRunResult> {
    workflow = isCompiledWorkflow(workflow) ? workflow : compileWorkflowDefinition(workflow);
    validateWorkflowDefinition(workflow);
    this.presentationRequired = workflow.presentationPrompt !== undefined;
    // Reset before any await: a park or cancel landing during preparation
    // must survive, or a host drain would hang while the run executes.
    this.cancelled = false;
    this.paused = false;
    this.parked = false;
    const loaded = await this.store.prepareRunResume(runId);
    const state = loaded.state;
    const sourceMismatch = workflowIdentityMismatch(state, workflow, options.workflowSource);
    if (sourceMismatch && options.force !== true) {
      throw new WorkflowSourceChangedError(runId);
    }

    const point = this.resumePointFor(workflow, state, "wait");
    const interruptedNode =
      state.currentNode !== undefined ? workflow.nodes[state.currentNode] : undefined;
    let resumedAttempt: ResumedNodeAttempt | undefined;
    if (
      state.currentNode !== undefined &&
      state.currentAttemptId !== undefined &&
      state.currentNodeStartedAt !== undefined &&
      interruptedNode?.nodeType === "agent" &&
      (assistantMessageConfig(interruptedNode) !== undefined ||
        options.acceptedInteractionAttemptId === state.currentAttemptId)
    ) {
      const resumedSettings = await this.persistedSettingsBinding(state);
      resumedAttempt = {
        nodeId: state.currentNode,
        attemptId: state.currentAttemptId,
        startedAt: state.currentNodeStartedAt,
        ...(resumedSettings !== undefined ? { settings: resumedSettings } : {}),
      };
    }
    // A resumed run starts unpaused. Submitted and non-agent nodes normally
    // discard stale in-flight markers and start a new attempt. A submitted
    // interaction and an assistant-message node keep their exact attempt id
    // so durable origin-session work is never detached from its contract.
    delete state.paused;
    if (resumedAttempt === undefined) {
      delete state.currentNode;
      delete state.currentAttemptId;
      delete state.currentNodeStartedAt;
      delete state.currentSettingsScopeId;
      delete state.currentSettingsChangeNumber;
      delete state.currentSettingsHash;
      delete state.statusDetail;
    }
    await this.persist(runId, state, {
      scope: "run",
      type: "run_resumed",
      payload: {
        ...(point.nodeId !== null ? { resumeAt: point.nodeId } : {}),
        ...(resumedAttempt !== undefined ? { resumedAttemptId: resumedAttempt.attemptId } : {}),
        replayedSteps: state.steps.length,
        ...(sourceMismatch ? { workflowSourceMismatch: true, forced: true } : {}),
      },
    });
    await this.onRunStarted?.(runId, state);

    if (point.nodeId === null) {
      // The last recorded transition already finished the graph; the crash
      // happened before the terminal event was written. A finished
      // checkpoint restores its waiting gate rather than completing.
      if (point.waitingOn !== undefined) {
        await this.finishRun(runId, state, "waiting", {
          waitingOn: point.waitingOn,
          finalOutput: point.lastOutput,
        });
      } else if (point.failedResult === undefined) {
        await this.finishRun(runId, state, "completed", { finalOutput: point.lastOutput });
      } else {
        const timedOut = point.failedResult.outcome === "timed_out";
        await this.finishRun(runId, state, timedOut ? "timed_out" : "failed", {
          error: point.failedResult.error ?? `Workflow node failed: ${point.failedResult.nodeId}`,
        });
      }
      return { runId, state };
    }

    try {
      await this.executeGraph(
        workflow,
        state,
        runId,
        point.nodeId,
        countExecutableSteps(workflow, state.steps),
        point.lastOutput,
        resumedAttempt,
      );
    } catch (error) {
      if (isClaimLostError(error)) throw error;
      if (isRunParkedError(error) || this.parked) {
        return { runId, state };
      }
      await this.finishAfterError(runId, state, error);
      return { runId, state };
    }
    return { runId, state };
  }

  /**
   * Start a continuation run from a checkpointed parent. The new run gets a
   * fresh run and event stream, carries forward the parent's outputs, results,
   * and step accounting, and continues routing after the checkpoint.
   */
  async continueRun(
    workflow: WorkflowDefinition,
    parentRunId: string,
    input: unknown,
    options: {
      workflowSource?: WorkflowSource;
      runId?: string;
      force?: boolean;
      humanDecision?: ResolvedHumanDecision;
    } = {},
  ): Promise<WorkflowRunResult> {
    workflow = isCompiledWorkflow(workflow) ? workflow : compileWorkflowDefinition(workflow);
    validateWorkflowDefinition(workflow);
    this.presentationRequired = workflow.presentationPrompt !== undefined;
    this.cancelled = false;
    this.paused = false;
    this.parked = false;
    const parent = await this.store.readRun(parentRunId);
    if (parent === null) {
      throw new Error(`Cannot continue from unreadable workflow run: ${parentRunId}`);
    }
    if (parent.state.status !== "waiting" || parent.state.waitingOn === undefined) {
      throw new Error(
        `Cannot continue workflow run ${parentRunId} with status ${parent.state.status}`,
      );
    }
    const sourceMismatch = workflowIdentityMismatch(parent.state, workflow, options.workflowSource);
    if (sourceMismatch && options.force !== true) {
      throw new WorkflowSourceChangedError(parentRunId);
    }

    const waitingNodeId = parent.state.waitingOn;
    const waitingNode = workflow.nodes[waitingNodeId];
    const humanContract =
      waitingNode?.nodeType === "checkpoint" ? waitingNode.humanDecision : undefined;
    let acceptedResponse: unknown;
    let acceptedNodeId: string | undefined;
    let normalizedInput: unknown;
    if (humanContract !== undefined) {
      if (options.humanDecision === undefined) {
        throw new Error(`Checkpoint ${waitingNodeId} requires an accepted verified human decision`);
      }
      const request = parent.state.finalOutput as HumanDecisionRequest;
      if (
        request?.schema !== "pi-workflows.human-decision-request.v1" ||
        request.decisionId !== options.humanDecision.decisionId ||
        request.requestDigest !== options.humanDecision.requestDigest
      ) {
        throw new Error("Accepted human decision does not match the waiting request");
      }
      const durableDecision = await this.store.readResolvedHumanDecision(request.decisionId);
      if (durableDecision === null || !isDeepStrictEqual(durableDecision, options.humanDecision)) {
        throw new Error("Accepted human decision does not match the durable decision record");
      }
      acceptedResponse = validateHumanDecisionResponse(request, durableDecision.response);
      acceptedNodeId = request.nodeId;
      normalizedInput = structuredClone(parent.state.input);
    } else {
      const suppliedInput = input === undefined ? null : input;
      normalizedInput = workflow.input ? await workflow.input(suppliedInput) : suppliedInput;
    }
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
    state.outputs = structuredClone(parent.state.outputs);
    state.results = structuredClone(parent.state.results);
    state.steps = structuredClone(parent.state.steps);
    if (humanContract !== undefined && options.humanDecision !== undefined) {
      const receipt = {
        decisionId: options.humanDecision.decisionId,
        requestDigest: options.humanDecision.requestDigest,
        nodeId: acceptedNodeId ?? waitingNodeId,
        response: options.humanDecision.response,
        provenance: options.humanDecision.provenance,
        acceptedAt: options.humanDecision.acceptedAt,
        answerDigest: options.humanDecision.answerDigest,
      };
      state.humanDecision = {
        schema: "pi-workflows.human-decision-receipt.v1",
        ...receipt,
        subjectDigest: options.humanDecision.subjectDigest,
        presentationDigest: options.humanDecision.presentationDigest,
        revision: options.humanDecision.revision,
      };
      state.outputs[waitingNodeId] = acceptedResponse;
      const priorResult = state.results[waitingNodeId];
      if (priorResult === undefined) {
        throw new Error(`Waiting human decision result is missing for ${waitingNodeId}`);
      }
      state.results[waitingNodeId] = { ...priorResult, output: acceptedResponse };
      const stepIndex = state.steps.findLastIndex((step) => step.nodeId === waitingNodeId);
      if (stepIndex < 0)
        throw new Error(`Waiting human decision step is missing for ${waitingNodeId}`);
      const priorStep = state.steps[stepIndex];
      if (priorStep === undefined)
        throw new Error("Waiting human decision step became unavailable");
      state.steps[stepIndex] = { ...priorStep, output: acceptedResponse };
    }
    state.carriedStepCount = state.steps.length;

    const runId = await this.store.initializeRun(workflow, state);
    await this.persist(runId, state, {
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
    await this.onRunStarted?.(runId, state);

    const point = this.resumePointFor(workflow, state, "continue");
    if (point.nodeId === null) {
      // The checkpoint was the final node; the answer completes the chain.
      await this.finishRun(runId, state, "completed", { finalOutput: point.lastOutput });
      return { runId, state };
    }
    try {
      await this.executeGraph(
        workflow,
        state,
        runId,
        point.nodeId,
        countExecutableSteps(workflow, state.steps),
        point.lastOutput,
      );
    } catch (error) {
      if (isClaimLostError(error)) throw error;
      if (isRunParkedError(error) || this.parked) {
        return { runId, state };
      }
      await this.finishAfterError(runId, state, error);
      return { runId, state };
    }
    return { runId, state };
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
    runId: string,
    state: WorkflowRunState,
    error: unknown,
  ): Promise<void> {
    const cancelled = this.cancelled || isAbortLikeError(error);
    try {
      await this.finishRun(runId, state, cancelled ? "cancelled" : "failed", {
        error: errorMessage(error),
      });
    } catch (finishError) {
      // A fenced-out runner must not touch run state, including terminal
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
    const composition = compositionMetadata(workflow);
    return {
      schema: RUN_STATE_SCHEMA,
      traceSeq: 0,
      runId: runId ?? createRunId(workflow.name),
      workflowName: workflow.name,
      ...(await this.resolveTitleBounded(workflow, input)),
      ...(workflowSource !== undefined ? { workflowSource } : {}),
      ...(composition?.sources.length ? { workflowSources: composition.sources } : {}),
      ...(composition?.snapshot.mounts.length
        ? { definitionDigest: definitionDigest(workflow) }
        : {}),
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
    runId: string,
    startNodeId: string | null = workflow.startAt,
    executedStepsBase = 0,
    initialLastOutput?: unknown,
    resumedAttempt?: ResumedNodeAttempt,
  ): Promise<void> {
    const maxSteps = workflow.maxSteps ?? this.maxSteps;
    const composition = compositionMetadata(workflow);
    let currentNodeId: string | null = startNodeId;
    let executedSteps = executedStepsBase;
    let lastOutput: unknown = initialLastOutput;
    const settingsRouteRetries = new Map<string, number>();

    while (currentNodeId !== null) {
      await this.holdWhilePaused(state, runId);
      const isTransition =
        composition?.entries[currentNodeId] !== undefined ||
        composition?.exits[currentNodeId] !== undefined;
      if (!isTransition) {
        executedSteps += 1;
        if (executedSteps > maxSteps) {
          throw new Error(
            `Workflow exceeded maxSteps=${maxSteps}; aborting to avoid an unbounded loop`,
          );
        }
        assertInvocationStepLimit(composition, currentNodeId, state.steps);
      }

      const node = workflow.nodes[currentNodeId];
      if (!node) {
        throw new Error(`Workflow node is missing: ${currentNodeId}`);
      }

      const activeResume = resumedAttempt?.nodeId === currentNodeId ? resumedAttempt : undefined;
      resumedAttempt = undefined;
      const attempt = await this.executeNode(
        workflow,
        state,
        runId,
        currentNodeId,
        node,
        activeResume,
      );
      if (this.parked) {
        // Do not record the aborted attempt: the projection keeps the node
        // as in-flight, and resume reruns it with a fresh attempt.
        throw new RunParkedError();
      }
      const beforeRecord = structuredClone(state);
      this.recordAttempt(workflow, state, attempt);
      // The durable step row owns the output. The trace keeps the terminal fact,
      // settings binding, and compact execution metadata.
      try {
        await this.persist(runId, state, {
          scope: "node",
          type: attempt.result.outcome === "ok" ? "node_finished" : "node_failed",
          nodeId: attempt.result.nodeId,
          attemptId: attempt.result.attemptId,
          payload: {
            outcome: attempt.result.outcome,
            durationMs: attempt.result.durationMs,
            ...(attempt.result.outcome === "ok" ? { output: attempt.result.output ?? null } : {}),
            ...(attempt.result.error !== undefined ? { error: attempt.result.error } : {}),
            ...(attempt.execution?.action !== undefined
              ? { action: attempt.execution.action }
              : {}),
            ...(attempt.execution?.assistantMessage !== undefined
              ? { assistantMessage: attempt.execution.assistantMessage }
              : {}),
            ...(attempt.execution?.conversation !== undefined
              ? { conversation: attempt.execution.conversation }
              : {}),
            ...(attempt.settings !== undefined
              ? {
                  settingsScopeId: attempt.settings.scopeId,
                  settingsChangeNumber: attempt.settings.changeNumber,
                  settingsHash: attempt.settings.settingsHash,
                }
              : {}),
          },
        });
      } catch (error) {
        if (
          !(error instanceof StaleResourceError) ||
          node.nodeType !== "compute" ||
          node.settingsRoute !== true ||
          attempt.settings === undefined
        ) {
          throw error;
        }
        restoreRunState(state, beforeRecord);
        const retryCount = (settingsRouteRetries.get(currentNodeId) ?? 0) + 1;
        if (retryCount > MAX_SETTINGS_ROUTE_RETRIES) {
          throw new Error(
            `Settings route ${currentNodeId} changed more than ${MAX_SETTINGS_ROUTE_RETRIES} times before settlement`,
          );
        }
        settingsRouteRetries.set(currentNodeId, retryCount);
        const latest = await this.captureSettingsBinding(workflow, state, currentNodeId);
        if (latest === undefined) {
          throw new Error(`Settings route ${currentNodeId} lost its settings scope`);
        }
        state.currentSettingsScopeId = latest.scopeId;
        state.currentSettingsChangeNumber = latest.changeNumber;
        state.currentSettingsHash = latest.settingsHash;
        await this.persist(runId, state, {
          scope: "run",
          type: "settings_route_retried",
          nodeId: currentNodeId,
          attemptId: attempt.result.attemptId,
          payload: {
            scopeId: latest.scopeId,
            previousChangeNumber: attempt.settings.changeNumber,
            changeNumber: latest.changeNumber,
          },
        });
        resumedAttempt = {
          nodeId: currentNodeId,
          attemptId: attempt.result.attemptId,
          startedAt: attempt.result.startedAt,
          settings: latest,
        };
        executedSteps -= 1;
        continue;
      }
      settingsRouteRetries.delete(currentNodeId);

      if (attempt.result.outcome !== "ok") {
        currentNodeId = this.routeAfterFailure(workflow, state, attempt);
        continue;
      }

      const entered = composition?.entries[attempt.result.nodeId];
      if (entered !== undefined) {
        const value = attempt.result.output as { invocation?: number } | undefined;
        await this.persist(runId, state, {
          scope: "run",
          type: "include_entered",
          payload: {
            mountPath: entered.mountPath.split("/"),
            workflowName: entered.workflowName,
            invocation: value?.invocation ?? 1,
          },
        });
      }
      const exited = composition?.exits[attempt.result.nodeId];
      if (exited !== undefined) {
        const entrySteps = state.steps.filter((step) => step.nodeId === exited.mountPath);
        await this.persist(runId, state, {
          scope: "run",
          type: "include_exited",
          payload: {
            mountPath: exited.mountPath.split("/"),
            workflowName: composition?.scopes[exited.mountPath]?.workflowName ?? exited.mountName,
            invocation: entrySteps.length,
            exit: exited.exitName,
            output: attempt.result.output ?? null,
          },
        });
      }

      lastOutput = attempt.result.output;
      if (node.nodeType === "checkpoint") {
        await this.finishRun(runId, state, "waiting", {
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

    await this.finishRun(runId, state, "completed", { finalOutput: lastOutput });
  }

  /**
   * Hold the run at the step boundary while a pause is in effect. Pausing
   * never interrupts a node mid-flight; it only delays the next dispatch.
   */
  private async holdWhilePaused(state: WorkflowRunState, runId: string): Promise<void> {
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
    await this.persist(runId, state, { scope: "run", type: "run_paused", payload: {} });
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
    await this.persist(runId, state, { scope: "run", type: "run_resumed", payload: {} });
  }

  private routeAfterFailure(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    attempt: NodeAttempt,
  ): string | null {
    if (attempt.result.outcome === "cancelled" || this.cancelled) {
      throw new CancelledError();
    }
    const next = resolveNextForOutcome(workflow.edges, attempt.result.nodeId, attempt.result);
    if (next !== null) {
      return next;
    }
    if (attempt.result.outcome === "timed_out") {
      state.status = "timed_out";
    }
    throw attempt.error instanceof Error
      ? attempt.error
      : new Error(attempt.result.error ?? `Workflow node failed: ${attempt.result.nodeId}`);
  }

  private recordAttempt(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    attempt: NodeAttempt,
  ): void {
    state.results[attempt.result.nodeId] = attempt.result;
    if (attempt.result.outcome === "ok") {
      state.outputs[attempt.result.nodeId] = attempt.result.output;
    } else {
      // A failed repeat attempt supersedes an earlier success; stale output
      // must not survive next to a non-ok latest result.
      delete state.outputs[attempt.result.nodeId];
    }
    const exit = compositionMetadata(workflow)?.exits[attempt.result.nodeId];
    if (exit !== undefined && attempt.result.outcome === "ok") {
      state.outputs[exit.mountPath] = attempt.result.output;
      state.results[exit.mountPath] = { ...attempt.result, nodeId: exit.mountPath };
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
      ...(attempt.execution?.assistantMessage !== undefined
        ? { assistantMessage: attempt.execution.assistantMessage }
        : {}),
      ...(attempt.execution?.conversation !== undefined
        ? { conversation: attempt.execution.conversation }
        : {}),
      ...(attempt.settings !== undefined
        ? {
            settingsScopeId: attempt.settings.scopeId,
            settingsChangeNumber: attempt.settings.changeNumber,
            settingsHash: attempt.settings.settingsHash,
          }
        : {}),
    };
    state.steps.push(step);
    delete state.currentNode;
    delete state.currentAttemptId;
    delete state.currentNodeStartedAt;
    delete state.currentSettingsScopeId;
    delete state.currentSettingsChangeNumber;
    delete state.currentSettingsHash;
    delete state.statusDetail;
  }

  private async executeNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runId: string,
    nodeId: string,
    node: WorkflowNodeDefinition,
    resumedAttempt?: ResumedNodeAttempt,
  ): Promise<NodeAttempt> {
    const attemptId = resumedAttempt?.attemptId ?? randomUUID();
    const startedAt = resumedAttempt?.startedAt ?? new Date().toISOString();
    const settings =
      resumedAttempt?.settings ?? (await this.captureSettingsBinding(workflow, state, nodeId));
    state.currentNode = nodeId;
    state.currentAttemptId = attemptId;
    state.currentNodeStartedAt = startedAt;
    if (settings !== undefined) {
      state.currentSettingsScopeId = settings.scopeId;
      state.currentSettingsChangeNumber = settings.changeNumber;
      state.currentSettingsHash = settings.settingsHash;
    } else {
      delete state.currentSettingsScopeId;
      delete state.currentSettingsChangeNumber;
      delete state.currentSettingsHash;
    }
    if (node.statusDetail !== undefined) {
      state.statusDetail = node.statusDetail;
    }
    if (resumedAttempt === undefined) {
      await this.persist(runId, state, {
        scope: "node",
        type: "node_started",
        nodeId,
        attemptId,
        payload: {
          nodeType: node.nodeType,
          ...(settings !== undefined
            ? {
                settingsScopeId: settings.scopeId,
                settingsChangeNumber: settings.changeNumber,
                settingsHash: settings.settingsHash,
              }
            : {}),
        },
      });
    }

    const meta: NodeExecutionMeta = { promptText: null };
    try {
      const execution = await this.runNodeWithTimeout(
        workflow,
        state,
        runId,
        nodeId,
        attemptId,
        node,
        meta,
        settings,
      );
      return {
        result: this.createNodeResult(nodeId, node, attemptId, startedAt, "ok", execution.output),
        execution,
        ...(settings !== undefined ? { settings } : {}),
      };
    } catch (error) {
      if (isRunParkedError(error) || isClaimLostError(error)) throw error;
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
        ...(settings !== undefined ? { settings } : {}),
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
    runId: string,
    nodeId: string,
    attemptId: string,
    node: WorkflowNodeDefinition,
    meta: NodeExecutionMeta,
    settings?: WorkflowSettingsScopeRecord,
  ): Promise<NodeExecution> {
    const abort = new AbortController();
    const context = this.createNodeContext(state, abort.signal, settings);
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
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          abort.abort(new TimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.activeAttempt = {
        runId,
        state,
        nodeId,
        attemptId,
        ...(settings !== undefined ? { settingsScopeId: settings.scopeId } : {}),
        signal: abort.signal,
      };
      const dispatched = this.dispatchNode(
        workflow,
        state,
        runId,
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
        // matches what persisted canonical JSON round-trips to.
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
  ): Promise<number | null> {
    const configured = node.timeoutMs;
    if (configured === null) return null;
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
      return resolved === null ? null : assertValidTimeout(resolved);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runId: string,
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
          runId,
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
        return await runCheckpointNode(node, context, {
          store: this.store,
          workflowName: workflow.name,
          nodeId,
          attemptId,
        });
    }
  }

  private async captureSettingsBinding(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    nodeId: string,
  ): Promise<WorkflowSettingsScopeRecord | undefined> {
    const metadata = compositionMetadata(workflow);
    let mountPath = "";
    let definition = workflow.settings;
    if (metadata !== undefined) {
      const entry = metadata.entries[nodeId];
      const exit = metadata.exits[nodeId];
      const scope =
        entry !== undefined
          ? metadata.scopes[entry.parentPath]
          : exit !== undefined
            ? metadata.scopes[exit.mountPath]
            : Object.values(metadata.scopes).find((candidate) =>
                Object.values(candidate.authoredNodes).includes(nodeId),
              );
      if (scope === undefined) {
        throw new Error(`Workflow settings scope is missing for node ${nodeId}`);
      }
      mountPath = scope.path;
      definition = scope.settings;
    }
    if (definition === undefined) return undefined;
    const invocation = mountPath === "" ? 1 : currentMountInvocation(state, mountPath);
    const existing = await this.store.findSettingsScope(state.runId, mountPath, invocation);
    if (existing !== undefined) return existing;
    const input = mountPath === "" ? state.input : currentMountInput(state, mountPath);
    const mappedSettings =
      mountPath === "" ? { present: false as const } : currentMountSettings(state, mountPath);
    const initial = mappedSettings.present
      ? await parseWorkflowSettingsValue(definition, mappedSettings.value)
      : await resolveInitialWorkflowSettings(definition, input);
    return await this.store.ensureSettingsScope({
      runId: state.runId,
      mountPath,
      invocation,
      settings: initial.json,
    });
  }

  private async persistedSettingsBinding(
    state: WorkflowRunState,
  ): Promise<WorkflowSettingsScopeRecord | undefined> {
    if (state.currentSettingsScopeId === undefined) return undefined;
    if (
      state.currentSettingsChangeNumber === undefined ||
      state.currentSettingsHash === undefined
    ) {
      throw new Error("Saved workflow settings binding is incomplete");
    }
    const scope = await this.store.getSettingsScopeAtChange(
      state.currentSettingsScopeId,
      state.currentSettingsChangeNumber,
    );
    if (scope === undefined) {
      throw new Error(`Saved workflow settings scope is missing: ${state.currentSettingsScopeId}`);
    }
    if (scope.settingsHash !== state.currentSettingsHash) {
      throw new Error("Saved workflow settings binding does not match its saved change");
    }
    return scope;
  }

  private createNodeContext(
    state: WorkflowRunState,
    signal: AbortSignal,
    settings?: WorkflowSettingsScopeRecord,
  ): WorkflowNodeContext {
    return {
      input: state.input,
      outputs: state.outputs,
      results: state.results,
      state,
      ...(settings !== undefined
        ? {
            settings: deepFreezeJson(structuredClone(settings.settings)),
            settingsScopeId: settings.scopeId,
            settingsChangeNumber: settings.changeNumber,
          }
        : {}),
      signal,
    };
  }

  private async runAgentNode(
    workflow: WorkflowDefinition,
    state: WorkflowRunState,
    runId: string,
    nodeId: string,
    attemptId: string,
    node: AgentNodeDefinition,
    context: WorkflowNodeContext,
    signal: AbortSignal,
    meta: NodeExecutionMeta,
  ): Promise<NodeExecution> {
    const assistant = assistantMessageConfig(node);
    if (assistant !== undefined) {
      if (this.executor.assistantMessageMode === "park") {
        state.statusDetail = "waiting for origin Pi session";
        await this.persist(runId, state, {
          scope: "agent",
          type: "agent_session_required",
          nodeId,
          attemptId,
          payload: { completion: "assistant" },
        });
        this.parked = true;
        throw new RunParkedError();
      }
      if (this.executor.assistantMessageMode !== "visible") {
        throw new Error("Assistant completion requires an origin Pi session");
      }
    }

    const authoredPrompt = await node.prompt(context);
    const basePrompt = appendLiveControlInstructions(authoredPrompt, workflow, nodeId, context);
    if (signal.aborted) {
      // The node timed out or the run was cancelled while the async prompt
      // builder ran; a late continuation must not write into a run that
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
    await this.persist(runId, state, {
      scope: "agent",
      type: "agent_prompt_sent",
      nodeId,
      attemptId,
      payload: { prompt, completion: assistant === undefined ? "submit" : "assistant" },
    });

    const submission = await this.executor.runAgentStep(
      {
        contract: {
          runId: state.runId,
          workflowName: workflow.name,
          nodeId,
          attemptId,
          completion: assistant === undefined ? "submit" : "assistant",
          ...(typeof node.expectedOutput === "string"
            ? { expectedOutput: node.expectedOutput }
            : {}),
          ...(assistant?.maxChars !== undefined ? { maxOutputChars: assistant.maxChars } : {}),
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
      ...(submission.assistantMessage !== undefined
        ? { assistantMessage: submission.assistantMessage }
        : {}),
      ...(submission.conversation !== undefined ? { conversation: submission.conversation } : {}),
    };
  }

  private async acceptSubmission(
    node: AgentNodeDefinition,
    context: WorkflowNodeContext,
    output: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    if (assistantMessageConfig(node) !== undefined) {
      return {
        ok: false,
        error:
          "This step completes with a normal assistant response. Do not submit workflow output.",
      };
    }
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
    /* istanbul ignore if -- graph validation rejects action nodes without managed effects */
    if (node.effect === undefined) {
      throw new Error(
        `Action node ${nodeId} must declare a managed effect with an explicit recovery policy`,
      );
    }
    const effectType = node.effect.type.trim();
    const idempotencyKey =
      typeof node.effect.idempotencyKey === "function"
        ? await node.effect.idempotencyKey(context)
        : node.effect.idempotencyKey;
    const request =
      typeof node.effect.request === "function"
        ? await node.effect.request(context)
        : node.effect.request;
    /* istanbul ignore if -- definition validation and effect helpers reject empty fields */
    if (effectType.length === 0 || idempotencyKey.trim().length === 0) {
      throw new Error("Managed effect type and idempotency key must be nonempty text");
    }
    canonicalJson(request);
    const reservation = await this.store.reserveEffect({
      runId: context.state.runId,
      attemptId,
      effectType,
      idempotencyKey,
      request: request as JsonValue,
      recovery: node.effect.recovery,
    });
    if (reservation.disposition === "ambiguous") throw new RunParkedError();
    if (reservation.disposition === "adopted") {
      const adopted = reservation.result;
      if (adopted === null || typeof adopted !== "object" || Array.isArray(adopted)) {
        throw new Error("Managed effect receipt is invalid");
      }
      const execution = adopted as NodeExecution;
      if (execution.action !== undefined) meta.action = execution.action;
      return execution;
    }
    const actionContext: WorkflowActionContext = {
      ...context,
      effect: { type: effectType, idempotencyKey, recovery: node.effect.recovery },
      publishUpdate: async (update) => await this.publishUpdate(nodeId, attemptId, update),
    };
    try {
      let execution: NodeExecution;
      if ("exec" in node) {
        execution = await runShellActionNode(node, actionContext, signal, meta);
      } else {
        meta.action = { actionType: "function" };
        const output = await node.run(actionContext);
        execution = { output, promptText: null, action: { actionType: "function" } };
      }
      canonicalJson(execution);
      await this.store.settleEffect({
        runId: context.state.runId,
        effectId: reservation.effectId,
        attemptNumber: reservation.attemptNumber,
        outcome: "applied",
        result: execution as JsonValue,
      });
      return execution;
    } catch (error) {
      if (isRunParkedError(error) || isClaimLostError(error)) throw error;
      await this.store.settleEffect({
        runId: context.state.runId,
        effectId: reservation.effectId,
        attemptNumber: reservation.attemptNumber,
        outcome: "rejected",
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private async persist(
    runId: string,
    state: WorkflowRunState,
    event: WorkflowTraceEventDraft,
  ): Promise<void> {
    const traceEvent = await this.store.writeSnapshot(runId, state, event);
    try {
      this.onEvent?.(traceEvent, state);
    } catch {
      // Observers (UI updates, loggers) must never determine workflow
      // correctness; a throwing observer would otherwise fail the run.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async finishRun(
    runId: string,
    state: WorkflowRunState,
    status: WorkflowRunState["status"],
    fields: { error?: string; waitingOn?: string; finalOutput?: unknown },
  ): Promise<void> {
    if (status === "failed" && state.status === "timed_out") {
      status = "timed_out";
    }
    // Let observers (e.g. the session recorder) stop and drain before the
    // terminal event exists, so the terminal fact is immutable from that point on.
    try {
      await this.onRunFinishing?.(runId, state);
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
    delete state.currentSettingsScopeId;
    delete state.currentSettingsChangeNumber;
    delete state.currentSettingsHash;
    await this.persist(runId, state, {
      scope: "run",
      type: `run_${status}`,
      payload: {
        status,
        ...(fields.error !== undefined ? { error: fields.error } : {}),
        ...(fields.waitingOn !== undefined ? { waitingOn: fields.waitingOn } : {}),
        ...(fields.finalOutput !== undefined ? { finalOutput: fields.finalOutput } : {}),
        presentationRequired: status === "completed" && this.presentationRequired,
      },
    });
  }
}

async function runCheckpointNode(
  node: CheckpointNodeDefinition,
  context: WorkflowNodeContext,
  execution: {
    store: WorkflowExecutionStore;
    workflowName: string;
    nodeId: string;
    attemptId: string;
  },
): Promise<NodeExecution> {
  if (node.humanDecision !== undefined) {
    const prompt = await node.humanDecision.request(context);
    const audience =
      typeof node.humanDecision.audience === "function"
        ? await node.humanDecision.audience(context)
        : node.humanDecision.audience;
    const timeout =
      typeof node.humanDecision.onTimeout === "function"
        ? await node.humanDecision.onTimeout(context)
        : node.humanDecision.onTimeout;
    const request = createHumanDecisionRequest({
      runId: context.state.runId,
      workflowName: execution.workflowName,
      nodeId: execution.nodeId,
      attemptId: execution.attemptId,
      contract: { audience, choices: node.humanDecision.choices },
      prompt,
      ...(timeout !== undefined ? { timeout } : {}),
    });
    await execution.store.createHumanDecisionRequest(request);
    return { output: request, promptText: null };
  }
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
  actionContext: WorkflowActionContext,
  signal: AbortSignal,
  meta: NodeExecutionMeta,
): Promise<NodeExecution> {
  const spec = await node.exec(actionContext);
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
  const output = node.parse ? await node.parse(result, actionContext) : result;
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

function restoreRunState(target: WorkflowRunState, saved: WorkflowRunState): void {
  for (const key of Object.keys(target) as Array<keyof WorkflowRunState>) {
    delete target[key];
  }
  Object.assign(target, saved);
}

function currentMountInvocation(state: WorkflowRunState, mountPath: string): number {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index];
    if (step?.nodeId !== mountPath || step.outcome !== "ok") continue;
    const output = step.output as { invocation?: unknown };
    if (typeof output.invocation === "number" && Number.isInteger(output.invocation)) {
      return output.invocation;
    }
  }
  throw new Error(`Workflow include entry is missing for settings scope ${mountPath}`);
}

function currentMountInput(state: WorkflowRunState, mountPath: string): unknown {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index];
    if (step?.nodeId !== mountPath || step.outcome !== "ok") continue;
    const output = step.output as { input?: unknown };
    return output.input ?? null;
  }
  throw new Error(`Workflow include input is missing for settings scope ${mountPath}`);
}

function currentMountSettings(
  state: WorkflowRunState,
  mountPath: string,
): { present: true; value: unknown } | { present: false } {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index];
    if (step?.nodeId !== mountPath || step.outcome !== "ok") continue;
    const output = step.output as { settings?: unknown };
    return Object.hasOwn(output, "settings")
      ? { present: true, value: output.settings }
      : { present: false };
  }
  throw new Error(`Workflow include entry is missing for settings scope ${mountPath}`);
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreezeJson(item);
  }
  return value;
}

function countExecutableSteps(workflow: WorkflowDefinition, steps: WorkflowStepRecord[]): number {
  const metadata = compositionMetadata(workflow);
  if (metadata === undefined) return steps.length;
  return steps.filter(
    (step) =>
      metadata.entries[step.nodeId] === undefined && metadata.exits[step.nodeId] === undefined,
  ).length;
}

function assertInvocationStepLimit(
  metadata: ReturnType<typeof compositionMetadata>,
  nodeId: string,
  steps: WorkflowStepRecord[],
): void {
  if (metadata === undefined) return;
  const scopes = Object.values(metadata.scopes)
    .filter(
      (candidate) =>
        candidate.path !== "" &&
        candidate.maxSteps !== undefined &&
        nodeId.startsWith(`${candidate.path}/`),
    )
    .sort((a, b) => a.path.length - b.path.length);
  for (const scope of scopes) {
    let entryIndex = -1;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index]?.nodeId === scope.path) {
        entryIndex = index;
        break;
      }
    }
    if (entryIndex < 0) throw new Error(`Workflow include entry is missing: ${scope.path}`);
    const attempts = steps
      .slice(entryIndex + 1)
      .filter(
        (step) =>
          step.nodeId.startsWith(`${scope.path}/`) &&
          metadata.entries[step.nodeId] === undefined &&
          metadata.exits[step.nodeId] === undefined,
      ).length;
    if (attempts >= (scope.maxSteps as number)) {
      throw new Error(
        `Included workflow ${scope.workflowName} at ${scope.path} exceeded maxSteps=${scope.maxSteps}`,
      );
    }
  }
}

/**
 * Outputs are persisted to the SQLite run state, so they must be JSON-serializable.
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

export function workflowIdentityMismatch(
  state: WorkflowRunState,
  workflow: WorkflowDefinition,
  source: WorkflowSource | undefined,
): boolean {
  if (workflowSourceMismatch(state, source)) return true;
  const metadata = compositionMetadata(workflow);
  const currentSources = metadata?.sources ?? [];
  if (!isDeepStrictEqual(state.workflowSources ?? [], currentSources)) return true;
  const currentDigest = metadata?.snapshot.mounts.length ? definitionDigest(workflow) : undefined;
  return state.definitionDigest !== currentDigest;
}

function definitionDigest(workflow: WorkflowDefinition): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(createDefinitionSnapshot(workflow)))
    .digest("hex")}`;
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

function assistantMessageOutput(
  expectedOutput: AgentExpectedOutput | undefined,
): AssistantMessageOutput | undefined {
  return typeof expectedOutput === "object" && expectedOutput?.kind === "assistant-message"
    ? expectedOutput
    : undefined;
}

function assistantMessageConfig(node: AgentNodeDefinition): AssistantMessageOutput | undefined {
  return assistantMessageOutput(node.expectedOutput);
}

function appendLiveControlInstructions(
  prompt: string,
  workflow: WorkflowDefinition,
  nodeId: string,
  context: WorkflowNodeContext,
): string {
  const lines = [prompt.trimEnd(), "", "Workflow context for this run:"];
  if (
    context.settingsScopeId !== undefined &&
    context.settingsChangeNumber !== undefined &&
    context.settings !== undefined
  ) {
    const definition = settingsDefinitionForNode(workflow, nodeId);
    const value = canonicalJson(context.settings);
    const summary =
      value.length <= 8_192 ? value : `${value.slice(0, 8_192)}… [settings truncated]`;
    const allowed = (definition?.paths ?? [])
      .flatMap((rule) =>
        Object.entries(rule.permissions)
          .filter(([, actors]) => actors?.includes("session") === true)
          .map(([permission]) => `${permission} ${rule.path || "/"}`),
      )
      .join(", ");
    lines.push(
      `- Active settings scope: ${context.settingsScopeId}`,
      `- Current settings change number: ${context.settingsChangeNumber}`,
      ...(definition?.description !== undefined
        ? [`- Settings purpose: ${definition.description}`]
        : []),
      `- Current settings: ${summary}`,
      `- Settings permissions: ${allowed || "none"}`,
      "- Treat the current settings as authoritative for this workflow scope.",
    );
  } else {
    lines.push("- This workflow scope has no editable settings.");
  }
  return lines.join("\n");
}

function settingsDefinitionForNode(
  workflow: WorkflowDefinition,
  nodeId: string,
): WorkflowDefinition["settings"] {
  const metadata = compositionMetadata(workflow);
  if (metadata === undefined) return workflow.settings;
  const entry = metadata.entries[nodeId];
  if (entry !== undefined) return metadata.scopes[entry.parentPath]?.settings;
  const exit = metadata.exits[nodeId];
  if (exit !== undefined) return metadata.scopes[exit.mountPath]?.settings;
  return Object.values(metadata.scopes).find((scope) =>
    Object.values(scope.authoredNodes).includes(nodeId),
  )?.settings;
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
  expectedOutput: AgentExpectedOutput | undefined,
): string {
  const assistant = assistantMessageOutput(expectedOutput);
  if (assistant !== undefined) {
    return [
      prompt.trimEnd(),
      "",
      "---",
      `Workflow step contract (workflow: ${workflowName}, step: ${nodeId}, attempt: ${attemptId})`,
      "",
      "Reply with a normal assistant message.",
      "Do not call the workflow tool to complete this step.",
      "Your visible reply becomes the workflow step output after the turn settles.",
      ...(assistant.maxChars !== undefined
        ? [`Keep the visible reply within ${assistant.maxChars} characters.`]
        : []),
    ].join("\n");
  }
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
    `Expected output: ${typeof expectedOutput === "string" ? expectedOutput : "a JSON object with your result"}`,
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
