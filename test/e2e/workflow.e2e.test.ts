import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../../src/controllers/sqlite.js";
import { WorkflowHostClient } from "../../src/host/client.js";
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
  sessionId: string;
}): RpcHandle {
  const child = spawn(
    process.execPath,
    [
      PI_BIN,
      "--mode",
      "rpc",
      "--session-id",
      options.sessionId,
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
      if (child.exitCode !== null) return;
      child.stdin?.end();
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
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

function requestEntryCount(entries: Array<Record<string, unknown>>, requestId: string): number {
  return entries.filter((entry) => isRecord(entry.details) && entry.details.requestId === requestId)
    .length;
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
    async () => requestEntryCount(await readRpcEntries(pi), requestId) === 1,
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
  let sessionId: string;
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
      { textChunkSize: 7, toolArgumentChunkSize: 11, chunkDelayMs: 5 },
    );

    projectDir = await makeTempDir("pi-workflows-host-e2e-project");
    agentDir = await makeTempDir("pi-workflows-host-e2e-agent");
    databasePath = workflowStatePath(agentDir);
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
    pi = startPiRpc({ cwd: projectDir, env: piEnvironment(), sessionId });
    await waitForPiIdle(pi);
  }, 60_000);

  afterAll(async () => {
    await pi?.stop();
    const client = new WorkflowHostClient({ databasePath });
    try {
      await client.request({ operation: "host.stop" });
    } catch {
      // The host is already stopped.
    }
    await mock?.close();
  });

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
    const entries = await readRpcEntries(pi);
    expect(
      entries.some((entry) => JSON.stringify(entry).includes("Visible assistant E2E response.")),
    ).toBe(true);

    const stepEntries = customEntriesForRun(entries, "pi-workflows-agent-step", runId);
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

    await pi.stop();
    pi = startPiRpc({ cwd: projectDir, env: piEnvironment(), sessionId });
    await waitForRequestEntry(pi, interaction.requestId);
    await waitForPiIdle(pi);

    holdRestartSubmission = false;
    pi.send({ id: "restart-continue", type: "prompt", message: "Complete the pending workflow." });
    const { state } = await waitForRun(
      databasePath,
      "restart-e2e",
      (candidate) => candidate.status === "completed",
      () => rpcDiagnostic(pi),
    );
    expect(state.finalOutput).toEqual({ finished: true });
    expect(requestEntryCount(await readRpcEntries(pi), interaction.requestId)).toBe(1);

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
    const client = new WorkflowHostClient({ databasePath, clientId: "e2e-replay-client" });
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
    const client = new WorkflowHostClient({ databasePath });
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
