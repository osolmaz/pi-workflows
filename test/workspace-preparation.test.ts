import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  inspectWorkspace,
  parsePreparedWorkspace,
  parseWorkspacePreparationInput,
  prepareWorkspace,
  validateBranchName,
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
  it("validates workspace inputs and prepared receipts", () => {
    expect(() => parseWorkspacePreparationInput(null)).toThrow(/object/);
    expect(() => parseWorkspacePreparationInput({ repository: "relative" })).toThrow(/absolute/);
    expect(
      parseWorkspacePreparationInput({
        repository: "/tmp/demo",
        directDefaultBranchAuthorized: true,
      }),
    ).toMatchObject({ directDefaultBranchAuthorized: true });
    expect(() =>
      parseWorkspacePreparationInput({ repository: "/tmp/demo", workspaceMode: "legacy" }),
    ).toThrow(/workspaceMode/);
    expect(() => parsePreparedWorkspace({ schema: "wrong" })).toThrow(/schema/);
    const basePrepared = {
      schema: "pi-workflows.prepared-workspace.v1",
      mode: "branch",
      repository: "/tmp/demo",
      baseBranch: "main",
      baseRevision: "abc",
      workBranch: "feat/x",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: [],
      scope: "Only /tmp/demo",
    };
    expect(() => parsePreparedWorkspace({ ...basePrepared, mode: "legacy" })).toThrow(/mode/);
    expect(() =>
      parsePreparedWorkspace({ ...basePrepared, directDefaultBranchAuthorized: "yes" }),
    ).toThrow(/boolean/);
    expect(() => parsePreparedWorkspace({ ...basePrepared, preExistingChangedPaths: [1] })).toThrow(
      /preExistingChangedPaths/,
    );
    expect(() => parsePreparedWorkspace({ ...basePrepared, evidence: [1] })).toThrow(/evidence/);
    expect(() => parsePreparedWorkspace({ ...basePrepared, scope: "" })).toThrow(/scope/);
    expect(() =>
      parsePreparedWorkspace({
        schema: "pi-workflows.prepared-workspace.v1",
        mode: "worktree",
        repository: "/tmp/demo",
        baseBranch: "main",
        baseRevision: "abc",
        workBranch: "feat/x",
        directDefaultBranchAuthorized: false,
        preExistingChangedPaths: [],
        evidence: [],
        scope: "Only /tmp/demo",
      }),
    ).toThrow(/worktreePath/);
    expect(
      parsePreparedWorkspace({
        ...basePrepared,
        mode: "worktree",
        worktreePath: "/tmp/demo-worktrees/feat-x",
      }),
    ).toMatchObject({ mode: "worktree", worktreePath: "/tmp/demo-worktrees/feat-x" });
    expect(() =>
      parsePreparedWorkspace({
        ...basePrepared,
        worktreePath: "/tmp/demo-worktrees/feat-x",
      }),
    ).toThrow(/only in worktree mode/);
  });

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

  it("creates a standard sibling worktree and records both paths of a dirty rename", async () => {
    const repo = await repository("workspace-dirty-default");
    await git(repo, ["mv", "README.md", "RENAMED.md"]);
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
    expect(result.preExistingChangedPaths).toEqual(["README.md", "RENAMED.md", "notes.txt"]);
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

  it("handles explicit worktree mode and rejects branch conflicts", async () => {
    const repo = await repository("workspace-explicit-worktree");
    const inspection = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "worktree",
    });
    const created = await prepareWorkspace(
      { repository: repo, baseBranch: "main", workspaceMode: "worktree" },
      inspection,
      { branchName: "feat/explicit-worktree", reason: "Explicit isolation." },
    );
    expect(created.preparedWorkspace).toMatchObject({ mode: "worktree" });
    const prepared = parsePreparedWorkspace(created.preparedWorkspace);
    const adopted = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      preparedWorkspace: prepared,
    });
    expect(adopted).toMatchObject({
      route: "ready",
      selectedMode: "worktree",
      currentBranch: "feat/explicit-worktree",
    });
    await git(repo, ["worktree", "remove", "--force", prepared.worktreePath!]);
    await git(repo, ["branch", "feat/existing"]);
    await expect(validateBranchName(repo, "feat/existing", "main")).rejects.toThrow(/exists/);
    await git(repo, ["update-ref", "refs/remotes/origin/feat/remote", "HEAD"]);
    await expect(validateBranchName(repo, "feat/remote", "main")).rejects.toThrow(/exists/);
  });

  it("blocks dirty explicit branch mode and invalid repositories", async () => {
    const repo = await repository("workspace-dirty-branch");
    await fs.writeFile(path.join(repo, "dirty.txt"), "keep\n");
    const dirty = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "branch",
    });
    expect(dirty).toMatchObject({ route: "blocked", preExistingChangedPaths: ["dirty.txt"] });
    const invalid = await inspectWorkspace({
      repository: path.join(repo, "missing"),
      baseBranch: "main",
    });
    expect(invalid).toMatchObject({ route: "blocked", reason: "Workspace inspection failed." });
  });

  it("rejects a prepared workspace owned by another path", async () => {
    const repo = await repository("workspace-wrong-prepared");
    const prepared = {
      schema: "pi-workflows.prepared-workspace.v1" as const,
      mode: "branch" as const,
      repository: "/tmp/other",
      baseBranch: "main",
      baseRevision: "abc",
      workBranch: "feat/other",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: ["other"],
      scope: "Only /tmp/other",
    };
    const result = await inspectWorkspace({ repository: repo, preparedWorkspace: prepared });
    expect(result).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("does not own"),
    });
  });

  it("rejects a worktree receipt that belongs to another repository", async () => {
    const repo = await repository("workspace-owner");
    const unrelated = await repository("workspace-unrelated-worktree");
    await git(unrelated, ["switch", "-c", "feat/unrelated"]);
    const prepared = {
      schema: "pi-workflows.prepared-workspace.v1" as const,
      mode: "worktree" as const,
      repository: repo,
      worktreePath: unrelated,
      baseBranch: "main",
      baseRevision: await git(unrelated, ["rev-parse", "main"]),
      workBranch: "feat/unrelated",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: ["untrusted receipt"],
      scope: `Only ${repo}`,
    };
    const result = await inspectWorkspace({ repository: repo, preparedWorkspace: prepared });
    expect(result).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("does not belong to the requested repository"),
    });
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

  it("rejects a prepared workspace after its task branch changes", async () => {
    const repo = await repository("workspace-stale-branch");
    await git(repo, ["switch", "-c", "feat/recorded"]);
    const first = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "auto",
    });
    const prepared = parsePreparedWorkspace(first.preparedWorkspace);
    await git(repo, ["switch", "-c", "feat/other"]);
    const result = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      preparedWorkspace: prepared,
    });
    expect(result).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("recorded task branch"),
      currentBranch: "feat/other",
    });
  });

  it("rejects a prepared workspace with a different requested base", async () => {
    const repo = await repository("workspace-base-mismatch");
    await git(repo, ["switch", "-c", "feat/recorded"]);
    const first = await inspectWorkspace({ repository: repo, baseBranch: "main" });
    const prepared = parsePreparedWorkspace(first.preparedWorkspace);
    const result = await inspectWorkspace({
      repository: repo,
      baseBranch: "release",
      preparedWorkspace: prepared,
    });
    expect(result).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("different base branch"),
    });
  });

  it("rejects a prepared default-branch receipt without retained authority", async () => {
    const repo = await repository("workspace-default-receipt-authority");
    const first = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "defaultBranch",
      directDefaultBranchAuthorized: true,
    });
    const retained = parsePreparedWorkspace(first.preparedWorkspace);
    const missingRequestAuthority = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      preparedWorkspace: retained,
    });
    expect(missingRequestAuthority).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("direct-work authority"),
      evidence: expect.arrayContaining(["requestAuthorized=false"]),
    });

    const missingReceiptAuthority = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      directDefaultBranchAuthorized: true,
      preparedWorkspace: { ...retained, directDefaultBranchAuthorized: false },
    });
    expect(missingReceiptAuthority).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("direct-work authority"),
      evidence: expect.arrayContaining(["receiptAuthorized=false"]),
    });
  });

  it("rejects a prepared path that is only a directory inside the worktree", async () => {
    const repo = await repository("workspace-nested-receipt");
    await git(repo, ["switch", "-c", "feat/recorded"]);
    const first = await inspectWorkspace({ repository: repo, baseBranch: "main" });
    const nested = path.join(repo, "nested");
    await fs.mkdir(nested);
    const prepared = {
      ...parsePreparedWorkspace(first.preparedWorkspace),
      repository: nested,
    };
    const result = await inspectWorkspace({ repository: nested, preparedWorkspace: prepared });
    expect(result).toMatchObject({
      route: "blocked",
      reason: expect.stringContaining("no longer names its Git worktree"),
    });
  });

  it("rejects a prepared workspace when its recorded base revision is unavailable", async () => {
    const repo = await repository("workspace-stale-base");
    await git(repo, ["switch", "-c", "feat/recorded"]);
    const first = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      workspaceMode: "auto",
    });
    const prepared = {
      ...parsePreparedWorkspace(first.preparedWorkspace),
      baseRevision: "0000000000000000000000000000000000000000",
    };
    const result = await inspectWorkspace({
      repository: repo,
      baseBranch: "main",
      preparedWorkspace: prepared,
    });
    expect(result).toMatchObject({
      route: "blocked",
      reason: "The supplied prepared workspace is stale or unavailable.",
    });
  });
});
