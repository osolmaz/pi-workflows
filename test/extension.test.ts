import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import piWorkflows from "../src/extension/index.js";
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

type FakeContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, type?: string) => void;
    setWidget: (key: string, lines: string[] | undefined) => void;
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
}) {
  const notifications: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const shortcuts = new Map<string, (ctx: FakeContext) => void>();
  let command: RegisteredCommand | null = null;
  let tool: RegisteredTool | null = null;

  const ctx: FakeContext = {
    cwd: options.cwd,
    hasUI: true,
    ui: {
      notify: (message) => notifications.push(message),
      setWidget: (_key, lines) => widgets.push(lines),
    },
  };

  const pi = {
    registerCommand: (_name: string, spec: RegisteredCommand) => {
      command = spec;
    },
    registerTool: (spec: RegisteredTool) => {
      tool = spec;
    },
    registerShortcut: (key: string, spec: { handler: (ctx: FakeContext) => void }) => {
      shortcuts.set(key, spec.handler);
    },
    on: (event: string, listener: () => void) => {
      const queue = listeners.get(event) ?? [];
      queue.push(listener);
      listeners.set(event, queue);
    },
    sendUserMessage: (prompt: string) => {
      // Deliver asynchronously like the real runtime would.
      queueMicrotask(() => options.respond(prompt, tool as RegisteredTool));
    },
  };

  piWorkflows(pi as never);
  if (!command || !tool) {
    throw new Error("extension did not register command and tool");
  }
  return {
    ctx,
    notifications,
    widgets,
    command: command as RegisteredCommand,
    tool: tool as RegisteredTool,
    shortcuts,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

async function writeEchoWorkflow(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".pi", "workflows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "mini.workflow.ts"),
    `import { agent, defineWorkflow } from "pi-workflows";

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

function stepFromPrompt(prompt: string): { step: string; attempt: string } | null {
  const match = prompt.match(/"step": "([^"]+)", "attempt": "([^"]+)"/);
  return match ? { step: match[1] as string, attempt: match[2] as string } : null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pi-workflows extension", () => {
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

      const runDirs = await fs.readdir(runsDir);
      expect(runDirs).toHaveLength(1);
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
        `import { checkpoint, defineWorkflow } from "pi-workflows";

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
      await waitFor(() =>
        harness.notifications.some((note) => note.includes("awaiting your decision")),
      );
      expect(harness.notifications.at(-1)).toContain(
        "parked at checkpoint review — run ended, awaiting your decision",
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
});
