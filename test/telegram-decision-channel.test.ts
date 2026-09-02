import { describe, expect, it } from "vitest";
import type { TelegramFetch } from "../src/channels/config.js";
import {
  TelegramAdapter,
  renderDecisionText,
  renderTelegramParts,
} from "../src/channels/telegram.js";
import { humanDecisionChannelRequest } from "../src/workflows/decision-presentation.js";
import {
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../src/workflows/human-decision.js";
import { decisionPrompt } from "./helpers.js";

function request(text = "Apply the safe change.") {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
      runId: "run-a",
      workflowName: "workflow-a",
      nodeId: "approve",
      attemptId: "attempt-a",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({
          continue: choice({ label: "Continue" }),
          replan: choice({
            label: "Replan",
            input: textInput({ name: "instructions", prompt: "What should change?" }),
          }),
        }),
      },
      prompt: {
        ...decisionPrompt({ privateMachineField: "not-for-display" }),
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review this readable plan.",
          blocks: [{ kind: "paragraph", text }],
        },
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
}

function fakeBot() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const updates: unknown[] = [];
  let nextMessage = 10;
  const fetchFn: TelegramFetch = async (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload });
    const result =
      method === "sendMessage"
        ? { message_id: nextMessage++ }
        : method === "getUpdates"
          ? updates.splice(0)
          : true;
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result };
      },
    };
  };
  return { calls, updates, fetchFn };
}

function adapter(fetchFn: TelegramFetch) {
  return new TelegramAdapter({
    profile: "approval",
    token: "fixture-token",
    allowedUserIds: ["100"],
    allowedChatIds: ["-200"],
    fetchFn,
  });
}

describe("supervised Telegram adapter transport", () => {
  it("renders only approved presentation data and keeps every part within Telegram's limit", () => {
    const text = "Readable ".repeat(1_200);
    const value = request(text);
    const rendered = renderDecisionText(value);
    const parts = renderTelegramParts(value);
    expect(rendered).toContain(text.trim());
    expect(rendered).not.toContain("privateMachineField");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 4_096)).toBe(true);
    expect(parts.join("\n")).toContain("Readable");
  });

  it("presents one complete decision and returns external message references", async () => {
    const bot = fakeBot();
    const value = request();
    const references = await adapter(bot.fetchFn).present(value);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ chatId: "-200", messageId: "10" });
    const send = bot.calls.find((call) => call.method === "sendMessage");
    expect(send?.payload.text).toContain("Apply the safe change.");
    expect(send?.payload.reply_markup).toMatchObject({ inline_keyboard: expect.any(Array) });
  });

  it("accepts an authorized callback as a verified answer", async () => {
    const bot = fakeBot();
    const value = request();
    const channel = adapter(bot.fetchFn);
    channel.setRequests([value]);
    await channel.present(value);
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const callbackData = markup.inline_keyboard?.[0]?.[0]?.callback_data;
    if (callbackData === undefined) throw new Error("callback token missing");
    bot.updates.push({
      update_id: 1,
      callback_query: {
        id: "callback-1",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: callbackData,
      },
    });
    const polled = await channel.poll(0);
    expect(polled.cursor).toBe(2);
    expect(polled.answers[0]).toMatchObject({
      response: { choice: "continue" },
      actorId: "100",
      chatId: "-200",
      eventId: "callback-1",
    });
  });

  it("rejects an unauthorized callback", async () => {
    const bot = fakeBot();
    const value = request();
    const channel = adapter(bot.fetchFn);
    channel.setRequests([value]);
    await channel.present(value);
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    bot.updates.push({
      update_id: 2,
      callback_query: {
        id: "callback-2",
        from: { id: 999 },
        message: { message_id: 10, chat: { id: -200 } },
        data: markup.inline_keyboard?.[0]?.[0]?.callback_data,
      },
    });
    expect((await channel.poll(0)).answers).toEqual([]);
    expect(bot.calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
  });

  it("recovers an input choice from the token in the Telegram reply prompt", async () => {
    const bot = fakeBot();
    const value = request();
    const channel = adapter(bot.fetchFn);
    channel.setRequests([value]);
    await channel.present(value);
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    bot.updates.push({
      update_id: 3,
      callback_query: {
        id: "callback-3",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: markup.inline_keyboard?.[1]?.[0]?.callback_data,
      },
    });
    expect((await channel.poll(0)).answers).toEqual([]);
    const prompt = bot.calls
      .filter((call) => call.method === "sendMessage")
      .find((call) => String(call.payload.text).includes("Reply token:"));
    if (prompt === undefined) throw new Error("reply prompt missing");
    bot.updates.push({
      update_id: 4,
      message: {
        message_id: 20,
        from: { id: 100 },
        chat: { id: -200 },
        text: "Use the smaller change.",
        reply_to_message: { text: prompt.payload.text },
      },
    });
    expect((await channel.poll(4)).answers[0]).toMatchObject({
      response: {
        choice: "replan",
        input: { instructions: "Use the smaller change." },
      },
    });
  });

  it("ignores inactive and malformed Telegram updates", async () => {
    const bot = fakeBot();
    const value = request();
    const channel = adapter(bot.fetchFn);
    channel.setRequests([value]);
    bot.updates.push(
      null,
      { update_id: "bad" },
      { update_id: 1 },
      {
        update_id: 2,
        callback_query: {
          id: "inactive",
          from: { id: "100" },
          message: { chat: { id: "-200" } },
          data: "not-a-workflow-token",
        },
      },
      {
        update_id: 3,
        message: {
          message_id: 30,
          from: { id: 100 },
          chat: { id: -200 },
          text: "not a reply",
          reply_to_message: { text: "No token" },
        },
      },
      {
        update_id: 4,
        message: {
          message_id: 31,
          from: { id: 100 },
          chat: { id: -200 },
          text: "unknown token",
          reply_to_message: { text: "Reply token: unknown" },
        },
      },
      {
        update_id: 5,
        message: {
          message_id: 32,
          from: { id: 999 },
          chat: { id: -200 },
          text: "unauthorized",
          reply_to_message: { text: "Reply token: unknown" },
        },
      },
    );

    await expect(channel.poll(0)).resolves.toMatchObject({ cursor: 6, answers: [] });
    expect(
      bot.calls.some(
        (call) =>
          call.method === "answerCallbackQuery" &&
          call.payload.text === "This decision choice is no longer active.",
      ),
    ).toBe(true);
  });

  it("presents multipart decisions to each allowed chat", async () => {
    const bot = fakeBot();
    const value = request("Readable ".repeat(1_200));
    const channel = new TelegramAdapter({
      profile: "approval",
      token: "fixture-token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200", "-201"],
      fetchFn: bot.fetchFn,
      apiBase: "https://telegram.invalid",
    });
    const references = await channel.present(value);
    expect(references.length).toBeGreaterThan(2);
    expect(new Set(references.map((item) => item.chatId))).toEqual(new Set(["-200", "-201"]));
    expect(
      bot.calls.filter(
        (call) => call.method === "sendMessage" && call.payload.reply_markup !== undefined,
      ),
    ).toHaveLength(2);
  });

  it("removes old controls and posts one settlement result per chat", async () => {
    const bot = fakeBot();
    const value = request();
    const channel = adapter(bot.fetchFn);
    const references = await channel.present(value);
    await channel.settle("accepted", { choice: "continue" }, references);
    await channel.settle("cancelled", undefined, [...references, ...references]);
    expect(bot.calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
    expect(
      bot.calls.some(
        (call) =>
          call.method === "sendMessage" && call.payload.text === "Decision accepted (continue).",
      ),
    ).toBe(true);
    expect(
      bot.calls.filter(
        (call) => call.method === "sendMessage" && call.payload.text === "Decision cancelled.",
      ),
    ).toHaveLength(1);
  });

  it("reports invalid Telegram API results without guessing", async () => {
    const value = request();
    const response =
      (ok: boolean, status: number, body: unknown): TelegramFetch =>
      async () => ({
        ok,
        status,
        async json() {
          return body;
        },
      });

    await expect(adapter(response(false, 503, {})).present(value)).rejects.toThrow("HTTP 503");
    await expect(adapter(response(true, 200, { ok: false })).present(value)).rejects.toThrow(
      "was rejected",
    );
    await expect(
      adapter(response(true, 200, { ok: true, result: {} })).present(value),
    ).rejects.toThrow("message_id must be an integer");
    await expect(adapter(response(true, 200, { ok: true, result: {} })).poll(0)).rejects.toThrow(
      "getUpdates result must be an array",
    );
  });
});
