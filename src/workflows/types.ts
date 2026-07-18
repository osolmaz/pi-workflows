export type MaybePromise<T> = T | Promise<T>;

/**
 * Context passed to node callbacks (prompt builders, compute/action runners,
 * validators). `outputs` maps node ids to their accepted outputs; `results`
 * maps node ids to the full result record of their latest attempt.
 */
export type WorkflowNodeContext<TInput = unknown> = {
  input: TInput;
  outputs: Record<string, unknown>;
  results: Record<string, WorkflowNodeResult>;
  state: WorkflowRunState;
};

export type WorkflowNodeCommon = {
  /** Per-node timeout. Falls back to the engine default (15 minutes). */
  timeoutMs?: number;
  /** Short human-readable label shown in the viewer while the node runs. */
  statusDetail?: string;
};

/**
 * Edges route between nodes. A node has at most one outgoing edge: either a
 * plain `to` edge or a `switch` edge that routes on a JSON path into the
 * node's output (`$.field`, `$output.field`) or result (`$result.outcome`).
 */
export type WorkflowEdge =
  | {
      from: string;
      to: string;
    }
  | {
      from: string;
      switch: {
        on: string;
        cases: Record<string, string>;
      };
    };

/**
 * A model-shaped step. The engine sends the prompt into the pi conversation
 * and the model completes the step by calling the `workflow` tool with a JSON
 * output. `expectedOutput` is appended to the step contract so the model
 * knows what shape to submit. `validate` may reject (throw) or normalize the
 * submitted output; rejections are surfaced to the model so it can retry
 * within the same step.
 */
export type AgentNodeDefinition = WorkflowNodeCommon & {
  nodeType: "agent";
  prompt: (context: WorkflowNodeContext) => MaybePromise<string>;
  expectedOutput?: string;
  validate?: (output: unknown, context: WorkflowNodeContext) => MaybePromise<unknown>;
};

/** A pure local function: shape inputs, route, format, derive values. */
export type ComputeNodeDefinition = WorkflowNodeCommon & {
  nodeType: "compute";
  run: (context: WorkflowNodeContext) => MaybePromise<unknown>;
};

/** A deterministic runtime-owned step implemented as a local function. */
export type FunctionActionNodeDefinition = WorkflowNodeCommon & {
  nodeType: "action";
  run: (context: WorkflowNodeContext) => MaybePromise<unknown>;
};

export type ShellActionExecution = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  shell?: boolean | string;
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
};

export type ShellActionResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

/** A deterministic runtime-owned step implemented as a shell command. */
export type ShellActionNodeDefinition = WorkflowNodeCommon & {
  nodeType: "action";
  exec: (context: WorkflowNodeContext) => MaybePromise<ShellActionExecution>;
  parse?: (result: ShellActionResult, context: WorkflowNodeContext) => MaybePromise<unknown>;
};

export type ActionNodeDefinition = FunctionActionNodeDefinition | ShellActionNodeDefinition;

/**
 * A pause point. The run terminates with status `waiting` so a human (or an
 * external trigger) can decide how to continue. The optional `run` callback
 * produces the checkpoint's output before the run pauses.
 */
export type CheckpointNodeDefinition = WorkflowNodeCommon & {
  nodeType: "checkpoint";
  summary?: string;
  run?: (context: WorkflowNodeContext) => MaybePromise<unknown>;
};

export type WorkflowNodeDefinition =
  | AgentNodeDefinition
  | ComputeNodeDefinition
  | ActionNodeDefinition
  | CheckpointNodeDefinition;

export type WorkflowDefinition = {
  name: string;
  /** Optional human-readable run title (static or derived from input). */
  title?:
    | string
    | ((context: { input: unknown; workflowName: string }) => MaybePromise<string | undefined>);
  startAt: string;
  nodes: Record<string, WorkflowNodeDefinition>;
  edges: WorkflowEdge[];
  /** Guard against unbounded loops. Defaults to the engine's maxSteps. */
  maxSteps?: number;
};

export type WorkflowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

export type WorkflowNodeResult = {
  attemptId: string;
  nodeId: string;
  nodeType: WorkflowNodeDefinition["nodeType"];
  outcome: WorkflowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
};

export type WorkflowActionReceipt = {
  actionType: "shell" | "function";
  command?: string;
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
};

export type WorkflowStepRecord = {
  attemptId: string;
  nodeId: string;
  nodeType: WorkflowNodeDefinition["nodeType"];
  outcome: WorkflowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  promptText: string | null;
  output: unknown;
  error?: string;
  action?: WorkflowActionReceipt;
};

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type WorkflowRunState = {
  runId: string;
  workflowName: string;
  runTitle?: string;
  workflowPath?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: WorkflowRunStatus;
  input: unknown;
  outputs: Record<string, unknown>;
  results: Record<string, WorkflowNodeResult>;
  steps: WorkflowStepRecord[];
  currentNode?: string;
  currentAttemptId?: string;
  currentNodeType?: WorkflowNodeDefinition["nodeType"];
  currentNodeStartedAt?: string;
  statusDetail?: string;
  waitingOn?: string;
  finalOutput?: unknown;
  error?: string;
};

export type WorkflowNodeSnapshot = {
  nodeType: WorkflowNodeDefinition["nodeType"];
  timeoutMs?: number;
  statusDetail?: string;
  summary?: string;
  expectedOutput?: string;
  actionExecution?: "function" | "shell";
};

export type WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1";
  name: string;
  startAt: string;
  nodes: Record<string, WorkflowNodeSnapshot>;
  edges: WorkflowEdge[];
};

export type WorkflowTraceEvent = {
  seq: number;
  at: string;
  scope: "run" | "node" | "agent" | "action";
  type: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  payload: Record<string, unknown>;
};

export type WorkflowTraceEventDraft = Omit<WorkflowTraceEvent, "seq" | "at" | "runId">;

export type WorkflowRunManifest = {
  schema: "pi-workflows.run-bundle.v1";
  runId: string;
  workflowName: string;
  runTitle?: string;
  workflowPath?: string;
  startedAt: string;
  finishedAt?: string;
  status: WorkflowRunStatus;
  traceSchema: "pi-workflows.trace-event.v1";
  paths: {
    workflow: string;
    state: string;
    trace: string;
  };
};

export type WorkflowRunResult = {
  runDir: string;
  state: WorkflowRunState;
};

/** The step contract handed to the executor alongside the prompt. */
export type AgentStepContract = {
  runId: string;
  workflowName: string;
  nodeId: string;
  attemptId: string;
  expectedOutput?: string;
};

export type AgentStepRequest = {
  contract: AgentStepContract;
  prompt: string;
  /**
   * Validate a submission from the model. Returns the normalized output or an
   * error message the executor should surface to the model for retry.
   */
  accept: (output: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
};

export type AgentStepSubmission = {
  output: unknown;
};

/**
 * Runs one agent step to completion. Implementations deliver the prompt to
 * the model and resolve once a submission has been accepted via `accept`.
 * Must reject with an `AbortError`-like error when `signal` aborts.
 */
export interface AgentStepExecutor {
  runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission>;
}

export type WorkflowEngineOptions = {
  executor: AgentStepExecutor;
  /** Root directory for run bundles. Defaults to `~/.pi/agent/workflows/runs`. */
  outputRoot?: string;
  /** Default per-node timeout. Defaults to 15 minutes. */
  defaultNodeTimeoutMs?: number;
  /** Guard against unbounded graph loops. Defaults to 100 executed steps. */
  maxSteps?: number;
  /** Observer invoked after every persisted trace event. */
  onEvent?: (event: WorkflowTraceEvent, state: WorkflowRunState) => void;
};
