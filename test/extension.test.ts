import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowClient } from "../src/client/client.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  NdjsonFrameDecoder,
  clientSocketPath,
  encodeProtocolLine,
  parseClientMessage,
} from "../src/client/protocol.js";
import type { ClientEvent } from "../src/client/protocol.js";
import type { WorkflowDisplayStatus, WorkflowSessionView } from "../src/client/view.js";
import piWorkflows from "../src/extension/index.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { ServerStateStore } from "../src/server/state.js";
import { StateDatabase, workflowStatePath } from "../src/state/database.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, waitUntil } from "./helpers.js";

let testHome: string | undefined;

afterEach(async () => {
  if (testHome !== undefined) {
    const client = new WorkflowClient({ databasePath: workflowStatePath(testHome) });
    try {
      await client.request({ operation: "server.stop" });
    } catch {
      // The test did not start a workflow server or already stopped it.
    }
  }
  testHome = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type FakeContext = ReturnType<typeof makePi>["ctx"];

function makePi(options: {
  cwd: string;
  sessionId?: string;
  branch?: Record<string, unknown>[];
  idle?: boolean;
  mode?: "tui" | "rpc";
  persistSentMessages?: boolean;
  signal?: AbortSignal;
}) {
  const branch = options.branch ?? [];
  const sent: Record<string, unknown>[] = [];
  const deferred: Record<string, unknown>[] = [];
  let idle = options.idle ?? true;
  const notifications: Array<{ message: string; level?: string }> = [];
  const widgets: unknown[] = [];
  const statuses: Array<string | undefined> = [];
  const shortcuts = new Map<string, (ctx: unknown) => void>();
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
    mode: options.mode ?? "tui",
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    get signal() {
      return options.signal;
    },
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
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
      setWidget(_key: string, content: unknown) {
        widgets.push(content);
      },
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
    registerShortcut(shortcut: string, spec: { handler: (context: unknown) => void }) {
      shortcuts.set(shortcut, spec.handler);
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
        display: message.display,
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
    widgets,
    statuses,
    shortcuts,
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
    runResourceManagerCommand: async (args: string) => {
      const command = commands.get("resource-manager");
      if (command === undefined) throw new Error("resource manager command was not registered");
      await command(args, ctx);
    },
    runChannelCommand: async (args: string) => {
      const command = commands.get("workflow-channel");
      if (command === undefined) throw new Error("workflow-channel command was not registered");
      await command(args, ctx);
    },
    runTool: async (toolCallId: string, params: Record<string, unknown>) => {
      if (tool === undefined) throw new Error("workflow tool was not registered");
      return await tool(toolCallId, params, new AbortController().signal, () => {}, ctx);
    },
    emit: async (name: string, event: unknown = {}) => {
      for (const listener of listeners.get(name) ?? []) await listener(event, ctx);
    },
  };
}

async function setupProject(): Promise<{ cwd: string; workflowPath: string }> {
  testHome = await makeTempDir("pw-ext-home");
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("PI_WORKFLOWS_CONFIG_DIR", shortcutsConfigDir());
  const cwd = await makeTempDir("pw-ext-project");
  const workflowPath = path.join(cwd, "interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "server-interactive",
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

/** Shortcut configuration lives in the stubbed temp config directory, never the real one. */
function shortcutsConfigDir(): string {
  if (testHome === undefined) throw new Error("the test home directory is not configured");
  return path.join(testHome, "pi-workflows-config");
}

function shortcutsConfigPath(): string {
  return path.join(shortcutsConfigDir(), "shortcuts.json");
}

async function writeShortcutsConfig(config: Record<string, unknown>): Promise<string> {
  await fs.mkdir(shortcutsConfigDir(), { recursive: true });
  const filePath = shortcutsConfigPath();
  await fs.writeFile(filePath, JSON.stringify({ schema: "pi-workflows.shortcuts.v1", ...config }));
  return filePath;
}

function renderedWidget(fake: ReturnType<typeof makePi>): string {
  const widget = fake.widgets.findLast((value) => typeof value === "function") as
    | ((tui: unknown, theme: unknown) => { render: (width: number) => string[] })
    | undefined;
  if (widget === undefined) throw new Error("no widget was rendered");
  return widget(undefined, {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  })
    .render(80)
    .join("\n");
}

/** Eleven nodes overflow the widget window, so the scroll keys change what is visible. */
async function writeTallWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "tall.workflow.ts");
  const nodeLines = Array.from(
    { length: 10 },
    (_value, index) => `    n${index}: compute({ run: () => ${index} }),`,
  ).join("\n");
  const edgeLines = Array.from(
    { length: 10 },
    (_value, index) => `    { from: "${index === 0 ? "ask" : `n${index - 1}`}", to: "n${index}" },`,
  ).join("\n");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "server-tall",
  startAt: "ask",
  nodes: {
    ask: agent({ prompt: () => "Return a result." }),
${nodeLines}
  },
  edges: [
${edgeLines}
  ],
});\n`,
  );
  return workflowPath;
}

/** A topology far wider than one widget node window. */
async function writeWideWorkflow(cwd: string, nodeCount: number): Promise<string> {
  const workflowPath = path.join(cwd, "wide.workflow.ts");
  const names = Array.from(
    { length: nodeCount },
    (_, index) => `n${String(index).padStart(3, "0")}`,
  );
  const nodeLines = names
    .map((name, index) => `    ${name}: compute({ run: () => ${index} }),`)
    .join("\n");
  const edgeLines = [
    `    { from: "ask", to: "${names[0]}" },`,
    ...names.slice(1).map((name, index) => `    { from: "${names[index]}", to: "${name}" },`),
  ].join("\n");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "server-wide",
  startAt: "ask",
  nodes: {
    ask: agent({ prompt: () => "Return a result." }),
${nodeLines}
  },
  edges: [
${edgeLines}
  ],
});\n`,
  );
  return workflowPath;
}

async function writeValidatedWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "validated.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "server-validated",
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
  name: ${JSON.stringify(protectedDecision ? "protected-server" : "checkpoint-server")},
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

async function writeDeliveryWorkflow(
  cwd: string,
  options: {
    stem?: string;
    name?: string;
    notification?: string;
  } = {},
): Promise<string> {
  const workflowPath = path.join(cwd, `${options.stem ?? "delivery"}.workflow.ts`);
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, notify } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: ${JSON.stringify(options.name ?? "extension-delivery")},
  startAt: "notify",
  nodes: {
    notify: notify({ message: () => ${JSON.stringify(
      options.notification ?? "Passive server update.",
    )} }),
    done: compute({ run: () => ({ complete: true }) }),
  },
  edges: [{ from: "notify", to: "done" }],
});\n`,
  );
  return workflowPath;
}

async function writeTerminalWorkflow(
  cwd: string,
  options: { stem: string; name: string },
): Promise<string> {
  const workflowPath = path.join(cwd, `${options.stem}.workflow.ts`);
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: ${JSON.stringify(options.name)},
  startAt: "done",
  nodes: { done: compute({ run: () => ({ complete: true }) }) },
  edges: [],
});\n`,
  );
  return workflowPath;
}

function stepContract(entry: Record<string, unknown>): {
  requestId: string;
  nodeId: string;
  attemptId: string;
} {
  const details = entry.details as { contract?: unknown };
  const contract = details.contract as {
    requestId?: unknown;
    nodeId?: unknown;
    attemptId?: unknown;
  };
  if (
    typeof contract.requestId !== "string" ||
    typeof contract.nodeId !== "string" ||
    typeof contract.attemptId !== "string"
  ) {
    throw new Error("Presented step contract is missing");
  }
  return { requestId: contract.requestId, nodeId: contract.nodeId, attemptId: contract.attemptId };
}

function widgetSessionSnapshot(
  revision: number,
  displayStatus: WorkflowDisplayStatus,
  waitingOn: string,
  stepTotal: number,
): WorkflowSessionView {
  const at = "2026-09-11T00:00:00.000Z";
  const runId = "widget-refresh-run";
  return {
    schema: "pi-workflows.session-view.v1",
    sessionId: "session-one",
    run: {
      schema: "pi-workflows.session-run-view.v1",
      runId,
      revision,
      runRevision: revision,
      display: {
        status: displayStatus,
        activity: displayStatus === "running" ? "origin_turn" : null,
        controls: [],
        reason: null,
      },
      workflowName: "widget-refresh",
      runTitle: null,
      paused: displayStatus === "paused",
      currentNode: displayStatus === "running" ? "runReview" : null,
      waitingOn: displayStatus === "running" ? null : waitingOn,
      error: null,
      nodes: [
        {
          nodeId: "publish",
          nodeType: "agent",
          actionExecution: false,
          state: displayStatus === "running" ? "ok" : "waiting",
          attempts: stepTotal,
          settingsChangeNumber: null,
          statusDetail: null,
          startedAt: null,
          durationMs: null,
          error: null,
          humanDecision: null,
          summary: null,
          assistantResponse: false,
          outcome: displayStatus === "running" ? "ok" : null,
        },
        {
          nodeId: "runReview",
          nodeType: "agent",
          actionExecution: false,
          state: displayStatus === "running" ? "running" : "pending",
          attempts: displayStatus === "running" ? 1 : 0,
          settingsChangeNumber: null,
          statusDetail: null,
          startedAt: null,
          durationMs: null,
          error: null,
          humanDecision: null,
          summary: null,
          assistantResponse: false,
          outcome: null,
        },
      ],
      nodeStart: 0,
      nodeTotal: 2,
      progressUpdates: [],
      monitorEstimate: null,
      monitorSchedule: null,
      live: true,
      possiblyInterrupted: false,
      queue: {
        runId,
        workflowName: "widget-refresh",
        workflowSourceRef: "builtin:autoimplement",
        initialized: true,
        definitionDigest: "digest",
        status: "running",
        originSessionId: "session-one",
        executionMode: "interactive",
        parentRunId: null,
        rootRunId: runId,
        lineageKind: null,
        restartNumber: 0,
        parentRunRevision: null,
        errorCode: null,
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        finishedAt: null,
      },
    },
    interaction: null,
    workflowMessage: null,
    openWorkflowTurn: null,
    coordinatorEpoch: "test-epoch",
    coordinatorActive: false,
    branchReportRequired: false,
  };
}

function sessionSnapshotEvent(revision: number, payload: WorkflowSessionView): ClientEvent {
  return {
    schema: "pi-workflows.client.v1",
    type: "event",
    subscriptionId: "widget-refresh-subscription",
    event: "session_snapshot",
    revision,
    payload: payload as unknown as ClientEvent["payload"],
  };
}

describe("pi-workflows workflow server extension", () => {
  it("reports channel status through the workflow client", async () => {
    const { cwd } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runChannelCommand("status");
    expect(fake.notifications.at(-1)).toEqual({
      message: "Human decisions use the Pi channel only.",
      level: "info",
    });
    await fake.emit("session_shutdown");
  }, 30_000);

  it("does not write durable claim commands while an idle session has no delivery", async () => {
    const { cwd } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await fake.emit("session_shutdown");

    const state = new StateDatabase({ filePath: workflowStatePath(), mode: "read-only" });
    try {
      expect(
        state.connection.prepare("SELECT count(*) AS count FROM server_commands").get(),
      ).toEqual({ count: 0 });
    } finally {
      state.close();
    }
  }, 30_000);

  it("reconnects the session after initial workflow server startup fails", async () => {
    const { cwd, workflowPath } = await setupProject();
    const originalEnsureAvailable = WorkflowClient.prototype.ensureAvailable;
    const ensureAvailable = vi
      .spyOn(WorkflowClient.prototype, "ensureAvailable")
      .mockRejectedValueOnce(new Error("injected startup failure"))
      .mockImplementation(function (this: WorkflowClient) {
        return originalEnsureAvailable.call(this);
      });
    const watchSession = vi.spyOn(WorkflowClient.prototype, "watchSession");
    const fake = makePi({ cwd });

    await fake.emit("session_start");
    await waitUntil(
      () =>
        fake.notifications.some(
          (notification) =>
            notification.level === "warning" &&
            notification.message.includes("injected startup failure"),
        ),
      5_000,
    );
    await waitUntil(() => ensureAvailable.mock.calls.length >= 2, 30_000);
    await waitUntil(() => watchSession.mock.calls.length === 1, 30_000);

    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(fake.sent).toHaveLength(1);
    expect(watchSession).toHaveBeenCalledTimes(1);
    expect(
      fake.notifications.filter((notification) =>
        notification.message.startsWith("Workflow server is unavailable:"),
      ),
    ).toHaveLength(1);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("updates the widget without waiting for complete run history", async () => {
    const { cwd } = await setupProject();
    let listener: ((event: ClientEvent) => void) | undefined;
    vi.spyOn(WorkflowClient.prototype, "ensureAvailable").mockResolvedValue({
      schema: "pi-workflows.client.v1",
      type: "hello",
      connectionId: "widget-refresh-connection",
      packageVersion: "test",
    });
    vi.spyOn(WorkflowClient.prototype, "watchSession").mockImplementation(
      async (_sessionId, next) => {
        listener = next;
        return async () => {};
      },
    );
    const request = vi.spyOn(WorkflowClient.prototype, "request").mockImplementation((options) => {
      if (options.operation === "view.page") return new Promise<never>(() => {});
      return Promise.reject(new Error(`Unexpected request: ${options.operation}`));
    });
    const fake = makePi({ cwd });

    await fake.emit("session_start");
    await waitUntil(() => listener !== undefined, 5_000);
    listener?.(sessionSnapshotEvent(1, widgetSessionSnapshot(1, "waiting", "publish", 0)));
    await waitUntil(() => fake.statuses.at(-1)?.includes("[waiting] publish") === true, 5_000);

    // A complete-view client would wait for this missing step page. The Pi
    // extension needs only the bounded session projection for its widget.
    listener?.(sessionSnapshotEvent(2, widgetSessionSnapshot(2, "running", "runReview", 1)));
    await waitUntil(() => fake.statuses.at(-1)?.includes("[running] runReview") === true, 5_000);
    const widget = fake.widgets.findLast((value) => typeof value === "function") as (
      tui: unknown,
      theme: { bold: (text: string) => string; fg: (_color: string, text: string) => string },
    ) => { render: (width: number) => string[] };
    const rendered = widget(undefined, {
      bold: (text) => text,
      fg: (_color, text) => text,
    }).render(80);
    expect(rendered.join("\n")).toContain("runReview");
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "view.page" }));

    await fake.emit("session_shutdown");
  }, 30_000);

  it("starts, presents, updates, and completes an interactive run", async () => {
    const { cwd, workflowPath } = await setupProject();
    const durableRequests = vi.spyOn(WorkflowClient.prototype, "requestDurable");
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    await fake.runTool("update-one", {
      action: "update",
      requestId: contract.requestId,
      update: { type: "note", key: "progress", data: { message: "working" } },
    });
    await fake.runTool("submit-one", {
      action: "submit",
      requestId: contract.requestId,
      output: { answer: "done" },
    });
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store.listWorkflowRuns()[0]?.status === "done";
      } finally {
        store.close();
      }
    }, 30_000);
    const store = new ServerStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(store.listPendingInteractions("session-one")).toEqual([]);
    } finally {
      store.close();
    }
    // Lost tool acknowledgments must adopt the accepted result after the pending view is empty.
    await expect(
      fake.runTool("submit-one", {
        action: "submit",
        requestId: contract.requestId,
        output: { answer: "done" },
      }),
    ).resolves.toBeDefined();
    await expect(
      fake.runTool("submit-one", {
        action: "submit",
        requestId: contract.requestId,
        output: { answer: "different" },
      }),
    ).rejects.toThrow(/different|conflict|reuse/i);
    const afterReplay = new ServerStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(
        afterReplay.state.connection
          .prepare("SELECT count(*) AS count FROM interactive_submissions")
          .get(),
      ).toEqual({ count: 1 });
      expect(afterReplay.listPendingInteractions("session-one")).toEqual([]);
    } finally {
      afterReplay.close();
    }
    expect(
      fake.sent.filter((entry) => (entry.details as { contract?: unknown }).contract !== undefined),
    ).toHaveLength(1);
    expect(durableRequests.mock.calls.map(([options]) => options.operation)).toEqual(
      expect.arrayContaining(["run.start", "interaction.update", "interaction.submit"]),
    );
    await fake.emit("session_shutdown");
    durableRequests.mockRestore();
  }, 60_000);

  it("returns the child run identity after restart", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    await fake.runTool("complete-before-restart", {
      action: "submit",
      requestId: contract.requestId,
      output: { answer: "done" },
    });

    let parentRunId = "";
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        const parent = store.listWorkflowRuns().find((run) => run.status === "done");
        parentRunId = parent?.runId ?? "";
        return parent !== undefined;
      } finally {
        store.close();
      }
    }, 30_000);
    const runStore = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
    const parentRunRevision = runStore.runRevision(parentRunId);
    runStore.close();

    const restarted = (await fake.runTool("restart-completed-run", {
      action: "restart",
      runId: parentRunId,
      expectedRevision: parentRunRevision,
    })) as {
      content: Array<{ text: string }>;
      details: {
        action: string;
        runId: string;
        parentRunId: string;
        restartNumber: number;
      };
    };
    expect(restarted.details).toMatchObject({
      action: "restart",
      parentRunId,
      restartNumber: 1,
    });
    expect(restarted.details.runId).not.toBe(parentRunId);
    expect(restarted.content[0]?.text).toContain(
      `Created child workflow run ${restarted.details.runId} from terminal parent ${parentRunId}`,
    );
    expect(restarted.content[0]?.text).toContain("Continue with the child run.");

    const childStatus = (await fake.runTool("status-restarted-child", {
      action: "status",
      runId: restarted.details.runId,
    })) as { details: { action: string; runId: string } };
    expect(childStatus.details).toMatchObject({
      action: "status",
      runId: restarted.details.runId,
    });
    await fake.emit("session_shutdown");
  }, 60_000);

  it("shows workflow server state and pauses a waiting step when Escape aborts its turn", async () => {
    const { cwd, workflowPath } = await setupProject();
    const abort = new AbortController();
    abort.abort();
    const fake = makePi({ cwd, signal: abort.signal });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    await waitUntil(() => fake.widgets.some((widget) => typeof widget === "function"), 30_000);
    expect([...fake.shortcuts.keys()]).toEqual(["ctrl+shift+r", "shift+up", "shift+down"]);
    const widget = fake.widgets.findLast((value) => typeof value === "function") as (
      tui: unknown,
      theme: { bold: (text: string) => string; fg: (_color: string, text: string) => string },
    ) => { render: (width: number) => string[] };
    const rendered = widget(undefined, {
      bold: (text) => text,
      fg: (_color, text) => text,
    }).render(80);
    expect(rendered.join("\n")).toContain("workflow server-interactive");
    fake.shortcuts.get("shift+down")?.(fake.ctx);
    fake.shortcuts.get("shift+up")?.(fake.ctx);

    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    await fake.emit("agent_start");
    await fake.emit("agent_end", {
      messages: [
        {
          role: "custom",
          customType: fake.sent[0]?.customType,
          details: fake.sent[0]?.details,
        },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "This operation was aborted",
        },
      ],
    });
    await fake.emit("agent_settled");
    await waitUntil(() => {
      const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
      try {
        return store.listRuns()[0]?.state.paused === true;
      } finally {
        store.close();
      }
    }, 30_000);
    await waitUntil(() => fake.statuses.at(-1)?.includes("[paused]") === true, 30_000);
    expect(fake.notifications.at(-1)?.message).toContain("durably paused");

    await expect(
      fake.runTool("paused-submit", {
        action: "submit",
        requestId: contract.requestId,
        output: { reply: "too early" },
      }),
    ).rejects.toThrow("Workflow run is paused");

    await fake.runCommand("resume");
    await waitUntil(() => {
      const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
      try {
        return store.listRuns()[0]?.state.paused !== true;
      } finally {
        store.close();
      }
    }, 30_000);
    await waitUntil(() => fake.sent.length === 2, 30_000);
    expect(fake.sent[1]?.details).toMatchObject({
      reason: "resumed",
      requestId: (fake.sent[0]!.details as { requestId: string }).requestId,
    });
    expect((fake.sent[1]!.details as { workflowMessageId: string }).workflowMessageId).not.toBe(
      (fake.sent[0]!.details as { workflowMessageId: string }).workflowMessageId,
    );
    const resumedContract = stepContract(fake.sent[1] as Record<string, unknown>);
    expect(resumedContract).toEqual(contract);
    await expect(
      fake.runTool("resumed-submit", {
        action: "submit",
        requestId: resumedContract.requestId,
        output: { reply: "continued" },
      }),
    ).resolves.toMatchObject({ content: [{ text: "Workflow step output accepted." }] });
    await fake.emit("session_shutdown");
  }, 60_000);

  it("does not bind an unrelated interrupted turn while a workflow is paused", async () => {
    const { cwd, workflowPath } = await setupProject();
    const abort = new AbortController();
    abort.abort();
    const fake = makePi({ cwd, signal: abort.signal });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    await fake.runCommand("pause");
    await waitUntil(() => {
      const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
      try {
        return store.listRuns()[0]?.state.paused === true;
      } finally {
        store.close();
      }
    }, 30_000);

    await fake.emit("agent_start");
    await fake.emit("agent_end", {
      messages: [
        { role: "user", content: "Unrelated request" },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "This operation was aborted",
        },
      ],
    });
    await fake.emit("agent_settled");

    const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
    try {
      expect(store.listRuns()[0]?.state.paused).toBe(true);
    } finally {
      store.close();
    }

    await fake.runCommand("cancel");
    await fake.emit("session_shutdown");
  }, 60_000);

  it("does not pause a waiting step after an ordinary provider error", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);

    await fake.emit("agent_start");
    await fake.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Provider unavailable",
        },
      ],
    });
    await fake.emit("agent_settled");

    const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
    try {
      expect(store.listRuns()[0]?.state.paused).not.toBe(true);
    } finally {
      store.close();
    }
    expect(
      fake.notifications.some((notification) =>
        notification.message.includes("paused because its model turn was interrupted"),
      ),
    ).toBe(false);

    await fake.runCommand("cancel");
    await fake.emit("session_shutdown");
  }, 60_000);

  it("reminds an exact missing submission twice, then reports a bounded failure", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    const state = new ServerStateStore(workflowStatePath(), { readOnly: true });
    try {
      for (let turn = 0; turn < 3; turn += 1) {
        fake.setIdle(false);
        await fake.emit("agent_start");
        await fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
        fake.setIdle(true);
        await fake.emit("agent_settled");
        if (turn < 2) {
          await waitUntil(() => fake.sent.length === turn + 2, 30_000);
          expect(state.getInteraction(contract.requestId)?.status).toBe("pending");
          expect(stepContract(fake.sent.at(-1) as Record<string, unknown>).requestId).toBe(
            contract.requestId,
          );
          expect((fake.sent.at(-1) as { details: { reason: string } }).details.reason).toBe(
            "reminder",
          );
        }
      }
      const runId = state.getInteraction(contract.requestId)!.runId;
      await waitUntil(
        () => state.workflowMessages.listRun(runId).some((message) => message.kind === "terminal"),
        30_000,
      );
      expect(
        state.workflowMessages.listRun(runId).filter((message) => message.kind === "step"),
      ).toHaveLength(3);
      expect(state.getInteraction(contract.requestId)?.status).toBe("cancelled");
      await fake.runCommand("cancel");
    } finally {
      state.close();
      await fake.emit("session_shutdown");
    }
  }, 60_000);

  it("uses serializable widget lines outside TUI mode", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd, mode: "rpc" });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.widgets.some((widget) => Array.isArray(widget)), 30_000);
    const widget = fake.widgets.findLast((value) => Array.isArray(value));
    expect(widget).toEqual(expect.arrayContaining([expect.stringContaining("server-interactive")]));
    await fake.runCommand("cancel");
    await fake.emit("session_shutdown");
    expect(fake.widgets.at(-1)).toBeUndefined();
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
      const store = new ServerStateStore(workflowStatePath(), { readOnly: true });
      try {
        return store.workflowMessages.listSession("session-one")[0]?.piSessionEntryId === "entry-1";
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
      const store = new ServerStateStore(workflowStatePath(), { readOnly: true });
      try {
        return store.listPendingInteractions("session-one").length === 1;
      } finally {
        store.close();
      }
    }, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fake.sent).toEqual([]);
    const pendingStore = new ServerStateStore(workflowStatePath(), { readOnly: true });
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
        requestId: contract.requestId,
        output: { answer: "wrong" },
      }),
    ).rejects.toThrow(/answer must be accepted/);
    const afterRejection = new ServerStateStore(workflowStatePath(), { readOnly: true });
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
        requestId: contract.requestId,
        output: { answer: "accepted" },
      }),
    ).resolves.toMatchObject({
      content: [{ text: "Workflow step output accepted." }],
    });
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
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

  it("rejects a checkpoint answer at an agent request without changing execution", async () => {
    const { cwd, workflowPath } = await setupProject();
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    const store = new ServerStateStore(workflowStatePath(), { readOnly: true });
    const queue = new WorkflowRunQueueStore(workflowStatePath(), {
      readOnly: true,
      global: true,
    });
    try {
      const requests = store.listPendingInteractions("session-one");
      const runs = queue.listWorkflowRuns();
      await expect(
        fake.runTool("wrong-answer", {
          action: "answer",
          requestId: contract.requestId,
          input: { approved: true },
        }),
      ).rejects.toThrow(/Only an ordinary checkpoint/);
      expect(store.listPendingInteractions("session-one")).toEqual(requests);
      expect(queue.listWorkflowRuns()).toEqual(runs);
      await expect(
        fake.runTool("wrong-attempt", {
          action: "submit",
          requestId: "another-request",
          output: { answer: "wrong" },
        }),
      ).rejects.toThrow(/No matching agent request/);
      expect(store.listPendingInteractions("session-one")).toEqual(requests);
      expect(queue.listWorkflowRuns()).toEqual(runs);
      await expect(
        fake.runTool("valid-after-rejection", {
          action: "submit",
          requestId: contract.requestId,
          output: { answer: "done" },
        }),
      ).resolves.toMatchObject({ content: [{ text: "Workflow step output accepted." }] });
    } finally {
      store.close();
      queue.close();
      await fake.emit("session_shutdown");
    }
  }, 60_000);

  it("answers an ordinary checkpoint in the same run through the model-facing action", async () => {
    const { cwd } = await setupProject();
    const workflowPath = await writeCheckpointWorkflow(cwd);
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        const runs = store.listWorkflowRuns();
        const failed = runs.find((run) => run.status === "failed");
        if (failed !== undefined) throw new Error(JSON.stringify(failed));
        return store.findSessionReservation("session-one")?.status === "parked";
      } finally {
        store.close();
      }
    }, 30_000);
    await waitUntil(
      () =>
        fake.sent.some(
          (entry) => (entry.details as { kind?: unknown } | undefined)?.kind === "checkpoint",
        ),
      30_000,
    );
    const checkpointEntry = fake.sent.find(
      (entry) => (entry.details as { kind?: unknown })?.kind === "checkpoint",
    )!;
    const requestId = (checkpointEntry.details as { requestId: string }).requestId;
    const result = await fake.runTool("checkpoint-answer", {
      action: "answer",
      requestId,
      input: { approved: true },
    });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining("Answered checkpoint") }],
    });
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        const runs = store.listWorkflowRuns();
        expect(runs).toHaveLength(1);
        return runs[0]?.status === "done";
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
    if (decisionEntry === undefined) throw new Error("Decision message is missing");
    const requestId = (decisionEntry.details as { requestId: string }).requestId;
    expect(decisionEntry).toMatchObject({
      delivery: { triggerTurn: false },
      content: expect.stringContaining("A human must answer"),
    });
    await expect(
      fake.runTool("forged-model-answer", {
        action: "answer",
        requestId,
        input: { choice: "approve" },
      }),
    ).rejects.toThrow(/Protected human decisions/);

    await fake.runCommand("pause");
    await fake.runCommand(`answer ${requestId} {"choice":"approve"}`);
    expect(fake.notifications.at(-1)).toMatchObject({
      message: expect.stringContaining("Workflow run is paused"),
      level: "error",
    });
    await fake.runCommand("resume");
    await fake.runCommand(`answer ${requestId} {"choice":"approve"}`);
    expect(fake.notifications).toContainEqual(
      expect.objectContaining({ message: "Human decision answer accepted." }),
    );
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        const runs = store.listWorkflowRuns();
        expect(runs).toHaveLength(1);
        return runs[0]?.status === "done";
      } finally {
        store.close();
      }
    }, 30_000);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("submits an assistant response only after the final settled boundary", async () => {
    const { cwd } = await setupProject();
    const workflowPath = path.join(cwd, "assistant.workflow.ts");
    await fs.writeFile(
      workflowPath,
      `
import { agent, assistantMessage, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({
  name: "settled-assistant", startAt: "respond",
  nodes: { respond: agent({ prompt: () => "Explain the recorded result.", expectedOutput: assistantMessage() }) },
  edges: [],
});`,
    );
    const fake = makePi({ cwd });
    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    await waitUntil(() => fake.sent.length === 1, 30_000);
    const contract = stepContract(fake.sent[0] as Record<string, unknown>);
    fake.setIdle(false);
    await fake.emit("agent_start");
    fake.branch.push({
      type: "message",
      id: "retry-response",
      message: {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "Incomplete answer." }],
      },
    });
    await fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    fake.setIdle(true);
    const state = new ServerStateStore(workflowStatePath(), { readOnly: true });
    try {
      expect(state.getInteraction(contract.requestId)?.status).toBe("pending");
      expect(state.workflowMessages.listSession("session-one")).toHaveLength(1);
      fake.setIdle(false);
      await fake.emit("agent_start");
      fake.branch.push({
        type: "message",
        id: "final-response",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "The result is complete." }],
        },
      });
      await fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      expect(state.getInteraction(contract.requestId)?.status).toBe("pending");
      fake.setIdle(true);
      await fake.emit("agent_settled");
      await waitUntil(() => state.getInteraction(contract.requestId)?.status === "settled", 30_000);
      await waitUntil(
        () => fake.sent.some((entry) => entry.customType === "pi-workflows-terminal"),
        30_000,
      );
      const store = new WorkflowRunStore(workflowStatePath(), { readOnly: true });
      try {
        expect(store.listRuns()[0]?.state).toMatchObject({
          status: "completed",
          finalOutput: "The result is complete.",
        });
      } finally {
        store.close();
      }
      expect(state.workflowMessages.listSession("session-one")).toHaveLength(2);
    } finally {
      state.close();
      await fake.emit("session_shutdown");
    }
  }, 60_000);

  it("delivers passive notifications and model-triggering terminal handoffs once each", async () => {
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
    expect(fake.sent.filter((entry) => entry.customType === "pi-workflows-terminal")).toHaveLength(
      0,
    );

    fake.flushSentMessages();
    await fake.emit("agent_settled");
    await waitUntil(
      () => fake.sent.some((entry) => entry.customType === "pi-workflows-terminal"),
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(
      fake.sent.filter((entry) => entry.customType === "pi-workflows-notification"),
    ).toHaveLength(1);
    expect(fake.sent.filter((entry) => entry.customType === "pi-workflows-terminal")).toHaveLength(
      1,
    );
    fake.flushSentMessages();
    await fake.emit("agent_settled");
    expect(
      fake.sent.find((entry) => entry.customType === "pi-workflows-notification"),
    ).toMatchObject({
      content: "Passive server update.",
      delivery: { triggerTurn: false },
    });
    expect(fake.sent.find((entry) => entry.customType === "pi-workflows-terminal")).toMatchObject({
      content: expect.stringContaining('"finalOutput":{"complete":true}'),
      display: true,
      delivery: { triggerTurn: true },
    });
    await fake.emit("session_shutdown");
  }, 60_000);

  it("delivers each terminal notice from its exact run", async () => {
    const { cwd } = await setupProject();
    const firstPath = await writeTerminalWorkflow(cwd, {
      stem: "terminal-first",
      name: "extension-terminal-first",
    });
    const secondPath = await writeTerminalWorkflow(cwd, {
      stem: "terminal-second",
      name: "extension-terminal-second",
    });
    const fake = makePi({ cwd, persistSentMessages: false });
    await fake.emit("session_start");
    await fake.runCommand(firstPath);
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store
          .listWorkflowRuns()
          .some((run) => run.workflowName === "extension-terminal-first" && run.status === "done");
      } finally {
        store.close();
      }
    }, 30_000);
    await fake.runCommand(secondPath);
    await waitUntil(() => {
      const store = new WorkflowRunQueueStore(workflowStatePath(), {
        readOnly: true,
        global: true,
      });
      try {
        return store.listWorkflowRuns().filter((run) => run.status === "done").length === 2;
      } finally {
        store.close();
      }
    }, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fake.emit("agent_settled");
    await waitUntil(
      () =>
        fake.sent.some(
          (entry) =>
            entry.customType === "pi-workflows-terminal" &&
            typeof entry.content === "string" &&
            entry.content.includes("Workflow extension-terminal-first: completed."),
        ),
      30_000,
    );
    expect(fake.sent.filter((entry) => entry.customType === "pi-workflows-terminal")).toHaveLength(
      1,
    );
    fake.flushSentMessages();
    fake.setIdle(false);
    await fake.emit("agent_start");
    await fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    fake.setIdle(true);
    await fake.emit("agent_settled");
    await waitUntil(
      () =>
        fake.sent.some(
          (entry) =>
            entry.customType === "pi-workflows-terminal" &&
            typeof entry.content === "string" &&
            entry.content.includes("Workflow extension-terminal-second: completed."),
        ),
      30_000,
    );
    expect(fake.sent.filter((entry) => entry.customType === "pi-workflows-terminal")).toHaveLength(
      2,
    );
    await fake.emit("session_shutdown");
  }, 90_000);

  it("applies managed resources through the workflow server and a source resolver child", async () => {
    const { cwd } = await setupProject();
    const directory = path.join(cwd, ".pi", "resource-managers");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "sample.resource-manager.ts"),
      `import { defineResourceManager } from ${JSON.stringify(path.resolve("src/resource-managers/index.ts"))};
export default defineResourceManager({
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
    await fake.runResourceManagerCommand('apply sample one {"value":7}');
    await waitUntil(() => {
      const store = new SqliteResourceManagerStore(workflowStatePath(), {
        projectPath: cwd,
        readOnly: true,
      });
      try {
        return store.getResource({ resourceManager: "sample", key: "one" }) !== undefined;
      } finally {
        store.close();
      }
    }, 30_000);
    const store = new SqliteResourceManagerStore(workflowStatePath(), {
      projectPath: cwd,
      readOnly: true,
    });
    try {
      const resource = store.getResource<unknown, { resolverPid: number; value: number }>({
        resourceManager: "sample",
        key: "one",
      });
      expect(resource?.status.resourceManagerStatus.value).toBe(7);
      expect(resource?.status.resourceManagerStatus.resolverPid).not.toBe(process.pid);
    } finally {
      store.close();
    }
    expect(fake.notifications).toContainEqual(
      expect.objectContaining({ message: "Applied managed resource sample/one." }),
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

  it("registers the default scroll shortcuts when no shortcuts file exists", async () => {
    const { cwd } = await setupProject();
    const fake = makePi({ cwd });

    expect([...fake.shortcuts.keys()]).toEqual(["ctrl+shift+r", "shift+up", "shift+down"]);
  });

  it("registers only the configured scroll keys", async () => {
    const { cwd } = await setupProject();

    await writeShortcutsConfig({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" });
    expect([...makePi({ cwd }).shortcuts.keys()]).toEqual([
      "ctrl+shift+r",
      "ctrl+alt+up",
      "ctrl+alt+down",
    ]);

    await writeShortcutsConfig({ scrollUp: null, scrollDown: null });
    expect([...makePi({ cwd }).shortcuts.keys()]).toEqual(["ctrl+shift+r"]);

    await writeShortcutsConfig({ scrollUp: "ctrl+up", scrollDown: "ctrl+up" });
    expect([...makePi({ cwd }).shortcuts.keys()]).toEqual(["ctrl+shift+r", "ctrl+up"]);

    await writeShortcutsConfig({ scrollUp: "ctrl+shift+r", scrollDown: "ctrl+alt+down" });
    expect([...makePi({ cwd }).shortcuts.keys()]).toEqual(["ctrl+shift+r", "ctrl+alt+down"]);
  });

  it("warns once about an unusable shortcuts file and registers nothing for it", async () => {
    const { cwd } = await setupProject();
    const configPath = await writeShortcutsConfig({ scrollUp: "meta+up" });
    const fake = makePi({ cwd });
    expect([...fake.shortcuts.keys()]).toEqual(["ctrl+shift+r", "shift+down"]);

    await fake.emit("session_start");

    const warnings = fake.notifications.filter((notice) =>
      notice.message.includes("shortcuts.json"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe("warning");
    expect(warnings[0]?.message).toContain(configPath);
    expect(warnings[0]?.message).toContain('"meta+up"');

    await fake.emit("session_start");
    expect(
      fake.notifications.filter((notice) => notice.message.includes("shortcuts.json")),
    ).toHaveLength(1);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("pages the widget window at its edge and keeps a failed request loaded", async () => {
    const { cwd } = await setupProject();
    await writeShortcutsConfig({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" });
    const workflowPath = await writeWideWorkflow(cwd, 300);
    const fake = makePi({ cwd });

    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    const rendered = (): string =>
      fake.widgets.some((value) => typeof value === "function") ? renderedWidget(fake) : "";
    await waitUntil(() => rendered().includes("ƒ n000"), 30_000);
    // The first window cannot hold the complete topology.
    expect(rendered()).not.toContain("ƒ n299");

    const requested = vi.spyOn(WorkflowClient.prototype, "setSessionNodeWindow");
    requested.mockRejectedValueOnce(new Error("session window request failed"));
    const scrollDownUntil = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        fake.shortcuts.get("ctrl+alt+down")?.(fake.ctx);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await scrollDownUntil(
      () => requested.mock.calls.length >= 1,
      "the widget never asked for the next window",
    );
    // The press sequence reached the end of the loaded window, so it shows the
    // last rows of that window, not the next one.
    expect(rendered()).toContain("↑ ");
    // A failed request keeps the loaded window and stays retryable.
    expect(rendered()).not.toContain("ƒ n000");
    expect(rendered()).not.toContain("ƒ n299");
    await scrollDownUntil(
      () => requested.mock.calls.length >= 2,
      "the widget never retried its window request",
    );
    await scrollDownUntil(
      () => /ƒ n2\d\d/.test(rendered()),
      "the widget never reached the next window",
    );
    // The paged window replaced the first one instead of appending to it, and it
    // opens at its top so the rows continue where the failed window ended.
    expect(rendered()).not.toContain("ƒ n000");
    expect(rendered()).toContain("↓ ");
    const pagesBeforeUp = requested.mock.calls.length;
    const scrollUpUntil = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        fake.shortcuts.get("ctrl+alt+up")?.(fake.ctx);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await scrollUpUntil(
      () => requested.mock.calls.length > pagesBeforeUp,
      "the widget never asked for the previous window",
    );
    // Scrolling up opens the previous window at its bottom, where the user was.
    await waitUntil(() => rendered().includes("↑ "), 30_000);
    expect(rendered()).toMatch(/ƒ n2\d\d/);
    await fake.emit("session_shutdown");
  }, 120_000);

  it("re-arms the session subscription after a failure during the first publish", async () => {
    const { cwd } = await setupProject();
    if (testHome === undefined) throw new Error("the test home directory is not configured");
    const socketPath = clientSocketPath(workflowStatePath(testHome));
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const watches: Array<{ subscriptionId: string; sessionId: string }> = [];
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "projection-failure",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome: "accepted",
              receipt: { subscribed: true, coordinatorEpoch: "projection-epoch" },
            }),
          );
          if (message.operation !== "view.session.watch") continue;
          const payload = message.payload as { subscriptionId: string; sessionId: string };
          watches.push(payload);
          // The server publishes the first snapshot immediately, so its failure
          // arrives while the extension is still waiting for this response.
          if (watches.length === 1) {
            socket.write(
              encodeProtocolLine({
                schema: CLIENT_PROTOCOL_SCHEMA,
                type: "event",
                subscriptionId: payload.subscriptionId,
                event: "unavailable",
                payload: {
                  schema: "pi-workflows.subscription-failure.v1",
                  reasonCode: "projection_failed",
                  message: "session view exceeds one frame",
                },
              }),
            );
          }
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const fake = makePi({ cwd });
    try {
      await fake.emit("session_start");
      // The failed first subscription must not strand the session view.
      await waitUntil(() => watches.length > 1, 30_000);
      expect(fake.notifications.map((notice) => notice.message)).toEqual([]);
      expect(watches[0]?.sessionId).toBe("session-one");
      expect(watches[1]?.sessionId).toBe("session-one");
      expect(watches[1]?.subscriptionId).not.toBe(watches[0]?.subscriptionId);
      await fake.emit("session_shutdown");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("stays quiet for a usable shortcuts file", async () => {
    const { cwd } = await setupProject();
    await writeShortcutsConfig({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" });
    const fake = makePi({ cwd });

    await fake.emit("session_start");

    expect(
      fake.notifications.filter((notice) => notice.message.includes("shortcuts.json")),
    ).toEqual([]);
    await fake.emit("session_shutdown");
  }, 60_000);

  it("binds the configured scroll key to the widget window and shows the same keys", async () => {
    const { cwd } = await setupProject();
    await writeShortcutsConfig({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" });
    const workflowPath = await writeTallWorkflow(cwd);
    const fake = makePi({ cwd });
    expect([...fake.shortcuts.keys()]).toEqual(["ctrl+shift+r", "ctrl+alt+up", "ctrl+alt+down"]);

    await fake.emit("session_start");
    await fake.runCommand(workflowPath);
    const rendered = (): string =>
      fake.widgets.some((value) => typeof value === "function") ? renderedWidget(fake) : "";
    // Wait for the step that is pending delivery. Its node is the one the widget
    // shows as working, so the window starts at the top and both keys can move.
    await waitUntil(() => rendered().includes("waiting on step: ask"), 30_000);

    const before = rendered();
    fake.shortcuts.get("ctrl+alt+down")?.(fake.ctx);
    const scrolledDown = rendered();
    expect(scrolledDown).not.toBe(before);
    expect(scrolledDown).toContain("ƒ n3");

    fake.shortcuts.get("ctrl+alt+up")?.(fake.ctx);
    const scrolledBack = rendered();
    expect(scrolledBack).not.toBe(scrolledDown);
    expect(scrolledBack).toContain("ƒ n0");
    await fake.emit("session_shutdown");
  }, 60_000);
});
