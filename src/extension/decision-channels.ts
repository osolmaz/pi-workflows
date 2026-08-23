import { createHash, randomBytes, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { StateDatabase } from "../state/database.js";
import { resourceIdFor, tokenHash } from "../state/mutation.js";
import {
  MAX_PRESENTATION_TRANSPORT_PARTS,
  decisionDocumentSegments,
  decisionPresentationFingerprint,
  digestCanonical,
} from "../workflows/decision-presentation.js";
import { HumanDecisionStore, createHumanDecisionAttemptId } from "../workflows/human-decision.js";
import type {
  ResolvedHumanDecision,
  HumanDecisionAnswerSource,
  HumanDecisionCancellationRecord,
  HumanDecisionChannelRequest,
  HumanDecisionDeliveryRecord,
  HumanDecisionResponse,
  HumanDecisionSettlementRecord,
} from "../workflows/types.js";

const TELEGRAM_TEXT_LIMIT = 4_096;
const PI_PRESENTATION_WINDOW_LINES = 18;
const DEFAULT_API_BASE = "https://api.telegram.org";
const LEASE_TTL_MS = 60_000;
const LEASE_RETRY_MS = 5_000;
const POLL_BACKOFF_MS = 1_000;
const MAX_SETTLEMENT_ATTEMPTS = 3;
const NUMERIC_ID = /^-?[0-9]+$/;
const SIMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type HumanDecisionChannelAnswer = {
  request: HumanDecisionChannelRequest;
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

export type SettledHumanDecision = ResolvedHumanDecision | HumanDecisionCancellationRecord;

export interface HumanDecisionChannel {
  readonly id: string;
  start(): Promise<void>;
  deliver(request: HumanDecisionChannelRequest): Promise<HumanDecisionDeliveryResult>;
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

export type PiDecisionUi = Pick<ExtensionContext["ui"], "custom" | "input">;

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
  await requirePrivateFile(channelPath, "pi-workflows channel profile");
  const channels = parseChannelConfig(channelsRaw);
  const profileNames = Object.keys(channels.telegramProfiles ?? {});
  if (profileNames.length === 0) return { channels, credentials: {}, configDir };

  const credentialPath = path.join(configDir, "credentials.json");
  await requirePrivateFile(credentialPath, "pi-workflows credential profile");
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
  private promptAbort: AbortController | null = null;
  private settlementTask: Promise<void> | null = null;

  constructor(
    private readonly options: {
      actorId: string;
      ui: PiDecisionUi;
      store: HumanDecisionStore;
      onAnswer: (answer: HumanDecisionChannelAnswer) => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.promptAbort?.abort();
  }

  async deliver(request: HumanDecisionChannelRequest): Promise<HumanDecisionDeliveryResult> {
    if (await this.alreadyDecided(request.decisionId)) {
      return { status: "confirmed", channel: this.id, attemptId: "adopted" };
    }
    const attemptId = createHumanDecisionAttemptId();
    const createdAt = new Date().toISOString();
    const controller = new AbortController();
    this.promptAbort = controller;
    try {
      await this.options.store.recordDelivery(
        request,
        this.id,
        deliveryRecord(request, this.id, attemptId, "intent", "intent", createdAt),
      );
      const entries = Object.entries(request.choices);
      const selectedChoice = await this.options.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          let choiceIndex = 0;
          let scroll = 0;
          let settled = false;
          const finish = (value: string | undefined) => {
            if (settled) return;
            settled = true;
            done(value);
          };
          const abort = () => finish(undefined);
          controller.signal.addEventListener("abort", abort, { once: true });
          return {
            render(width: number): string[] {
              const content = renderPiPresentationLines(request, Math.max(20, width), theme);
              const maxScroll = Math.max(0, content.length - PI_PRESENTATION_WINDOW_LINES);
              scroll = Math.min(scroll, maxScroll);
              const visible = content.slice(scroll, scroll + PI_PRESENTATION_WINDOW_LINES);
              const lines = [...visible];
              if (content.length > PI_PRESENTATION_WINDOW_LINES) {
                lines.push(
                  theme.fg(
                    "dim",
                    `Decision text ${scroll + 1}-${Math.min(content.length, scroll + PI_PRESENTATION_WINDOW_LINES)}/${content.length} · PgUp/PgDn scroll`,
                  ),
                );
              }
              lines.push("");
              for (const [index, [, definition]] of entries.entries()) {
                const marker = index === choiceIndex ? "›" : " ";
                lines.push(
                  ...wrapTextWithAnsi(
                    `${theme.fg(index === choiceIndex ? "accent" : "text", `${marker} ${definition.label}`)}`,
                    Math.max(1, width),
                  ),
                );
                if (definition.input !== undefined) {
                  lines.push(
                    ...wrapTextWithAnsi(
                      theme.fg("dim", `    ${definition.input.prompt}`),
                      Math.max(1, width),
                    ),
                  );
                }
              }
              lines.push("");
              lines.push(theme.fg("dim", "↑/↓ choose · Enter confirm · Esc cancel"));
              return lines;
            },
            invalidate() {},
            handleInput(data: string): void {
              if (matchesKey(data, Key.escape)) finish(undefined);
              else if (matchesKey(data, Key.enter)) finish(entries[choiceIndex]?.[0]);
              else if (matchesKey(data, Key.up)) choiceIndex = Math.max(0, choiceIndex - 1);
              else if (matchesKey(data, Key.down)) {
                choiceIndex = Math.min(entries.length - 1, choiceIndex + 1);
              } else if (matchesKey(data, Key.pageUp)) {
                scroll = Math.max(0, scroll - PI_PRESENTATION_WINDOW_LINES);
              } else if (matchesKey(data, Key.pageDown)) {
                scroll += PI_PRESENTATION_WINDOW_LINES;
              } else return;
              tui.requestRender();
            },
            dispose(): void {
              controller.signal.removeEventListener("abort", abort);
            },
          };
        },
      );
      if (selectedChoice === undefined) {
        const errorCode = controller.signal.aborted
          ? "pi_selection_settled_elsewhere"
          : "pi_selection_cancelled";
        await this.options.store.recordDelivery(
          request,
          this.id,
          deliveryRecord(
            request,
            this.id,
            `${attemptId}-cancelled`,
            "complete",
            "failed",
            createdAt,
            { errorCode },
          ),
        );
        return { status: "failed", channel: this.id, attemptId, errorCode };
      }
      const definition = request.choices[selectedChoice];
      if (definition === undefined) throw new Error("Pi decision selection is not in the request");
      let response: HumanDecisionResponse = { choice: selectedChoice };
      if (definition.input !== undefined) {
        const text = await this.options.ui.input(definition.input.prompt, "", {
          signal: controller.signal,
        });
        if (text === undefined) {
          const errorCode = controller.signal.aborted
            ? "pi_input_settled_elsewhere"
            : "pi_input_cancelled";
          await this.options.store.recordDelivery(
            request,
            this.id,
            deliveryRecord(
              request,
              this.id,
              `${attemptId}-cancelled`,
              "complete",
              "failed",
              createdAt,
              { errorCode },
            ),
          );
          return { status: "failed", channel: this.id, attemptId, errorCode };
        }
        response = { choice: selectedChoice, input: { [definition.input.name]: text } };
      }
      if (await this.alreadyDecided(request.decisionId)) {
        return { status: "confirmed", channel: this.id, attemptId: "adopted" };
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
        deliveryRecord(
          request,
          this.id,
          `${attemptId}-confirmed`,
          "complete",
          "confirmed",
          createdAt,
          { messageCount: 1 },
        ),
      );
      return { status: "confirmed", channel: this.id, attemptId };
    } finally {
      if (this.promptAbort === controller) this.promptAbort = null;
    }
  }

  private async alreadyDecided(decisionId: string): Promise<boolean> {
    return (
      (await this.options.store.readResolved(decisionId)) !== null ||
      (await this.options.store.readCancellation(decisionId)) !== null
    );
  }

  async settle(decision: SettledHumanDecision): Promise<void> {
    this.promptAbort?.abort();
    if (this.settlementTask !== null) return await this.settlementTask;
    const task = this.settleOnce(decision);
    this.settlementTask = task;
    try {
      await task;
    } finally {
      if (this.settlementTask === task) this.settlementTask = null;
    }
  }

  private async settleOnce(decision: SettledHumanDecision): Promise<void> {
    const prior = await this.options.store.listSettlements(decision.decisionId, this.id);
    if (prior.some((record) => record.state === "confirmed")) return;
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
  request: HumanDecisionChannelRequest;
  choice: string;
};

type ReplyBinding = CallbackBinding & {
  chatId: string;
  promptMessageId: string;
};

type MessageRow = { chat_id: string; message_id: string };
type MessagePartRow = {
  recipient_index: number;
  part_index: number;
  content_digest: string;
  chat_id: string;
  message_id: string;
};

class TelegramProjection {
  private readonly channelId: string;
  private readonly resourceId: string;
  private readonly token = randomBytes(32).toString("base64url");
  private generation = 0;

  constructor(
    private readonly state: StateDatabase,
    private readonly profile: string,
    private readonly owner: string,
  ) {
    this.channelId = `telegram-${createHash("sha256").update(profile).digest("hex").slice(0, 40)}`;
    this.resourceId = resourceIdFor("channel", this.channelId);
    this.state.transaction(() => {
      const now = Date.now();
      this.state.connection
        .prepare(
          `INSERT INTO resources(
             resource_id, resource_type, aggregate_key, revision, created_at, updated_at
           ) VALUES (?, 'channel', ?, 1, ?, ?)
           ON CONFLICT(resource_type, aggregate_key) DO NOTHING`,
        )
        .run(this.resourceId, this.channelId, now, now);
      this.state.connection
        .prepare(
          "INSERT INTO leases(resource_id, generation) VALUES (?, 0) ON CONFLICT(resource_id) DO NOTHING",
        )
        .run(this.resourceId);
      this.state.connection
        .prepare(
          `INSERT INTO channels(channel_id, resource_id, adapter_type, profile_key, created_at)
           VALUES (?, ?, 'telegram', ?, ?) ON CONFLICT(channel_id) DO NOTHING`,
        )
        .run(this.channelId, this.resourceId, this.profile, now);
    });
  }

  close(): void {
    this.release();
  }

  acquire(now = Date.now()): boolean {
    return this.state.transaction(() => {
      const lease = this.lease();
      if (
        lease.ownerId !== null &&
        lease.ownerId !== this.owner &&
        lease.expiresAt !== null &&
        lease.expiresAt > now
      ) {
        return false;
      }
      const generation = lease.ownerId === this.owner ? lease.generation : lease.generation + 1;
      const result = this.state.connection
        .prepare(
          `UPDATE leases
           SET generation = ?, owner_type = 'channel', owner_id = ?, token_hash = ?,
               acquired_at = COALESCE(acquired_at, ?), heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND generation = ?`,
        )
        .run(
          generation,
          this.owner,
          tokenHash(this.token),
          now,
          now,
          now + LEASE_TTL_MS,
          this.resourceId,
          lease.generation,
        );
      /* istanbul ignore if -- impossible after exact schema and transaction checks */
      if (result.changes !== 1) return false;
      this.generation = generation;
      this.recordMutation("channel.lease_acquired", { expiresAt: now + LEASE_TTL_MS }, now);
      return true;
    });
  }

  renew(now = Date.now()): boolean {
    return (
      this.state.connection
        .prepare(
          `UPDATE leases SET heartbeat_at = ?, expires_at = ?
           WHERE resource_id = ? AND owner_id = ? AND token_hash = ? AND generation = ?`,
        )
        .run(
          now,
          now + LEASE_TTL_MS,
          this.resourceId,
          this.owner,
          tokenHash(this.token),
          this.generation,
        ).changes === 1
    );
  }

  release(): void {
    this.state.transaction(() => {
      const result = this.state.connection
        .prepare(
          `UPDATE leases
           SET owner_type = NULL, owner_id = NULL, token_hash = NULL,
               acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL
           WHERE resource_id = ? AND owner_id = ? AND token_hash = ? AND generation = ?`,
        )
        .run(this.resourceId, this.owner, tokenHash(this.token), this.generation);
      if (result.changes === 1) {
        this.recordMutation("channel.lease_released", {}, Date.now());
      }
    });
  }

  offset(): number {
    const row = this.state.connection
      .prepare(
        "SELECT cursor_value AS cursorValue FROM channel_cursors WHERE channel_id = ? AND cursor_key = 'telegram_update'",
      )
      .get(this.channelId);
    return isCursorRow(row) ? Number.parseInt(row.cursorValue, 10) || 0 : 0;
  }

  setOffset(offset: number): void {
    this.mutate("channel.cursor_updated", { offset }, () => {
      this.state.connection
        .prepare(
          `INSERT INTO channel_cursors(channel_id, cursor_key, cursor_value, updated_at)
           VALUES (?, 'telegram_update', ?, ?)
           ON CONFLICT(channel_id, cursor_key) DO UPDATE SET
             cursor_value = CAST(MAX(CAST(channel_cursors.cursor_value AS INTEGER), CAST(excluded.cursor_value AS INTEGER)) AS TEXT),
             updated_at = excluded.updated_at`,
        )
        .run(this.channelId, String(offset), Date.now());
    });
  }

  putCallback(token: string, binding: CallbackBinding): void {
    this.putInbox(`callback:${token}`, "callback", binding);
  }

  callback(token: string): CallbackBinding | undefined {
    return this.inbox<CallbackBinding>(`callback:${token}`);
  }

  putReply(binding: ReplyBinding): void {
    this.putInbox(`reply:${binding.chatId}:${binding.promptMessageId}`, "reply", binding);
  }

  reply(chatId: string, messageId: string): ReplyBinding | undefined {
    return this.inbox<ReplyBinding>(`reply:${chatId}:${messageId}`);
  }

  deleteReply(chatId: string, messageId: string): void {
    this.mutate("channel.reply_consumed", { chatId, messageId }, () => {
      this.state.connection
        .prepare("DELETE FROM channel_inbox WHERE channel_id = ? AND external_event_id = ?")
        .run(this.channelId, `reply:${chatId}:${messageId}`);
    });
  }

  putMessage(decisionId: string, chatId: string, messageId: string): void {
    const localId = transportMessageId(this.channelId, decisionId, chatId, messageId);
    this.mutate("channel.message_confirmed", { decisionId, chatId, messageId }, () => {
      const contentHash = this.state.putJson({ chatId, messageId });
      this.state.connection
        .prepare(
          `INSERT INTO channel_messages(
             message_id, channel_id, decision_id, purpose, content_hash,
             external_conversation_ref, external_message_ref, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'delivery', ?, ?, ?, 'confirmed', ?, ?)
           ON CONFLICT(message_id) DO NOTHING`,
        )
        .run(
          localId,
          this.channelId,
          decisionId,
          contentHash,
          chatId,
          messageId,
          Date.now(),
          Date.now(),
        );
    });
  }

  messages(decisionId: string): MessageRow[] {
    const rows = this.state.connection
      .prepare(
        `SELECT external_conversation_ref AS chatId, external_message_ref AS messageId
         FROM channel_messages
         WHERE channel_id = ? AND decision_id = ? AND purpose = 'delivery'
           AND external_conversation_ref IS NOT NULL AND external_message_ref IS NOT NULL
         ORDER BY external_conversation_ref, external_message_ref`,
      )
      .all(this.channelId, decisionId);
    return rows.filter(isTransportMessageRow).map((row) => ({
      chat_id: row.chatId,
      message_id: row.messageId,
    }));
  }

  putMessagePart(
    decisionId: string,
    recipientIndex: number,
    partIndex: number,
    contentDigest: string,
    chatId: string,
    messageId: string,
  ): void {
    const localId = `telegram-parts-${createHash("sha256")
      .update(`${this.channelId}\0${decisionId}`)
      .digest("hex")
      .slice(0, 40)}`;
    this.mutate("channel.message_part_confirmed", { decisionId, recipientIndex, partIndex }, () => {
      const parentHash = this.state.putJson({ decisionId });
      this.state.connection
        .prepare(
          `INSERT INTO channel_messages(
             message_id, channel_id, decision_id, purpose, content_hash,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, 'delivery', ?, 'confirmed', ?, ?)
           ON CONFLICT(message_id) DO NOTHING`,
        )
        .run(localId, this.channelId, decisionId, parentHash, Date.now(), Date.now());
      const contentHash = this.state.putText(contentDigest);
      this.state.connection
        .prepare(
          `INSERT INTO channel_message_parts(
             message_id, recipient_index, part_index, content_hash,
             external_conversation_ref, external_message_ref
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id, recipient_index, part_index) DO UPDATE SET
             content_hash = excluded.content_hash,
             external_conversation_ref = excluded.external_conversation_ref,
             external_message_ref = excluded.external_message_ref`,
        )
        .run(localId, recipientIndex, partIndex, contentHash, chatId, messageId);
    });
  }

  messagePart(
    decisionId: string,
    recipientIndex: number,
    partIndex: number,
  ): MessagePartRow | undefined {
    const localId = `telegram-parts-${createHash("sha256")
      .update(`${this.channelId}\0${decisionId}`)
      .digest("hex")
      .slice(0, 40)}`;
    const row = this.state.connection
      .prepare(
        `SELECT recipient_index AS recipientIndex, part_index AS partIndex,
                content_hash AS contentHash,
                external_conversation_ref AS chatId,
                external_message_ref AS messageId
         FROM channel_message_parts
         WHERE message_id = ? AND recipient_index = ? AND part_index = ?`,
      )
      .get(localId, recipientIndex, partIndex);
    if (!isMessagePartProjectionRow(row)) return undefined;
    const content = this.state.readBlob(row.contentHash);
    /* istanbul ignore if -- foreign key guarantees the content blob */
    if (content === undefined) throw new Error("Telegram part content is missing");
    return {
      recipient_index: row.recipientIndex,
      part_index: row.partIndex,
      content_digest: content.content.toString("utf8"),
      chat_id: row.chatId,
      message_id: row.messageId,
    };
  }

  private putInbox(
    eventId: string,
    type: "callback" | "reply",
    binding: CallbackBinding | ReplyBinding,
  ): void {
    this.mutate(`channel.${type}_stored`, { eventId }, () => {
      const payloadHash = this.state.putJson(binding);
      this.state.connection
        .prepare(
          `INSERT INTO channel_inbox(
             channel_id, external_event_id, event_type, payload_hash, received_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, external_event_id) DO UPDATE SET payload_hash = excluded.payload_hash`,
        )
        .run(this.channelId, eventId, type, payloadHash, Date.now());
    });
  }

  private inbox<T>(eventId: string): T | undefined {
    const row = this.state.connection
      .prepare(
        "SELECT payload_hash AS payloadHash FROM channel_inbox WHERE channel_id = ? AND external_event_id = ?",
      )
      .get(this.channelId, eventId);
    return isPayloadHashRow(row) ? (this.state.readJson(row.payloadHash) as T) : undefined;
  }

  private mutate(type: string, payload: unknown, operation: () => void): void {
    this.state.transaction(() => {
      this.assertOwner();
      operation();
      this.recordMutation(type, payload, Date.now());
    });
  }

  private recordMutation(type: string, payload: unknown, now: number): void {
    const revisionRow = this.state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(this.resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isRevisionProjectionRow(revisionRow))
      throw new Error("Telegram channel resource is missing");
    const revision = revisionRow.revision + 1;
    this.state.connection
      .prepare(
        "UPDATE resources SET revision = ?, updated_at = ? WHERE resource_id = ? AND revision = ?",
      )
      .run(revision, now, this.resourceId, revision - 1);
    const payloadHash = this.state.putJson(payload, now);
    this.state.connection
      .prepare(
        `INSERT INTO events(
           event_id, resource_id, resource_revision, event_type, actor_type,
           actor_id, lease_generation, payload_hash, recorded_at
         ) VALUES (?, ?, ?, ?, 'channel', ?, ?, ?, ?)`,
      )
      .run(
        `event-${randomUUID()}`,
        this.resourceId,
        revision,
        type,
        this.owner,
        this.generation === 0 ? null : this.generation,
        payloadHash,
        now,
      );
  }

  private assertOwner(): void {
    const lease = this.lease();
    if (
      lease.ownerId !== this.owner ||
      lease.generation !== this.generation ||
      lease.tokenHash === null ||
      !lease.tokenHash.equals(tokenHash(this.token)) ||
      lease.expiresAt === null ||
      lease.expiresAt <= Date.now()
    ) {
      throw new Error(`Telegram profile ${this.profile} is not owned by this channel process`);
    }
  }

  private lease(): TelegramLeaseRow {
    const row = this.state.connection
      .prepare(
        `SELECT generation, owner_id AS ownerId, token_hash AS tokenHash,
                expires_at AS expiresAt
         FROM leases WHERE resource_id = ?`,
      )
      .get(this.resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isTelegramLeaseRow(row)) throw new Error("Telegram channel lease is missing");
    return row;
  }
}

function transportMessageId(
  channelId: string,
  decisionId: string,
  chatId: string,
  messageId: string,
): string {
  return `telegram-message-${createHash("sha256")
    .update(`${channelId}\0${decisionId}\0${chatId}\0${messageId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

type TelegramLeaseRow = {
  generation: number;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
};

function isTelegramLeaseRow(value: unknown): value is TelegramLeaseRow {
  return isProjectionRecord(value);
}

function isCursorRow(value: unknown): value is { cursorValue: string } {
  return isProjectionRecord(value);
}

function isPayloadHashRow(value: unknown): value is { payloadHash: Buffer } {
  return isProjectionRecord(value);
}

function isTransportMessageRow(value: unknown): value is { chatId: string; messageId: string } {
  return isProjectionRecord(value);
}

function isMessagePartProjectionRow(value: unknown): value is {
  recipientIndex: number;
  partIndex: number;
  contentHash: Buffer;
  chatId: string;
  messageId: string;
} {
  return isProjectionRecord(value);
}

function isRevisionProjectionRow(value: unknown): value is { revision: number } {
  return isProjectionRecord(value);
}

function isProjectionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  private readonly settlementTasks = new Map<string, Promise<void>>();

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
      options.store.state,
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
    await Promise.allSettled(this.settlementTasks.values());
    this.pollAbort = null;
    this.pollTask = null;
    this.projection.close();
  }

  async deliver(request: HumanDecisionChannelRequest): Promise<HumanDecisionDeliveryResult> {
    const channelPath = this.channelPath();
    const parts = renderTelegramParts(request);
    const partDigests = parts.map((part) => digestCanonical(part));
    const prior = await this.store.listDeliveries(request.decisionId, channelPath);
    if (prior.some(isCompleteDelivery)) {
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
    if (hasUnsettledDeliveryIntent(prior)) {
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
    await this.store.recordDelivery(
      request,
      channelPath,
      deliveryRecord(request, this.id, attemptId, "intent", "intent", createdAt, {
        partCount: parts.length,
      }),
    );
    const keyboard = this.registerCallbacks(request);
    const recipients = [...this.profile.allowedChatIds].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const [recipientOffset, chatId] of recipients.entries()) {
      const recipientIndex = recipientOffset + 1;
      for (const [partOffset, text] of parts.entries()) {
        const partIndex = partOffset + 1;
        const contentDigest = partDigests[partOffset]!;
        const projected = this.projection.messagePart(
          request.decisionId,
          recipientIndex,
          partIndex,
        );
        const confirmed = prior.some(
          (record) =>
            record.phase === "part" &&
            record.state === "confirmed" &&
            record.recipientIndex === recipientIndex &&
            record.partIndex === partIndex &&
            record.partCount === parts.length &&
            record.contentDigest === contentDigest,
        );
        if (
          confirmed &&
          projected?.content_digest === contentDigest &&
          projected.chat_id === chatId
        ) {
          continue;
        }
        if (confirmed || projected !== undefined) {
          const errorCode = "telegram_part_evidence_mismatch";
          await this.store.recordDelivery(
            request,
            channelPath,
            deliveryRecord(
              request,
              this.id,
              `${attemptId}-r${recipientIndex}-p${partIndex}-unknown`,
              "part",
              "unknown",
              createdAt,
              { recipientIndex, partIndex, partCount: parts.length, contentDigest, errorCode },
            ),
          );
          return { status: "unknown", channel: this.id, attemptId, errorCode };
        }
        const partAttemptId = `${attemptId}-r${recipientIndex}-p${partIndex}`;
        await this.store.recordDelivery(
          request,
          channelPath,
          deliveryRecord(request, this.id, `${partAttemptId}-intent`, "part", "intent", createdAt, {
            recipientIndex,
            partIndex,
            partCount: parts.length,
            contentDigest,
          }),
        );
        try {
          const result = await this.call("sendMessage", {
            chat_id: chatId,
            text,
            ...(partIndex === parts.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          });
          const messageId = telegramMessageId(result);
          this.projection.putMessage(request.decisionId, chatId, messageId);
          this.projection.putMessagePart(
            request.decisionId,
            recipientIndex,
            partIndex,
            contentDigest,
            chatId,
            messageId,
          );
          await this.store.recordDelivery(
            request,
            channelPath,
            deliveryRecord(
              request,
              this.id,
              `${partAttemptId}-confirmed`,
              "part",
              "confirmed",
              createdAt,
              { recipientIndex, partIndex, partCount: parts.length, contentDigest },
            ),
          );
        } catch (error) {
          const callError = normalizeCallError(error);
          const state = callError.ambiguous ? "unknown" : "failed";
          await this.store.recordDelivery(
            request,
            channelPath,
            deliveryRecord(
              request,
              this.id,
              `${partAttemptId}-${state}`,
              "part",
              state,
              createdAt,
              {
                recipientIndex,
                partIndex,
                partCount: parts.length,
                contentDigest,
                errorCode: callError.code,
              },
            ),
          );
          await this.store.recordDelivery(
            request,
            channelPath,
            deliveryRecord(
              request,
              this.id,
              `${attemptId}-${state}`,
              "complete",
              state,
              createdAt,
              { partCount: parts.length, errorCode: callError.code },
            ),
          );
          return { status: state, channel: this.id, attemptId, errorCode: callError.code };
        }
      }
    }
    await this.store.recordDelivery(
      request,
      channelPath,
      deliveryRecord(
        request,
        this.id,
        `${attemptId}-confirmed`,
        "complete",
        "confirmed",
        createdAt,
        { partCount: parts.length, messageCount: parts.length * recipients.length },
      ),
    );
    return { status: "confirmed", channel: this.id, attemptId };
  }

  async settle(decision: SettledHumanDecision): Promise<void> {
    const existing = this.settlementTasks.get(decision.decisionId);
    if (existing !== undefined) return await existing;
    const task = this.settleOnce(decision);
    this.settlementTasks.set(decision.decisionId, task);
    try {
      await task;
    } finally {
      if (this.settlementTasks.get(decision.decisionId) === task) {
        this.settlementTasks.delete(decision.decisionId);
      }
    }
  }

  private async settleOnce(decision: SettledHumanDecision): Promise<void> {
    const channelPath = this.channelPath();
    const prior = await this.store.listSettlements(decision.decisionId, channelPath);
    if (
      prior.some((record) => record.state === "confirmed") ||
      prior.length >= MAX_SETTLEMENT_ATTEMPTS
    ) {
      return;
    }
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
      } catch (error) {
        if (normalizeCallError(error).code !== "telegram_message_not_modified") failed = true;
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
    await this.store.recordSettlement(decision.decisionId, channelPath, record);
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

  private registerCallbacks(
    request: HumanDecisionChannelRequest,
  ): Array<Array<Record<string, string>>> {
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

  private isStale(request: HumanDecisionChannelRequest): boolean {
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
    const body = record(await response.json(), `Telegram ${method} response`);
    if (!response.ok) {
      const description = typeof body.description === "string" ? body.description : "";
      if (
        method === "editMessageReplyMarkup" &&
        description.toLowerCase().includes("message is not modified")
      ) {
        throw new TelegramCallError(
          "Telegram message was already settled",
          false,
          "telegram_message_not_modified",
        );
      }
      throw new TelegramCallError(
        `Telegram ${method} failed with HTTP ${response.status}`,
        false,
        `telegram_http_${response.status}`,
      );
    }
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
  fetchFn?: TelegramFetch,
  apiBase = DEFAULT_API_BASE,
): Promise<void> {
  /* istanbul ignore next -- global fetch is used only by operator setup */
  const request = fetchFn ?? (fetch as TelegramFetch);
  if (!path.isAbsolute(tokenFile)) throw new Error("Telegram token file path must be absolute");
  await requirePrivateFile(tokenFile, "Telegram token file");
  const token = (await fsp.readFile(tokenFile, "utf8")).trim();
  if (token.length === 0) throw new Error("Telegram token file is empty");
  let response;
  try {
    response = await request(`${apiBase}/bot${encodeURIComponent(token)}/getMe`, {
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
  const config = record(value, "pi-workflows channel config");
  if (config.schema !== "pi-workflows.channels.v1") {
    throw new Error("pi-workflows channel config schema is invalid");
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
  const audiencesRaw = record(config.audiences, "pi-workflows audiences");
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
  const config = record(value, "pi-workflows credential config");
  if (config.schema !== "pi-workflows.credentials.v1") {
    throw new Error("pi-workflows credential config schema is invalid");
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

type DeliveryRecord = HumanDecisionDeliveryRecord;

type DeliveryRecordExtra = Partial<
  Pick<
    DeliveryRecord,
    "recipientIndex" | "partIndex" | "partCount" | "contentDigest" | "messageCount" | "errorCode"
  >
>;

function deliveryRecord(
  request: HumanDecisionChannelRequest,
  channel: string,
  attemptId: string,
  phase: DeliveryRecord["phase"],
  state: DeliveryRecord["state"],
  createdAt: string,
  extra: DeliveryRecordExtra = {},
): DeliveryRecord {
  return {
    schema: "pi-workflows.human-decision-delivery.v1",
    attemptId,
    decisionId: request.decisionId,
    requestDigest: request.requestDigest,
    presentationDigest: request.presentationDigest,
    channel,
    phase,
    state,
    createdAt,
    ...(state === "intent" ? {} : { finishedAt: new Date().toISOString() }),
    ...extra,
  };
}

function isCompleteDelivery(record: HumanDecisionDeliveryRecord): boolean {
  return record.state === "confirmed" && record.phase === "complete";
}

function hasUnsettledDeliveryIntent(records: HumanDecisionDeliveryRecord[]): boolean {
  return records.some((record) => {
    if (record.phase !== "part" || record.state !== "intent") return false;
    return !records.some(
      (other) =>
        other.phase === "part" &&
        other.state !== "intent" &&
        other.recipientIndex === record.recipientIndex &&
        other.partIndex === record.partIndex &&
        other.contentDigest === record.contentDigest,
    );
  });
}

export function renderDecisionText(request: HumanDecisionChannelRequest): string {
  const content = decisionDocumentSegments(request)
    .map((segment) => operatorSafeText(segment.text))
    .join("\n\n");
  return `${content}\n\nDecision ${decisionPresentationFingerprint(request)}`;
}

export function renderTelegramParts(
  request: HumanDecisionChannelRequest,
  textLimit = TELEGRAM_TEXT_LIMIT,
): string[] {
  const fingerprint = decisionPresentationFingerprint(request);
  const maximumHeader = telegramPartHeader(
    MAX_PRESENTATION_TRANSPORT_PARTS,
    MAX_PRESENTATION_TRANSPORT_PARTS,
    fingerprint,
  );
  const capacity = textLimit - maximumHeader.length;
  if (capacity < 1)
    throw new Error("Telegram decision text limit is too small for its part header");
  const bodyParts = packDecisionSegments(
    decisionDocumentSegments(request).map((segment) => operatorSafeText(segment.text)),
    capacity,
  );
  if (bodyParts.length > MAX_PRESENTATION_TRANSPORT_PARTS) {
    throw new Error(
      `Decision presentation renders as ${bodyParts.length} Telegram parts; limit is ${MAX_PRESENTATION_TRANSPORT_PARTS}`,
    );
  }
  return bodyParts.map((body, index) => {
    const text = `${telegramPartHeader(index + 1, bodyParts.length, fingerprint)}${body}`;
    if (text.length > textLimit) {
      throw new Error(
        `Telegram decision part ${index + 1} exceeds the ${textLimit} character limit`,
      );
    }
    return text;
  });
}

function renderPiPresentationLines(
  request: HumanDecisionChannelRequest,
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  for (const segment of decisionDocumentSegments(request).filter(
    (candidate) => candidate.kind !== "choices",
  )) {
    const text = operatorSafeText(segment.text);
    const styled =
      segment.kind === "title"
        ? theme.fg("accent", theme.bold(text))
        : segment.kind === "section"
          ? theme.fg("text", theme.bold(text))
          : segment.kind === "preformatted"
            ? theme.fg("muted", text)
            : theme.fg("text", text);
    for (const rawLine of styled.split("\n")) {
      lines.push(...wrapTextWithAnsi(rawLine.length === 0 ? " " : rawLine, Math.max(1, width)));
    }
    lines.push("");
  }
  lines.push(theme.fg("dim", `Decision ${decisionPresentationFingerprint(request)}`));
  return lines;
}

function telegramPartHeader(part: number, total: number, fingerprint: string): string {
  return `Part ${part}/${total}\nDecision ${fingerprint}\n\n`;
}

function packDecisionSegments(segments: string[], capacity: number): string[] {
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length === 0) return;
    parts.push(current);
    current = "";
  };
  for (const segment of segments) {
    const pieces = splitTransportText(segment, capacity);
    for (const piece of pieces) {
      const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;
      if (candidate.length <= capacity) {
        current = candidate;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return parts.length === 0 ? ["Decision"] : parts;
}

function splitTransportText(value: string, capacity: number): string[] {
  const parts: string[] = [];
  let remaining = value;
  while (remaining.length > capacity) {
    let end = codePointBoundary(remaining, capacity);
    const newline = remaining.lastIndexOf("\n", end);
    if (newline > 0) end = newline;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function codePointBoundary(value: string, limit: number): number {
  let end = Math.min(limit, value.length);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff && end < value.length) end -= 1;
  return Math.max(1, end);
}

function operatorSafeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127 ? "�" : character;
    })
    .join("");
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
