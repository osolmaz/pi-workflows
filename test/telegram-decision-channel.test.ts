import { describe, expect, it, vi } from "vitest";
import {
  TelegramDecisionChannel,
  renderDecisionText,
  renderTelegramParts,
  type HumanDecisionChannelAnswer,
  type TelegramFetch,
} from "../src/extension/decision-channels.js";
import {
  digestCanonical,
  humanDecisionChannelRequest,
} from "../src/workflows/decision-presentation.js";
import {
  HumanDecisionStore,
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../src/workflows/human-decision.js";
import {
  decisionPrompt,
  makeStateDatabasePath,
  seedHumanDecisionRequest,
  waitUntil,
} from "./helpers.js";

function fullRequest(text = "Apply the safe change.") {
  return createHumanDecisionRequest({
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
  });
}

function fakeBot() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let nextMessage = 10;
  const fetchFn: TelegramFetch = async (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload });
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          result:
            method === "sendMessage"
              ? { message_id: nextMessage++ }
              : method === "getUpdates"
                ? []
                : true,
        };
      },
    };
  };
  return { calls, fetchFn };
}

async function fixture(
  options: {
    fetchFn?: TelegramFetch;
    ownerId?: string;
    answers?: HumanDecisionChannelAnswer[];
  } = {},
) {
  const request = fullRequest();
  const store = new HumanDecisionStore(await makeStateDatabasePath("telegram"));
  await seedHumanDecisionRequest(store, request);
  const answers = options.answers ?? [];
  const channel = new TelegramDecisionChannel({
    profileName: "approval",
    token: "test-token-not-real",
    allowedUserIds: ["100"],
    allowedChatIds: ["-200"],
    store,
    onAnswer: async (answer) => {
      answers.push(answer);
    },
    fetchFn: options.fetchFn ?? fakeBot().fetchFn,
    apiBase: "https://telegram.test",
    ownerId: options.ownerId ?? "owner-a",
  });
  await channel.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { request, store, channel, answers };
}

describe("Telegram decision presentation", () => {
  it("renders readable text without exposing the subject", () => {
    const rendered = renderDecisionText(humanDecisionChannelRequest(fullRequest()));
    expect(rendered).toContain("Review this readable plan.");
    expect(rendered).toContain("Apply the safe change.");
    expect(rendered).not.toContain("privateMachineField");
  });

  it("splits long Unicode text without truncation", () => {
    const text = "🙂".repeat(5_000);
    const parts = renderTelegramParts(humanDecisionChannelRequest(fullRequest(text)));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => [...part].length <= 4_096)).toBe(true);
    expect(parts.join("").match(/🙂/gu)).toHaveLength(5_000);
  });
});

describe("TelegramDecisionChannel SQLite", () => {
  it("validates profile and authorization inputs", async () => {
    const store = new HumanDecisionStore(await makeStateDatabasePath("telegram-validation"));
    const base = {
      profileName: "approval",
      token: "token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store,
      onAnswer: async () => {},
    };
    expect(() => new TelegramDecisionChannel({ ...base, profileName: "bad profile" })).toThrow();
    expect(() => new TelegramDecisionChannel({ ...base, token: " " })).toThrow(/must not be empty/);
    expect(() => new TelegramDecisionChannel({ ...base, allowedUserIds: ["bad"] })).toThrow(
      /numeric/,
    );
    expect(() => new TelegramDecisionChannel({ ...base, allowedChatIds: ["bad"] })).toThrow(
      /numeric/,
    );
    store.close();
  });

  it("delivers once and adopts durable message evidence", async () => {
    const bot = fakeBot();
    const { request, store, channel } = await fixture({ fetchFn: bot.fetchFn });
    const first = await channel.deliver(humanDecisionChannelRequest(request));
    const second = await channel.deliver(humanDecisionChannelRequest(request));
    expect(first.status).toBe("confirmed");
    expect(second).toMatchObject({ status: "confirmed", attemptId: "adopted" });
    expect(bot.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM channel_message_parts").get(),
    ).toEqual({ count: 1 });
    await channel.stop();
    store.close();
  });

  it("delivers multipart content to multiple recipients", async () => {
    const bot = fakeBot();
    const request = fullRequest("long ".repeat(2_000));
    const store = new HumanDecisionStore(await makeStateDatabasePath("telegram-multipart"));
    await seedHumanDecisionRequest(store, request);
    const channel = new TelegramDecisionChannel({
      profileName: "approval",
      token: "token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200", "-201"],
      store,
      onAnswer: async () => {},
      fetchFn: bot.fetchFn,
      ownerId: "owner-multipart",
    });
    await channel.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await channel.deliver(humanDecisionChannelRequest(request));
    expect(result.status).toBe("confirmed");
    expect(bot.calls.filter((call) => call.method === "sendMessage").length).toBeGreaterThan(2);
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM channel_message_parts").get(),
    ).toMatchObject({
      count: expect.any(Number),
    });
    await channel.stop();
    store.close();
  });

  it("adopts unknown and unsettled delivery evidence without resending", async () => {
    for (const state of ["unknown", "intent"] as const) {
      const bot = fakeBot();
      const request = fullRequest();
      const store = new HumanDecisionStore(await makeStateDatabasePath(`telegram-${state}`));
      await seedHumanDecisionRequest(store, request);
      const createdAt = new Date().toISOString();
      await store.recordDelivery(request, "telegram-approval", {
        schema: "pi-workflows.human-decision-delivery.v1",
        attemptId: `${state}-attempt`,
        decisionId: request.decisionId,
        requestDigest: request.requestDigest,
        presentationDigest: request.presentationDigest,
        channel: "telegram:approval",
        phase: state === "intent" ? "part" : "complete",
        state,
        createdAt,
        ...(state === "intent"
          ? { recipientIndex: 1, partIndex: 1, partCount: 1, contentDigest: "digest" }
          : {}),
      });
      expect(await store.listDeliveries(request.decisionId, "telegram-approval")).toMatchObject([
        { state },
      ]);
      const channel = new TelegramDecisionChannel({
        profileName: "approval",
        token: "token",
        allowedUserIds: ["100"],
        allowedChatIds: ["-200"],
        store,
        onAnswer: async () => {},
        fetchFn: bot.fetchFn,
        ownerId: `owner-${state}`,
      });
      await channel.start();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await channel.deliver(humanDecisionChannelRequest(request))).toMatchObject({
        status: "unknown",
        attemptId: "adopted",
      });
      expect(bot.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
      await channel.stop();
      store.close();
    }
  });

  it("fails closed when confirmed part evidence lacks its transport receipt", async () => {
    const bot = fakeBot();
    const request = fullRequest();
    const channelRequest = humanDecisionChannelRequest(request);
    const store = new HumanDecisionStore(await makeStateDatabasePath("telegram-part-mismatch"));
    await seedHumanDecisionRequest(store, request);
    const parts = renderTelegramParts(channelRequest);
    await store.recordDelivery(request, "telegram-approval", {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId: "confirmed-part",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      presentationDigest: request.presentationDigest,
      channel: "telegram:approval",
      phase: "part",
      state: "confirmed",
      createdAt: new Date().toISOString(),
      recipientIndex: 1,
      partIndex: 1,
      partCount: parts.length,
      contentDigest: digestCanonical(parts[0]),
    });
    const channel = new TelegramDecisionChannel({
      profileName: "approval",
      token: "token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store,
      onAnswer: async () => {},
      fetchFn: bot.fetchFn,
      ownerId: "owner-mismatch",
    });
    await channel.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await channel.deliver(channelRequest)).toMatchObject({
      status: "unknown",
      errorCode: "telegram_part_evidence_mismatch",
    });
    await channel.stop();
    store.close();
  });

  it("advances a valid provider cursor", async () => {
    let firstPoll = true;
    const fetchFn: TelegramFetch = async (url) => {
      const method = url.split("/").at(-1) ?? "";
      if (method === "getUpdates") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = firstPoll ? [{ update_id: 5 }] : [];
        firstPoll = false;
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: true };
        },
      };
    };
    const { store, channel } = await fixture({ fetchFn });
    await waitUntil(
      () =>
        store.state.connection
          .prepare(
            "SELECT cursor_value AS value FROM channel_cursors WHERE cursor_key = 'telegram_update'",
          )
          .get() !== undefined,
    );
    expect(
      store.state.connection
        .prepare(
          "SELECT cursor_value AS value FROM channel_cursors WHERE cursor_key = 'telegram_update'",
        )
        .get(),
    ).toEqual({ value: "6" });
    await channel.stop();
    store.close();
  });

  it("accepts an authorized callback as a verified human answer", async () => {
    const bot = fakeBot();
    const answers: HumanDecisionChannelAnswer[] = [];
    const { request, store, channel } = await fixture({ fetchFn: bot.fetchFn, answers });
    await channel.deliver(humanDecisionChannelRequest(request));
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const callbackData = markup.inline_keyboard?.[0]?.[0]?.callback_data;
    if (callbackData === undefined) throw new Error("callback token missing");
    await channel.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "callback-1",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: callbackData,
      },
    });
    expect(answers[0]).toMatchObject({
      response: { choice: "continue" },
      source: { channel: "telegram:approval", actorId: "100" },
    });
    await channel.stop();
    store.close();
  });

  it("ignores an unknown callback token", async () => {
    const bot = fakeBot();
    const answers: HumanDecisionChannelAnswer[] = [];
    const { store, channel } = await fixture({ fetchFn: bot.fetchFn, answers });
    await channel.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "unknown-callback",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: "unknown-token",
      },
    });
    expect(answers).toEqual([]);
    await channel.stop();
    store.close();
  });

  it("rejects callbacks from an unauthorized actor", async () => {
    const bot = fakeBot();
    const answers: HumanDecisionChannelAnswer[] = [];
    const { request, store, channel } = await fixture({ fetchFn: bot.fetchFn, answers });
    await channel.deliver(humanDecisionChannelRequest(request));
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const callbackData = markup.inline_keyboard?.[0]?.[0]?.callback_data;
    await channel.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "callback-unauthorized",
        from: { id: 999 },
        message: { message_id: 10, chat: { id: -200 } },
        data: callbackData,
      },
    });
    expect(answers).toEqual([]);
    await channel.stop();
    store.close();
  });

  it("collects exact reply text for an input choice", async () => {
    const bot = fakeBot();
    const answers: HumanDecisionChannelAnswer[] = [];
    const { request, store, channel } = await fixture({ fetchFn: bot.fetchFn, answers });
    await channel.deliver(humanDecisionChannelRequest(request));
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    const replan = markup.inline_keyboard?.[1]?.[0]?.callback_data;
    await channel.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "callback-replan",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: replan,
      },
    });
    await channel.handleUpdate({ update_id: 4 });
    await channel.handleUpdate({
      update_id: 5,
      message: { from: { id: 999 }, chat: { id: -200 }, text: "ignored" },
    });
    await channel.handleUpdate({
      update_id: 6,
      message: { from: { id: 100 }, chat: { id: -200 }, text: "ignored" },
    });
    await channel.handleUpdate({
      update_id: 7,
      message: {
        message_id: 12,
        chat: { id: -200 },
        from: { id: 100 },
        text: 42,
        reply_to_message: { message_id: 11 },
      },
    });
    await channel.handleUpdate({
      update_id: 8,
      message: {
        message_id: 12,
        chat: { id: -200 },
        from: { id: 100 },
        text: "  exact reply  ",
        reply_to_message: { message_id: 11 },
      },
    });
    expect(answers[0]?.response).toEqual({
      choice: "replan",
      input: { instructions: "  exact reply  " },
    });
    await channel.stop();
    store.close();
  });

  it("ignores a stale callback request", async () => {
    const request = createHumanDecisionRequest({
      runId: "stale-run",
      workflowName: "stale",
      nodeId: "approve",
      attemptId: "stale-attempt",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: {
        ...decisionPrompt({}),
        expiresAt: "2026-08-19T00:00:01.000Z",
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const bot = fakeBot();
    const answers: HumanDecisionChannelAnswer[] = [];
    const store = new HumanDecisionStore(await makeStateDatabasePath("telegram-stale"));
    await seedHumanDecisionRequest(store, request);
    const channel = new TelegramDecisionChannel({
      profileName: "approval",
      token: "token",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store,
      onAnswer: async (answer) => {
        answers.push(answer);
      },
      fetchFn: bot.fetchFn,
      ownerId: "owner-stale",
    });
    await channel.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await channel.deliver(humanDecisionChannelRequest(request));
    const send = bot.calls.find((call) => call.method === "sendMessage");
    const markup = send?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ callback_data?: string }>>;
    };
    await channel.handleUpdate({
      update_id: 30,
      callback_query: {
        id: "stale",
        from: { id: 100 },
        message: { message_id: 10, chat: { id: -200 } },
        data: markup.inline_keyboard?.[0]?.[0]?.callback_data,
      },
    });
    expect(answers).toEqual([]);
    await channel.stop();
    store.close();
  });

  it("ignores malformed provider updates", async () => {
    const { store, channel } = await fixture();
    await expect(channel.handleUpdate(null)).rejects.toThrow(/must be an object/);
    await expect(channel.handleUpdate({ update_id: "bad" })).resolves.toBeUndefined();
    await channel.stop();
    store.close();
  });

  it("stops an in-flight long poll through its abort signal", async () => {
    const fetchFn: TelegramFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const { store, channel } = await fixture({ fetchFn });
    await expect(channel.stop()).resolves.toBeUndefined();
    store.close();
  });

  it("settles confirmed messages after another channel wins", async () => {
    const bot = fakeBot();
    const { request, store, channel } = await fixture({ fetchFn: bot.fetchFn });
    await channel.deliver(humanDecisionChannelRequest(request));
    await channel.settle({
      schema: "pi-workflows.human-decision-accepted.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      response: { choice: "continue" },
      provenance: "human",
      source: { channel: "pi", actorId: "session", eventId: "event" },
      idempotencyKey: "event",
      acceptedAt: "2026-08-19T00:00:01.000Z",
      answerDigest: "sha256:" + "a".repeat(64),
      subjectDigest: request.subjectDigest,
      presentationDigest: request.presentationDigest,
      revision: request.revision,
    });
    expect(bot.calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
    await channel.stop();
    store.close();
  });

  it("adopts Telegram's message-not-modified settlement response", async () => {
    let sendId = 10;
    const fetchFn: TelegramFetch = async (url) => {
      const method = url.split("/").at(-1) ?? "";
      if (method === "getUpdates") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: [] };
          },
        };
      }
      if (method === "editMessageReplyMarkup") {
        return {
          ok: false,
          status: 400,
          async json() {
            return { ok: false, description: "Bad Request: message is not modified" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: method === "sendMessage" ? { message_id: sendId++ } : true };
        },
      };
    };
    const { request, store, channel } = await fixture({ fetchFn });
    await channel.deliver(humanDecisionChannelRequest(request));
    await channel.settle({
      schema: "pi-workflows.human-decision-cancellation.v1",
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      cancelledAt: new Date().toISOString(),
      reason: "cancelled",
    });
    expect(await store.listSettlements(request.decisionId, "telegram-approval")).toMatchObject([
      { state: "confirmed" },
    ]);
    await channel.stop();
    store.close();
  });

  it("records rejected Bot API delivery without treating it as ambiguous", async () => {
    const fetchFn: TelegramFetch = async (url) => {
      const method = url.split("/").at(-1) ?? "";
      if (method === "getUpdates") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: [] };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: false, description: "denied" };
        },
      };
    };
    const { request, store, channel } = await fixture({ fetchFn });
    expect(await channel.deliver(humanDecisionChannelRequest(request))).toMatchObject({
      status: "failed",
      errorCode: "telegram_rejected",
    });
    await channel.stop();
    store.close();
  });

  it("records failed settlement attempts and stops after the bound", async () => {
    let sendId = 10;
    const fetchFn: TelegramFetch = async (url) => {
      const method = url.split("/").at(-1) ?? "";
      if (method === "getUpdates") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: [] };
          },
        };
      }
      if (method === "editMessageReplyMarkup") throw new Error("edit failed");
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: method === "sendMessage" ? { message_id: sendId++ } : true };
        },
      };
    };
    const { request, store, channel } = await fixture({ fetchFn });
    await channel.deliver(humanDecisionChannelRequest(request));
    const cancellation = {
      schema: "pi-workflows.human-decision-cancellation.v1" as const,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      cancelledAt: new Date().toISOString(),
      reason: "cancelled" as const,
    };
    await channel.settle(cancellation);
    await channel.settle(cancellation);
    await channel.settle(cancellation);
    await channel.settle(cancellation);
    const settlements = await store.listSettlements(request.decisionId, "telegram-approval");
    expect(settlements).toHaveLength(3);
    expect(settlements.every((record) => record.state === "failed")).toBe(true);
    await channel.stop();
    store.close();
  });

  it("records ambiguous delivery and does not repeat it blindly", async () => {
    const fetchFn = vi.fn<TelegramFetch>(async (url) => {
      if (url.endsWith("/getUpdates")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: [] };
          },
        };
      }
      throw new Error("connection lost");
    });
    const { request, store, channel } = await fixture({ fetchFn });
    const first = await channel.deliver(humanDecisionChannelRequest(request));
    const calls = fetchFn.mock.calls.length;
    const second = await channel.deliver(humanDecisionChannelRequest(request));
    expect(first.status).toBe("unknown");
    expect(second).toMatchObject({
      status: "unknown",
      errorCode: "ambiguous_delivery_not_retried",
    });
    expect(fetchFn.mock.calls.length).toBe(calls);
    await channel.stop();
    store.close();
  });

  it("allows only one channel owner for a profile", async () => {
    const databasePath = await makeStateDatabasePath("telegram-lease");
    const request = fullRequest();
    const firstStore = new HumanDecisionStore(databasePath);
    await seedHumanDecisionRequest(firstStore, request);
    const first = new TelegramDecisionChannel({
      profileName: "approval",
      token: "test-token-not-real",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store: firstStore,
      onAnswer: async () => {},
      fetchFn: fakeBot().fetchFn,
      ownerId: "owner-a",
    });
    const second = new TelegramDecisionChannel({
      profileName: "approval",
      token: "test-token-not-real",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store: new HumanDecisionStore(databasePath),
      onAnswer: async () => {},
      fetchFn: fakeBot().fetchFn,
      ownerId: "owner-b",
    });
    await first.start();
    await second.start();
    await waitUntil(
      () =>
        firstStore.state.connection
          .prepare("SELECT owner_id AS ownerId FROM leases WHERE resource_id LIKE 'channel-%'")
          .get() !== undefined,
    );
    await expect(second.deliver(humanDecisionChannelRequest(request))).rejects.toThrow(/not owned/);
    await second.stop();
    await first.stop();
    firstStore.close();
  });
});
