import { createHmac } from "node:crypto";
import { decisionDocumentSegments, digestCanonical } from "../workflows/decision-presentation.js";
import type { HumanDecisionChannelRequest, HumanDecisionResponse } from "../workflows/types.js";
import type { TelegramFetch } from "./config.js";
import type { TelegramMessageReference } from "./protocol.js";

const DEFAULT_API_BASE = "https://api.telegram.org";
const TELEGRAM_TEXT_LIMIT = 4_096;
const CALLBACK_PREFIX = "pw:";
const REPLY_TOKEN_PREFIX = "Reply token: ";

export type TelegramVerifiedAnswer = {
  request: HumanDecisionChannelRequest;
  response: HumanDecisionResponse;
  actorId: string;
  chatId: string;
  eventId: string;
  cursor: number;
};

export class TelegramAdapter {
  private requests: HumanDecisionChannelRequest[] = [];
  private readonly allowedUsers: Set<string>;
  private readonly allowedChats: Set<string>;
  private readonly request: TelegramFetch;

  constructor(
    private readonly options: {
      profile: string;
      token: string;
      allowedUserIds: readonly string[];
      allowedChatIds: readonly string[];
      fetchFn?: TelegramFetch;
      apiBase?: string;
    },
  ) {
    this.allowedUsers = new Set(options.allowedUserIds);
    this.allowedChats = new Set(options.allowedChatIds);
    this.request = options.fetchFn ?? (fetch as TelegramFetch);
  }

  setRequests(requests: readonly HumanDecisionChannelRequest[]): void {
    this.requests = [...requests];
  }

  async present(request: HumanDecisionChannelRequest): Promise<TelegramMessageReference[]> {
    const parts = renderTelegramParts(request);
    const references: TelegramMessageReference[] = [];
    const keyboard = this.keyboard(request);
    for (const [recipientIndex, chatId] of [...this.allowedChats].entries()) {
      for (const [partIndex, text] of parts.entries()) {
        const result = await this.call("sendMessage", {
          chat_id: chatId,
          text,
          ...(partIndex === parts.length - 1
            ? { reply_markup: { inline_keyboard: keyboard } }
            : {}),
        });
        const messageId = integerField(result, "message_id", "Telegram sendMessage result");
        references.push({
          chatId,
          messageId: String(messageId),
          recipientIndex,
          partIndex,
          contentDigest: digestCanonical(text),
        });
      }
    }
    return references;
  }

  async poll(cursor: number): Promise<{ cursor: number; answers: TelegramVerifiedAnswer[] }> {
    const result = await this.call("getUpdates", {
      offset: cursor,
      timeout: 1,
      allowed_updates: ["callback_query", "message"],
    });
    if (!Array.isArray(result)) throw new Error("Telegram getUpdates result must be an array");
    let nextCursor = cursor;
    const answers: TelegramVerifiedAnswer[] = [];
    for (const raw of result) {
      const update = asRecord(raw);
      if (update === null || !Number.isSafeInteger(update.update_id)) continue;
      const updateId = update.update_id as number;
      nextCursor = Math.max(nextCursor, updateId + 1);
      const answer = await this.handleUpdate(update, updateId + 1);
      if (answer !== undefined) answers.push(answer);
    }
    return { cursor: nextCursor, answers };
  }

  async settle(
    outcome: "accepted" | "cancelled" | "expired",
    response: HumanDecisionResponse | undefined,
    messages: readonly TelegramMessageReference[],
  ): Promise<void> {
    const seenChats = new Set<string>();
    for (const message of messages) {
      await this.call("editMessageReplyMarkup", {
        chat_id: message.chatId,
        message_id: Number.parseInt(message.messageId, 10),
        reply_markup: { inline_keyboard: [] },
      });
      if (seenChats.has(message.chatId)) continue;
      seenChats.add(message.chatId);
      const selection = response?.choice === undefined ? "" : ` (${response.choice})`;
      await this.call("sendMessage", {
        chat_id: message.chatId,
        text: `Decision ${outcome}${selection}.`,
      });
    }
  }

  private async handleUpdate(
    update: Record<string, unknown>,
    cursor: number,
  ): Promise<TelegramVerifiedAnswer | undefined> {
    const callback = asRecord(update.callback_query);
    if (callback !== null) return await this.handleCallback(callback, cursor);
    const message = asRecord(update.message);
    if (message !== null) return await this.handleReply(message, cursor);
    return undefined;
  }

  private async handleCallback(
    callback: Record<string, unknown>,
    cursor: number,
  ): Promise<TelegramVerifiedAnswer | undefined> {
    const callbackId = stringField(callback, "id");
    const actor = asRecord(callback.from);
    const message = asRecord(callback.message);
    const chat = asRecord(message?.chat);
    const actorId = numericText(actor?.id);
    const chatId = numericText(chat?.id);
    const data = typeof callback.data === "string" ? callback.data : "";
    if (
      callbackId === undefined ||
      actorId === undefined ||
      chatId === undefined ||
      !this.allowedUsers.has(actorId) ||
      !this.allowedChats.has(chatId)
    ) {
      if (callbackId !== undefined) {
        await this.answerCallback(callbackId, "This decision answer is not authorized.");
      }
      return undefined;
    }
    const binding = this.callbackBinding(data);
    if (binding === undefined) {
      await this.answerCallback(callbackId, "This decision choice is no longer active.");
      return undefined;
    }
    const choice = binding.request.choices[binding.choice];
    if (choice === undefined) return undefined;
    if (choice.input !== undefined) {
      const token = this.replyToken(binding.request, binding.choice);
      await this.call("sendMessage", {
        chat_id: chatId,
        text: `${choice.input.prompt}\n${REPLY_TOKEN_PREFIX}${token}`,
        reply_markup: { force_reply: true, selective: true },
      });
      await this.answerCallback(callbackId, "Reply to the new prompt.");
      return undefined;
    }
    await this.answerCallback(callbackId, "Answer received.");
    return {
      request: binding.request,
      response: { choice: binding.choice },
      actorId,
      chatId,
      eventId: callbackId,
      cursor,
    };
  }

  private async handleReply(
    message: Record<string, unknown>,
    cursor: number,
  ): Promise<TelegramVerifiedAnswer | undefined> {
    const actorId = numericText(asRecord(message.from)?.id);
    const chatId = numericText(asRecord(message.chat)?.id);
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const replyText = asRecord(message.reply_to_message)?.text;
    const eventId = numericText(message.message_id);
    if (
      actorId === undefined ||
      chatId === undefined ||
      eventId === undefined ||
      text.length === 0 ||
      typeof replyText !== "string" ||
      !this.allowedUsers.has(actorId) ||
      !this.allowedChats.has(chatId)
    ) {
      return undefined;
    }
    const marker = replyText.lastIndexOf(REPLY_TOKEN_PREFIX);
    if (marker < 0) return undefined;
    const token = replyText
      .slice(marker + REPLY_TOKEN_PREFIX.length)
      .trim()
      .split(/\s/u)[0];
    if (token === undefined) return undefined;
    const binding = this.replyBinding(token);
    if (binding === undefined) return undefined;
    const choice = binding.request.choices[binding.choice];
    if (choice?.input === undefined) return undefined;
    return {
      request: binding.request,
      response: { choice: binding.choice, input: { [choice.input.name]: text } },
      actorId,
      chatId,
      eventId,
      cursor,
    };
  }

  private keyboard(request: HumanDecisionChannelRequest): Array<Array<Record<string, string>>> {
    return Object.entries(request.choices).map(([choice, definition]) => [
      {
        text: definition.label,
        callback_data: `${CALLBACK_PREFIX}${this.callbackToken(request, choice)}`,
      },
    ]);
  }

  private callbackBinding(
    data: string,
  ): { request: HumanDecisionChannelRequest; choice: string } | undefined {
    if (!data.startsWith(CALLBACK_PREFIX)) return undefined;
    const token = data.slice(CALLBACK_PREFIX.length);
    for (const request of this.requests) {
      for (const choice of Object.keys(request.choices)) {
        if (this.callbackToken(request, choice) === token) return { request, choice };
      }
    }
    return undefined;
  }

  private replyBinding(
    token: string,
  ): { request: HumanDecisionChannelRequest; choice: string } | undefined {
    for (const request of this.requests) {
      for (const [choice, definition] of Object.entries(request.choices)) {
        if (definition.input !== undefined && this.replyToken(request, choice) === token) {
          return { request, choice };
        }
      }
    }
    return undefined;
  }

  private callbackToken(request: HumanDecisionChannelRequest, choice: string): string {
    return this.token("callback", request, choice);
  }

  private replyToken(request: HumanDecisionChannelRequest, choice: string): string {
    return this.token("reply", request, choice);
  }

  private token(
    purpose: "callback" | "reply",
    request: HumanDecisionChannelRequest,
    choice: string,
  ): string {
    return createHmac("sha256", this.options.token)
      .update(`${purpose}\0${this.options.profile}\0${request.requestDigest}\0${choice}`)
      .digest("base64url")
      .slice(0, 32);
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const apiBase = this.options.apiBase ?? DEFAULT_API_BASE;
    const response = await this.request(
      `${apiBase}/bot${encodeURIComponent(this.options.token)}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    const body = asRecord(await response.json());
    if (body?.ok !== true) throw new Error(`Telegram ${method} was rejected`);
    return body.result;
  }
}

export function renderDecisionText(request: HumanDecisionChannelRequest): string {
  return decisionDocumentSegments(request)
    .map((segment) => segment.text)
    .join("\n\n");
}

export function renderTelegramParts(request: HumanDecisionChannelRequest): string[] {
  const text = renderDecisionText(request);
  if (text.length <= TELEGRAM_TEXT_LIMIT) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_TEXT_LIMIT) {
    const window = remaining.slice(0, TELEGRAM_TEXT_LIMIT);
    const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const cut = boundary > TELEGRAM_TEXT_LIMIT / 2 ? boundary : TELEGRAM_TEXT_LIMIT;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/u, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function integerField(value: unknown, field: string, label: string): number {
  const record = asRecord(value);
  const result = record?.[field];
  if (!Number.isSafeInteger(result)) throw new Error(`${label} ${field} must be an integer`);
  return result as number;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? (value[field] as string) : undefined;
}

function numericText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?[0-9]+$/u.test(value)) return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
