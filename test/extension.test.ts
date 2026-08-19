import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { projectControllerStorePath } from "../src/controllers/store.js";
import piWorkflows from "../src/extension/index.js";
import type { WorkflowToolInput } from "../src/extension/workflow-tool.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { listRunBundles, readRunBundle } from "../src/workflows/store.js";
import { stripAnsi } from "../src/workflows/text.js";
import type { HumanDecisionRequest } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

type ToolResult = {
  content: { type: string; text: string }[];
  details: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: WorkflowToolInput) => Promise<ToolResult>;
};

type RegisteredToolSpec = {
  name: string;
  execute: (
    toolCallId: string,
    params: WorkflowToolInput,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: FakeContext,
  ) => Promise<ToolResult>;
};

type RegisteredCommand = {
  handler: (args: string, ctx: FakeContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Promise<{ value: string; label: string }[] | null>;
};

type SentMessage = {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details?: Record<string, unknown>;
  };
  options?: { deliverAs?: string; triggerTurn?: boolean };
};

type WidgetComponent = {
  render: (width: number) => string[];
  invalidate: () => void;
};

type WidgetTheme = {
  bold: (text: string) => string;
  fg: (color: string, text: string) => string;
};

type WidgetFactory = (_tui: unknown, theme: WidgetTheme) => WidgetComponent;

const TEST_THEME: WidgetTheme = {
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  fg: (color, text) => `\u001b[${color === "accent" ? 36 : 32}m${text}\u001b[0m`,
};

type FakeContext = {
  cwd: string;
  mode: "tui" | "rpc";
  hasUI: boolean;
  isIdle: () => boolean;
  abort: () => void;
  sessionManager: {
    getSessionId: () => string;
    getLeafId: () => string | null;
    getSessionFile: () => string | undefined;
    getBranch: () => never[];
  };
  ui: {
    notify: (message: string, type?: string) => void;
    setWidget: (key: string, content: string[] | WidgetFactory | undefined) => void;
    setStatus: (key: string, text: string | undefined) => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (title: string, initial?: string) => Promise<string | undefined>;
  };
};

/**
 * Harness that stands in for the pi runtime: it captures the registered
 * command/tool and plays the model, answering each delivered step prompt by
 * calling the workflow tool.
 */
function makeHarness(options: {
  cwd: string;
  respond: (prompt: string, tool: RegisteredTool) => void;
  sessionId?: string;
  mode?: "tui" | "rpc";
  select?: (title: string, choices: string[]) => Promise<string | undefined>;
  input?: (title: string, initial?: string) => Promise<string | undefined>;
  exec?: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}) {
  const notifications: string[] = [];
  const widgets: (string[] | WidgetFactory | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: string[] = [];
  const messageRenderers = new Map<string, unknown>();
  const listeners = new Map<
    string,
    ((event?: unknown, ctx?: FakeContext) => void | Promise<void>)[]
  >();
  const shortcuts = new Map<string, (ctx: FakeContext) => void | Promise<void>>();
  const commands = new Map<string, RegisteredCommand>();
  let tool: RegisteredTool | null = null;
  let idle = true;
  let abortCalls = 0;

  const ctx: FakeContext = {
    cwd: options.cwd,
    mode: options.mode ?? "tui",
    hasUI: true,
    isIdle: () => idle,
    abort: () => {
      abortCalls += 1;
      idle = true;
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "test-session",
      getLeafId: () => null,
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    ui: {
      notify: (message) => notifications.push(message),
      setWidget: (_key, content) => widgets.push(content),
      setStatus: (_key, text) => statuses.push(text),
      select: async (title, choices) => await options.select?.(title, choices),
      input: async (title, initial) => await options.input?.(title, initial),
    },
  };

  const pi = {
    registerCommand: (name: string, spec: RegisteredCommand) => {
      commands.set(name, spec);
    },
    registerTool: (spec: RegisteredToolSpec) => {
      tool = {
        name: spec.name,
        execute: async (toolCallId, params) =>
          await spec.execute(
            toolCallId,
            params,
            new AbortController().signal,
            () => undefined,
            ctx,
          ),
      };
    },
    registerShortcut: (
      key: string,
      spec: { handler: (ctx: FakeContext) => void | Promise<void> },
    ) => {
      shortcuts.set(key, spec.handler);
    },
    exec:
      options.exec ?? (async () => ({ stdout: "", stderr: "unavailable", code: 1, killed: false })),
    registerMessageRenderer: (customType: string, renderer: unknown) => {
      messageRenderers.set(customType, renderer);
    },
    on: (event: string, listener: (event?: unknown, ctx?: FakeContext) => void | Promise<void>) => {
      const queue = listeners.get(event) ?? [];
      queue.push(listener);
      listeners.set(event, queue);
    },
    sendUserMessage: (prompt: string) => {
      sentUserMessages.push(prompt);
      idle = false;
      queueMicrotask(() => options.respond(prompt, tool as RegisteredTool));
    },
    sendMessage: (message: SentMessage["message"], messageOptions?: SentMessage["options"]) => {
      sentMessages.push({
        message,
        ...(messageOptions === undefined ? {} : { options: messageOptions }),
      });
      if (
        message.customType === "pi-workflows-agent-step" &&
        messageOptions?.triggerTurn === true
      ) {
        idle = false;
        queueMicrotask(() => options.respond(message.content, tool as RegisteredTool));
      }
    },
  };

  piWorkflows(pi as never);
  const workflowCommand = commands.get("workflow");
  if (!workflowCommand || !tool) {
    throw new Error("extension did not register workflow command and tool");
  }
  return {
    ctx,
    notifications,
    widgets,
    statuses,
    sentMessages,
    sentUserMessages,
    messageRenderers,
    get abortCalls() {
      return abortCalls;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    command: workflowCommand,
    commands,
    tool: tool as RegisteredTool,
    shortcuts,
    emit: (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) {
        void listener(payload, ctx);
      }
    },
    emitAsync: async (event: string, payload?: unknown) =>
      await Promise.all(
        (listeners.get(event) ?? []).map(async (listener) => await listener(payload, ctx)),
      ),
  };
}

async function writeEchoWorkflow(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".pi", "workflows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "mini.workflow.ts"),
    `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "mini",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: () => "Say hi.",
      expectedOutput: '{ "reply": "…" }',
    }),
  },
  edges: [],
});
`,
    "utf8",
  );
}

async function writeTimeoutWorkflow(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".pi", "workflows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "timeout.workflow.ts"),
    `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "timeout",
  presentationPrompt: () => { throw new Error("must not present failed run"); },
  startAt: "wait",
  nodes: { wait: agent({ prompt: () => "Wait.", timeoutMs: 30 }) },
  edges: [],
});
`,
    "utf8",
  );
}

async function writeControllerWithChild(cwd: string): Promise<void> {
  const controllerDir = path.join(cwd, ".pi", "controllers");
  const workflowDir = path.join(cwd, ".pi", "workflows");
  await fs.mkdir(controllerDir, { recursive: true });
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(
    path.join(controllerDir, "demo.controller.ts"),
    `import {
  conditionTrue,
  defineController,
} from "@osolmaz/pi-workflows/controllers";

export default defineController({
  name: "demo",
  initialStatus: () => ({ phase: "new" }),
  async reconcile(ctx, resource) {
    const child = await ctx.workflows.ensure({
      requestKey: \`child:\${resource.metadata.generation}\`,
      workflow: "child",
      input: { value: resource.spec.value },
    });
    const workflowRun = {
      requestId: child.requestId,
      ...(child.runId ? { runId: child.runId } : {}),
      state: child.state,
      attempt: child.attempt,
    };
    if (child.state === "succeeded") {
      return ctx.settled({
        controllerStatus: { phase: "done" },
        conditions: [conditionTrue("Ready", "Complete")],
        workflowRun,
      });
    }
    return ctx.requeueAfter(10, {
      controllerStatus: { phase: "running" },
      workflowRun,
    });
  },
});
`,
  );
  await fs.writeFile(
    path.join(workflowDir, "child.workflow.ts"),
    `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "child",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => input }) },
  edges: [],
});
`,
  );
}

async function writeHumanDecisionWorkflow(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".pi", "workflows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "human.workflow.ts"),
    `import { choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge, textInput } from "@osolmaz/pi-workflows";
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  replan: choice({ label: "Replan", input: textInput({ name: "instructions", prompt: "What should change?" }) }),
});
export default defineWorkflow({
  name: "human",
  startAt: "approve",
  nodes: {
    approve: humanDecision({ audience: "operator", choices, request: ({ input }) => ({ title: "Approve", body: input }) }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
    replanned: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
  },
  edges: [humanDecisionEdge({ from: "approve", choices, cases: { continue: "continued", replan: "replanned" } })],
});
`,
    "utf8",
  );
}

function stepFromPrompt(prompt: string): { step: string; attempt: string } | null {
  const match = prompt.match(/"step": "([^"]+)", "attempt": "([^"]+)"/);
  return match ? { step: match[1] as string, attempt: match[2] as string } : null;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pi-workflows extension", () => {
  beforeEach(async () => {
    // Interactive runs are tracked in the project run queue; keep that
    // store inside a temp dir so tests never touch the real home state.
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", await makeTempDir("pi-workflows-ext-controllers"));
    vi.stubEnv("PI_WORKFLOWS_CONFIG_DIR", await makeTempDir("pi-workflows-ext-config"));
    vi.stubEnv("HERDR_ENV", "0");
  });

  it("runs a workflow end to end through the command and tool", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({
        cwd,
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("call-1", {
              action: "submit",
              ...contract,
              output: { reply: "hi" },
            });
          }
        },
      });

      await harness.command.handler("mini say hi", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("completed")));

      expect(harness.notifications.some((note) => note.includes("Workflow mini started"))).toBe(
        true,
      );
      expect(harness.notifications.some((note) => note.includes("Workflow mini completed"))).toBe(
        true,
      );
      expect(harness.widgets.length).toBeGreaterThan(0);
      const widget = [...harness.widgets].reverse().find((entry) => typeof entry === "function");
      expect(widget).toBeTypeOf("function");
      const renderedWidget =
        typeof widget === "function"
          ? widget(undefined, TEST_THEME).render(120).join("\n")
          : undefined;
      expect(stripAnsi(renderedWidget ?? "")).toContain("✓ ● reply");
      expect(renderedWidget).toContain("\u001b[32m✓\u001b[0m");
      expect(renderedWidget).not.toMatch(/[┏┌┃]/u);
      expect(harness.sentMessages).toHaveLength(1);
      expect(harness.sentMessages[0]?.message.customType).toBe("pi-workflows-agent-step");
      expect(harness.sentUserMessages).toHaveLength(0);

      const runDirs = await fs.readdir(runsDir);
      expect(runDirs).toHaveLength(1);

      // The run went through the durable queue and was released as done.
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        const runs = queue.listWorkflowRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          workflowName: "mini",
          status: "done",
          runnerId: null,
          claimToken: null,
        });
      } finally {
        queue.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects model-tool answers for protected human decisions", async () => {
    const cwd = await makeTempDir("pi-workflows-human-tool");
    const runsDir = await makeTempDir("pi-workflows-human-tool-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    await writeHumanDecisionWorkflow(cwd);
    const harness = makeHarness({ cwd, mode: "rpc", respond: () => {} });

    await harness.command.handler(
      'human --input-json {"task":"approve","original":true}',
      harness.ctx,
    );
    await waitFor(() => harness.notifications.some((note) => note.includes("verified human")));
    await expect(
      harness.tool.execute("model-answer", {
        action: "answer",
        input: { choice: "continue" },
      }),
    ).rejects.toThrow(/verified human answer/);
  });

  it("continues a protected decision through Pi UI and preserves exact replan text", async () => {
    const cwd = await makeTempDir("pi-workflows-human-pi");
    const runsDir = await makeTempDir("pi-workflows-human-pi-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    await writeHumanDecisionWorkflow(cwd);
    const exact = "  use option B\nkeep this exact  ";
    const harness = makeHarness({
      cwd,
      respond: () => {},
      select: async () => "Replan",
      input: async () => exact,
    });

    await harness.command.handler(
      'human --input-json {"task":"approve","original":true}',
      harness.ctx,
    );
    await waitFor(() => harness.notifications.some((note) => note.includes("continuation")));
    await waitFor(async () =>
      (await listRunBundles(runsDir)).some((bundle) => bundle.state.status === "completed"),
    );
    const bundles = await listRunBundles(runsDir);
    const completed = bundles.find((bundle) => bundle.state.status === "completed");
    expect(completed?.state.parentRunId).toBeDefined();
    expect(completed?.state.input).toEqual({ task: "approve", original: true });
    expect(completed?.state.finalOutput).toEqual({
      input: { task: "approve", original: true },
      answer: { choice: "replan", input: { instructions: exact } },
    });
    expect(JSON.stringify(completed?.state.finalOutput)).not.toContain("actorId");
  });

  it("cancels a pending human decision and rejects later acceptance", async () => {
    const cwd = await makeTempDir("pi-workflows-human-cancel");
    const runsDir = await makeTempDir("pi-workflows-human-cancel-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    await writeHumanDecisionWorkflow(cwd);
    const harness = makeHarness({ cwd, mode: "rpc", respond: () => {} });

    await harness.command.handler("human", harness.ctx);
    await waitFor(() => harness.notifications.some((note) => note.includes("verified human")));
    await harness.command.handler("cancel", harness.ctx);
    const waiting = (await listRunBundles(runsDir)).find(
      (bundle) => bundle.state.status === "waiting",
    );
    const request = waiting?.state.finalOutput as
      | { decisionId: string; requestDigest: string }
      | undefined;
    expect(request).toBeDefined();
    const store = new HumanDecisionStore(runsDir);
    expect(await store.readCancellation(request!.decisionId)).toMatchObject({
      reason: "cancelled",
      requestDigest: request!.requestDigest,
    });
  });

  it("recovers an accepted human decision into one deterministic continuation", async () => {
    const cwd = await makeTempDir("pi-workflows-human-recovery");
    const runsDir = await makeTempDir("pi-workflows-human-recovery-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    await writeHumanDecisionWorkflow(cwd);
    const first = makeHarness({ cwd, mode: "rpc", respond: () => {}, sessionId: "session-a" });

    await first.command.handler("human", first.ctx);
    await waitFor(() => first.notifications.some((note) => note.includes("verified human")));
    const waiting = (await listRunBundles(runsDir)).find(
      (bundle) => bundle.state.status === "waiting",
    );
    const request = waiting?.state.finalOutput as HumanDecisionRequest | undefined;
    if (request === undefined) throw new Error("missing human decision request");
    const decisionStore = new HumanDecisionStore(runsDir);
    const staleRequest: HumanDecisionRequest = {
      ...request,
      decisionId: "decision-stale-request",
      requestDigest: `sha256:${"0".repeat(64)}`,
      attemptId: "stale-attempt",
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    await decisionStore.createRequest(staleRequest);
    await decisionStore.accept(staleRequest, {
      decisionId: staleRequest.decisionId,
      requestDigest: staleRequest.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "session-a", eventId: "stale-event" },
      idempotencyKey: "stale-event",
    });
    await decisionStore.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "pi", actorId: "session-a", eventId: "recovery-event" },
      idempotencyKey: "recovery-event",
    });

    const outsider = makeHarness({ cwd, mode: "rpc", respond: () => {}, sessionId: "session-b" });
    await outsider.emitAsync("session_start", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await listRunBundles(runsDir)).filter(
        (bundle) => bundle.state.parentRunId === waiting?.state.runId,
      ),
    ).toHaveLength(0);

    const second = makeHarness({ cwd, mode: "rpc", respond: () => {}, sessionId: "session-a" });
    await second.emitAsync("session_start", {});
    await waitFor(async () => {
      const bundles = await listRunBundles(runsDir);
      return bundles.some(
        (bundle) =>
          bundle.state.parentRunId === waiting?.state.runId && bundle.state.status === "completed",
      );
    });
    const continuations = (await listRunBundles(runsDir)).filter(
      (bundle) => bundle.state.parentRunId === waiting?.state.runId,
    );
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.state.finalOutput).toMatchObject({
      answer: { choice: "continue" },
    });
  });

  it("shows the native Herdr shortcut and opens the exact run bundle in piw", async () => {
    const cwd = await makeTempDir("pi-workflows-herdr-ext");
    const runsDir = await makeTempDir("pi-workflows-herdr-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", path.relative(process.cwd(), runsDir));
    vi.stubEnv("HERDR_ENV", "1");
    const execCalls: { command: string; args: string[] }[] = [];
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({
        cwd,
        select: async (_title, choices) => choices.find((choice) => choice === "Split right"),
        exec: async (command, args) => {
          execCalls.push({ command, args: [...args] });
          const key = `${command} ${args.join(" ")}`;
          if (key === "piw --version") {
            return { stdout: "piw 0.1.0\n", stderr: "", code: 0, killed: false };
          }
          if (key === "herdr pane current --current") {
            return {
              stdout: JSON.stringify({
                result: {
                  pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
                },
              }),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          if (key.includes("plugin list")) {
            return {
              stdout: JSON.stringify({
                result: {
                  plugins: [{ plugin_id: "osolmaz.pi-workflows", enabled: true }],
                },
              }),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          if (key === "herdr api snapshot") {
            return {
              stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          if (key.includes("plugin pane open")) {
            return {
              stdout: JSON.stringify({
                result: {
                  plugin_pane: {
                    pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" },
                  },
                },
              }),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          return { stdout: "", stderr: `unexpected: ${key}`, code: 1, killed: false };
        },
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("call-herdr", {
              action: "submit",
              ...contract,
              output: { reply: "hi" },
            });
          }
        },
      });

      await harness.emitAsync("session_start", {});
      await harness.command.handler("mini", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("completed")));
      await waitFor(() => {
        const widget = [...harness.widgets].reverse().find((entry) => typeof entry === "function");
        if (typeof widget !== "function") return false;
        return stripAnsi(widget(undefined, TEST_THEME).render(120).join("\n")).includes(
          "Ctrl+Shift+R piw",
        );
      });

      expect(harness.commands.has("piw")).toBe(true);
      expect(harness.shortcuts.has("ctrl+shift+r")).toBe(true);
      await harness.shortcuts.get("ctrl+shift+r")?.(harness.ctx);
      const opened = execCalls.find(
        (call) => call.args.slice(0, 3).join(" ") === "plugin pane open",
      );
      const runDirEnv = opened?.args.find((arg) => arg.startsWith("PI_WORKFLOWS_RUN_DIR="));
      expect(runDirEnv).toBeDefined();
      expect(
        runDirEnv?.slice("PI_WORKFLOWS_RUN_DIR=".length).startsWith(`${runsDir}${path.sep}`),
      ).toBe(true);
      expect(opened?.args).toContain("--target-pane");
      expect(opened?.args.at(-1)).toBe("right");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not register the Herdr shortcut outside Herdr", async () => {
    const cwd = await makeTempDir("pi-workflows-no-herdr-ext");
    const harness = makeHarness({ cwd, respond: () => {} });
    expect(harness.commands.has("piw")).toBe(true);
    expect(harness.shortcuts.has("ctrl+shift+r")).toBe(false);
  });

  it("removes assistant tail text after an accepted workflow submission", async () => {
    const cwd = await makeTempDir("pi-workflows-tail");
    const runsDir = await makeTempDir("pi-workflows-tail-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({
        cwd,
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("submit-tail", {
              action: "submit",
              ...contract,
              output: { reply: "hi" },
            });
          }
        },
      });

      await harness.command.handler("mini say hi", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("completed")));

      const assistantMessage = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The workflow submission is complete." },
          { type: "text", text: "This reply must not appear." },
        ],
      };
      await harness.emitAsync("turn_end", { message: assistantMessage, toolResults: [] });
      const [replacement] = await harness.emitAsync("message_end", {
        message: assistantMessage,
      });
      expect(replacement).toEqual({
        message: {
          ...assistantMessage,
          content: [{ type: "thinking", thinking: "The workflow submission is complete." }],
        },
      });

      await harness.emitAsync("agent_end", { messages: [] });
      const [normal] = await harness.emitAsync("message_end", { message: assistantMessage });
      expect(normal).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets the model list, start, and inspect workflows through one tool", async () => {
    const cwd = await makeTempDir("pi-workflows-tool-control");
    const runsDir = await makeTempDir("pi-workflows-tool-control-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({
        cwd,
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("submit-1", {
              action: "submit",
              ...contract,
              output: { reply: "hi" },
            });
          }
        },
      });

      const listed = await harness.tool.execute("list-1", { action: "list" });
      expect(listed.details.workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "mini", source: "project" }),
          expect.objectContaining({ name: "monitor", source: "builtin" }),
        ]),
      );

      const queued = await harness.tool.execute("start-1", {
        action: "start",
        workflow: "mini",
        input: { task: "say hi" },
      });
      expect(queued.details).toMatchObject({ action: "start", workflow: "mini", queued: true });
      expect(harness.notifications.some((note) => note.includes("Workflow mini started"))).toBe(
        false,
      );

      await harness.emitAsync("agent_settled");
      await waitFor(() =>
        harness.sentMessages.some(
          (entry) => entry.message.customType === "pi-workflows-agent-step",
        ),
      );
      const stepMessage = harness.sentMessages.find(
        (entry) => entry.message.customType === "pi-workflows-agent-step",
      );
      expect(stepMessage).toMatchObject({
        message: {
          display: true,
          details: {
            schema: "pi-workflows.agent-step-message.v1",
            kind: "step",
            contract: { workflowName: "mini", nodeId: "reply" },
          },
        },
        options: { deliverAs: "followUp", triggerTurn: true },
      });
      expect(harness.sentUserMessages).toHaveLength(0);
      expect(harness.messageRenderers.has("pi-workflows-agent-step")).toBe(true);

      await waitFor(() => harness.notifications.some((note) => note.includes("completed")));
      await harness.emitAsync("agent_settled");

      const status = await harness.tool.execute("status-1", { action: "status" });
      expect(status.details).toMatchObject({ workflowName: "mini", status: "completed" });
      await expect(
        harness.tool.execute("status-missing", { action: "status", runId: "missing-run" }),
      ).rejects.toThrow(/Workflow run not found/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds and paginates workflow lists returned to the model", async () => {
    const cwd = await makeTempDir("pi-workflows-tool-list");
    vi.stubEnv("HOME", await makeTempDir("pi-workflows-tool-list-home"));
    try {
      const workflowDir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(workflowDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 60 }, async (_, index) => {
          const name = `item-${String(index).padStart(3, "0")}.workflow.ts`;
          await fs.writeFile(path.join(workflowDir, name), "", "utf8");
        }),
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      const first = await harness.tool.execute("list-first", { action: "list" });
      expect(first.details).toMatchObject({ total: 65, offset: 0, omitted: 15, nextOffset: 50 });
      expect(first.details.workflows).toHaveLength(50);
      expect(first.content[0]?.text).toContain("15 more omitted; list again with offset 50");

      const second = await harness.tool.execute("list-second", { action: "list", offset: 50 });
      expect(second.details).toMatchObject({ total: 65, offset: 50, omitted: 0 });
      expect(second.details.workflows).toHaveLength(15);
      expect(second.details).not.toHaveProperty("nextOffset");

      await expect(
        harness.tool.execute("list-fraction", { action: "list", offset: 1.5 }),
      ).rejects.toThrow(/offset must be an integer/);
      await expect(
        harness.tool.execute("list-negative", { action: "list", offset: -1 }),
      ).rejects.toThrow(/offset must be an integer/);
      await expect(
        harness.tool.execute("list-too-large", { action: "list", offset: 66 }),
      ).rejects.toThrow(/offset must be an integer/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reserves one model-started workflow while it validates", async () => {
    const cwd = await makeTempDir("pi-workflows-tool-start-reservation");
    await writeEchoWorkflow(cwd);
    const harness = makeHarness({ cwd, respond: () => {} });

    await expect(
      harness.tool.execute("start-missing", {
        action: "start",
        workflow: "missing",
      }),
    ).rejects.toThrow(/Unknown workflow/);

    const starts = await Promise.allSettled([
      harness.tool.execute("start-first", { action: "start", workflow: "mini" }),
      harness.tool.execute("start-second", { action: "start", workflow: "mini" }),
    ]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(starts.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/launch is already waiting/),
      }),
    });

    const cancelled = await harness.tool.execute("cancel-pending", { action: "cancel" });
    expect(cancelled.details).toMatchObject({ action: "cancel", workflow: "mini", queued: false });

    const validating = harness.tool.execute("start-cancelled", {
      action: "start",
      workflow: "mini",
    });
    await harness.tool.execute("cancel-validating", { action: "cancel" });
    await expect(validating).rejects.toThrow(/cancelled before validation finished/);
  });

  it("bounds failed-run errors returned by workflow status", async () => {
    const cwd = await makeTempDir("pi-workflows-tool-status-error");
    const runsDir = await makeTempDir("pi-workflows-tool-status-error-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "fail.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "fail",
  startAt: "fail",
  nodes: { fail: compute({ run: () => { throw new Error("x".repeat(10000)); } }) },
  edges: [],
});
`,
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("fail", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("failed")));
      const status = await harness.tool.execute("status-error", { action: "status" });

      expect(status.details.error).toEqual(expect.stringContaining("[error truncated]"));
      expect(String(status.details.error).length).toBeLessThan(4_100);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("queues an opted-in result presentation after completion", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "present.workflow.ts"),
        `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "present",
  presentationPrompt: "Explain the answer plainly.",
  startAt: "reply",
  nodes: {
    reply: agent({ prompt: () => "Answer.", expectedOutput: '{ "answer": "text" }' }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({
        cwd,
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("call-1", {
              action: "submit",
              ...contract,
              output: { answer: "forty-two" },
            });
          }
        },
      });

      await harness.command.handler("present", harness.ctx);
      await waitFor(() =>
        harness.sentMessages.some(
          (entry) => entry.message.customType === "pi-workflows-presentation",
        ),
      );

      const sent = harness.sentMessages.find(
        (entry) => entry.message.customType === "pi-workflows-presentation",
      );
      expect(sent?.message.customType).toBe("pi-workflows-presentation");
      expect(sent?.message.display).toBe(false);
      expect(sent?.message.content).toContain("Explain the answer plainly.");
      expect(sent?.message.content).toContain('"answer": "forty-two"');
      expect(sent?.message.content).toContain("Do not call the `workflow` tool");
      expect(sent?.options).toEqual({ deliverAs: "steer", triggerTurn: true });

      await fs.writeFile(
        path.join(dir, "next.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "next",
  startAt: "finish",
  nodes: { finish: compute({ run: () => ({ next: true }) }) },
  edges: [],
});
`,
        "utf8",
      );
      await harness.command.handler("next", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("still being presented");

      harness.emit("agent_settled");
      await harness.command.handler("next", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("Workflow next completed")),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves an async presentation prompt for a waiting checkpoint", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "present-waiting.workflow.ts"),
        `import { checkpoint, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "present-waiting",
  presentationPrompt: async ({ state, finalOutput }) => {
    await Promise.resolve();
    return \`Ask for a decision about \${state.waitingOn}: \${JSON.stringify(finalOutput)}\`;
  },
  startAt: "review",
  nodes: {
    review: checkpoint({ run: () => ({ choice: "approve or reject" }) }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("present-waiting", harness.ctx);
      await waitFor(() => harness.sentMessages.length === 1);

      expect(harness.sentMessages[0]?.message.content).toContain(
        'Ask for a decision about review: {"choice":"approve or reject"}',
      );
      expect(harness.sentMessages[0]?.message.content).toContain('"status": "waiting"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discards a delayed presentation when another workflow starts", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "delayed.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "delayed",
  presentationPrompt: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return "Present the old result.";
  },
  startAt: "finish",
  nodes: { finish: compute({ run: () => ({ old: true }) }) },
  edges: [],
});
`,
        "utf8",
      );
      await fs.writeFile(
        path.join(dir, "newer.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "newer",
  startAt: "finish",
  nodes: { finish: compute({ run: () => ({ newer: true }) }) },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("delayed", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("Workflow delayed completed")),
      );
      await harness.command.handler("newer", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("Workflow newer completed")),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.notifications.some((note) => note.includes("Could not present"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discards a delayed presentation when a normal user turn starts", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "delayed-turn.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "delayed-turn",
  presentationPrompt: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return "Present the stale result.";
  },
  startAt: "finish",
  nodes: { finish: compute({ run: () => ({ old: true }) }) },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("delayed-turn", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("Workflow delayed-turn completed")),
      );
      harness.emit("agent_start");
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(harness.sentMessages).toHaveLength(0);
      expect(harness.notifications.some((note) => note.includes("Could not present"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("isolates presentation failures from the finished run", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "bad-presentation.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "bad-presentation",
  presentationPrompt: () => { throw new Error("presentation broke"); },
  startAt: "finish",
  nodes: { finish: compute({ run: () => ({ ok: true }) }) },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("bad-presentation", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("presentation broke")),
      );

      expect(harness.notifications.some((note) => note.includes("completed"))).toBe(true);
      expect(harness.sentMessages).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("aborts a timed-out Pi turn without treating it as a user interruption", async () => {
    const cwd = await makeTempDir("pi-workflows-timeout");
    const runsDir = await makeTempDir("pi-workflows-timeout-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeTimeoutWorkflow(cwd);
      let contract: { step: string; attempt: string } | null = null;
      const harness = makeHarness({
        cwd,
        respond: (prompt) => {
          contract = stepFromPrompt(prompt);
        },
      });

      await harness.command.handler("timeout", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("timed_out")));
      expect(harness.abortCalls).toBe(1);
      expect(contract).not.toBeNull();

      await harness.emitAsync("agent_end", { messages: [{ stopReason: "aborted" }] });
      expect(harness.notifications.some((note) => note.includes("paused (turn interrupted)"))).toBe(
        false,
      );
      expect(harness.notifications.some((note) => note.includes("must not present"))).toBe(false);
      expect(
        harness.sentMessages.filter(
          (entry) => entry.message.customType === "pi-workflows-presentation",
        ),
      ).toHaveLength(0);
      expect(
        harness.sentMessages.filter(
          (entry) => entry.message.customType === "pi-workflows-agent-step",
        ),
      ).toHaveLength(1);

      const capturedContract = contract as unknown as {
        step: string;
        attempt: string;
      } | null;
      if (capturedContract === null) {
        throw new Error("workflow contract was not captured");
      }
      await expect(
        harness.tool.execute("late-submit", {
          action: "submit",
          step: capturedContract.step,
          attempt: capturedContract.attempt,
          output: { too: "late" },
        }),
      ).rejects.toThrow(/timed out; its output is no longer accepted/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not abort a later user turn after Escape holds the workflow", async () => {
    const cwd = await makeTempDir("pi-workflows-held-timeout");
    const runsDir = await makeTempDir("pi-workflows-held-timeout-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeTimeoutWorkflow(cwd);
      let promptDelivered = false;
      const harness = makeHarness({
        cwd,
        respond: () => {
          promptDelivered = true;
        },
      });

      await harness.command.handler("timeout", harness.ctx);
      await waitFor(() => promptDelivered);
      await harness.emitAsync("agent_end", { messages: [{ stopReason: "aborted" }] });
      expect(harness.notifications.at(-1)).toContain("paused (turn interrupted)");
      harness.setIdle(false);

      await waitFor(() => harness.notifications.some((note) => note.includes("timed_out")));

      expect(harness.abortCalls).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not present cancelled runs", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "cancel-presentation.workflow.ts"),
        `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "cancel-presentation",
  presentationPrompt: "This must not be sent.",
  startAt: "wait",
  nodes: { wait: agent({ prompt: () => "Wait forever." }) },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("cancel-presentation", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("started")));
      await harness.command.handler("cancel", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(
        harness.sentMessages.filter(
          (entry) => entry.message.customType === "pi-workflows-presentation",
        ),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lists workflows, rejects bad input, and reports missing cancels", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    await writeEchoWorkflow(cwd);
    const harness = makeHarness({ cwd, respond: () => {} });

    await harness.command.handler("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("mini (project)");

    await harness.command.handler("cancel", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No workflow is running");

    await harness.command.handler("mini --input-json {broken", harness.ctx);
    expect(harness.notifications.at(-1)).toMatch(/JSON/);

    await harness.command.handler("does-not-exist", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("Could not start workflow");
  });

  it("lists the built-in monitor when no user workflows are discoverable", async () => {
    const cwd = await makeTempDir("pi-workflows-ext-empty");
    // The real home directory may have global workflows installed; point
    // discovery at an empty home so this test stays hermetic.
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(cwd);
    try {
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.command.handler("", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("monitor (builtin)");
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("keeps the widget up when a run parks at a checkpoint", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "parked.workflow.ts"),
        `import { checkpoint, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "parked",
  startAt: "review",
  nodes: {
    review: checkpoint({ summary: "human review", run: () => ({ ok: true }) }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("parked", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("/workflow answer")));
      expect(harness.notifications.at(-1)).toContain(
        "parked at checkpoint review — answer with /workflow answer <json>",
      );

      // The final widget update must still be present, not cleared, and show
      // the waiting state so the human sees the parked checkpoint.
      const last = harness.widgets.at(-1);
      expect(last).toBeTypeOf("function");
      const rendered =
        typeof last === "function" ? last(undefined, TEST_THEME).render(80).join("\n") : undefined;
      expect(stripAnsi(rendered ?? "")).toContain("[waiting]");
      expect(stripAnsi(rendered ?? "")).toContain("waiting on checkpoint: review");

      // With no live run, cancel clears the parked widget instead of
      // claiming nothing exists.
      await harness.command.handler("cancel", harness.ctx);
      expect(harness.notifications.at(-1)).toContain(
        "Workflow parked already ended at checkpoint review; cleared its widget.",
      );
      expect(harness.widgets.at(-1)).toBeUndefined();

      await harness.command.handler("cancel", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("No workflow is running");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shares pause, resume, and cancel behavior between commands and the tool", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      // Never respond, so the agent step stays pending and the run stays live.
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("pause", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("No workflow is running");

      await harness.command.handler("mini", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("started")));

      const paused = await harness.tool.execute("pause-1", { action: "pause" });
      expect(paused.content[0]?.text).toContain("Pausing workflow mini");
      const pausedAgain = await harness.tool.execute("pause-2", { action: "pause" });
      expect(pausedAgain.content[0]?.text).toContain("already pausing or paused");

      const resumed = await harness.tool.execute("resume-1", { action: "resume" });
      expect(resumed.content[0]?.text).toContain("Workflow mini resumed");
      const resumedAgain = await harness.tool.execute("resume-2", { action: "resume" });
      expect(resumedAgain.content[0]?.text).toContain("is not paused");

      const cancelled = await harness.tool.execute("cancel-1", { action: "cancel" });
      expect(cancelled.content[0]?.text).toContain("Cancelling workflow mini");
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("auto-pauses when the user interrupts the turn and resumes with a reprompt", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const prompts: string[] = [];
      const harness = makeHarness({ cwd, respond: (prompt) => prompts.push(prompt) });

      await harness.command.handler("mini", harness.ctx);
      await waitFor(() => prompts.length === 1);

      // Escape aborts the turn; the extension must hold the run instead of
      // nudging the model and stealing the conversation back.
      harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
      expect(harness.notifications.at(-1)).toContain("paused (turn interrupted)");
      expect(harness.statuses.at(-1)).toContain("[paused]");

      harness.emit("agent_settled");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toHaveLength(1);

      // A second aborted turn while already held must not renotify.
      const notificationCount = harness.notifications.length;
      harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
      expect(harness.notifications).toHaveLength(notificationCount);

      // Resume re-delivers the pending step prompt so the model picks it up.
      await harness.command.handler("resume", harness.ctx);
      await waitFor(() => prompts.length === 2);
      expect(prompts[1]).toContain("Workflow step contract");
      expect(harness.notifications.at(-1)).toContain("Workflow mini resumed");

      await harness.command.handler("cancel", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores non-aborted turn ends", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.command.handler("mini", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("started")));

      harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      expect(harness.notifications.some((note) => note.includes("paused (turn interrupted)"))).toBe(
        false,
      );

      await harness.command.handler("cancel", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("registers scroll shortcuts that no-op without a widget", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const harness = makeHarness({ cwd, respond: () => {} });
    expect([...harness.shortcuts.keys()]).toEqual(["shift+up", "shift+down"]);
    // No workflow has run yet, so there is nothing to scroll; must not throw.
    harness.shortcuts.get("shift+up")?.(harness.ctx);
    harness.shortcuts.get("shift+down")?.(harness.ctx);
    expect(harness.widgets).toHaveLength(0);
  });

  it("rejects submissions outside a workflow", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const harness = makeHarness({ cwd, respond: () => {} });
    await expect(
      harness.tool.execute("call-1", {
        action: "submit",
        step: "reply",
        attempt: "a1",
        output: {},
      }),
    ).rejects.toThrow(/No workflow step is waiting/);
  });

  it("cancels a running workflow", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      // Never respond, so the step stays pending until cancelled.
      const harness = makeHarness({ cwd, respond: () => {} });

      await harness.command.handler("mini", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("started")));

      await harness.command.handler("other", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("already running");

      await harness.command.handler("cancel", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("completes workflow names for the command", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    await writeEchoWorkflow(cwd);
    const harness = makeHarness({ cwd, respond: () => {} });
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const completions = await harness.command.getArgumentCompletions?.("m");
      expect(completions?.map((item) => item.value)).toContain("mini");
      const cancelCompletion = await harness.command.getArgumentCompletions?.("can");
      expect(cancelCompletion?.map((item) => item.value)).toEqual(["cancel"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("reconciles a controller through a child workflow", async () => {
    const cwd = await makeTempDir("pi-workflows-controller-ext");
    const runsDir = await makeTempDir("pi-workflows-controller-runs");
    const controllerDir = await makeTempDir("pi-workflows-controller-state");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    const controllerFile = projectControllerStorePath(cwd);
    try {
      await writeControllerWithChild(cwd);
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("controller");
      expect(command).toBeDefined();
      await command?.handler('apply demo item-1 {"value":"hello"}', harness.ctx);
      await waitFor(() => {
        const reader = new SqliteControllerStore(controllerFile, { readOnly: true });
        try {
          return (
            reader.getResource<unknown, { phase: string }>({
              controller: "demo",
              key: "item-1",
            })?.status.controllerStatus.phase === "done"
          );
        } finally {
          reader.close();
        }
      });
      await command?.handler("get demo item-1", harness.ctx);
      expect(harness.notifications.at(-1)).toContain('"phase": "done"');
      await command?.handler("list", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("demo/item-1 generation=1");
      await command?.handler("get demo missing", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Controller command failed");
      await command?.handler("stop", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("workers stopped");
      await command?.handler("reconcile demo item-1", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Queued demo/item-1");
      await command?.handler("start", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("workers started");
      await command?.handler("delete demo item-1", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Requested deletion");
      await waitFor(() => {
        const reader = new SqliteControllerStore(controllerFile, { readOnly: true });
        try {
          return reader.getResource({ controller: "demo", key: "item-1" }) === undefined;
        } finally {
          reader.close();
        }
      });
      expect(harness.statuses.some((status) => status?.includes("controller resource"))).toBe(true);
      expect(await fs.readdir(runsDir)).toHaveLength(1);
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retries a child workflow interrupted by stopping controller workers", async () => {
    const cwd = await makeTempDir("pi-workflows-controller-ext");
    const runsDir = await makeTempDir("pi-workflows-controller-runs");
    const controllerRoot = await makeTempDir("pi-workflows-controller-state");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerRoot);
    try {
      await writeControllerWithChild(cwd);
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "child.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "child",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ input, signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(input), 250);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("controller");
      await command?.handler('apply demo item-1 {"value":"hello"}', harness.ctx);
      const controllerFile = projectControllerStorePath(cwd);
      await waitFor(() => {
        const reader = new SqliteControllerStore(controllerFile, { readOnly: true });
        try {
          return (
            reader.listWorkflows(reader.listResources()[0]?.metadata.uid ?? "")[0]?.state ===
            "running"
          );
        } finally {
          reader.close();
        }
      });

      await command?.handler("stop", harness.ctx);
      await waitFor(() => {
        const reader = new SqliteControllerStore(controllerFile, { readOnly: true });
        try {
          const resource = reader.listResources()[0];
          return (
            resource !== undefined &&
            reader.listWorkflows(resource.metadata.uid)[0]?.state === "interrupted"
          );
        } finally {
          reader.close();
        }
      });

      await command?.handler("start", harness.ctx);
      await waitFor(() => {
        const reader = new SqliteControllerStore(controllerFile, { readOnly: true });
        try {
          const resource = reader.getResource<unknown, { phase: string }>({
            controller: "demo",
            key: "item-1",
          });
          const child =
            resource === undefined ? undefined : reader.listWorkflows(resource.metadata.uid)[0];
          return (
            resource?.status.controllerStatus.phase === "done" &&
            child?.state === "succeeded" &&
            child.attempt === 2
          );
        } finally {
          reader.close();
        }
      });
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parks a queued run on shutdown and leaves it resumable", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-park");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("workflow");
      await command?.handler("slow", harness.ctx);

      // Wait for the run to be claimed and the node to be in flight.
      const queueFile = projectControllerStorePath(cwd);
      await waitFor(() => {
        const reader = new SqliteControllerStore(queueFile, { readOnly: true });
        try {
          return reader.listWorkflowRuns()[0]?.status === "claimed";
        } finally {
          reader.close();
        }
      });
      await waitFor(async () => {
        const runDirs = await fs.readdir(runsDir);
        const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
        return bundle?.state.currentNode === "work";
      });

      await harness.emitAsync("session_shutdown");

      const queue = new SqliteControllerStore(queueFile, { readOnly: true });
      try {
        const rows = queue.listWorkflowRuns();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "parked", runnerId: null, claimToken: null });
        // The bundle stayed resumable: no terminal event, node still in flight.
        const bundle = await readRunBundle(path.join(runsDir, rows[0]?.runId ?? ""));
        expect(bundle?.state.status).toBe("running");
        expect(bundle?.state.currentNode).toBe("work");
        // The recorder drained before the claim released, so capture closed.
        expect(bundle?.sessionCapture?.status).toBe("complete");
      } finally {
        queue.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("continues a checkpointed run through /workflow answer", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-answer");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "gate.workflow.ts"),
        `import { checkpoint, compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "gate",
  startAt: "approval",
  nodes: {
    approval: checkpoint({ summary: "approve the deploy" }),
    apply: compute({ run: ({ outputs }) => ({ deployed: true, saw: outputs.approval ?? null }) }),
  },
  edges: [{ from: "approval", to: "apply" }],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("workflow");

      await command?.handler("gate", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("parked at checkpoint approval")),
      );

      await command?.handler('answer {"approved":true}', harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("completed") && note.includes("gate")),
      );

      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        const rows = queue.listWorkflowRuns();
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "done")).toBe(true);
        const [parent, child] = rows;
        expect(child?.parentRunId).toBe(parent?.runId);
        expect(child?.input).toEqual({ approved: true });
      } finally {
        queue.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("delivers notifications only to their target session", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-notifications");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const queue = new SqliteControllerStore(projectControllerStorePath(cwd));
      queue.enqueueWorkflowNotification({
        runId: "run-targeted",
        nodeId: "report",
        attemptId: "attempt-1",
        notificationIndex: 1,
        targetSessionId: "session-a",
        kind: "final",
        content: "Targeted result",
      });
      queue.close();

      const unrelated = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
      await unrelated.emitAsync("session_start");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unrelated.sentMessages).toHaveLength(0);

      const origin = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await origin.emitAsync("session_start");
      await waitFor(() =>
        origin.sentMessages.some((entry) => entry.message.content === "Targeted result"),
      );
      expect(origin.sentMessages[0]?.message).toMatchObject({
        customType: "pi-workflows-notification",
        display: true,
        details: { runId: "run-targeted", kind: "final" },
      });
      expect(origin.sentMessages[0]?.options).toEqual({ triggerTurn: false });

      const check = new SqliteControllerStore(projectControllerStorePath(cwd));
      expect(
        check.claimPendingWorkflowNotifications({
          targetSessionId: "session-a",
          claimToken: "post-delivery-check",
          leaseMs: 1_000,
        }),
      ).toHaveLength(0);
      check.close();
      await unrelated.emitAsync("session_shutdown");
      await origin.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps string-array widget updates in RPC mode", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-rpc-widget");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      const harness = makeHarness({ cwd, mode: "rpc", respond: () => {} });
      await harness.command.handler("mini say hi", harness.ctx);
      await waitFor(() => harness.widgets.some((widget) => Array.isArray(widget)));
      const rpcWidget = harness.widgets.find((widget): widget is string[] => Array.isArray(widget));
      expect(rpcWidget).toBeDefined();
      expect(rpcWidget?.join("\n")).not.toContain("\u001b");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("presents a result with a function-built prompt", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-present");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const dir = path.join(cwd, ".pi", "workflows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "mini-present.workflow.ts"),
        `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "mini-present",
  presentationPrompt: ({ finalOutput }) =>
    \`Tell the user the reply was \${JSON.stringify(finalOutput)} in one sentence.\`,
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: () => "Say hi.",
      expectedOutput: '{ "reply": "…" }',
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({
        cwd,
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("call-1", {
              action: "submit",
              ...contract,
              output: { reply: "hi" },
            });
          }
        },
      });
      await harness.emitAsync("session_start");
      await harness.command.handler("mini-present", harness.ctx);
      await waitFor(() =>
        harness.sentMessages.some(
          (entry) => entry.message.customType === "pi-workflows-presentation",
        ),
      );
      const presentation = harness.sentMessages.find(
        (entry) => entry.message.customType === "pi-workflows-presentation",
      );
      expect(presentation?.message.content).toContain("reply was");
      const presentationResponse = {
        role: "assistant",
        content: [{ type: "text", text: "The reply was hi." }],
      };
      const [replacement] = await harness.emitAsync("message_end", {
        message: presentationResponse,
      });
      expect(replacement).toBeUndefined();
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("drives the controller command through its lifecycle", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-ctlcmd");
    const controllerDir = await makeTempDir("pi-workflows-ext-ctl");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerDir);
    try {
      await writeControllerWithChild(cwd);
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("controller");

      await command?.handler('apply demo item-9 {"value":"x"}', harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Applied demo/item-9 generation 1");
      await command?.handler("list", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("demo/item-9");
      await command?.handler("get demo item-9", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("item-9");
      await command?.handler("reconcile demo item-9", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Queued demo/item-9");
      await command?.handler("delete demo item-9", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Requested deletion");
      await command?.handler("start", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("workers started");
      await command?.handler("stop", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("workers stopped");
      await command?.handler("bogus", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Usage: /controller");
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it(
    "lists workflows, refuses a second concurrent run, and parses input json",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-workflows-ext-list");
      const runsDir = await makeTempDir("pi-workflows-ext-runs");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      try {
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        await fs.writeFile(
          path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
          `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
          "utf8",
        );
        const harness = makeHarness({ cwd, respond: () => {} });
        await harness.emitAsync("session_start");
        const workflow = harness.commands.get("workflow");

        // The list command names discovered workflows.
        await workflow?.handler("", harness.ctx);
        expect(harness.notifications.at(-1)).toContain("Workflows: slow");

        // A second run is refused while one is active.
        await workflow?.handler("slow", harness.ctx);
        await waitFor(async () => {
          const runDirs = await fs.readdir(runsDir);
          const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
          return bundle?.state.currentNode === "work";
        });
        await workflow?.handler("slow", harness.ctx);
        expect(harness.notifications.at(-1)).toContain("already running");

        // --input-json drives the input, and the widget shortcuts are safe.
        await workflow?.handler("cancel", harness.ctx);
        await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
        harness.shortcuts.get("shift+up")?.(harness.ctx);
        harness.shortcuts.get("shift+down")?.(harness.ctx);
        await harness.emitAsync("session_shutdown");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it(
    "rejects workflow tool calls with no run or the wrong contract",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-workflows-ext-tool");
      const runsDir = await makeTempDir("pi-workflows-ext-runs");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      try {
        const harness = makeHarness({ cwd, respond: () => {} });
        await harness.emitAsync("session_start");
        // No active run.
        await expect(
          harness.tool.execute("call-x", {
            action: "submit",
            step: "s",
            attempt: "a",
            output: {},
          }),
        ).rejects.toThrow(/No workflow step is waiting/);

        // An active run with a pending step contract.
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        await fs.writeFile(
          path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
          `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
          "utf8",
        );
        await harness.command.handler("slow", harness.ctx);
        await waitFor(async () => {
          const runDirs = await fs.readdir(runsDir);
          const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
          return bundle?.state.currentNode === "work";
        });
        // A compute node has no agent contract: submissions are rejected.
        await expect(
          harness.tool.execute("call-y", {
            action: "submit",
            step: "work",
            attempt: "wrong",
            output: {},
          }),
        ).rejects.toThrow();
        await harness.emitAsync("session_shutdown");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("handles command edge cases", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-edges");
    // No global workflows or controllers in this test's home.
    vi.stubEnv("HOME", await makeTempDir("pi-workflows-ext-home"));
    const harness = makeHarness({ cwd, respond: () => {} });
    await harness.emitAsync("session_start");
    const workflow = harness.commands.get("workflow");
    const controller = harness.commands.get("controller");

    // The built-in monitor exists even when the project has no local workflows or controllers.
    await workflow?.handler("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("monitor (builtin)");
    await workflow?.handler("pause", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No workflow is running");
    await workflow?.handler("resume", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No workflow is running");
    await workflow?.handler("cancel", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No workflow is running");
    await workflow?.handler('answer {"x":1}', harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No workflow is waiting for an answer");
    await workflow?.handler('answer missing-run {"x":1}', harness.ctx);
    expect(harness.notifications.at(-1)).toContain("no longer waiting");
    await controller?.handler("list", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No controllers found");
    await harness.emitAsync("session_shutdown");
  });

  it("pauses, resumes, and cancels an active run", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-controls");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 600);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      const workflow = harness.commands.get("workflow");
      await workflow?.handler("slow", harness.ctx);
      await waitFor(async () => {
        const runDirs = await fs.readdir(runsDir);
        const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
        return bundle?.state.currentNode === "work";
      });

      await workflow?.handler("pause", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Pausing workflow slow");
      await workflow?.handler("pause", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("already pausing or paused");
      await workflow?.handler("resume", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("resumed");
      await workflow?.handler("resume", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("is not paused");
      await workflow?.handler("cancel", harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("cancelled")));
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a run that continues under another runner", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-claimlost");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 600);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.emitAsync("session_start");
      await harness.command.handler("slow", harness.ctx);
      const queueFile = projectControllerStorePath(cwd);
      await waitFor(() => {
        const reader = new SqliteControllerStore(queueFile, { readOnly: true });
        try {
          return reader.listWorkflowRuns()[0]?.status === "claimed";
        } finally {
          reader.close();
        }
      });

      // Another runner takes over: expire and reclaim the row directly.
      const { default: Database } = await import("better-sqlite3");
      const raw = new Database(queueFile);
      raw
        .prepare("UPDATE workflow_run_queue SET claim_expires_at = 1 WHERE status = 'claimed'")
        .run();
      raw
        .prepare(
          "UPDATE workflow_run_queue SET runner_id = 'other', claim_token = 'other-token', claim_expires_at = 9999999999999 WHERE status = 'claimed'",
        )
        .run();
      raw.close();

      await waitFor(
        () => harness.notifications.some((note) => note.includes("continues under another runner")),
        15_000,
      );
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("describes resumed events and survives store errors", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-feed2");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      const queueFile = projectControllerStorePath(cwd);
      const queue = new SqliteControllerStore(queueFile);
      queue.recordRunEvent({
        runId: "r-skip",
        workflowRef: "old",
        type: "queued",
        runnerId: "other-runner",
      });
      queue.recordRunEvent({
        runId: "r-resume",
        workflowRef: "demo",
        type: "resumed",
        runnerId: "other-runner",
      });
      queue.close();

      const harness = makeHarness({ cwd, sessionId: "session-y", respond: () => {} });
      await harness.emitAsync("session_start");
      // "resumed" is not a noteworthy type: no notification, no crash.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.notifications.some((note) => note.includes("r-resume"))).toBe(false);
      await harness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers a checkpoint after a session restart", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-answer-restart");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "gate.workflow.ts"),
        `import { checkpoint, compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "gate",
  startAt: "approval",
  nodes: {
    approval: checkpoint({ summary: "approve" }),
    apply: compute({ run: () => ({ deployed: true }) }),
  },
  edges: [{ from: "approval", to: "apply" }],
});
`,
        "utf8",
      );
      // Session A runs to the checkpoint and closes.
      const first = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await first.emitAsync("session_start");
      await first.command.handler("gate", first.ctx);
      await waitFor(() =>
        first.notifications.some((note) => note.includes("parked at checkpoint approval")),
      );
      await first.emitAsync("session_shutdown");

      // Reopening session A discovers its waiting run from disk and starts the
      // continuation after the answering turn settles.
      const second = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await second.emitAsync("session_start");
      const queued = await second.tool.execute("answer-1", {
        action: "answer",
        input: { approved: true },
      });
      expect(queued.details).toMatchObject({ action: "start", queued: true });
      await second.emitAsync("agent_settled");
      await waitFor(() => second.notifications.some((note) => note.includes("completed")));

      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        expect(queue.listWorkflowRuns().map((row) => row.status)).toEqual(["done", "done"]);
      } finally {
        queue.close();
      }
      await second.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it(
    "keeps the checkpoint answerable after a refused continuation",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-workflows-ext-answer-refused");
      const runsDir = await makeTempDir("pi-workflows-ext-runs");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      try {
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        const workflowFile = path.join(cwd, ".pi", "workflows", "gate.workflow.ts");
        await fs.writeFile(
          workflowFile,
          `import { checkpoint, compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "gate",
  startAt: "approval",
  nodes: {
    approval: checkpoint({ summary: "approve" }),
    apply: compute({ run: () => ({ deployed: true }) }),
  },
  edges: [{ from: "approval", to: "apply" }],
});
`,
          "utf8",
        );
        const harness = makeHarness({ cwd, respond: () => {} });
        await harness.emitAsync("session_start");
        const command = harness.commands.get("workflow");
        await command?.handler("gate", harness.ctx);
        await waitFor(() =>
          harness.notifications.some((note) => note.includes("parked at checkpoint approval")),
        );

        // The workflow file changes while the run waits; the answer is refused.
        await fs.appendFile(workflowFile, "\n// edited while waiting\n", "utf8");
        await command?.handler('answer {"approved":true}', harness.ctx);
        expect(harness.notifications.at(-1)).toContain("source changed");

        // No continuation row was consumed: the parent is alone in the queue.
        const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
          readOnly: true,
        });
        try {
          const rows = queue.listWorkflowRuns();
          expect(rows).toHaveLength(1);
          expect(rows[0]?.parentRunId).toBeNull();
        } finally {
          queue.close();
        }
        await harness.emitAsync("session_shutdown");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("skips already-answered checkpoints in the answer fallback", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-answer-skip");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "gate.workflow.ts"),
        `import { checkpoint, compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "gate",
  startAt: "approval",
  nodes: {
    approval: checkpoint({ summary: "approve" }),
    apply: compute({ run: () => ({ deployed: true }) }),
  },
  edges: [{ from: "approval", to: "apply" }],
});
`,
        "utf8",
      );
      const harness = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await harness.emitAsync("session_start");
      const command = harness.commands.get("workflow");

      // First checkpoint: answered through its continuation.
      await command?.handler("gate", harness.ctx);
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("parked at checkpoint approval")),
      );
      await command?.handler('answer {"round":1}', harness.ctx);
      await waitFor(() => harness.notifications.some((note) => note.includes("completed")));

      // Second checkpoint of the same workflow: left waiting across a restart.
      await command?.handler("gate", harness.ctx);
      await waitFor(
        () =>
          harness.notifications.filter((note) => note.includes("parked at checkpoint approval"))
            .length === 2,
      );
      await harness.emitAsync("session_shutdown");

      const second = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await second.emitAsync("session_start");
      await second.command.handler('answer {"round":2}', second.ctx);
      await waitFor(() => second.notifications.some((note) => note.includes("completed")));

      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        const rows = queue.listWorkflowRuns();
        expect(rows).toHaveLength(4);
        const continuations = rows.filter((row) => row.parentRunId !== null);
        expect(continuations).toHaveLength(2);
        // The fallback continued the second (unanswered) parent.
        const parents = rows.filter((row) => row.parentRunId === null);
        expect(continuations[1]?.parentRunId).toBe(parents[1]?.runId);
        expect(continuations[1]?.input).toEqual({ round: 2 });
      } finally {
        queue.close();
      }
      await second.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parks a run again when resume fails on changed source", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-resume-fail");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      const workflowFile = path.join(cwd, ".pi", "workflows", "slow.workflow.ts");
      await fs.writeFile(
        workflowFile,
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 400);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      const first = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await first.emitAsync("session_start");
      await first.command.handler("slow", first.ctx);
      await waitFor(async () => {
        const runDirs = await fs.readdir(runsDir);
        const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
        return bundle?.state.currentNode === "work";
      });
      await first.emitAsync("session_shutdown");

      // The workflow file changes while the run is parked.
      await fs.appendFile(workflowFile, "\n// edited while parked\n", "utf8");

      const second = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await second.emitAsync("session_start");
      await waitFor(() => second.notifications.some((note) => note.includes("parked again")));

      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        // The run stays claimable instead of being stranded as done.
        expect(queue.listWorkflowRuns().map((row) => row.status)).toEqual(["parked"]);
      } finally {
        queue.close();
      }
      await second.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it(
    "closes the queue row when a claimed run's bundle is already waiting",
    { timeout: 20_000 },
    async () => {
      const cwd = await makeTempDir("pi-workflows-ext-terminal-row");
      const runsDir = await makeTempDir("pi-workflows-ext-runs");
      vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
      try {
        await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
        const workflowFile = path.join(cwd, ".pi", "workflows", "gate.workflow.ts");
        await fs.writeFile(
          workflowFile,
          `import { checkpoint, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "gate",
  startAt: "approval",
  nodes: { approval: checkpoint({ summary: "approve" }) },
  edges: [],
});
`,
          "utf8",
        );
        // A run reaches the checkpoint in session A.
        const first = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
        await first.emitAsync("session_start");
        await first.command.handler("gate", first.ctx);
        await waitFor(() =>
          first.notifications.some((note) => note.includes("parked at checkpoint approval")),
        );
        // Simulate the crash window: the bundle is waiting (terminal) but
        // the queue row was never released — flip it back to claimed with an
        // expired lease, as a killed session would have left it.
        const queueFile = projectControllerStorePath(cwd);
        const queue = new SqliteControllerStore(queueFile);
        const [row] = queue.listWorkflowRuns();
        const runId = row?.runId as string;
        queue.close();
        const { default: Database } = await import("better-sqlite3");
        const raw = new Database(queueFile);
        raw
          .prepare(
            "UPDATE workflow_run_queue SET status = 'claimed', runner_id = 'dead-runner', claim_token = 'stale-token', claim_expires_at = 1 WHERE run_id = ?",
          )
          .run(runId);
        raw.close();
        await first.emitAsync("session_shutdown");

        // Session B claims it, fails to resume a terminal bundle, and closes
        // the row as done instead of re-parking forever.
        const second = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
        await second.emitAsync("session_start");
        await waitFor(() => {
          const reader = new SqliteControllerStore(queueFile, { readOnly: true });
          try {
            return reader.getWorkflowRun(runId)?.status === "done";
          } finally {
            reader.close();
          }
        });
        await second.emitAsync("session_shutdown");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("resumes a parked run when a new session opens", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-reopen");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "workflows", "slow.workflow.ts"),
        `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";
export default defineWorkflow({
  name: "slow",
  startAt: "work",
  nodes: {
    work: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 400);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
  },
  edges: [],
});
`,
        "utf8",
      );
      // Session A starts the run and closes mid-flight: the run parks.
      const first = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await first.emitAsync("session_start");
      await first.command.handler("slow", first.ctx);
      await waitFor(async () => {
        const runDirs = await fs.readdir(runsDir);
        const bundle = await readRunBundle(path.join(runsDir, runDirs[0] ?? ""));
        return bundle?.state.currentNode === "work";
      });
      await first.emitAsync("session_shutdown");

      // Session B opens: it claims the parked run, resumes the node, and
      // drives it to completion.
      const second = makeHarness({ cwd, sessionId: "session-a", respond: () => {} });
      await second.emitAsync("session_start");
      await waitFor(() => second.notifications.some((note) => note.includes("Resumed workflow")));
      await waitFor(() => second.notifications.some((note) => note.includes("completed")));

      const queue = new SqliteControllerStore(projectControllerStorePath(cwd), {
        readOnly: true,
      });
      try {
        expect(queue.listWorkflowRuns().map((row) => row.status)).toEqual(["done"]);
      } finally {
        queue.close();
      }
      const [runId] = await fs.readdir(runsDir);
      const bundle = await readRunBundle(path.join(runsDir, runId ?? ""));
      expect(bundle?.state.status).toBe("completed");
      expect(bundle?.state.finalOutput).toBe("done");
      await second.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("isolates same-named controllers by project", async () => {
    const controllerRoot = await makeTempDir("pi-workflows-controller-state");
    const firstCwd = await makeTempDir("pi-workflows-controller-project");
    const secondCwd = await makeTempDir("pi-workflows-controller-project");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", controllerRoot);
    try {
      for (const [cwd, marker] of [
        [firstCwd, "first"],
        [secondCwd, "second"],
      ] as const) {
        const controllerDir = path.join(cwd, ".pi", "controllers");
        await fs.mkdir(controllerDir, { recursive: true });
        await fs.writeFile(
          path.join(controllerDir, "shared.controller.ts"),
          `import { defineController } from ${JSON.stringify(
            path.join(process.cwd(), "src", "controllers", "index.ts"),
          )};
export default defineController({
  name: "shared",
  initialStatus: () => ({ marker: "new" }),
  reconcile: (ctx) => ctx.settled({ controllerStatus: { marker: ${JSON.stringify(marker)} } }),
});
`,
          "utf8",
        );
      }

      const firstHarness = makeHarness({ cwd: firstCwd, respond: () => {} });
      await firstHarness.emitAsync("session_start");
      await firstHarness.commands
        .get("controller")
        ?.handler("apply shared item {}", firstHarness.ctx);
      const firstFile = projectControllerStorePath(firstCwd);
      await waitFor(() => {
        const reader = new SqliteControllerStore(firstFile, { readOnly: true });
        try {
          return (
            reader.getResource<unknown, { marker: string }>({
              controller: "shared",
              key: "item",
            })?.status.controllerStatus.marker === "first"
          );
        } finally {
          reader.close();
        }
      });
      await firstHarness.emitAsync("session_shutdown");

      const secondHarness = makeHarness({ cwd: secondCwd, respond: () => {} });
      await secondHarness.emitAsync("session_start");
      await secondHarness.commands.get("controller")?.handler("list", secondHarness.ctx);
      expect(secondHarness.notifications.at(-1)).toContain("No resources");
      expect(projectControllerStorePath(secondCwd)).not.toBe(firstFile);
      await secondHarness.emitAsync("session_shutdown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports when no controller definitions are installed", async () => {
    const cwd = await makeTempDir("pi-workflows-controller-ext");
    const harness = makeHarness({ cwd, respond: () => {} });
    await harness.emitAsync("session_start");
    await harness.commands.get("controller")?.handler("list", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No controllers found");
    await harness.emitAsync("session_shutdown");
  });
});
