import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "../../src/workflows/types.js";
import { makeTempDir } from "../helpers.js";
import { startMockOpenAiServer } from "./mock-openai.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");
const EXTENSION_PATH = path.join(REPO_ROOT, "src", "extension", "index.ts");

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
  predicate: () => boolean,
  onTimeout: () => string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for condition.\n${onTimeout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  beforeAll(async () => {
    // The scripted "model": answers each workflow step contract through the
    // workflow tool and ends its turn after each tool result.
    mock = await startMockOpenAiServer(({ lastUserText, lastRole }) => {
      if (lastUserText.includes("Presentation instructions:")) {
        return { kind: "text", text: "Implemented the boring, proven design." };
      }
      if (lastRole === "tool") {
        return { kind: "text", text: "Step submitted." };
      }
      const stepMatch = lastUserText.match(
        /workflow step contract \(workflow: e2e, step: ([a-z_]+), attempt: ([a-z0-9-]+)\)/i,
      );
      const step = stepMatch?.[1];
      const attempt = stepMatch?.[2] ?? "";
      if (step === "propose") {
        return {
          kind: "tool",
          toolName: "workflow",
          args: {
            step: "propose",
            attempt,
            output: { proposal: "Ship the boring, proven design." },
          },
        };
      }
      if (step === "confirm") {
        return {
          kind: "tool",
          toolName: "workflow",
          args: {
            step: "confirm",
            attempt,
            output: { route: "y", reason: "proposal matches the holy grail" },
          },
        };
      }
      return { kind: "text", text: "Nothing to do." };
    });

    projectDir = await makeTempDir("pi-workflows-e2e-project");
    runsDir = await makeTempDir("pi-workflows-e2e-runs");
    agentDir = await makeTempDir("pi-workflows-e2e-agent");

    await fs.mkdir(path.join(projectDir, ".pi", "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".pi", "workflows", "e2e.workflow.ts"),
      E2E_WORKFLOW,
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
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pi?.stop();
    await mock?.close();
  });

  it("runs a workflow to completion inside a real pi session", async () => {
    pi.send({ id: "wf-1", type: "prompt", message: "/workflow e2e ship it" });

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
      .map(
        (line) =>
          JSON.parse(line) as {
            seq: number;
            type: string;
            messageId?: string;
            payload: Record<string, unknown>;
          },
      );
    expect(sessionEvents.map((event) => event.seq)).toEqual(
      Array.from({ length: sessionEvents.length }, (_, index) => index + 1),
    );
    expect(sessionEvents.map((event) => event.type)).toContain("assistant_event");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_started");
    expect(sessionEvents.map((event) => event.type)).toContain("tool_execution_finished");
    expect(sessionEventsRaw).not.toContain('"partial"');
    expect(sessionEventsRaw).not.toContain('"partialResult"');

    const entriesRaw = await fs.readFile(path.join(runDir, "session", "entries.ndjson"), "utf8");
    const entryIds = new Set(
      entriesRaw
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { entry: { id: string } }).entry.id),
    );
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

  it("keeps a real workflow successful when temporal capture fails", async () => {
    const failedRunsDir = await makeTempDir("pi-workflows-e2e-capture-failure");
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
      (candidate) => candidate.status === "completed",
      () => "expected the previous test to have completed a run",
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
    expect(stdout).toContain("✓ completed [agent]");
    expect(stdout).toContain("propose");
    expect(stdout).toContain("confirm");
    expect(stdout).toContain("✓ completed [action]");
    expect(stdout).toContain("implement");
  }, 30_000);
});
