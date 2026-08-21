import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelegramDecisionChannel,
  loadDecisionChannelConfig,
  renderDecisionText,
  renderTelegramParts,
  verifyTelegramTokenFile,
  writeDecisionChannelProfile,
  type HumanDecisionChannelAnswer,
  type TelegramFetch,
} from "../src/extension/decision-channels.js";
import { humanDecisionChannelRequest } from "../src/workflows/decision-presentation.js";
import {
  HumanDecisionStore,
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../src/workflows/human-decision.js";
import { decisionPrompt, makeTempDir } from "./helpers.js";

function request() {
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
      prompt: decisionPrompt({ plan: "a" }),
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
}

function presentedRequest(text: string) {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
      runId: "run-readable",
      workflowName: "workflow-readable",
      nodeId: "approve",
      attemptId: "attempt-readable",
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
        title: "Approve readable plan",
        subject: { privateMachineField: "not-for-display" },
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
  const calls: Array<{ method: string; payload: Record<string, unknown>; url: string }> = [];
  let nextMessage = 10;
  const fetchFn: TelegramFetch = async (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, payload, url });
    if (method === "sendMessage") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: nextMessage++ } };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: method === "getUpdates" ? [] : true };
      },
    };
  };
  return { calls, fetchFn };
}

async function channel(options: {
  answers?: HumanDecisionChannelAnswer[];
  fetchFn?: TelegramFetch;
  configDir?: string;
  runs?: string;
}) {
  const answers = options.answers ?? [];
  const runs = options.runs ?? (await makeTempDir("telegram-decision-runs"));
  const configDir = options.configDir ?? (await makeTempDir("telegram-decision-config"));
  return new TelegramDecisionChannel({
    profileName: "approval",
    token: "test-token-not-real",
    allowedUserIds: ["100"],
    allowedChatIds: ["-200"],
    store: new HumanDecisionStore(runs),
    configDir,
    onAnswer: async (answer) => {
      answers.push(answer);
    },
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    apiBase: "https://telegram.test",
    ownerId: "owner-a",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram decision presentation", () => {
  it("renders readable text without exposing the canonical subject", () => {
    const rendered = renderDecisionText(presentedRequest("Apply the safe change."));
    expect(rendered).toContain("Review this readable plan.");
    expect(rendered).toContain("Apply the safe change.");
    expect(rendered).toContain("What should change?");
    expect(rendered).not.toContain("privateMachineField");
    expect(rendered).not.toContain("not-for-display");
    expect(rendered).not.toContain('{"');
  });

  it("splits complete long Unicode content without truncation", () => {
    const content = Array.from({ length: 7_000 }, (_, index) =>
      index % 71 === 0 ? "\n" : "🙂",
    ).join("");
    const decision = presentedRequest(content);
    const parts = renderTelegramParts(decision);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(20);
    expect(parts.every((part) => part.length <= 4_096)).toBe(true);
    expect(parts.some((part) => part.includes("…"))).toBe(false);
    expect(parts.at(-1)).toContain("Choices");
    expect(parts.at(-1)).toContain("What should change?");
    const deliveredBodies = parts
      .map((part) => part.replace(/^Part \d+\/\d+\nDecision [a-f0-9]+\n\n/u, ""))
      .join("");
    expect([...deliveredBodies].filter((character) => character === "🙂")).toHaveLength(
      [...content].filter((character) => character === "🙂").length,
    );
    for (const part of parts) {
      const lastCodeUnit = part.charCodeAt(part.length - 1);
      expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
    }
  });
});

describe("TelegramDecisionChannel", () => {
  it("rejects invalid profile, token, and allowlist construction", async () => {
    const configDir = await makeTempDir("telegram-constructor-config");
    const store = new HumanDecisionStore(await makeTempDir("telegram-constructor-runs"));
    const base = {
      profileName: "approval",
      token: "fixture",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store,
      configDir,
      onAnswer: async () => {},
    };
    expect(() => new TelegramDecisionChannel({ ...base, profileName: "bad/name" })).toThrow(
      /profile/,
    );
    expect(() => new TelegramDecisionChannel({ ...base, token: "" })).toThrow(/token/);
    expect(() => new TelegramDecisionChannel({ ...base, allowedUserIds: [] })).toThrow(/numeric/);
    expect(() => new TelegramDecisionChannel({ ...base, allowedChatIds: ["bad"] })).toThrow(
      /numeric/,
    );
  });
  it("records every multipart message and puts controls only on the final part", async () => {
    const runs = await makeTempDir("telegram-multipart-runs");
    const bot = fakeBot();
    const adapter = await channel({ fetchFn: bot.fetchFn, runs });
    const decision = presentedRequest("Readable line.\n".repeat(700));
    const expectedParts = renderTelegramParts(decision);
    expect((await adapter.deliver(decision)).status).toBe("confirmed");
    const sends = bot.calls.filter((call) => call.method === "sendMessage");
    expect(sends.map((call) => call.payload.text)).toEqual(expectedParts);
    expect(sends.slice(0, -1).every((call) => call.payload.reply_markup === undefined)).toBe(true);
    expect(sends.at(-1)?.payload.reply_markup).toBeDefined();
    const records = await new HumanDecisionStore(runs).listDeliveries(
      decision.decisionId,
      "telegram-approval",
    );
    expect(
      records.filter(
        (record) =>
          record.schema === "pi-workflows.human-decision-delivery.v1" &&
          record.phase === "part" &&
          record.state === "confirmed",
      ),
    ).toHaveLength(expectedParts.length);
    expect(records.some((record) => record.state === "unknown")).toBe(false);
    expect(JSON.stringify(records)).not.toContain("-200");
    expect(JSON.stringify(records)).not.toContain("message_id");
    await adapter.stop();
  });

  it("binds callbacks and preserves exact ForceReply text", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const bot = fakeBot();
    const adapter = await channel({ answers, fetchFn: bot.fetchFn });
    const decision = request();
    expect((await adapter.deliver(decision)).status).toBe("confirmed");
    expect((await adapter.deliver(decision)).status).toBe("confirmed");
    expect(bot.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    const initial = bot.calls.find((call) => call.method === "sendMessage");
    const keyboard = initial?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const replanToken = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    expect(replanToken).toMatch(/^piw:/);

    await adapter.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "callback-1",
        data: replanToken,
        from: { id: 100 },
        message: { chat: { id: -200 } },
      },
    });
    const forceReply = bot.calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(forceReply?.payload.reply_markup).toEqual({ force_reply: true, selective: true });
    const exact = "  use the smaller option\nkeep this  ";
    await adapter.handleUpdate({
      update_id: 2,
      message: {
        message_id: 20,
        text: exact,
        from: { id: 100 },
        chat: { id: -200 },
        reply_to_message: { message_id: 11 },
      },
    });
    expect(answers).toHaveLength(1);
    expect(answers[0]?.response).toEqual({
      choice: "replan",
      input: { instructions: exact },
    });
    expect(answers[0]?.request.requestDigest).toBe(decision.requestDigest);
    expect(bot.calls.every((call) => !JSON.stringify(call.payload).includes("test-token"))).toBe(
      true,
    );
    await adapter.stop();
  });

  it("accepts a verified no-input callback", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const bot = fakeBot();
    const adapter = await channel({ answers, fetchFn: bot.fetchFn });
    await adapter.deliver(request());
    const initial = bot.calls.find((call) => call.method === "sendMessage");
    const keyboard = initial?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await adapter.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "continue-callback",
        data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
        from: { id: 100 },
        message: { chat: { id: -200 } },
      },
    });
    expect(answers[0]).toMatchObject({
      response: { choice: "continue" },
      source: { channel: "telegram:approval", actorId: "100" },
    });
    await adapter.stop();
  });

  it("restores callback and ForceReply bindings after a Pi restart", async () => {
    const runs = await makeTempDir("telegram-restart-runs");
    const configDir = await makeTempDir("telegram-restart-config");
    const firstBot = fakeBot();
    const first = await channel({ fetchFn: firstBot.fetchFn, runs, configDir });
    await first.deliver(request());
    const initial = firstBot.calls.find((call) => call.method === "sendMessage");
    const keyboard = initial?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await first.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "callback-restart",
        data: keyboard.inline_keyboard[1]?.[0]?.callback_data,
        from: { id: 100 },
        message: { chat: { id: -200 } },
      },
    });
    await first.stop();

    const answers: HumanDecisionChannelAnswer[] = [];
    const secondBot = fakeBot();
    const second = await channel({ answers, fetchFn: secondBot.fetchFn, runs, configDir });
    const exact = "restart text  ";
    await second.handleUpdate({
      update_id: 2,
      message: {
        message_id: 30,
        text: exact,
        from: { id: 100 },
        chat: { id: -200 },
        reply_to_message: { message_id: 11 },
      },
    });
    expect(answers[0]?.response).toEqual({
      choice: "replan",
      input: { instructions: exact },
    });
    await second.stop();
  });

  it("ignores malformed, unrelated, and unbound updates", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const bot = fakeBot();
    const adapter = await channel({ answers, fetchFn: bot.fetchFn });
    await expect(adapter.handleUpdate(null)).rejects.toThrow(/must be an object/);
    await adapter.handleUpdate({ update_id: 1 });
    await adapter.handleUpdate({ update_id: 2, callback_query: {} });
    await adapter.handleUpdate({
      update_id: 3,
      callback_query: {
        from: { id: 100 },
        message: { chat: { id: -200 } },
        data: "unknown",
      },
    });
    await adapter.handleUpdate({
      update_id: 4,
      message: { from: { id: 100 }, chat: { id: -200 }, text: "unbound" },
    });
    await adapter.handleUpdate({ update_id: 5, message: {} });
    expect(answers).toEqual([]);
    await adapter.stop();
  });

  it("ignores users and chats outside the private allowlist", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const bot = fakeBot();
    const adapter = await channel({ answers, fetchFn: bot.fetchFn });
    await adapter.deliver(request());
    const initial = bot.calls.find((call) => call.method === "sendMessage");
    const keyboard = initial?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await adapter.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "bad",
        data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
        from: { id: 999 },
        message: { chat: { id: -200 } },
      },
    });
    expect(answers).toEqual([]);
    await adapter.stop();
  });

  it("records a definite HTTP delivery failure and permits a safe retry", async () => {
    let sends = 0;
    const fetchFn: TelegramFetch = async (url) => {
      if (url.endsWith("/sendMessage")) {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            status: 400,
            async json() {
              return {};
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: { message_id: 10 } };
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
    const adapter = await channel({ fetchFn });
    const decision = request();
    expect((await adapter.deliver(decision)).status).toBe("failed");
    expect((await adapter.deliver(decision)).status).toBe("confirmed");
    expect(sends).toBe(2);
    await adapter.stop();
  });

  it("retries only chats that did not already receive a multi-chat decision", async () => {
    const counts = new Map<string, number>();
    const fetchFn: TelegramFetch = async (url, init) => {
      if (!url.endsWith("/sendMessage")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: true };
          },
        };
      }
      const chatId = String((JSON.parse(String(init?.body)) as { chat_id: string }).chat_id);
      const count = (counts.get(chatId) ?? 0) + 1;
      counts.set(chatId, count);
      if (chatId === "-201" && count === 1) {
        return {
          ok: false,
          status: 400,
          async json() {
            return {};
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: count } };
        },
      };
    };
    const adapter = new TelegramDecisionChannel({
      profileName: "approval",
      token: "fixture",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200", "-201"],
      store: new HumanDecisionStore(await makeTempDir("telegram-multichat-runs")),
      configDir: await makeTempDir("telegram-multichat-config"),
      onAnswer: async () => {},
      fetchFn,
      apiBase: "https://telegram.test",
    });
    const decision = request();
    expect((await adapter.deliver(decision)).status).toBe("failed");
    expect((await adapter.deliver(decision)).status).toBe("confirmed");
    expect(counts.get("-200")).toBe(1);
    expect(counts.get("-201")).toBe(2);
    await adapter.stop();
  });

  it("ignores an expired callback binding", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const bot = fakeBot();
    const adapter = await channel({ answers, fetchFn: bot.fetchFn });
    const expired = { ...request(), expiresAt: "2000-01-01T00:00:00.000Z" };
    await adapter.deliver(expired);
    const initial = bot.calls.find((call) => call.method === "sendMessage");
    const keyboard = initial?.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await adapter.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "expired",
        data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
        from: { id: 100 },
        message: { chat: { id: -200 } },
      },
    });
    expect(answers).toEqual([]);
    await adapter.stop();
  });

  it("settles confirmed messages once and bounds settlement failures", async () => {
    const bot = fakeBot();
    const runs = await makeTempDir("telegram-settle-runs");
    const store = new HumanDecisionStore(runs);
    const configDir = await makeTempDir("telegram-settle-config");
    const adapter = await channel({ fetchFn: bot.fetchFn, runs, configDir });
    const decision = request();
    const accepted = {
      schema: "pi-workflows.human-decision-accepted.v1" as const,
      provenance: "human" as const,
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      subjectDigest: `sha256:${"b".repeat(64)}`,
      presentationDigest: decision.presentationDigest,
      revision: decision.revision,
      response: { choice: "continue" },
      source: { channel: "pi", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
      acceptedAt: "2026-08-19T00:01:00.000Z",
      answerDigest: `sha256:${"a".repeat(64)}`,
    };
    await adapter.deliver(decision);
    await Promise.all([adapter.settle(accepted), adapter.settle(accepted)]);
    await adapter.settle(accepted);
    expect(bot.calls.filter((call) => call.method === "editMessageReplyMarkup")).toHaveLength(1);
    expect(await store.listSettlements(decision.decisionId, "telegram-approval")).toHaveLength(1);
    await adapter.stop();

    const failingRuns = await makeTempDir("telegram-settle-fail-runs");
    const failingStore = new HumanDecisionStore(failingRuns);
    let editAttempts = 0;
    const failing = await channel({
      runs: failingRuns,
      configDir: await makeTempDir("telegram-settle-fail-config"),
      fetchFn: async (url) => {
        if (url.endsWith("/sendMessage")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, result: { message_id: 1 } };
            },
          };
        }
        editAttempts += 1;
        return {
          ok: false,
          status: 500,
          async json() {
            return {};
          },
        };
      },
    });
    await failing.deliver(decision);
    const cancellation = {
      schema: "pi-workflows.human-decision-cancellation.v1" as const,
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      cancelledAt: "2026-08-19T00:01:00.000Z",
      reason: "cancelled" as const,
    };
    for (let attempt = 0; attempt < 10; attempt += 1) await failing.settle(cancellation);
    expect(editAttempts).toBe(3);
    expect(
      await failingStore.listSettlements(decision.decisionId, "telegram-approval"),
    ).toHaveLength(3);
    await failing.stop();
  });

  it("adopts Telegram's already-settled response as a confirmed settlement", async () => {
    const runs = await makeTempDir("telegram-settle-adopt-runs");
    const store = new HumanDecisionStore(runs);
    const adapter = await channel({
      runs,
      configDir: await makeTempDir("telegram-settle-adopt-config"),
      fetchFn: async (url) => {
        if (url.endsWith("/sendMessage")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, result: { message_id: 1 } };
            },
          };
        }
        return {
          ok: false,
          status: 400,
          async json() {
            return { ok: false, description: "Bad Request: message is not modified" };
          },
        };
      },
    });
    const decision = request();
    await adapter.deliver(decision);
    await adapter.settle({
      schema: "pi-workflows.human-decision-cancellation.v1",
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      cancelledAt: "2026-08-19T00:01:00.000Z",
      reason: "cancelled",
    });
    expect(await store.listSettlements(decision.decisionId, "telegram-approval")).toMatchObject([
      { state: "confirmed" },
    ]);
    await adapter.stop();
  });

  it("bounds malformed and rejected Bot API responses", async () => {
    const malformed = await channel({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: {} };
        },
      }),
    });
    expect((await malformed.deliver(request())).status).toBe("unknown");
    await malformed.stop();

    const rejected = await channel({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: false };
        },
      }),
    });
    expect((await rejected.deliver(request())).status).toBe("failed");
    await rejected.stop();
  });

  it("does not retry an ambiguous send automatically", async () => {
    let sends = 0;
    const fetchFn: TelegramFetch = async (url) => {
      if (url.endsWith("/sendMessage")) {
        sends += 1;
        throw new Error("network timeout");
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: [] };
        },
      };
    };
    const runs = await makeTempDir("telegram-ambiguous-runs");
    const configDir = await makeTempDir("telegram-ambiguous-config");
    const adapter = await channel({ fetchFn, runs, configDir });
    const decision = request();
    expect((await adapter.deliver(decision)).status).toBe("unknown");
    expect((await adapter.deliver(decision)).status).toBe("unknown");
    expect(sends).toBe(1);
    await adapter.stop();
  });

  it("does not retry a delivery intent left uncertain by a crash", async () => {
    const runs = await makeTempDir("telegram-intent-runs");
    const configDir = await makeTempDir("telegram-intent-config");
    const decision = request();
    const store = new HumanDecisionStore(runs);
    await store.recordDelivery(decision, "telegram-approval", {
      schema: "pi-workflows.human-decision-delivery.v1",
      attemptId: "attempt-before-crash",
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      presentationDigest: decision.presentationDigest,
      channel: "telegram:approval",
      phase: "part",
      state: "intent",
      createdAt: "2026-08-19T00:00:00.000Z",
      recipientIndex: 1,
      partIndex: 1,
      partCount: 1,
      contentDigest: `sha256:${"c".repeat(64)}`,
    });
    let sends = 0;
    const fetchFn: TelegramFetch = async () => {
      sends += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: true };
        },
      };
    };
    const adapter = await channel({ fetchFn, runs, configDir });
    expect((await adapter.deliver(decision)).status).toBe("unknown");
    expect(sends).toBe(0);
    await adapter.stop();
  });

  it("hands the shared long-poll lease to another Pi process", async () => {
    vi.useFakeTimers();
    const configDir = await makeTempDir("telegram-lease-config");
    const runs = await makeTempDir("telegram-lease-runs");
    let firstPolls = 0;
    let secondPolls = 0;
    const pendingFetch =
      (counter: () => void): TelegramFetch =>
      async (_url, init) => {
        counter();
        return await new Promise((resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new Error("aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      };
    const first = new TelegramDecisionChannel({
      profileName: "approval",
      token: "test-token-not-real",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store: new HumanDecisionStore(runs),
      configDir,
      onAnswer: async () => {},
      fetchFn: pendingFetch(() => {
        firstPolls += 1;
      }),
      apiBase: "https://telegram.test",
      ownerId: "owner-first",
    });
    const second = new TelegramDecisionChannel({
      profileName: "approval",
      token: "test-token-not-real",
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
      store: new HumanDecisionStore(runs),
      configDir,
      onAnswer: async () => {},
      fetchFn: pendingFetch(() => {
        secondPolls += 1;
      }),
      apiBase: "https://telegram.test",
      ownerId: "owner-second",
    });
    await first.start();
    await first.start();
    await second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstPolls).toBe(1);
    expect(secondPolls).toBe(0);
    await first.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondPolls).toBe(1);
    await second.stop();
  });

  it("verifies and merges private token-file profiles without copying a token", async () => {
    const configDir = await makeTempDir("telegram-profile-config");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "test-token-not-real\n", { mode: 0o600 });
    const calls: string[] = [];
    const fetchFn: TelegramFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { id: 1 } };
        },
      };
    };
    await verifyTelegramTokenFile(tokenFile, fetchFn, "https://telegram.test");
    await writeDecisionChannelProfile({
      configDir,
      audience: "operator",
      profile: "approval",
      credential: "approval",
      tokenFile,
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
    });
    await writeDecisionChannelProfile({
      configDir,
      audience: "maintainer",
      profile: "maintenance",
      credential: "maintenance",
      tokenFile,
      allowedUserIds: ["101"],
      allowedChatIds: ["-201"],
    });
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(Object.keys(loaded?.channels.audiences ?? {})).toEqual(["operator", "maintainer"]);
    expect(Object.keys(loaded?.credentials ?? {})).toEqual(["approval", "maintenance"]);
    expect((await fs.stat(path.join(configDir, "channels.json"))).mode & 0o077).toBe(0);
    expect((await fs.stat(path.join(configDir, "credentials.json"))).mode & 0o077).toBe(0);
    expect(await fs.readFile(path.join(configDir, "credentials.json"), "utf8")).not.toContain(
      "test-token-not-real",
    );
    expect(calls).toHaveLength(1);
  });

  it("loads only mode-0600 token-file references", async () => {
    const configDir = await makeTempDir("telegram-config");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "test-token-not-real\n", { mode: 0o600 });
    await fs.writeFile(
      path.join(configDir, "channels.json"),
      `${JSON.stringify({
        schema: "pi-workflows.channels.v1",
        audiences: {
          operator: {
            channels: ["pi", "telegram:approval"],
            accept: "first-valid-answer",
          },
        },
        telegramProfiles: {
          approval: {
            credential: "approval",
            allowedUserIds: ["100"],
            allowedChatIds: ["-200"],
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(configDir, "credentials.json"),
      `${JSON.stringify({
        schema: "pi-workflows.credentials.v1",
        telegram: { approval: { tokenFile } },
      })}\n`,
      { mode: 0o600 },
    );
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.credentials.approval).toBe("test-token-not-real");
    await fs.chmod(tokenFile, 0o644);
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/0600/);
  });
});
