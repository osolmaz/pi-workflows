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

export type WorkflowUpdateInput = {
  type: string;
  key: string;
  data: Record<string, unknown>;
};

export type WorkflowUpdateRecord = {
  updateId: string;
  seq: number;
  at: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  type: string;
  key: string;
  data: Record<string, unknown>;
};

export type WorkflowUpdateReceipt = Pick<
  WorkflowUpdateRecord,
  "updateId" | "seq" | "at" | "type" | "key"
>;

export type WorkflowActionContext<TInput = unknown> = WorkflowNodeContext<TInput> & {
  publishUpdate(update: WorkflowUpdateInput): Promise<WorkflowUpdateReceipt>;
};

export type WorkflowProgressStatus =
  | "pending"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type WorkflowProgressData = {
  schema: "pi-workflows.progress.v1";
  status: WorkflowProgressStatus;
  label?: string;
  phase?: string;
  completed?: number;
  total?: number;
  unit?: string;
  sourceUpdatedAt?: string;
  sourceEstimatedFinishAt?: string;
};

export type WorkflowNodeCommon = {
  /**
   * Per-node timeout or a callback that derives it from the run context.
   * Null disables the wall-clock deadline. Omission falls back to the engine
   * default (15 minutes).
   */
  timeoutMs?: number | null | ((context: WorkflowNodeContext) => MaybePromise<number | null>);
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

/** A visible assistant response used as the accepted agent-node output. */
export type AssistantMessageOutput = {
  kind: "assistant-message";
  /** Optional author-supplied character limit. Omission adds no workflow limit. */
  maxChars?: number;
};

export type AgentExpectedOutput = string | AssistantMessageOutput;

type AgentNodeBase = WorkflowNodeCommon & {
  nodeType: "agent";
  prompt: (context: WorkflowNodeContext) => MaybePromise<string>;
};

/** The existing workflow-tool submission form. */
export type SubmittedAgentNodeDefinition = AgentNodeBase & {
  expectedOutput?: string;
  validate?: (output: unknown, context: WorkflowNodeContext) => MaybePromise<unknown>;
};

/** A model turn whose normal visible assistant text becomes the node output. */
export type AssistantAgentNodeDefinition = AgentNodeBase & {
  expectedOutput: AssistantMessageOutput;
  validate?: never;
};

/** A model-shaped step with either submitted or visible assistant output. */
export type AgentNodeDefinition = SubmittedAgentNodeDefinition | AssistantAgentNodeDefinition;

/** A pure local function: shape inputs, route, format, derive values. */
export type ComputeNodeDefinition = WorkflowNodeCommon & {
  nodeType: "compute";
  run: (context: WorkflowNodeContext) => MaybePromise<unknown>;
};

/** A durable user-facing message addressed by the runtime to the run's origin session. */
export type NotifyNodeDefinition = WorkflowNodeCommon & {
  nodeType: "notify";
  message: (context: WorkflowNodeContext) => MaybePromise<string>;
  kind?: "progress" | "final";
};

/** A deterministic runtime-owned step implemented as a local function. */
export type FunctionActionNodeDefinition = WorkflowNodeCommon & {
  nodeType: "action";
  run: (context: WorkflowActionContext) => MaybePromise<unknown>;
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
export type ShellUpdateLine = {
  stream: "stdout" | "stderr";
  text: string;
};

export type ShellActionUpdates = {
  streams?: Array<"stdout" | "stderr">;
  parseLine: (
    line: ShellUpdateLine,
    context: WorkflowActionContext,
  ) => MaybePromise<WorkflowUpdateInput | WorkflowUpdateInput[] | undefined>;
};

export type ShellActionNodeDefinition = WorkflowNodeCommon & {
  nodeType: "action";
  exec: (context: WorkflowNodeContext) => MaybePromise<ShellActionExecution>;
  parse?: (result: ShellActionResult, context: WorkflowNodeContext) => MaybePromise<unknown>;
  updates?: ShellActionUpdates;
};

export type ActionNodeDefinition = FunctionActionNodeDefinition | ShellActionNodeDefinition;

export type HumanDecisionTextInput = {
  kind: "text";
  name: string;
  prompt: string;
  minLength: number;
  maxLength: number;
};

export type HumanDecisionChoice = {
  label: string;
  input?: HumanDecisionTextInput;
};

export type HumanDecisionChoiceMap = Record<string, HumanDecisionChoice>;

export type DecisionPresentationParagraph = {
  kind: "paragraph";
  text: string;
};

export type DecisionPresentationSection = {
  kind: "section";
  title: string;
};

export type DecisionPresentationBullets = {
  kind: "bullets";
  items: string[];
};

export type DecisionPresentationFields = {
  kind: "fields";
  items: Array<{ label: string; value: string }>;
};

export type DecisionPresentationPreformatted = {
  kind: "preformatted";
  text: string;
};

export type DecisionPresentationBlock =
  | DecisionPresentationParagraph
  | DecisionPresentationSection
  | DecisionPresentationBullets
  | DecisionPresentationFields
  | DecisionPresentationPreformatted;

export type DecisionPresentation = {
  schema: "pi-workflows.decision-presentation.v1";
  summary: string;
  blocks: DecisionPresentationBlock[];
};

export type HumanDecisionPrompt<TSubject = unknown> = {
  title: string;
  subject: TSubject;
  presentation: DecisionPresentation;
  /** Positive revision of the decision subject and presentation. Defaults to 1. */
  revision?: number;
  /** Optional absolute expiry. An expired request cannot accept an answer. */
  expiresAt?: string;
};

export type HumanDecisionAudience =
  | string
  | ((context: WorkflowNodeContext) => MaybePromise<string>);

export type HumanDecisionTimeout = {
  afterMs: number;
  response: HumanDecisionResponse;
};

export type HumanDecisionTimeoutPolicy =
  | HumanDecisionTimeout
  | ((context: WorkflowNodeContext) => MaybePromise<HumanDecisionTimeout | undefined>);

export type HumanDecisionNodeContract = {
  audience: HumanDecisionAudience;
  choices: HumanDecisionChoiceMap;
  request: (context: WorkflowNodeContext) => MaybePromise<HumanDecisionPrompt>;
  onTimeout?: HumanDecisionTimeoutPolicy;
};

type HumanDecisionRequestCommon = {
  decisionId: string;
  requestDigest: string;
  runId: string;
  workflowName: string;
  nodeId: string;
  attemptId: string;
  audience: string;
  title: string;
  choices: HumanDecisionChoiceMap;
  createdAt: string;
  expiresAt?: string;
  defaultResponse?: HumanDecisionResponse;
};

export type HumanDecisionRequest = HumanDecisionRequestCommon & {
  schema: "pi-workflows.human-decision-request.v1";
  subject: unknown;
  presentation: DecisionPresentation;
  revision: number;
  subjectDigest: string;
  presentationDigest: string;
};

/**
 * Complete operator-facing request passed to a decision channel. It excludes
 * the canonical subject by design.
 */
export type HumanDecisionChannelRequest = HumanDecisionRequestCommon & {
  schema: "pi-workflows.human-decision-channel-request.v1";
  sourceSchema: HumanDecisionRequest["schema"];
  presentation: DecisionPresentation;
  presentationDigest: string;
  revision: number;
};

export type HumanDecisionResponse = {
  choice: string;
  input?: Record<string, string>;
};

export type HumanDecisionAnswerSource = {
  channel: string;
  actorId: string;
  eventId: string;
};

export type HumanDecisionSubmission = HumanDecisionResponse & {
  decisionId: string;
  requestDigest: string;
  source: HumanDecisionAnswerSource;
  idempotencyKey: string;
};

type ResolvedHumanDecisionCommon = {
  decisionId: string;
  requestDigest: string;
  response: HumanDecisionResponse;
  provenance: "human" | "timeout";
  acceptedAt: string;
  answerDigest: string;
};

type AcceptedHumanDecisionCommon = ResolvedHumanDecisionCommon & {
  provenance: "human";
  source: HumanDecisionAnswerSource;
  idempotencyKey: string;
};

type DefaultedHumanDecisionCommon = ResolvedHumanDecisionCommon & {
  provenance: "timeout";
};

export type AcceptedHumanDecision = AcceptedHumanDecisionCommon & {
  schema: "pi-workflows.human-decision-accepted.v1";
  subjectDigest: string;
  presentationDigest: string;
  revision: number;
};

export type DefaultedHumanDecision = DefaultedHumanDecisionCommon & {
  schema: "pi-workflows.human-decision-accepted.v1";
  subjectDigest: string;
  presentationDigest: string;
  revision: number;
};
export type ResolvedHumanDecision = AcceptedHumanDecision | DefaultedHumanDecision;

type HumanDecisionReceiptCommon = {
  decisionId: string;
  requestDigest: string;
  nodeId: string;
  response: HumanDecisionResponse;
  provenance: "human" | "timeout";
  acceptedAt: string;
  answerDigest: string;
};

export type HumanDecisionReceipt = HumanDecisionReceiptCommon & {
  schema: "pi-workflows.human-decision-receipt.v1";
  subjectDigest: string;
  presentationDigest: string;
  revision: number;
};

export type HumanDecisionDeliveryRecord = {
  schema: "pi-workflows.human-decision-delivery.v1";
  attemptId: string;
  decisionId: string;
  requestDigest: string;
  presentationDigest: string;
  channel: string;
  phase: "intent" | "part" | "complete";
  state: "intent" | "confirmed" | "failed" | "unknown";
  createdAt: string;
  finishedAt?: string;
  recipientIndex?: number;
  partIndex?: number;
  partCount?: number;
  contentDigest?: string;
  messageCount?: number;
  errorCode?: string;
};

export type HumanDecisionSettlementRecord = {
  schema: "pi-workflows.human-decision-settlement.v1";
  attemptId: string;
  decisionId: string;
  requestDigest: string;
  channel: string;
  state: "confirmed" | "failed";
  createdAt: string;
  finishedAt: string;
  errorCode?: string;
};

export type HumanDecisionCancellationRecord = {
  schema: "pi-workflows.human-decision-cancellation.v1";
  decisionId: string;
  requestDigest: string;
  cancelledAt: string;
  reason: "cancelled" | "expired";
};

export type HumanDecisionContinuationRecord = {
  schema: "pi-workflows.human-decision-continuation.v1";
  decisionId: string;
  requestDigest: string;
  provenance: "human" | "timeout";
  parentRunId: string;
  runId: string;
  createdAt: string;
};

/**
 * A pause point. The run terminates with status `waiting` so a human (or an
 * external trigger) can decide how to continue. The optional `run` callback
 * produces the checkpoint's output before the run pauses.
 */
export type CheckpointNodeDefinition = WorkflowNodeCommon & {
  nodeType: "checkpoint";
  summary?: string;
  run?: (context: WorkflowNodeContext) => MaybePromise<unknown>;
  /** Typed verified-human request. Still executes as a checkpoint node. */
  humanDecision?: HumanDecisionNodeContract;
};

export type WorkflowNodeDefinition =
  | AgentNodeDefinition
  | ComputeNodeDefinition
  | NotifyNodeDefinition
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

/** Runtime parser that also carries its normalized TypeScript result type. */
export type WorkflowValueParser<T> = (value: unknown) => MaybePromise<T>;

export type WorkflowExitDefinition<TOutput = unknown> = {
  /** Successful terminal node whose output leaves through this exit. */
  from: string;
  /** Optional runtime output normalizer and validator. */
  validate?: WorkflowValueParser<TOutput>;
};

export type WorkflowExitMap = Record<string, WorkflowExitDefinition>;

export type WorkflowInputOf<TWorkflow> =
  TWorkflow extends WorkflowDefinition<infer TInput, any, any> ? TInput : unknown;

export type WorkflowExitOutputs<TWorkflow> =
  TWorkflow extends WorkflowDefinition<any, infer TExits, any>
    ? {
        [K in keyof TExits]: TExits[K] extends WorkflowExitDefinition<infer TOutput>
          ? TOutput
          : unknown;
      }
    : Record<string, unknown>;

export type WorkflowIncludedResult<TWorkflow> = {
  [K in keyof WorkflowExitOutputs<TWorkflow>]: {
    exit: K;
    output: WorkflowExitOutputs<TWorkflow>[K];
  };
}[keyof WorkflowExitOutputs<TWorkflow>];

export type WorkflowIncludeDefinition<
  TWorkflow extends WorkflowDefinition<any, any, any> = WorkflowDefinition<any, any, any>,
> = {
  /** Imported child definition or dynamic discovered name/path. */
  workflow: TWorkflow | string;
  /** Pure parent-to-child input mapping, evaluated on every mount entry. */
  input?: (context: WorkflowNodeContext) => MaybePromise<WorkflowInputOf<TWorkflow>>;
  /** Optional direct definition that supplies the contract for a dynamic reference. */
  contract?: TWorkflow;
};

export type WorkflowIncludeMap = Record<string, WorkflowIncludeDefinition>;

export type WorkflowIncludeExitReference<TIncludes extends WorkflowIncludeMap> = {
  [K in keyof TIncludes & string]: TIncludes[K] extends WorkflowIncludeDefinition<infer TWorkflow>
    ? `${K}.${Extract<keyof WorkflowExitOutputs<TWorkflow>, string>}`
    : never;
}[keyof TIncludes & string];

export type WorkflowTypedEdge<
  TNodes extends Record<string, WorkflowNodeDefinition>,
  TIncludes extends WorkflowIncludeMap,
> =
  | {
      from: (keyof TNodes & string) | WorkflowIncludeExitReference<TIncludes>;
      to: (keyof TNodes & string) | (keyof TIncludes & string);
    }
  | {
      from: keyof TNodes & string;
      switch: {
        on: string;
        cases: Record<string, (keyof TNodes & string) | (keyof TIncludes & string)>;
      };
    };

export type WorkflowDefinition<
  TInput = any,
  TExits extends WorkflowExitMap = WorkflowExitMap,
  TIncludes extends WorkflowIncludeMap = WorkflowIncludeMap,
> = {
  name: string;
  /** Module URL used to attest directly imported child workflow files. */
  source?: string;
  /** Stable public input-and-exit contract identity for compatible overrides. */
  contractId?: string;
  /** Optional runtime input normalizer and validator. */
  input?: WorkflowValueParser<TInput>;
  /** Optional human-readable run title (static or derived from input). */
  title?:
    | string
    | ((context: { input: TInput; workflowName: string }) => MaybePromise<string | undefined>);
  /**
   * Optional instructions for a normal assistant response after the run ends.
   * The Pi extension resolves this only after the final state is persisted;
   * the engine and durable store remain presentation-agnostic.
   */
  presentationPrompt?:
    | string
    | ((context: WorkflowPresentationContext) => MaybePromise<string | undefined>);
  startAt: string;
  nodes: Record<string, WorkflowNodeDefinition>;
  includes?: TIncludes;
  exits?: TExits;
  edges: WorkflowEdge[];
  /** Guard against unbounded loops. Defaults to the engine's maxSteps. */
  maxSteps?: number;
};

export type WorkflowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

/** Explicit linkage from a workflow attempt to the Pi conversation slice it produced. */
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
  /** Full prompt text for agent steps, `null` for other node types. */
  prompt: string | null;
  output: unknown;
  error?: string;
  action?: WorkflowActionReceipt;
  /** Receipt for a visible assistant-message completion. */
  assistantMessage?: AssistantMessageReceipt;
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

export type WorkflowSource =
  | { kind: "builtin"; id: string; revision: string }
  | { kind: "file"; path: string; hash: string };

export type WorkflowMountedSource = {
  mountPath: string[];
  workflowName: string;
  source: WorkflowSource;
};

export type WorkflowMountSnapshot = {
  mountPath: string[];
  workflowName: string;
  entryNode: string;
  exits: Record<string, string>;
  maxSteps?: number;
};

export type WorkflowCompositionSnapshot = {
  mounts: WorkflowMountSnapshot[];
};

export type WorkflowRunState = {
  schema: "pi-workflows.run-state.v1";
  /** Resource revision of the event reflected by this projection. */
  traceSeq: number;
  runId: string;
  workflowName: string;
  /** Set on continuation runs: the checkpointed run this one carries forward. */
  parentRunId?: string;
  /**
   * Steps carried from the parent at continuation start. Steps beyond this
   * count were recorded by this run itself; resume uses it to tell a
   * carried checkpoint from this run's own.
   */
  carriedStepCount?: number;
  runTitle?: string;
  /** Stable built-in identity or immutable file source used by this run. */
  workflowSource?: WorkflowSource;
  /** Sorted immutable sources used by included workflow mounts. */
  workflowSources?: WorkflowMountedSource[];
  /** SHA-256 of the fully resolved definition snapshot. */
  definitionDigest?: string;
  /** Legacy fields accepted only by the bounded built-in migration. */
  workflowPath?: string;
  workflowHash?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: WorkflowRunStatus;
  input: unknown;
  outputs: Record<string, unknown>;
  results: Record<string, WorkflowNodeResult>;
  steps: WorkflowStepRecord[];
  /** Latest update for each `(type, key)` pair, sorted by trace sequence. */
  updates?: WorkflowUpdateRecord[];
  currentNode?: string;
  currentAttemptId?: string;
  currentNodeStartedAt?: string;
  statusDetail?: string;
  /** Redacted verified-human receipt carried by a continuation run. */
  humanDecision?: HumanDecisionReceipt;
  /** True while the run is held at a step boundary by a pause request. */
  paused?: boolean;
  waitingOn?: string;
  finalOutput?: unknown;
  error?: string;
};

export type WorkflowNodeSnapshot = {
  nodeType: WorkflowNodeDefinition["nodeType"];
  timeoutMs?: number | null;
  statusDetail?: string;
  summary?: string;
  expectedOutput?: AgentExpectedOutput;
  actionExecution?: "function" | "shell";
  mountPath?: string[];
  localNodeId?: string;
  includeTransition?: "entry" | "exit";
  humanDecision?: {
    audience: string;
    dynamicAudience?: boolean;
    choices: HumanDecisionChoiceMap;
    onTimeout?: HumanDecisionTimeout;
    dynamicTimeout?: boolean;
  };
};

export type WorkflowDefinitionSnapshot = {
  schema: "pi-workflows.definition-snapshot.v1";
  name: string;
  contractId?: string;
  startAt: string;
  nodes: Record<string, WorkflowNodeSnapshot>;
  edges: WorkflowEdge[];
  composition?: WorkflowCompositionSnapshot;
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
  /** When the entry was recorded in workflow state. */
  at: string;
  /** Verbatim Pi session entry (has its own id/parentId/timestamp). */
  entry: Record<string, unknown>;
};

export type WorkflowSessionEventType =
  | "turn_started"
  | "turn_finished"
  | "message_started"
  | "assistant_event"
  | "message_finished"
  | "tool_execution_started"
  | "tool_execution_finished";

/** One normalized temporal Pi event in `session/events.ndjson`. */
export type WorkflowSessionEventRecord = {
  /** Starts at 1 and increases by exactly 1 within the file. */
  seq: number;
  /** Time when the extension received the public Pi event. */
  at: string;
  nodeId: string;
  attemptId: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  type: WorkflowSessionEventType;
  payload: Record<string, unknown>;
};

export type WorkflowSessionCaptureFailure = {
  failedAt: string;
  code: string;
  message: string;
};

/** Atomic integrity projection for the temporal session journal. */
export type WorkflowSessionCapture = {
  schema: "pi-workflows.session-capture.v1";
  eventSchema: "pi-workflows.session-event.v1";
  status: "recording" | "complete" | "failed";
  eventCount: number;
  entryCount: number;
  lastEventSeq: number;
  failure?: WorkflowSessionCaptureFailure;
};

export type WorkflowTraceEventDraft = Omit<WorkflowTraceEvent, "seq" | "at" | "runId">;

export type WorkflowRunResult = {
  runId: string;
  state: WorkflowRunState;
};

export type AgentStepCompletion = "submit" | "assistant";

export type AssistantMessageReceipt = {
  sha256: string;
  /** Pi session entry containing the visible response, when available. */
  entryId?: string;
  /** Present only when the workflow author supplied a limit. */
  maxChars?: number;
  /** True when recovery adopted an already visible response. */
  recovered?: boolean;
};

/** The step contract handed to the executor alongside the prompt. */
export type AgentStepContract = {
  runId: string;
  workflowName: string;
  nodeId: string;
  attemptId: string;
  completion: AgentStepCompletion;
  expectedOutput?: string;
  maxOutputChars?: number;
};

/** Optional human-facing labels for an agent step. They never affect execution. */
export type AgentStepPresentation = {
  runTitle?: string;
  statusDetail?: string;
};

export type AgentStepRequest = {
  contract: AgentStepContract;
  prompt: string;
  presentation?: AgentStepPresentation;
  /**
   * Validate a submission from the model. Returns the normalized output or an
   * error message the executor should surface to the model for retry.
   */
  accept: (output: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** Publish a non-completing update from a headless executor. */
  publishUpdate?: (
    update: WorkflowUpdateInput,
    idempotencyKey?: string,
  ) => Promise<WorkflowUpdateReceipt>;
};

export type AgentStepSubmission = {
  output: unknown;
  /** Receipt for a visible assistant response. */
  assistantMessage?: AssistantMessageReceipt;
  /**
   * The Pi conversation slice this step produced, when the executor records
   * one. Persisted verbatim into the step record and terminal node event.
   */
  conversation?: ConversationRange;
};

/**
 * Runs one agent step to completion. Implementations deliver the prompt to
 * the model and resolve once the configured output has been accepted.
 * Must reject with an `AbortError`-like error when `signal` aborts.
 */
export interface AgentStepExecutor {
  /**
   * `visible` supports assistant-message output. `park` asks the engine to
   * leave the run claimable for an origin session. Omission is unsupported.
   */
  readonly assistantMessageMode?: "visible" | "park" | "unsupported";
  runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission>;
}

export type WorkflowNotificationRequest = {
  runId: string;
  workflowName: string;
  nodeId: string;
  attemptId: string;
  /** Stable one-based occurrence of this notify node within the run. */
  notificationIndex: number;
  kind: "progress" | "final";
  content: string;
};

export type WorkflowNotificationReceipt = {
  notificationId: string;
  targetSessionId: string;
};

export interface WorkflowNotificationSink {
  notify(request: WorkflowNotificationRequest): MaybePromise<WorkflowNotificationReceipt>;
}

export type WorkflowEngineOptions = {
  executor: AgentStepExecutor;
  /** Durable destination for notify nodes. Required when a workflow uses one. */
  notificationSink?: WorkflowNotificationSink;
  /** Canonical SQLite database. Defaults to `~/.pi/agent/workflows/state.sqlite`. */
  databasePath?: string;
  /** Shared SQLite run store. */
  store?: import("./store.js").WorkflowRunStore;
  /**
   * Awaited after `run_started` is persisted, before any node executes.
   */
  onRunStarted?: (runId: string, state: WorkflowRunState) => MaybePromise<void>;
  /**
   * Awaited before the terminal snapshot is persisted. This is where a
   * session recorder stops and drains. Errors are swallowed: finishing the run wins.
   */
  onRunFinishing?: (runId: string, state: WorkflowRunState) => MaybePromise<void>;
  /** Default per-node timeout. Defaults to 15 minutes. */
  defaultNodeTimeoutMs?: number;
  /** Guard against unbounded graph loops. Defaults to 100 executed steps. */
  maxSteps?: number;
  /** Observer invoked after every persisted trace event. */
  onEvent?: (event: WorkflowTraceEvent, state: WorkflowRunState) => void;
};
