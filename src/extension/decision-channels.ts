import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { HumanDecisionStore, createHumanDecisionAttemptId } from "../workflows/human-decision.js";
import type {
  AcceptedHumanDecision,
  HumanDecisionAnswerSource,
  HumanDecisionCancellationRecord,
  HumanDecisionDeliveryRecord,
  HumanDecisionRequest,
  HumanDecisionResponse,
  HumanDecisionSettlementRecord,
} from "../workflows/types.js";

const TELEGRAM_TEXT_LIMIT = 4_096;
const DEFAULT_API_BASE = "https://api.telegram.org";
const LEASE_TTL_MS = 60_000;
const LEASE_RETRY_MS = 5_000;
const POLL_BACKOFF_MS = 1_000;
const NUMERIC_ID = /^-?[0-9]+$/;
const SIMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type HumanDecisionChannelAnswer = {
  request: HumanDecisionRequest;
  response: HumanDecisionResponse;
  source: HumanDecisionAnswerSource;
  idempotencyKey: string;
};

export type HumanDecisionDeliveryResult = {
  status: "confirmed" | "failed" | "unknown";
  channel: string;
  attemptId: string;
  errorCode?: string;
};

export type SettledHumanDecision = AcceptedHumanDecision | HumanDecisionCancellationRecord;

export interface HumanDecisionChannel {
  readonly id: string;
  start(): Promise<void>;
  deliver(request: HumanDecisionRequest): Promise<HumanDecisionDeliveryResult>;
  settle(decision: SettledHumanDecision): Promise<void>;
  stop(): Promise<void>;
}

export type DecisionChannelConfig = {
  schema: "pi-workflows.channels.v1";
  audiences: Record<string, { channels: string[]; accept: "first-valid-answer" }>;
  telegramProfiles?: Record<
    string,
    {
      credential: string;
      allowedUserIds: string[];
      allowedChatIds: string[];
    }
  >;
};

export type DecisionCredentialConfig = {
  schema: "pi-workflows.credentials.v1";
  telegram: Record<string, { tokenFile: string }>;
};

type ResolvedDecisionCredentials = Record<string, string>;

export type LoadedDecisionChannelConfig = {
  channels: DecisionChannelConfig;
  credentials: ResolvedDecisionCredentials;
  configDir: string;
};

export type TelegramFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PiDecisionUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, initial?: string): Promise<string | undefined>;
};

export function decisionConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_WORKFLOWS_CONFIG_DIR ?? path.join(os.homedir(), ".config", "pi-workflows");
}

export async function loadDecisionChannelConfig(
  configDir = decisionConfigDir(),
): Promise<LoadedDecisionChannelConfig | null> {
  const channelPath = path.join(configDir, "channels.json");
  let channelsRaw: unknown;
  try {
    channelsRaw = JSON.parse(await fsp.readFile(channelPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await requirePrivateFile(channelPath, "Pi Workflows channel profile");
  const channels = parseChannelConfig(channelsRaw);
  const profileNames = Object.keys(channels.telegramProfiles ?? {});
  if (profileNames.length === 0) return { channels, credentials: {}, configDir };

  const credentialPath = path.join(configDir, "credentials.json");
  await requirePrivateFile(credentialPath, "Pi Workflows credential profile");
  const credentialConfig = parseCredentialConfig(
    JSON.parse(await fsp.readFile(credentialPath, "utf8")),
  );
  const credentials: ResolvedDecisionCredentials = {};
  for (const [name, credential] of Object.entries(credentialConfig.telegram)) {
    if (!path.isAbsolute(credential.tokenFile)) {
      throw new Error(`Telegram credential ${name} tokenFile must be absolute`);
    }
    await requirePrivateFile(credential.tokenFile, `Telegram credential ${name} token file`);
    const token = (await fsp.readFile(credential.tokenFile, "utf8")).trim();
    if (token.length === 0) throw new Error(`Telegram credential ${name} token file is empty`);
    credentials[name] = token;
  }
  return { channels, credentials, configDir };
}

export function audienceChannels(config: DecisionChannelConfig | null, audience: string): string[] {
  const configured = config?.audiences[audience]?.channels;
  return configured === undefined ? ["pi"] : [...configured];
}

export class PiDecisionChannel implements HumanDecisionChannel {
  readonly id = "pi";

  constructor(
    private readonly options: {
      actorId: string;
      ui: PiDecisionUi;
      store: HumanDecisionStore;
      onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async deliver(request: HumanDecisionRequest): Promise<HumanDecisionDeliveryResult> {
    const attemptId = createHumanDecisionAttemptId();
    const createdAt = new Date().toISOString();
    await this.options.store.recordDelivery(request, this.id, {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      channel: this.id,
      state: "intent",
      createdAt,
    });
    const entries = Object.entries(request.choices);
    const selectedLabel = await this.options.ui.select(
      request.title,
      entries.map(([, definition]) => definition.label),
    );
    if (selectedLabel === undefined) {
      const record = deliveryRecord(
        request,
        this.id,
        `${attemptId}-cancelled`,
        "failed",
        createdAt,
        {
          errorCode: "pi_selection_cancelled",
        },
      );
      await this.options.store.recordDelivery(request, this.id, record);
      return {
        status: "failed",
        channel: this.id,
        attemptId,
        errorCode: "pi_selection_cancelled",
      };
    }
    const selected = entries.find(([, definition]) => definition.label === selectedLabel);
    if (selected === undefined) throw new Error("Pi decision selection is not in the request");
    const [choiceId, definition] = selected;
    let response: HumanDecisionResponse = { choice: choiceId };
    if (definition.input !== undefined) {
      const text = await this.options.ui.input(definition.input.prompt, "");
      if (text === undefined) {
        const record = deliveryRecord(
          request,
          this.id,
          `${attemptId}-cancelled`,
          "failed",
          createdAt,
          {
            errorCode: "pi_input_cancelled",
          },
        );
        await this.options.store.recordDelivery(request, this.id, record);
        return {
          status: "failed",
          channel: this.id,
          attemptId,
          errorCode: "pi_input_cancelled",
        };
      }
      response = { choice: choiceId, input: { [definition.input.name]: text } };
    }
    const eventId = createHumanDecisionAttemptId();
    await this.options.onAnswer({
      request,
      response,
      source: { channel: this.id, actorId: this.options.actorId, eventId },
      idempotencyKey: `${this.id}:${eventId}`,
    });
    await this.options.store.recordDelivery(
      request,
      this.id,
      deliveryRecord(request, this.id, `${attemptId}-confirmed`, "confirmed", createdAt),
    );
    return { status: "confirmed", channel: this.id, attemptId };
  }

  async settle(decision: SettledHumanDecision): Promise<void> {
    const createdAt = new Date().toISOString();
    const record: HumanDecisionSettlementRecord = {
      schema: "pi-workflows.human-decision-settlement.v1",
      attemptId: createHumanDecisionAttemptId(),
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      channel: this.id,
      state: "confirmed",
      createdAt,
      finishedAt: createdAt,
    };
    await this.options.store.recordSettlement(decision.decisionId, this.id, record);
  }
}

type TelegramProfile = {
  name: string;
  token: string;
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
};

type CallbackBinding = {
  request: HumanDecisionRequest;
  choice: string;
};

type ReplyBinding = CallbackBinding & {
  chatId: string;
  promptMessageId: string;
};

type CallbackRow = { request_json: string; choice_id: string };
type ReplyRow = { request_json: string; choice_id: string; chat_id: string; message_id: string };
type MessageRow = { chat_id: string; message_id: string };
type OffsetRow = { next_offset: number };

class TelegramProjection {
  private readonly db: Database.Database;

  constructor(
    filePath: string,
    private readonly profile: string,
    private readonly owner: string,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new Database(filePath);
    fs.chmodSync(filePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        profile TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offsets (
        profile TEXT PRIMARY KEY,
        next_offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS callbacks (
        profile TEXT NOT NULL,
        token TEXT NOT NULL,
        request_json TEXT NOT NULL,
        choice_id TEXT NOT NULL,
        PRIMARY KEY (profile, token)
      );
      CREATE TABLE IF NOT EXISTS replies (
        profile TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        choice_id TEXT NOT NULL,
        PRIMARY KEY (profile, chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        profile TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (profile, decision_id, chat_id, message_id)
      );
    `);
  }

  close(): void {
    this.release();
    this.db.close();
  }

  acquire(now = Date.now()): boolean {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT owner, expires_at FROM leases WHERE profile = ?")
        .get(this.profile) as { owner: string; expires_at: number } | undefined;
      if (row !== undefined && row.owner !== this.owner && row.expires_at > now) return false;
      this.db
        .prepare(
          "INSERT INTO leases(profile, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(profile) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
        )
        .run(this.profile, this.owner, now + LEASE_TTL_MS);
      return true;
    });
    return transaction();
  }

  renew(now = Date.now()): boolean {
    return (
      this.db
        .prepare("UPDATE leases SET expires_at = ? WHERE profile = ? AND owner = ?")
        .run(now + LEASE_TTL_MS, this.profile, this.owner).changes === 1
    );
  }

  release(): void {
    this.db
      .prepare("DELETE FROM leases WHERE profile = ? AND owner = ?")
      .run(this.profile, this.owner);
  }

  offset(): number {
    return (
      (
        this.db.prepare("SELECT next_offset FROM offsets WHERE profile = ?").get(this.profile) as
          | OffsetRow
          | undefined
      )?.next_offset ?? 0
    );
  }

  setOffset(offset: number): void {
    this.db
      .prepare(
        "INSERT INTO offsets(profile, next_offset) VALUES (?, ?) ON CONFLICT(profile) DO UPDATE SET next_offset = MAX(next_offset, excluded.next_offset)",
      )
      .run(this.profile, offset);
  }

  putCallback(token: string, binding: CallbackBinding): void {
    this.db
      .prepare(
        "INSERT INTO callbacks(profile, token, request_json, choice_id) VALUES (?, ?, ?, ?) ON CONFLICT(profile, token) DO UPDATE SET request_json = excluded.request_json, choice_id = excluded.choice_id",
      )
      .run(this.profile, token, JSON.stringify(binding.request), binding.choice);
  }

  callback(token: string): CallbackBinding | undefined {
    const row = this.db
      .prepare("SELECT request_json, choice_id FROM callbacks WHERE profile = ? AND token = ?")
      .get(this.profile, token) as CallbackRow | undefined;
    return row === undefined
      ? undefined
      : { request: JSON.parse(row.request_json) as HumanDecisionRequest, choice: row.choice_id };
  }

  putReply(binding: ReplyBinding): void {
    this.db
      .prepare(
        "INSERT INTO replies(profile, chat_id, message_id, request_json, choice_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile, chat_id, message_id) DO UPDATE SET request_json = excluded.request_json, choice_id = excluded.choice_id",
      )
      .run(
        this.profile,
        binding.chatId,
        binding.promptMessageId,
        JSON.stringify(binding.request),
        binding.choice,
      );
  }

  reply(chatId: string, messageId: string): ReplyBinding | undefined {
    const row = this.db
      .prepare(
        "SELECT request_json, choice_id, chat_id, message_id FROM replies WHERE profile = ? AND chat_id = ? AND message_id = ?",
      )
      .get(this.profile, chatId, messageId) as ReplyRow | undefined;
    return row === undefined
      ? undefined
      : {
          request: JSON.parse(row.request_json) as HumanDecisionRequest,
          choice: row.choice_id,
          chatId: row.chat_id,
          promptMessageId: row.message_id,
        };
  }

  deleteReply(chatId: string, messageId: string): void {
    this.db
      .prepare("DELETE FROM replies WHERE profile = ? AND chat_id = ? AND message_id = ?")
      .run(this.profile, chatId, messageId);
  }

  putMessage(decisionId: string, chatId: string, messageId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO messages(profile, decision_id, chat_id, message_id) VALUES (?, ?, ?, ?)",
      )
      .run(this.profile, decisionId, chatId, messageId);
  }

  messages(decisionId: string): MessageRow[] {
    return this.db
      .prepare(
        "SELECT chat_id, message_id FROM messages WHERE profile = ? AND decision_id = ? ORDER BY chat_id, message_id",
      )
      .all(this.profile, decisionId) as MessageRow[];
  }
}

class TelegramCallError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

export class TelegramDecisionChannel implements HumanDecisionChannel {
  readonly id: string;
  private readonly profile: TelegramProfile;
  private readonly store: HumanDecisionStore;
  private readonly fetchFn: TelegramFetch;
  private readonly apiBase: string;
  private readonly onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
  private readonly projection: TelegramProjection;
  private running = false;
  private pollAbort: AbortController | null = null;
  private pollTask: Promise<void> | null = null;

  constructor(options: {
    profileName: string;
    token: string;
    allowedUserIds: string[];
    allowedChatIds: string[];
    store: HumanDecisionStore;
    configDir?: string;
    onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
    fetchFn?: TelegramFetch;
    apiBase?: string;
    ownerId?: string;
  }) {
    requireSimpleId(options.profileName, "Telegram profile");
    if (options.token.trim().length === 0) throw new Error("Telegram token must not be empty");
    validateNumericIds(options.allowedUserIds, "Telegram allowed user IDs");
    validateNumericIds(options.allowedChatIds, "Telegram allowed chat IDs");
    this.id = `telegram:${options.profileName}`;
    this.profile = {
      name: options.profileName,
      token: options.token,
      allowedUserIds: new Set(options.allowedUserIds),
      allowedChatIds: new Set(options.allowedChatIds),
    };
    this.store = options.store;
    this.onAnswer = options.onAnswer;
    this.fetchFn = options.fetchFn ?? (fetch as TelegramFetch);
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.projection = new TelegramProjection(
      path.join(options.configDir ?? decisionConfigDir(), "telegram-state.sqlite"),
      options.profileName,
      options.ownerId ?? randomUUID(),
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.pollAbort = new AbortController();
    this.pollTask = this.poll(this.pollAbort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    await this.pollTask?.catch(() => undefined);
    this.pollAbort = null;
    this.pollTask = null;
    this.projection.close();
  }

  async deliver(request: HumanDecisionRequest): Promise<HumanDecisionDeliveryResult> {
    const channelPath = this.channelPath();
    const prior = await this.store.listDeliveries(request.decisionId, channelPath);
    if (prior.some((record) => record.state === "confirmed")) {
      this.registerCallbacks(request);
      return { status: "confirmed", channel: this.id, attemptId: "adopted" };
    }
    if (prior.some((record) => record.state === "unknown")) {
      this.registerCallbacks(request);
      return {
        status: "unknown",
        channel: this.id,
        attemptId: "adopted",
        errorCode: "ambiguous_delivery_not_retried",
      };
    }
    if (
      prior.some((record) => record.state === "intent") &&
      !prior.some((record) => record.state === "failed")
    ) {
      this.registerCallbacks(request);
      return {
        status: "unknown",
        channel: this.id,
        attemptId: "adopted",
        errorCode: "unsettled_delivery_intent_not_retried",
      };
    }

    const attemptId = createHumanDecisionAttemptId();
    const createdAt = new Date().toISOString();
    await this.store.recordDelivery(request, channelPath, {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      channel: this.id,
      state: "intent",
      createdAt,
    });
    const keyboard = this.registerCallbacks(request);
    try {
      const deliveredChats = new Set(
        this.projection.messages(request.decisionId).map((message) => message.chat_id),
      );
      let messageCount = deliveredChats.size;
      for (const chatId of this.profile.allowedChatIds) {
        if (deliveredChats.has(chatId)) continue;
        const result = await this.call("sendMessage", {
          chat_id: chatId,
          text: renderTelegramRequest(request),
          reply_markup: { inline_keyboard: keyboard },
        });
        const messageId = telegramMessageId(result);
        this.projection.putMessage(request.decisionId, chatId, messageId);
        messageCount += 1;
      }
      await this.store.recordDelivery(
        request,
        channelPath,
        deliveryRecord(request, this.id, `${attemptId}-confirmed`, "confirmed", createdAt, {
          messageCount,
        }),
      );
      return { status: "confirmed", channel: this.id, attemptId };
    } catch (error) {
      const callError = normalizeCallError(error);
      const state = callError.ambiguous ? "unknown" : "failed";
      await this.store.recordDelivery(
        request,
        channelPath,
        deliveryRecord(request, this.id, `${attemptId}-${state}`, state, createdAt, {
          errorCode: callError.code,
        }),
      );
      return { status: state, channel: this.id, attemptId, errorCode: callError.code };
    }
  }

  async settle(decision: SettledHumanDecision): Promise<void> {
    const attemptId = createHumanDecisionAttemptId();
    const createdAt = new Date().toISOString();
    let failed = false;
    for (const message of this.projection.messages(decision.decisionId)) {
      try {
        await this.call("editMessageReplyMarkup", {
          chat_id: message.chat_id,
          message_id: Number(message.message_id),
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        failed = true;
      }
    }
    const record: HumanDecisionSettlementRecord = {
      schema: "pi-workflows.human-decision-settlement.v1",
      attemptId,
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      channel: this.id,
      state: failed ? "failed" : "confirmed",
      createdAt,
      finishedAt: new Date().toISOString(),
      ...(failed ? { errorCode: "telegram_settlement_failed" } : {}),
    };
    await this.store.recordSettlement(decision.decisionId, this.channelPath(), record);
  }

  async handleUpdate(value: unknown): Promise<void> {
    const update = record(value, "Telegram update");
    const updateId = String(update.update_id ?? "");
    const callback = asRecord(update.callback_query);
    if (callback !== null) {
      const actorId = String(asRecord(callback.from)?.id ?? "");
      const message = asRecord(callback.message);
      const chatId = String(asRecord(message?.chat)?.id ?? "");
      if (!this.allowed(actorId, chatId)) return;
      const binding = this.projection.callback(String(callback.data ?? ""));
      if (binding === undefined || this.isStale(binding.request)) return;
      const definition = binding.request.choices[binding.choice];
      if (definition === undefined) return;
      if (definition.input === undefined) {
        await this.onAnswer({
          request: binding.request,
          response: { choice: binding.choice },
          source: { channel: this.id, actorId, eventId: String(callback.id ?? updateId) },
          idempotencyKey: `${this.id}:${String(callback.id ?? updateId)}`,
        });
      } else {
        const prompt = await this.call("sendMessage", {
          chat_id: chatId,
          text: definition.input.prompt,
          reply_markup: { force_reply: true, selective: true },
        });
        this.projection.putReply({
          ...binding,
          chatId,
          promptMessageId: telegramMessageId(prompt),
        });
      }
      await this.call("answerCallbackQuery", { callback_query_id: callback.id }).catch(
        () => undefined,
      );
      return;
    }

    const message = asRecord(update.message);
    if (message === null) return;
    const actorId = String(asRecord(message.from)?.id ?? "");
    const chatId = String(asRecord(message.chat)?.id ?? "");
    if (!this.allowed(actorId, chatId)) return;
    const replyTo = asRecord(message.reply_to_message);
    const replyId = String(replyTo?.message_id ?? "");
    const binding = this.projection.reply(chatId, replyId);
    if (binding === undefined || this.isStale(binding.request)) return;
    const definition = binding.request.choices[binding.choice];
    const text = message.text;
    if (definition?.input === undefined || typeof text !== "string") return;
    await this.onAnswer({
      request: binding.request,
      response: { choice: binding.choice, input: { [definition.input.name]: text } },
      source: { channel: this.id, actorId, eventId: String(message.message_id ?? updateId) },
      idempotencyKey: `${this.id}:${String(message.message_id ?? updateId)}`,
    });
    this.projection.deleteReply(chatId, replyId);
  }

  private registerCallbacks(request: HumanDecisionRequest): Array<Array<Record<string, string>>> {
    return Object.entries(request.choices).map(([choiceId, definition]) => {
      const token = callbackToken(request.decisionId, request.requestDigest, choiceId);
      this.projection.putCallback(token, { request, choice: choiceId });
      return [{ text: definition.label, callback_data: token }];
    });
  }

  private channelPath(): string {
    return this.id.replace(":", "-");
  }

  private allowed(userId: string, chatId: string): boolean {
    return this.profile.allowedUserIds.has(userId) && this.profile.allowedChatIds.has(chatId);
  }

  private isStale(request: HumanDecisionRequest): boolean {
    return request.expiresAt !== undefined && Date.parse(request.expiresAt) <= Date.now();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      if (!this.projection.acquire()) {
        await wait(LEASE_RETRY_MS, signal);
        continue;
      }
      try {
        const result = await this.call(
          "getUpdates",
          {
            offset: this.projection.offset(),
            timeout: 20,
            allowed_updates: ["callback_query", "message"],
          },
          signal,
        );
        const updates = Array.isArray(result) ? result : [];
        for (const update of updates) {
          await this.handleUpdate(update);
          const id = Number(asRecord(update)?.update_id);
          if (Number.isSafeInteger(id)) this.projection.setOffset(id + 1);
        }
        if (!this.projection.renew()) this.projection.release();
      } catch {
        if (signal.aborted) return;
        await wait(POLL_BACKOFF_MS, signal);
      }
    }
  }

  private async call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Awaited<ReturnType<TelegramFetch>>;
    try {
      response = await this.fetchFn(
        `${this.apiBase}/bot${encodeURIComponent(this.profile.token)}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    } catch {
      throw new TelegramCallError(
        `Telegram ${method} request did not return a response`,
        true,
        "telegram_response_unknown",
      );
    }
    if (!response.ok) {
      throw new TelegramCallError(
        `Telegram ${method} failed with HTTP ${response.status}`,
        false,
        `telegram_http_${response.status}`,
      );
    }
    const body = record(await response.json(), `Telegram ${method} response`);
    if (body.ok !== true) {
      throw new TelegramCallError(
        `Telegram ${method} rejected the request`,
        false,
        "telegram_rejected",
      );
    }
    return body.result;
  }
}

export function createTelegramChannels(options: {
  config: DecisionChannelConfig;
  credentials: ResolvedDecisionCredentials;
  store: HumanDecisionStore;
  configDir?: string;
  onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
  fetchFn?: TelegramFetch;
  apiBase?: string;
}): Map<string, TelegramDecisionChannel> {
  const channels = new Map<string, TelegramDecisionChannel>();
  for (const [name, profile] of Object.entries(options.config.telegramProfiles ?? {})) {
    const token = options.credentials[profile.credential];
    if (token === undefined) {
      throw new Error(`Telegram profile ${name} references a missing credential`);
    }
    const channel = new TelegramDecisionChannel({
      profileName: name,
      token,
      allowedUserIds: profile.allowedUserIds,
      allowedChatIds: profile.allowedChatIds,
      store: options.store,
      onAnswer: options.onAnswer,
      ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : {}),
    });
    channels.set(channel.id, channel);
  }
  return channels;
}

export async function verifyTelegramTokenFile(
  tokenFile: string,
  fetchFn: TelegramFetch = fetch as TelegramFetch,
  apiBase = DEFAULT_API_BASE,
): Promise<void> {
  if (!path.isAbsolute(tokenFile)) throw new Error("Telegram token file path must be absolute");
  await requirePrivateFile(tokenFile, "Telegram token file");
  const token = (await fsp.readFile(tokenFile, "utf8")).trim();
  if (token.length === 0) throw new Error("Telegram token file is empty");
  let response;
  try {
    response = await fetchFn(`${apiBase}/bot${encodeURIComponent(token)}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new Error("Telegram credential verification did not return a response");
  }
  if (!response.ok)
    throw new Error(`Telegram credential verification failed with HTTP ${response.status}`);
  const body = record(await response.json(), "Telegram credential verification response");
  if (body.ok !== true) throw new Error("Telegram credential verification was rejected");
}

export async function writeDecisionChannelProfile(options: {
  configDir?: string;
  audience: string;
  profile: string;
  credential: string;
  tokenFile: string;
  allowedUserIds: string[];
  allowedChatIds: string[];
}): Promise<void> {
  const configDir = options.configDir ?? decisionConfigDir();
  requireSimpleId(options.audience, "Decision audience");
  requireSimpleId(options.profile, "Telegram profile");
  requireSimpleId(options.credential, "Telegram credential");
  validateNumericIds(options.allowedUserIds, "Telegram allowed user IDs");
  validateNumericIds(options.allowedChatIds, "Telegram allowed chat IDs");
  if (!path.isAbsolute(options.tokenFile)) {
    throw new Error("Telegram token file path must be absolute");
  }
  await requirePrivateFile(options.tokenFile, "Telegram token file");
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  const channelPath = path.join(configDir, "channels.json");
  const credentialPath = path.join(configDir, "credentials.json");
  const existingChannels = await readOptionalJson(channelPath);
  const existingCredentials = await readOptionalJson(credentialPath);
  const parsedChannels =
    existingChannels === null
      ? { schema: "pi-workflows.channels.v1" as const, audiences: {} }
      : parseChannelConfig(existingChannels);
  const parsedCredentials =
    existingCredentials === null
      ? { schema: "pi-workflows.credentials.v1" as const, telegram: {} }
      : parseCredentialConfig(existingCredentials);
  const channels: DecisionChannelConfig = {
    schema: "pi-workflows.channels.v1",
    audiences: {
      ...parsedChannels.audiences,
      [options.audience]: {
        channels: ["pi", `telegram:${options.profile}`],
        accept: "first-valid-answer",
      },
    },
    telegramProfiles: {
      ...parsedChannels.telegramProfiles,
      [options.profile]: {
        credential: options.credential,
        allowedUserIds: options.allowedUserIds,
        allowedChatIds: options.allowedChatIds,
      },
    },
  };
  const credentials: DecisionCredentialConfig = {
    schema: "pi-workflows.credentials.v1",
    telegram: {
      ...parsedCredentials.telegram,
      [options.credential]: { tokenFile: options.tokenFile },
    },
  };
  await writePrivateJson(channelPath, channels);
  await writePrivateJson(credentialPath, credentials);
}

function parseChannelConfig(value: unknown): DecisionChannelConfig {
  const config = record(value, "Pi Workflows channel config");
  if (config.schema !== "pi-workflows.channels.v1") {
    throw new Error("Pi Workflows channel config schema is invalid");
  }
  const telegramProfiles: NonNullable<DecisionChannelConfig["telegramProfiles"]> = {};
  if (config.telegramProfiles !== undefined) {
    for (const [name, raw] of Object.entries(
      record(config.telegramProfiles, "Telegram profiles"),
    )) {
      requireSimpleId(name, "Telegram profile");
      const profile = record(raw, `Telegram profile ${name}`);
      const allowedUserIds = stringArray(
        profile.allowedUserIds,
        `Telegram profile ${name} user IDs`,
      );
      const allowedChatIds = stringArray(
        profile.allowedChatIds,
        `Telegram profile ${name} chat IDs`,
      );
      validateNumericIds(allowedUserIds, `Telegram profile ${name} user IDs`);
      validateNumericIds(allowedChatIds, `Telegram profile ${name} chat IDs`);
      telegramProfiles[name] = {
        credential: requireSimpleId(profile.credential, `Telegram profile ${name} credential`),
        allowedUserIds,
        allowedChatIds,
      };
    }
  }
  const audiencesRaw = record(config.audiences, "Pi Workflows audiences");
  const audiences: DecisionChannelConfig["audiences"] = {};
  for (const [name, raw] of Object.entries(audiencesRaw)) {
    requireSimpleId(name, "Decision audience");
    const audience = record(raw, `Audience ${name}`);
    if (audience.accept !== "first-valid-answer") {
      throw new Error(`Audience ${name} accept policy must be first-valid-answer`);
    }
    const channels = stringArray(audience.channels, `Audience ${name} channels`);
    if (channels.length === 0) throw new Error(`Audience ${name} must have at least one channel`);
    for (const channel of channels) {
      if (channel !== "pi") {
        const match = /^telegram:([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/.exec(channel);
        if (match === null || telegramProfiles[match[1]!] === undefined) {
          throw new Error(`Audience ${name} references an unknown channel`);
        }
      }
    }
    audiences[name] = { channels, accept: "first-valid-answer" };
  }
  return {
    schema: "pi-workflows.channels.v1",
    audiences,
    ...(Object.keys(telegramProfiles).length > 0 ? { telegramProfiles } : {}),
  };
}

function parseCredentialConfig(value: unknown): DecisionCredentialConfig {
  const config = record(value, "Pi Workflows credential config");
  if (config.schema !== "pi-workflows.credentials.v1") {
    throw new Error("Pi Workflows credential config schema is invalid");
  }
  const telegram: DecisionCredentialConfig["telegram"] = {};
  for (const [name, raw] of Object.entries(record(config.telegram, "Telegram credentials"))) {
    requireSimpleId(name, "Telegram credential");
    const credential = record(raw, `Telegram credential ${name}`);
    telegram[name] = {
      tokenFile: requireString(credential.tokenFile, `Telegram credential ${name} tokenFile`),
    };
  }
  return { schema: "pi-workflows.credentials.v1", telegram };
}

function deliveryRecord(
  request: HumanDecisionRequest,
  channel: string,
  attemptId: string,
  state: HumanDecisionDeliveryRecord["state"],
  createdAt: string,
  extra: Pick<HumanDecisionDeliveryRecord, "messageCount" | "errorCode"> = {},
): HumanDecisionDeliveryRecord {
  return {
    schema: "pi-workflows.human-decision-delivery.v1",
    attemptId,
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    channel,
    state,
    createdAt,
    finishedAt: new Date().toISOString(),
    ...extra,
  };
}

function renderTelegramRequest(request: HumanDecisionRequest): string {
  const body =
    typeof request.body === "string" ? request.body : JSON.stringify(request.body, null, 2);
  const suffix = "\n\nReply with a button below.";
  const available = Math.max(0, TELEGRAM_TEXT_LIMIT - request.title.length - suffix.length - 2);
  const clipped = body.length <= available ? body : `${body.slice(0, Math.max(0, available - 1))}…`;
  return `${request.title}\n\n${clipped}${suffix}`;
}

function callbackToken(decisionId: string, requestDigest: string, choice: string): string {
  return `piw:${createHash("sha256")
    .update(`${decisionId}\0${requestDigest}\0${choice}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function telegramMessageId(value: unknown): string {
  const message = record(value, "Telegram message");
  const id = message.message_id;
  if (!Number.isSafeInteger(id)) throw new Error("Telegram message id is missing");
  return String(id);
}

function normalizeCallError(error: unknown): TelegramCallError {
  return error instanceof TelegramCallError
    ? error
    : new TelegramCallError("Telegram request failed", true, "telegram_response_unknown");
}

function validateNumericIds(values: string[], label: string): void {
  if (values.length === 0 || values.some((value) => !NUMERIC_ID.test(value))) {
    throw new Error(`${label} must contain numeric IDs`);
  }
}

function requireSimpleId(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!SIMPLE_ID.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function requirePrivateFile(filePath: string, label: string): Promise<void> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label} must be a file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600`);
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filePath);
  await fsp.chmod(filePath, 0o600);
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
