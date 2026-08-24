import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  inspectWorkspace,
  parsePreparedWorkspace,
  prepareWorkspace,
  workspacePreparationWorkflow,
  type WorkspacePreparationInput,
} from "../src/builtins/workspace-preparation.workflow.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(name: string): Promise<string> {
  const root = await makeTempDir(name);
  const repo = path.join(root, "demo");
  await fs.mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "demo\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

async function run(input: WorkspacePreparationInput, executor = new ScriptedExecutor()) {
  return await new WorkflowEngine({
    executor,
    databasePath: await makeStateDatabasePath("workspace-preparation"),
  }).run(workspacePreparationWorkflow, input);
}

describe("workspace preparation", () => {
  it("adopts an existing non-default task branch", async () => {
    const repo = await repository("workspace-existing-branch");
    await git(repo, ["switch", "-c", "feat/current"]);
    const { state } = await run({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "auto",
      scope: `Only ${repo}`,
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      mode: "branch",
      repository: repo,
      workBranch: "feat/current",
      preExistingChangedPaths: [],
    });
  });

  it("uses a model proposal and programmatically creates a branch from a clean default branch", async () => {
    const repo = await repository("workspace-clean-default");
    const executor = new ScriptedExecutor().respond("propose", {
      output: { branchName: "feat/change-checks", reason: "Clear task name." },
    });
    const { state } = await run(
      { repository: repo, baseBranch: "main", workspaceMode: "auto" },
      executor,
    );
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      mode: "branch",
      workBranch: "feat/change-checks",
      baseBranch: "main",
    });
    expect(await git(repo, ["branch", "--show-current"])).toBe("feat/change-checks");
  });

  it("creates a standard sibling worktree when the default checkout is dirty", async () => {
    const repo = await repository("workspace-dirty-default");
    await fs.writeFile(path.join(repo, "notes.txt"), "keep\n");
    const executor = new ScriptedExecutor().respond("propose", {
      output: { branchName: "feat/isolated", reason: "Keep shared work isolated." },
    });
    const { state } = await run(
      { repository: repo, baseBranch: "main", workspaceMode: "auto" },
      executor,
    );
    const result = parsePreparedWorkspace(state.finalOutput);
    expect(result.mode).toBe("worktree");
    expect(result.worktreePath).toBe(
      path.join(path.dirname(repo), "demo-worktrees", "feat-isolated"),
    );
    expect(result.preExistingChangedPaths).toEqual(["notes.txt"]);
    await expect(fs.readFile(path.join(repo, "notes.txt"), "utf8")).resolves.toBe("keep\n");
    await git(repo, ["worktree", "remove", "--force", result.worktreePath!]);
  });

  it("requires explicit authority and a clean actual default branch for defaultBranch mode", async () => {
    const repo = await repository("workspace-default-authority");
    const blocked = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "defaultBranch",
    });
    expect(blocked.route).toBe("blocked");
    const ready = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "defaultBranch",
      directDefaultBranchAuthorized: true,
    });
    expect(ready.preparedWorkspace).toMatchObject({
      mode: "defaultBranch",
      directDefaultBranchAuthorized: true,
    });
  });

  it("rejects invalid or conflicting branch names without moving existing work", async () => {
    const repo = await repository("workspace-invalid-name");
    const inspection = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "branch",
    });
    const result = await prepareWorkspace(
      { repository: repo, baseBranch: "main", workspaceMode: "branch" },
      inspection,
      { branchName: "main", reason: "bad" },
    );
    expect(result.route).toBe("blocked");
    expect(await git(repo, ["branch", "--show-current"])).toBe("main");
  });

  it("adopts the same prepared workspace after restart", async () => {
    const repo = await repository("workspace-restart");
    await git(repo, ["switch", "-c", "feat/restart"]);
    const first = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "auto",
      scope: `Only ${repo}`,
    });
    const prepared = parsePreparedWorkspace(first.preparedWorkspace);
    const second = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      preparedWorkspace: prepared,
    });
    expect(second.route).toBe("ready");
    expect(second.preparedWorkspace).toEqual(prepared);
  });
});
