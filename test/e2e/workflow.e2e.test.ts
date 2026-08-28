import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repositoryId } from "../../src/builtins/autoimplement-command-batches.js";
import { SqliteControllerStore } from "../../src/controllers/sqlite.js";
import { reduceSessionEvents } from "../../src/viewer/session-reducer.js";
import { digest } from "../../src/workflows/human-decision.js";
import {
  listWorkflowRuns,
  readWorkflowRun,
  workflowStateDatabasePath,
} from "../../src/workflows/store.js";
import type { WorkflowRunState } from "../../src/workflows/types.js";
import { makeTempDir } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const EXTENSION_PATH = path.join(REPO_ROOT, "src", "extension", "index.ts");
const SANITY_DETAILED_RESPONSE = [
  "Sanity Check: keep",
  "",
  "The fixture change is supported by its tests.",
  "",
  "Findings:",
  ...["necessity", "duplication", "contracts", "scope_tests"].flatMap((area) => [
    `- ${area} (pass): ${area} passed`,
    "  - .pi/workflows/e2e.workflow.ts :: default export: The fixture provides direct evidence.",
  ]),
].join("\n");
const SANITY_PLAIN_RESPONSE =
  "Verdict: keep. The change is supported, and the review found no required follow-up.";

async function sessionEntries(agentDirectory: string): Promise<string[]> {
  return await fs
    .readdir(path.join(agentDirectory, "sessions"), { recursive: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
}

function workflowActionCallIds(
  messages: Array<{ tool_calls?: unknown[] }>,
  action: string,
): string[] {
  return messages.flatMap((message) =>
    (message.tool_calls ?? []).flatMap((call) => {
      if (call === null || typeof call !== "object") return [];
      const fn = (call as { function?: unknown }).function;
      if (fn === null || typeof fn !== "object") return [];
      const args = (fn as { arguments?: unknown }).arguments;
      if (typeof args !== "string") return [];
      try {
        if ((JSON.parse(args) as { action?: unknown }).action !== action) return [];
        const id = (call as { id?: unknown }).id;
        return [typeof id === "string" ? id : JSON.stringify(call)];
      } catch {
        return [];
      }
    }),
  );
}

function calledWorkflowAction(
  messages: Array<{ tool_calls?: unknown[] }>,
  action: string,
): boolean {
  return workflowActionCallIds(messages, action).length > 0;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part === null || typeof part !== "object" || !("text" in part)) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

const E2E_CONTROLLER = `import {
  conditionTrue,
  defineController,
} from "@osolmaz/pi-workflows/controllers";

export default defineController({
  name: "e2e-controller",
  initialStatus: () => ({ phase: "new" }),
  async reconcile(ctx, resource) {
    const child = await ctx.workflows.ensure({
      requestKey: \`child:\${resource.metadata.generation}\`,
      workflow: "controller-child",
      input: resource.spec,
    });
    const workflowRun = {
      requestId: child.requestId,
      ...(child.runId ? { runId: child.runId } : {}),
      state: child.state,
      attempt: child.attempt,
    };
    return child.state === "succeeded"
      ? ctx.settled({
          controllerStatus: { phase: "done" },
          conditions: [conditionTrue("Ready", "Complete")],
          workflowRun,
        })
      : ctx.requeueAfter(10, {
          controllerStatus: { phase: "running" },
          workflowRun,
        });
  },
});
`;

const E2E_CONTROLLER_CHILD = `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "controller-child",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => input }) },
  edges: [],
});
`;

const HOST_E2E_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "host-e2e",
  startAt: "work",
  nodes: {
    work: agent({
      prompt: () => "Finish the parked run.",
      expectedOutput: '{ "finished": "string" }',
    }),
  },
  edges: [],
});
`;

const ASSISTANT_OUTPUT_E2E_WORKFLOW = `import { agent, assistantMessage, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "assistant-output-e2e",
  startAt: "prepare",
  nodes: {
    prepare: agent({
      prompt: () => "Submit the assistant-output fixture input.",
      expectedOutput: '{ "ready": true }',
    }),
    present: agent({
      prompt: ({ outputs }) =>
        \`Write the assistant-output fixture response for: \${JSON.stringify(outputs.prepare)}\`,
      expectedOutput: assistantMessage(),
    }),
    finish: compute({ run: ({ outputs }) => ({ text: outputs.present }) }),
  },
  edges: [
    { from: "prepare", to: "present" },
    { from: "present", to: "finish" },
  ],
});
`;

const TIMEOUT_E2E_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "timeout-e2e",
  startAt: "work",
  nodes: {
    work: agent({
      prompt: () => "Try to write the timeout marker.",
      timeoutMs: 50,
    }),
  },
  edges: [],
});
`;

const NO_TIMEOUT_E2E_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "no-timeout-e2e",
  startAt: "work",
  nodes: {
    work: agent({
      prompt: () => "Complete the no-timeout workflow.",
      timeoutMs: null,
    }),
  },
  edges: [],
});
`;

const RESUME_CONTROL_E2E_WORKFLOW = `import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "resume-control-e2e",
  startAt: "prepare",
  nodes: {
    prepare: compute({
      run: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ prepared: true }), 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    work: agent({
      prompt: () => "Advance the resumed workflow once.",
      expectedOutput: '{ "advanced": true }',
    }),
    finish: compute({ run: ({ outputs }) => ({ prepare: outputs.prepare, work: outputs.work }) }),
  },
  edges: [
    { from: "prepare", to: "work" },
    { from: "work", to: "finish" },
  ],
});
`;

const LIVE_SETTINGS_E2E_WORKFLOW = `import {
  agent,
  allowSettingsPath,
  compute,
  defineWorkflow,
  settingsRoute,
  workflowSettings,
} from "@osolmaz/pi-workflows";

const settings = workflowSettings({
  initial: { route: "normal", instructions: [] },
  parse: (value) => value,
  paths: [
    allowSettingsPath("/route", { read: ["session"], replace: ["session"] }),
    allowSettingsPath("/instructions", { read: ["session"], add: ["session"] }),
  ],
});

export default defineWorkflow({
  name: "live-settings-e2e",
  settings,
  startAt: "configure",
  presentationPrompt: "LIVE SETTINGS FINAL PRESENTATION",
  nodes: {
    configure: agent({ prompt: () => "Apply the scripted live settings and follow-up.", expectedOutput: '{ "done": true }' }),
    choose: settingsRoute({ run: ({ settings }) => ({ route: settings.route }) }),
    normal: compute({ run: ({ settings }) => ({ selected: "normal", settings }) }),
    careful: compute({ run: ({ settings }) => ({ selected: "careful", settings }) }),
  },
  edges: [
    { from: "configure", to: "choose" },
    { from: "choose", switch: { on: "$.route", cases: { normal: "normal", careful: "careful" } } },
  ],
});
`;

const COMPOSED_CHILD_WORKFLOW = `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  source: import.meta.url,
  name: "composed-child",
  input: (value) => value,
  startAt: "work",
  exits: { ready: { from: "work" } },
  nodes: { work: compute({ run: ({ input }) => ({ child: input }) }) },
  edges: [],
});
`;

const COMPOSED_PARENT_WORKFLOW = `import { compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";
import child from "./composed-child.workflow.ts";

export default defineWorkflow({
  source: import.meta.url,
  name: "composed-e2e",
  startAt: "start",
  includes: { child: includeWorkflow(child, { input: ({ outputs }) => outputs.start }) },
  nodes: {
    start: compute({ run: ({ input }) => input }),
    finish: compute({ run: ({ outputs }) => outputs.child }),
  },
  edges: [
    { from: "start", to: "child" },
    { from: "child.ready", to: "finish" },
  ],
});
`;

const HUMAN_DECISION_E2E_WORKFLOW = `import { choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge } from "@osolmaz/pi-workflows";

const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});

export default defineWorkflow({
  name: "human-decision-e2e",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      request: ({ input }) => ({ title: "Approve", subject: input, presentation: { schema: "pi-workflows.decision-presentation.v1", summary: "Review this decision.", blocks: [] } }),
    }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
    stopped: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
  },
  edges: [humanDecisionEdge({
    from: "approve",
    choices,
    cases: { continue: "continued", stop: "stopped" },
  })],
});
`;

const HUMAN_DECISION_RACE_E2E_WORKFLOW = `import fs from "node:fs/promises";
import path from "node:path";
import { choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge } from "@osolmaz/pi-workflows";

const barrierDir = process.env.PI_WORKFLOWS_E2E_RACE_DIR;
if (barrierDir === undefined) throw new Error("PI_WORKFLOWS_E2E_RACE_DIR is required");
const enteredPath = path.join(barrierDir, "human-decision-race-loads");
const releasePath = path.join(barrierDir, "human-decision-race-release");
let previousLoads = "";
try { previousLoads = await fs.readFile(enteredPath, "utf8"); } catch {}
await fs.appendFile(enteredPath, "load\\n");
if (previousLoads.length > 0) {
  for (;;) {
    try { await fs.access(releasePath); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
}

const choices = defineHumanChoices({ continue: choice({ label: "Continue" }) });

export default defineWorkflow({
  name: "human-decision-race-e2e",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      request: ({ input }) => ({ title: "Approve", subject: input, presentation: { schema: "pi-workflows.decision-presentation.v1", summary: "Review this decision.", blocks: [] } }),
    }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
  },
  edges: [humanDecisionEdge({ from: "approve", choices, cases: { continue: "continued" } })],
});
`;

const HUMAN_TIMEOUT_E2E_WORKFLOW = `import { choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge } from "@osolmaz/pi-workflows";

const choices = defineHumanChoices({ continue: choice({ label: "Continue" }) });

export default defineWorkflow({
  name: "human-timeout-e2e",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      onTimeout: { afterMs: 50, response: { choice: "continue" } },
      request: ({ input }) => ({ title: "Approve", subject: input, presentation: { schema: "pi-workflows.decision-presentation.v1", summary: "Review this decision.", blocks: [] } }),
    }),
    continued: compute({ run: ({ input, outputs }) => ({ input, answer: outputs.approve }) }),
  },
  edges: [humanDecisionEdge({ from: "approve", choices, cases: { continue: "continued" } })],
});
`;

const DURABLE_LAUNCH_WORKFLOW = `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "durable-launch-e2e",
  startAt: "finish",
  nodes: { finish: compute({ run: ({ input }) => ({ input, recovered: true }) }) },
  edges: [],
});
`;

const POST_START_CRASH_E2E_WORKFLOW = `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "post-start-crash-e2e",
  startAt: "validate",
  nodes: {
    validate: compute({
      run: ({ input }) => {
        const scope = input && typeof input === "object" ? input.scope : undefined;
        if (typeof scope !== "string" || scope.trim().length === 0) {
          throw new Error("scope must be a non-empty string");
        }
        return { scope };
      },
    }),
  },
  edges: [],
});
`;

const SELF_CANCEL_E2E_WORKFLOW = `import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "self-cancel-e2e",
  startAt: "work",
  nodes: { work: agent({ prompt: () => "Cancel this workflow now." }) },
  edges: [],
});
`;

const TERMINAL_RESTART_INPUT = {
  task: "Preserve this exact terminal restart input.",
  nested: { enabled: true, values: [1, 2, 3] },
};

const TERMINAL_RESTART_E2E_WORKFLOW = `import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "terminal-restart-e2e",
  maxSteps: 1,
  startAt: "loop",
  nodes: { loop: compute({ run: ({ input }) => input }) },
  edges: [{ from: "loop", to: "loop" }],
});
`;

const COMMAND_BATCH_E2E_WORKFLOW = `import { action, compute, defineWorkflow, runCommandBatch } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "command-batch-e2e",
  startAt: "prepare",
  nodes: {
    prepare: compute({
      run: ({ input }) => ({
        maxConcurrency: 2,
        items: ["first", "second"].map((id) => ({
          id,
          command: process.execPath,
          args: ["-e", "process.stdout.write(" + JSON.stringify(id) + ")"],
          cwd: input.cwd,
          timeoutMs: 10000,
          maxOutputChars: 10000,
        })),
      }),
    }),
    run: action({
      run: async (context) => await runCommandBatch(context.outputs.prepare, { signal: context.signal }),
    }),
  },
  edges: [{ from: "prepare", to: "run" }],
});
`;

const E2E_WORKFLOW = `import { agent, decision, decisionEdge, defineWorkflow, shell } from "@osolmaz/pi-workflows";

const choices = ["y", "n"] as const;

export default defineWorkflow({
  name: "e2e",
  title: ({ input }) => \`e2e: \${(input as { task?: string }).task ?? "unnamed"}\`,
  presentationPrompt: "Tell the user what was implemented in one plain sentence.",
  startAt: "propose",
  nodes: {
    propose: agent({
      prompt: ({ input }) => \`Propose a solution for: \${(input as { task?: string }).task}\`,
      expectedOutput: '{ "proposal": "one sentence" }',
      statusDetail: "Proposing a solution",
    }),
    confirm: decision({
      choices,
      question: ({ outputs }) =>
        \`Is this the holy grail? \${JSON.stringify(outputs.propose)}\`,
    }),
    implement: shell({
      exec: () => ({ command: "printf", args: ["%s", "implemented"] }),
      parse: (result) => ({ marker: result.stdout }),
    }),
    stop: shell({
      exec: () => ({ command: "printf", args: ["%s", "stopped"] }),
      parse: (result) => ({ marker: result.stdout }),
    }),
  },
  edges: [
    { from: "propose", to: "confirm" },
    decisionEdge({ from: "confirm", choices, cases: { y: "implement", n: "stop" } }),
  ],
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

let rpcStateRequest = 0;

function startPiRpc(options: {
  cwd: string;
  env: Record<string, string>;
  extensionPath?: string;
}): RpcHandle {
  const child = spawn(
    process.execPath,
    [
      PI_BIN,
      "--mode",
      "rpc",
      "--no-session",
      "--no-skills",
      "--no-themes",
      "--no-prompt-templates",
      "--no-context-files",
      "--offline",
      "-e",
      options.extensionPath ?? EXTENSION_PATH,
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
    send: (command) => {
      child.stdin?.write(`${JSON.stringify(command)}\n`);
    },
    stop: async () => {
      child.stdin?.end();
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      await Promise.race([exited, timeout]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

async function readRpcState(pi: RpcHandle): Promise<RpcState> {
  const id = `e2e-state-${++rpcStateRequest}`;
  const start = pi.stdoutLines.length;
  pi.send({ id, type: "get_state" });
  await waitForCondition(
    () => pi.stdoutLines.slice(start).some((line) => line.includes(`"id":"${id}"`)),
    () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
  );
  const response = pi.stdoutLines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((value) => value.id === id);
  const data = response?.data;
  if (data === null || typeof data !== "object") {
    throw new Error(`Pi RPC get_state ${id} returned no state`);
  }
  return data as RpcState;
}

async function readRpcEntries(pi: RpcHandle): Promise<
  Array<{
    type?: unknown;
    customType?: unknown;
    content?: unknown;
    details?: unknown;
  }>
> {
  const id = `e2e-entries-${++rpcStateRequest}`;
  const start = pi.stdoutLines.length;
  pi.send({ id, type: "get_entries" });
  await waitForCondition(
    () => pi.stdoutLines.slice(start).some((line) => line.includes(`"id":"${id}"`)),
    () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
  );
  const response = pi.stdoutLines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((value) => value.id === id);
  const data = response?.data;
  if (data === null || typeof data !== "object") {
    throw new Error(`Pi RPC get_entries ${id} returned no data`);
  }
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Pi RPC get_entries ${id} returned no entries`);
  }
  return entries;
}

async function waitForPiIdle(pi: RpcHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readRpcState(pi);
    if (!state.isStreaming && state.pendingMessageCount === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for Pi RPC idle state.\n${pi.stderr()}\n${pi.stdoutLines.slice(-15).join("\n")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  onTimeout: () => string,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for condition.\n${onTimeout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForQueueRecord(
  controllerFile: string,
  projectPath: string,
  predicate: (record: ReturnType<SqliteControllerStore["getWorkflowRun"]>) => boolean,
  onTimeout: () => string,
  timeoutMs = 15_000,
  workflowName = "durable-launch-e2e",
): Promise<NonNullable<ReturnType<SqliteControllerStore["getWorkflowRun"]>>> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() <= deadline) {
    try {
      const store = new SqliteControllerStore(controllerFile, { readOnly: true, projectPath });
      try {
        const record = store
          .listWorkflowRuns()
          .find((candidate) => candidate.workflowName === workflowName);
        if (predicate(record)) return record as NonNullable<typeof record>;
      } finally {
        store.close();
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for workflow queue state. Last read error: ${lastError}\n${onTimeout()}`,
  );
}

async function waitForResolvedTurnIntent(
  databasePath: string,
  projectPath: string,
  runId: string,
  onTimeout: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForCondition(
    () => {
      try {
        const store = new SqliteControllerStore(databasePath, { readOnly: true, projectPath });
        try {
          return store
            .listWorkflowTurnIntents({ runId })
            .some((intent) => intent.resolvedAt !== null);
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
}

async function waitForRunState(
  databasePath: string,
  predicate: (state: WorkflowRunState) => boolean,
  onTimeout: () => string,
  timeoutMs = 90_000,
): Promise<{ state: WorkflowRunState; runId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const run = listWorkflowRuns({ databasePath }).find((candidate) =>
        predicate(candidate.state),
      );
      if (run !== undefined) return { state: run.state, runId: run.runId };
    } catch {
      // The database may not exist yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for workflow run state.\n${onTimeout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.sequential("pi-workflows end to end", () => {
  let mock: Awaited<ReturnType<typeof startMockOpenAiServer>>;
  let pi: RpcHandle;
  let runsDir: string;
  let projectDir: string;
  let agentDir: string;
  let controllerFile: string;
  let timeoutMarker: string;
  let commandDir: string;
  let defaultBranch: string;

  beforeAll(async () => {
    // The scripted "model": answers each workflow step contract through the
    // workflow tool and ends its turn after each tool result.
    mock = await startMockOpenAiServer(
      ({ messages, lastUserText, lastRole }) => {
        if (
          lastUserText.includes(
            "Check the review claims against the collected evidence and combine the supported findings into one result.",
          )
        ) {
          return {
            kind: "text",
            text: JSON.stringify({
              verdict: "keep",
              summary: "The fixture change is supported by its tests.",
              findings: ["necessity", "duplication", "contracts", "scope_tests"].map((area) => ({
                area,
                assessment: "pass",
                summary: `${area} passed`,
                evidence: [
                  {
                    path: ".pi/workflows/e2e.workflow.ts",
                    symbol: "default export",
                    detail: "The fixture provides direct evidence.",
                  },
                ],
              })),
              requiredChanges: [],
              questionsForContributor: [],
              unknowns: [],
            }),
          };
        }
        if (lastUserText.includes("Review the change in the current repository.")) {
          const requested = ["necessity", "duplication", "contracts", "scope_tests"].filter(
            (area) => lastUserText.includes(area),
          );
          return {
            kind: "text",
            text: JSON.stringify({
              areas: requested.map((area) => ({
                area,
                assessment: "pass",
                summary: `${area} passed`,
                evidence: [
                  {
                    path: ".pi/workflows/e2e.workflow.ts",
                    symbol: "default export",
                    detail: "The fixture provides direct evidence.",
                  },
                ],
              })),
              acceptanceCase: "The fixture directly exercises the requested behavior.",
              questions: [],
              unknowns: [],
            }),
          };
        }
        if (
          lastUserText.includes("Print the verified Sanity Check report below exactly as written")
        ) {
          return { kind: "text", text: SANITY_DETAILED_RESPONSE };
        }
        if (
          lastUserText.includes("Give a short plain-language summary of the Sanity Check verdict")
        ) {
          return { kind: "text", text: SANITY_PLAIN_RESPONSE };
        }
        if (
          lastUserText.includes("Presentation instructions:") ||
          lastUserText.includes("Workflow presentation instructions:")
        ) {
          return { kind: "text", text: "Implemented the boring, proven design." };
        }
        if (
          lastRole !== "tool" &&
          lastUserText.includes('"workflowName": "terminal-restart-e2e"')
        ) {
          const runId = lastUserText.match(/"runId": "([^"]+)"/u)?.[1] ?? "";
          const restartCount = Number(lastUserText.match(/"count": (\d+)/u)?.[1] ?? "-1");
          if (restartCount === 0) {
            return {
              kind: "tool",
              toolName: "workflow",
              args: { action: "restart", runId },
            };
          }
          return { kind: "text", text: "Repeated terminal outcome observed; stopping." };
        }
        if (
          lastUserText.includes('"workflowName": "post-start-crash-e2e"') &&
          lastUserText.includes('"terminalState": "failed"')
        ) {
          return { kind: "text", text: "Post-start crash observed." };
        }
        if (
          lastUserText.includes('"workflowName": "self-cancel-e2e"') &&
          lastUserText.includes('"terminalState": "cancelled"')
        ) {
          return { kind: "text", text: "Self-cancellation observed." };
        }
        if (
          lastRole === "user" &&
          (lastUserText === "Start the durable launch fixture now." ||
            lastUserText === "Start the repaired durable launch fixture now.")
        ) {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "start",
              workflow: "durable-launch-e2e",
              input: { task: lastUserText },
            },
          };
        }
        if (lastRole === "user" && lastUserText === "Start the post-start crash fixture now.") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: { action: "start", workflow: "post-start-crash-e2e", input: {} },
          };
        }
        if (lastRole === "user" && lastUserText === "Start the self-cancel fixture now.") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: { action: "start", workflow: "self-cancel-e2e", input: {} },
          };
        }
        if (lastRole === "user" && lastUserText === "Start the terminal restart fixture now.") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "start",
              workflow: "terminal-restart-e2e",
              input: TERMINAL_RESTART_INPUT,
            },
          };
        }
        if (lastRole === "user" && lastUserText === "Start the built-in monitor now.") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "start",
              workflow: "monitor",
              input: {
                task: "Check the fixture once",
                everyMinutes: 30,
                stopWhen: "The first check is complete",
                maxChecks: 1,
              },
            },
          };
        }
        if (lastRole === "user" && lastUserText === "continue it") {
          return { kind: "tool", toolName: "workflow", args: { action: "resume" } };
        }
        if (
          lastRole === "tool" &&
          contentText(messages.at(-1)?.content).includes("Workflow update published") &&
          /workflow step contract \(workflow: monitor, step: observe/i.test(lastUserText)
        ) {
          const monitorStepMatch = lastUserText.match(
            /workflow step contract \(workflow: monitor, step: observe, attempt: ([a-z0-9-]+)\)/i,
          );
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "observe",
              attempt: monitorStepMatch?.[1] ?? "",
              output: {
                route: "stop",
                goalState: "complete",
                workState: "stopped",
                observation: "The fixture check completed at 1 of 2 items.",
                report: "The fixture check completed.",
                targetStateId: "fixture:first-check-complete",
                authorizedActions: [],
                progress: {
                  tracks: [
                    {
                      key: "fixture",
                      data: {
                        schema: "pi-workflows.progress.v1",
                        label: "Fixture",
                        status: "running",
                        completed: 1,
                        total: 2,
                        unit: "items",
                        sourceEstimatedFinishAt: "2099-01-01T00:00:00.000Z",
                      },
                    },
                  ],
                },
                reason: "The requested first check is complete.",
              },
            },
          };
        }
        const autoimplementStep = lastUserText.match(
          /workflow step contract \(workflow: autoimplement, step: ([^,]+), attempt: ([a-z0-9-]+)\)/i,
        );
        if (autoimplementStep) {
          const step = autoimplementStep[1] ?? "";
          const attempt = autoimplementStep[2] ?? "";
          const submit = (output: unknown) => ({
            kind: "tool" as const,
            toolName: "workflow",
            args: { action: "submit", step, attempt, output },
          });
          if (step === "workspace/propose") {
            return submit({
              branchName: "feat/change-scoped-e2e",
              reason: "Isolate the real-Pi fixture.",
            });
          }
          if (step === "implement") {
            return submit({
              status: "implemented",
              summary: "The fixture implementation is ready for verification.",
              files: ["fixture-change.txt"],
              repositories: [projectDir],
              issueKind: null,
              evidence: "fixture implementation",
            });
          }
          if (step === "classifyImplementation") {
            return submit({ route: "verify", summary: "Ready for checks.", evidence: "fixture" });
          }
          if (step === "planVerification") {
            return submit({
              commands: [
                {
                  id: "simpledoc-baseline",
                  command: process.execPath,
                  args: ["baseline-check.cjs"],
                  cwd: projectDir,
                  timeoutMs: 60_000,
                  maxOutputChars: 100_000,
                },
              ],
              untested: [],
            });
          }
          if (step === "publish") {
            return submit({
              repositories: [
                {
                  repository: projectDir,
                  branch: "feat/change-scoped-e2e",
                  baseBranch: defaultBranch,
                  headRevision: "fixture-head",
                  pr: "https://example.test/pi-workflows/pull/1",
                  pushed: true,
                },
              ],
            });
          }
          if (step === "assessReview") {
            return submit({
              repositories: [
                {
                  id: repositoryId(projectDir),
                  invocationSucceeded: true,
                  p0: [],
                  p1: [],
                  p2: [],
                  lower: [],
                  reason: "No findings.",
                },
              ],
              reason: "Review passed.",
            });
          }
          if (step === "inspectComments") {
            return submit({ route: "ci", summary: "No comments.", evidence: [] });
          }
          if (step === "inspectCi") {
            return submit({
              targets: [
                {
                  repository: projectDir,
                  headRevision: "fixture-head",
                  pr: "https://example.test/pi-workflows/pull/1",
                  route: "green",
                  reason: "Fixture CI is green.",
                  relatedFailures: [],
                  unrelatedFailures: [],
                },
              ],
            });
          }
          if (step === "finalizeDelivery") {
            return submit({
              status: "completed",
              merged: false,
              pr: "https://example.test/pi-workflows/pull/1",
              reportComment: "fixture report",
              reason: "Ready without merge.",
            });
          }
        }
        const resumeControlStepMatch = lastUserText.match(
          /workflow step contract \(workflow: resume-control-e2e, step: work, attempt: ([a-z0-9-]+)\)/i,
        );
        if (resumeControlStepMatch && lastRole !== "tool") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "work",
              attempt: resumeControlStepMatch[1] ?? "",
              output: { advanced: true },
            },
          };
        }
        if (lastRole === "tool") {
          return {
            kind: "text",
            thinking: "Confirm the workflow tool result before stopping.",
            text: "Step submitted.",
          };
        }
        const stepMatch = lastUserText.match(
          /workflow step contract \(workflow: e2e, step: ([a-z_]+), attempt: ([a-z0-9-]+)\)/i,
        );
        const step = stepMatch?.[1];
        const attempt = stepMatch?.[2] ?? "";
        if (step === "propose") {
          return {
            kind: "tool",
            thinking: "Build and submit the proposed workflow output.",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "propose",
              attempt,
              output: { proposal: "Ship the boring, proven design." },
            },
          };
        }
        if (step === "confirm") {
          return {
            kind: "tool",
            thinking: "Choose the accepted workflow route.",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "confirm",
              attempt,
              output: { route: "y", reason: "proposal matches the holy grail" },
            },
          };
        }
        const selfCancelStepMatch = lastUserText.match(
          /workflow step contract \(workflow: self-cancel-e2e, step: work, attempt: ([a-z0-9-]+)\)/i,
        );
        if (selfCancelStepMatch) {
          return { kind: "tool", toolName: "workflow", args: { action: "cancel" } };
        }
        const monitorStepMatch = lastUserText.match(
          /workflow step contract \(workflow: monitor, step: ([a-z_]+), attempt: ([a-z0-9-]+)\)/i,
        );
        if (monitorStepMatch?.[1] === "observe") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "update",
              step: "observe",
              attempt: monitorStepMatch[2] ?? "",
              update: {
                type: "progress",
                key: "live-agent",
                data: {
                  schema: "pi-workflows.progress.v1",
                  label: "Live agent",
                  status: "running",
                  completed: 1,
                  total: 2,
                  unit: "items",
                },
              },
            },
          };
        }
        const serializedMessages = JSON.stringify(messages);
        const liveSettingsStep = serializedMessages.match(
          /workflow step contract \(workflow: live-settings-e2e, step: configure, attempt: ([a-z0-9-]+)\)/i,
        );
        if (liveSettingsStep && !calledWorkflowAction(messages, "submit")) {
          if (!calledWorkflowAction(messages, "change-settings")) {
            return {
              kind: "tool",
              toolName: "workflow",
              args: {
                action: "change-settings",
                expectedChangeNumber: 0,
                patch: [
                  { op: "replace", path: "/route", value: "careful" },
                  { op: "add", path: "/instructions/-", value: "Run every check." },
                ],
              },
            };
          }
          if (!calledWorkflowAction(messages, "queue-follow-up")) {
            return {
              kind: "tool",
              toolName: "workflow",
              args: {
                action: "queue-follow-up",
                prompt: "LIVE SETTINGS FOLLOW-UP",
              },
            };
          }
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "configure",
              attempt: liveSettingsStep[1] ?? "",
              output: { done: true },
            },
          };
        }
        if (lastUserText.includes("LIVE SETTINGS FINAL PRESENTATION")) {
          return { kind: "text", text: "Live settings final response." };
        }
        if (lastUserText.includes("LIVE SETTINGS FOLLOW-UP")) {
          return { kind: "text", text: "Live settings follow-up completed." };
        }
        const assistantOutputStepMatch = lastUserText.match(
          /workflow step contract \(workflow: assistant-output-e2e, step: (prepare|present), attempt: ([a-z0-9-]+)\)/i,
        );
        if (assistantOutputStepMatch?.[1] === "prepare") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "prepare",
              attempt: assistantOutputStepMatch[2] ?? "",
              output: { ready: true },
            },
          };
        }
        if (assistantOutputStepMatch?.[1] === "present") {
          return { kind: "text", text: "This is one normal visible assistant response." };
        }
        const timeoutStepMatch = lastUserText.match(
          /workflow step contract \(workflow: timeout-e2e, step: work, attempt: ([a-z0-9-]+)\)/i,
        );
        if (timeoutStepMatch) {
          return {
            kind: "tool",
            toolName: "write",
            args: {
              path: timeoutMarker,
              content: "This tool call must not finish after the workflow timeout.",
            },
          };
        }
        const noTimeoutStepMatch = lastUserText.match(
          /workflow step contract \(workflow: no-timeout-e2e, step: work, attempt: ([a-z0-9-]+)\)/i,
        );
        if (noTimeoutStepMatch) {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "work",
              attempt: noTimeoutStepMatch[1] ?? "",
              output: { completed: true },
            },
          };
        }
        const hostStepMatch = lastUserText.match(
          /workflow step contract \(workflow: host-e2e, step: ([a-z_]+), attempt: ([a-z0-9-]+)\)/i,
        );
        if (hostStepMatch?.[1] === "work") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "work",
              attempt: hostStepMatch[2] ?? "",
              output: { finished: "host did it" },
            },
          };
        }
        return { kind: "text", text: "Nothing to do." };
      },
      {
        textChunkSize: 5,
        thinkingChunkSize: 6,
        toolArgumentChunkSize: 12,
        chunkDelayMs: 15,
      },
    );

    projectDir = await makeTempDir("pi-workflows-e2e-project");
    agentDir = await makeTempDir("pi-workflows-e2e-agent");
    runsDir = workflowStateDatabasePath(agentDir);
    controllerFile = runsDir;
    timeoutMarker = path.join(projectDir, "timeout-marker.txt");
    commandDir = await makeTempDir("pi-workflows-e2e-commands");
    await fs.writeFile(
      path.join(commandDir, "pi-reviewer"),
      "#!/bin/sh\nprintf '%s\\n' 'Overall: patch is correct' 'No findings.'\n",
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(projectDir, "baseline-check.cjs"),
      "console.error('30 renames, 32 frontmatter insertions, 8 reference updates'); process.exit(1);\n",
      "utf8",
    );

    await fs.mkdir(path.join(projectDir, ".pi", "workflows"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".pi", "controllers"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "e2e.workflow.ts"),
      E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "durable-launch-e2e.workflow.ts"),
      DURABLE_LAUNCH_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "post-start-crash-e2e.workflow.ts"),
      POST_START_CRASH_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "self-cancel-e2e.workflow.ts"),
      SELF_CANCEL_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "terminal-restart-e2e.workflow.ts"),
      TERMINAL_RESTART_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "command-batch-e2e.workflow.ts"),
      COMMAND_BATCH_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "human-decision-e2e.workflow.ts"),
      HUMAN_DECISION_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "human-timeout-e2e.workflow.ts"),
      HUMAN_TIMEOUT_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "human-decision-race-e2e.workflow.ts"),
      HUMAN_DECISION_RACE_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "composed-child.workflow.ts"),
      COMPOSED_CHILD_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "composed-e2e.workflow.ts"),
      COMPOSED_PARENT_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "assistant-output-e2e.workflow.ts"),
      ASSISTANT_OUTPUT_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "timeout-e2e.workflow.ts"),
      TIMEOUT_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "no-timeout-e2e.workflow.ts"),
      NO_TIMEOUT_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "resume-control-e2e.workflow.ts"),
      RESUME_CONTROL_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "live-settings-e2e.workflow.ts"),
      LIVE_SETTINGS_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "controller-child.workflow.ts"),
      E2E_CONTROLLER_CHILD,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "host-e2e.workflow.ts"),
      HOST_E2E_WORKFLOW,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".pi", "controllers", "e2e-controller.controller.ts"),
      E2E_CONTROLLER,
      "utf8",
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
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture-legacy",
        defaultModel: "fixture-legacy-model",
        defaultThinkingLevel: "high",
        extensions: [
          path.join(REPO_ROOT, "test", "fixtures", "pi-agent-extensions", "legacy-provider.ts"),
        ],
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

    await execFileAsync("git", ["init", "-q"], { cwd: projectDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: projectDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: projectDir });
    await execFileAsync("git", ["commit", "-q", "-m", "test fixtures"], { cwd: projectDir });
    defaultBranch = (
      await execFileAsync("git", ["branch", "--show-current"], {
        cwd: projectDir,
        encoding: "utf8",
      })
    ).stdout.trim();

    pi = startPiRpc({
      cwd: projectDir,
      env: {
        HOME: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_FIXTURE_BASE_URL: mock.baseUrl,
        PI_AGENT_FIXTURE_API_KEY: "e2e-provider-key",
        PI_WORKFLOWS_E2E_RACE_DIR: agentDir,
        PATH: `${commandDir}:${process.env.PATH ?? ""}`,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pi?.stop();
    await mock?.close();
  });

  it("runs a bounded command batch in a real Pi workflow", async () => {
    pi.send({
      id: "command-batch-e2e",
      type: "prompt",
      message: `/workflow command-batch-e2e --input-json ${JSON.stringify({ cwd: projectDir })}`,
    });
    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "command-batch-e2e" && candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    expect(state.finalOutput).toMatchObject({
      schema: "pi-workflows.command-batch-result.v1",
      items: [
        { id: "first", outcome: "succeeded", stdout: "first" },
        { id: "second", outcome: "succeeded", stdout: "second" },
      ],
    });
    await waitForQueueRecord(
      controllerFile,
      projectDir,
      (record) => record?.status === "done",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      15_000,
      "command-batch-e2e",
    );
  }, 30_000);

  it("applies live settings and sends ordered work after terminal presentation", async () => {
    pi.send({
      id: "live-settings-e2e",
      type: "prompt",
      message: "/workflow live-settings-e2e",
    });
    const completed = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "live-settings-e2e" && candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      20_000,
    );
    await waitForCondition(
      () => {
        const run = readWorkflowRun(completed.runId, { databasePath: runsDir, includeTrace: true });
        return (
          run?.followUpQueue?.presentationState === "settled" &&
          run.followUpQueue.followUps[0]?.state === "sent"
        );
      },
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      30_000,
    );
    await waitForPiIdle(pi);
    const run = readWorkflowRun(completed.runId, { databasePath: runsDir, includeTrace: true });
    expect(run?.state.finalOutput).toEqual({
      selected: "careful",
      settings: { route: "careful", instructions: ["Run every check."] },
    });
    expect(run?.settingsScopes?.[0]).toMatchObject({ changeNumber: 1 });
    expect(run?.followUpQueue).toMatchObject({
      presentationState: "settled",
      followUps: [
        {
          order: 1,
          state: "sent",
          sessionEntryId: expect.any(String),
        },
      ],
    });
    expect(run?.traceEvents?.map((event) => event.type)).toContain("run_completed");
    expect(
      listWorkflowRuns({ databasePath: runsDir }).filter(
        (candidate) => candidate.state.workflowName === "live-settings-e2e",
      ),
    ).toHaveLength(1);
  }, 60_000);

  it("starts one later turn after a post-start runtime crash", async () => {
    const requestsBefore = mock.requests.length;
    const settledBefore = pi.stdoutLines.filter((line) =>
      line.includes('"type":"agent_settled"'),
    ).length;
    pi.send({
      id: "post-start-crash",
      type: "prompt",
      message: "Start the post-start crash fixture now.",
    });

    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "post-start-crash-e2e" && candidate.status === "failed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    expect(state.error).toContain("scope must be a non-empty string");
    await waitForCondition(
      () => {
        const store = new SqliteControllerStore(controllerFile, {
          readOnly: true,
          projectPath: projectDir,
        });
        try {
          return store
            .listWorkflowTurnIntents({ runId: state.runId })
            .some((intent) => intent.cause === "failed" && intent.resolution === "fallback");
        } finally {
          store.close();
        }
      },
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () => mock.requests.length >= requestsBefore + 3,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () => pi.stdoutLines.some((line) => line.includes("Post-start crash observed.")),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () =>
        pi.stdoutLines.filter((line) => line.includes('"type":"agent_settled"')).length >=
        settledBefore + 2,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    const store = new SqliteControllerStore(controllerFile, {
      readOnly: true,
      projectPath: projectDir,
    });
    try {
      expect(store.listWorkflowTurnIntents({ runId: state.runId })).toMatchObject([
        { cause: "failed", resolution: "fallback", resolvedAt: expect.any(String) },
      ]);
    } finally {
      store.close();
    }
  }, 60_000);

  it("starts one later turn after an agent cancels its own workflow", async () => {
    const requestsBefore = mock.requests.length;
    const settledBefore = pi.stdoutLines.filter((line) =>
      line.includes('"type":"agent_settled"'),
    ).length;
    pi.send({
      id: "self-cancel",
      type: "prompt",
      message: "Start the self-cancel fixture now.",
    });

    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "self-cancel-e2e" && candidate.status === "cancelled",
      () =>
        `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}\n${mock.requests
          .slice(-5)
          .map((request) => contentText(request.messages.at(-1)?.content))
          .join("\n---\n")}`,
      15_000,
    );
    await waitForCondition(
      () => {
        const store = new SqliteControllerStore(controllerFile, {
          readOnly: true,
          projectPath: projectDir,
        });
        try {
          return store
            .listWorkflowTurnIntents({ runId: state.runId })
            .some(
              (intent) => intent.cause === "agentCancelled" && intent.resolution === "fallback",
            );
        } finally {
          store.close();
        }
      },
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () => mock.requests.length >= requestsBefore + 4,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () => pi.stdoutLines.some((line) => line.includes("Self-cancellation observed.")),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForCondition(
      () =>
        pi.stdoutLines.filter((line) => line.includes('"type":"agent_settled"')).length >=
        settledBefore + 3,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    const store = new SqliteControllerStore(controllerFile, {
      readOnly: true,
      projectPath: projectDir,
    });
    try {
      expect(store.listWorkflowTurnIntents({ runId: state.runId })).toMatchObject([
        { cause: "agentCancelled", resolution: "fallback", resolvedAt: expect.any(String) },
      ]);
    } finally {
      store.close();
    }
  }, 60_000);

  it("restarts exact maxSteps input once and reloads without duplicate turns or runs", async () => {
    await waitForPiIdle(pi);
    const requestOffset = mock.requests.length;
    pi.send({
      id: "terminal-restart",
      type: "prompt",
      message: "Start the terminal restart fixture now.",
    });

    await waitForCondition(
      () =>
        listWorkflowRuns({ databasePath: runsDir }).filter(
          (candidate) =>
            candidate.state.workflowName === "terminal-restart-e2e" &&
            candidate.state.status === "failed",
        ).length === 2,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-30).join("\n")}`,
      30_000,
    );
    await waitForCondition(
      () => pi.stdoutLines.some((line) => line.includes("Repeated terminal outcome observed")),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-30).join("\n")}`,
      30_000,
    );
    await waitForPiIdle(pi);

    const terminalDecisionRequests = () =>
      mock.requests.slice(requestOffset).filter((request) => {
        const last = request.messages.at(-1);
        return (
          last?.role === "user" &&
          contentText(last.content).includes('"workflowName": "terminal-restart-e2e"')
        );
      });
    expect(terminalDecisionRequests()).toHaveLength(2);

    const terminalRuns = listWorkflowRuns({ databasePath: runsDir }).filter(
      (candidate) => candidate.state.workflowName === "terminal-restart-e2e",
    );
    const terminalRunIds = new Set(terminalRuns.map((candidate) => candidate.runId));
    const recordedTerminalMessages = (await readRpcEntries(pi)).filter((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== "pi-workflows-deferred-turn") {
        return false;
      }
      const details = entry.details;
      if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
      const runId = (details as { runId?: unknown }).runId;
      return typeof runId === "string" && terminalRunIds.has(runId);
    });
    expect(recordedTerminalMessages).toHaveLength(2);
    for (const message of recordedTerminalMessages) {
      expect(message.details).toMatchObject({
        schema: "pi-workflows.deferred-turn-message.v1",
        presentation: {
          workflowName: "terminal-restart-e2e",
          state: "failed",
          reasonKind: "maxSteps",
          restart: { limit: 3 },
        },
        terminalDecision: { schema: "pi-workflows.terminal-decision.v1" },
      });
      expect(contentText(message.content)).toContain("Exact workflow input:");
      expect(contentText(message.content)).toContain('"workflowName": "terminal-restart-e2e"');
    }

    const restartCallIds = new Set<string>();
    for (const request of mock.requests.slice(requestOffset)) {
      for (const message of request.messages) {
        for (const call of message.tool_calls ?? []) {
          if (call === null || typeof call !== "object") continue;
          const candidate = call as { id?: unknown; function?: unknown };
          if (typeof candidate.id !== "string") continue;
          const fn = candidate.function;
          if (fn === null || typeof fn !== "object") continue;
          const args = (fn as { arguments?: unknown }).arguments;
          if (typeof args !== "string") continue;
          try {
            if ((JSON.parse(args) as { action?: unknown }).action === "restart") {
              restartCallIds.add(candidate.id);
            }
          } catch {
            // Ignore partial or unrelated model tool arguments.
          }
        }
      }
    }
    expect(restartCallIds.size).toBe(1);

    const store = new SqliteControllerStore(controllerFile, {
      readOnly: true,
      projectPath: projectDir,
    });
    try {
      const records = store
        .listWorkflowRuns()
        .filter((record) => record.workflowName === "terminal-restart-e2e");
      expect(records).toHaveLength(2);
      const original = records.find(
        (record) =>
          !(
            record.launchOptions !== null &&
            typeof record.launchOptions === "object" &&
            "restartLineage" in record.launchOptions
          ),
      );
      const restarted = records.find(
        (record) =>
          record.launchOptions !== null &&
          typeof record.launchOptions === "object" &&
          "restartLineage" in record.launchOptions,
      );
      expect(original).toMatchObject({ input: TERMINAL_RESTART_INPUT, status: "done" });
      expect(restarted).toMatchObject({
        input: TERMINAL_RESTART_INPUT,
        status: "done",
        launchOptions: {
          restartLineage: {
            schema: "pi-workflows.restart-lineage.v1",
            rootRunId: original?.runId,
            parentRunId: original?.runId,
            restartNumber: 1,
          },
          terminalSelection: {
            schema: "pi-workflows.terminal-selection.v1",
            sourceRunId: original?.runId,
          },
        },
      });
      for (const record of records) {
        expect(store.listWorkflowTurnIntents({ runId: record.runId })).toMatchObject([
          { resolution: "fallback", resolvedAt: expect.any(String) },
        ]);
      }
    } finally {
      store.close();
    }

    const terminalTurnsBeforeReload = terminalDecisionRequests().length;
    pi.send({ id: "terminal-restart-reload", type: "prompt", message: "/reload" });
    await waitForCondition(
      () => pi.stdoutLines.some((line) => line.includes('"id":"terminal-restart-reload"')),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-30).join("\n")}`,
      30_000,
    );
    await waitForPiIdle(pi);
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(terminalDecisionRequests()).toHaveLength(terminalTurnsBeforeReload);
    expect(
      listWorkflowRuns({ databasePath: runsDir }).filter(
        (candidate) => candidate.state.workflowName === "terminal-restart-e2e",
      ),
    ).toHaveLength(2);
  }, 90_000);

  it("runs a directly imported child in one real Pi workflow run", async () => {
    pi.send({
      id: "wf-composed",
      type: "prompt",
      message: '/workflow composed-e2e --input-json {"task":"nested"}',
    });

    const { state, runId } = await waitForRunState(
      runsDir,
      (candidate) => candidate.workflowName === "composed-e2e" && candidate.status === "completed",
      pi.stderr,
    );

    expect(state.finalOutput).toEqual({
      exit: "ready",
      output: { child: { task: "nested" } },
    });
    expect(state.steps.map((step) => step.nodeId)).toEqual([
      "start",
      "child",
      "child/work",
      "child/__piw_exit_ready",
      "finish",
    ]);
    expect(state.workflowSources).toEqual([
      expect.objectContaining({ mountPath: ["child"], workflowName: "composed-child" }),
    ]);
    const trace = listWorkflowRuns({ databasePath: runsDir, includeTrace: true }).find(
      (run) => run.runId === runId,
    )?.traceEvents;
    expect(trace?.map((event) => event.type)).toContain("include_entered");
    expect(trace?.map((event) => event.type)).toContain("include_exited");
  });

  it("runs a workflow to completion inside a real pi session", async () => {
    pi.send({ id: "wf-1", type: "prompt", message: "/workflow e2e ship it" });

    // Observe the durable journal while the first tool call is still streaming,
    // not only after Pi and the workflow have reached a terminal state.
    await waitForCondition(
      async () => {
        try {
          return listWorkflowRuns({ databasePath: runsDir }).some((run) => {
            const starts = run.sessionEvents.filter(
              (event) =>
                event.type === "assistant_event" &&
                event.payload.type === "toolcall_start" &&
                event.messageId !== undefined,
            );
            return starts.length >= 1;
          });
        } catch {
          return false;
        }
      },
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
      20_000,
      10,
    );

    const { state, runId } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "e2e" &&
        (candidate.status === "completed" || candidate.status === "failed"),
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
    );

    expect(state.status).toBe("completed");
    expect(state.workflowName).toBe("e2e");
    expect(state.runTitle).toBe("e2e: ship it");
    expect(state.steps.map((step) => step.nodeId)).toEqual(["propose", "confirm", "implement"]);
    expect(state.outputs.propose).toEqual({ proposal: "Ship the boring, proven design." });
    expect(state.outputs.confirm).toMatchObject({ route: "y" });
    expect(state.finalOutput).toEqual({ marker: "implemented" });

    const loaded = listWorkflowRuns({ databasePath: runsDir, includeTrace: true }).find(
      (run) => run.runId === runId,
    );
    if (loaded === undefined) throw new Error("completed run is missing");
    const traceEvents = loaded.traceEvents ?? [];
    const types = traceEvents.map((event) => event.type);
    expect(types[0]).toBe("run.queued");
    expect(types).toContain("run_initialized");
    expect(types).toContain("run_completed");
    expect(types.at(-1)).toBe("completed");
    expect(types).toContain("agent_prompt_sent");

    const sessionEvents = loaded.sessionEvents;
    expect(sessionEvents.map((event) => event.seq)).toEqual(
      Array.from({ length: sessionEvents.length }, (_, index) => index + 1),
    );
    expect(sessionEvents.map((event) => event.type)).toContain("assistant_event");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_started");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_finished");
    expect(sessionEvents.map((event) => event.type)).toContain("turn_finished");
    expect(JSON.stringify(sessionEvents)).not.toContain('"partial"');
    expect(JSON.stringify(sessionEvents)).not.toContain('"partialResult"');

    const sessionEntries = loaded.sessionEntries;
    const entryIds = new Set(sessionEntries.map((record) => record.entry.id));
    expect(
      traceEvents
        .filter((event) => event.type === "agent_prompt_sent")
        .every((event) => event.payload.prompt === undefined),
    ).toBe(true);
    const agentPrompts = loaded.state.steps
      .map((step) => step.prompt)
      .filter((prompt): prompt is string => typeof prompt === "string");
    const stepEntries = sessionEntries.filter(
      ({ entry }) =>
        entry.type === "custom_message" && entry.customType === "pi-workflows-agent-step",
    );
    expect(stepEntries).toHaveLength(2);
    expect(stepEntries.map(({ entry }) => entry.content)).toEqual(agentPrompts);
    expect(stepEntries[0]?.entry.details).toMatchObject({
      schema: "pi-workflows.agent-step-message.v1",
      kind: "step",
      contract: {
        workflowName: "e2e",
        nodeId: "propose",
        attemptId: expect.any(String),
      },
      presentation: {
        runTitle: "e2e: ship it",
        statusDetail: "Proposing a solution",
      },
    });
    for (const prompt of agentPrompts) {
      expect(
        mock.requests.some((request) =>
          request.messages.some(
            (message) => message.role === "user" && contentText(message.content) === prompt,
          ),
        ),
      ).toBe(true);
    }
    const duplicateUserPrompts = sessionEntries.filter(({ entry }) => {
      if (entry.type !== "message") return false;
      const message = entry.message;
      return (
        message !== null &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "user" &&
        agentPrompts.some(
          (prompt) => contentText((message as { content?: unknown }).content) === prompt,
        )
      );
    });
    expect(duplicateUserPrompts).toHaveLength(0);

    const incrementalEvents = sessionEvents.filter(
      (event) =>
        event.type === "assistant_event" &&
        ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(event.payload.type)),
    );
    expect(incrementalEvents).toHaveLength(0);
    for (const settledType of ["text_end", "thinking_end", "toolcall_end"]) {
      expect(
        sessionEvents.some(
          (event) => event.type === "assistant_event" && event.payload.type === settledType,
        ),
      ).toBe(true);
    }

    const finalReplay = reduceSessionEvents(sessionEntries, sessionEvents);
    expect(finalReplay.diagnostics).toEqual([]);
    expect(finalReplay.messages.every((message) => message.status !== "streaming")).toBe(true);
    expect(finalReplay.tools.every((tool) => tool.status === "finished")).toBe(true);
    expect(mock.requests.every((request) => request.stream === true)).toBe(true);

    const agentSteps = state.steps.filter((step) => step.nodeType === "agent");
    expect(agentSteps.every((step) => step.conversation !== undefined)).toBe(true);
    expect(
      agentSteps.every(
        (step) =>
          entryIds.has(step.conversation?.firstEntryId ?? "") &&
          entryIds.has(step.conversation?.lastEntryId ?? ""),
      ),
    ).toBe(true);

    const finishedMessages = sessionEvents.filter((event) => event.type === "message_finished");
    const customMessages = finishedMessages.filter((event) => event.payload.role === "custom");
    expect(customMessages).toHaveLength(2);
    expect(customMessages.every((event) => event.payload.settled === false)).toBe(true);
    expect(
      finishedMessages
        .filter((event) => event.payload.role !== "custom")
        .every((event) => event.payload.settled === true),
    ).toBe(true);
    const linkedEntryIds = finishedMessages.flatMap((event) => {
      const id = event.payload.entryId;
      return typeof id === "string" ? [id] : [];
    });
    expect(linkedEntryIds.length).toBeGreaterThan(0);
    expect(linkedEntryIds.every((id) => entryIds.has(id))).toBe(true);

    const capture = loaded.sessionCapture;
    expect(capture).toMatchObject({
      status: "complete",
      eventCount: sessionEvents.length,
      entryCount: entryIds.size,
      lastEventSeq: sessionEvents.length,
    });

    // The mock server must have been driven through the workflow tool, then
    // receive the hidden presentation follow-up and emit normal assistant text.
    const toolRequests = mock.requests.filter((request) =>
      request.messages.some((message) => message.role === "tool"),
    );
    expect(toolRequests.length).toBeGreaterThanOrEqual(2);
    await waitForCondition(
      () =>
        mock.requests.some((request) =>
          request.messages.some(
            (message) =>
              JSON.stringify(message.content)?.includes("Workflow presentation instructions:") ===
              true,
          ),
        ) && pi.stdoutLines.some((line) => line.includes("Implemented the boring, proven design.")),
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );

    await waitForCondition(
      () => {
        const run = readWorkflowRun(runId, { databasePath: runsDir });
        return (
          run?.followUpQueue?.presentationState === "settled" ||
          run?.followUpQueue?.presentationState === "unavailable"
        );
      },
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    const terminalProjection = JSON.stringify(
      listWorkflowRuns({ databasePath: runsDir, includeTrace: true }).find(
        (run) => run.runId === runId,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      JSON.stringify(
        listWorkflowRuns({ databasePath: runsDir, includeTrace: true }).find(
          (run) => run.runId === runId,
        ),
      ),
    ).toBe(terminalProjection);
  }, 120_000);

  it("uses one normal assistant message as node output before continuing", async () => {
    pi.send({
      id: "assistant-output-1",
      type: "prompt",
      message: "/workflow assistant-output-e2e",
    });

    const { state, runId } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "assistant-output-e2e" && candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );

    expect(state.steps.map((step) => step.nodeId)).toEqual(["prepare", "present", "finish"]);
    expect(state.outputs.prepare).toEqual({ ready: true });
    expect(state.outputs.present).toBe("This is one normal visible assistant response.");
    expect(state.finalOutput).toEqual({ text: "This is one normal visible assistant response." });
    expect(state.steps[1]).toMatchObject({
      assistantMessage: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const records = readWorkflowRun(runId, { databasePath: runsDir })?.sessionEntries ?? [];
    const visibleText = records.flatMap((record) => {
      if (record.entry.type !== "message") return [];
      return [contentText((record.entry.message as { content?: unknown } | undefined)?.content)];
    });
    expect(
      visibleText.filter((text) => text === "This is one normal visible assistant response."),
    ).toHaveLength(1);
    const requests = mock.requests.filter((candidate) =>
      candidate.messages.some((message) =>
        contentText(message.content)
          .toLowerCase()
          .includes("workflow step contract (workflow: assistant-output-e2e"),
      ),
    );
    expect(
      requests.some((request) =>
        JSON.stringify(request.messages).includes("assistant-output-e2e, step: prepare"),
      ),
    ).toBe(true);
    const presentationRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes("assistant-output-e2e, step: present"),
    );
    expect(presentationRequest).toBeDefined();
    expect(JSON.stringify(presentationRequest?.messages)).not.toContain('"action":"submit"');
  }, 90_000);

  it("stops the real Pi turn when an agent node times out", async () => {
    pi.send({ id: "timeout-1", type: "prompt", message: "/workflow timeout-e2e" });

    const { state } = await waitForRunState(
      runsDir,
      (candidate) => candidate.workflowName === "timeout-e2e" && candidate.status === "timed_out",
      () => `${pi.stderr()}\n${pi.stdoutLines.join("\n")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(state.results.work?.outcome).toBe("timed_out");
    await expect(fs.stat(timeoutMarker)).rejects.toThrow();
  }, 90_000);

  it("loads and completes a null-timeout node through the real Pi runtime", async () => {
    pi.send({ id: "no-timeout-1", type: "prompt", message: "/workflow no-timeout-e2e" });

    const { runId, state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "no-timeout-e2e" && candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.join("\n")}`,
    );
    const snapshot = listWorkflowRuns({ databasePath: runsDir }).find(
      (run) => run.runId === runId,
    )?.snapshot;

    expect(state.finalOutput).toEqual({ completed: true });
    expect(snapshot?.nodes.work?.timeoutMs).toBeNull();
  }, 90_000);

  it("resumes a paused workflow from explicit normal user text without duplicate execution", async () => {
    await waitForPiIdle(pi);
    const requestOffset = mock.requests.length;
    pi.send({
      id: "resume-control-start",
      type: "prompt",
      message: "/workflow resume-control-e2e",
    });

    const started = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "resume-control-e2e" && candidate.currentNode === "prepare",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForPiIdle(pi);
    pi.send({ id: "resume-control-pause", type: "prompt", message: "/workflow pause" });
    await waitForRunState(
      runsDir,
      (candidate) => candidate.runId === started.runId && candidate.paused === true,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );

    await waitForPiIdle(pi);
    pi.send({ id: "resume-control-continue", type: "prompt", message: "continue it" });
    const { state } = await waitForRunState(
      runsDir,
      (candidate) => candidate.runId === started.runId && candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      20_000,
    );
    await waitForPiIdle(pi);

    expect(state.finalOutput).toEqual({
      prepare: { prepared: true },
      work: { advanced: true },
    });
    expect(state.steps.map((step) => step.nodeId)).toEqual(["prepare", "work", "finish"]);
    const resumeCallIds = new Set(
      mock.requests
        .slice(requestOffset)
        .flatMap((request) => workflowActionCallIds(request.messages, "resume")),
    );
    expect(resumeCallIds.size).toBe(1);
  }, 90_000);

  it("continues a protected human decision through a real Pi command without Telegram", async () => {
    pi.send({
      id: "human-decision-1",
      type: "prompt",
      message: '/workflow human-decision-e2e --input-json {"original":true}',
    });
    const waiting = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "human-decision-e2e" && candidate.status === "waiting",
      () => `${pi.stderr()}\n${pi.stdoutLines.join("\n")}`,
    );
    expect(waiting.state.waitingOn).toBe("approve");
    expect(waiting.state.finalOutput).toMatchObject({
      schema: "pi-workflows.human-decision-request.v1",
      audience: "operator",
    });

    pi.send({
      id: "human-decision-2",
      type: "prompt",
      message: `/workflow answer ${waiting.state.runId} {"choice":"continue"}`,
    });
    const continued = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "human-decision-e2e" &&
        candidate.parentRunId === waiting.state.runId &&
        candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.join("\n")}`,
    );
    expect(continued.state.input).toEqual({ original: true });
    expect(continued.state.finalOutput).toEqual({
      input: { original: true },
      answer: { choice: "continue" },
    });
    expect(continued.state.humanDecision).toMatchObject({
      schema: "pi-workflows.human-decision-receipt.v1",
      provenance: "human",
      response: { choice: "continue" },
    });
    expect(continued.state.humanDecision).not.toHaveProperty("source");
    await waitForResolvedTurnIntent(
      controllerFile,
      projectDir,
      continued.runId,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForPiIdle(pi);
  });

  it("starts one continuation when a direct answer races recovery", async () => {
    const outputOffset = pi.stdoutLines.length;
    pi.send({
      id: "human-decision-race-1",
      type: "prompt",
      message: '/workflow human-decision-race-e2e --input-json {"original":true}',
    });
    const waiting = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "human-decision-race-e2e" && candidate.status === "waiting",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      20_000,
    );
    pi.send({
      id: "human-decision-race-2",
      type: "prompt",
      message: `/workflow answer ${waiting.state.runId} {"choice":"continue"}`,
    });
    const enteredPath = path.join(agentDir, "human-decision-race-loads");
    await waitForCondition(
      async () => {
        const loads = await fs.readFile(enteredPath, "utf8").catch(() => "");
        return loads.trim().split("\n").length >= 3;
      },
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      20_000,
    );
    await fs.writeFile(path.join(agentDir, "human-decision-race-release"), "release\n", "utf8");
    const continued = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "human-decision-race-e2e" &&
        candidate.parentRunId === waiting.state.runId &&
        candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      20_000,
    );
    await waitForPiIdle(pi);

    const continuations = listWorkflowRuns({ databasePath: runsDir }).filter(
      (bundle) => bundle.state.parentRunId === waiting.state.runId,
    );
    expect(continuations).toHaveLength(1);
    expect(continued.state.steps.map((step) => step.nodeId)).toEqual(["approve", "continued"]);

    const queue = new SqliteControllerStore(runsDir, { projectPath: projectDir });
    expect(queue.getWorkflowRun(continued.state.runId)?.status).toBe("done");
    expect(
      queue.state.connection
        .prepare(
          `SELECT l.generation AS generation FROM leases l
           JOIN runs r ON r.resource_id = l.resource_id WHERE r.run_id = ?`,
        )
        .get(continued.state.runId),
    ).toEqual({ generation: 1 });
    expect(
      queue.state.connection
        .prepare(
          `SELECT count(*) AS starts FROM events e
           JOIN runs r ON r.resource_id = e.resource_id
           WHERE r.run_id = ? AND e.event_type = 'run_started'`,
        )
        .get(continued.state.runId),
    ).toEqual({ starts: 1 });
    expect(
      queue.state.connection
        .prepare(
          `SELECT count(*) AS failures FROM events e
           JOIN runs r ON r.resource_id = e.resource_id
           WHERE r.run_id = ? AND e.event_type = 'failed'`,
        )
        .get(continued.state.runId),
    ).toEqual({ failures: 0 });
    queue.close();
    expect(pi.stdoutLines.slice(outputOffset).join("\n")).not.toMatch(
      /already exists|revision conflict|crashed/iu,
    );
  }, 30_000);

  it("continues a timed human decision through the real Pi recovery loop", async () => {
    pi.send({
      id: "human-timeout-1",
      type: "prompt",
      message: '/workflow human-timeout-e2e --input-json {"original":true}',
    });
    const continued = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "human-timeout-e2e" &&
        candidate.parentRunId !== undefined &&
        candidate.status === "completed",
      () => `${pi.stderr()}\n${pi.stdoutLines.join("\n")}`,
    );
    expect(continued.state.finalOutput).toEqual({
      input: { original: true },
      answer: { choice: "continue" },
    });
    expect(continued.state.humanDecision).toMatchObject({
      provenance: "timeout",
      response: { choice: "continue" },
    });
    const parent = listWorkflowRuns({ databasePath: runsDir }).find(
      (bundle) => bundle.state.runId === continued.state.parentRunId,
    );
    expect(parent?.state.finalOutput).toMatchObject({
      defaultResponse: { choice: "continue" },
    });
    expect(parent?.snapshot.nodes.approve?.humanDecision?.onTimeout).toEqual({
      afterMs: 50,
      response: { choice: "continue" },
    });
    await waitForResolvedTurnIntent(
      controllerFile,
      projectDir,
      continued.runId,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    await waitForPiIdle(pi);
  });

  it("starts the built-in monitor from the model-facing workflow tool", async () => {
    await waitForPiIdle(pi);
    pi.send({ id: "monitor-1", type: "prompt", message: "Start the built-in monitor now." });

    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "monitor" &&
        (candidate.status === "completed" || candidate.status === "failed"),
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
    );

    expect(state.status, state.error).toBe("completed");
    expect(state.workflowName).toBe("monitor");
    expect(state.workflowSource).toEqual({ kind: "builtin", id: "monitor", revision: "11" });
    expect(state.workflowPath).toBeUndefined();
    expect(state.workflowHash).toBeUndefined();
    expect(state.finalOutput).toMatchObject({
      observation: "The fixture check completed at 1 of 2 items.",
      reason: "The requested first check is complete.",
    });
    expect(state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "progress", key: "live-agent" }),
        expect.objectContaining({ type: "progress", key: "fixture" }),
      ]),
    );
    await waitForPiIdle(pi);
  });

  it("reconciles a durable controller through the real pi extension", async () => {
    pi.send({
      id: "controller-1",
      type: "prompt",
      message: '/controller apply e2e-controller item-1 {"value":"hello"}',
    });

    await waitForCondition(
      async () => {
        try {
          const store = new SqliteControllerStore(controllerFile, {
            readOnly: true,
            projectPath: projectDir,
          });
          try {
            return (
              store.getResource<unknown, { phase: string }>({
                controller: "e2e-controller",
                key: "item-1",
              })?.status.controllerStatus.phase === "done"
            );
          } finally {
            store.close();
          }
        } catch {
          return false;
        }
      },
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
      20_000,
    );

    const store = new SqliteControllerStore(controllerFile, {
      readOnly: true,
      projectPath: projectDir,
    });
    try {
      const resource = store.getResource({ controller: "e2e-controller", key: "item-1" });
      expect(resource?.status).toMatchObject({
        observedGeneration: 1,
        controllerStatus: { phase: "done" },
        conditions: [{ type: "Ready", status: true, reason: "Complete" }],
      });
      expect(store.listWorkflows(resource?.metadata.uid as string)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("renders the finished run in the viewer CLI", async () => {
    const { state } = await waitForRunState(
      runsDir,
      (candidate) => candidate.status === "completed" && candidate.workflowName === "e2e",
      () => "expected the previous test to have completed an e2e run",
      5_000,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(REPO_ROOT, "src", "viewer", "cli.ts"),
        "view",
        state.runId,
        "--once",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
      },
    );
    expect(stdout).toContain("workflow e2e");
    expect(stdout).toContain("● agent");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("propose");
    expect(stdout).toContain("confirm");
    expect(stdout).toContain("$ action");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("implement");
  }, 30_000);

  it("runs the built-in sanity check in isolated read-only Pi sessions", async () => {
    await waitForPiIdle(pi);
    const requestsBefore = mock.requests.length;
    const sessionsBefore = await sessionEntries(agentDir);
    pi.send({
      id: "sanity-check-e2e",
      type: "prompt",
      message: `/workflow sanity-check --input-json ${JSON.stringify({ baseRef: "HEAD" })}`,
    });
    const { state, runId } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "sanity-check" &&
        ["completed", "failed", "cancelled"].includes(candidate.status),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
      45_000,
    );
    expect(state.status, state.error).toBe("completed");
    expect(state.workflowSource).toEqual({ kind: "builtin", id: "sanity-check", revision: "6" });
    expect(state.outputs.verify).toMatchObject({ verdict: "keep" });
    expect(state.outputs.review).toHaveLength(1);
    expect(state.outputs.detailedReport).toBe(SANITY_DETAILED_RESPONSE);
    expect(state.outputs.plainSummary).toMatchObject({
      exit: "completed",
      output: { text: SANITY_PLAIN_RESPONSE },
    });
    expect(state.finalOutput).toMatchObject({ verdict: "keep" });
    const progress = (state.updates ?? []).filter((update) => update.type === "progress");
    expect(progress.map((update) => update.key)).toEqual(
      expect.arrayContaining([
        "agents/review",
        "agents/review/review",
        "agents/verification",
        "agents/verification/verification",
      ]),
    );
    expect(progress.find((update) => update.key === "agents/review/review")?.data).toMatchObject({
      status: "completed",
      label: expect.stringContaining("fixture-legacy/fixture-legacy-model"),
    });
    await waitForCondition(
      () => mock.requests.length >= requestsBefore + 4,
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
    expect(
      mock.requests
        .slice(requestsBefore)
        .filter(({ messages }) =>
          JSON.stringify(messages).match(
            /Review the change in the current repository|Check the review claims against the collected evidence/u,
          ),
        ),
    ).toHaveLength(2);
    expect(await sessionEntries(agentDir)).toEqual(sessionsBefore);
    const records = readWorkflowRun(runId, { databasePath: runsDir })?.sessionEntries ?? [];
    const visibleReports = records.flatMap((record) => {
      if (record.entry.type !== "message") return [];
      const text = contentText(
        (record.entry.message as { content?: unknown } | undefined)?.content,
      );
      return text === SANITY_DETAILED_RESPONSE || text === SANITY_PLAIN_RESPONSE ? [text] : [];
    });
    expect(visibleReports).toEqual([SANITY_DETAILED_RESPONSE, SANITY_PLAIN_RESPONSE]);
    await waitForCondition(
      () =>
        pi.stdoutLines.some((line) => line.includes("Sanity Check: keep")) &&
        pi.stdoutLines.some((line) => line.includes("Verdict: keep")),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );
  }, 90_000);

  it("continues Autoimplement when the same repository-wide failure exists on the base", async () => {
    await waitForPiIdle(pi);
    const plan = {
      summary: "Exercise change-scoped verification.",
      requirements: ["Keep the baseline backlog visible and continue."],
    };
    pi.send({
      id: "autoimplement-change-scoped-e2e",
      type: "prompt",
      message: `/workflow autoimplement --input-json ${JSON.stringify({
        task: "Run the change-scoped verification fixture.",
        plan,
        repository: projectDir,
        baseBranch: defaultBranch,
        scope: `Only ${projectDir}. Test and report without merge.`,
        constraints: ["Do not merge."],
        documentation: {
          status: "current",
          planDigest: digest(plan),
          documents: ["baseline-check.cjs"],
        },
        workspaceMode: "auto",
        merge: false,
      })}`,
    });
    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "autoimplement" &&
        ["completed", "failed", "cancelled"].includes(candidate.status),
      () => `${pi.stderr()}\n${pi.stdoutLines.slice(-30).join("\n")}`,
      120_000,
    );
    expect(state.status, state.error).toBe("completed");
    expect(state.workflowSource).toEqual({
      kind: "builtin",
      id: "autoimplement",
      revision: "11",
    });
    expect(state.steps.map((step) => step.nodeId)).toEqual(
      expect.arrayContaining([
        "workspace/propose",
        "workspace/apply",
        "implement",
        "localVerification/runCandidate",
        "localVerification/runBase",
        "publish",
      ]),
    );
    const verification = state.outputs.localVerification as {
      exit?: string;
      output?: { relatedFailures?: unknown[]; unrelatedFailures?: unknown[]; route?: string };
    };
    expect(verification).toMatchObject({
      exit: "ready",
      output: {
        route: "ready",
        relatedFailures: [],
        unrelatedFailures: [{ checkId: "simpledoc-baseline" }],
      },
    });
    expect(state.finalOutput).toMatchObject({
      status: "completed",
      delivery: { merged: false },
    });
  }, 150_000);
});
