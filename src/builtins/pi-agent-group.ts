import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_AGENTS = 8;
const MAX_CONCURRENCY = 8;
const MAX_PROMPT_CHARS = 96_000;
const DEFAULT_FINAL_CHARS = 256_000;
const MAX_FINAL_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_PHASE_UPDATES = 64;
const MIN_PHASE_INTERVAL_MS = 250;

export type PiAgentTool = "read" | "grep" | "find" | "ls";
export type PiAgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiAgentRequest = {
  id: string;
  role: string;
  prompt: string;
  cwd: string;
  tools: PiAgentTool[];
  timeoutMs?: number;
  model?: { provider: string; id: string };
  thinkingLevel?: PiAgentThinkingLevel;
};

export type PiAgentResult = {
  id: string;
  text: string;
  model: string;
  thinkingLevel: PiAgentThinkingLevel;
  durationMs: number;
};

export type PiAgentLifecycleState = "running" | "completed" | "failed" | "cancelled";

export type PiAgentLifecycleEvent = {
  id: string;
  role: string;
  state: PiAgentLifecycleState;
  phase: string;
  elapsedMs: number;
  model?: string;
  thinkingLevel?: PiAgentThinkingLevel;
};

type PiAgentEvent = Record<string, unknown>;

type PiAgentSession = {
  prompt(text: string, options?: { preflightResult?: (accepted: boolean) => void }): Promise<void>;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: PiAgentThinkingLevel;
};

export type PiAgentSessionFactory = (
  request: PiAgentRequest,
  context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
) => Promise<PiAgentSession>;

export type PiAgentGroupOptions = {
  maxConcurrency: number;
  signal: AbortSignal;
  failFast?: boolean;
  maxFinalChars?: number;
  onLifecycle?: (event: PiAgentLifecycleEvent) => void | Promise<void>;
  sessionFactory?: PiAgentSessionFactory;
  now?: () => number;
};

export class PiAgentGroupError extends Error {
  constructor(
    readonly agentId: string,
    readonly code: string,
    message: string,
  ) {
    super(`Pi agent ${agentId} ${code}: ${bounded(message)}`);
    this.name = "PiAgentGroupError";
  }
}

export async function runPiAgentGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): Promise<PiAgentResult[]> {
  const { requests, maxFinalChars } = validateGroup(input, options);
  if (requests.length === 0) return [];
  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);

  const modelRuntime =
    options.sessionFactory === undefined
      ? await ModelRuntime.create({
          allowModelNetwork: false,
          credentials: await createEphemeralCredentialStore(options.signal),
          modelsStore: createEphemeralModelStore(),
        })
      : undefined;
  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);
  const sessionFactory = options.sessionFactory ?? createSdkSession;
  const internalAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, internalAbort.signal]);
  const results = Array.from<PiAgentResult | undefined>({ length: requests.length });
  const started = new Set<number>();
  let nextIndex = 0;
  let primary: { index: number; error: unknown } | undefined;

  const worker = async () => {
    while (!signal.aborted) {
      const index = nextIndex;
      if (index >= requests.length) return;
      nextIndex += 1;
      started.add(index);
      try {
        results[index] = await runOneAgent(requests[index]!, {
          ...options,
          maxFinalChars,
          signal,
          sessionFactory,
          ...(modelRuntime !== undefined ? { modelRuntime } : {}),
        });
      } catch (error) {
        if (primary === undefined && !options.signal.aborted) {
          primary = { index, error };
          if (options.failFast !== false) internalAbort.abort(error);
        }
        if (options.failFast !== false) return;
      }
    }
  };

  const workerCount = Math.min(options.maxConcurrency, requests.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);
  if (primary !== undefined) {
    await publishQueuedCancellations(requests, started, options);
    throw primary.error;
  }
  return results as PiAgentResult[];
}

type ModelRuntimeCreateOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
type CredentialStore = NonNullable<ModelRuntimeCreateOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;
type StoredCredential = Exclude<Credential, undefined>;
type ModelStore = NonNullable<ModelRuntimeCreateOptions["modelsStore"]>;
type ModelStoreEntry = Awaited<ReturnType<ModelStore["read"]>>;

export async function createEphemeralCredentialStore(
  signal: AbortSignal,
): Promise<CredentialStore> {
  signal.throwIfAborted();
  const authPath = path.join(getAgentDir(), "auth.json");
  let source: unknown = {};
  try {
    source = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error("Could not load Pi credentials for isolated agents");
    }
  }
  const entries = parseCredentialEntries(source);
  const pending = new Map<string, Promise<Credential>>();
  const enqueue = (
    providerId: string,
    operation: () => Promise<Credential>,
  ): Promise<Credential> => {
    const work = (pending.get(providerId) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(operation);
    pending.set(providerId, work);
    const release = () => {
      if (pending.get(providerId) === work) pending.delete(providerId);
    };
    void work.then(release, release);
    return work;
  };
  return {
    async read(providerId) {
      signal.throwIfAborted();
      return cloneCredential(entries.get(providerId));
    },
    async list() {
      signal.throwIfAborted();
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, update) {
      return await enqueue(providerId, async () => {
        signal.throwIfAborted();
        const current = entries.get(providerId);
        const next = await update(cloneCredential(current));
        signal.throwIfAborted();
        if (next !== undefined) entries.set(providerId, cloneCredential(next)!);
        return cloneCredential(entries.get(providerId));
      });
    },
    async delete(providerId) {
      await enqueue(providerId, async () => {
        signal.throwIfAborted();
        entries.delete(providerId);
        return undefined;
      });
    },
  };
}

function parseCredentialEntries(source: unknown): Map<string, StoredCredential> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Could not load Pi credentials for isolated agents");
  }
  const entries = new Map<string, StoredCredential>();
  for (const [providerId, value] of Object.entries(source)) {
    if (!isStoredCredential(value)) {
      throw new Error("Could not load Pi credentials for isolated agents");
    }
    entries.set(providerId, cloneCredential(value)!);
  }
  return entries;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    return credential.key === undefined || typeof credential.key === "string";
  }
  return (
    credential.type === "oauth" &&
    typeof credential.refresh === "string" &&
    typeof credential.access === "string" &&
    typeof credential.expires === "number"
  );
}

function cloneCredential(value: StoredCredential | undefined): Credential {
  return value === undefined ? undefined : structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createEphemeralModelStore(): ModelStore {
  const entries = new Map<string, ModelStoreEntry>();
  return {
    async read(providerId) {
      return entries.get(providerId);
    },
    async write(providerId, entry) {
      entries.set(providerId, entry);
    },
    async delete(providerId) {
      entries.delete(providerId);
    },
  };
}

type RunOneOptions = PiAgentGroupOptions & {
  signal: AbortSignal;
  sessionFactory: PiAgentSessionFactory;
  modelRuntime?: ModelRuntime;
};

async function runOneAgent(
  request: PiAgentRequest,
  options: RunOneOptions,
): Promise<PiAgentResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lifecycle = lifecyclePublisher(request, startedAt, options);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let session: PiAgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let finalMessage: Record<string, unknown> | undefined;
  let preflightAccepted: boolean | undefined;
  let abortKind: "timeout" | "cancelled" | undefined;
  let abortFailure: unknown;
  let abortWork = Promise.resolve();
  let result: PiAgentResult | undefined;
  let failure: unknown;

  const abortSession = (kind: "timeout" | "cancelled") => {
    abortKind ??= kind;
    if (session !== undefined) {
      abortWork = abortWork
        .then(async () => await session?.abort())
        .catch((error) => {
          abortFailure = error;
        });
    }
  };
  const onAbort = () => abortSession("cancelled");
  const timeout = setTimeout(() => abortSession("timeout"), timeoutMs);
  options.signal.addEventListener("abort", onAbort, { once: true });

  lifecycle.emit("running", "starting");
  try {
    if (options.signal.aborted) throw cancellationError(request.id, options.signal.reason);
    session = await options.sessionFactory(request, {
      ...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime } : {}),
      signal: options.signal,
    });
    const model = modelName(session.model);
    lifecycle.setDispatch(model, session.thinkingLevel);
    lifecycle.emit("running", "starting", true);
    unsubscribe = session.subscribe((event) => {
      const phase = eventPhase(event, request.tools);
      if (phase !== undefined) lifecycle.emit("running", phase);
      const message = assistantMessage(event);
      if (message !== undefined) finalMessage = message;
    });
    if (abortKind !== undefined || options.signal.aborted) {
      abortSession(abortKind ?? "cancelled");
      await abortWork;
      if (abortKind === "timeout") {
        throw new PiAgentGroupError(
          request.id,
          "timed out",
          `after ${timeoutMs}ms${abortSuffix(abortFailure)}`,
        );
      }
      throw new PiAgentGroupError(
        request.id,
        "cancelled",
        `${cancellationReason(options.signal.reason)}${abortSuffix(abortFailure)}`,
      );
    }

    await session.prompt(request.prompt, {
      preflightResult: (accepted) => {
        preflightAccepted = accepted;
      },
    });
    await abortWork;
    if (abortKind === "timeout") {
      throw new PiAgentGroupError(
        request.id,
        "timed out",
        `after ${timeoutMs}ms${abortSuffix(abortFailure)}`,
      );
    }
    if (abortKind === "cancelled" || options.signal.aborted) {
      throw new PiAgentGroupError(
        request.id,
        "cancelled",
        `${cancellationReason(options.signal.reason)}${abortSuffix(abortFailure)}`,
      );
    }
    if (preflightAccepted === false) {
      throw new PiAgentGroupError(request.id, "rejected prompt", "prompt preflight failed");
    }
    lifecycle.emit("running", "finalizing", true);
    const text = finalAssistantText(request.id, finalMessage, options.maxFinalChars!);
    result = {
      id: request.id,
      text,
      model,
      thinkingLevel: session.thinkingLevel,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    failure = normalizeAgentError(request.id, error, abortKind, options.signal);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (session !== undefined && abortKind !== undefined) await abortWork;
    try {
      session?.dispose();
    } catch (error) {
      failure ??= new PiAgentGroupError(request.id, "cleanup failed", errorMessage(error));
    }
    const state = terminalState(failure);
    lifecycle.emit(state, state, true);
    await lifecycle.flush();
  }
  if (failure !== undefined) throw failure;
  return result!;
}

function lifecyclePublisher(
  request: PiAgentRequest,
  startedAt: number,
  options: RunOneOptions,
): {
  emit(state: PiAgentLifecycleState, phase: string, force?: boolean): void;
  setDispatch(model: string, thinkingLevel: PiAgentThinkingLevel): void;
  flush(): Promise<void>;
} {
  const now = options.now ?? Date.now;
  let model: string | undefined;
  let thinkingLevel: PiAgentThinkingLevel | undefined;
  let previous = "";
  let previousAt = -Infinity;
  let phaseUpdates = 0;
  let work = Promise.resolve();
  const emit = (state: PiAgentLifecycleState, phase: string, force = false) => {
    const at = now();
    const key = `${state}:${phase}:${model ?? ""}`;
    if (!force && (key === previous || at - previousAt < MIN_PHASE_INTERVAL_MS)) return;
    if (!force && phaseUpdates >= MAX_PHASE_UPDATES) return;
    previous = key;
    previousAt = at;
    phaseUpdates += 1;
    if (options.onLifecycle === undefined) return;
    const event: PiAgentLifecycleEvent = {
      id: request.id,
      role: request.role,
      state,
      phase,
      elapsedMs: Math.max(0, at - startedAt),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    };
    work = work.then(async () => await options.onLifecycle?.(event)).catch(() => undefined);
  };
  return {
    emit,
    setDispatch(value, thinking) {
      model = value;
      thinkingLevel = thinking;
    },
    async flush() {
      await work;
    },
  };
}

async function createSdkSession(
  request: PiAgentRequest,
  context: { modelRuntime?: ModelRuntime; signal: AbortSignal },
): Promise<PiAgentSession> {
  if (context.signal.aborted) throw cancellationError(request.id, context.signal.reason);
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const modelRuntime = context.modelRuntime ?? (await ModelRuntime.create());
  if (context.signal.aborted) throw cancellationError(request.id, context.signal.reason);
  const model = resolveRequestedModel(request, modelRuntime);
  const { session } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.cwd),
    tools: request.tools,
    ...(model !== undefined ? { model } : {}),
    ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
  });
  const activeTools = session.getActiveToolNames().toSorted();
  const requestedTools = request.tools.toSorted();
  if (activeTools.join("\0") !== requestedTools.join("\0")) {
    session.dispose();
    throw new PiAgentGroupError(
      request.id,
      "has unexpected tools",
      activeTools.length === 0 ? "no tools are active" : activeTools.join(", "),
    );
  }
  return {
    prompt: async (text, promptOptions) => await session.prompt(text, promptOptions),
    subscribe: (listener) =>
      session.subscribe((event) => listener(event as unknown as PiAgentEvent)),
    abort: async () => await session.abort(),
    dispose: () => session.dispose(),
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
  };
}

function resolveRequestedModel(request: PiAgentRequest, runtime: ModelRuntime) {
  if (request.model === undefined) return undefined;
  const model = runtime.getModel(request.model.provider, request.model.id);
  if (model === undefined) {
    throw new PiAgentGroupError(
      request.id,
      "has no model",
      `${request.model.provider}/${request.model.id}`,
    );
  }
  return model;
}

function validateGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): { requests: PiAgentRequest[]; maxFinalChars: number } {
  if (!Array.isArray(input) || input.length > MAX_AGENTS) {
    throw new Error(`Pi agent group must contain at most ${MAX_AGENTS} requests`);
  }
  positiveInteger(options.maxConcurrency, "Pi agent maxConcurrency", MAX_CONCURRENCY);
  const maxFinalChars = options.maxFinalChars ?? DEFAULT_FINAL_CHARS;
  positiveInteger(maxFinalChars, "Pi agent maxFinalChars", MAX_FINAL_CHARS);
  const ids = new Set<string>();
  const requests = input.map((request) => {
    validateRequest(request);
    if (ids.has(request.id)) throw new Error(`Duplicate Pi agent id: ${request.id}`);
    ids.add(request.id);
    return request;
  });
  return { requests, maxFinalChars };
}

function validateRequest(request: PiAgentRequest): void {
  if (!REQUEST_ID.test(request.id)) throw new Error(`Invalid Pi agent id: ${request.id}`);
  operationalText(request.role, "Pi agent role", 200);
  nonEmpty(request.prompt, "Pi agent prompt", MAX_PROMPT_CHARS);
  nonEmpty(request.cwd, "Pi agent cwd", 4_000);
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    throw new Error(`Pi agent ${request.id} requires at least one tool`);
  }
  const tools = new Set<PiAgentTool>();
  for (const tool of request.tools) {
    if (!["read", "grep", "find", "ls"].includes(tool)) {
      throw new Error(`Pi agent ${request.id} has unsupported tool: ${String(tool)}`);
    }
    if (tools.has(tool)) throw new Error(`Pi agent ${request.id} has duplicate tool: ${tool}`);
    tools.add(tool);
  }
  positiveInteger(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `Pi agent ${request.id} timeoutMs`,
    MAX_TIMEOUT_MS,
  );
  if (request.model !== undefined) {
    operationalText(request.model.provider, `Pi agent ${request.id} model provider`, 200);
    operationalText(request.model.id, `Pi agent ${request.id} model id`, 500);
  }
}

function eventPhase(event: PiAgentEvent, tools: PiAgentTool[]): string | undefined {
  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    return event.assistantMessageEvent.type === "thinking_delta" ? "thinking" : undefined;
  }
  if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") return undefined;
  return tools.includes(event.toolName as PiAgentTool) ? `tool: ${event.toolName}` : undefined;
}

function assistantMessage(event: PiAgentEvent): Record<string, unknown> | undefined {
  if (event.type !== "message_end" || !isRecord(event.message)) return undefined;
  return event.message.role === "assistant" ? event.message : undefined;
}

function finalAssistantText(
  id: string,
  message: Record<string, unknown> | undefined,
  maxChars: number,
): string {
  if (message === undefined)
    throw new PiAgentGroupError(id, "returned no final output", "missing assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new PiAgentGroupError(
      id,
      `stopped with ${String(message.stopReason)}`,
      typeof message.errorMessage === "string" ? message.errorMessage : "provider stopped",
    );
  }
  const text = messageText(message.content).trim();
  if (!text) throw new PiAgentGroupError(id, "returned no final output", "assistant text is empty");
  if (text.length > maxChars) {
    throw new PiAgentGroupError(id, "final output is too large", `${text.length} characters`);
  }
  return text;
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

async function publishQueuedCancellations(
  requests: PiAgentRequest[],
  started: Set<number>,
  options: PiAgentGroupOptions,
): Promise<void> {
  if (options.onLifecycle === undefined) return;
  await Promise.all(
    requests.map(async (request, index) => {
      if (started.has(index)) return;
      await options.onLifecycle?.({
        id: request.id,
        role: request.role,
        state: "cancelled",
        phase: "cancelled",
        elapsedMs: 0,
      });
    }),
  ).catch(() => undefined);
}

function normalizeAgentError(
  id: string,
  error: unknown,
  abortKind: "timeout" | "cancelled" | undefined,
  signal: AbortSignal,
): unknown {
  if (error instanceof PiAgentGroupError) return error;
  if (abortKind === "timeout") return new PiAgentGroupError(id, "timed out", errorMessage(error));
  if (abortKind === "cancelled" || signal.aborted) return cancellationError(id, signal.reason);
  return new PiAgentGroupError(id, "failed", errorMessage(error));
}

function terminalState(error: unknown): PiAgentLifecycleState {
  if (error === undefined) return "completed";
  return error instanceof PiAgentGroupError && error.code === "cancelled" ? "cancelled" : "failed";
}

function cancellationError(id: string, reason: unknown): PiAgentGroupError {
  return new PiAgentGroupError(id, "cancelled", cancellationReason(reason));
}

function cancellationReason(reason: unknown): string {
  return reason === undefined ? "operation cancelled" : errorMessage(reason);
}

function abortSuffix(error: unknown): string {
  return error === undefined ? "" : `; abort failed: ${bounded(errorMessage(error))}`;
}

function modelName(model: { provider: string; id: string } | undefined): string {
  if (model === undefined) throw new Error("No usable Pi model is configured");
  const value = `${model.provider}/${model.id}`;
  operationalText(value, "Pi model identity", 700);
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${label} must be an integer from 1 through ${max}`);
  }
}

function operationalText(value: unknown, label: string, max: number): asserts value is string {
  nonEmpty(value, label, max);
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`${label} must not contain control characters`);
  }
}

function nonEmpty(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string with at most ${max} characters`);
  }
}

function bounded(value: string): string {
  const text = value.trim() || "unknown failure";
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
