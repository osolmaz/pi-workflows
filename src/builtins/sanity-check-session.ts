import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandBatch, type CommandBatchItemResult } from "../workflows/command-batch.js";
import { extractJsonValue } from "../workflows/json.js";

const SESSION_TIMEOUT_MS = 15 * 60_000;
const SESSION_OUTPUT_CHARS = 1_000_000;
const MAX_PROMPT_CHARS = 96_000;
const MAX_ERROR_CHARS = 2_000;

export type IsolatedReviewRequest = {
  id: string;
  prompt: string;
};

export type PiInvocation = {
  command: string;
  prefixArgs: string[];
};

export type IsolatedReviewOptions = {
  invocation?: PiInvocation;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxConcurrency?: number;
};

export async function runIsolatedReviewSessions(
  requests: IsolatedReviewRequest[],
  cwd: string,
  signal: AbortSignal,
  options: IsolatedReviewOptions = {},
): Promise<Record<string, unknown>> {
  if (requests.length === 0) return {};
  const ids = new Set<string>();
  for (const request of requests) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(request.id)) {
      throw new Error(`Invalid isolated review id: ${request.id}`);
    }
    if (ids.has(request.id)) throw new Error(`Duplicate isolated review id: ${request.id}`);
    ids.add(request.id);
    if (request.prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `Isolated review prompt ${request.id} exceeds ${MAX_PROMPT_CHARS} characters`,
      );
    }
  }

  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sanity-check-"));
  try {
    const invocation = options.invocation ?? resolvePiInvocation();
    const items = await Promise.all(
      requests.map(async (request) => {
        const promptPath = path.join(promptDir, `${request.id}.md`);
        await fs.writeFile(promptPath, request.prompt, { encoding: "utf8", mode: 0o600 });
        return {
          id: request.id,
          command: invocation.command,
          args: [
            ...invocation.prefixArgs,
            "--mode",
            "json",
            "--print",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--tools",
            "read,grep,find,ls",
            `@${promptPath}`,
            "Follow the attached review instructions and return only the requested JSON.",
          ],
          cwd,
          timeoutMs: options.timeoutMs ?? SESSION_TIMEOUT_MS,
          maxOutputChars: options.maxOutputChars ?? SESSION_OUTPUT_CHARS,
        };
      }),
    );
    const batch = await runCommandBatch(
      {
        items,
        maxConcurrency: options.maxConcurrency ?? requests.length,
      },
      { signal },
    );
    const outputs: Record<string, unknown> = {};
    for (const item of batch.items) {
      outputs[item.id] = parseSessionResult(item);
    }
    return outputs;
  } finally {
    await fs.rm(promptDir, { recursive: true, force: true });
  }
}

export function resolvePiInvocation(): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const scriptName = currentScript === undefined ? "" : path.basename(currentScript).toLowerCase();
  const isPiPackageCli =
    scriptName === "cli.js" &&
    currentScript?.split(path.sep).some((segment) => segment === "pi-coding-agent");
  const isPiScript = /^(pi|pi\.[cm]?js)$/.test(scriptName) || isPiPackageCli;
  if (currentScript && !isBunVirtualScript && isPiScript) {
    return {
      command: process.execPath,
      prefixArgs: [currentScript, ...inheritedPiArgs(process.argv.slice(2))],
    };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^pi(\.exe)?$/.test(execName)) {
    return { command: process.execPath, prefixArgs: inheritedPiArgs(process.argv.slice(1)) };
  }
  return { command: "pi", prefixArgs: [] };
}

export function parsePiJsonOutput(stdout: string): unknown {
  let finalText = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "message_end" || !isRecord(event.message)) continue;
    const message = event.message;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(
        boundedError(
          typeof message.errorMessage === "string"
            ? message.errorMessage
            : `Pi session stopped with ${String(message.stopReason)}`,
        ),
      );
    }
    const text = messageText(message.content);
    if (text.trim()) finalText = text;
  }
  if (!finalText) throw new Error("Isolated Pi session returned no assistant JSON output");
  return extractJsonValue(finalText);
}

function parseSessionResult(result: CommandBatchItemResult): unknown {
  if (result.outcome !== "succeeded") {
    throw new Error(
      `Isolated Pi session ${result.id} ${result.outcome}: ${boundedError(result.error ?? result.stderr)}`,
    );
  }
  if (result.stdoutTruncated) {
    throw new Error(`Isolated Pi session ${result.id} exceeded its output limit`);
  }
  try {
    return parsePiJsonOutput(result.stdout);
  } catch (error) {
    throw new Error(
      `Isolated Pi session ${result.id} returned invalid output: ${boundedError(errorMessage(error))}`,
    );
  }
}

function inheritedPiArgs(args: string[]): string[] {
  const inherited: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline") {
      inherited.push(arg);
      continue;
    }
    if (arg !== "--provider" && arg !== "--model" && arg !== "--thinking") continue;
    const value = args[index + 1];
    if (value !== undefined) {
      inherited.push(arg, value);
      index += 1;
    }
  }
  return inherited;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedError(message: string): string {
  const value = message.trim() || "unknown failure";
  return value.length <= MAX_ERROR_CHARS ? value : `${value.slice(0, MAX_ERROR_CHARS)}…`;
}
