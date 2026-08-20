import path from "node:path";
import {
  runCommandBatch,
  type CommandBatchItem,
  type CommandBatchResult,
} from "../workflows/command-batch.js";
import {
  action,
  agent,
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
} from "../workflows/definition.js";
import { digest } from "../workflows/human-decision.js";
import type { WorkflowActionContext, WorkflowNodeContext } from "../workflows/types.js";
import autodocWorkflow, { type AutodocInput } from "./autodoc.workflow.js";
import {
  parseAutoimplementConcurrency,
  parseCiInspectionBatch,
  parsePublishedRepositories,
  parseVerificationCommandPlan,
  reviewerCommand,
  type AutoimplementConcurrency,
  type CiInspectionBatch,
  type PublishedRepositories,
  type PublishedRepository,
  type VerificationCommandPlan,
} from "./autoimplement-command-batches.js";
import autoplanWorkflow, { type AutoplanInput } from "./autoplan.workflow.js";
import planApprovalWorkflow, { type PlanApprovalInput } from "./plan-approval.workflow.js";

export type AutoimplementInput = {
  task: string;
  plan?: unknown;
  scope?: string;
  constraints?: string[];
  repository?: string;
  baseBranch?: string;
  merge?: boolean;
  documents?: string[];
  documentation?: {
    status: "current";
    planDigest: string;
    documents: string[];
  };
  approval?: {
    audience: string;
    maxReplans: number;
  };
  concurrency?: Partial<AutoimplementConcurrency>;
};

export type ExistingPlanDiscovery = {
  route: "found" | "blocked";
  plan?: unknown;
  documentation?: "current" | "missing" | "stale";
  documents: string[];
  reason: string;
  evidence: unknown;
};

type ReviewFinding = {
  severity: "P0" | "P1" | "P2" | "lower";
  kind: "design" | "implementation";
  summary: string;
};

type RepositoryReviewAssessment = {
  id: string;
  repository: string;
  baseBranch: string;
  headRevision: string;
  dependencyFingerprint?: string;
  invocationSucceeded: boolean;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  reason: string;
};

type ReviewAssessment = {
  route: "critical" | "p2" | "clean" | "command_error";
  invocationSucceeded: boolean;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  reason: string;
  repositories?: RepositoryReviewAssessment[];
};

export type AutoimplementCompleted = {
  status: "completed";
  task: string;
  plan: unknown;
  implementation: unknown;
  verification: unknown;
  reviewRounds: ReviewAssessment[];
  ci: unknown;
  delivery: unknown;
};

export type AutoimplementBlocked = {
  status: "blocked";
  task: string;
  reason: string;
  evidence: unknown;
};

type BlockerChallenge = {
  route: "continue" | "blocked";
  blockingNow: boolean;
  outsideAuthority: boolean;
  canProceed: boolean;
  reason: string;
  nextAction: string;
  alternativesChecked: string[];
  evidence: string[];
};

const MAX_BLOCKER_CHALLENGES = 3;
const MAX_CHALLENGE_ITEMS = 5;
const MAX_CHALLENGE_TEXT = 500;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function boundedChallengeItems(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CHALLENGE_ITEMS) {
    throw new Error(`${label} must be an array with at most ${MAX_CHALLENGE_ITEMS} items`);
  }
  return value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (text.length > MAX_CHALLENGE_TEXT) {
      throw new Error(`${label}[${index}] must be at most ${MAX_CHALLENGE_TEXT} characters`);
    }
    return text;
  });
}

function parseBlockerChallenge(value: unknown): BlockerChallenge {
  const result = requireRecord(value, "blocker challenge");
  if (result.route !== "continue" && result.route !== "blocked") {
    throw new Error("blocker challenge route must be continue or blocked");
  }
  for (const key of ["blockingNow", "outsideAuthority", "canProceed"] as const) {
    if (typeof result[key] !== "boolean") {
      throw new Error(`blocker challenge ${key} must be a boolean`);
    }
  }
  const blockingNow = result.blockingNow as boolean;
  const outsideAuthority = result.outsideAuthority as boolean;
  const canProceed = result.canProceed as boolean;
  const reason = requireString(result.reason, "blocker challenge reason");
  if (reason.length > MAX_CHALLENGE_TEXT) {
    throw new Error(`blocker challenge reason must be at most ${MAX_CHALLENGE_TEXT} characters`);
  }
  if (typeof result.nextAction !== "string") {
    throw new Error("blocker challenge nextAction must be a string");
  }
  const nextAction = result.nextAction.trim();
  if (nextAction.length > MAX_CHALLENGE_TEXT) {
    throw new Error(
      `blocker challenge nextAction must be at most ${MAX_CHALLENGE_TEXT} characters`,
    );
  }
  const alternativesChecked = boundedChallengeItems(
    result.alternativesChecked,
    "blocker challenge alternativesChecked",
  );
  const evidence = boundedChallengeItems(result.evidence, "blocker challenge evidence");

  if (result.route === "blocked") {
    if (
      blockingNow !== true ||
      outsideAuthority !== true ||
      canProceed !== false ||
      nextAction.length > 0 ||
      alternativesChecked.length === 0 ||
      evidence.length === 0
    ) {
      throw new Error(
        "blocked challenge requires blockingNow=true, outsideAuthority=true, canProceed=false, an empty nextAction, and concrete alternatives and evidence",
      );
    }
  } else if (canProceed !== true || nextAction.length === 0) {
    throw new Error("continue challenge requires canProceed=true and a practical nextAction");
  }

  return {
    route: result.route,
    blockingNow,
    outsideAuthority,
    canProceed,
    reason,
    nextAction,
    alternativesChecked,
    evidence,
  };
}

function parseInput(value: unknown): AutoimplementInput {
  const input = requireRecord(value, "autoimplement input");
  const constraints = input.constraints;
  if (
    constraints !== undefined &&
    (!Array.isArray(constraints) || constraints.some((item) => typeof item !== "string"))
  ) {
    throw new Error("autoimplement constraints must be an array of strings");
  }
  if (input.merge !== undefined && typeof input.merge !== "boolean") {
    throw new Error("autoimplement merge must be a boolean");
  }
  const documents = input.documents;
  if (
    documents !== undefined &&
    (!Array.isArray(documents) || documents.some((item) => typeof item !== "string"))
  ) {
    throw new Error("autoimplement documents must be an array of strings");
  }
  let documentation: AutoimplementInput["documentation"];
  if (input.documentation !== undefined) {
    if (input.plan === undefined) {
      throw new Error("autoimplement documentation requires an explicit plan");
    }
    const raw = requireRecord(input.documentation, "autoimplement documentation");
    if (raw.status !== "current") {
      throw new Error("autoimplement documentation status must be current");
    }
    const planDigest = requireString(raw.planDigest, "autoimplement documentation planDigest");
    if (planDigest !== digest(input.plan)) {
      throw new Error("autoimplement documentation planDigest does not match the explicit plan");
    }
    if (!Array.isArray(raw.documents) || raw.documents.some((item) => typeof item !== "string")) {
      throw new Error("autoimplement documentation documents must be an array of strings");
    }
    documentation = {
      status: "current",
      planDigest,
      documents: [...raw.documents] as string[],
    };
  }
  const concurrency = parseAutoimplementConcurrency(input.concurrency);
  let approval: AutoimplementInput["approval"];
  if (input.approval !== undefined) {
    const raw = requireRecord(input.approval, "autoimplement approval");
    const maxReplans = raw.maxReplans ?? 3;
    if (
      !Number.isInteger(maxReplans) ||
      (maxReplans as number) < 1 ||
      (maxReplans as number) > 20
    ) {
      throw new Error("autoimplement approval maxReplans must be from 1 through 20");
    }
    approval = {
      audience: requireString(raw.audience, "autoimplement approval audience"),
      maxReplans: maxReplans as number,
    };
  }
  return {
    task: requireString(input.task, "autoimplement task"),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.scope !== undefined ? { scope: requireString(input.scope, "scope") } : {}),
    ...(constraints !== undefined ? { constraints: [...constraints] as string[] } : {}),
    ...(input.repository !== undefined
      ? { repository: requireString(input.repository, "repository") }
      : {}),
    ...(input.baseBranch !== undefined
      ? { baseBranch: requireString(input.baseBranch, "baseBranch") }
      : {}),
    merge: input.merge === true,
    ...(documents !== undefined ? { documents: [...documents] as string[] } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    ...(approval !== undefined ? { approval } : {}),
    concurrency,
  };
}

function parseExistingPlan(value: unknown): ExistingPlanDiscovery {
  const result = requireRecord(value, "existing plan discovery");
  if (result.route !== "found" && result.route !== "blocked") {
    throw new Error("existing plan discovery route must be found or blocked");
  }
  if (result.route === "found") {
    if (result.plan === undefined) throw new Error("found plan must include plan");
    if (
      result.documentation !== "current" &&
      result.documentation !== "missing" &&
      result.documentation !== "stale"
    ) {
      throw new Error("found plan documentation must be current, missing, or stale");
    }
  }
  if (
    !Array.isArray(result.documents) ||
    result.documents.some((item) => typeof item !== "string")
  ) {
    throw new Error("existing plan documents must be an array of strings");
  }
  return {
    route: result.route,
    ...(result.plan !== undefined ? { plan: result.plan } : {}),
    ...(result.documentation !== undefined
      ? { documentation: result.documentation as "current" | "missing" | "stale" }
      : {}),
    documents: [...result.documents] as string[],
    reason: requireString(result.reason, "existing plan discovery reason"),
    evidence: result.evidence ?? null,
  };
}

function parseRoute<T extends string>(
  value: unknown,
  routes: readonly T[],
  label: string,
): Record<string, unknown> & { route: T } {
  const record = requireRecord(value, label);
  if (!routes.includes(record.route as T)) {
    throw new Error(`${label} route must be one of ${routes.join(", ")}`);
  }
  return { ...record, route: record.route as T };
}

type ReviewCommandSelection = {
  route: "run" | "reuse";
  repositories: PublishedRepository[];
  commands: CommandBatchItem[];
};

type BatchExecution = {
  route: "assess" | "repair";
  batch: CommandBatchResult;
};

function concurrency(context: WorkflowNodeContext): AutoimplementConcurrency {
  return parseAutoimplementConcurrency((context.input as AutoimplementInput).concurrency);
}

async function runAutoimplementBatch(
  context: WorkflowActionContext,
  kind: "review" | "ciWatch" | "verification",
  commands: CommandBatchItem[],
  maxConcurrency: number,
): Promise<CommandBatchResult> {
  return await runCommandBatch(
    { items: commands, maxConcurrency: Math.min(maxConcurrency, Math.max(1, commands.length)) },
    {
      signal: context.signal,
      onItemSettled: async (result, completed, total) => {
        if (context.signal.aborted) return;
        try {
          await context.publishUpdate({
            type: "command-batch.item",
            key: `${kind}/${result.id}`,
            data: {
              schema: "pi-workflows.command-batch-item.v1",
              batchKind: kind,
              itemId: result.id,
              outcome: result.outcome,
              completed,
              total,
            },
          });
        } catch (error) {
          if (!context.signal.aborted) throw error;
        }
      },
    },
  );
}

function commandBatchTimeoutMs(commands: CommandBatchItem[], maxConcurrency: number): number {
  if (commands.length === 0) return 10_000;
  const concurrency = Math.min(maxConcurrency, commands.length);
  const waves = Math.ceil(commands.length / concurrency);
  const longestItem = Math.max(...commands.map((command) => command.timeoutMs));
  return waves * longestItem + 10_000;
}

function reviewBatchNeedsRepair(result: CommandBatchResult): boolean {
  return result.items.some(
    (item) =>
      item.outcome === "timedOut" ||
      item.outcome === "cancelled" ||
      (item.outcome === "failed" && item.exitCode === null) ||
      item.stdoutTruncated ||
      item.stderrTruncated,
  );
}

function latestOutput<T>(context: WorkflowNodeContext, nodeIds: string[]): T {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && nodeIds.includes(step.nodeId)) return step.output as T;
  }
  for (const nodeId of nodeIds) {
    if (context.outputs[nodeId] !== undefined) return context.outputs[nodeId] as T;
  }
  throw new Error(`No output found for ${nodeIds.join(" or ")}`);
}

function currentPlan(context: WorkflowNodeContext): unknown {
  const adopted = context.outputs.adoptPlan as { plan?: unknown } | undefined;
  if (adopted?.plan !== undefined) return adopted.plan;
  const documented = context.outputs.documentation as
    | { exit?: string; output?: { plan?: unknown } }
    | undefined;
  if (documented?.exit === "ready" && documented.output?.plan !== undefined) {
    return documented.output.plan;
  }
  const discovered = context.outputs.findPlan as ExistingPlanDiscovery | undefined;
  if (discovered?.route === "found" && discovered.plan !== undefined) return discovered.plan;
  return (context.input as AutoimplementInput).plan;
}

function currentPlanDigest(context: WorkflowNodeContext): string {
  const adopted = context.outputs.adoptPlan as { planDigest?: unknown } | undefined;
  if (typeof adopted?.planDigest === "string") return adopted.planDigest;
  const documented = context.outputs.documentation as
    | { exit?: string; output?: { planDigest?: unknown } }
    | undefined;
  if (documented?.exit === "ready" && typeof documented.output?.planDigest === "string") {
    return documented.output.planDigest;
  }
  const plan = currentPlan(context);
  if (plan === undefined) throw new Error("autoimplement does not have a selected plan");
  return digest(plan);
}

function blockerChallenges(context: WorkflowNodeContext): BlockerChallenge[] {
  return context.state.steps
    .filter((step) => step.nodeId === "challengeBlocker" && step.outcome === "ok")
    .map((step) => step.output as BlockerChallenge);
}

function latestBlockerClaim(context: WorkflowNodeContext): unknown {
  const ids = [
    "classifyImplementation",
    "classifyVerification",
    "repairReviewCommand",
    "inspectComments",
    "inspectCi",
    "repairCiCommand",
    "assessTrackedCi",
    "classifyCi",
    "finalizeDelivery",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && ids.includes(step.nodeId)) {
      return { source: step.nodeId, result: step.output };
    }
  }
  throw new Error("No model-generated blocker claim is available to challenge");
}

function recentWorkflowAttempts(context: WorkflowNodeContext): unknown[] {
  return context.state.steps.slice(-12).map((step) => ({
    nodeId: step.nodeId,
    outcome: step.outcome,
    output: step.output,
  }));
}

function latestIssue(context: WorkflowNodeContext): unknown {
  const approval = context.outputs.approval as
    | { exit?: string; output?: { instructions?: unknown } }
    | undefined;
  if (approval?.exit === "replan" && typeof approval.output?.instructions === "string") {
    return {
      source: "human-replan",
      instructions: approval.output.instructions,
      priorPlanDigest: currentPlanDigest(context),
    };
  }
  const ids = [
    "challengeBlocker",
    "classifyImplementation",
    "classifyVerification",
    "triageReview",
    "inspectComments",
    "classifyCi",
    "adoptPlan",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && ids.includes(step.nodeId)) return step.output;
  }
  return null;
}

function parseFinding(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding {
  const finding = requireRecord(value, `${severity} finding`);
  if (finding.kind !== "design" && finding.kind !== "implementation") {
    throw new Error(`${severity} finding kind must be design or implementation`);
  }
  return {
    severity,
    kind: finding.kind,
    summary: requireString(finding.summary, `${severity} finding summary`),
  };
}

function parseVerificationForContext(
  value: unknown,
  context: WorkflowNodeContext,
): VerificationCommandPlan {
  const plan = parseVerificationCommandPlan(value);
  const implementation = latestOutput<Record<string, unknown>>(context, ["implement"]);
  const reported = Array.isArray(implementation.repositories)
    ? implementation.repositories.filter((entry): entry is string => typeof entry === "string")
    : [];
  const request = context.input as AutoimplementInput;
  const roots = new Set(
    (reported.length > 0 ? reported : [request.repository ?? process.cwd()]).map((entry) =>
      path.resolve(entry),
    ),
  );
  for (const command of plan.commands) {
    if (!roots.has(path.resolve(command.cwd))) {
      throw new Error(
        `verification command cwd was not reported by implementation: ${command.cwd}`,
      );
    }
  }
  return plan;
}

function currentPublishedRepositories(context: WorkflowNodeContext): PublishedRepositories {
  return latestOutput<PublishedRepositories>(context, ["verifyP2", "publish"]);
}

type DeliveryRepositoryResult = {
  repository: string;
  pr: string;
  merged: boolean;
  reportComment: string;
  reason: string;
};

function parseDeliveryRepository(value: unknown, index: number): DeliveryRepositoryResult {
  const result = requireRecord(value, `delivery repositories[${index}]`);
  const repository = requireString(result.repository, `delivery repositories[${index}].repository`);
  if (!path.isAbsolute(repository)) {
    throw new Error(`delivery repositories[${index}].repository must be absolute`);
  }
  if (typeof result.merged !== "boolean") {
    throw new Error(`delivery repositories[${index}].merged must be a boolean`);
  }
  return {
    repository: path.resolve(repository),
    pr: requireString(result.pr, `delivery repositories[${index}].pr`),
    merged: result.merged,
    reportComment: requireString(
      result.reportComment,
      `delivery repositories[${index}].reportComment`,
    ),
    reason: requireString(result.reason, `delivery repositories[${index}].reason`),
  };
}

function parseDeliveryResult(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> {
  const result = requireRecord(value, "delivery result");
  if (result.status !== "completed" && result.status !== "blocked") {
    throw new Error("delivery status must be completed or blocked");
  }
  const request = context.input as AutoimplementInput;
  if (request.merge !== true && result.merged === true) {
    throw new Error("delivery cannot merge without explicit merge: true");
  }
  if (result.status === "blocked") return result;
  if (typeof result.merged !== "boolean") {
    throw new Error("completed delivery merged must be a boolean");
  }
  const pr = requireString(result.pr, "completed delivery pr");
  const reportComment = requireString(result.reportComment, "completed delivery reportComment");
  const reason = requireString(result.reason, "completed delivery reason");
  const published = currentPublishedRepositories(context).repositories;
  let repositories: DeliveryRepositoryResult[];
  if (result.repositories === undefined) {
    if (published.length !== 1) {
      throw new Error("completed delivery repositories must cover every published repository");
    }
    const only = published[0];
    if (only === undefined) throw new Error("completed delivery has no published repository");
    repositories = [
      {
        repository: path.resolve(only.repository),
        pr,
        merged: result.merged,
        reportComment,
        reason,
      },
    ];
  } else {
    if (!Array.isArray(result.repositories)) {
      throw new Error("completed delivery repositories must be an array");
    }
    repositories = result.repositories.map(parseDeliveryRepository);
  }
  const actual = new Map<string, DeliveryRepositoryResult>();
  for (const repository of repositories) {
    if (actual.has(repository.repository)) {
      throw new Error(`completed delivery repository is duplicated: ${repository.repository}`);
    }
    actual.set(repository.repository, repository);
  }
  const mergeExpected = request.merge === true;
  for (const expected of published) {
    const repository = actual.get(path.resolve(expected.repository));
    if (repository === undefined || repository.pr !== expected.pr) {
      throw new Error(
        `completed delivery does not match published repository and PR: ${expected.repository}`,
      );
    }
    if (repository.merged !== mergeExpected) {
      throw new Error(
        `completed delivery merge result does not match merge policy: ${expected.repository}`,
      );
    }
    actual.delete(repository.repository);
  }
  if (actual.size > 0) {
    throw new Error(
      `completed delivery contains unpublished repositories: ${[...actual.keys()].join(", ")}`,
    );
  }
  const firstPublished = published[0];
  const first =
    firstPublished === undefined
      ? undefined
      : repositories.find(
          (repository) => repository.repository === path.resolve(firstPublished.repository),
        );
  if (
    first === undefined ||
    first.pr !== pr ||
    first.merged !== result.merged ||
    first.reportComment !== reportComment
  ) {
    throw new Error(
      "completed delivery top-level compatibility fields must match the first result",
    );
  }
  return { status: "completed", merged: result.merged, pr, reportComment, reason, repositories };
}

function parseP2Verification(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> {
  const result = requireRecord(value, "P2 verification");
  if (typeof result.passed !== "boolean") {
    throw new Error("P2 verification passed must be a boolean");
  }
  if (result.pushed !== true) {
    throw new Error("P2 verification pushed must be true");
  }
  const refreshed = parsePublishedRepositories(result);
  const previous = latestOutput<PublishedRepositories>(context, ["publish"]);
  const expected = new Map(
    previous.repositories.map((repository) => [repository.id, repository] as const),
  );
  for (const repository of refreshed.repositories) {
    const prior = expected.get(repository.id);
    if (
      prior === undefined ||
      prior.repository !== repository.repository ||
      prior.branch !== repository.branch ||
      prior.baseBranch !== repository.baseBranch ||
      prior.pr !== repository.pr ||
      prior.dependencyFingerprint !== repository.dependencyFingerprint
    ) {
      throw new Error(`P2 verification repository does not match publication: ${repository.id}`);
    }
    expected.delete(repository.id);
  }
  if (expected.size > 0) {
    throw new Error(
      `P2 verification is missing repository ids: ${[...expected.keys()].join(", ")}`,
    );
  }
  return { ...result, repositories: refreshed.repositories };
}

function parseCiInspectionForPublished(
  value: unknown,
  context: WorkflowNodeContext,
): CiInspectionBatch {
  const inspected = parseCiInspectionBatch(value);
  const published = currentPublishedRepositories(context);
  const expected = new Map(
    published.repositories.map((repository) => [repository.id, repository] as const),
  );
  for (const target of inspected.targets) {
    const repository = expected.get(target.id);
    if (
      repository === undefined ||
      repository.repository !== target.repository ||
      repository.headRevision !== target.headRevision ||
      repository.pr !== target.pr
    ) {
      throw new Error(
        `CI target does not match the published repository and head: ${target.id} (${JSON.stringify({ target, repository })})`,
      );
    }
    expected.delete(target.id);
  }
  if (expected.size > 0) {
    throw new Error(`CI inspection is missing repository ids: ${[...expected.keys()].join(", ")}`);
  }
  return inspected;
}

function parseTrackedCiAssessment(
  value: unknown,
  context: WorkflowNodeContext,
): Record<string, unknown> & { route: CiInspectionBatch["route"] } {
  const result = requireRecord(value, "tracked CI assessment");
  const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
  const execution = latestOutput<BatchExecution>(context, ["trackCi"]);
  const expectedIds = execution.batch.items.map((item) => item.id);
  if (!Array.isArray(result.targets)) {
    throw new Error("tracked CI assessment targets must be an array");
  }
  const seen = new Set<string>();
  const targets = result.targets.map((entry, index) => {
    const target = requireRecord(entry, `tracked CI assessment targets[${index}]`);
    const id = requireString(target.id, `tracked CI assessment targets[${index}].id`);
    if (seen.has(id)) throw new Error(`tracked CI assessment target is duplicated: ${id}`);
    seen.add(id);
    if (
      target.route !== "green" &&
      target.route !== "failed" &&
      target.route !== "pending" &&
      target.route !== "unavailable"
    ) {
      throw new Error(`tracked CI assessment targets[${index}].route is invalid`);
    }
    return {
      id,
      route: target.route,
      reason: requireString(target.reason, `tracked CI assessment targets[${index}].reason`),
    };
  });
  const missing = expectedIds.filter((id) => !seen.has(id));
  const unexpected = [...seen].filter((id) => !expectedIds.includes(id));
  if (missing.length > 0 || unexpected.length > 0 || targets.length !== expectedIds.length) {
    throw new Error(
      `tracked CI assessment targets must exactly cover watched ids; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
  const trackedRoutes = new Map(targets.map((target) => [target.id, target.route] as const));
  const routes = inspected.targets.map((target) => trackedRoutes.get(target.id) ?? target.route);
  const route = routes.includes("failed")
    ? "failed"
    : routes.includes("pending")
      ? "pending"
      : routes.includes("unavailable")
        ? "unavailable"
        : "green";
  if (result.route !== route) {
    throw new Error(`tracked CI assessment route must be ${route}`);
  }
  return {
    ...result,
    route,
    reason: requireString(result.reason, "tracked CI assessment reason"),
    targets,
    relatedFailures: requireStringArray(
      result.relatedFailures ?? [],
      "tracked CI assessment relatedFailures",
    ),
    unrelatedFailures: requireStringArray(
      result.unrelatedFailures ?? [],
      "tracked CI assessment unrelatedFailures",
    ),
  };
}

function selectReviewCommands(context: WorkflowNodeContext): ReviewCommandSelection {
  const published = latestOutput<PublishedRepositories>(context, ["publish"]);
  const reviewed = reviewRounds(context).flatMap((round) => round.repositories ?? []);
  const repositories = published.repositories.filter(
    (repository) =>
      !reviewed.some(
        (entry) =>
          entry.id === repository.id &&
          entry.headRevision === repository.headRevision &&
          entry.dependencyFingerprint === repository.dependencyFingerprint &&
          entry.invocationSucceeded,
      ),
  );
  return {
    route: repositories.length === 0 ? "reuse" : "run",
    repositories,
    commands: repositories.map(reviewerCommand),
  };
}

function parseReviewAssessment(value: unknown, context: WorkflowNodeContext): ReviewAssessment {
  const review = requireRecord(value, "review assessment");
  if (!Array.isArray(review.repositories)) {
    throw new Error("review repositories must be an array");
  }
  const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
  const expected = new Map(selected.repositories.map((repository) => [repository.id, repository]));
  const repositories = review.repositories.map((value, index) => {
    const raw = requireRecord(value, `review repositories[${index}]`);
    const id = requireString(raw.id, `review repositories[${index}].id`);
    const published = expected.get(id);
    if (published === undefined)
      throw new Error(`review repository id was not in the batch: ${id}`);
    expected.delete(id);
    const parseList = (key: "p0" | "p1" | "p2" | "lower", severity: ReviewFinding["severity"]) => {
      const list = raw[key];
      if (!Array.isArray(list))
        throw new Error(`review repositories[${index}].${key} must be an array`);
      return list.map((item) => parseFinding(item, severity));
    };
    return {
      id,
      repository: published.repository,
      baseBranch: published.baseBranch,
      headRevision: published.headRevision,
      ...(published.dependencyFingerprint !== undefined
        ? { dependencyFingerprint: published.dependencyFingerprint }
        : {}),
      invocationSucceeded: raw.invocationSucceeded === true,
      p0: parseList("p0", "P0"),
      p1: parseList("p1", "P1"),
      p2: parseList("p2", "P2"),
      lower: parseList("lower", "lower"),
      reason: requireString(raw.reason, `review repositories[${index}].reason`),
    } satisfies RepositoryReviewAssessment;
  });
  if (expected.size > 0) {
    throw new Error(
      `review assessment is missing repository ids: ${[...expected.keys()].join(", ")}`,
    );
  }
  const p0 = repositories.flatMap((entry) => entry.p0);
  const p1 = repositories.flatMap((entry) => entry.p1);
  const p2 = repositories.flatMap((entry) => entry.p2);
  const lower = repositories.flatMap((entry) => entry.lower);
  const invocationSucceeded = repositories.every((entry) => entry.invocationSucceeded);
  const route = !invocationSucceeded
    ? "command_error"
    : p0.length + p1.length > 0
      ? "critical"
      : p2.length > 0
        ? "p2"
        : "clean";
  return {
    route,
    invocationSucceeded,
    p0,
    p1,
    p2,
    lower,
    reason: requireString(review.reason, "review reason"),
    repositories,
  };
}

function reviewRounds(context: WorkflowNodeContext): ReviewAssessment[] {
  return context.state.steps
    .filter((step) => step.nodeId === "assessReview" && step.outcome === "ok")
    .map((step) => step.output as ReviewAssessment);
}

function reviewRoundsForOutput(context: WorkflowNodeContext): ReviewAssessment[] {
  const rounds = reviewRounds(context);
  const repositoryIds = new Set(
    rounds.flatMap((round) => (round.repositories ?? []).map((repository) => repository.id)),
  );
  if (repositoryIds.size > 1) return rounds;
  return rounds.map(({ repositories: _repositories, ...round }) => round);
}

function ciForOutput(context: WorkflowNodeContext): unknown {
  const result = latestOutput<Record<string, unknown>>(context, ["assessTrackedCi", "inspectCi"]);
  const targets = result.targets;
  if (!Array.isArray(targets) || targets.length !== 1) return result;
  const { targets: _targets, ...aggregate } = result;
  if (result.route === "green" || result.route === "failed" || result.route === "unavailable") {
    const target = targets[0];
    if (target !== null && typeof target === "object" && !Array.isArray(target)) {
      const record = target as Record<string, unknown>;
      return {
        ...aggregate,
        reason: aggregate.reason ?? record.reason,
        relatedFailures: aggregate.relatedFailures ?? record.relatedFailures ?? [],
        unrelatedFailures: aggregate.unrelatedFailures ?? record.unrelatedFailures ?? [],
      };
    }
  }
  return aggregate;
}

function latestBlockedReason(context: WorkflowNodeContext): { reason: string; evidence: unknown } {
  const candidates = [
    "challengeBlockerGuard",
    "challengeBlocker",
    "finalizeDelivery",
    "inspectCi",
    "assessTrackedCi",
    "classifyCi",
    "inspectComments",
    "classifyImplementation",
    "classifyVerification",
    "triageReview",
    "replanGuard",
    "adoptPlan",
    "findPlan",
    "documentation",
    "approval",
  ];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (!step || !candidates.includes(step.nodeId)) continue;
    const output = step.output as Record<string, unknown>;
    const reason = output.reason ?? output.blocker ?? output.summary;
    if (typeof reason === "string" && reason.length > 0) return { reason, evidence: step.output };
  }
  return {
    reason: "Autoimplementation could not continue within the authorized scope.",
    evidence: null,
  };
}

export const autoimplementWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.autoimplement.v1",
  name: "autoimplement",
  input: parseInput,
  title: ({ input }) => `autoimplement: ${input.task.slice(0, 60)}`,
  presentationPrompt:
    "Summarize what was implemented, the review rounds by severity, the CI result, the PR or merge result, and any remaining limitation. Include exact validation commands.",
  startAt: "prepare",
  maxSteps: 240,
  includes: {
    documentation: includeWorkflow(autodocWorkflow, {
      input: (context): AutodocInput => {
        const request = context.input as AutoimplementInput;
        const discovery = context.outputs.findPlan as ExistingPlanDiscovery | undefined;
        const plan = currentPlan(context);
        if (plan === undefined) throw new Error("autoimplement documentation is missing a plan");
        return {
          task: request.task,
          plan,
          ...(request.repository !== undefined ? { repository: request.repository } : {}),
          documents:
            request.documents ?? request.documentation?.documents ?? discovery?.documents ?? [],
          evidence: latestIssue(context),
        };
      },
    }),
    approval: includeWorkflow(planApprovalWorkflow, {
      input: (context): PlanApprovalInput => {
        const request = context.input as AutoimplementInput;
        if (request.approval === undefined) {
          throw new Error("autoimplement approval was entered without an approval policy");
        }
        const plan = currentPlan(context);
        if (plan === undefined) throw new Error("autoimplement approval is missing a plan");
        const revisions = context.state.steps.filter(
          (step) => step.nodeId === "approval/approve",
        ).length;
        return {
          task: request.task,
          plan,
          planDigest: currentPlanDigest(context),
          audience: request.approval.audience,
          revision: revisions + 1,
        };
      },
    }),
    redesign: includeWorkflow({
      workflow: "autoplan",
      contract: autoplanWorkflow,
      input: (context): AutoplanInput => {
        const request = context.input as AutoimplementInput;
        return {
          problem: request.task,
          ...(request.scope !== undefined ? { scope: request.scope } : {}),
          ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
          ...(currentPlan(context) !== undefined ? { previousPlan: currentPlan(context) } : {}),
          newEvidence: latestIssue(context),
        };
      },
    }),
  },
  exits: {
    completed: {
      from: "finalize",
      validate: (value: unknown): AutoimplementCompleted => value as AutoimplementCompleted,
    },
    blocked: {
      from: "blocked",
      validate: (value: unknown): AutoimplementBlocked => value as AutoimplementBlocked,
    },
  },
  nodes: {
    prepare: compute({
      run: ({ input }) => {
        const request = input as AutoimplementInput;
        return {
          route:
            request.plan === undefined
              ? "find"
              : request.documentation?.status === "current"
                ? "ready"
                : "document",
        };
      },
    }),
    findPlan: agent({
      statusDetail: "finding existing plan",
      prompt: ({ input }) => {
        const request = input as AutoimplementInput;
        return [
          "Find the clear plan that has already been selected for this task.",
          "Use the current conversation context and referenced canonical documents.",
          "Do not devise, improve, replace, document, or implement a plan.",
          "Return blocked when no single clear existing plan can be found.",
          "Report whether its canonical documentation is current, missing, or stale.",
          `Task: ${request.task}`,
          `Repository: ${request.repository ?? "current repository"}`,
          `Referenced documents: ${JSON.stringify(request.documents ?? [])}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "route": "found" | "blocked", "plan": {} (required when found), "documentation": "current" | "missing" | "stale" (required when found), "documents": ["canonical file"], "reason": "reason", "evidence": "evidence" }',
      validate: parseExistingPlan,
    }),
    routeFoundPlan: compute({
      run: ({ outputs }) => {
        const discovered = outputs.findPlan as ExistingPlanDiscovery;
        if (discovered.route !== "found" || discovered.plan === undefined) {
          return { route: "blocked", reason: discovered.reason, evidence: discovered.evidence };
        }
        return {
          route: discovered.documentation === "current" ? "ready" : "document",
          plan: discovered.plan,
          reason: discovered.reason,
          evidence: discovered.evidence,
        };
      },
    }),
    adoptPlan: compute({
      run: ({ outputs }) => {
        const result = includedResult(autoplanWorkflow, outputs.redesign);
        if (result.exit !== "ready") throw new Error("redesign did not return a ready plan");
        return {
          route: result.output.changed ? "document" : "blocked",
          plan: result.output.plan,
          planDigest: result.output.planDigest,
          changed: result.output.changed,
          reason: result.output.changed
            ? "The plan changed in response to new evidence and must be documented."
            : "Redesign returned the same plan for the same unresolved evidence.",
        };
      },
    }),
    maybeApproval: compute({
      run: ({ input }) => ({
        route: (input as AutoimplementInput).approval === undefined ? "implement" : "approve",
      }),
    }),
    replanGuard: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        const limit = request.approval?.maxReplans ?? 3;
        const replans = context.state.steps.filter(
          (step) => step.nodeId === "approval/replan",
        ).length;
        return replans > limit
          ? {
              route: "blocked",
              reason: `Plan approval reached the ${limit}-replan safety limit.`,
              evidence: context.outputs.approval,
            }
          : { route: "redesign", replans, limit };
      },
    }),
    implement: agent({
      timeoutMs: 60 * 60_000,
      statusDetail: "implementing",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          `Implement this task end-to-end: ${request.task}`,
          `Plan: ${JSON.stringify(currentPlan(context))}`,
          `Authorized scope: ${request.scope ?? request.repository ?? "the current repository and task"}`,
          `Constraints: ${JSON.stringify(request.constraints ?? [])}`,
          "Follow repository instructions and use the most elegant long-term production-ready implementation without unnecessary work.",
          "If implementation exposes a new design or scope problem, report it precisely instead of forcing the old plan.",
          "Report every changed repository as an absolute path so independent verification can be bounded safely.",
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "status": "implemented" | "issue" | "blocked", "summary": "work completed or issue", "files": ["changed file"], "repositories": ["absolute repository path changed"], "issueKind": "design" | "implementation" | null, "evidence": "new evidence" }`,
      validate: (value) => requireRecord(value, "implementation result"),
    }),
    classifyImplementation: agent({
      statusDetail: "assessing implementation",
      prompt: ({ outputs }) =>
        [
          "Assess the implementation result.",
          "Choose verify when implementation is ready for tests.",
          "Choose redesign when new evidence invalidates the plan.",
          "Choose fix for a local implementation issue that does not change the plan.",
          "Choose blocked only for a material issue outside the authorized scope.",
          `Implementation: ${JSON.stringify(outputs.implement)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "verify" | "redesign" | "fix" | "blocked", "summary": "reason", "evidence": "evidence" }`,
      validate: (value) =>
        parseRoute(
          value,
          ["verify", "redesign", "fix", "blocked"] as const,
          "implementation assessment",
        ),
    }),
    challengeBlockerGuard: compute({
      run: (context) => {
        const challenges = blockerChallenges(context);
        return challenges.length >= MAX_BLOCKER_CHALLENGES
          ? {
              route: "blocked",
              reason: `Blocker challenge reached the ${MAX_BLOCKER_CHALLENGES}-attempt workflow safety limit.`,
              evidence: { attempts: challenges.length, challenges },
            }
          : {
              route: "challenge",
              attempt: challenges.length + 1,
              limit: MAX_BLOCKER_CHALLENGES,
            };
      },
    }),
    challengeBlocker: agent({
      statusDetail: "challenging blocker claim",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          "Independently challenge the latest claim that autoimplement is blocked.",
          "Are you really blocked?",
          "Is this really a blocker right now?",
          "Can you find a safe way to move forward and finish this?",
          "Are you getting stuck on something trivial, procedural, reversible, or already authorized?",
          "Inspect the task, approved plan, current result, evidence, scope, authority, previous attempts, and viable alternatives.",
          "Distinguish a true external blocker from ordinary rollout work, local implementation work, a design adjustment, a missing verification step, or a reversible operational task.",
          "A local test failure, stale package, packaging or artifact mismatch, rollback preparation, or deployment procedure is not by itself outside authority.",
          "If a safe deployment and rollback path is already authorized, a supported cutover is work to do, not a blocker.",
          "Confirm blocked only when the issue blocks progress now, is outside authority, and has no safe practical path forward.",
          "Return continue with the next practical action when work can proceed. Keep text concise, with at most five alternatives and five evidence items.",
          `Task: ${request.task}`,
          `Approved plan: ${JSON.stringify(currentPlan(context))}`,
          `Current result and claimed blocker: ${JSON.stringify(latestBlockerClaim(context))}`,
          `Authorized scope: ${request.scope ?? request.repository ?? "the current repository and task"}`,
          `Constraints and authority: ${JSON.stringify(request.constraints ?? [])}`,
          `Merge authorized: ${request.merge === true}`,
          `Previous blocker challenges: ${JSON.stringify(blockerChallenges(context))}`,
          `Recent workflow attempts: ${JSON.stringify(recentWorkflowAttempts(context))}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "continue" | "blocked", "blockingNow": true | false, "outsideAuthority": true | false, "canProceed": true | false, "reason": "concise reason", "nextAction": "practical action or empty when blocked", "alternativesChecked": ["checked alternative"], "evidence": ["concrete evidence"] }`,
      validate: parseBlockerChallenge,
    }),
    planVerification: agent({
      timeoutMs: 15 * 60_000,
      statusDetail: "planning independent verification commands",
      prompt: () =>
        [
          "Select the required local verification commands for the implementation.",
          "Return one command per independent repository working directory.",
          "Use exact executables and argument arrays without shell wrappers, environment overrides, stdin, Git or GitHub mutations, package publication, deployment, merge, or release commands.",
          "Use absolute repository paths, explicit timeouts no longer than 2700000ms, and maxOutputChars no larger than 1000000.",
          "List checks that cannot run locally under untested.",
        ].join("\n"),
      expectedOutput: `{ "commands": [{ "id": "stable-id", "command": "npm", "args": ["run", "check"], "cwd": "/absolute/repository", "timeoutMs": 2700000, "maxOutputChars": 1000000 }], "untested": ["remaining check"] }`,
      validate: parseVerificationForContext,
    }),
    runVerification: action({
      timeoutMs: (context) => {
        const plan = latestOutput<VerificationCommandPlan>(context, ["planVerification"]);
        return commandBatchTimeoutMs(plan.commands, concurrency(context).verification);
      },
      statusDetail: "running independent verification commands",
      run: async (context) => {
        const plan = latestOutput<VerificationCommandPlan>(context, ["planVerification"]);
        return await runAutoimplementBatch(
          context,
          "verification",
          plan.commands,
          concurrency(context).verification,
        );
      },
    }),
    verify: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "assessing verification",
      prompt: (context) =>
        [
          "Assess the completed local verification commands.",
          "Set passed true only when every required command succeeded without truncated output.",
          "Report exact command outcomes, failures, and checks that still need remote verification.",
          `Command plan: ${JSON.stringify(latestOutput(context, ["planVerification"]))}`,
          `Command results: ${JSON.stringify(latestOutput(context, ["runVerification"]))}`,
        ].join("\n"),
      expectedOutput: `{ "passed": true | false, "commands": [{ "command": "exact command", "outcome": "result" }], "failures": ["failure"], "untested": ["remaining check"] }`,
      validate: (value) => requireRecord(value, "verification result"),
    }),
    classifyVerification: agent({
      statusDetail: "classifying verification",
      prompt: ({ outputs }) =>
        [
          "Classify the verification result.",
          "Choose publish when required local checks passed.",
          "Choose redesign for evidence that invalidates the plan.",
          "Choose fix for a local implementation or test issue.",
          "Choose blocked only when the work cannot continue in scope.",
          `Verification: ${JSON.stringify(outputs.verify)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "publish" | "redesign" | "fix" | "blocked", "summary": "reason", "evidence": "evidence" }`,
      validate: (value) =>
        parseRoute(
          value,
          ["publish", "redesign", "fix", "blocked"] as const,
          "verification assessment",
        ),
    }),
    fix: agent({
      timeoutMs: 45 * 60_000,
      statusDetail: "fixing",
      prompt: (context) =>
        [
          "Fix the current implementation issue without expanding the approved design.",
          `Issue: ${JSON.stringify(latestIssue(context))}`,
          `Current plan: ${JSON.stringify(currentPlan(context))}`,
          "Stop after the fix so verification can run again.",
        ].join("\n"),
      expectedOutput: `{ "fixed": "what changed", "files": ["changed file"] }`,
      validate: (value) => requireRecord(value, "fix result"),
    }),
    publish: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "committing and pushing",
      prompt: ({ input }) => {
        const request = input as AutoimplementInput;
        return [
          "Commit and push the verified implementation before review.",
          "Use the existing implementation-plan PR when one exists. Otherwise open a PR and use the pr-description skill for its body.",
          "Inspect the complete public diff before every push or PR mutation.",
          "Report every repository that received a pushed pull request with its absolute repository path, branch, base branch, pushed head revision, and PR URL.",
          "Include dependencyFingerprint only when a declared dependency result is relevant to review reuse.",
          `Requested base branch: ${request.baseBranch ?? "discover each repository default branch"}.`,
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "repositories": [{ "repository": "/absolute/repository", "branch": "branch", "baseBranch": "base", "headRevision": "revision", "pr": "URL", "pushed": true, "dependencyFingerprint": "optional digest" }] }`,
      validate: parsePublishedRepositories,
    }),
    selectReviewCommands: compute({
      run: selectReviewCommands,
    }),
    runReview: action({
      statusDetail: "running pi-reviewer commands",
      timeoutMs: (context) => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        return commandBatchTimeoutMs(selected.commands, concurrency(context).reviewer);
      },
      run: async (context): Promise<BatchExecution> => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const batch = await runAutoimplementBatch(
          context,
          "review",
          selected.commands,
          concurrency(context).reviewer,
        );
        return { route: reviewBatchNeedsRepair(batch) ? "repair" : "assess", batch };
      },
    }),
    repairReviewCommand: agent({
      statusDetail: "repairing reviewer prerequisites",
      prompt: (context) =>
        [
          "One or more pi-reviewer commands failed, timed out, or returned truncated output.",
          "Diagnose and fix only local reviewer prerequisites or configuration that are in scope.",
          "Do not change the deterministic executable, base branch, or repository command shape, and do not substitute another reviewer.",
          "Choose retry only when the same commands can now produce complete reviews. Choose blocked when pi-reviewer or required configuration remains unavailable.",
          `Failed batch: ${JSON.stringify(context.outputs.runReview)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "retry" | "blocked", "reason": "diagnosis and action" }`,
      validate: (value) =>
        parseRoute(value, ["retry", "blocked"] as const, "reviewer command repair"),
    }),
    assessReview: agent({
      statusDetail: "assessing reviewer findings",
      prompt: (context) => {
        const selected = latestOutput<ReviewCommandSelection>(context, ["selectReviewCommands"]);
        const execution = latestOutput<BatchExecution>(context, ["runReview"]);
        return [
          "Assess each completed pi-reviewer result separately.",
          "Return one repository entry for every selected command, using the exact repository id.",
          "Set invocationSucceeded false when a complete valid review was not produced.",
          "Record every finding under P0, P1, P2, or lower and mark it as design or implementation.",
          "Do not promote P2 findings to P1 merely to force another review round.",
          `Selected repositories: ${JSON.stringify(selected.repositories)}`,
          `Reviewer results: ${JSON.stringify(execution.batch)}`,
        ].join("\n");
      },
      expectedOutput: `{ "repositories": [{ "id": "repository-id", "invocationSucceeded": true | false, "p0": [{ "kind": "design" | "implementation", "summary": "finding" }], "p1": [], "p2": [], "lower": [], "reason": "assessment" }], "reason": "batch assessment" }`,
      validate: parseReviewAssessment,
    }),
    triageReview: compute({
      run: ({ outputs }) => {
        const review = outputs.assessReview as ReviewAssessment;
        const critical = [...review.p0, ...review.p1];
        return {
          route: critical.some((finding) => finding.kind === "design") ? "redesign" : "fix",
          summary: `${critical.length} P0/P1 finding(s) require changes`,
          evidence: critical,
        };
      },
    }),
    addressP2: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "addressing P2 findings",
      prompt: ({ outputs }) =>
        [
          "Address valid P2 findings from the last review when the improvement is proportionate and in scope.",
          "Do not rerun pi-reviewer solely because P2 work changes files. Verification will run once, then the workflow continues.",
          `Review: ${JSON.stringify(outputs.assessReview)}`,
        ].join("\n"),
      expectedOutput: `{ "addressed": ["P2 change"], "skipped": [{ "finding": "finding", "reason": "why" }] }`,
      validate: (value) => requireRecord(value, "P2 result"),
    }),
    verifyP2: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "verifying P2 changes",
      prompt: () =>
        [
          "Run focused verification for the P2 changes and push the verified result.",
          "Do not run pi-reviewer again because the previous round had no P0 or P1 findings.",
          "Re-observe every published PR after the push and return its current repository, branch, base branch, head revision, PR URL, pushed status, and unchanged dependency fingerprint.",
          "Report exact commands and outcomes.",
        ].join("\n"),
      expectedOutput: `{ "passed": true | false, "commands": [{ "command": "command", "outcome": "result" }], "pushed": true, "repositories": [{ "repository": "/absolute/repository", "branch": "branch", "baseBranch": "base", "headRevision": "current pushed revision", "pr": "URL", "pushed": true, "dependencyFingerprint": "optional fingerprint" }] }`,
      validate: parseP2Verification,
    }),
    inspectComments: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "checking PR comments",
      prompt: (context) =>
        [
          "Inspect current inline review comments and PR issue comments for every published pull request.",
          "Handle pull requests one at a time. Reply to and resolve every comment. Ignore stale or irrelevant comments only after explaining why.",
          "Choose redesign for a valid design issue, fix for a local code issue, ci when no actionable comment remains on any PR, or blocked for an external blocker.",
          `Published repositories: ${JSON.stringify(currentPublishedRepositories(context))}`,
        ].join("\n"),
      expectedOutput: `{ "route": "redesign" | "fix" | "ci" | "blocked", "summary": "comment status", "evidence": ["comment or response"] }`,
      validate: (value) =>
        parseRoute(value, ["redesign", "fix", "ci", "blocked"] as const, "PR comment assessment"),
    }),
    inspectCi: agent({
      timeoutMs: 10 * 60_000,
      statusDetail: "checking CI",
      prompt: (context) =>
        [
          "Inspect every published pull request once without waiting for completion.",
          "Return one target per repository and current PR head.",
          "Choose green, failed, pending, or unavailable for each target.",
          "When pending, provide an exact supported gh pr checks --watch or gh run watch command with the repository id, absolute repository cwd, timeoutMs at most 300000, and maxOutputChars at most 1000000.",
          "Separate failures caused by this change from unrelated failures. Do not invent an ETA.",
          `Published repositories: ${JSON.stringify(currentPublishedRepositories(context))}`,
        ].join("\n"),
      expectedOutput: `{ "targets": [{ "repository": "/absolute/repository", "headRevision": "revision", "pr": "URL", "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "relatedFailures": ["failure"], "unrelatedFailures": ["failure"], "trackingCommand": { "id": "repository-id", "command": "gh", "args": ["pr", "checks", "--watch"], "cwd": "/absolute/repository", "timeoutMs": 300000, "maxOutputChars": 1000000 } }] }`,
      validate: parseCiInspectionForPublished,
    }),
    trackCi: action({
      statusDetail: "tracking pending CI commands",
      timeoutMs: (context) => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const commands = inspected.targets.flatMap((target) =>
          target.trackingCommand === undefined ? [] : [target.trackingCommand],
        );
        return commandBatchTimeoutMs(commands, concurrency(context).ciWatch);
      },
      run: async (context): Promise<BatchExecution> => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const commands = inspected.targets.flatMap((target) =>
          target.trackingCommand === undefined ? [] : [target.trackingCommand],
        );
        const batch = await runAutoimplementBatch(
          context,
          "ciWatch",
          commands,
          concurrency(context).ciWatch,
        );
        const needsRepair = batch.items.some(
          (item) =>
            (item.outcome === "failed" && item.exitCode === null) ||
            item.stdoutTruncated ||
            item.stderrTruncated,
        );
        return { route: needsRepair ? "repair" : "assess", batch };
      },
    }),
    repairCiCommand: agent({
      statusDetail: "repairing CI watch prerequisites",
      prompt: (context) =>
        [
          "One or more supported CI watch commands failed or returned truncated output.",
          "Diagnose and fix only local gh prerequisites or authentication that are already authorized.",
          "Do not change the PR identity or substitute another command form.",
          "Choose retry only when the same validated commands can now provide useful status. Choose blocked otherwise.",
          `Failure: ${JSON.stringify(context.outputs.trackCi)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "retry" | "blocked", "reason": "diagnosis" }`,
      validate: (value) => parseRoute(value, ["retry", "blocked"] as const, "CI command repair"),
    }),
    assessTrackedCi: agent({
      statusDetail: "assessing tracked CI",
      prompt: (context) => {
        const inspected = latestOutput<CiInspectionBatch>(context, ["inspectCi"]);
        const execution = latestOutput<BatchExecution>(context, ["trackCi"]);
        return [
          "Assess every CI watch result without starting another wait.",
          "Return one target result for every watched PR and an aggregate route of green, failed, pending, or unavailable.",
          "A timed-out watch normally remains pending. Separate related from unrelated failures. Do not invent an ETA.",
          `Initial inspection: ${JSON.stringify(inspected)}`,
          `Tracking results: ${JSON.stringify(execution.batch)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "targets": [{ "id": "repository-id", "route": "green" | "failed" | "pending" | "unavailable", "reason": "status" }], "relatedFailures": ["failure"], "unrelatedFailures": ["failure"] }`,
      validate: parseTrackedCiAssessment,
    }),
    opportunisticTest: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "using CI wait for more testing",
      prompt: () =>
        [
          "CI has remained pending for about five minutes.",
          "Do not spend this model turn waiting for CI.",
          "Run additional useful local tests, smoke tests, or targeted checks that were not covered earlier.",
          "If no further useful test exists, say so plainly. Then stop so the workflow can inspect CI again.",
        ].join("\n"),
      expectedOutput: `{ "performed": [{ "command": "exact command", "outcome": "result" }], "furtherUsefulTests": true | false, "summary": "what was learned" }`,
      validate: (value) => requireRecord(value, "opportunistic test result"),
    }),
    classifyCi: agent({
      statusDetail: "classifying CI failures",
      prompt: (context) =>
        [
          "Classify the current CI failure.",
          "Choose redesign when it invalidates the plan, fix for a related local issue, unrelated when the failures are demonstrably outside this change, or blocked when required CI cannot be verified.",
          `CI: ${JSON.stringify(latestOutput(context, ["inspectCi", "assessTrackedCi"]))}`,
        ].join("\n"),
      expectedOutput: `{ "route": "redesign" | "fix" | "unrelated" | "blocked", "reason": "classification", "evidence": ["failure"] }`,
      validate: (value) =>
        parseRoute(
          value,
          ["redesign", "fix", "unrelated", "blocked"] as const,
          "CI classification",
        ),
    }),
    finalizeDelivery: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "finalizing PRs",
      prompt: (context) => {
        const request = context.input as AutoimplementInput;
        return [
          request.merge === false
            ? "Leave every verified PR ready without merging because input disabled merge."
            : "Handle verified PRs one at a time and merge each unless repository policy or explicit user instructions prohibit it.",
          "Use each repository's required merge method.",
          "Post a final report with the implementation summary and exact validation commands on every PR.",
          "Keep the existing top-level merged, pr, reportComment, and reason fields. For several PRs, use the first PR for the top-level compatibility fields and include every result under repositories.",
          "Return blocked instead of claiming completion when a required merge or report action fails.",
          `Published repositories: ${JSON.stringify(currentPublishedRepositories(context))}`,
        ].join("\n");
      },
      expectedOutput: `{ "status": "completed" | "blocked", "merged": true | false, "pr": "first PR URL", "reportComment": "first report URL or summary", "reason": "aggregate result", "repositories": [{ "repository": "/absolute/repository", "pr": "URL", "merged": true | false, "reportComment": "URL or summary", "reason": "result" }] }`,
      validate: parseDeliveryResult,
    }),
    blocked: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        const blocked = latestBlockedReason(context);
        return {
          status: "blocked",
          task: request.task,
          reason: blocked.reason,
          evidence: blocked.evidence,
        } satisfies AutoimplementBlocked;
      },
    }),
    finalize: compute({
      run: (context) => {
        const request = context.input as AutoimplementInput;
        return {
          status: "completed",
          task: request.task,
          plan: currentPlan(context),
          implementation: latestOutput(context, ["implement"]),
          verification: latestOutput(context, ["verifyP2", "verify"]),
          reviewRounds: reviewRoundsForOutput(context),
          ci: ciForOutput(context),
          delivery: latestOutput(context, ["finalizeDelivery"]),
        } satisfies AutoimplementCompleted;
      },
    }),
  },
  edges: [
    {
      from: "prepare",
      switch: {
        on: "$.route",
        cases: { find: "findPlan", document: "documentation", ready: "maybeApproval" },
      },
    },
    {
      from: "findPlan",
      switch: { on: "$.route", cases: { found: "routeFoundPlan", blocked: "blocked" } },
    },
    {
      from: "routeFoundPlan",
      switch: {
        on: "$.route",
        cases: { ready: "maybeApproval", document: "documentation", blocked: "blocked" },
      },
    },
    { from: "redesign.ready", to: "adoptPlan" },
    { from: "redesign.blocked", to: "blocked" },
    {
      from: "adoptPlan",
      switch: { on: "$.route", cases: { document: "documentation", blocked: "blocked" } },
    },
    { from: "documentation.ready", to: "maybeApproval" },
    { from: "documentation.blocked", to: "blocked" },
    {
      from: "maybeApproval",
      switch: { on: "$.route", cases: { approve: "approval", implement: "implement" } },
    },
    { from: "approval.continue", to: "implement" },
    { from: "approval.stop", to: "blocked" },
    { from: "approval.replan", to: "replanGuard" },
    {
      from: "replanGuard",
      switch: { on: "$.route", cases: { redesign: "redesign", blocked: "blocked" } },
    },
    { from: "implement", to: "classifyImplementation" },
    {
      from: "classifyImplementation",
      switch: {
        on: "$.route",
        cases: {
          verify: "planVerification",
          redesign: "redesign",
          fix: "fix",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "challengeBlockerGuard",
      switch: { on: "$.route", cases: { challenge: "challengeBlocker", blocked: "blocked" } },
    },
    {
      from: "challengeBlocker",
      switch: { on: "$.route", cases: { continue: "redesign", blocked: "blocked" } },
    },
    { from: "planVerification", to: "runVerification" },
    { from: "runVerification", to: "verify" },
    { from: "verify", to: "classifyVerification" },
    {
      from: "classifyVerification",
      switch: {
        on: "$.route",
        cases: {
          publish: "publish",
          redesign: "redesign",
          fix: "fix",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    { from: "fix", to: "planVerification" },
    { from: "publish", to: "selectReviewCommands" },
    {
      from: "selectReviewCommands",
      switch: { on: "$.route", cases: { run: "runReview", reuse: "inspectComments" } },
    },
    {
      from: "runReview",
      switch: { on: "$.route", cases: { assess: "assessReview", repair: "repairReviewCommand" } },
    },
    {
      from: "repairReviewCommand",
      switch: {
        on: "$.route",
        cases: { retry: "runReview", blocked: "challengeBlockerGuard" },
      },
    },
    {
      from: "assessReview",
      switch: {
        on: "$.route",
        cases: {
          command_error: "repairReviewCommand",
          critical: "triageReview",
          p2: "addressP2",
          clean: "inspectComments",
        },
      },
    },
    {
      from: "triageReview",
      switch: { on: "$.route", cases: { redesign: "redesign", fix: "fix" } },
    },
    { from: "addressP2", to: "verifyP2" },
    {
      from: "verifyP2",
      switch: { on: "$.passed", cases: { true: "inspectComments", false: "fix" } },
    },
    {
      from: "inspectComments",
      switch: {
        on: "$.route",
        cases: {
          redesign: "redesign",
          fix: "fix",
          ci: "inspectCi",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "inspectCi",
      switch: {
        on: "$.route",
        cases: {
          green: "finalizeDelivery",
          failed: "classifyCi",
          pending: "trackCi",
          unavailable: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "trackCi",
      switch: { on: "$.route", cases: { assess: "assessTrackedCi", repair: "repairCiCommand" } },
    },
    {
      from: "repairCiCommand",
      switch: {
        on: "$.route",
        cases: { retry: "trackCi", blocked: "challengeBlockerGuard" },
      },
    },
    {
      from: "assessTrackedCi",
      switch: {
        on: "$.route",
        cases: {
          green: "finalizeDelivery",
          failed: "classifyCi",
          pending: "opportunisticTest",
          unavailable: "challengeBlockerGuard",
        },
      },
    },
    { from: "opportunisticTest", to: "inspectCi" },
    {
      from: "classifyCi",
      switch: {
        on: "$.route",
        cases: {
          redesign: "redesign",
          fix: "fix",
          unrelated: "finalizeDelivery",
          blocked: "challengeBlockerGuard",
        },
      },
    },
    {
      from: "finalizeDelivery",
      switch: {
        on: "$.status",
        cases: { completed: "finalize", blocked: "challengeBlockerGuard" },
      },
    },
  ],
});

export default autoimplementWorkflow;
