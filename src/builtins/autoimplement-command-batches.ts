import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_COMMAND_BATCH_ITEMS, type CommandBatchItem } from "../workflows/command-batch.js";

export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export const CI_WATCH_TIMEOUT_MS = 5 * 60_000;
export const VERIFICATION_TIMEOUT_MS = 45 * 60_000;
export const AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS = 1_000_000;
export const AUTOIMPLEMENT_MAX_CONCURRENCY = 8;

export type AutoimplementConcurrency = {
  reviewer: number;
  ciWatch: number;
  verification: number;
};

export type PublishedRepository = {
  id: string;
  repository: string;
  branch: string;
  baseBranch: string;
  headRevision: string;
  pr: string;
  dependencyFingerprint?: string;
};

export type PublishedRepositories = {
  repositories: PublishedRepository[];
};

export type VerificationCommandPlan = {
  commands: CommandBatchItem[];
  untested: string[];
};

export type CiTargetInspection = {
  id: string;
  repository: string;
  headRevision: string;
  pr: string;
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  trackingCommand?: CommandBatchItem;
};

export type CiInspectionBatch = {
  route: "green" | "failed" | "pending" | "unavailable";
  reason: string;
  relatedFailures: string[];
  unrelatedFailures: string[];
  targets: CiTargetInspection[];
};

export function parseAutoimplementConcurrency(value: unknown): AutoimplementConcurrency {
  if (value === undefined) return { reviewer: 4, ciWatch: 4, verification: 2 };
  const input = requireRecord(value, "autoimplement concurrency");
  for (const key of Object.keys(input)) {
    if (key !== "reviewer" && key !== "ciWatch" && key !== "verification") {
      throw new Error(`autoimplement concurrency.${key} is not supported`);
    }
  }
  return {
    reviewer: concurrencyValue(input.reviewer ?? 4, "reviewer"),
    ciWatch: concurrencyValue(input.ciWatch ?? 4, "ciWatch"),
    verification: concurrencyValue(input.verification ?? 2, "verification"),
  };
}

export function parsePublishedRepositories(value: unknown): PublishedRepositories {
  const result = requireRecord(value, "publication result");
  if (!Array.isArray(result.repositories) || result.repositories.length === 0) {
    throw new Error("publication result repositories must be a non-empty array");
  }
  if (result.repositories.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `publication result repositories must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  const repositories = result.repositories.map((entry, index) => {
    const raw = requireRecord(entry, `publication repositories[${index}]`);
    const repository = requireAbsolutePath(
      raw.repository,
      `publication repositories[${index}].repository`,
    );
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`publication repository is duplicated: ${repository}`);
    ids.add(id);
    const dependencyFingerprint = optionalString(
      raw.dependencyFingerprint,
      `publication repositories[${index}].dependencyFingerprint`,
    );
    if (raw.pushed !== true) {
      throw new Error(`publication repositories[${index}].pushed must be true`);
    }
    return {
      id,
      repository,
      branch: requireString(raw.branch, `publication repositories[${index}].branch`),
      baseBranch: requireString(raw.baseBranch, `publication repositories[${index}].baseBranch`),
      headRevision: requireString(
        raw.headRevision,
        `publication repositories[${index}].headRevision`,
      ),
      pr: requireString(raw.pr, `publication repositories[${index}].pr`),
      ...(dependencyFingerprint !== undefined ? { dependencyFingerprint } : {}),
    };
  });
  return { repositories };
}

export function reviewerCommand(repository: PublishedRepository): CommandBatchItem {
  return {
    id: repository.id,
    command: "pi-reviewer",
    args: ["--base", repository.baseBranch],
    cwd: repository.repository,
    timeoutMs: REVIEW_TIMEOUT_MS,
    maxOutputChars: AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  };
}

export function parseVerificationCommandPlan(value: unknown): VerificationCommandPlan {
  const result = requireRecord(value, "verification command plan");
  if (!Array.isArray(result.commands) || result.commands.length === 0) {
    throw new Error("verification commands must be a non-empty array");
  }
  const directories = new Set<string>();
  const commands = result.commands.map((entry, index) => {
    const command = parseCommandItem(entry, `verification commands[${index}]`, {
      maxTimeoutMs: VERIFICATION_TIMEOUT_MS,
    });
    if (directories.has(command.cwd)) {
      throw new Error(
        `verification commands must use distinct working directories: ${command.cwd}`,
      );
    }
    directories.add(command.cwd);
    validateVerificationCommand(command, index);
    return command;
  });
  return {
    commands,
    untested: stringArray(result.untested ?? [], "verification untested"),
  };
}

export function parseCiInspectionBatch(value: unknown): CiInspectionBatch {
  const result = requireRecord(value, "CI inspection");
  if (!Array.isArray(result.targets) || result.targets.length === 0) {
    throw new Error("CI inspection targets must be a non-empty array");
  }
  if (result.targets.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(
      `CI inspection targets must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`,
    );
  }
  const ids = new Set<string>();
  const targets = result.targets.map((entry, index) => {
    const raw = requireRecord(entry, `CI targets[${index}]`);
    const repository = requireAbsolutePath(raw.repository, `CI targets[${index}].repository`);
    const id = repositoryId(repository);
    if (ids.has(id)) throw new Error(`CI target is duplicated: ${repository}`);
    ids.add(id);
    if (
      raw.route !== "green" &&
      raw.route !== "failed" &&
      raw.route !== "pending" &&
      raw.route !== "unavailable"
    ) {
      throw new Error(`CI targets[${index}].route is invalid`);
    }
    const target: CiTargetInspection = {
      id,
      repository,
      headRevision: requireString(raw.headRevision, `CI targets[${index}].headRevision`),
      pr: requireString(raw.pr, `CI targets[${index}].pr`),
      route: raw.route,
      reason: requireString(raw.reason, `CI targets[${index}].reason`),
      relatedFailures: stringArray(
        raw.relatedFailures ?? [],
        `CI targets[${index}].relatedFailures`,
      ),
      unrelatedFailures: stringArray(
        raw.unrelatedFailures ?? [],
        `CI targets[${index}].unrelatedFailures`,
      ),
    };
    if (raw.route === "pending") {
      target.trackingCommand = parseCiCommand(raw.trackingCommand, id, repository);
    }
    return target;
  });
  const route = targets.some((target) => target.route === "failed")
    ? "failed"
    : targets.some((target) => target.route === "pending")
      ? "pending"
      : targets.some((target) => target.route === "unavailable")
        ? "unavailable"
        : "green";
  return {
    route,
    reason: targets.map((target) => `${target.id}: ${target.reason}`).join("; "),
    relatedFailures: targets.flatMap((target) => target.relatedFailures),
    unrelatedFailures: targets.flatMap((target) => target.unrelatedFailures),
    targets,
  };
}

export function parseCiCommand(value: unknown, id: string, repository: string): CommandBatchItem {
  const raw = requireRecord(value, "CI tracking command");
  if (raw.id !== id) throw new Error("CI tracking command id must match the target repository");
  const command = parseCommandItem(raw, "CI tracking command", {
    id,
    command: "gh",
    cwd: repository,
    maxTimeoutMs: CI_WATCH_TIMEOUT_MS,
  });
  const args = command.args;
  const allowed =
    (args[0] === "pr" && args[1] === "checks" && args.includes("--watch")) ||
    (args[0] === "run" && args[1] === "watch");
  if (!allowed) throw new Error("CI tracking command args are not allowed");
  return command;
}

export function repositoryId(repository: string): string {
  const canonical = path.resolve(repository);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function parseCommandItem(
  value: unknown,
  label: string,
  options: {
    id?: string;
    command?: string;
    cwd?: string;
    maxTimeoutMs: number;
  },
): CommandBatchItem {
  const raw = requireRecord(value, label);
  const id = options.id ?? requireString(raw.id, `${label}.id`);
  const command = options.command ?? requireString(raw.command, `${label}.command`);
  if (options.command !== undefined && raw.command !== options.command) {
    throw new Error(`${label}.command must be ${options.command}`);
  }
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${label}.args must be an array of strings`);
  }
  const cwd = options.cwd ?? requireAbsolutePath(raw.cwd, `${label}.cwd`);
  if (options.cwd !== undefined && path.resolve(String(raw.cwd)) !== options.cwd) {
    throw new Error(`${label}.cwd must match the target repository`);
  }
  const timeoutMs = positiveInteger(raw.timeoutMs, `${label}.timeoutMs`, options.maxTimeoutMs);
  const maxOutputChars = positiveInteger(
    raw.maxOutputChars ?? AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
    `${label}.maxOutputChars`,
    AUTOIMPLEMENT_BATCH_MAX_OUTPUT_CHARS,
  );
  return { id, command, args: [...raw.args] as string[], cwd, timeoutMs, maxOutputChars };
}

function validateVerificationCommand(command: CommandBatchItem, index: number): void {
  const forbiddenCommands = new Set(["bash", "sh", "zsh", "fish", "git", "gh", "rm"]);
  if (forbiddenCommands.has(path.basename(command.command))) {
    throw new Error(`verification commands[${index}].command is not allowed`);
  }
  const joined = command.args.join(" ").toLowerCase();
  if (/\b(publish|release|deploy|push|merge)\b/.test(joined)) {
    throw new Error(`verification commands[${index}] contains a mutation or publication action`);
  }
}

function concurrencyValue(value: unknown, field: string): number {
  return positiveInteger(
    value,
    `autoimplement concurrency.${field}`,
    AUTOIMPLEMENT_MAX_CONCURRENCY,
  );
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

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
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireAbsolutePath(value: unknown, label: string): string {
  const resolved = requireString(value, label);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be absolute`);
  return path.resolve(resolved);
}
