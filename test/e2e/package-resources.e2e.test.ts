import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowClient } from "../../src/client/client.js";
import { clientSocketPath } from "../../src/client/protocol.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const piBin = path.join(repoRoot, "node_modules", ".bin", "pi");
const HOST_STOP_TIMEOUT_MS = 5_000;
const tempDirs: string[] = [];

type CommandInfo = {
  name: string;
  sourceInfo?: { path?: string };
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflows-package-"));
  tempDirs.push(dir);
  return dir;
}

async function getCommands(args: string[], tempDir: string): Promise<CommandInfo[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        piBin,
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-context-files",
        "--no-themes",
        "--no-prompt-templates",
        "--provider",
        "openai",
        "--model",
        "gpt-4o-mini",
        ...args,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tempDir,
          PI_CODING_AGENT_DIR: path.join(tempDir, "agent"),
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi package discovery timed out.\n${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Pi package discovery exited with ${code}.\n${stderr}\n${stdout}`));
        return;
      }

      const responses = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const response = responses.find(
        (entry) => entry.type === "response" && entry.command === "get_commands",
      ) as { data?: { commands?: CommandInfo[] } } | undefined;
      if (!response?.data?.commands) {
        reject(new Error(`Pi did not return get_commands.\n${stderr}\n${stdout}`));
        return;
      }
      resolve(response.data.commands);
    });

    child.stdin.end(`${JSON.stringify({ type: "get_commands" })}\n`);
  });
}

function command(commands: CommandInfo[], name: string): CommandInfo | undefined {
  return commands.find((entry) => entry.name === name);
}

async function stopPackageHost(directory: string): Promise<void> {
  const databasePath = path.join(directory, ".pi", "agent", "workflows", "state.sqlite");
  const endpoint = clientSocketPath(databasePath);
  const client = new WorkflowClient({ databasePath });
  try {
    await client.request({ operation: "host.stop" });
  } catch (error) {
    try {
      await fs.access(endpoint);
    } catch {
      return;
    }
    throw error;
  }

  const deadline = Date.now() + HOST_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fs.access(endpoint);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }
  }
  throw new Error(`Temporary workflow host did not stop: ${endpoint}`);
}

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await stopPackageHost(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe.sequential("Pi package resource discovery", () => {
  it("discovers the extension and bundled skills from the package", async () => {
    const tempDir = await makeTempDir();
    const commands = await getCommands(["-e", repoRoot], tempDir);

    expect(command(commands, "workflow")?.sourceInfo?.path).toBe(
      path.join(repoRoot, "src", "extension", "index.ts"),
    );
    expect(command(commands, "skill:monitor")?.sourceInfo?.path).toBe(
      path.join(repoRoot, "skills", "monitor", "SKILL.md"),
    );
    expect(command(commands, "skill:pi-workflows")?.sourceInfo?.path).toBe(
      path.join(repoRoot, "skills", "pi-workflows", "SKILL.md"),
    );
    expect(command(commands, "skill:sanity-check")?.sourceInfo?.path).toBe(
      path.join(repoRoot, "skills", "sanity-check", "SKILL.md"),
    );
  });

  it("can disable one bundled skill without disabling the extension", async () => {
    const tempDir = await makeTempDir();
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          packages: [{ source: repoRoot, skills: ["-skills/monitor"] }],
        },
        undefined,
        2,
      )}\n`,
    );

    const commands = await getCommands([], tempDir);

    expect(command(commands, "workflow")).toBeDefined();
    expect(command(commands, "skill:pi-workflows")).toBeDefined();
    expect(command(commands, "skill:monitor")).toBeUndefined();
  });

  it("can disable all bundled skills without disabling the extension", async () => {
    const tempDir = await makeTempDir();
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [{ source: repoRoot, skills: [] }] }, undefined, 2)}\n`,
    );

    const commands = await getCommands([], tempDir);

    expect(command(commands, "workflow")).toBeDefined();
    expect(command(commands, "skill:pi-workflows")).toBeUndefined();
    expect(command(commands, "skill:monitor")).toBeUndefined();
  });

  it("can disable the extension without disabling bundled skills", async () => {
    const tempDir = await makeTempDir();
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [{ source: repoRoot, extensions: [] }] }, undefined, 2)}\n`,
    );

    const commands = await getCommands([], tempDir);

    expect(command(commands, "workflow")).toBeUndefined();
    expect(command(commands, "skill:pi-workflows")).toBeDefined();
    expect(command(commands, "skill:monitor")).toBeDefined();
  });
});
