import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { projectControllerStorePath } from "../src/controllers/store.js";
import piWorkflows from "../src/extension/index.js";
import { readRunBundle } from "../src/workflows/store.js";
import { makeTempDir } from "./helpers.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: { step: string; attempt: string; output: unknown },
  ) => Promise<unknown>;
};

type RegisteredCommand = {
  handler: (args: string, ctx: FakeContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Promise<{ value: string; label: string }[] | null>;
};

type SentMessage = {
  message: { customType: string; content: string; display: boolean };
  options: { deliverAs: string; triggerTurn: boolean };
};

type FakeContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getSessionId: () => string;
    getLeafId: () => string | null;
    getSessionFile: () => string | undefined;
  };
  ui: {
    notify: (message: string, type?: string) => void;
    setWidget: (key: string, lines: string[] | undefined) => void;
    setStatus: (key: string, text: string | undefined) => void;
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
}) {
  const notifications: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const sentMessages: SentMessage[] = [];
  const listeners = new Map<
    string,
    ((event?: unknown, ctx?: FakeContext) => void | Promise<void>)[]
  >();
  const shortcuts = new Map<string, (ctx: FakeContext) => void>();
  const commands = new Map<string, RegisteredCommand>();
  let tool: RegisteredTool | null = null;

  const ctx: FakeContext = {
    cwd: options.cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "test-session",
      getLeafId: () => null,
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message) => notifications.push(message),
      setWidget: (_key, lines) => widgets.push(lines),
      setStatus: (_key, text) => statuses.push(text),
    },
  };

  const pi = {
    registerCommand: (name: string, spec: RegisteredCommand) => {
      commands.set(name, spec);
    },
    registerTool: (spec: RegisteredTool) => {
      tool = spec;
    },
    registerShortcut: (key: string, spec: { handler: (ctx: FakeContext) => void }) => {
      shortcuts.set(key, spec.handler);
    },
    on: (event: string, listener: (event?: unknown, ctx?: FakeContext) => void | Promise<void>) => {
      const queue = listeners.get(event) ?? [];
      queue.push(listener);
      listeners.set(event, queue);
    },
    sendUserMessage: (prompt: string) => {
      // Deliver asynchronously like the real runtime would.
      queueMicrotask(() => options.respond(prompt, tool as RegisteredTool));
    },
    sendMessage: (message: SentMessage["message"], messageOptions: SentMessage["options"]) => {
      sentMessages.push({ message, options: messageOptions });
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
    command: workflowCommand,
    commands,
    tool: tool as RegisteredTool,
    shortcuts,
    emit: (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) {
        void listener(payload, ctx);
      }
    },
    emitAsync: async (event: string, payload?: unknown) => {
      await Promise.all(
        (listeners.get(event) ?? []).map(async (listener) => await listener(payload, ctx)),
      );
    },
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
            void tool.execute("call-1", { ...contract, output: { reply: "hi" } });
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
      expect(harness.sentMessages).toHaveLength(0);

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
          workflowRef: "mini",
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
            void tool.execute("call-1", { ...contract, output: { answer: "forty-two" } });
          }
        },
      });

      await harness.command.handler("present", harness.ctx);
      await waitFor(() => harness.sentMessages.length === 1);

      const sent = harness.sentMessages[0];
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

      expect(harness.sentMessages).toHaveLength(0);
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

  it("warns when no workflows are discoverable", async () => {
    const cwd = await makeTempDir("pi-workflows-ext-empty");
    // The real home directory may have global workflows installed; point
    // discovery at an empty home so this test stays hermetic.
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(cwd);
    try {
      const harness = makeHarness({ cwd, respond: () => {} });
      await harness.command.handler("", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("No workflows found");
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
      expect(last).toBeDefined();
      expect(last?.join("\n")).toContain("[waiting]");
      expect(last?.join("\n")).toContain("waiting on checkpoint: review");

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

  it("pauses and resumes a live run via subcommands", async () => {
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

      await harness.command.handler("pause", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Pausing workflow mini");
      await harness.command.handler("pause", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("already pausing or paused");

      await harness.command.handler("resume", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("Workflow mini resumed");
      await harness.command.handler("resume", harness.ctx);
      expect(harness.notifications.at(-1)).toContain("is not paused");

      await harness.command.handler("cancel", harness.ctx);
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

  it("rejects tool calls outside a workflow", async () => {
    const cwd = await makeTempDir("pi-workflows-ext");
    const harness = makeHarness({ cwd, respond: () => {} });
    await expect(
      harness.tool.execute("call-1", { step: "reply", attempt: "a1", output: {} }),
    ).rejects.toThrow(/No workflow is running/);
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

  it("syncs a reopened session with runs another session drove", { timeout: 20_000 }, async () => {
    const cwd = await makeTempDir("pi-workflows-ext-sync");
    const runsDir = await makeTempDir("pi-workflows-ext-runs");
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", runsDir);
    try {
      await writeEchoWorkflow(cwd);
      // Session A drives a run to completion.
      const first = makeHarness({
        cwd,
        sessionId: "session-a",
        respond: (prompt, tool) => {
          const contract = stepFromPrompt(prompt);
          if (contract) {
            void tool.execute("call-1", { ...contract, output: { reply: "hi" } });
          }
        },
      });
      await first.emitAsync("session_start");
      await first.command.handler("mini say hi", first.ctx);
      await waitFor(() => first.notifications.some((note) => note.includes("completed")));
      await first.emitAsync("session_shutdown");

      // Session B opens later: catch-up mentions the completed run exactly
      // through the shared event feed.
      const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
      await second.emitAsync("session_start");
      await waitFor(() =>
        second.notifications.some((note) => note.includes("mini") && note.includes("completed")),
      );
      expect(second.sentMessages.some((entry) => entry.message.content.includes("completed"))).toBe(
        true,
      );
      // Session B's own progress does not re-notify on the next pass.
      const notificationCount = second.notifications.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(second.notifications.length).toBe(notificationCount);
      await second.emitAsync("session_shutdown");
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

      // Session B has no in-memory waiting run; discovery comes from disk.
      const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
      await second.emitAsync("session_start");
      await second.command.handler('answer {"approved":true}', second.ctx);
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

      const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
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

      const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
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
        const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
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
      const second = makeHarness({ cwd, sessionId: "session-b", respond: () => {} });
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
