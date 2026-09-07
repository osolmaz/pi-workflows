import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowClient } from "../../src/client/client.js";
import { buildWidgetView } from "../../src/extension/widget.js";
import { branchWorkflowEntries } from "../../src/extension/workflow-message-coordinator.js";
import { SqliteResourceManagerStore } from "../../src/resource-managers/sqlite.js";
import { ServerStateStore } from "../../src/server/state.js";
import { StateDatabase, workflowStatePath } from "../../src/state/database.js";
import { parseJson, type JsonValue } from "../../src/state/json.js";
import { WorkflowRunQueueStore } from "../../src/workflows/queue.js";
import type { InteractiveRequestRecord } from "../../src/workflows/requests.js";
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

const TIMEOUT_RECOVERY_WORKFLOW = `import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";
import { existsSync, readFileSync } from "node:fs";
export default defineWorkflow({
  name: "timeout-recovery-e2e",
  startAt: "work",
  nodes: {
    work: agent({ timeoutMs: 4000, prompt: () => "Save partial work, then run the timeout E2E command until aborted." }),
    recover: agent({
      allowedTools: ["read"],
      prompt: () => "Inspect the stopped timeout command and preserve the saved partial repair.",
      expectedOutput: '{ "commandsSettled": true }',
      validate: (value) => { if (value.commandsSettled !== true) throw new Error("Command must settle first"); return value; },
    }),
    finish: compute({ run: ({ input }) => {
      const pid = Number(readFileSync(input.pidPath, "utf8"));
      let stopped = false;
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") stopped = true; else throw error; }
      if (!stopped) throw new Error("Previous command is still alive");
      if (existsSync("forbidden-recovery-write")) throw new Error("Reconciliation mutated the repository");
      return { partial: readFileSync(input.partialPath, "utf8"), commandStopped: stopped };
    } }),
  },
  edges: [
    { from: "work", switch: { on: "$result.outcome", cases: { timed_out: "recover", failed: "recover", ok: "finish" } } },
    { from: "recover", to: "finish" },
  ],
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

const RESOURCE_MANAGER = `import { conditionTrue, defineResourceManager } from "@osolmaz/pi-workflows/resource-managers";

export default defineResourceManager({
  name: "hosted-e2e",
  initialStatus: (spec) => ({
    phase: "new",
    resolverPid: process.pid,
    runnerPid: null,
    value: typeof spec === "object" && spec !== null && "value" in spec ? spec.value : null,
  }),
  reconcile: (ctx, resource) => ctx.settled({
    resourceManagerStatus: {
      ...resource.status.resourceManagerStatus,
      phase: "done",
      runnerPid: process.pid,
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
        const host = new ServerStateStore(databasePath, { readOnly: true });
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
  requestId: string | undefined;
} | null {
  const text = messages
    .flatMap(({ content }) =>
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((part) =>
              isRecord(part) && typeof part.text === "string" ? [part.text] : [],
            )
          : [],
    )
    .join("\n");
  const matches = [
    ...text.matchAll(
      /workflow step contract \(workflow: ([^,]+), step: ([^,]+), attempt: ([a-z0-9-]+)\)/giu,
    ),
  ];
  const match = matches.at(-1);
  return match === undefined
    ? null
    : {
        workflow: match[1] as string,
        step: match[2] as string,
        attempt: match[3] as string,
        requestId: text.slice(match.index).match(/"requestId":\s*"([^"]+)"/u)?.[1],
      };
}

function commandHasStopped(pidPath: string): boolean {
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
  return false;
}

function rpcDiagnostic(pi: RpcHandle): string {
  const errors = pi.stdoutLines.filter((line) => line.includes('"notifyType":"error"'));
  return `pi stderr:\n${pi.stderr()}\npi errors:\n${errors.join("\n")}\npi stdout tail:\n${pi.stdoutLines.slice(-20).join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe.sequential("out-of-process workflow server end to end", () => {
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
        const contract = latestStepContract(messages);
        if (
          contract?.workflow === "timeout-recovery-e2e" &&
          contract.step === "recover" &&
          lastRole === "tool" &&
          JSON.stringify(messages.at(-1)).includes("not allowed")
        ) {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              requestId: contract.requestId,
              output: {
                commandsSettled: commandHasStopped(path.join(projectDir, "timeout-command.pid")),
              },
            },
          };
        }
        if (lastRole === "tool") return { kind: "text", text: "Workflow tool result accepted." };
        if (JSON.stringify(messages.at(-1)?.content).includes("START_AUTOIMPLEMENT_HANDOFF_TEST")) {
          const repository = path.join(projectDir, "autoimplement-repo");
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "start",
              workflow: "autoimplement",
              input: {
                task: "Verify workspace preparation in this temporary test repository.",
                plan: { summary: "Prepare a temporary worktree, then stop for test cancellation." },
                repository,
                baseBranch: "main",
                workspaceMode: "worktree",
                merge: false,
                scope: `Only inspect and create a local task worktree in ${repository}. Do not implement, push, open a pull request, merge, release, deploy, or touch another repository.`,
              },
            },
          };
        }
        if (contract === null) return { kind: "text", text: "No workflow step is pending." };
        if (contract.workflow === "autoimplement") {
          if (contract.step === "workspace/propose")
            return {
              kind: "tool",
              toolName: "workflow",
              args: {
                action: "submit",
                requestId: contract.requestId,
                output: { branchName: "test/handoff", reason: "Temporary workflow handoff test." },
              },
            };
          return {
            kind: "text",
            text: "The workspace test is complete. Await cancellation without further work.",
          };
        }
        if (contract.workflow === "assistant-e2e" && contract.step === "prepare") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              requestId: contract.requestId,
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
              requestId: contract.requestId,
              output: contract.step === "first" ? { first: true } : { second: true },
            },
            ...(contract.step === "second"
              ? { thinking: "Hold the second workflow turn open for inspection. ".repeat(300) }
              : {}),
          };
        }
        if (contract.workflow === "timeout-recovery-e2e") {
          if (contract.step === "work") {
            const source = `const fs = require('node:fs'); fs.writeFileSync('timeout-partial.txt', 'saved repair'); fs.writeFileSync('timeout-command.pid', String(process.pid)); setInterval(() => {}, 1000);`;
            return {
              kind: "tool",
              toolName: "bash",
              args: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}` },
            };
          }
          return {
            kind: "tool",
            toolName: "bash",
            args: { command: "printf forbidden > forbidden-recovery-write" },
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
              requestId: contract.requestId,
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
              requestId: contract.requestId,
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
    await fs.mkdir(path.join(projectDir, ".pi", "resource-managers"), { recursive: true });
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
      path.join(projectDir, ".pi", "workflows", "timeout-recovery-e2e.workflow.ts"),
      TIMEOUT_RECOVERY_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "multi-step-widget-e2e.workflow.ts"),
      MULTI_STEP_WIDGET_WORKFLOW,
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "resource-managers", "hosted-e2e.resource-manager.ts"),
      RESOURCE_MANAGER,
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
      await client.request({ operation: "server.stop" });
    } catch {
      // The host is already stopped.
    }
    await mock?.close();
  });

  it("starts Autoimplement from normal chat and submits its first delivered step", async () => {
    const repository = path.join(projectDir, "autoimplement-repo");
    await fs.mkdir(repository);
    await execFileAsync("git", ["init", "-b", "main", repository]);
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Workflow Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "test: initialize workspace",
      ],
      { cwd: repository },
    );
    const ordinaryChatStart = pi.stdoutLines.length;
    pi.send({ id: "ordinary-chat", type: "prompt", message: "Respond with a short greeting." });
    await waitForCondition(
      () =>
        pi.stdoutLines.slice(ordinaryChatStart).some((line) => line.includes('"type":"agent_end"')),
      () => rpcDiagnostic(pi),
      30_000,
    );
    await waitForPiIdle(pi);
    pi.send({
      id: "tool-autoimplement-start",
      type: "prompt",
      message: "START_AUTOIMPLEMENT_HANDOFF_TEST",
    });
    const run = await waitForRun(
      databasePath,
      "autoimplement",
      (state) =>
        state.steps.some((step) => step.nodeId === "workspace/ready" && step.outcome === "ok"),
      () => rpcDiagnostic(pi),
    );
    await waitForPiIdle(pi);
    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    let worktreePath: string;
    try {
      const saved = store.readRun(run.runId);
      const workspace = saved?.state.steps.find(
        (step) => step.nodeId === "workspace/ready" && step.outcome === "ok",
      )?.output;
      if (!isRecord(workspace) || typeof workspace.worktreePath !== "string")
        throw new Error("Autoimplement did not save its worktree");
      worktreePath = workspace.worktreePath;
      await fs.stat(worktreePath);
      expect(saved?.state.steps.filter((step) => step.nodeId === "workspace/propose")).toHaveLength(
        1,
      );
      const state = new StateDatabase({ filePath: databasePath, mode: "read-only" });
      try {
        const rows = state.connection
          .prepare(`SELECT i.status, i.consumed_at AS consumedAt, m.status AS deliveryStatus,
          (SELECT COUNT(*) FROM interactive_submissions s WHERE s.request_id = i.request_id AND s.outcome = 'accepted') AS accepted
          FROM interactive_requests i JOIN node_attempts a ON a.attempt_id = i.attempt_id
          JOIN workflow_messages m ON m.source_id = i.request_id
          WHERE i.run_id = ? AND a.node_id = 'workspace/propose'`)
          .all(run.runId);
        expect(rows).toEqual([
          {
            status: "settled",
            consumedAt: expect.any(Number),
            deliveryStatus: "sent",
            accepted: 1,
          },
        ]);
      } finally {
        state.close();
      }
    } finally {
      store.close();
    }
    pi.send({
      id: "cancel-autoimplement-test",
      type: "prompt",
      message: `/workflow cancel ${run.runId}`,
    });
    await waitForRun(
      databasePath,
      "autoimplement",
      (state) => state.status === "cancelled",
      () => rpcDiagnostic(pi),
    );
    await waitForPiIdle(pi);
    await execFileAsync("git", ["worktree", "remove", worktreePath], { cwd: repository });
    await execFileAsync("git", ["branch", "-D", "test/handoff"], { cwd: repository });
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
    expect(runView.display).toMatchObject({
      status: "running",
      activity: "origin_turn",
      controls: ["pause", "cancel", "update", "submit"],
    });
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
    expect(piwOutput).toContain("running");
    expect(piwOutput).toContain("✓ first · ok");
    expect(piwOutput).not.toContain("● running");

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
      expect(lines.find((line) => line.includes("second"))).toContain("○");
      expect(lines.join("\n")).toContain("second · waiting");
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
          customEntriesForRun(entries, "pi-workflows-terminal", runId).length === 1
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
    expect(customEntriesForRun(entries, "pi-workflows-terminal", runId)).toHaveLength(1);

    for (const deliveryPrompt of [
      "Submit the structured E2E input.",
      "Write the visible assistant E2E response.",
    ]) {
      expect(
        mock.requests.filter(({ messages }) =>
          JSON.stringify(messages.at(-1)).includes(deliveryPrompt),
        ),
      ).toHaveLength(1);
    }

    expect(
      mock.requests.filter(({ messages }) =>
        JSON.stringify(messages.at(-1)).includes("Workflow assistant-e2e: completed."),
      ),
    ).toHaveLength(0);

    const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
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

  it("aborts an expired Pi command, preserves partial work, and completes recovery", async () => {
    await waitForPiIdle(pi);
    const input = {
      partialPath: path.join(projectDir, "timeout-partial.txt"),
      pidPath: path.join(projectDir, "timeout-command.pid"),
    };
    pi.send({
      id: "timeout-recovery-start",
      type: "prompt",
      message: `/workflow timeout-recovery-e2e --input-json ${JSON.stringify(input)}`,
    });
    const { state } = await waitForRun(
      databasePath,
      "timeout-recovery-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(state.finalOutput).toEqual({ partial: "saved repair", commandStopped: true });
    expect(
      state.steps
        .filter((step) => ["work", "recover"].includes(step.nodeId))
        .map((step) => [step.nodeId, step.outcome]),
    ).toEqual([
      ["work", "timed_out"],
      ["recover", "ok"],
    ]);
    await waitForPiIdle(pi);
    const store = new ServerStateStore(databasePath, { readOnly: true });
    try {
      const messages = store.workflowMessages
        .listRun(state.runId)
        .filter((message) => message.kind === "step");
      expect(messages).toHaveLength(2);
      const firstTurn = store.workflowMessages.latestTurnForMessage(messages[0]!.workflowMessageId);
      expect(firstTurn).toMatchObject({ state: "ended", stopReason: "aborted" });
      const secondTurn = store.workflowMessages.latestTurnForMessage(
        messages[1]!.workflowMessageId,
      );
      expect(secondTurn?.state).toBe("ended");
      expect(Date.parse(secondTurn!.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(firstTurn!.endedAt!),
      );
      expect(store.getInteraction(messages[0]!.sourceId)?.status).toBe("cancelled");
    } finally {
      store.close();
    }
    const before = pi.stdoutLines.length;
    pi.send({
      id: "ordinary-after-timeout",
      type: "prompt",
      message: "Normal chat after timeout recovery.",
    });
    await waitForCondition(
      () => pi.stdoutLines.slice(before).some((line) => line.includes('"type":"agent_end"')),
      () => rpcDiagnostic(pi),
    );
    await waitForPiIdle(pi);
    expect(
      pi.stdoutLines.slice(before).some((line) => line.includes('"stopReason":"aborted"')),
    ).toBe(false);
  });

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

  it("restarts a recorded terminal run with its execution revision", async () => {
    const source = await waitForRun(
      databasePath,
      "pause-resume-e2e",
      (state) => state.status === "completed",
      () => rpcDiagnostic(pi),
    );
    const client = new WorkflowClient({ databasePath });
    let sourceRevision: number;
    try {
      const view = await client.getRun(source.runId);
      if (view === null) throw new Error("Recorded source view is missing");
      expect(view.revision).not.toBe(view.runRevision);
      sourceRevision = view.runRevision;
      const store = new WorkflowRunStore(databasePath, { readOnly: true });
      try {
        expect(sourceRevision).toBe(store.runRevision(source.runId));
        expect(
          store.state.connection
            .prepare(
              "SELECT e.effect_type, e.status FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id WHERE r.run_id = ? AND e.status IN ('pending', 'applying', 'ambiguous')",
            )
            .all(source.runId),
        ).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      await client.close();
    }
    pi.send({
      id: "recorded-run-restart",
      type: "prompt",
      message: `/workflow restart ${source.runId}`,
    });
    const restarted = await waitForRun(
      databasePath,
      "pause-resume-e2e",
      (state) => state.runId !== source.runId && state.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(restarted.state.finalOutput).toEqual({ resumed: true });
    const queue = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
    try {
      expect(queue.getWorkflowRun(restarted.runId)).toMatchObject({
        parentRunId: source.runId,
        parentRunRevision: sourceRevision,
      });
    } finally {
      queue.close();
    }
    await waitForPiIdle(pi);
  }, 60_000);

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

    const serverState = new ServerStateStore(databasePath, { readOnly: true });
    let submission:
      | { submissionId: string; idempotencyKey: string; payload: JsonValue }
      | undefined;
    try {
      const row = serverState.state.connection
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
      serverState.close();
    }
    if (submission === undefined) throw new Error("Accepted interaction submission is missing");

    const currentState = new ServerStateStore(databasePath, { readOnly: true });
    const current = currentState.getInteraction(interaction.requestId);
    currentState.close();
    if (current === undefined) throw new Error("Durable interaction is missing");
    await waitForPiIdle(pi);
    const entries = [...branchWorkflowEntries(await readRpcEntries(pi))].map(
      ([workflowMessageId, piSessionEntryId]) => ({ workflowMessageId, piSessionEntryId }),
    );
    await pi.stop();
    const client = new WorkflowClient({ databasePath, clientId: "e2e-replay-client" });
    try {
      const watched = await client.request({
        operation: "view.session.watch",
        payload: { subscriptionId: "replay-session", sessionId, coordinator: true },
      });
      const coordinatorEpoch = (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch;
      const authority = { targetSessionId: sessionId, coordinatorEpoch };
      expect(
        (
          await client.request({
            operation: "workflowMessage.reportBranch",
            payload: { ...authority, entries, isIdle: true, hasPendingMessages: false },
          })
        ).outcome,
      ).toBe("accepted");
      const adopted = await client.request({
        operation: "interaction.submit",
        runId: interaction.runId,
        expectedRevision: current.revision,
        idempotencyKey: submission.idempotencyKey,
        payload: {
          ...authority,
          requestId: interaction.requestId,
          submissionId: submission.submissionId,
          value: submission.payload,
        },
      });
      expect(adopted.outcome).toBe("adopted");

      const stale = await client.request({
        operation: "interaction.submit",
        runId: "another-run",
        expectedRevision: current.revision,
        payload: {
          ...authority,
          requestId: interaction.requestId,
          submissionId: "stale-e2e-submission",
          value: { output: { finished: false } },
        },
      });
      expect(stale).toMatchObject({
        outcome: "notFound",
        error: `No matching agent request: ${interaction.requestId}`,
      });
    } finally {
      await client.close();
      pi = startPiRpc({
        cwd: projectDir,
        env: piEnvironment(),
        sessionDir,
        session: { file: path.join(sessionDir, sessionFileName) },
      });
      await waitForPiIdle(pi);
    }
  }, 75_000);

  it("applies and reconciles a resource manager through supervised children", async () => {
    pi.send({
      id: "resource-manager-apply",
      type: "prompt",
      message: '/resource-manager apply hosted-e2e item-1 {"value":7}',
    });
    await waitForCondition(
      () => {
        try {
          const store = new SqliteResourceManagerStore(databasePath, {
            projectPath: projectDir,
            readOnly: true,
          });
          try {
            const resource = store.getResource<
              unknown,
              { phase: string; resolverPid: number; runnerPid: number | null; value: number }
            >({ resourceManager: "hosted-e2e", key: "item-1" });
            return resource?.status.resourceManagerStatus.phase === "done";
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
    const store = new SqliteResourceManagerStore(databasePath, {
      projectPath: projectDir,
      readOnly: true,
    });
    try {
      const resource = store.getResource<
        unknown,
        { phase: string; resolverPid: number; runnerPid: number | null; value: number }
      >({ resourceManager: "hosted-e2e", key: "item-1" });
      expect(resource?.status).toMatchObject({
        observedGeneration: 1,
        resourceManagerStatus: { phase: "done", value: 7 },
        conditions: [{ type: "Ready", status: true, reason: "Complete" }],
      });
      expect(resource?.status.resourceManagerStatus.resolverPid).not.toBe(process.pid);
      expect(resource?.status.resourceManagerStatus.runnerPid).not.toBe(process.pid);
      expect(resource?.status.resourceManagerStatus.runnerPid).not.toBe(
        resource?.status.resourceManagerStatus.resolverPid,
      );
    } finally {
      store.close();
    }
  }, 60_000);

  it("reports privacy-safe host state and renders a completed run", async () => {
    const client = new WorkflowClient({ databasePath });
    const status = await client.request({ operation: "server.status" });
    expect(status.receipt).toMatchObject({
      state: "running",
      socketAvailable: true,
      lifecycleContradictions: 0,
    });
    expect(status.receipt).not.toHaveProperty("serverId");
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
