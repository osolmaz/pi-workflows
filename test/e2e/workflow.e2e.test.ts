import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowClient } from "../../src/client/client.js";
import { SqliteControllerStore } from "../../src/controllers/sqlite.js";
import { buildWidgetView } from "../../src/extension/widget.js";
import { HostStateStore, type InteractiveRequestRecord } from "../../src/host/state.js";
import { workflowStatePath } from "../../src/state/database.js";
import { parseJson, type JsonValue } from "../../src/state/json.js";
import { WorkflowRunStore } from "../../src/workflows/store.js";
import type { WorkflowRunState } from "../../src/workflows/types.js";
import { makeTempDir } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const EXTENSION_PATH = path.join(REPO_ROOT, "src", "extension", "index.ts");

const ASSISTANT_WORKFLOW = `import { agent, assistantMessage, compute, defineWorkflow, notify } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "assistant-e2e",
  presentationPrompt: "Summarize the completed E2E workflow.",
  startAt: "report",
  nodes: {
    report: notify({ message: () => "Durable E2E progress." }),
    prepare: agent({
      prompt: () => "Submit the structured E2E input.",
      expectedOutput: '{ "ready": true }',
    }),
    present: agent({
      prompt: () => "Write the visible assistant E2E response.",
      expectedOutput: assistantMessage(),
    }),
    finish: compute({
      run: ({ outputs }) => ({ prepared: outputs.prepare, visible: outputs.present }),
    }),
  },
  edges: [
    { from: "report", to: "prepare" },
    { from: "prepare", to: "present" },
    { from: "present", to: "finish" },
  ],
});
`;

const RESTART_WORKFLOW = `import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "restart-e2e",
  startAt: "work",
  nodes: {
    work: agent({
      prompt: () => "Submit the durable restart E2E result.",
      expectedOutput: '{ "finished": true }',
    }),
    finish: compute({ run: ({ outputs }) => outputs.work }),
  },
  edges: [{ from: "work", to: "finish" }],
});
`;

const PAUSE_RESUME_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "pause-resume-e2e",
  startAt: "work",
  nodes: {
    work: agent({
      prompt: () => "Submit the durable pause and resume E2E result.",
      expectedOutput: '{ "resumed": true }',
    }),
  },
  edges: [],
});
`;

const MULTI_STEP_WIDGET_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "multi-step-widget-e2e",
  startAt: "first",
  nodes: {
    first: agent({
      prompt: () => "Submit the first multi-step widget result.",
      expectedOutput: '{ "first": true }',
    }),
    second: agent({
      prompt: () => "Submit the second multi-step widget result.",
      expectedOutput: '{ "second": true }',
    }),
  },
  edges: [{ from: "first", to: "second" }],
});
`;

const CONTROLLER = `import { conditionTrue, defineController } from "@osolmaz/pi-workflows/controllers";

export default defineController({
  name: "hosted-e2e",
  initialStatus: (spec) => ({
    phase: "new",
    resolverPid: process.pid,
    workerPid: null,
    value: typeof spec === "object" && spec !== null && "value" in spec ? spec.value : null,
  }),
  reconcile: (ctx, resource) => ctx.settled({
    controllerStatus: {
      ...resource.status.controllerStatus,
      phase: "done",
      workerPid: process.pid,
    },
    conditions: [conditionTrue("Ready", "Complete")],
  }),
});
`;

type RpcHandle = {
  child: ChildProcess;
  stdoutLines: string[];
  stderr: () => string;
  send: (command: Record<string, unknown>) => void;
  stop: () => Promise<void>;
};

type RpcState = {
  isStreaming: boolean;
  pendingMessageCount: number;
};

let rpcRequest = 0;

function startPiRpc(options: {
  cwd: string;
  env: Record<string, string>;
  sessionDir: string;
  session: { id: string } | { file: string };
}): RpcHandle {
  const sessionArgs =
    "id" in options.session
      ? ["--session-id", options.session.id]
      : ["--session", options.session.file];
  const child = spawn(
    process.execPath,
    [
      PI_BIN,
      "--mode",
      "rpc",
      ...sessionArgs,
      "--session-dir",
      options.sessionDir,
      "--no-skills",
      "--no-themes",
      "--no-prompt-templates",
      "--no-context-files",
      "--offline",
      "-e",
      EXTENSION_PATH,
      "--provider",
      "mock",
      "--model",
      "mock-model",
    ],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdoutLines: string[] = [];
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    stdoutLines.push(...lines.filter((line) => line.trim().length > 0));
  });
  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });

  return {
    child,
    stdoutLines,
    stderr: () => stderrText,
    send: (command) => child.stdin?.write(`${JSON.stringify(command)}\n`),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
      const waitForExit = (): Promise<boolean> =>
        Promise.race([
          exited,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
        ]);

      child.stdin?.end();
      if (await waitForExit()) return;
      child.kill("SIGTERM");
      if (await waitForExit()) return;
      child.kill("SIGKILL");
      await waitForExit();
    },
  };
}

async function readRpcState(pi: RpcHandle): Promise<RpcState> {
  const id = `e2e-state-${++rpcRequest}`;
  const start = pi.stdoutLines.length;
  pi.send({ id, type: "get_state" });
  await waitForCondition(
    () => pi.stdoutLines.slice(start).some((line) => line.includes(`"id":"${id}"`)),
    () => rpcDiagnostic(pi),
  );
  const response = pi.stdoutLines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((value) => value.id === id);
  if (!isRecord(response?.data)) throw new Error(`Pi RPC get_state ${id} returned no state`);
  return response.data as RpcState;
}

async function readRpcEntries(pi: RpcHandle): Promise<Array<Record<string, unknown>>> {
  const id = `e2e-entries-${++rpcRequest}`;
  const start = pi.stdoutLines.length;
  pi.send({ id, type: "get_entries" });
  await waitForCondition(
    () => pi.stdoutLines.slice(start).some((line) => line.includes(`"id":"${id}"`)),
    () => rpcDiagnostic(pi),
  );
  const response = pi.stdoutLines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((value) => value.id === id);
  const entries = isRecord(response?.data) ? response.data.entries : undefined;
  if (!Array.isArray(entries)) throw new Error(`Pi RPC get_entries ${id} returned no entries`);
  return entries.filter(isRecord);
}

async function waitForPiIdle(pi: RpcHandle, timeoutMs = 30_000): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await readRpcState(pi);
      return !state.isStreaming && state.pendingMessageCount === 0;
    },
    () => rpcDiagnostic(pi),
    timeoutMs,
  );
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  onTimeout: () => string,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for condition.\n${onTimeout()}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForRun(
  databasePath: string,
  workflowName: string,
  predicate: (state: WorkflowRunState) => boolean,
  onTimeout: () => string,
  timeoutMs = 45_000,
): Promise<{ state: WorkflowRunState; runId: string }> {
  let found: { state: WorkflowRunState; runId: string } | undefined;
  await waitForCondition(
    () => {
      try {
        const store = new WorkflowRunStore(databasePath, { readOnly: true });
        try {
          const run = store
            .listRuns()
            .find(
              (candidate) =>
                candidate.state.workflowName === workflowName && predicate(candidate.state),
            );
          if (run === undefined) return false;
          found = { state: run.state, runId: run.state.runId };
          return true;
        } finally {
          store.close();
        }
      } catch {
        return false;
      }
    },
    onTimeout,
    timeoutMs,
  );
  if (found === undefined) throw new Error(`Workflow ${workflowName} was not found`);
  return found;
}

async function waitForPendingInteraction(
  databasePath: string,
  sessionId: string,
  workflowName: string,
  onTimeout: () => string,
): Promise<InteractiveRequestRecord> {
  let found: InteractiveRequestRecord | undefined;
  await waitForCondition(
    () => {
      try {
        const host = new HostStateStore(databasePath, { readOnly: true });
        const runs = new WorkflowRunStore(databasePath, { readOnly: true });
        try {
          found = host
            .listPendingInteractions(sessionId)
            .find(
              (interaction) => runs.readRun(interaction.runId)?.state.workflowName === workflowName,
            );
          return found !== undefined;
        } finally {
          runs.close();
          host.close();
        }
      } catch {
        return false;
      }
    },
    onTimeout,
    30_000,
  );
  if (found === undefined) throw new Error(`No pending interaction for ${workflowName}`);
  return found;
}

function requestEntryKeys(entries: Array<Record<string, unknown>>, requestId: string): string[] {
  return entries.flatMap((entry) => {
    if (!isRecord(entry.details) || entry.details.requestId !== requestId) return [];
    if (typeof entry.id !== "string" || typeof entry.details.workflowMessageId !== "string") {
      return [];
    }
    return [`${entry.id}:${entry.details.workflowMessageId}`];
  });
}

function customEntriesForRun(
  entries: Array<Record<string, unknown>>,
  customType: string,
  runId: string,
): Array<Record<string, unknown>> {
  return entries.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === customType &&
      isRecord(entry.details) &&
      (entry.details.runId === runId ||
        (isRecord(entry.details.contract) && entry.details.contract.runId === runId)),
  );
}

async function waitForRequestEntry(pi: RpcHandle, requestId: string): Promise<void> {
  await waitForCondition(
    async () => requestEntryKeys(await readRpcEntries(pi), requestId).length > 0,
    () => rpcDiagnostic(pi),
    30_000,
  );
}

async function waitForRequestEntries(
  pi: RpcHandle,
  requestId: string,
  expected: string[],
): Promise<void> {
  await waitForCondition(
    async () => {
      const actual = requestEntryKeys(await readRpcEntries(pi), requestId);
      return JSON.stringify(actual) === JSON.stringify(expected);
    },
    () => rpcDiagnostic(pi),
    30_000,
  );
}

function latestStepContract(messages: Array<{ content?: unknown }>): {
  workflow: string;
  step: string;
  attempt: string;
} | null {
  const text = JSON.stringify(messages);
  const matches = [
    ...text.matchAll(
      /workflow step contract \(workflow: ([^,]+), step: ([^,]+), attempt: ([a-z0-9-]+)\)/giu,
    ),
  ];
  const match = matches.at(-1);
  return match === undefined
    ? null
    : { workflow: match[1] as string, step: match[2] as string, attempt: match[3] as string };
}

function rpcDiagnostic(pi: RpcHandle): string {
  return `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-20).join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe.sequential("out-of-process workflow host end to end", () => {
  let mock: Awaited<ReturnType<typeof startMockOpenAiServer>>;
  let pi: RpcHandle;
  let projectDir: string;
  let agentDir: string;
  let databasePath: string;
  let sessionDir: string;
  let sessionId: string;
  let holdPauseSubmission = true;
  let holdRestartSubmission = true;

  const piEnvironment = (): Record<string, string> => ({
    HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: "1",
  });

  beforeAll(async () => {
    mock = await startMockOpenAiServer(
      ({ messages, lastRole }) => {
        if (lastRole === "tool") return { kind: "text", text: "Workflow tool result accepted." };
        if (JSON.stringify(messages.at(-1)).includes("Summarize the completed E2E workflow.")) {
          return { kind: "text", text: "Final hosted E2E summary." };
        }
        const contract = latestStepContract(messages);
        if (contract === null) return { kind: "text", text: "No workflow step is pending." };
        if (contract.workflow === "assistant-e2e" && contract.step === "prepare") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: contract.step,
              attempt: contract.attempt,
              output: { ready: true },
            },
          };
        }
        if (contract.workflow === "assistant-e2e" && contract.step === "present") {
          return { kind: "text", text: "Visible assistant E2E response." };
        }
        if (contract.workflow === "multi-step-widget-e2e") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: contract.step,
              attempt: contract.attempt,
              output: contract.step === "first" ? { first: true } : { second: true },
            },
            ...(contract.step === "second"
              ? { thinking: "Hold the second workflow turn open for inspection. ".repeat(300) }
              : {}),
          };
        }
        if (contract.workflow === "pause-resume-e2e") {
          if (holdPauseSubmission) {
            return { kind: "text", text: "Waiting for the pause. ".repeat(500) };
          }
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: contract.step,
              attempt: contract.attempt,
              output: { resumed: true },
            },
          };
        }
        if (contract.workflow === "restart-e2e") {
          if (holdRestartSubmission) {
            return { kind: "text", text: "The durable request is still pending." };
          }
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: contract.step,
              attempt: contract.attempt,
              output: { finished: true },
            },
          };
        }
        return { kind: "text", text: "No scripted response." };
      },
      {
        textChunkSize: 7,
        thinkingChunkSize: 10,
        toolArgumentChunkSize: 11,
        chunkDelayMs: 5,
      },
    );

    projectDir = await makeTempDir("pi-workflows-host-e2e-project");
    agentDir = await makeTempDir("pi-workflows-host-e2e-agent");
    databasePath = workflowStatePath(agentDir);
    sessionDir = path.join(agentDir, "sessions");
    sessionId = randomUUID();
    await fs.mkdir(path.join(projectDir, ".pi", "workflows"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".pi", "controllers"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "assistant-e2e.workflow.ts"),
      ASSISTANT_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "restart-e2e.workflow.ts"),
      RESTART_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "pause-resume-e2e.workflow.ts"),
      PAUSE_RESUME_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "multi-step-widget-e2e.workflow.ts"),
      MULTI_STEP_WIDGET_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "controllers", "hosted-e2e.controller.ts"),
      CONTROLLER,
    );
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            mock: {
              name: "Mock",
              baseUrl: mock.baseUrl,
              api: "openai-completions",
              apiKey: "mock-key",
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              models: [{ id: "mock-model" }],
            },
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n");
    pi = startPiRpc({
      cwd: projectDir,
      env: piEnvironment(),
      sessionDir,
      session: { id: sessionId },
    });
    await waitForPiIdle(pi);
  }, 60_000);

  afterAll(async () => {
    await pi?.stop();
    const client = new WorkflowClient({ databasePath });
    try {
      await client.request({ operation: "host.stop" });
    } catch {
      // The host is already stopped.
    }
    await mock?.close();
  });

  it("marks a completed agent node done while the next agent turn runs", async () => {
    const requestStart = mock.requests.length;
    pi.send({
      id: "multi-step-widget-start",
      type: "prompt",
      message: "/workflow multi-step-widget-e2e",
    });
    await waitForCondition(
      () =>
        mock.requests
          .slice(requestStart)
          .some(({ messages }) =>
            JSON.stringify(messages.at(-1)).includes("Submit the second multi-step widget result."),
          ),
      () => rpcDiagnostic(pi),
      30_000,
    );

    const { runId } = await waitForRun(
      databasePath,
      "multi-step-widget-e2e",
      (candidate) => candidate.results.first?.outcome === "ok",
      () => rpcDiagnostic(pi),
    );
    const client = new WorkflowClient({ databasePath });
    let runView = await client.getRun(runId);
    await waitForCondition(
      async () => {
        runView = await client.getRun(runId);
        return runView?.display.status === "running" && runView.display.activity === "origin_turn";
      },
      () => rpcDiagnostic(pi),
      10_000,
    );
    await client.close();
    if (runView === null) throw new Error("Multi-step widget run view disappeared");
    expect(runView.display).toMatchObject({ status: "running", activity: "origin_turn" });
    expect(runView.state).toMatchObject({
      status: "waiting",
      waitingOn: "second",
      currentAttemptId: expect.any(String),
      results: { first: { outcome: "ok" } },
    });
    if (!isRecord(runView.state) || typeof runView.state.currentAttemptId !== "string") {
      throw new Error("Current attempt disappeared");
    }
    const currentAttemptId = runView.state.currentAttemptId;
    const { stdout: piwOutput } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(REPO_ROOT, "src", "viewer", "cli.ts"), "view", runId, "--once"],
      { cwd: REPO_ROOT, env: { ...process.env, ...piEnvironment() } },
    );
    expect(piwOutput).toContain("● running");
    expect(piwOutput).toContain("✓ first · ok");
    expect(piwOutput).not.toContain("○ waiting");

    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    try {
      const loaded = store.readRun(runId);
      if (loaded === null) throw new Error("Multi-step widget run disappeared");
      expect(loaded.state).toMatchObject({
        status: "waiting",
        waitingOn: "second",
        currentAttemptId,
        results: { first: { outcome: "ok" } },
      });
      expect(loaded.state.currentNode).toBeUndefined();

      const lines = buildWidgetView(
        loaded.state,
        loaded.snapshot,
        undefined,
        null,
        false,
        100,
        undefined,
        undefined,
        undefined,
        runView.display.status,
      ).lines;
      expect(lines.find((line) => line.includes("first"))).toContain("✓");
      expect(lines.find((line) => line.includes("second"))).toContain("◐");
      expect(lines.join("\n")).not.toContain("second · waiting");
    } finally {
      store.close();
    }

    const completed = await waitForRun(
      databasePath,
      "multi-step-widget-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(completed.state.results).toMatchObject({
      first: { outcome: "ok" },
      second: { outcome: "ok" },
    });
  }, 60_000);

  it("runs structured and visible agent steps through the origin Pi session", async () => {
    pi.send({ id: "assistant-start", type: "prompt", message: "/workflow assistant-e2e" });
    const { state, runId } = await waitForRun(
      databasePath,
      "assistant-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(state.finalOutput).toEqual({
      prepared: { ready: true },
      visible: "Visible assistant E2E response.",
    });
    await waitForCondition(
      async () => {
        const entries = await readRpcEntries(pi);
        return (
          entries.some((entry) => JSON.stringify(entry).includes("Durable E2E progress.")) &&
          entries.some((entry) => JSON.stringify(entry).includes("Final hosted E2E summary."))
        );
      },
      () => rpcDiagnostic(pi),
      30_000,
    );
    await waitForPiIdle(pi);
    const entries = await readRpcEntries(pi);
    expect(
      entries.some((entry) => JSON.stringify(entry).includes("Visible assistant E2E response.")),
    ).toBe(true);

    const stepEntries = customEntriesForRun(entries, "pi-workflows-step", runId);
    expect(stepEntries).toHaveLength(2);
    const stepRequestIds = stepEntries.map((entry) =>
      isRecord(entry.details) ? entry.details.requestId : undefined,
    );
    expect(stepRequestIds.every((requestId) => typeof requestId === "string")).toBe(true);
    expect(new Set(stepRequestIds)).toHaveLength(2);
    expect(customEntriesForRun(entries, "pi-workflows-notification", runId)).toHaveLength(1);
    expect(customEntriesForRun(entries, "pi-workflows-presentation", runId)).toHaveLength(1);

    for (const deliveryPrompt of [
      "Submit the structured E2E input.",
      "Write the visible assistant E2E response.",
      "Summarize the completed E2E workflow.",
    ]) {
      expect(
        mock.requests.filter(({ messages }) =>
          JSON.stringify(messages.at(-1)).includes(deliveryPrompt),
        ),
      ).toHaveLength(1);
    }

    const store = new SqliteControllerStore(databasePath, { readOnly: true, global: true });
    try {
      const workers = store.state.connection
        .prepare("SELECT pid, status FROM run_workers WHERE run_id = ? ORDER BY started_at")
        .all(runId) as Array<{ pid: number | null; status: string }>;
      expect(workers).not.toHaveLength(0);
      expect(workers.every((worker) => worker.pid !== process.pid)).toBe(true);
      expect(workers.some((worker) => worker.status === "exited")).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it("starts a fresh origin-session turn after pause and resume", async () => {
    const requestStart = mock.requests.length;
    pi.send({ id: "pause-start", type: "prompt", message: "/workflow pause-resume-e2e" });
    await waitForCondition(
      () =>
        mock.requests
          .slice(requestStart)
          .some(({ messages }) =>
            JSON.stringify(messages.at(-1)).includes(
              "Submit the durable pause and resume E2E result.",
            ),
          ),
      () => rpcDiagnostic(pi),
      30_000,
    );

    pi.send({ id: "pause-abort", type: "abort" });
    const paused = await waitForRun(
      databasePath,
      "pause-resume-e2e",
      (candidate) => candidate.paused === true,
      () => rpcDiagnostic(pi),
    );
    await waitForPiIdle(pi);

    holdPauseSubmission = false;
    pi.send({ id: "pause-resume", type: "prompt", message: "/workflow resume" });
    const { state } = await waitForRun(
      databasePath,
      "pause-resume-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
      60_000,
    );
    expect(state.finalOutput).toEqual({ resumed: true });
    await waitForPiIdle(pi);

    const client = new WorkflowClient({ databasePath });
    let runReceipt: JsonValue | undefined;
    await waitForCondition(
      async () => {
        const runView = await client.request({
          operation: "view.run.get",
          runId: paused.runId,
        });
        runReceipt = runView.receipt;
        if (!isRecord(runReceipt) || !isRecord(runReceipt.session)) return false;
        const { capture, integrity } = runReceipt.session;
        return (
          isRecord(capture) &&
          capture.status === "complete" &&
          isRecord(integrity) &&
          integrity.status === "complete"
        );
      },
      () => rpcDiagnostic(pi),
      30_000,
    );
    await client.close();
    expect(runReceipt).toMatchObject({
      session: {
        capture: { status: "complete" },
        integrity: { status: "complete", diagnostics: [] },
      },
    });

    const stepEntries = customEntriesForRun(
      await readRpcEntries(pi),
      "pi-workflows-step",
      paused.runId,
    );
    expect(stepEntries).toHaveLength(2);
    const details = stepEntries.map((entry) => entry.details).filter(isRecord);
    expect(details.map((value) => value.reason)).toEqual(["initial", "resumed"]);
    expect(new Set(details.map((value) => value.requestId))).toHaveLength(1);
    expect(new Set(details.map((value) => value.workflowMessageId))).toHaveLength(2);
    expect(
      mock.requests
        .slice(requestStart)
        .filter(({ messages }) =>
          JSON.stringify(messages.at(-1)).includes(
            "Submit the durable pause and resume E2E result.",
          ),
        ),
    ).toHaveLength(2);
  }, 90_000);

  it("adopts one durable interaction across a real Pi restart", async () => {
    pi.send({ id: "restart-start", type: "prompt", message: "/workflow restart-e2e" });
    const interaction = await waitForPendingInteraction(
      databasePath,
      sessionId,
      "restart-e2e",
      () => rpcDiagnostic(pi),
    );
    await waitForRequestEntry(pi, interaction.requestId);
    await waitForPiIdle(pi);
    const requestEntriesBeforeRestart = requestEntryKeys(
      await readRpcEntries(pi),
      interaction.requestId,
    );
    expect(new Set(requestEntriesBeforeRestart)).toHaveLength(requestEntriesBeforeRestart.length);
    const beforeRestartStore = new WorkflowRunStore(databasePath, { readOnly: true });
    try {
      expect(beforeRestartStore.readRun(interaction.runId)?.state).toMatchObject({
        status: "waiting",
        waitingOn: "work",
        currentAttemptId: interaction.attemptId,
      });
    } finally {
      beforeRestartStore.close();
    }

    await pi.stop();
    const sessionFileName = (await fs.readdir(sessionDir)).find((name) => name.includes(sessionId));
    if (sessionFileName === undefined)
      throw new Error("Pi session was not persisted before restart");
    pi = startPiRpc({
      cwd: projectDir,
      env: piEnvironment(),
      sessionDir,
      session: { file: path.join(sessionDir, sessionFileName) },
    });
    await waitForRequestEntries(pi, interaction.requestId, requestEntriesBeforeRestart);
    await waitForPiIdle(pi);
    const afterRestartStore = new WorkflowRunStore(databasePath, { readOnly: true });
    try {
      expect(afterRestartStore.readRun(interaction.runId)?.state).toMatchObject({
        status: "waiting",
        waitingOn: "work",
        currentAttemptId: interaction.attemptId,
      });
    } finally {
      afterRestartStore.close();
    }

    holdRestartSubmission = false;
    pi.send({ id: "restart-continue", type: "prompt", message: "Complete the pending workflow." });
    const { state } = await waitForRun(
      databasePath,
      "restart-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(state.finalOutput).toEqual({ finished: true });
    expect(requestEntryKeys(await readRpcEntries(pi), interaction.requestId)).toEqual(
      requestEntriesBeforeRestart,
    );

    const hostState = new HostStateStore(databasePath, { readOnly: true });
    let submission:
      | { submissionId: string; idempotencyKey: string; payload: JsonValue }
      | undefined;
    try {
      const row = hostState.state.connection
        .prepare(
          `SELECT s.submission_id AS submissionId, s.idempotency_key AS idempotencyKey,
                  b.content AS payload
           FROM interactive_submissions s JOIN blobs b ON b.blob_hash = s.payload_hash
           WHERE s.request_id = ? AND s.outcome = 'accepted'`,
        )
        .get(interaction.requestId) as
        | { submissionId: string; idempotencyKey: string; payload: Buffer }
        | undefined;
      if (row !== undefined) {
        submission = {
          submissionId: row.submissionId,
          idempotencyKey: row.idempotencyKey,
          payload: parseJson(row.payload.toString("utf8")),
        };
      }
    } finally {
      hostState.close();
    }
    if (submission === undefined) throw new Error("Accepted interaction submission is missing");

    const currentState = new HostStateStore(databasePath, { readOnly: true });
    const current = currentState.getInteraction(interaction.requestId);
    currentState.close();
    if (current === undefined) throw new Error("Durable interaction is missing");
    const contract = interaction.contract as {
      contract: { nodeId: string; attemptId: string };
    };
    const client = new WorkflowClient({ databasePath, clientId: "e2e-replay-client" });
    const adopted = await client.request({
      operation: "interaction.submit",
      runId: interaction.runId,
      expectedRevision: current.revision,
      idempotencyKey: submission.idempotencyKey,
      payload: {
        requestId: interaction.requestId,
        submissionId: submission.submissionId,
        step: contract.contract.nodeId,
        attempt: contract.contract.attemptId,
        value: submission.payload,
      },
    });
    expect(adopted.outcome).toBe("adopted");

    const stale = await client.request({
      operation: "interaction.submit",
      runId: interaction.runId,
      expectedRevision: current.revision,
      payload: {
        requestId: interaction.requestId,
        submissionId: "stale-e2e-submission",
        step: contract.contract.nodeId,
        attempt: "stale-attempt",
        value: { output: { finished: false } },
      },
    });
    expect(stale).toMatchObject({
      outcome: "conflict",
      error: "Interactive request attempt is stale",
    });
  }, 75_000);

  it("applies and reconciles a controller through supervised children", async () => {
    pi.send({
      id: "controller-apply",
      type: "prompt",
      message: '/controller apply hosted-e2e item-1 {"value":7}',
    });
    await waitForCondition(
      () => {
        try {
          const store = new SqliteControllerStore(databasePath, {
            projectPath: projectDir,
            readOnly: true,
          });
          try {
            const resource = store.getResource<
              unknown,
              { phase: string; resolverPid: number; workerPid: number | null; value: number }
            >({ controller: "hosted-e2e", key: "item-1" });
            return resource?.status.controllerStatus.phase === "done";
          } finally {
            store.close();
          }
        } catch {
          return false;
        }
      },
      () => rpcDiagnostic(pi),
      45_000,
    );
    const store = new SqliteControllerStore(databasePath, {
      projectPath: projectDir,
      readOnly: true,
    });
    try {
      const resource = store.getResource<
        unknown,
        { phase: string; resolverPid: number; workerPid: number | null; value: number }
      >({ controller: "hosted-e2e", key: "item-1" });
      expect(resource?.status).toMatchObject({
        observedGeneration: 1,
        controllerStatus: { phase: "done", value: 7 },
        conditions: [{ type: "Ready", status: true, reason: "Complete" }],
      });
      expect(resource?.status.controllerStatus.resolverPid).not.toBe(process.pid);
      expect(resource?.status.controllerStatus.workerPid).not.toBe(process.pid);
      expect(resource?.status.controllerStatus.workerPid).not.toBe(
        resource?.status.controllerStatus.resolverPid,
      );
    } finally {
      store.close();
    }
  }, 60_000);

  it("reports privacy-safe host state and renders a completed run", async () => {
    const client = new WorkflowClient({ databasePath });
    const status = await client.request({ operation: "host.status" });
    expect(status.receipt).toMatchObject({
      state: "running",
      socketAvailable: true,
      lifecycleContradictions: 0,
    });
    expect(status.receipt).not.toHaveProperty("hostId");
    expect(status.receipt).not.toHaveProperty("pid");
    expect(status.receipt).not.toHaveProperty("projectPath");
    expect(status.receipt).not.toHaveProperty("sessionId");

    const { runId } = await waitForRun(
      databasePath,
      "assistant-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(REPO_ROOT, "src", "viewer", "cli.ts"), "view", runId, "--once"],
      { cwd: REPO_ROOT, env: { ...process.env, ...piEnvironment() } },
    );
    expect(stdout).toContain("workflow assistant-e2e");
    expect(stdout).toContain("prepare");
    expect(stdout).toContain("present");
    expect(stdout).toContain("✓ completed");
  }, 30_000);
});
