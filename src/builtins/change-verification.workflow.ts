import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  runCommandBatch,
  MAX_COMMAND_BATCH_ITEMS,
  validateCommandBatchRequest,
  type CommandBatchItem,
  type CommandBatchItemResult,
  type CommandBatchResult,
} from "../workflows/command-batch.js";
import { action, agent, compute, defineWorkflow, manualEffect } from "../workflows/definition.js";
import type { WorkflowActionContext, WorkflowNodeContext } from "../workflows/types.js";
import { IMPLEMENTATION_TIMEOUT_MS } from "./agent-timeouts.js";
import { validateVerificationCommandSafety } from "./autoimplement-command-batches.js";
import {
  parsePreparedWorkspace,
  type PreparedWorkspace,
} from "./workspace-preparation.workflow.js";

const execFileAsync = promisify(execFile);
export const CHANGE_VERIFICATION_SCHEMA = "pi-workflows.change-verification.v1";
const MAX_REPAIR_ATTEMPTS = 2;

export type FindingFormat = "text" | "json";
export type MechanicalFix = {
  command: string;
  args: string[];
  files: string[];
  timeoutMs: number;
  maxOutputChars: number;
  expectedDiff: string;
};

export type VerificationCheck = CommandBatchItem & {
  readOnly: boolean;
  baseEligible: boolean;
  changedFileScope: boolean;
  findingFormat: FindingFormat;
  mechanicalFix?: MechanicalFix;
};

export type VerificationFinding = {
  checkId: string;
  kind: "related" | "unrelated" | "fixedBaseline" | "unknown" | "untested";
  summary: string;
  fingerprint: string;
  candidateOutputRef?: string;
  baseOutputRef?: string;
};

export type RepairAttempt = {
  attempt: number;
  kind: "mechanical" | "semantic" | "judgment";
  fingerprint: string;
  changedFiles: string[];
  result: string;
};

export type ChangeVerificationResult = {
  schema: typeof CHANGE_VERIFICATION_SCHEMA;
  route: "ready" | "repairable" | "needsJudgment" | "blocked";
  originatingWorkflow: string;
  qualifiedNode: string;
  workspace: PreparedWorkspace;
  changedFiles: string[];
  candidateCommands: CommandBatchResult | null;
  baseCommands: CommandBatchResult | null;
  relatedFailures: VerificationFinding[];
  unrelatedFailures: VerificationFinding[];
  fixedBaselineFailures: VerificationFinding[];
  unknownFailures: VerificationFinding[];
  untestedChecks: VerificationFinding[];
  repairAttempts: RepairAttempt[];
  failureFingerprint: string;
  outputReferences: string[];
  reason: string;
  evidence: string[];
};

export type ChangeVerificationInput = {
  originatingWorkflow: string;
  qualifiedNode: string;
  workspace: PreparedWorkspace;
  checks?: VerificationCheck[];
  changedFiles?: string[];
  untested?: string[];
  plan?: unknown;
  maxConcurrency?: number;
};

type VerificationPlan = { checks: VerificationCheck[]; untested: string[] };
type RepairReconciliation = {
  route: "verify" | "retry" | "blocked";
  commandsSettled: boolean;
  evidence: string[];
  reason: string;
};

type ExecutionState = {
  checks: VerificationCheck[];
  candidate: CommandBatchResult;
  base: CommandBatchResult;
  baseEvidence: string[];
  cleanupEvidence: string[];
  repairAttempts: RepairAttempt[];
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must be an array of strings`);
  return [...value] as string[];
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  return value as number;
}

function validateDirectCommand(command: string, args: string[], label: string): void {
  validateVerificationCommandSafety(command, args, label);
  if (args.some((arg) => arg.includes("\0")))
    throw new Error(`${label} arguments cannot contain NUL`);
}

function parseMechanicalFix(value: unknown, repository: string, label: string): MechanicalFix {
  const record = requireRecord(value, label);
  const command = requireString(record.command, `${label}.command`);
  const args = stringArray(record.args, `${label}.args`);
  validateDirectCommand(command, args, label);
  const files = stringArray(record.files, `${label}.files`).map((file) => {
    if (path.isAbsolute(file) || file.split(path.sep).includes(".."))
      throw new Error(`${label}.files must stay inside ${repository}`);
    return file;
  });
  if (files.length === 0) throw new Error(`${label}.files must not be empty`);
  return {
    command,
    args,
    files,
    timeoutMs: positiveInteger(record.timeoutMs, `${label}.timeoutMs`, 60 * 60_000),
    maxOutputChars: positiveInteger(record.maxOutputChars, `${label}.maxOutputChars`, 1_000_000),
    expectedDiff: requireString(record.expectedDiff, `${label}.expectedDiff`),
  };
}

function parseCheck(
  value: unknown,
  workspace: PreparedWorkspace,
  index: number,
): VerificationCheck {
  const record = requireRecord(value, `verification checks[${index}]`);
  const candidateRoot = workspace.worktreePath ?? workspace.repository;
  const batch = validateCommandBatchRequest({
    items: [
      {
        id: record.id,
        command: record.command,
        args: record.args,
        cwd: record.cwd,
        timeoutMs: record.timeoutMs,
        maxOutputChars: record.maxOutputChars,
      },
    ],
    maxConcurrency: 1,
  }).items[0];
  if (batch === undefined) throw new Error(`verification checks[${index}] is missing`);
  if (path.resolve(batch.cwd) !== path.resolve(candidateRoot))
    throw new Error(`verification checks[${index}].cwd must equal the prepared workspace`);
  validateDirectCommand(batch.command, batch.args, `verification checks[${index}]`);
  if (
    typeof record.readOnly !== "boolean" ||
    typeof record.baseEligible !== "boolean" ||
    typeof record.changedFileScope !== "boolean"
  ) {
    throw new Error(`verification checks[${index}] flags must be booleans`);
  }
  if (record.baseEligible === true && record.readOnly !== true)
    throw new Error(`verification checks[${index}] base comparison requires readOnly=true`);
  if (
    record.baseEligible === true &&
    batch.args.some((arg) => arg.includes(path.resolve(candidateRoot)))
  ) {
    throw new Error(
      `verification checks[${index}] base comparison arguments must not reference the prepared workspace`,
    );
  }
  if (record.findingFormat !== "text" && record.findingFormat !== "json")
    throw new Error(`verification checks[${index}].findingFormat must be text or json`);
  return {
    ...batch,
    readOnly: record.readOnly,
    baseEligible: record.baseEligible,
    changedFileScope: record.changedFileScope,
    findingFormat: record.findingFormat,
    ...(record.mechanicalFix === undefined
      ? {}
      : {
          mechanicalFix: parseMechanicalFix(
            record.mechanicalFix,
            candidateRoot,
            `verification checks[${index}].mechanicalFix`,
          ),
        }),
  };
}

export function parseChangeVerificationInput(value: unknown): ChangeVerificationInput {
  const record = requireRecord(value, "change verification input");
  const workspace = parsePreparedWorkspace(record.workspace);
  if (record.checks !== undefined && !Array.isArray(record.checks))
    throw new Error("change verification checks must be an array");
  const checks = (record.checks as unknown[] | undefined)?.map((check, index) =>
    parseCheck(check, workspace, index),
  );
  if (checks !== undefined && checks.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(`verification checks must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`);
  }
  const ids = new Set<string>();
  for (const check of checks ?? []) {
    if (ids.has(check.id)) throw new Error(`verification check id is duplicated: ${check.id}`);
    ids.add(check.id);
  }
  return {
    originatingWorkflow: requireString(
      record.originatingWorkflow,
      "change verification originatingWorkflow",
    ),
    qualifiedNode: requireString(record.qualifiedNode, "change verification qualifiedNode"),
    workspace,
    ...(checks === undefined ? {} : { checks }),
    changedFiles: stringArray(record.changedFiles, "change verification changedFiles"),
    untested: stringArray(record.untested, "change verification untested"),
    ...(record.plan === undefined ? {} : { plan: record.plan }),
    maxConcurrency:
      record.maxConcurrency === undefined
        ? 2
        : positiveInteger(record.maxConcurrency, "change verification maxConcurrency", 8),
  };
}

function parsePlannedChecks(value: unknown, context: WorkflowNodeContext): VerificationPlan {
  const record = requireRecord(value, "verification command plan");
  if (!Array.isArray(record.checks) || record.checks.length === 0)
    throw new Error("verification command plan checks must be a non-empty array");
  const input = parseChangeVerificationInput({
    ...(context.input as ChangeVerificationInput),
    checks: record.checks,
    untested: record.untested,
  });
  return { checks: input.checks!, untested: input.untested ?? [] };
}

async function runBatch(
  context: WorkflowActionContext,
  checks: VerificationCheck[],
  root?: string,
): Promise<CommandBatchResult> {
  const items = checks.map((check) => ({
    id: check.id,
    command: check.command,
    args: [...check.args],
    cwd: root ?? check.cwd,
    timeoutMs: check.timeoutMs,
    maxOutputChars: check.maxOutputChars,
  }));
  return await runCommandBatch(
    {
      items,
      maxConcurrency: Math.min(
        (context.input as ChangeVerificationInput).maxConcurrency ?? 2,
        Math.max(1, items.length),
      ),
    },
    { signal: context.signal },
  );
}

function emptyBatch(): CommandBatchResult {
  return { schema: "pi-workflows.command-batch-result.v1", items: [], completed: 0, total: 0 };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 5_000_000,
    timeout: 60_000,
  });
  return result.stdout.trim();
}

function candidateRoot(workspace: PreparedWorkspace): string {
  return workspace.worktreePath ?? workspace.repository;
}

const NODE_DEPENDENCY_INPUT_PATHS = [
  ":(glob)**/package.json",
  ":(glob)**/package-lock.json",
  ":(glob)**/npm-shrinkwrap.json",
  ":(glob)**/yarn.lock",
  ":(glob)**/pnpm-lock.yaml",
  ":(glob)**/pnpm-workspace.yaml",
  ":(glob)**/bun.lock",
  ":(glob)**/bun.lockb",
  ":(glob)**/.npmrc",
  ":(glob)**/.yarnrc",
  ":(glob)**/.yarnrc.yml",
  ":(glob)**/.pnpmfile.cjs",
  ":(glob)**/patches/**",
] as const;

async function nodeDependencyInputsChanged(workspace: PreparedWorkspace): Promise<boolean> {
  const root = candidateRoot(workspace);
  const [tracked, untracked] = await Promise.all([
    git(root, [
      "diff",
      "--name-only",
      workspace.baseRevision,
      "--",
      ...NODE_DEPENDENCY_INPUT_PATHS,
    ]),
    git(root, ["ls-files", "--others", "--exclude-standard", "--", ...NODE_DEPENDENCY_INPUT_PATHS]),
  ]);
  return tracked.length > 0 || untracked.length > 0;
}

async function runCandidate(
  context: WorkflowActionContext,
  checks: VerificationCheck[],
): Promise<CommandBatchResult> {
  return await runBatch(context, checks);
}

async function runBase(
  context: WorkflowActionContext,
  checks: VerificationCheck[],
): Promise<{ batch: CommandBatchResult; baseEvidence: string[]; cleanupEvidence: string[] }> {
  const input = context.input as ChangeVerificationInput;
  const eligible = checks.filter((check) => check.readOnly && check.baseEligible);
  if (eligible.length === 0)
    return {
      batch: emptyBatch(),
      baseEvidence: ["No checks were eligible for base comparison."],
      cleanupEvidence: [],
    };
  const repository = input.workspace.repository;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-base-"));
  const worktree = path.join(parent, "worktree");
  const baseEvidence: string[] = [];
  const cleanupEvidence: string[] = [];
  try {
    await git(repository, ["worktree", "add", "--detach", worktree, input.workspace.baseRevision]);
    baseEvidence.push(`Created detached base worktree at ${worktree}`);
    const candidateModules = path.join(candidateRoot(input.workspace), "node_modules");
    let candidateModulesAvailable = false;
    try {
      candidateModulesAvailable = (await fs.stat(candidateModules)).isDirectory();
      if (!candidateModulesAvailable) {
        baseEvidence.push("The candidate node_modules path is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        baseEvidence.push("No candidate dependency installation was available for reuse.");
      } else {
        baseEvidence.push(
          `Candidate dependency inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { batch: emptyBatch(), baseEvidence, cleanupEvidence };
      }
    }
    if (candidateModulesAvailable) {
      try {
        if (await nodeDependencyInputsChanged(input.workspace)) {
          baseEvidence.push(
            "Candidate dependencies were not reused because dependency inputs differ from the base revision.",
          );
          return { batch: emptyBatch(), baseEvidence, cleanupEvidence };
        }
        await fs.symlink(candidateModules, path.join(worktree, "node_modules"), "dir");
        baseEvidence.push(
          "Reused the candidate dependency installation after confirming that dependency inputs match the base revision.",
        );
      } catch (error) {
        baseEvidence.push(
          `Equivalent dependency reuse could not be established: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { batch: emptyBatch(), baseEvidence, cleanupEvidence };
      }
    }
    const batch = await runBatch(context, eligible, worktree);
    return { batch, baseEvidence, cleanupEvidence };
  } catch (error) {
    baseEvidence.push(
      `Base setup or execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { batch: emptyBatch(), baseEvidence, cleanupEvidence };
  } finally {
    try {
      await git(repository, ["worktree", "remove", "--force", worktree]);
      cleanupEvidence.push(`Removed detached base worktree ${worktree}`);
    } catch (error) {
      cleanupEvidence.push(
        `Base worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resultComplete(result: CommandBatchItemResult): boolean {
  return (
    result.outcome !== "timedOut" &&
    result.outcome !== "cancelled" &&
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    !(result.outcome === "failed" && result.exitCode === null)
  );
}

function resultPassed(result: CommandBatchItemResult | undefined): boolean {
  return (
    result !== undefined &&
    resultComplete(result) &&
    result.outcome === "succeeded" &&
    result.exitCode === 0
  );
}

function normalizeText(value: string, basePath: string, candidatePath: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll(basePath, candidatePath);
}

function stableFindings(result: CommandBatchItemResult, format: FindingFormat): string[] | null {
  if (format !== "json") return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.map((entry) => {
      const record = requireRecord(entry, "JSON finding");
      return requireString(record.id, "JSON finding id");
    });
    return ids.sort();
  } catch {
    return null;
  }
}

function resultFingerprint(
  result: CommandBatchItemResult | undefined,
  check: VerificationCheck,
  basePath: string,
  candidatePath: string,
): string {
  if (result === undefined) return "missing";
  const ids = stableFindings(result, check.findingFormat);
  const source =
    ids === null
      ? JSON.stringify({
          outcome: result.outcome,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: normalizeText(result.stdout, basePath, candidatePath),
          stderr: normalizeText(result.stderr, basePath, candidatePath),
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        })
      : JSON.stringify({ outcome: result.outcome, exitCode: result.exitCode, ids });
  return createHash("sha256").update(source).digest("hex");
}

function finding(
  check: VerificationCheck,
  kind: VerificationFinding["kind"],
  summary: string,
  fingerprint: string,
  candidate?: CommandBatchItemResult,
  base?: CommandBatchItemResult,
): VerificationFinding {
  return {
    checkId: check.id,
    kind,
    summary,
    fingerprint,
    ...(candidate === undefined ? {} : { candidateOutputRef: `candidate:${candidate.id}` }),
    ...(base === undefined ? {} : { baseOutputRef: `base:${base.id}` }),
  };
}

function previousRepairAttempts(context: WorkflowNodeContext): RepairAttempt[] {
  const attempts: RepairAttempt[] = [];
  let fingerprint = "";
  for (const step of context.state.steps) {
    if (step.nodeId === "repairGuard" && step.outcome === "ok") {
      const guard = step.output as { fingerprint?: string };
      fingerprint = guard.fingerprint ?? fingerprint;
    }
    if (step.nodeId !== "mechanicalRepair" && step.nodeId !== "semanticRepair") continue;
    if (step.outcome === "ok") {
      const output = step.output as RepairAttempt;
      if (output?.attempt !== undefined) attempts.push(output);
    } else if (step.outcome === "timed_out" || step.outcome === "failed") {
      attempts.push({
        attempt: attempts.length + 1,
        kind: step.nodeId === "semanticRepair" ? "semantic" : "mechanical",
        fingerprint,
        changedFiles: [],
        result: `${step.nodeId} ended with ${step.outcome}; inspect existing work before retrying.`,
      });
    }
  }
  return attempts;
}

export function classifyVerification(
  input: ChangeVerificationInput,
  state: ExecutionState,
): ChangeVerificationResult {
  const root = candidateRoot(input.workspace);
  const baseRoot = state.base.items[0]?.cwd ?? root;
  const candidate = new Map(state.candidate.items.map((item) => [item.id, item] as const));
  const base = new Map(state.base.items.map((item) => [item.id, item] as const));
  const related: VerificationFinding[] = [];
  const unrelated: VerificationFinding[] = [];
  const fixed: VerificationFinding[] = [];
  const unknown: VerificationFinding[] = [];
  for (const check of state.checks) {
    const candidateResult = candidate.get(check.id);
    const baseResult = base.get(check.id);
    const candidateFingerprint = resultFingerprint(candidateResult, check, root, root);
    const baseFingerprint = resultFingerprint(baseResult, check, baseRoot, root);
    if (candidateResult === undefined || !resultComplete(candidateResult)) {
      unknown.push(
        finding(
          check,
          "unknown",
          "Candidate result is missing, cancelled, timed out, truncated, or incomplete.",
          candidateFingerprint,
          candidateResult,
          baseResult,
        ),
      );
      continue;
    }
    if (!check.baseEligible || !check.readOnly) {
      if (!resultPassed(candidateResult))
        unknown.push(
          finding(
            check,
            "unknown",
            "Candidate-only check failed; base comparison is unavailable.",
            candidateFingerprint,
            candidateResult,
          ),
        );
      continue;
    }
    if (baseResult === undefined || !resultComplete(baseResult)) {
      if (!resultPassed(candidateResult))
        unknown.push(
          finding(
            check,
            "unknown",
            "Base comparison was unavailable or incomplete.",
            `${candidateFingerprint}:${baseFingerprint}`,
            candidateResult,
            baseResult,
          ),
        );
      continue;
    }
    const candidatePass = resultPassed(candidateResult);
    const basePass = resultPassed(baseResult);
    if (candidatePass && !basePass)
      fixed.push(
        finding(
          check,
          "fixedBaseline",
          "The candidate fixes a failure present on the base.",
          baseFingerprint,
          candidateResult,
          baseResult,
        ),
      );
    else if (!candidatePass && basePass)
      related.push(
        finding(
          check,
          "related",
          "The failure appears only on the candidate.",
          candidateFingerprint,
          candidateResult,
          baseResult,
        ),
      );
    else if (!candidatePass && !basePass && candidateFingerprint === baseFingerprint)
      unrelated.push(
        finding(
          check,
          "unrelated",
          "The same failure is present on the candidate and base.",
          candidateFingerprint,
          candidateResult,
          baseResult,
        ),
      );
    else if (!candidatePass && !basePass)
      unknown.push(
        finding(
          check,
          "unknown",
          "Candidate and base both fail differently.",
          `${candidateFingerprint}:${baseFingerprint}`,
          candidateResult,
          baseResult,
        ),
      );
  }
  const untested = (input.untested ?? []).map((summary, index) => ({
    checkId: `untested-${index + 1}`,
    kind: "untested" as const,
    summary,
    fingerprint: createHash("sha256").update(summary).digest("hex"),
  }));
  if (state.cleanupEvidence.some((item) => item.includes("failed"))) {
    unknown.push({
      checkId: "base-cleanup",
      kind: "unknown",
      summary: "Temporary base worktree cleanup failed.",
      fingerprint: createHash("sha256").update(state.cleanupEvidence.join("\n")).digest("hex"),
    });
  }
  const rejectedRepair = state.repairAttempts.find((attempt) =>
    attempt.result.startsWith("Rejected mechanical fixer:"),
  );
  if (rejectedRepair !== undefined) {
    unknown.push({
      checkId: "mechanical-fix-boundary",
      kind: "unknown",
      summary: rejectedRepair.result,
      fingerprint: createHash("sha256").update(rejectedRepair.result).digest("hex"),
    });
  }
  const failureFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        related: related.map((item) => item.fingerprint).sort(),
        unknown: unknown.map((item) => item.fingerprint).sort(),
        untested: untested.map((item) => item.fingerprint).sort(),
      }),
    )
    .digest("hex");
  const route =
    rejectedRepair !== undefined
      ? "blocked"
      : unknown.length > 0 || untested.length > 0
        ? "needsJudgment"
        : related.length === 0
          ? "ready"
          : "repairable";
  return {
    schema: CHANGE_VERIFICATION_SCHEMA,
    route,
    originatingWorkflow: input.originatingWorkflow,
    qualifiedNode: input.qualifiedNode,
    workspace: input.workspace,
    changedFiles: input.changedFiles ?? [],
    candidateCommands: state.candidate,
    baseCommands: state.base,
    relatedFailures: related,
    unrelatedFailures: unrelated,
    fixedBaselineFailures: fixed,
    unknownFailures: unknown,
    untestedChecks: untested,
    repairAttempts: state.repairAttempts,
    failureFingerprint,
    outputReferences: [
      ...state.candidate.items.map((item) => `candidate:${item.id}`),
      ...state.base.items.map((item) => `base:${item.id}`),
    ],
    reason:
      route === "ready"
        ? "All current-change checks passed; baseline failures remain visible."
        : route === "repairable"
          ? "Current-change failures have a bounded repair path."
          : route === "needsJudgment"
            ? "Complete evidence needs bounded attribution or repair judgment."
            : "Verification could not continue safely.",
    evidence: [...state.baseEvidence, ...state.cleanupEvidence],
  };
}

function checksForContext(context: WorkflowNodeContext): VerificationCheck[] {
  const input = context.input as ChangeVerificationInput;
  return input.checks?.length
    ? input.checks
    : (context.outputs.planChecks as VerificationPlan).checks;
}

function latestExecution(context: WorkflowNodeContext): ExecutionState {
  const checks = checksForContext(context);
  const candidate = context.outputs.runCandidate as CommandBatchResult;
  const baseOutput = context.outputs.runBase as {
    batch: CommandBatchResult;
    baseEvidence: string[];
    cleanupEvidence: string[];
  };
  return {
    checks,
    candidate,
    base: baseOutput.batch,
    baseEvidence: baseOutput.baseEvidence,
    cleanupEvidence: baseOutput.cleanupEvidence,
    repairAttempts: previousRepairAttempts(context),
  };
}

function latestClassification(context: WorkflowNodeContext): ChangeVerificationResult {
  const input = context.input as ChangeVerificationInput;
  const plan = context.outputs.planChecks as VerificationPlan | undefined;
  return classifyVerification(
    { ...input, untested: [...(input.untested ?? []), ...(plan?.untested ?? [])] },
    latestExecution(context),
  );
}

function statusPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if ((status.includes("R") || status.includes("C")) && entries[index + 1] !== undefined) {
      files.push(entries[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(files)].sort();
}

function workspacePath(root: string, file: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, file);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Workspace path escapes the repository: ${file}`);
  }
  return resolved;
}

async function pathFingerprint(root: string, file: string): Promise<string> {
  try {
    const target = workspacePath(root, file);
    const stat = await fs.lstat(target);
    const hash = createHash("sha256").update(`${stat.mode}:${stat.isSymbolicLink()}:`);
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(target));
    else if (stat.isFile()) hash.update(await fs.readFile(target));
    else hash.update("directory");
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function gitState(root: string): Promise<Map<string, string>> {
  const status = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional"],
    { cwd: root, encoding: "utf8", maxBuffer: 5_000_000, timeout: 60_000 },
  );
  const state = new Map<string, string>();
  for (const file of statusPaths(status.stdout)) {
    state.set(file, await pathFingerprint(root, file));
  }
  return state;
}

type PathBackup = { existed: false } | { existed: true; backupPath: string };

type WorkspaceBackup = {
  directory: string;
  paths: Map<string, PathBackup>;
};

async function backupPaths(root: string, files: Iterable<string>): Promise<WorkspaceBackup> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-repair-"));
  const snapshots = new Map<string, PathBackup>();
  let index = 0;
  try {
    for (const file of files) {
      const source = workspacePath(root, file);
      const backupPath = path.join(directory, String(index));
      index += 1;
      try {
        await fs.lstat(source);
        await fs.cp(source, backupPath, {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
        snapshots.set(file, { existed: true, backupPath });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        snapshots.set(file, { existed: false });
      }
    }
    return { directory, paths: snapshots };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function gitBlob(root: string, object: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["cat-file", "blob", object],
      { cwd: root, encoding: "buffer", maxBuffer: 100_000_000, timeout: 60_000 },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function restoreFromRevision(root: string, file: string, revision: string): Promise<void> {
  const target = workspacePath(root, file);
  const tree = await execFileAsync("git", ["ls-tree", "-z", revision, "--", file], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 5_000_000,
    timeout: 60_000,
  });
  if (tree.stdout.length === 0) {
    await fs.rm(target, { recursive: true, force: true });
    return;
  }
  const metadata = tree.stdout.slice(0, tree.stdout.indexOf("\t")).split(" ");
  const mode = metadata[0];
  const type = metadata[1];
  const object = metadata[2];
  if (mode === undefined || type !== "blob" || object === undefined) {
    throw new Error(`Cannot restore unsupported Git entry ${file}`);
  }
  const content = await gitBlob(root, object);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (mode === "120000") await fs.symlink(content.toString(), target);
  else {
    const permissions = mode === "100755" ? 0o755 : 0o644;
    await fs.writeFile(target, content, { mode: permissions });
    await fs.chmod(target, permissions);
  }
}

async function restorePath(
  root: string,
  file: string,
  backup: PathBackup | undefined,
  revision: string,
): Promise<void> {
  const target = workspacePath(root, file);
  if (backup === undefined) {
    await restoreFromRevision(root, file, revision);
    return;
  }
  await fs.rm(target, { recursive: true, force: true });
  if (!backup.existed) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(backup.backupPath, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function changedState(before: Map<string, string>, after: Map<string, string>): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((file) => before.get(file) !== after.get(file)).sort();
}

async function runMechanicalRepair(context: WorkflowActionContext): Promise<RepairAttempt> {
  const classification = latestClassification(context as unknown as WorkflowNodeContext);
  const checks = checksForContext(context as unknown as WorkflowNodeContext);
  const root = candidateRoot((context.input as ChangeVerificationInput).workspace);
  const attempts = previousRepairAttempts(context as unknown as WorkflowNodeContext);
  const target = classification.relatedFailures.find(
    (item) => checks.find((check) => check.id === item.checkId)?.mechanicalFix !== undefined,
  );
  if (target === undefined) throw new Error("No mechanical repair is available");
  const fix = checks.find((check) => check.id === target.checkId)?.mechanicalFix;
  if (fix === undefined) throw new Error("Mechanical repair disappeared");
  const beforeRevision = await git(root, ["rev-parse", "HEAD"]);
  const before = await gitState(root);
  const backup = await backupPaths(root, before.keys());
  let retainBackup = false;
  try {
    const result = await runCommandBatch(
      {
        items: [
          {
            id: `fix-${target.checkId}`,
            command: fix.command,
            args: fix.args,
            cwd: root,
            timeoutMs: fix.timeoutMs,
            maxOutputChars: fix.maxOutputChars,
          },
        ],
        maxConcurrency: 1,
      },
      { signal: context.signal },
    );
    const after = await gitState(root);
    const changedFiles = changedState(before, after);
    const outside = changedFiles.filter((file) => !fix.files.includes(file));
    let rejection: string | undefined;
    if (outside.length > 0) {
      const restorationFailures: string[] = [];
      for (const file of outside) {
        try {
          await restorePath(root, file, backup.paths.get(file), beforeRevision);
        } catch (error) {
          restorationFailures.push(`${file}: ${String(error)}`);
        }
      }
      const restored = await gitState(root);
      const unrestored = outside.filter((file) => before.get(file) !== restored.get(file));
      if (restorationFailures.length > 0 || unrestored.length > 0) {
        retainBackup = true;
        rejection = `Rejected mechanical fixer: changed undeclared files ${outside.join(", ")}; restoration failed for ${[...restorationFailures, ...unrestored].join(", ")}; backup retained at ${backup.directory}`;
      } else {
        rejection = `Rejected mechanical fixer: changed undeclared files ${outside.join(", ")}; restored all undeclared paths`;
      }
    }
    return {
      attempt: attempts.length + 1,
      kind: "mechanical",
      fingerprint: classification.failureFingerprint,
      changedFiles,
      result:
        rejection ??
        (result.items[0]?.outcome === "succeeded"
          ? fix.expectedDiff
          : JSON.stringify(result.items[0])),
    };
  } finally {
    if (!retainBackup) await fs.rm(backup.directory, { recursive: true, force: true });
  }
}

function parseSemanticRepair(value: unknown, context: WorkflowNodeContext): RepairAttempt {
  const record = requireRecord(value, "semantic repair");
  const attempts = previousRepairAttempts(context);
  return {
    attempt: attempts.length + 1,
    kind: "semantic",
    fingerprint: latestClassification(context).failureFingerprint,
    changedFiles: stringArray(record.changedFiles, "semantic repair changedFiles"),
    result: requireString(record.result, "semantic repair result"),
  };
}

function repairGuard(context: WorkflowNodeContext): Record<string, unknown> {
  const classification = latestClassification(context);
  const attempts = previousRepairAttempts(context);
  const repeated = context.state.steps.some(
    (step) =>
      (step.nodeId === "semanticRepair" || step.nodeId === "mechanicalRepair") &&
      step.outcome === "ok" &&
      (step.output as RepairAttempt)?.fingerprint === classification.failureFingerprint,
  );
  if (attempts.length >= MAX_REPAIR_ATTEMPTS || repeated) {
    return {
      route: "blocked",
      result: {
        ...classification,
        route: "blocked",
        repairAttempts: attempts,
        reason: repeated
          ? "The failure fingerprint repeated after repair."
          : "The repair attempt limit was reached.",
      },
    };
  }
  const checks = checksForContext(context);
  const mechanical =
    classification.relatedFailures.length > 0 &&
    classification.relatedFailures.every(
      (failure) =>
        checks.find((check) => check.id === failure.checkId)?.mechanicalFix !== undefined,
    );
  return {
    route: mechanical ? "mechanical" : "semantic",
    attempt: attempts.length + 1,
    fingerprint: classification.failureFingerprint,
  };
}

function parseRepairReconciliation(value: unknown): RepairReconciliation {
  const record = requireRecord(value, "repair reconciliation");
  if (record.route !== "verify" && record.route !== "retry" && record.route !== "blocked")
    throw new Error("repair reconciliation route must be verify, retry, or blocked");
  if (typeof record.commandsSettled !== "boolean")
    throw new Error("repair reconciliation commandsSettled must be a boolean");
  if (record.route !== "blocked" && !record.commandsSettled)
    throw new Error("Repair cannot continue until previous commands have settled");
  const evidence = stringArray(record.evidence, "repair reconciliation evidence").map((item) =>
    requireString(item, "repair reconciliation evidence item"),
  );
  if (evidence.length === 0)
    throw new Error("repair reconciliation needs command disposition evidence");
  return {
    route: record.route,
    commandsSettled: record.commandsSettled,
    evidence,
    reason: requireString(record.reason, "repair reconciliation reason"),
  };
}

function parseJudgment(value: unknown, context: WorkflowNodeContext): Record<string, unknown> {
  const record = requireRecord(value, "verification judgment");
  if (record.route !== "ready" && record.route !== "repair" && record.route !== "blocked")
    throw new Error("verification judgment route must be ready, repair, or blocked");
  return {
    route: record.route,
    reason: requireString(record.reason, "verification judgment reason"),
    evidence: stringArray(record.evidence, "verification judgment evidence"),
    result: latestClassification(context),
  };
}

export const changeVerificationWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.change-verification.v1",
  name: "change-verification",
  input: parseChangeVerificationInput,
  startAt: "selectChecks",
  maxSteps: 30,
  exits: {
    ready: { from: "ready", validate: (value: unknown) => value as ChangeVerificationResult },
    blocked: { from: "blocked", validate: (value: unknown) => value as ChangeVerificationResult },
  },
  nodes: {
    selectChecks: compute({
      run: ({ input }) => ({
        route: (input as ChangeVerificationInput).checks?.length ? "run" : "plan",
      }),
    }),
    planChecks: agent({
      statusDetail: "planning independent verification commands",
      prompt: ({ input }) => {
        const request = input as ChangeVerificationInput;
        return [
          "Propose the required direct verification commands because no complete program command list was supplied.",
          "Do not run commands. Use no shell wrapper, stdin, environment override, Git mutation, publication, merge, release, or deployment.",
          "Each check needs id, executable, argument array, exact prepared cwd, timeout, output limit, readOnly, baseEligible, changedFileScope, and findingFormat.",
          "Set readOnly only when the command does not modify repository source. Set baseEligible only when the same executable and arguments safely test a separate base checkout by changing cwd alone.",
          "Candidate-bound paths, including absolute Docker bind mounts, require baseEligible=false. Do not claim base-comparison evidence for candidate-only checks.",
          "List checks that cannot run locally under untested. Do not omit required remote checks or mark them completed.",
          `Prepared workspace: ${JSON.stringify(request.workspace)}`,
          `Changed files: ${JSON.stringify(request.changedFiles ?? [])}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "checks": [{ "id": "stable", "command": "npm", "args": ["run", "check"], "cwd": "/absolute/workspace", "timeoutMs": 2700000, "maxOutputChars": 1000000, "readOnly": true, "baseEligible": true, "changedFileScope": false, "findingFormat": "text" }], "untested": [] }',
      validate: parsePlannedChecks,
    }),
    runCandidate: action({
      effect: manualEffect("pi-workflows.change-verification.candidate"),
      run: async (context) =>
        await runCandidate(context, checksForContext(context as unknown as WorkflowNodeContext)),
    }),
    runBase: action({
      effect: manualEffect("pi-workflows.change-verification.base"),
      run: async (context) =>
        await runBase(context, checksForContext(context as unknown as WorkflowNodeContext)),
    }),
    classify: compute({ run: latestClassification }),
    routeRepairReconciliation: compute({ run: ({ outputs }) => outputs.reconcileRepair }),
    repairGuard: compute({ run: repairGuard }),
    mechanicalRepair: action({
      effect: manualEffect("pi-workflows.change-verification.mechanical-repair"),
      run: runMechanicalRepair,
    }),
    semanticRepair: agent({
      timeoutMs: IMPLEMENTATION_TIMEOUT_MS,
      prompt: (context) => {
        const input = context.input as ChangeVerificationInput;
        const result = latestClassification(context);
        return [
          "Repair only current-change failures in the prepared workspace.",
          "Do not fix unrelated baseline failures or run broad repository migrations.",
          `Prepared path: ${candidateRoot(input.workspace)}`,
          `Authorized scope: ${input.workspace.scope}`,
          `Approved plan: ${JSON.stringify(input.plan)}`,
          `Related failures: ${JSON.stringify(result.relatedFailures)}`,
          `Unknown failures: ${JSON.stringify(result.unknownFailures)}`,
        ].join("\n");
      },
      expectedOutput: '{ "changedFiles": ["file"], "result": "repair made" }',
      validate: parseSemanticRepair,
    }),
    reconcileRepair: agent({
      allowedTools: ["read", "grep", "find", "ls", "list_sessions"],
      timeoutMs: 30 * 60_000,
      statusDetail: "checking interrupted repair work and commands",
      prompt: (context) =>
        [
          "A semantic repair failed or timed out. Reconcile the existing work before any replacement work.",
          "Do not edit repository files or launch repair, verification, publication, deployment, or paid work in this step.",
          "Inspect repository files, existing diff reports, saved receipts, and command sessions with read, grep, find, ls, or list_sessions. Other tools, including shells, edits, process input, and process termination, are blocked.",
          "Identify every command from the interrupted attempt and establish that it finished or was safely stopped. An interrupted tool wait or an aborted Pi turn does not prove its process stopped. If an owned command still needs termination, report a blocker for that exact command rather than calling a mutation-capable tool.",
          "If command ownership or settlement cannot be established, return blocked with commandsSettled=false and the missing evidence. Do not infer that no output means no active process.",
          "Return verify when completed or partial edits can now be checked without repeating them. Return retry only when commands have settled and implementation work remains; the existing repair bound still applies.",
          "Evidence must identify checked command sessions or receipts and their terminal outcomes, or explain how the complete turn evidence proves no commands were launched.",
          `Workspace: ${JSON.stringify((context.input as ChangeVerificationInput).workspace)}`,
          `Repair attempts: ${JSON.stringify(previousRepairAttempts(context))}`,
          `Verification: ${JSON.stringify(latestClassification(context))}`,
        ].join("\n"),
      expectedOutput:
        '{ "route": "verify", "commandsSettled": true, "evidence": ["Exact command receipts and observed terminal outcomes"], "reason": "Existing edits can be verified" }',
      validate: parseRepairReconciliation,
    }),
    judge: agent({
      prompt: (context) =>
        [
          "Judge only the complete verification evidence that exact comparison could not attribute.",
          "Choose ready only when evidence proves no current-change failure. Choose repair for an in-scope fix. Choose blocked for a material unresolved problem.",
          `Verification: ${JSON.stringify(latestClassification(context))}`,
        ].join("\n"),
      expectedOutput:
        '{ "route": "ready" | "repair" | "blocked", "reason": "reason", "evidence": ["evidence"] }',
      validate: parseJudgment,
    }),
    ready: compute({
      run: (context) => {
        const result = latestClassification(context);
        const judgment = context.outputs.judge as
          | { reason?: string; evidence?: string[] }
          | undefined;
        return {
          ...result,
          route: "ready",
          ...(judgment === undefined
            ? {}
            : {
                reason: judgment.reason ?? result.reason,
                evidence: [...result.evidence, ...(judgment.evidence ?? [])],
              }),
        };
      },
    }),
    blocked: compute({
      run: (context) => {
        const guard = context.outputs.repairGuard as
          | { result?: ChangeVerificationResult }
          | undefined;
        const judgment = context.outputs.judge as
          | { reason?: string; evidence?: string[] }
          | undefined;
        const result = guard?.result ?? latestClassification(context);
        const reconciliationStep = context.state.steps
          .filter((step) => step.nodeId === "reconcileRepair")
          .at(-1);
        const reconciliation =
          reconciliationStep?.outcome === "ok"
            ? (reconciliationStep.output as RepairReconciliation)
            : undefined;
        const recoveryFailed =
          reconciliationStep !== undefined && reconciliationStep.outcome !== "ok";
        return {
          ...result,
          route: "blocked",
          reason:
            guard?.result?.reason ??
            (recoveryFailed
              ? "Repair reconciliation did not establish safe command settlement."
              : reconciliation?.route === "blocked"
                ? reconciliation.reason
                : (judgment?.reason ?? result.reason)),
          evidence: [
            ...result.evidence,
            ...(judgment?.evidence ?? []),
            ...(reconciliation?.evidence ?? []),
          ],
        };
      },
    }),
  },
  edges: [
    {
      from: "selectChecks",
      switch: { on: "$.route", cases: { run: "runCandidate", plan: "planChecks" } },
    },
    { from: "planChecks", to: "runCandidate" },
    { from: "runCandidate", to: "runBase" },
    { from: "runBase", to: "classify" },
    {
      from: "classify",
      switch: {
        on: "$.route",
        cases: {
          ready: "ready",
          repairable: "repairGuard",
          needsJudgment: "judge",
          blocked: "blocked",
        },
      },
    },
    {
      from: "repairGuard",
      switch: {
        on: "$.route",
        cases: { mechanical: "mechanicalRepair", semantic: "semanticRepair", blocked: "blocked" },
      },
    },
    { from: "mechanicalRepair", to: "runCandidate" },
    {
      from: "semanticRepair",
      switch: {
        on: "$result.outcome",
        cases: { ok: "runCandidate", timed_out: "reconcileRepair", failed: "reconcileRepair" },
      },
    },
    {
      from: "reconcileRepair",
      switch: {
        on: "$result.outcome",
        cases: { ok: "routeRepairReconciliation", timed_out: "blocked", failed: "blocked" },
      },
    },
    {
      from: "routeRepairReconciliation",
      switch: {
        on: "$.route",
        cases: { verify: "runCandidate", retry: "repairGuard", blocked: "blocked" },
      },
    },
    {
      from: "judge",
      switch: {
        on: "$.route",
        cases: { ready: "ready", repair: "repairGuard", blocked: "blocked" },
      },
    },
  ],
});

export default changeVerificationWorkflow;
