import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteControllerStore } from "../../src/controllers/sqlite.js";
import { controllerProjectScope } from "../../src/controllers/store.js";
import { reduceSessionEvents } from "../../src/viewer/session-reducer.js";
import type {
  WorkflowRunState,
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
} from "../../src/workflows/types.js";
import { makeTempDir } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const EXTENSION_PATH = path.join(REPO_ROOT, "src", "extension", "index.ts");

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
      "--no-extensions",
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

async function waitForRunState(
  runsDir: string,
  predicate: (state: WorkflowRunState) => boolean,
  onTimeout: () => string,
  timeoutMs = 90_000,
): Promise<{ state: WorkflowRunState; runDir: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await fs.readdir(runsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const runDir = path.join(runsDir, entry);
      try {
        const raw = await fs.readFile(path.join(runDir, "state.json"), "utf8");
        const state = JSON.parse(raw) as WorkflowRunState;
        if (predicate(state)) {
          return { state, runDir };
        }
      } catch {
        // partial write or not a bundle; retry
      }
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
  let controllerDir: string;
  let controllerFile: string;

  beforeAll(async () => {
    // The scripted "model": answers each workflow step contract through the
    // workflow tool and ends its turn after each tool result.
    mock = await startMockOpenAiServer(
      ({ lastUserText, lastRole }) => {
        if (lastUserText.includes("Presentation instructions:")) {
          return { kind: "text", text: "Implemented the boring, proven design." };
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
                reportWhen: "The fixture fails",
                stopWhen: "The first check is complete",
                maxChecks: 1,
              },
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
        const monitorStepMatch = lastUserText.match(
          /workflow step contract \(workflow: monitor, step: ([a-z_]+), attempt: ([a-z0-9-]+)\)/i,
        );
        if (monitorStepMatch?.[1] === "check") {
          return {
            kind: "tool",
            toolName: "workflow",
            args: {
              action: "submit",
              step: "check",
              attempt: monitorStepMatch[2] ?? "",
              output: {
                route: "stop_quiet",
                observation: "The fixture check completed.",
                reason: "The requested first check is complete.",
              },
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
    runsDir = await makeTempDir("pi-workflows-e2e-runs");
    agentDir = await makeTempDir("pi-workflows-e2e-agent");
    controllerDir = await makeTempDir("pi-workflows-e2e-controllers");
    controllerFile = path.join(
      controllerDir,
      "projects",
      controllerProjectScope(projectDir),
      "controller.sqlite",
    );

    await fs.mkdir(path.join(projectDir, ".pi", "workflows"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".pi", "controllers"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "e2e.workflow.ts"),
      E2E_WORKFLOW,
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

    pi = startPiRpc({
      cwd: projectDir,
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_WORKFLOWS_RUNS_DIR: runsDir,
        PI_WORKFLOWS_CONTROLLER_DIR: controllerDir,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pi?.stop();
    await mock?.close();
  });

  it("runs a workflow to completion inside a real pi session", async () => {
    pi.send({ id: "wf-1", type: "prompt", message: "/workflow e2e ship it" });

    // Observe the durable journal while the first tool call is still streaming,
    // not only after Pi and the workflow have reached a terminal state.
    await waitForCondition(
      async () => {
        const runNames = await fs.readdir(runsDir).catch(() => [] as string[]);
        for (const runName of runNames) {
          try {
            const raw = await fs.readFile(
              path.join(runsDir, runName, "session", "events.ndjson"),
              "utf8",
            );
            const events = raw
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as WorkflowSessionEventRecord);
            const deltas = events.filter(
              (event) =>
                event.type === "assistant_event" &&
                event.payload.type === "toolcall_delta" &&
                event.messageId !== undefined,
            );
            const messageId = deltas[0]?.messageId;
            if (deltas.length >= 2 && messageId !== undefined) {
              const alreadyEnded = events.some(
                (event) =>
                  event.type === "assistant_event" &&
                  event.messageId === messageId &&
                  event.payload.type === "toolcall_end",
              );
              if (!alreadyEnded) {
                return true;
              }
            }
          } catch {
            // The bundle or journal is not visible yet; keep polling.
          }
        }
        return false;
      },
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
      20_000,
      10,
    );

    const { state, runDir } = await waitForRunState(
      runsDir,
      (candidate) => candidate.status === "completed" || candidate.status === "failed",
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
    );

    expect(state.status).toBe("completed");
    expect(state.workflowName).toBe("e2e");
    expect(state.runTitle).toBe("e2e: ship it");
    expect(state.steps.map((step) => step.nodeId)).toEqual(["propose", "confirm", "implement"]);
    expect(state.outputs.propose).toEqual({ proposal: "Ship the boring, proven design." });
    expect(state.outputs.confirm).toMatchObject({ route: "y" });
    expect(state.finalOutput).toEqual({ marker: "implemented" });

    const manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8")) as {
      status: string;
    };
    expect(manifest.status).toBe("completed");

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const types = trace
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");
    expect(types).toContain("agent_prompt_sent");

    const sessionEventsRaw = await fs.readFile(
      path.join(runDir, "session", "events.ndjson"),
      "utf8",
    );
    const sessionEvents = sessionEventsRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowSessionEventRecord);
    expect(sessionEvents.map((event) => event.seq)).toEqual(
      Array.from({ length: sessionEvents.length }, (_, index) => index + 1),
    );
    expect(sessionEvents.map((event) => event.type)).toContain("assistant_event");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_started");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_finished");
    expect(sessionEvents.map((event) => event.type)).toContain("turn_finished");
    expect(sessionEventsRaw).not.toContain('"partial"');
    expect(sessionEventsRaw).not.toContain('"partialResult"');

    const entriesRaw = await fs.readFile(path.join(runDir, "session", "entries.ndjson"), "utf8");
    const sessionEntries = entriesRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowSessionEntryRecord);
    const entryIds = new Set(sessionEntries.map((record) => record.entry.id));

    const streamGroups = (deltaType: "text_delta" | "thinking_delta" | "toolcall_delta") => {
      const groups = new Map<string, WorkflowSessionEventRecord[]>();
      for (const event of sessionEvents) {
        if (
          event.type !== "assistant_event" ||
          event.payload.type !== deltaType ||
          event.messageId === undefined ||
          typeof event.payload.contentIndex !== "number"
        ) {
          continue;
        }
        const key = `${event.messageId}:${event.payload.contentIndex}`;
        const group = groups.get(key) ?? [];
        group.push(event);
        groups.set(key, group);
      }
      return groups;
    };
    const textGroups = streamGroups("text_delta");
    const thinkingGroups = streamGroups("thinking_delta");
    const toolGroups = streamGroups("toolcall_delta");
    const fragmentedTextGroups = [...textGroups.values()].filter((group) => group.length > 1);
    const fragmentedThinkingGroups = [...thinkingGroups.values()].filter(
      (group) => group.length > 1,
    );
    const fragmentedToolGroups = [...toolGroups.values()].filter((group) => group.length > 1);
    expect(fragmentedTextGroups.length).toBeGreaterThanOrEqual(2);
    expect(fragmentedThinkingGroups.length).toBeGreaterThanOrEqual(4);
    expect(fragmentedToolGroups.length).toBeGreaterThanOrEqual(2);
    for (const group of [
      ...fragmentedTextGroups,
      ...fragmentedThinkingGroups,
      ...fragmentedToolGroups,
    ]) {
      expect(new Set(group.map((event) => event.at)).size).toBeGreaterThan(1);
    }

    const textEnds = sessionEvents.filter(
      (event) => event.type === "assistant_event" && event.payload.type === "text_end",
    );
    for (const end of textEnds) {
      const key = `${end.messageId}:${String(end.payload.contentIndex)}`;
      const deltas = textGroups.get(key) ?? [];
      expect(deltas.map((event) => event.payload.delta).join("")).toBe(end.payload.content);
    }
    const thinkingEnds = sessionEvents.filter(
      (event) => event.type === "assistant_event" && event.payload.type === "thinking_end",
    );
    for (const end of thinkingEnds) {
      const key = `${end.messageId}:${String(end.payload.contentIndex)}`;
      const deltas = thinkingGroups.get(key) ?? [];
      expect(deltas.map((event) => event.payload.delta).join("")).toBe(end.payload.content);
    }
    const toolEnds = sessionEvents.filter(
      (event) => event.type === "assistant_event" && event.payload.type === "toolcall_end",
    );
    for (const end of toolEnds) {
      const key = `${end.messageId}:${String(end.payload.contentIndex)}`;
      const deltas = toolGroups.get(key) ?? [];
      const toolCall = end.payload.toolCall as { arguments?: unknown };
      expect(JSON.parse(deltas.map((event) => event.payload.delta).join(""))).toEqual(
        toolCall.arguments,
      );
    }

    const textPrefix = fragmentedTextGroups[0]!;
    const textReplay = reduceSessionEvents(sessionEntries, sessionEvents, textPrefix[1]!.seq);
    const textMessage = textReplay.messages.find(
      (message) => message.messageId === textPrefix[0]!.messageId,
    );
    expect(textMessage?.status).toBe("streaming");
    expect(
      textMessage?.blocks.find(
        (block) => block.contentIndex === textPrefix[0]!.payload.contentIndex,
      )?.text,
    ).toBe(
      textPrefix
        .slice(0, 2)
        .map((event) => event.payload.delta)
        .join(""),
    );
    expect(textReplay.diagnostics).toEqual([]);

    const toolPrefix = fragmentedToolGroups[0]!;
    const toolReplay = reduceSessionEvents(sessionEntries, sessionEvents, toolPrefix[1]!.seq);
    const toolMessage = toolReplay.messages.find(
      (message) => message.messageId === toolPrefix[0]!.messageId,
    );
    expect(toolMessage?.status).toBe("streaming");
    expect(
      toolMessage?.blocks.find(
        (block) => block.contentIndex === toolPrefix[0]!.payload.contentIndex,
      )?.text,
    ).toBe(
      toolPrefix
        .slice(0, 2)
        .map((event) => event.payload.delta)
        .join(""),
    );
    expect(toolReplay.diagnostics).toEqual([]);

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
    expect(finishedMessages.every((event) => event.payload.settled === true)).toBe(true);
    const linkedEntryIds = finishedMessages.flatMap((event) => {
      const id = event.payload.entryId;
      return typeof id === "string" ? [id] : [];
    });
    expect(linkedEntryIds.length).toBeGreaterThan(0);
    expect(linkedEntryIds.every((id) => entryIds.has(id))).toBe(true);

    const capture = JSON.parse(
      await fs.readFile(path.join(runDir, "session", "capture.json"), "utf8"),
    ) as {
      status: string;
      eventCount: number;
      entryCount: number;
      lastEventSeq: number;
    };
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
              JSON.stringify(message.content)?.includes("Presentation instructions:") === true,
          ),
        ) && pi.stdoutLines.some((line) => line.includes("Implemented the boring, proven design.")),
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-20).join("\n")}`,
    );

    const terminalFiles = [
      "manifest.json",
      "state.json",
      "trace.ndjson",
      "session/entries.ndjson",
      "session/events.ndjson",
      "session/capture.json",
    ];
    const terminalContents = await Promise.all(
      terminalFiles.map((file) => fs.readFile(path.join(runDir, file), "utf8")),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      Promise.all(terminalFiles.map((file) => fs.readFile(path.join(runDir, file), "utf8"))),
    ).resolves.toEqual(terminalContents);
  }, 120_000);

  it("starts the built-in monitor from the model-facing workflow tool", async () => {
    pi.send({ id: "monitor-1", type: "prompt", message: "Start the built-in monitor now." });

    const { state } = await waitForRunState(
      runsDir,
      (candidate) =>
        candidate.workflowName === "monitor" &&
        (candidate.status === "completed" || candidate.status === "failed"),
      () => `pi stderr:\n${pi.stderr()}\npi stdout tail:\n${pi.stdoutLines.slice(-15).join("\n")}`,
    );

    expect(state.status).toBe("completed");
    expect(state.workflowName).toBe("monitor");
    expect(state.finalOutput).toMatchObject({
      observation: "The fixture check completed.",
      reason: "The requested first check is complete.",
    });
    expect(state.steps.some((step) => step.nodeId === "sleep")).toBe(false);
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
          const store = new SqliteControllerStore(controllerFile, { readOnly: true });
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

    const store = new SqliteControllerStore(controllerFile, { readOnly: true });
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

  it("keeps a real workflow successful when temporal capture fails", async () => {
    const failedRunsDir = await makeTempDir("pi-workflows-e2e-capture-failure");
    const failedControllerDir = await makeTempDir("pi-workflows-e2e-controller-failure");
    const wrapperPath = path.join(projectDir, "capture-failure-extension.ts");
    await fs.writeFile(
      wrapperPath,
      `import workflowExtension from ${JSON.stringify(EXTENSION_PATH)};
import { WorkflowRunStore } from ${JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "store.ts"))};

export default function captureFailureExtension(pi: unknown) {
  WorkflowRunStore.prototype.appendSessionEventBatch = async function () {
    throw new Error("injected real-pi event failure");
  };
  return workflowExtension(pi as never);
}
`,
      "utf8",
    );
    const failingPi = startPiRpc({
      cwd: projectDir,
      extensionPath: wrapperPath,
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_WORKFLOWS_RUNS_DIR: failedRunsDir,
        PI_WORKFLOWS_CONTROLLER_DIR: failedControllerDir,
      },
    });
    try {
      failingPi.send({ id: "wf-failure", type: "prompt", message: "/workflow e2e still ship it" });
      const { state, runDir } = await waitForRunState(
        failedRunsDir,
        (candidate) => candidate.status === "completed" || candidate.status === "failed",
        () =>
          `pi stderr:\n${failingPi.stderr()}\npi stdout tail:\n${failingPi.stdoutLines.slice(-15).join("\n")}`,
      );
      expect(state.status).toBe("completed");
      const capture = JSON.parse(
        await fs.readFile(path.join(runDir, "session", "capture.json"), "utf8"),
      ) as { status: string; failure: { code: string; message: string } };
      expect(capture).toMatchObject({
        status: "failed",
        failure: {
          code: "event_write_failed",
          message: "injected real-pi event failure",
        },
      });
    } finally {
      await failingPi.stop();
    }
  }, 120_000);

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
      { cwd: REPO_ROOT, env: { ...process.env, PI_WORKFLOWS_RUNS_DIR: runsDir, NO_COLOR: "1" } },
    );
    expect(stdout).toContain("workflow e2e");
    expect(stdout).toContain("● agent");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("propose");
    expect(stdout).toContain("confirm");
    expect(stdout).toContain("⚙ action");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("implement");
  }, 30_000);

  it("resumes a parked run through the standalone host", async () => {
    // An isolated project keeps this test away from the controller workers
    // the shared project's live pi session runs.
    const hostProjectDir = await makeTempDir("pi-workflows-host-e2e-project");
    const hostControllerDir = await makeTempDir("pi-workflows-host-e2e-controllers");
    await fs.mkdir(path.join(hostProjectDir, ".pi", "workflows"), { recursive: true });
    const workflowPath = path.join(hostProjectDir, ".pi", "workflows", "host-e2e.workflow.ts");
    await fs.writeFile(workflowPath, HOST_E2E_WORKFLOW, "utf8");
    const hostControllerFile = path.join(
      hostControllerDir,
      "projects",
      controllerProjectScope(hostProjectDir),
      "controller.sqlite",
    );
    const hostRunsDir = await makeTempDir("pi-workflows-host-e2e-runs");
    const hostAgentDir = await makeTempDir("pi-workflows-host-e2e-agent");
    await fs.cp(agentDir, hostAgentDir, { recursive: true });

    // Build the parked state directly: a claimed-then-parked queue row and a
    // bundle stopped mid-agent-node, as if the driving session had closed.
    const queue = new SqliteControllerStore(hostControllerFile);
    queue.enqueueWorkflowRun({
      runId: "host-e2e-run",
      workflowRef: "host-e2e",
      workflowPath,
      input: {},
      runnerId: "session-a",
      claimToken: "token-a",
      leaseMs: 60_000,
    });
    queue.parkWorkflowRun({ runId: "host-e2e-run", claimToken: "token-a" });
    queue.close();

    const { WorkflowRunStore, RUN_STATE_SCHEMA } = await import(
      path.join(REPO_ROOT, "src", "workflows", "store.js")
    );
    const runStore = new WorkflowRunStore(hostRunsDir);
    const { agent, defineWorkflow } = await import(
      path.join(REPO_ROOT, "src", "workflows", "definition.js")
    );
    const workflow = defineWorkflow({
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
    const now = new Date().toISOString();
    const state = {
      schema: RUN_STATE_SCHEMA,
      traceSeq: 0,
      runId: "host-e2e-run",
      workflowName: "host-e2e",
      workflowPath,
      startedAt: now,
      updatedAt: now,
      status: "running" as const,
      input: {},
      outputs: {},
      results: {},
      steps: [],
      currentNode: "work",
    };
    const runDir = await runStore.initializeRunBundle(workflow, state);
    await runStore.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_started",
      payload: {},
    });
    await runStore.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId: "work",
      attemptId: "a1",
      payload: { nodeType: "agent" },
    });

    const { WorkflowHost } = await import(path.join(REPO_ROOT, "src", "host", "runner.js"));
    const logs: string[] = [];
    const host = new WorkflowHost({
      cwd: hostProjectDir,
      storeFile: hostControllerFile,
      runsDir: hostRunsDir,
      claimPollMs: 50,
      piArgs: ["--provider", "mock", "--model", "mock-model"],
      env: {
        PI_CODING_AGENT_DIR: hostAgentDir,
        PI_WORKFLOWS_RUNS_DIR: hostRunsDir,
        PI_WORKFLOWS_CONTROLLER_DIR: hostControllerDir,
      },
      onLog: (line: string) => logs.push(line),
    });
    await host.start();
    try {
      await waitForCondition(
        () => {
          const reader = new SqliteControllerStore(hostControllerFile, { readOnly: true });
          try {
            return reader.getWorkflowRun("host-e2e-run")?.status === "done";
          } finally {
            reader.close();
          }
        },
        () => `expected the host to complete the parked run.\nhost logs:\n${logs.join("\n")}`,
        60_000,
      );
    } finally {
      await host.stop();
    }

    const { state: finished } = await waitForRunState(
      hostRunsDir,
      (candidate) => candidate.runId === "host-e2e-run" && candidate.status !== "running",
      () => "expected the host-resumed run to finish",
      10_000,
    );
    expect(finished.status).toBe("completed");
    expect(finished.finalOutput).toEqual({ finished: "host did it" });
    void runDir;
  }, 90_000);
});
