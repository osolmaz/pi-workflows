import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEphemeralCredentialStore,
  createEphemeralModelStore,
  PiAgentGroupError,
  runPiAgentGroup,
  type PiAgentLifecycleEvent,
  type PiAgentRequest,
  type PiAgentSessionFactory,
} from "../src/builtins/pi-agent-group.js";
import { startMockOpenAiServer } from "./e2e/mock-openai.js";
import { makeTempDir } from "./helpers.js";

function request(id: string): PiAgentRequest {
  return {
    id,
    role: `Role ${id}`,
    prompt: `Prompt ${id}`,
    cwd: process.cwd(),
    tools: ["read", "grep", "find", "ls"],
    timeoutMs: 1_000,
  };
}

function message(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  };
}

function fixtureExtension(name: string): string {
  return path.resolve(`test/fixtures/pi-agent-extensions/${name}.ts`);
}

async function writeNativeFixtureConfig(agentDir: string, extensions?: string[]): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture-native",
      defaultModel: "fixture-model",
      defaultThinkingLevel: "high",
      extensions: extensions ?? [fixtureExtension("native-provider")],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(agentDir, "models-store.json"),
    JSON.stringify({
      "fixture-native": {
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            api: "fixture-api",
            provider: "fixture-native",
            baseUrl: "http://localhost:0",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
        checkedAt: 1,
      },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
}

function successfulFactory(
  delays: Record<string, number> = {},
  results: Record<string, string> = {},
  hooks: { active?: (value: number) => void; disposed?: (id: string) => void } = {},
): PiAgentSessionFactory {
  let active = 0;
  return async (agent) => {
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    return {
      model: { provider: "mock", id: "model" },
      thinkingLevel: "high",
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(_prompt, options) {
        options?.preflightResult?.(true);
        active += 1;
        hooks.active?.(active);
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta" },
          });
          listener({ type: "tool_execution_start", toolName: "read", args: { secret: true } });
        }
        await new Promise((resolve) => setTimeout(resolve, delays[agent.id] ?? 0));
        for (const listener of listeners)
          listener(message(results[agent.id] ?? `result ${agent.id}`));
        active -= 1;
        hooks.active?.(active);
      },
      async abort() {},
      dispose() {
        hooks.disposed?.(agent.id);
      },
    };
  };
}

describe("Pi agent groups", () => {
  it("validates requests and options before creating sessions", async () => {
    const signal = new AbortController().signal;
    await expect(runPiAgentGroup([], { maxConcurrency: 1, signal })).resolves.toEqual([]);
    await expect(
      runPiAgentGroup([{ ...request("bad id") }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/Invalid Pi agent id/);
    await expect(
      runPiAgentGroup([request("same"), request("same")], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/Duplicate Pi agent id/);
    await expect(
      runPiAgentGroup([{ ...request("bad-tool"), tools: ["bash" as "read"] }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/unsupported tool/);
    await expect(
      runPiAgentGroup([{ ...request("large"), prompt: "x".repeat(96_001) }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/at most 96000/);
    await expect(runPiAgentGroup([request("one")], { maxConcurrency: 0, signal })).rejects.toThrow(
      /maxConcurrency/,
    );
    await expect(
      runPiAgentGroup([{ ...request("control"), role: "bad\u007frole" }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/control characters/);
    const reasonlessAbort = { aborted: true, reason: undefined } as AbortSignal;
    await expect(
      runPiAgentGroup([request("reasonless")], {
        maxConcurrency: 1,
        signal: reasonlessAbort,
      }),
    ).rejects.toThrow(/operation cancelled/);
  });

  it("returns final results in request order and emits safe lifecycle facts", async () => {
    const events: PiAgentLifecycleEvent[] = [];
    const disposed: string[] = [];
    let clock = 0;
    const results = await runPiAgentGroup([request("slow"), request("fast")], {
      maxConcurrency: 2,
      signal: new AbortController().signal,
      sessionFactory: successfulFactory(
        { slow: 20, fast: 1 },
        { slow: '{"answer":"slow"}', fast: '{"answer":"fast"}' },
        { disposed: (id) => disposed.push(id) },
      ),
      onLifecycle: (event) => {
        events.push(event);
      },
      now: () => (clock += 300),
    });

    expect(results.map((result) => result.id)).toEqual(["slow", "fast"]);
    expect(results.map((result) => result.text)).toEqual([
      '{"answer":"slow"}',
      '{"answer":"fast"}',
    ]);
    expect(results.every((result) => result.model === "mock/model")).toBe(true);
    expect(disposed.sort()).toEqual(["fast", "slow"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "slow", state: "running", phase: "thinking" }),
        expect.objectContaining({ id: "slow", state: "completed", phase: "completed" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("Prompt slow");
  });

  it("enforces maximum concurrency", async () => {
    let maximum = 0;
    await runPiAgentGroup([request("a"), request("b"), request("c")], {
      maxConcurrency: 2,
      signal: new AbortController().signal,
      sessionFactory: successfulFactory(
        { a: 10, b: 10, c: 10 },
        {},
        { active: (value) => (maximum = Math.max(maximum, value)) },
      ),
    });
    expect(maximum).toBe(2);
  });

  it("fails on a provider error and disposes the session", async () => {
    let disposed = false;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.(true);
          for (const listener of listeners) listener(message("", "error", "provider failed"));
        },
        async abort() {},
        dispose() {
          disposed = true;
        },
      };
    };
    await expect(
      runPiAgentGroup([request("provider")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/provider failed/);
    expect(disposed).toBe(true);
  });

  it("bounds final output", async () => {
    await expect(
      runPiAgentGroup([request("large")], {
        maxConcurrency: 1,
        maxFinalChars: 10,
        signal: new AbortController().signal,
        sessionFactory: successfulFactory({}, { large: "x".repeat(11) }),
      }),
    ).rejects.toThrow(/final output is too large/);
  });

  it("times out, aborts, and disposes a running session", async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    let disposed = false;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt(_prompt, options) {
        options?.preflightResult?.(true);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        aborted = true;
        release?.();
      },
      dispose() {
        disposed = true;
      },
    });
    await expect(
      runPiAgentGroup([{ ...request("slow"), timeoutMs: 20 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("preserves parent cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    await expect(
      runPiAgentGroup([request("cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: successfulFactory(),
      }),
    ).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<PiAgentGroupError>);
  });

  it("cancels queued work after the first material failure", async () => {
    const created: string[] = [];
    const events: PiAgentLifecycleEvent[] = [];
    const factory: PiAgentSessionFactory = async (agent) => {
      created.push(agent.id);
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        async prompt() {
          throw new Error("first failed");
        },
        async abort() {},
        dispose() {},
      };
    };
    await expect(
      runPiAgentGroup([request("first"), request("queued")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
        onLifecycle: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow(/first failed/);
    expect(created).toEqual(["first"]);
    expect(events).toContainEqual(
      expect.objectContaining({ id: "queued", state: "cancelled", phase: "cancelled" }),
    );
    await expect(
      runPiAgentGroup([request("first-no-progress"), request("queued-no-progress")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/first failed/);
  });

  it("rejects duplicate tools and invalid limits", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup([{ ...request("tools"), tools: ["read", "read"] }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/duplicate tool/);
    await expect(
      runPiAgentGroup([{ ...request("timeout"), timeoutMs: 0 }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      runPiAgentGroup([request("output")], {
        maxConcurrency: 1,
        maxFinalChars: 0,
        signal,
      }),
    ).rejects.toThrow(/maxFinalChars/);
  });

  it("rejects unsafe request fields and oversized groups", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup(
        Array.from({ length: 9 }, (_, index) => request(`agent-${index}`)),
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/at most 8/);
    await expect(
      runPiAgentGroup([{ ...request("role"), role: "" }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/role/);
    await expect(
      runPiAgentGroup([{ ...request("role-control"), role: "bad\nrole" }], {
        maxConcurrency: 1,
        signal,
      }),
    ).rejects.toThrow(/control characters/);
    await expect(
      runPiAgentGroup([{ ...request("cwd"), cwd: "" }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/cwd/);
    await expect(
      runPiAgentGroup([{ ...request("no-tools"), tools: [] }], { maxConcurrency: 1, signal }),
    ).rejects.toThrow(/at least one tool/);
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("provider"),
            model: { provider: "", id: "model" },
            thinkingLevel: "high",
          },
        ],
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/model provider/);
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("model-id"),
            model: { provider: "mock", id: "" },
            thinkingLevel: "high",
          },
        ],
        {
          maxConcurrency: 1,
          signal,
        },
      ),
    ).rejects.toThrow(/model id/);
  });

  it("reports prompt rejection and missing final output", async () => {
    const rejected: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt(_prompt, options) {
        options?.preflightResult?.(false);
      },
      async abort() {},
      dispose() {},
    });
    await expect(
      runPiAgentGroup([request("rejected")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: rejected,
      }),
    ).rejects.toThrow(/rejected prompt/);

    const missing: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt(_prompt, options) {
        options?.preflightResult?.(true);
      },
      async abort() {},
      dispose() {},
    });
    await expect(
      runPiAgentGroup([request("missing")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: missing,
      }),
    ).rejects.toThrow(/no final output/);
  });

  it("accepts string content and ignores lifecycle callback failures", async () => {
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "medium",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(_prompt, options) {
          options?.preflightResult?.(true);
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: { role: "assistant", content: '{"ok":true}', stopReason: "stop" },
            });
          }
        },
        async abort() {},
        dispose() {},
      };
    };
    const [result] = await runPiAgentGroup([request("string")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      onLifecycle: () => {
        throw new Error("display failed");
      },
    });
    expect(result?.text).toBe('{"ok":true}');
    expect(result?.thinkingLevel).toBe("medium");
  });

  it("uses the latest assistant text and ignores unknown tool phases", async () => {
    const events: PiAgentLifecycleEvent[] = [];
    let clock = 0;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          for (const listener of listeners) {
            listener({ type: "tool_execution_start", toolName: "bash" });
            listener(message("old failure", "error", "old"));
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", text: "private" },
                  { type: "text", text: "final" },
                ],
                stopReason: "stop",
              },
            });
          }
        },
        async abort() {},
        dispose() {},
      };
    };
    const [result] = await runPiAgentGroup([request("latest")], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      now: () => (clock += 300),
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    expect(result?.text).toBe("final");
    expect(events.map((event) => event.phase)).not.toContain("tool: bash");
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("handles ignored messages, empty output, and provider aborts", async () => {
    const makeFactory =
      (events: Record<string, unknown>[]): PiAgentSessionFactory =>
      async () => {
        const listeners = new Set<(event: Record<string, unknown>) => void>();
        return {
          model: { provider: "mock", id: "model" },
          thinkingLevel: "off",
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            for (const event of events) for (const listener of listeners) listener(event);
          },
          async abort() {},
          dispose() {},
        };
      };
    await expect(
      runPiAgentGroup([request("empty")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([
          { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
          { type: "message_end", message: { role: "user", content: "ignored" } },
          message("   "),
        ]),
      }),
    ).rejects.toThrow(/assistant text is empty/);
    await expect(
      runPiAgentGroup([request("aborted")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([message("", "aborted")]),
      }),
    ).rejects.toThrow(/provider stopped/);
    await expect(
      runPiAgentGroup([request("non-text")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: makeFactory([
          {
            type: "message_end",
            message: { role: "assistant", content: 42, stopReason: "stop" },
          },
        ]),
      }),
    ).rejects.toThrow(/assistant text is empty/);
  });

  it("includes bounded abort diagnostics", async () => {
    let release: (() => void) | undefined;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        release?.();
        throw new Error("abort failed");
      },
      dispose() {},
    });
    await expect(
      runPiAgentGroup([{ ...request("abort-diagnostic"), timeoutMs: 5 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/abort failed/);
  });

  it("bounds unexpected error messages", async () => {
    const blank: PiAgentSessionFactory = async () => {
      throw "";
    };
    await expect(
      runPiAgentGroup([request("blank")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: blank,
      }),
    ).rejects.toThrow(/unknown failure/);

    const verbose: PiAgentSessionFactory = async () => {
      throw new Error("x".repeat(3_000));
    };
    await expect(
      runPiAgentGroup([request("verbose")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: verbose,
      }),
    ).rejects.toSatisfy((error: Error) => error.message.length < 2_100);
  });

  it("reports missing models and cleanup failures", async () => {
    const noModel: PiAgentSessionFactory = async () => ({
      model: undefined,
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {},
      async abort() {},
      dispose() {},
    });
    await expect(
      runPiAgentGroup([request("model")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: noModel,
      }),
    ).rejects.toThrow(/No usable Pi model/);

    const cleanup: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          for (const listener of listeners) listener(message("ok"));
        },
        async abort() {},
        dispose() {
          throw new Error("dispose failed");
        },
      };
    };
    await expect(
      runPiAgentGroup([request("cleanup")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: cleanup,
      }),
    ).rejects.toThrow(/cleanup failed/);

    const primary: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        throw new Error("prompt failed first");
      },
      async abort() {},
      dispose() {
        throw new Error("cleanup failed second");
      },
    });
    await expect(
      runPiAgentGroup([request("primary")], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: primary,
      }),
    ).rejects.toThrow(/prompt failed first/);
  });

  it("cancels a session while its prompt is running", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let aborted = false;
    const factory: PiAgentSessionFactory = async () => ({
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
      subscribe: () => () => {},
      async prompt() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async abort() {
        aborted = true;
        release?.();
      },
      dispose() {},
    });
    const running = runPiAgentGroup([request("cancel-running")], {
      maxConcurrency: 1,
      signal: controller.signal,
      sessionFactory: factory,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("cancel running"));
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(aborted).toBe(true);
  });

  it("normalizes timeout and cancellation failures during session creation", async () => {
    const timedOutFactory: PiAgentSessionFactory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw "late creation failure";
    };
    await expect(
      runPiAgentGroup([{ ...request("late-timeout"), timeoutMs: 1 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: timedOutFactory,
      }),
    ).rejects.toMatchObject({ code: "timed out" });

    const controller = new AbortController();
    const cancelledFactory: PiAgentSessionFactory = async () => {
      controller.abort(new Error("cancel during creation"));
      throw "creation stopped";
    };
    await expect(
      runPiAgentGroup([request("creation-cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: cancelledFactory,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels before creating a session when the run clock aborts", async () => {
    const controller = new AbortController();
    let created = false;
    await expect(
      runPiAgentGroup([request("clock-cancel")], {
        maxConcurrency: 1,
        signal: controller.signal,
        sessionFactory: async () => {
          created = true;
          return await successfulFactory()!(request("clock-cancel"), {
            signal: controller.signal,
          });
        },
        now: () => {
          controller.abort(new Error("clock cancelled"));
          return 0;
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(created).toBe(false);
  });

  it("does not prompt when a session times out during creation", async () => {
    let prompted = false;
    let aborted = false;
    const factory: PiAgentSessionFactory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "off",
        subscribe: () => () => {},
        async prompt() {
          prompted = true;
        },
        async abort() {
          aborted = true;
        },
        dispose() {},
      };
    };
    await expect(
      runPiAgentGroup([{ ...request("creation"), timeoutMs: 5 }], {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/timed out/);
    expect(prompted).toBe(false);
    expect(aborted).toBe(true);
  });

  it("bounds repeated lifecycle phase updates", async () => {
    let updates = 0;
    let clock = 0;
    const factory: PiAgentSessionFactory = async () => {
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      return {
        model: { provider: "mock", id: "model" },
        thinkingLevel: "high",
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          for (let index = 0; index < 100; index += 1) {
            for (const listener of listeners) {
              listener({
                type: "tool_execution_start",
                toolName: index % 2 === 0 ? "read" : "grep",
              });
            }
          }
          for (const listener of listeners) listener(message("ok"));
        },
        async abort() {},
        dispose() {},
      };
    };
    const phaseRequest = request("phases");
    delete phaseRequest.timeoutMs;
    await runPiAgentGroup([phaseRequest], {
      maxConcurrency: 1,
      signal: new AbortController().signal,
      sessionFactory: factory,
      now: () => (clock += 300),
      onLifecycle: () => {
        updates += 1;
      },
    });
    expect(updates).toBeLessThanOrEqual(68);
  });

  it("keeps credential and model refresh state in memory", async () => {
    const agentDir = await makeTempDir("pi-agent-group-credentials");
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        api: { type: "api_key", key: "test-key" },
        command: { type: "api_key" },
        oauth: { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 1 },
      }),
      "utf8",
    );
    const catalogText = JSON.stringify({
      cached: { models: [], checkedAt: 1, etag: '"catalog"' },
    });
    await fs.writeFile(path.join(agentDir, "models-store.json"), catalogText, "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const controller = new AbortController();
      const credentials = await createEphemeralCredentialStore(controller.signal);
      expect(await credentials.list()).toEqual([
        { providerId: "api", type: "api_key" },
        { providerId: "command", type: "api_key" },
        { providerId: "oauth", type: "oauth" },
      ]);
      const firstRead = await credentials.read("api");
      expect(firstRead).toEqual({ type: "api_key", key: "test-key" });
      if (firstRead?.type === "api_key") firstRead.key = "changed-only-in-copy";
      expect(await credentials.read("api")).toEqual({ type: "api_key", key: "test-key" });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failed = credentials.modify("api", async () => {
        await gate;
        throw new Error("refresh failed");
      });
      const recovered = credentials.modify("api", async (current) => ({
        ...(current ?? { type: "api_key" as const }),
        key: "refreshed-in-memory",
      }));
      release();
      await expect(failed).rejects.toThrow("refresh failed");
      await expect(recovered).resolves.toEqual({
        type: "api_key",
        key: "refreshed-in-memory",
      });
      await expect(credentials.modify("api", async () => undefined)).resolves.toEqual({
        type: "api_key",
        key: "refreshed-in-memory",
      });
      await credentials.delete("api");
      expect(await credentials.read("api")).toBeUndefined();

      const models = await createEphemeralModelStore(controller.signal);
      const cached = await models.read("cached");
      expect(cached).toEqual({ models: [], checkedAt: 1, etag: '"catalog"' });
      if (cached !== undefined) cached.checkedAt = 2;
      expect(await models.read("cached")).toEqual({
        models: [],
        checkedAt: 1,
        etag: '"catalog"',
      });
      await models.write("mock", { models: [], checkedAt: 1 });
      expect(await models.read("mock")).toEqual({ models: [], checkedAt: 1 });
      await models.delete("mock");
      expect(await models.read("mock")).toBeUndefined();
      expect(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8")).toBe(catalogText);

      controller.abort(new Error("stop"));
      await expect(credentials.read("oauth")).rejects.toThrow("stop");
      await expect(credentials.list()).rejects.toThrow("stop");
      await expect(credentials.modify("oauth", async (value) => value)).rejects.toThrow("stop");
      await expect(credentials.delete("oauth")).rejects.toThrow("stop");
      await expect(models.read("cached")).rejects.toThrow("stop");
      await expect(models.write("mock", { models: [] })).rejects.toThrow("stop");
      await expect(models.delete("cached")).rejects.toThrow("stop");
      expect(JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8"))).toEqual({
        api: { type: "api_key", key: "test-key" },
        command: { type: "api_key" },
        oauth: { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 1 },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed credential files without exposing their contents", async () => {
    const agentDir = await makeTempDir("pi-agent-group-invalid-credentials");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const invalidValues: unknown[] = [
      null,
      [],
      "PRIVATE_CREDENTIAL_TEXT",
      { bad: null },
      { bad: [] },
      { bad: { type: "api_key", key: 1 } },
      { bad: { type: "oauth" } },
      { bad: { type: "oauth", refresh: "r" } },
      { bad: { type: "oauth", refresh: "r", access: "a" } },
      { bad: { type: "oauth", refresh: "r", access: "a", expires: "later" } },
    ];
    try {
      for (const invalid of invalidValues) {
        await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(invalid), "utf8");
        await expect(createEphemeralCredentialStore(new AbortController().signal)).rejects.toThrow(
          "Could not load Pi credentials for isolated agents",
        );
      }
      await fs.writeFile(path.join(agentDir, "auth.json"), "PRIVATE_NOT_JSON", "utf8");
      let message = "";
      try {
        await createEphemeralCredentialStore(new AbortController().signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Could not load Pi credentials for isolated agents");
      expect(message).not.toContain("PRIVATE_NOT_JSON");
      await fs.rm(path.join(agentDir, "auth.json"));
      await expect(
        createEphemeralCredentialStore(new AbortController().signal),
      ).resolves.toBeDefined();
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled before load"));
      await expect(createEphemeralCredentialStore(cancelled.signal)).rejects.toThrow(
        "cancelled before load",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed model catalogs without exposing their contents", async () => {
    const agentDir = await makeTempDir("pi-agent-group-invalid-models");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const invalidValues: unknown[] = [
      null,
      [],
      "PRIVATE_MODEL_CATALOG_TEXT",
      { bad: null },
      { bad: { models: null } },
      { bad: { models: [], checkedAt: "later" } },
      { bad: { models: [], lastModified: "later" } },
      { bad: { models: [], etag: 1 } },
    ];
    try {
      for (const invalid of invalidValues) {
        await fs.writeFile(
          path.join(agentDir, "models-store.json"),
          JSON.stringify(invalid),
          "utf8",
        );
        await expect(createEphemeralModelStore(new AbortController().signal)).rejects.toThrow(
          "Could not load Pi model catalog for isolated agents",
        );
      }
      await fs.writeFile(path.join(agentDir, "models-store.json"), "PRIVATE_NOT_JSON", "utf8");
      let message = "";
      try {
        await createEphemeralModelStore(new AbortController().signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Could not load Pi model catalog for isolated agents");
      expect(message).not.toContain("PRIVATE_NOT_JSON");
      await fs.rm(path.join(agentDir, "models-store.json"));
      await expect(createEphemeralModelStore(new AbortController().signal)).resolves.toBeDefined();
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled before model load"));
      await expect(createEphemeralModelStore(cancelled.signal)).rejects.toThrow(
        "cancelled before model load",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs provider extensions through isolated per-agent SDK runtimes", async () => {
    const agentDir = await makeTempDir("pi-agent-group-agent");
    const cwd = await makeTempDir("pi-agent-group-project");
    const lifecycleFile = path.join(agentDir, "lifecycle.log");
    const providerExtension = path.resolve("test/fixtures/pi-agent-extensions/native-provider.ts");
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "PRIVATE_CONTEXT_MARKER", "utf8");
    await writeNativeFixtureConfig(agentDir, [providerExtension]);
    const settingsBefore = await fs.readFile(path.join(agentDir, "settings.json"), "utf8");
    const modelsStoreBefore = await fs.readFile(path.join(agentDir, "models-store.json"), "utf8");
    const authBefore = await fs.readFile(path.join(agentDir, "auth.json"), "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_API_KEY", "provider-owned-key");
    vi.stubEnv("PI_AGENT_FIXTURE_LIFECYCLE_FILE", lifecycleFile);
    try {
      const results = await runPiAgentGroup(
        [
          { ...request("sdk-a"), cwd, tools: ["read"] },
          { ...request("sdk-b"), cwd, tools: ["read"] },
        ],
        { maxConcurrency: 2, signal: new AbortController().signal },
      );
      expect(results).toEqual([
        expect.objectContaining({
          id: "sdk-a",
          text: '{"answer":"ok"}',
          model: "fixture-native/fixture-model",
          thinkingLevel: "high",
        }),
        expect.objectContaining({
          id: "sdk-b",
          text: '{"answer":"ok"}',
          model: "fixture-native/fixture-model",
          thinkingLevel: "high",
        }),
      ]);
      expect((await fs.readFile(lifecycleFile, "utf8")).trim().split("\n").toSorted()).toEqual([
        "session_shutdown",
        "session_shutdown",
        "session_shutdown",
        "session_start",
        "session_start",
      ]);
      await expect(fs.stat(path.join(agentDir, "sessions"))).rejects.toThrow();
      expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
      expect(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8")).toBe(
        modelsStoreBefore,
      );
      expect(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")).toBe(authBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admits explicit behavior extensions without activating their tools", async () => {
    const agentDir = await makeTempDir("pi-agent-group-behavior");
    const cwd = await makeTempDir("pi-agent-group-behavior-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("behavior"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("behavior")],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          model: "fixture-native/fixture-model",
          text: '{"answer":"ok"}',
        }),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails before prompting when provider-owned authentication is unavailable", async () => {
    const agentDir = await makeTempDir("pi-agent-group-missing-auth");
    const cwd = await makeTempDir("pi-agent-group-missing-auth-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_DISABLE_AUTH", "1");
    try {
      await expect(
        runPiAgentGroup([{ ...request("missing-auth"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/has no provider authentication/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails without the exact provider extension or cached model", async () => {
    const agentDir = await makeTempDir("pi-agent-group-exact-dispatch");
    const cwd = await makeTempDir("pi-agent-group-exact-project");
    await writeNativeFixtureConfig(agentDir, []);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("missing-provider"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/has no provider extension/);
      await writeNativeFixtureConfig(agentDir);
      await expect(
        runPiAgentGroup(
          [
            {
              ...request("missing-model"),
              cwd,
              model: { provider: "fixture-native", id: "missing" },
              thinkingLevel: "high",
            },
          ],
          { maxConcurrency: 1, signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/has no model/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discovers a legacy provider owner and uses its configured authentication", async () => {
    const mock = await startMockOpenAiServer(() => ({
      kind: "text",
      text: '{"answer":"legacy"}',
    }));
    const agentDir = await makeTempDir("pi-agent-group-legacy");
    const cwd = await makeTempDir("pi-agent-group-legacy-project");
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture-legacy",
        defaultModel: "fixture-legacy-model",
        defaultThinkingLevel: "high",
        extensions: [fixtureExtension("legacy-provider")],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "models-store.json"),
      JSON.stringify({
        "fixture-legacy": {
          models: [
            {
              id: "fixture-legacy-model",
              name: "Fixture legacy model",
              api: "openai-completions",
              provider: "fixture-legacy",
              baseUrl: mock.baseUrl,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
          checkedAt: 1,
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_FIXTURE_BASE_URL", mock.baseUrl);
    vi.stubEnv("PI_AGENT_FIXTURE_API_KEY", "legacy-provider-key");
    try {
      await expect(
        runPiAgentGroup([{ ...request("legacy"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          model: "fixture-legacy/fixture-legacy-model",
          text: '{"answer":"legacy"}',
        }),
      ]);
      expect(mock.requests).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("rejects a failed child provider registration instead of using a built-in fallback", async () => {
    const mock = await startMockOpenAiServer(() => ({ kind: "text", text: "must not run" }));
    const agentDir = await makeTempDir("pi-agent-group-invalid-registration");
    const cwd = await makeTempDir("pi-agent-group-invalid-registration-project");
    const shutdownFile = path.join(agentDir, "invalid-provider-shutdown.log");
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "fixture-openai-model",
        defaultThinkingLevel: "high",
        extensions: [fixtureExtension("invalid-openai-provider")],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "models-store.json"),
      JSON.stringify({
        openai: {
          models: [
            {
              id: "fixture-openai-model",
              name: "Fixture OpenAI model",
              api: "openai-responses",
              provider: "openai",
              baseUrl: mock.baseUrl,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
          checkedAt: 1,
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
      "utf8",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_AGENT_INVALID_PROVIDER_SHUTDOWN_FILE", shutdownFile);
    try {
      await expect(
        runPiAgentGroup([{ ...request("invalid-registration"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/could not register provider extension: registration failed/);
      expect(mock.requests).toHaveLength(0);
      expect((await fs.readFile(shutdownFile, "utf8")).trim().split("\n")).toEqual([
        "session_shutdown",
        "session_shutdown",
      ]);
    } finally {
      vi.unstubAllEnvs();
      await mock.close();
    }
  });

  it("surfaces child extension shutdown failures without private details", async () => {
    const agentDir = await makeTempDir("pi-agent-group-child-shutdown-failure");
    const cwd = await makeTempDir("pi-agent-group-child-shutdown-failure-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      let message = "";
      try {
        await runPiAgentGroup([{ ...request("child-shutdown-failure"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("child-shutdown-failure")],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("could not settle child extensions");
      expect(message).not.toContain("PRIVATE_CHILD_CLEANUP_FAILURE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects workflow capabilities and built-in tool overrides", async () => {
    const agentDir = await makeTempDir("pi-agent-group-unsafe-extension");
    const cwd = await makeTempDir("pi-agent-group-unsafe-project");
    await writeNativeFixtureConfig(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("workflow-capability"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("workflow-capability")],
        }),
      ).rejects.toThrow(/exposes workflow control/);
      await expect(
        runPiAgentGroup([{ ...request("read-override"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("read-override")],
        }),
      ).rejects.toThrow(/replaces a built-in tool/);
      let cleanupMessage = "";
      try {
        await runPiAgentGroup([{ ...request("shutdown-failure"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [fixtureExtension("shutdown-failure")],
        });
      } catch (error) {
        cleanupMessage = error instanceof Error ? error.message : String(error);
      }
      expect(cleanupMessage).toContain("could not settle extension preflight");
      expect(cleanupMessage).not.toContain("PRIVATE_PRECHECK_CLEANUP_FAILURE");
      await expect(
        runPiAgentGroup([{ ...request("primary-before-cleanup"), cwd }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
          behaviorExtensionPaths: [
            fixtureExtension("workflow-capability"),
            fixtureExtension("shutdown-failure"),
          ],
        }),
      ).rejects.toThrow(/exposes workflow control/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects incomplete, mixed, and slash-command dispatch requests", async () => {
    const signal = new AbortController().signal;
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("partial"),
            model: { provider: "fixture-native", id: "fixture-model" },
          },
        ],
        { maxConcurrency: 1, signal, sessionFactory: successfulFactory() },
      ),
    ).rejects.toThrow(/model and thinkingLevel together/);
    await expect(
      runPiAgentGroup([{ ...request("slash"), prompt: "  /workflow status" }], {
        maxConcurrency: 1,
        signal,
        sessionFactory: successfulFactory(),
      }),
    ).rejects.toThrow(/must not invoke an extension command/);
    await expect(
      runPiAgentGroup(
        [
          {
            ...request("first-dispatch"),
            model: { provider: "fixture-native", id: "fixture-model" },
            thinkingLevel: "high",
          },
          {
            ...request("second-dispatch"),
            model: { provider: "fixture-native", id: "other-model" },
            thinkingLevel: "high",
          },
        ],
        { maxConcurrency: 2, signal },
      ),
    ).rejects.toThrow(/one exact model dispatch/);
  });

  it("excludes Pi Workflows wrapper packages before their factories run", async () => {
    const agentDir = await makeTempDir("pi-agent-group-wrapper");
    const cwd = await makeTempDir("pi-agent-group-wrapper-project");
    const wrapper = path.join(agentDir, "wrapper");
    const marker = path.join(agentDir, "wrapper-loaded");
    await fs.mkdir(wrapper);
    await fs.writeFile(
      path.join(wrapper, "package.json"),
      JSON.stringify({
        name: "fixture-workflows-wrapper",
        type: "module",
        dependencies: { "@osolmaz/pi-workflows": "0.12.0" },
        pi: { extensions: ["./index.ts"] },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(wrapper, "index.ts"),
      `import fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
      "utf8",
    );
    await writeNativeFixtureConfig(agentDir, [
      fixtureExtension("native-provider"),
      path.join(wrapper, "index.ts"),
    ]);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    try {
      await expect(
        runPiAgentGroup([{ ...request("wrapper"), cwd, tools: ["read"] }], {
          maxConcurrency: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toHaveLength(1);
      await expect(fs.stat(marker)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("continues remaining work when fail-fast is disabled", async () => {
    const created: string[] = [];
    const factory: PiAgentSessionFactory = async (agent) => {
      created.push(agent.id);
      if (agent.id === "bad") throw new Error("bad agent");
      return await successfulFactory()!(agent, {
        signal: new AbortController().signal,
      });
    };
    await expect(
      runPiAgentGroup([request("bad"), request("good")], {
        maxConcurrency: 1,
        failFast: false,
        signal: new AbortController().signal,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/bad agent/);
    expect(created).toEqual(["bad", "good"]);
  });
});
