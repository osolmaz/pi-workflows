import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import piWorkflows from "../src/extension/index.js";
import { WorkflowHostClient } from "../src/host/client.js";
import { HostStateStore } from "../src/host/state.js";
import { workflowStatePath } from "../src/state/database.js";
import { makeTempDir, waitUntil } from "./helpers.js";

let testHome: string | undefined;

afterEach(async () => {
  if (testHome !== undefined) {
    const client = new WorkflowHostClient({ databasePath: workflowStatePath(testHome) });
    try {
      await client.request({ operation: "host.stop" });
    } catch {
      // The test did not start a host or already stopped it.
    }
  }
  testHome = undefined;
  vi.unstubAllEnvs();
});

type FakeContext = ReturnType<typeof makePi>["ctx"];

function makePi(options: { cwd: string; sessionId?: string; branch?: Record<string, unknown>[] }) {
  const branch = options.branch ?? [];
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Array<(event: unknown, ctx: FakeContext) => Promise<void>>>();
  let command: ((args: string, ctx: FakeContext) => Promise<void>) | undefined;
  let tool:
    | ((
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (update: unknown) => void,
        ctx: FakeContext,
      ) => Promise<unknown>)
    | undefined;
  const ctx = {
    cwd: options.cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    abort() {},
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-one",
      getBranch: () => branch,
      getLeafId: () => null,
      getSessionFile: () => undefined,
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
  } as never;
  const pi = {
    registerMessageRenderer() {},
    registerCommand(_name: string, spec: { handler: typeof command }) {
      command = spec.handler;
    },
    registerTool(spec: { execute: typeof tool }) {
      tool = spec.execute;
    },
    on(name: string, handler: (event: unknown, context: FakeContext) => Promise<void>) {
      const current = listeners.get(name) ?? [];
      current.push(handler);
      listeners.set(name, current);
    },
    sendMessage(message: Record<string, unknown>) {
      const entry = {
        id: `entry-${branch.length + 1}`,
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
      };
      branch.push(entry);
      sent.push(entry);
    },
  } as never;
  piWorkflows(pi);
  return {
    ctx,
    branch,
    sent,
    runCommand: async (args: string) => {
      if (command === undefined) throw new Error("workflow command was not registered");
      await command(args, ctx);
    },
    runTool: async (toolCallId: string, params: Record<string, unknown>) => {
      if (tool === undefined) throw new Error("workflow tool was not registered");
      return await tool(toolCallId, params, new AbortController().signal, () => {}, ctx);
    },
    emit: async (name: string) => {
      for (const listener of listeners.get(name) ?? []) await listener({}, ctx);
    },
  };
}

async function setupProject(): Promise<{ cwd: string; workflowPath: string }> {
  testHome = await makeTempDir("pi-workflows-hosted-extension-home");
  vi.stubEnv("HOME", testHome);
  const cwd = await makeTempDir("pi-workflows-hosted-extension-project");
  const workflowPath = path.join(cwd, "interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "hosted-interactive",
  startAt: "ask",
  nodes: {
    ask: agent({ prompt: () => "Return a result." }),
    done: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "done" }],
});\n`,
  );
  return { cwd, workflowPath };
}

function stepContract(entry: Record<string, unknown>): { nodeId: string; attemptId: string } {
  const details = entry.details as { contract?: unknown };
  const contract = details.contract as { nodeId?: unknown; attemptId?: unknown };
  if (typeof contract.nodeId !== "string" || typeof contract.attemptId !== "string") {
    throw new Error("Presented step contract is missing");
  }
  return { nodeId: contract.nodeId, attemptId: contract.attemptId };
}

describe("pi-workflows hosted extension", () => {
  it("starts, presents, updates, and completes an interactive hosted run", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    await fake.runTool("update-one", {
      action: "update",
      step: contract.nodeId,
      attempt: contract.attemptId,
      update: { type: "note", key: "progress", data: { message: "working" } },
    });
    await fake.runTool("submit-one", {
      action: "submit",
      step: contract.nodeId,
      attempt: contract.attemptId,
      output: { answer: "done" },
    });
    await waitUntil(() => {
      const store = new SqliteControllerStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store.listWorkflowRuns()[0]?.status === "done";
      } finally {
        store.close();
      }
    }, 30_000);
    const store = new HostStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(store.listPendingInteractions("session-one")).toEqual([]);
    } finally {
      store.close();
    }
    expect(fake.sent).toHaveLength(1);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("adopts the exact persisted request after a Pi restart without presenting it twice", async () => {
    const { cwd, workflowPath } = await setupProject();
    const branch: Record<string, unknown>[] = [];
    const first = makePi({ cwd, branch, sessionId: "restart-session" });
    await first.emit("session_start");
    await first.runCommand(workflowPath);
    await waitUntil(() => first.sent.length === 1, 30_000);
    await first.emit("session_shutdown");

    const restarted = makePi({ cwd, branch, sessionId: "restart-session" });
    await restarted.emit("session_start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restarted.sent).toEqual([]);
    expect(branch).toHaveLength(1);
    await restarted.emit("session_shutdown");
  }, 60_000);
});
