import path from "node:path";
import { CancelledError, TimeoutError, errorMessage, isAbortLikeError } from "./errors.js";
import { runShellAction, shellOutputTruncation, shellResultFromError } from "./shell.js";
import type { MaybePromise, ShellActionResult } from "./types.js";

export const COMMAND_BATCH_RESULT_SCHEMA = "pi-workflows.command-batch-result.v1";
export const MAX_COMMAND_BATCH_ITEMS = 64;
export const MAX_COMMAND_BATCH_CONCURRENCY = 8;
export const MAX_COMMAND_BATCH_TIMEOUT_MS = 60 * 60_000;
export const MAX_COMMAND_BATCH_OUTPUT_CHARS = 1_000_000;

const MAX_ERROR_CHARS = 2_000;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type CommandBatchItem = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
};

export type CommandBatchRequest = {
  items: CommandBatchItem[];
  maxConcurrency: number;
};

export type CommandBatchItemOutcome = "succeeded" | "failed" | "timedOut" | "cancelled";

export type CommandBatchItemResult = ShellActionResult & {
  id: string;
  outcome: CommandBatchItemOutcome;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
};

export type CommandBatchResult = {
  schema: typeof COMMAND_BATCH_RESULT_SCHEMA;
  items: CommandBatchItemResult[];
  completed: number;
  total: number;
};

export type RunCommandBatchOptions = {
  signal?: AbortSignal;
  onItemSettled?: (
    result: CommandBatchItemResult,
    completed: number,
    total: number,
  ) => MaybePromise<void>;
};

export function validateCommandBatchRequest(value: unknown): CommandBatchRequest {
  const request = requireRecord(value, "command batch request");
  for (const key of Object.keys(request)) {
    if (key !== "items" && key !== "maxConcurrency") {
      throw new Error(`command batch request.${key} is not supported`);
    }
  }
  if (!Array.isArray(request.items)) {
    throw new Error("command batch items must be an array");
  }
  if (request.items.length > MAX_COMMAND_BATCH_ITEMS) {
    throw new Error(`command batch items must contain at most ${MAX_COMMAND_BATCH_ITEMS} entries`);
  }
  const ids = new Set<string>();
  const items = request.items.map((item, index) => {
    const normalized = validateItem(item, index);
    if (ids.has(normalized.id)) {
      throw new Error(`command batch item id is duplicated: ${normalized.id}`);
    }
    ids.add(normalized.id);
    return normalized;
  });
  const maxConcurrency = positiveInteger(
    request.maxConcurrency,
    "command batch maxConcurrency",
    MAX_COMMAND_BATCH_CONCURRENCY,
  );
  return { items, maxConcurrency };
}

export async function runCommandBatch(
  input: CommandBatchRequest,
  options: RunCommandBatchOptions = {},
): Promise<CommandBatchResult> {
  const request = validateCommandBatchRequest(input);
  const total = request.items.length;
  if (total === 0) {
    return { schema: COMMAND_BATCH_RESULT_SCHEMA, items: [], completed: 0, total: 0 };
  }

  const results = Array.from<CommandBatchItemResult | undefined>({ length: total });
  const signal = options.signal;
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (!signal?.aborted) {
      const index = nextIndex;
      if (index >= total) return;
      nextIndex += 1;
      if (signal?.aborted) return;

      const item = request.items[index];
      if (item === undefined) return;
      const result = await runItem(item, signal);
      results[index] = result;
      completed += 1;
      try {
        await options.onItemSettled?.(result, completed, total);
      } catch {
        // Completion callbacks are observational and cannot change batch execution.
      }
    }
  };

  const runnerCount = Math.min(request.maxConcurrency, total);
  await Promise.all(Array.from({ length: runnerCount }, worker));

  for (let index = 0; index < total; index += 1) {
    if (results[index] !== undefined) continue;
    const item = request.items[index];
    if (item !== undefined) results[index] = cancelledResult(item);
  }

  return {
    schema: COMMAND_BATCH_RESULT_SCHEMA,
    items: results as CommandBatchItemResult[],
    completed,
    total,
  };
}

function validateItem(value: unknown, index: number): CommandBatchItem {
  const item = requireRecord(value, `command batch items[${index}]`);
  const allowed = new Set(["id", "command", "args", "cwd", "timeoutMs", "maxOutputChars"]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) throw new Error(`command batch items[${index}].${key} is not supported`);
  }
  const id = requireString(item.id, `command batch items[${index}].id`);
  if (!ITEM_ID_PATTERN.test(id)) {
    throw new Error(`command batch items[${index}].id is invalid`);
  }
  const command = requireString(item.command, `command batch items[${index}].command`);
  if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`command batch items[${index}].args must be an array of strings`);
  }
  const cwd = requireString(item.cwd, `command batch items[${index}].cwd`);
  if (!path.isAbsolute(cwd)) {
    throw new Error(`command batch items[${index}].cwd must be absolute`);
  }
  const timeoutMs = positiveInteger(
    item.timeoutMs,
    `command batch items[${index}].timeoutMs`,
    MAX_COMMAND_BATCH_TIMEOUT_MS,
  );
  const maxOutputChars = positiveInteger(
    item.maxOutputChars,
    `command batch items[${index}].maxOutputChars`,
    MAX_COMMAND_BATCH_OUTPUT_CHARS,
  );
  return { id, command, args: [...item.args] as string[], cwd, timeoutMs, maxOutputChars };
}

async function runItem(
  item: CommandBatchItem,
  signal?: AbortSignal,
): Promise<CommandBatchItemResult> {
  try {
    const result = await runShellAction(
      {
        command: item.command,
        args: item.args,
        cwd: item.cwd,
        timeoutMs: item.timeoutMs,
        maxOutputChars: item.maxOutputChars,
      },
      signal,
    );
    return itemResult(item.id, "succeeded", result);
  } catch (error) {
    const result = shellResultFromError(error) ?? emptyShellResult(item);
    const outcome =
      error instanceof TimeoutError
        ? "timedOut"
        : error instanceof CancelledError || isAbortLikeError(error)
          ? "cancelled"
          : "failed";
    return itemResult(item.id, outcome, result, boundedError(error));
  }
}

function itemResult(
  id: string,
  outcome: CommandBatchItemOutcome,
  result: ShellActionResult,
  error?: string,
): CommandBatchItemResult {
  const truncation = shellOutputTruncation(result);
  return {
    id,
    outcome,
    ...result,
    stdoutTruncated: truncation.stdout,
    stderrTruncated: truncation.stderr,
    ...(error !== undefined ? { error } : {}),
  };
}

function cancelledResult(item: CommandBatchItem): CommandBatchItemResult {
  return itemResult(item.id, "cancelled", emptyShellResult(item), "Command was not started");
}

function emptyShellResult(item: CommandBatchItem): ShellActionResult {
  return {
    command: item.command,
    args: [...item.args],
    cwd: item.cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    durationMs: 0,
  };
}

function boundedError(error: unknown): string {
  const message = errorMessage(error);
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS)}…`;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
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
