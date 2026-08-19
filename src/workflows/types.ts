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
   * Falls back to the engine default (15 minutes).
   */
  timeoutMs?: number | ((context: WorkflowNodeContext) => MaybePromise<number>);
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

export type LegacyHumanDecisionPrompt = {
  title: string;
  body: unknown;
  subject?: never;
  presentation?: never;
  revision?: never;
  /** Optional absolute expiry. An expired request cannot accept an answer. */
  expiresAt?: string;
};

export type PresentedHumanDecisionPrompt<TSubject = unknown> = {
  title: string;
  subject: TSubject;
  presentation: DecisionPresentation;
  body?: never;
  /** Positive revision of the decision subject and presentation. Defaults to 1. */
  revision?: number;
  /** Optional absolute expiry. An expired request cannot accept an answer. */
  expiresAt?: string;
};

export type HumanDecisionPrompt = LegacyHumanDecisionPrompt | PresentedHumanDecisionPrompt;

export type HumanDecisionAudience =
  | string
  | ((context: WorkflowNodeContext) => MaybePromise<string>);

export type HumanDecisionNodeContract = {
  audience: HumanDecisionAudience;
  choices: HumanDecisionChoiceMap;
  request: (context: WorkflowNodeContext) => MaybePromise<HumanDecisionPrompt>;
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
};

export type HumanDecisionRequestV1 = HumanDecisionRequestCommon & {
  schema: "pi-workflows.human-decision-request.v1";
  body: unknown;
};

export type HumanDecisionRequestV2 = HumanDecisionRequestCommon & {
  schema: "pi-workflows.human-decision-request.v2";
  subject: unknown;
  presentation: DecisionPresentation;
  revision: number;
  subjectDigest: string;
  presentationDigest: string;
};

export type HumanDecisionRequest = HumanDecisionRequestV1 | HumanDecisionRequestV2;

/**
 * Complete operator-facing request passed to a decision channel. It excludes
 * the canonical subject and legacy body by design.
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

type AcceptedHumanDecisionCommon = {
  decisionId: string;
  requestDigest: string;
  response: HumanDecisionResponse;
  source: HumanDecisionAnswerSource;
  idempotencyKey: string;
  acceptedAt: string;
  answerDigest: string;
};

export type AcceptedHumanDecisionV1 = AcceptedHumanDecisionCommon & {
  schema: "pi-workflows.human-decision-accepted.v1";
};

export type AcceptedHumanDecisionV2 = AcceptedHumanDecisionCommon & {
  schema: "pi-workflows.human-decision-accepted.v2";
  subjectDigest: string;
  presentationDigest: string;
  revision: number;
};

export type AcceptedHumanDecision = AcceptedHumanDecisionV1 | AcceptedHumanDecisionV2;

type HumanDecisionReceiptCommon = {
  decisionId: string;
  requestDigest: string;
  nodeId: string;
  response: HumanDecisionResponse;
  acceptedAt: string;
  answerDigest: string;
};

export type HumanDecisionReceiptV1 = HumanDecisionReceiptCommon & {
  schema: "pi-workflows.human-decision-receipt.v1";
};

export type HumanDecisionReceiptV2 = HumanDecisionReceiptCommon & {
  schema: "pi-workflows.human-decision-receipt.v2";
  subjectDigest: string;
  presentationDigest: string;
  revision: number;
};

export type HumanDecisionReceipt = HumanDecisionReceiptV1 | HumanDecisionReceiptV2;

export type HumanDecisionDeliveryRecordV1 = {
  schema: "pi-workflows.human-decision-delivery.v1";
  attemptId: string;
  decisionId: string;
  requestDigest: string;
  channel: string;
  state: "intent" | "confirmed" | "failed" | "unknown";
  createdAt: string;
  finishedAt?: string;
  messageCount?: number;
  errorCode?: string;
};

export type HumanDecisionDeliveryRecordV2 = {
  schema: "pi-workflows.human-decision-delivery.v2";
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

export type HumanDecisionDeliveryRecord =
  | HumanDecisionDeliveryRecordV1
  | HumanDecisionDeliveryRecordV2;

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
   * the engine and run bundle remain presentation-agnostic.
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
  /**
   * `seq` of the trace event this projection reflects. `trace.ndjson` is the
   * source of truth; a state whose `traceSeq` is older than the trace tail is
   * a stale projection.
   */
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
  timeoutMs?: number;
  statusDetail?: string;
  summary?: string;
  expectedOutput?: string;
  actionExecution?: "function" | "shell";
  mountPath?: string[];
  localNodeId?: string;
  includeTransition?: "entry" | "exit";
  humanDecision?: {
    audience: string;
    dynamicAudience?: boolean;
    choices: HumanDecisionChoiceMap;
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
  /** When the entry was recorded into the bundle. */
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
  | "tool_execution_updated"
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

export type WorkflowRunManifest = {
  schema: "pi-workflows.run-bundle.v1";
  runId: string;
  workflowName: string;
  runTitle?: string;
  workflowSource?: WorkflowSource;
  workflowSources?: WorkflowMountedSource[];
  definitionDigest?: string;
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
  /** Root directory for run bundles. Defaults to `~/.pi/agent/workflows/runs`. */
  outputRoot?: string;
  /**
   * Shared run store. Pass the same instance used by a session recorder so
   * trace sequence numbers stay single-writer. Defaults to a new store on
   * `outputRoot`.
   */
  store?: import("./store.js").WorkflowRunStore;
  /**
   * Awaited after `run_started` is persisted, before any node executes. This
   * is where a session recorder binds, so `session_bound` lands at the start
   * of the trace and can never trail the terminal event.
   */
  onRunStarted?: (runDir: string, state: WorkflowRunState) => MaybePromise<void>;
  /**
   * Awaited before the terminal snapshot is persisted. This is where a
   * session recorder stops and drains, so the bundle is immutable the moment
   * the terminal event exists. Errors are swallowed: finishing the run wins.
   */
  onRunFinishing?: (runDir: string, state: WorkflowRunState) => MaybePromise<void>;
  /** Default per-node timeout. Defaults to 15 minutes. */
  defaultNodeTimeoutMs?: number;
  /** Guard against unbounded graph loops. Defaults to 100 executed steps. */
  maxSteps?: number;
  /** Observer invoked after every persisted trace event. */
  onEvent?: (event: WorkflowTraceEvent, state: WorkflowRunState) => void;
};
