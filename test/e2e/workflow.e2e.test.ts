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

const E2E_WORKFLOW = `import { agent, decision, decisionEdge, defineWorkflow, shell } from "pi-workflows";

const choices = ["y", "n"] as const;

export default defineWorkflow({
  name: "e2e",
  title: ({ input }) => \`e2e: \${(input as { task?: string }).task ?? "unnamed"}\`,
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

function startPiRpc(options: { cwd: string; env: Record<string, string> }): RpcHandle {
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

  beforeAll(async () => {
    // The scripted "model": answers each workflow step contract through the
    // workflow tool and ends its turn after each tool result.
    mock = await startMockOpenAiServer(({ lastUserText, lastRole }) => {
      if (lastRole === "tool") {
        return { kind: "text", text: "Step submitted." };
      }
      const stepMatch = lastUserText.match(
        /workflow step contract \(workflow: e2e, step: ([a-z_]+)\)/i,
      );
      const step = stepMatch?.[1];
      if (step === "propose") {
        return {
          kind: "tool",
          toolName: "workflow",
          args: { step: "propose", output: { proposal: "Ship the boring, proven design." } },
        };
      }
      if (step === "confirm") {
        return {
          kind: "tool",
          toolName: "workflow",
          args: {
            step: "confirm",
            output: { route: "y", reason: "proposal matches the holy grail" },
          },
        };
      }
      return { kind: "text", text: "Nothing to do." };
    });

    projectDir = await makeTempDir("pi-workflows-e2e-project");
    runsDir = await makeTempDir("pi-workflows-e2e-runs");
    const agentDir = await makeTempDir("pi-workflows-e2e-agent");

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

    // The mock server must have been driven through the workflow tool.
    const toolRequests = mock.requests.filter((request) =>
      request.messages.some((message) => message.role === "tool"),
    );
    expect(toolRequests.length).toBeGreaterThanOrEqual(2);
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
    expect(stdout).toContain("✓ propose [agent]");
    expect(stdout).toContain("✓ confirm [agent]");
    expect(stdout).toContain("✓ implement [action]");
  }, 30_000);
});
