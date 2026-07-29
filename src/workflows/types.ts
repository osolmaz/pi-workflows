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
  /**
   * Aborted when the node times out or the run is cancelled. Long-running
   * callbacks should observe it (pass it to fetch/spawn or check
   * `signal.aborted`) so side effects stop when the engine gives up on the
   * node.
   */
  signal: AbortSignal;
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
  /** Cap on captured stdout/stderr each, default 1,000,000 characters. */
  maxOutputChars?: number;
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

export type WorkflowPresentationContext = {
  /** Final persisted state of the workflow run. */
  state: WorkflowRunState;
  /** Convenience alias for `state.finalOutput`. */
  finalOutput: unknown;
  /** Aborted if a new run starts, the session closes, or prompt generation times out. */
  signal: AbortSignal;
};

export type WorkflowDefinition = {
  name: string;
  /** Optional human-readable run title (static or derived from input). */
  title?:
    | string
    | ((context: { input: unknown; workflowName: string }) => MaybePromise<string | undefined>);
  /**
   * Optional instructions for a normal assistant response after the run ends.
   * The Pi extension resolves this only after the final state is persisted;
   * the engine and run bundle remain presentation-agnostic.
   */
  presentationPrompt?:
    | string
    | ((context: WorkflowPresentationContext) => MaybePromise<string | undefined>);
  startAt: string;
  nodes: Record<string, WorkflowNodeDefinition>;
  edges: WorkflowEdge[];
  /** Guard against unbounded loops. Defaults to the engine's maxSteps. */
  maxSteps?: number;
};

export type WorkflowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

/**
 * Reference to a content-addressed file under the bundle's `artifacts/`
 * directory. Large string leaves inside persisted values are replaced by
 * `{ "$artifact": ArtifactRef }` at write time (see `docs/run-bundles.md`).
 */
export type ArtifactRef = {
  /** Bundle-relative path, `artifacts/sha256-<64 hex>.txt`. */
  path: string;
  mediaType: string;
  bytes: number;
  /** Hex digest of the artifact bytes. */
  sha256: string;
};

/** The sentinel wrapper that replaces an externalized value. */
export type ArtifactValue = { $artifact: ArtifactRef };

/**
 * Explicit linkage from a workflow attempt to the Pi conversation slice it
 * produced. Ids address entries in `session/entries.ndjson` by Pi entry id.
 */
export type ConversationRange = {
  /** First Pi session entry id of the attempt. */
  firstEntryId: string;
  /** Last Pi session entry id of the attempt, inclusive. */
  lastEntryId: string;
};

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
  /**
   * Full prompt text for agent steps, `null` for other node types. In a
   * persisted bundle a large prompt may be an `ArtifactValue`.
   */
  prompt: string | ArtifactValue | null;
  output: unknown;
  error?: string;
  action?: WorkflowActionReceipt;
  /** For agent steps recorded inside a Pi conversation. */
  conversation?: ConversationRange;
};

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type WorkflowRunState = {
  schema: "pi-workflows.run-state.v1";
  /**
   * `seq` of the trace event this projection reflects. `trace.ndjson` is the
   * source of truth; a state whose `traceSeq` is older than the trace tail is
   * a stale projection.
   */
  traceSeq: number;
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
  currentNodeStartedAt?: string;
  statusDetail?: string;
  /** True while the run is held at a step boundary by a pause request. */
  paused?: boolean;
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
  scope: "run" | "node" | "agent" | "action" | "session";
  type: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  payload: Record<string, unknown>;
};

/** `session/binding.json`: written once when a run binds to a conversation. */
export type WorkflowSessionBinding = {
  schema: "pi-workflows.session-binding.v1";
  runId: string;
  /** Pi session UUID. */
  piSessionId: string;
  /**
   * Absolute path of the Pi session file; provenance only, never read back.
   * Absent for in-memory sessions.
   */
  piSessionFile?: string;
  /** Working directory of the conversation. */
  cwd: string;
  boundAt: string;
};

/**
 * One line of `session/entries.ndjson`: a verbatim Pi session entry recorded
 * while the run was active. The inner entry shape is owned by Pi.
 */
export type WorkflowSessionEntryRecord = {
  /** Starts at 1, increases by exactly 1 within the file. */
  seq: number;
  /** When the entry was recorded into the bundle. */
  at: string;
  /** Verbatim Pi session entry (has its own id/parentId/timestamp). */
  entry: Record<string, unknown>;
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
    /** Bundle-relative session directory, present once a session is bound. */
    session?: string;
    /** Bundle-relative artifacts directory, present once a value was externalized. */
    artifacts?: string;
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
  /**
   * The Pi conversation slice this step produced, when the executor records
   * one. Persisted verbatim into the step record and terminal node event.
   */
  conversation?: ConversationRange;
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
  /**
   * Shared run store. Pass the same instance used by a session recorder so
   * trace sequence numbers stay single-writer. Defaults to a new store on
   * `outputRoot`.
   */
  store?: import("./store.js").WorkflowRunStore;
  /** Default per-node timeout. Defaults to 15 minutes. */
  defaultNodeTimeoutMs?: number;
  /** Guard against unbounded graph loops. Defaults to 100 executed steps. */
  maxSteps?: number;
  /** Observer invoked after every persisted trace event. */
  onEvent?: (event: WorkflowTraceEvent, state: WorkflowRunState) => void;
};
