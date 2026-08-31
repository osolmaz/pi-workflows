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

function makePi(options: {
  cwd: string;
  sessionId?: string;
  branch?: Record<string, unknown>[];
  idle?: boolean;
  persistSentMessages?: boolean;
}) {
  const branch = options.branch ?? [];
  const sent: Record<string, unknown>[] = [];
  const deferred: Record<string, unknown>[] = [];
  let idle = options.idle ?? true;
  const notifications: Array<{ message: string; level?: string }> = [];
  const listeners = new Map<string, Array<(event: unknown, ctx: FakeContext) => Promise<void>>>();
  const commands = new Map<string, (args: string, ctx: FakeContext) => Promise<void>>();
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
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort() {},
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-one",
      getBranch: () => branch,
      getLeafId: () => null,
      getSessionFile: () => undefined,
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, ...(level === undefined ? {} : { level }) });
      },
      setStatus() {},
      setWidget() {},
    },
  } as never;
  const pi = {
    registerMessageRenderer() {},
    registerCommand(
      name: string,
      spec: { handler: (args: string, ctx: FakeContext) => Promise<void> },
    ) {
      commands.set(name, spec.handler);
    },
    registerTool(spec: { execute: typeof tool }) {
      tool = spec.execute;
    },
    on(name: string, handler: (event: unknown, context: FakeContext) => Promise<void>) {
      const current = listeners.get(name) ?? [];
      current.push(handler);
      listeners.set(name, current);
    },
    sendMessage(message: Record<string, unknown>, delivery?: Record<string, unknown>) {
      const entry = {
        id: `entry-${sent.length + 1}`,
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        details: message.details,
        delivery,
      };
      sent.push(entry);
      if (options.persistSentMessages === false) deferred.push(entry);
      else branch.push(entry);
    },
  } as never;
  piWorkflows(pi);
  return {
    ctx,
    branch,
    sent,
    notifications,
    setIdle(value: boolean) {
      idle = value;
    },
    flushSentMessages() {
      branch.push(...deferred.splice(0));
    },
    runCommand: async (args: string) => {
      const command = commands.get("workflow");
      if (command === undefined) throw new Error("workflow command was not registered");
      await command(args, ctx);
    },
    runControllerCommand: async (args: string) => {
      const command = commands.get("controller");
      if (command === undefined) throw new Error("controller command was not registered");
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

async function writeValidatedWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "validated.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "hosted-validated",
  startAt: "ask",
  nodes: {
    ask: agent({
      prompt: () => "Return the accepted answer.",
      validate: (output) => {
        if (typeof output !== "object" || output === null || output.answer !== "accepted") {
          throw new Error("answer must be accepted");
        }
        return output;
      },
    }),
    done: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "done" }],
});\n`,
  );
  return workflowPath;
}

async function writeCheckpointWorkflow(cwd: string, protectedDecision = false): Promise<string> {
  const workflowPath = path.join(
    cwd,
    protectedDecision ? "protected.workflow.ts" : "checkpoint.workflow.ts",
  );
  const gate = protectedDecision
    ? `const choices = defineHumanChoices({
  approve: choice({ label: "Approve" }),
  reject: choice({ label: "Reject" }),
});
const gate = humanDecision({
  audience: "operator",
  choices,
  request: () => ({
    title: "Approve the protected action",
    subject: { action: "test" },
    presentation: {
      schema: "pi-workflows.decision-presentation.v1",
      summary: "A human must approve this test action.",
      blocks: [{ kind: "paragraph", text: "Review the action before approval." }],
    },
  }),
});`
    : `const gate = checkpoint({ summary: "Continue the ordinary checkpoint" });`;
  const edge = protectedDecision
    ? `humanDecisionEdge({ from: "gate", choices, cases: { approve: "done", reject: "done" } })`
    : `{ from: "gate", to: "done" }`;
  await fs.writeFile(
    workflowPath,
    `import {
  checkpoint,
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
${gate}
export default defineWorkflow({
  name: ${JSON.stringify(protectedDecision ? "protected-hosted" : "checkpoint-hosted")},
  startAt: "gate",
  nodes: {
    gate,
    done: compute({ run: ({ input, outputs }) => ({ input, gate: outputs.gate }) }),
  },
  edges: [${edge}],
});\n`,
  );
  return workflowPath;
}

async function writeDeliveryWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "delivery.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, notify } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "extension-delivery",
  presentationPrompt: "Explain the completed delivery result.",
  startAt: "notify",
  nodes: {
    notify: notify({ message: () => "Passive hosted update." }),
    done: compute({ run: () => ({ complete: true }) }),
  },
  edges: [{ from: "notify", to: "done" }],
});\n`,
  );
  return workflowPath;
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

  it("does not repeat a step while Pi delays the queued session entry", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd, persistSentMessages: false });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.sent).toHaveLength(1);

    fake.flushSentMessages();
    await fake.emit("agent_settled");
    await waitUntil(() => {
      const store = new HostStateStore(workflowStatePath(), { readOnly: true });
      try {
        return (
          store.listPendingInteractions("session-one")[0]?.presentationSessionEntryId === "entry-1"
        );
      } finally {
        store.close();
      }
    }, 30_000);
    expect(fake.sent).toHaveLength(1);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("waits for Pi to become idle before it claims or sends a step", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd, idle: false });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => {
      const store = new HostStateStore(workflowStatePath(), { readOnly: true });
      try {
        return store.listPendingInteractions("session-one").length === 1;
      } finally {
        store.close();
      }
    }, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.sent).toEqual([]);
    const pendingStore = new HostStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(pendingStore.listPendingInteractions("session-one")[0]).toMatchObject({
        status: "pending",
        revision: 1,
      });
    } finally {
      pendingStore.close();
    }

    fake.setIdle(true);
    await fake.emit("agent_settled");
    await waitUntil(() => fake.sent.length === 1, 30_000);
    expect(fake.sent).toHaveLength(1);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("rejects invalid child-validated output and accepts a corrected submission", async () => {
    const { cwd } = await setupProject();
    const workflowPath = await writeValidatedWorkflow(cwd);
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);

    await expect(
      fake.runTool("submit-invalid", {
        action: "submit",
        step: contract.nodeId,
        attempt: contract.attemptId,
        output: { answer: "wrong" },
      }),
    ).rejects.toThrow(/answer must be accepted/);
    const afterRejection = new HostStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(afterRejection.listPendingInteractions("session-one")).toHaveLength(1);
      expect(
        afterRejection.interactionSubmission(
          afterRejection.listPendingInteractions("session-one")[0]?.requestId ?? "",
          "submit-invalid",
        ),
      ).toMatchObject({
        outcome: "rejected",
        receipt: { status: "rejected", error: "answer must be accepted" },
      });
    } finally {
      afterRejection.close();
    }

    await expect(
      fake.runTool("submit-corrected", {
        action: "submit",
        step: contract.nodeId,
        attempt: contract.attemptId,
        output: { answer: "accepted" },
      }),
    ).resolves.toMatchObject({
      content: [{ text: "Workflow step output accepted." }],
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
    await fake.emit("session_shutdown");
  }, 60_000);

  it("continues an ordinary checkpoint through the model-facing answer action", async () => {
    const { cwd } = await setupProject();
    const workflowPath = await writeCheckpointWorkflow(cwd);
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => {
      const store = new SqliteControllerStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store.findSessionReservation("session-one")?.status === "parked";
      } finally {
        store.close();
      }
    }, 30_000);
    const result = await fake.runTool("checkpoint-answer", {
      action: "answer",
      input: { approved: true },
    });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining("Answered checkpoint") }],
    });
    await waitUntil(() => {
      const store = new SqliteControllerStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store
          .listWorkflowRuns()
          .some((run) => run.parentRunId !== null && run.status === "done");
      } finally {
        store.close();
      }
    }, 30_000);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("keeps protected decisions out of the model-facing workflow tool", async () => {
    const { cwd } = await setupProject();
    const workflowPath = await writeCheckpointWorkflow(cwd, true);
    const fake = makePi({ cwd, persistSentMessages: false });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(
      () =>
        fake.sent.some(
          (entry) => (entry.details as { kind?: unknown } | undefined)?.kind === "decision",
        ),
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.sent).toHaveLength(1);
    fake.flushSentMessages();
    await fake.emit("agent_settled");
    const decisionEntry = fake.sent.find(
      (entry) => (entry.details as { kind?: unknown } | undefined)?.kind === "decision",
    );
    expect(decisionEntry).toMatchObject({
      delivery: { triggerTurn: false },
      content: expect.stringContaining("A human must answer"),
    });
    await expect(
      fake.runTool("forged-model-answer", {
        action: "answer",
        input: { choice: "approve" },
      }),
    ).rejects.toThrow(/Protected human decisions/);

    await fake.runCommand('answer {"choice":"approve"}');
    expect(fake.notifications).toContainEqual(
      expect.objectContaining({ message: "Human decision answer accepted." }),
    );
    await waitUntil(() => {
      const store = new SqliteControllerStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store
          .listWorkflowRuns()
          .some((run) => run.parentRunId !== null && run.status === "done");
      } finally {
        store.close();
      }
    }, 30_000);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("delivers hosted notifications and the terminal presentation turn once each", async () => {
    const { cwd } = await setupProject();
    const workflowPath = await writeDeliveryWorkflow(cwd);
    const fake = makePi({ cwd, persistSentMessages: false });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(
      () => fake.sent.some((entry) => entry.customType === "pi-workflows-notification"),
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(
      fake.sent.filter((entry) => entry.customType === "pi-workflows-notification"),
    ).toHaveLength(1);
    expect(
      fake.sent.filter((entry) => entry.customType === "pi-workflows-presentation"),
    ).toHaveLength(0);

    fake.flushSentMessages();
    await fake.emit("agent_settled");
    await waitUntil(
      () => fake.sent.some((entry) => entry.customType === "pi-workflows-presentation"),
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(
      fake.sent.filter((entry) => entry.customType === "pi-workflows-notification"),
    ).toHaveLength(1);
    expect(
      fake.sent.filter((entry) => entry.customType === "pi-workflows-presentation"),
    ).toHaveLength(1);
    fake.flushSentMessages();
    await fake.emit("agent_settled");
    expect(
      fake.sent.find((entry) => entry.customType === "pi-workflows-notification"),
    ).toMatchObject({
      content: "Passive hosted update.",
      delivery: { triggerTurn: false },
    });
    expect(
      fake.sent.find((entry) => entry.customType === "pi-workflows-presentation"),
    ).toMatchObject({
      content: expect.stringContaining("Explain the completed delivery result."),
      delivery: { triggerTurn: true },
    });
    await fake.emit("session_shutdown");
  }, 60_000);

  it("applies controller resources through the host and a source resolver child", async () => {
    const { cwd } = await setupProject();
    const directory = path.join(cwd, ".pi", "controllers");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "sample.controller.ts"),
      `import { defineController } from ${JSON.stringify(path.resolve("src/controllers/index.ts"))};
export default defineController({
  name: "sample",
  initialStatus: (spec) => ({
    resolverPid: process.pid,
    value: typeof spec === "object" && spec !== null && "value" in spec ? spec.value : null,
  }),
  reconcile: (ctx) => ctx.settled(),
});\n`,
    );
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runControllerCommand('apply sample one {"value":7}');
    await waitUntil(() => {
      const store = new SqliteControllerStore(workflowStatePath(), {
        projectPath: cwd,
        readOnly: true,
      });
      try {
        return store.getResource({ controller: "sample", key: "one" }) !== undefined;
      } finally {
        store.close();
      }
    }, 30_000);
    const store = new SqliteControllerStore(workflowStatePath(), {
      projectPath: cwd,
      readOnly: true,
    });
    try {
      const resource = store.getResource<unknown, { resolverPid: number; value: number }>({
        controller: "sample",
        key: "one",
      });
      expect(resource?.status.controllerStatus.value).toBe(7);
      expect(resource?.status.controllerStatus.resolverPid).not.toBe(process.pid);
    } finally {
      store.close();
    }
    expect(fake.notifications).toContainEqual(
      expect.objectContaining({ message: "Applied controller resource sample/one." }),
    );
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
