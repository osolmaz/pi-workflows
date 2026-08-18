import path from "node:path";
import {
  agent,
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
  shell,
} from "../workflows/definition.js";
import type {
  ShellActionExecution,
  ShellActionResult,
  WorkflowNodeContext,
} from "../workflows/types.js";
import autodeviseWorkflow, { type AutodeviseInput } from "./autodevise.workflow.js";

export type AutoimplementInput = {
  task: string;
  plan?: unknown;
  scope?: string;
  constraints?: string[];
  repository?: string;
  baseBranch?: string;
  merge?: boolean;
};

type StructuredCommand = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

type ReviewFinding = {
  severity: "P0" | "P1" | "P2" | "lower";
  kind: "design" | "implementation";
  summary: string;
};

type ReviewAssessment = {
  route: "critical" | "p2" | "clean" | "command_error";
  invocationSucceeded: boolean;
  p0: ReviewFinding[];
  p1: ReviewFinding[];
  p2: ReviewFinding[];
  lower: ReviewFinding[];
  reason: string;
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

const FIVE_MINUTES_MS = 5 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;

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
    merge: input.merge !== false,
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

function parseCommand(
  value: unknown,
  options: {
    command: string;
    maxTimeoutMs: number;
    validateArgs: (args: string[]) => boolean;
    label: string;
  },
): StructuredCommand {
  const command = requireRecord(value, options.label);
  if (command.command !== options.command) {
    throw new Error(`${options.label} command must be ${options.command}`);
  }
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${options.label} args must be an array of strings`);
  }
  const args = [...command.args] as string[];
  if (!options.validateArgs(args)) throw new Error(`${options.label} args are not allowed`);
  const cwd = requireString(command.cwd, `${options.label} cwd`);
  if (!path.isAbsolute(cwd)) throw new Error(`${options.label} cwd must be absolute`);
  const timeoutMs = command.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > options.maxTimeoutMs
  ) {
    throw new Error(`${options.label} timeoutMs must be at most ${options.maxTimeoutMs}`);
  }
  return { command: options.command, args, cwd, timeoutMs };
}

function parseReviewerCommand(value: unknown): StructuredCommand {
  return parseCommand(value, {
    command: "pi-reviewer",
    maxTimeoutMs: TEN_MINUTES_MS,
    label: "reviewer command",
    validateArgs: (args) => {
      const base = args.indexOf("--base");
      return base >= 0 && typeof args[base + 1] === "string" && args[base + 1]!.length > 0;
    },
  });
}

function parseCiCommand(value: unknown): StructuredCommand {
  return parseCommand(value, {
    command: "gh",
    maxTimeoutMs: FIVE_MINUTES_MS,
    label: "CI tracking command",
    validateArgs: (args) =>
      (args[0] === "pr" && args[1] === "checks" && args.includes("--watch")) ||
      (args[0] === "run" && args[1] === "watch"),
  });
}

function commandExecution(command: StructuredCommand): ShellActionExecution {
  return {
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    allowNonZeroExit: true,
    maxOutputChars: 1_000_000,
  };
}

function latestOutput<T>(context: WorkflowNodeContext, nodeIds: string[]): T {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step && nodeIds.includes(step.nodeId)) return step.output as T;
  }
  throw new Error(`No output found for ${nodeIds.join(" or ")}`);
}

function latestCiCommand(context: WorkflowNodeContext): StructuredCommand {
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (!step) continue;
    if (step.nodeId === "repairCiCommand") return step.output as StructuredCommand;
    if (step.nodeId === "inspectCi") {
      const output = step.output as { trackingCommand?: StructuredCommand };
      if (output.trackingCommand !== undefined) return output.trackingCommand;
    }
  }
  throw new Error("No CI tracking command is available");
}

function currentPlan(context: WorkflowNodeContext): unknown {
  const adopted = context.outputs.adoptPlan as { plan?: unknown } | undefined;
  return adopted?.plan ?? (context.input as AutoimplementInput).plan;
}

function latestIssue(context: WorkflowNodeContext): unknown {
  const ids = [
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

function parseReviewAssessment(value: unknown): ReviewAssessment {
  const review = requireRecord(value, "review assessment");
  const parseList = (key: "p0" | "p1" | "p2" | "lower", severity: ReviewFinding["severity"]) => {
    const raw = review[key];
    if (!Array.isArray(raw)) throw new Error(`review ${key} must be an array`);
    return raw.map((item) => parseFinding(item, severity));
  };
  const p0 = parseList("p0", "P0");
  const p1 = parseList("p1", "P1");
  const p2 = parseList("p2", "P2");
  const lower = parseList("lower", "lower");
  const invocationSucceeded = review.invocationSucceeded === true;
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
  };
}

function reviewRounds(context: WorkflowNodeContext): ReviewAssessment[] {
  return context.state.steps
    .filter((step) => step.nodeId === "assessReview" && step.outcome === "ok")
    .map((step) => step.output as ReviewAssessment);
}

function latestBlockedReason(context: WorkflowNodeContext): { reason: string; evidence: unknown } {
  const candidates = [
    "finalizeDelivery",
    "inspectCi",
    "assessTrackedCi",
    "classifyCi",
    "inspectComments",
    "classifyImplementation",
    "classifyVerification",
    "triageReview",
    "adoptPlan",
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
  maxSteps: 160,
  includes: {
    redesign: includeWorkflow({
      workflow: "autodevise",
      contract: autodeviseWorkflow,
      input: (context): AutodeviseInput => {
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
      run: ({ input }) => ({
        route: (input as AutoimplementInput).plan === undefined ? "redesign" : "implement",
      }),
    }),
    adoptPlan: compute({
      run: ({ outputs }) => {
        const result = includedResult(autodeviseWorkflow, outputs.redesign);
        if (result.exit !== "ready") throw new Error("redesign did not return a ready plan");
        return {
          route: result.output.changed ? "implement" : "blocked",
          plan: result.output.plan,
          planDigest: result.output.planDigest,
          changed: result.output.changed,
          reason: result.output.changed
            ? "The plan changed in response to new evidence."
            : "Redesign returned the same plan for the same unresolved evidence.",
        };
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
          "Follow repository instructions and use the most elegant long-term production-ready implementation without unnecessary work.",
          "If implementation exposes a new design or scope problem, report it precisely instead of forcing the old plan.",
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "status": "implemented" | "issue" | "blocked", "summary": "work completed or issue", "files": ["changed file"], "issueKind": "design" | "implementation" | null, "evidence": "new evidence" }`,
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
    verify: agent({
      timeoutMs: 45 * 60_000,
      statusDetail: "verifying",
      prompt: () =>
        [
          "Verify the implementation thoroughly.",
          "Run required tests, formatting, lint, type checks, builds, and useful local smoke tests.",
          "Do not put optional mutation testing on the critical path.",
          "State exactly what ran, what passed, what failed, and what still needs remote verification.",
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
          `Requested base branch: ${request.baseBranch ?? "discover the repository default branch"}.`,
          "Do not merge yet.",
        ].join("\n");
      },
      expectedOutput: `{ "branch": "branch", "baseBranch": "base", "headRevision": "revision", "pr": "URL", "pushed": true }`,
      validate: (value) => requireRecord(value, "publication result"),
    }),
    authorReviewCommand: agent({
      statusDetail: "writing reviewer command",
      prompt: ({ outputs, input }) => {
        const published = outputs.publish as Record<string, unknown>;
        const request = input as AutoimplementInput;
        return [
          "Write the exact Pi Reviewer command for the pushed branch.",
          "The executable must be pi-reviewer. Use its configured model and thinking settings.",
          "Use the repository base branch and an absolute repository working directory.",
          "Set timeoutMs to at most 600000.",
          `Published branch: ${JSON.stringify(published)}`,
          `Repository hint: ${request.repository ?? "current repository"}`,
        ].join("\n");
      },
      expectedOutput: `{ "command": "pi-reviewer", "args": ["--base", "main"], "cwd": "/absolute/repository", "timeoutMs": 600000 }`,
      validate: parseReviewerCommand,
    }),
    runReview: shell({
      statusDetail: "running Pi Reviewer",
      timeoutMs: TEN_MINUTES_MS + 10_000,
      exec: (context) =>
        commandExecution(
          latestOutput<StructuredCommand>(context, ["authorReviewCommand", "repairReviewCommand"]),
        ),
    }),
    repairReviewCommand: agent({
      statusDetail: "correcting reviewer command",
      prompt: (context) => {
        const failed = context.results.runReview;
        return [
          "The Pi Reviewer invocation failed. Diagnose the exact command, arguments, base branch, working directory, and error.",
          "Write a corrected pi-reviewer command. Do not substitute codex review or another reviewer.",
          "If Pi Reviewer or its configuration is missing, report that through the same command shape only when another valid invocation exists; otherwise the next assessment must block.",
          `Failed result: ${JSON.stringify(failed)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "retry" | "blocked", "command": "pi-reviewer", "args": ["--base", "main"], "cwd": "/absolute/repository", "timeoutMs": 600000, "reason": "diagnosis" }`,
      validate: (value) => {
        const result = requireRecord(value, "reviewer command repair");
        if (result.route === "blocked") {
          return {
            route: "blocked",
            reason: requireString(result.reason, "reviewer command blocker"),
          };
        }
        if (result.route !== "retry")
          throw new Error("reviewer command repair route must be retry or blocked");
        return {
          route: "retry",
          ...parseReviewerCommand(result),
          reason: requireString(result.reason, "reviewer command repair reason"),
        };
      },
    }),
    assessReview: agent({
      statusDetail: "assessing reviewer findings",
      prompt: (context) => {
        const result = latestOutput<ShellActionResult>(context, ["runReview"]);
        return [
          "Assess the completed Pi Reviewer invocation.",
          "Set invocationSucceeded false only when the reviewer did not produce a valid review.",
          "Record each finding under P0, P1, P2, or lower. Mark each finding as design or implementation.",
          "Do not promote P2 findings to P1 merely to force another review round.",
          `Reviewer result: ${JSON.stringify(result)}`,
        ].join("\n");
      },
      expectedOutput: `{ "invocationSucceeded": true | false, "p0": [{ "kind": "design" | "implementation", "summary": "finding" }], "p1": [], "p2": [], "lower": [], "reason": "assessment" }`,
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
          "Do not rerun Pi Reviewer solely because P2 work changes files. Verification will run once, then the workflow continues.",
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
          "Do not run Pi Reviewer again because the previous round had no P0 or P1 findings.",
          "Report exact commands and outcomes.",
        ].join("\n"),
      expectedOutput: `{ "passed": true | false, "commands": [{ "command": "command", "outcome": "result" }], "pushed": true }`,
      validate: (value) => requireRecord(value, "P2 verification"),
    }),
    inspectComments: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "checking PR comments",
      prompt: () =>
        [
          "Inspect current inline review comments and PR issue comments.",
          "Reply to and resolve every comment. Ignore stale or irrelevant comments only after explaining why.",
          "Choose redesign for a valid design issue, fix for a local code issue, ci when no actionable comment remains, or blocked for an external blocker.",
        ].join("\n"),
      expectedOutput: `{ "route": "redesign" | "fix" | "ci" | "blocked", "summary": "comment status", "evidence": ["comment or response"] }`,
      validate: (value) =>
        parseRoute(value, ["redesign", "fix", "ci", "blocked"] as const, "PR comment assessment"),
    }),
    inspectCi: agent({
      timeoutMs: 10 * 60_000,
      statusDetail: "checking CI",
      prompt: () =>
        [
          "Inspect CI once without waiting for completion.",
          "Choose green, failed, pending, or unavailable.",
          "When pending, provide an exact gh command that tracks this PR or run and set timeoutMs to at most 300000.",
          "Separate failures caused by this change from unrelated failures.",
        ].join("\n"),
      expectedOutput: `{ "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "relatedFailures": ["failure"], "unrelatedFailures": ["failure"], "trackingCommand": { "command": "gh", "args": ["pr", "checks", "--watch"], "cwd": "/absolute/repository", "timeoutMs": 300000 } (required when pending) }`,
      validate: (value) => {
        const result = parseRoute(
          value,
          ["green", "failed", "pending", "unavailable"] as const,
          "CI inspection",
        );
        if (result.route === "pending")
          result.trackingCommand = parseCiCommand(result.trackingCommand);
        return result;
      },
    }),
    trackCi: shell({
      statusDetail: "tracking CI for at most five minutes",
      timeoutMs: FIVE_MINUTES_MS + 10_000,
      exec: (context) => commandExecution(latestCiCommand(context)),
    }),
    repairCiCommand: agent({
      statusDetail: "correcting CI tracking command",
      prompt: (context) =>
        [
          "The CI tracking command failed before it could provide a useful status.",
          "Write a corrected gh pr checks --watch or gh run watch command for the same PR or run.",
          "Use an absolute repository path and a timeout no longer than five minutes.",
          `Failure: ${JSON.stringify(context.results.trackCi)}`,
        ].join("\n"),
      expectedOutput: `{ "route": "retry" | "blocked", "command": "gh", "args": ["pr", "checks", "--watch"], "cwd": "/absolute/repository", "timeoutMs": 300000, "reason": "diagnosis" }`,
      validate: (value) => {
        const result = requireRecord(value, "CI command repair");
        if (result.route === "blocked") {
          return { route: "blocked", reason: requireString(result.reason, "CI command blocker") };
        }
        if (result.route !== "retry")
          throw new Error("CI command repair route must be retry or blocked");
        return {
          route: "retry",
          ...parseCiCommand(result),
          reason: requireString(result.reason, "CI command repair reason"),
        };
      },
    }),
    assessTrackedCi: agent({
      statusDetail: "assessing tracked CI",
      prompt: (context) => {
        const result = latestOutput<ShellActionResult>(context, ["trackCi"]);
        return [
          "Assess the CI tracking result without starting another wait.",
          "Choose green, failed, pending, or unavailable and separate related from unrelated failures.",
          `Tracking result: ${JSON.stringify(result)}`,
        ].join("\n");
      },
      expectedOutput: `{ "route": "green" | "failed" | "pending" | "unavailable", "reason": "status", "relatedFailures": ["failure"], "unrelatedFailures": ["failure"] }`,
      validate: (value) =>
        parseRoute(
          value,
          ["green", "failed", "pending", "unavailable"] as const,
          "tracked CI assessment",
        ),
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
      statusDetail: "finalizing PR",
      prompt: ({ input }) => {
        const request = input as AutoimplementInput;
        return [
          request.merge === false
            ? "Leave the verified PR ready without merging because input disabled merge."
            : "Merge the verified PR unless repository policy or explicit user instructions prohibit it.",
          "Use the repository's required merge method.",
          "Post a final PR report with the implementation summary and exact validation commands.",
          "Return blocked instead of claiming completion when a required merge or report action fails.",
        ].join("\n");
      },
      expectedOutput: `{ "status": "completed" | "blocked", "merged": true | false, "pr": "URL", "reportComment": "URL or summary", "reason": "result" }`,
      validate: (value) => {
        const result = requireRecord(value, "delivery result");
        if (result.status !== "completed" && result.status !== "blocked") {
          throw new Error("delivery status must be completed or blocked");
        }
        return result;
      },
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
          implementation: context.outputs.implement,
          verification: context.outputs.verifyP2 ?? context.outputs.verify,
          reviewRounds: reviewRounds(context),
          ci: context.outputs.assessTrackedCi ?? context.outputs.inspectCi,
          delivery: context.outputs.finalizeDelivery,
        } satisfies AutoimplementCompleted;
      },
    }),
  },
  edges: [
    {
      from: "prepare",
      switch: { on: "$.route", cases: { redesign: "redesign", implement: "implement" } },
    },
    { from: "redesign.ready", to: "adoptPlan" },
    { from: "redesign.blocked", to: "blocked" },
    {
      from: "adoptPlan",
      switch: { on: "$.route", cases: { implement: "implement", blocked: "blocked" } },
    },
    { from: "implement", to: "classifyImplementation" },
    {
      from: "classifyImplementation",
      switch: {
        on: "$.route",
        cases: { verify: "verify", redesign: "redesign", fix: "fix", blocked: "blocked" },
      },
    },
    { from: "verify", to: "classifyVerification" },
    {
      from: "classifyVerification",
      switch: {
        on: "$.route",
        cases: { publish: "publish", redesign: "redesign", fix: "fix", blocked: "blocked" },
      },
    },
    { from: "fix", to: "verify" },
    { from: "publish", to: "authorReviewCommand" },
    { from: "authorReviewCommand", to: "runReview" },
    {
      from: "runReview",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "assessReview",
          failed: "repairReviewCommand",
          timed_out: "repairReviewCommand",
        },
      },
    },
    {
      from: "repairReviewCommand",
      switch: { on: "$.route", cases: { retry: "runReview", blocked: "blocked" } },
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
        cases: { redesign: "redesign", fix: "fix", ci: "inspectCi", blocked: "blocked" },
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
          unavailable: "blocked",
        },
      },
    },
    {
      from: "trackCi",
      switch: {
        on: "$result.outcome",
        cases: { ok: "assessTrackedCi", failed: "repairCiCommand", timed_out: "opportunisticTest" },
      },
    },
    {
      from: "repairCiCommand",
      switch: { on: "$.route", cases: { retry: "trackCi", blocked: "blocked" } },
    },
    {
      from: "assessTrackedCi",
      switch: {
        on: "$.route",
        cases: {
          green: "finalizeDelivery",
          failed: "classifyCi",
          pending: "opportunisticTest",
          unavailable: "blocked",
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
          blocked: "blocked",
        },
      },
    },
    {
      from: "finalizeDelivery",
      switch: { on: "$.status", cases: { completed: "finalize", blocked: "blocked" } },
    },
  ],
});

export default autoimplementWorkflow;
