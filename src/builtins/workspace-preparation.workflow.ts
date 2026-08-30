import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { action, agent, compute, defineWorkflow, manualEffect } from "../workflows/definition.js";

const execFileAsync = promisify(execFile);

export const PREPARED_WORKSPACE_SCHEMA = "pi-workflows.prepared-workspace.v1";
export type WorkspaceMode = "auto" | "branch" | "worktree" | "defaultBranch";
export type PreparedWorkspaceMode = Exclude<WorkspaceMode, "auto">;

export type PreparedWorkspace = {
  schema: typeof PREPARED_WORKSPACE_SCHEMA;
  mode: PreparedWorkspaceMode;
  repository: string;
  worktreePath?: string;
  baseBranch: string;
  baseRevision: string;
  workBranch: string;
  directDefaultBranchAuthorized: boolean;
  preExistingChangedPaths: string[];
  evidence: string[];
  scope: string;
};

export type WorkspacePreparationInput = {
  repository: string;
  baseBranch?: string;
  workspaceMode?: WorkspaceMode;
  directDefaultBranchAuthorized?: boolean;
  scope?: string;
  preparedWorkspace?: PreparedWorkspace;
};

type WorkspaceInspection = {
  route: "ready" | "propose" | "blocked";
  selectedMode?: PreparedWorkspaceMode;
  preparedWorkspace?: PreparedWorkspace;
  repository: string;
  baseBranch: string;
  baseRevision?: string;
  currentBranch?: string;
  preExistingChangedPaths: string[];
  reason: string;
  evidence: string[];
};

type BranchProposal = { branchName: string; reason: string };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireAbsolutePath(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}

function parseMode(value: unknown): WorkspaceMode {
  if (value === undefined) return "auto";
  if (value !== "auto" && value !== "branch" && value !== "worktree" && value !== "defaultBranch") {
    throw new Error("workspaceMode must be auto, branch, worktree, or defaultBranch");
  }
  return value;
}

export function parsePreparedWorkspace(value: unknown): PreparedWorkspace {
  const record = requireRecord(value, "prepared workspace");
  if (record.schema !== PREPARED_WORKSPACE_SCHEMA) {
    throw new Error(`prepared workspace schema must be ${PREPARED_WORKSPACE_SCHEMA}`);
  }
  if (record.mode !== "branch" && record.mode !== "worktree" && record.mode !== "defaultBranch") {
    throw new Error("prepared workspace mode is invalid");
  }
  if (typeof record.directDefaultBranchAuthorized !== "boolean") {
    throw new Error("prepared workspace directDefaultBranchAuthorized must be a boolean");
  }
  if (
    !Array.isArray(record.preExistingChangedPaths) ||
    record.preExistingChangedPaths.some((item) => typeof item !== "string")
  ) {
    throw new Error("prepared workspace preExistingChangedPaths must be strings");
  }
  if (!Array.isArray(record.evidence) || record.evidence.some((item) => typeof item !== "string")) {
    throw new Error("prepared workspace evidence must be strings");
  }
  const repository = requireAbsolutePath(record.repository, "prepared workspace repository");
  const worktreePath =
    record.worktreePath === undefined
      ? undefined
      : requireAbsolutePath(record.worktreePath, "prepared workspace worktreePath");
  if (record.mode === "worktree" && worktreePath === undefined) {
    throw new Error("worktree mode requires worktreePath");
  }
  if (record.mode !== "worktree" && worktreePath !== undefined) {
    throw new Error("worktreePath is allowed only in worktree mode");
  }
  return {
    schema: PREPARED_WORKSPACE_SCHEMA,
    mode: record.mode,
    repository,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    baseBranch: requireString(record.baseBranch, "prepared workspace baseBranch"),
    baseRevision: requireString(record.baseRevision, "prepared workspace baseRevision"),
    workBranch: requireString(record.workBranch, "prepared workspace workBranch"),
    directDefaultBranchAuthorized: record.directDefaultBranchAuthorized,
    preExistingChangedPaths: [...record.preExistingChangedPaths] as string[],
    evidence: [...record.evidence] as string[],
    scope: requireString(record.scope, "prepared workspace scope"),
  };
}

export function parseWorkspacePreparationInput(value: unknown): WorkspacePreparationInput {
  const record = requireRecord(value, "workspace preparation input");
  return {
    repository: requireAbsolutePath(record.repository, "workspace repository"),
    ...(record.baseBranch === undefined
      ? {}
      : { baseBranch: requireString(record.baseBranch, "workspace baseBranch") }),
    workspaceMode: parseMode(record.workspaceMode),
    ...(record.directDefaultBranchAuthorized === undefined
      ? {}
      : { directDefaultBranchAuthorized: record.directDefaultBranchAuthorized === true }),
    ...(record.scope === undefined
      ? {}
      : { scope: requireString(record.scope, "workspace scope") }),
    ...(record.preparedWorkspace === undefined
      ? {}
      : { preparedWorkspace: parsePreparedWorkspace(record.preparedWorkspace) }),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function changedPaths(repository: string): Promise<string[]> {
  const status = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repository, encoding: "utf8", maxBuffer: 2_000_000, timeout: 30_000 },
  );
  const entries = status.stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const statusCode = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (
      (statusCode.includes("R") || statusCode.includes("C")) &&
      entries[index + 1] !== undefined
    ) {
      files.push(entries[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(files)].sort();
}

function workspaceScope(input: WorkspacePreparationInput): string {
  return input.scope ?? `Only ${input.repository}`;
}

function prepared(
  input: WorkspacePreparationInput,
  mode: PreparedWorkspaceMode,
  repository: string,
  baseBranch: string,
  baseRevision: string,
  workBranch: string,
  preExistingChangedPaths: string[],
  evidence: string[],
  worktreePath?: string,
): PreparedWorkspace {
  return {
    schema: PREPARED_WORKSPACE_SCHEMA,
    mode,
    repository,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    baseBranch,
    baseRevision,
    workBranch,
    directDefaultBranchAuthorized:
      mode === "defaultBranch" && input.directDefaultBranchAuthorized === true,
    preExistingChangedPaths,
    evidence,
    scope: workspaceScope(input),
  };
}

export async function inspectWorkspace(
  input: WorkspacePreparationInput,
): Promise<WorkspaceInspection> {
  if (input.preparedWorkspace !== undefined) {
    const value = parsePreparedWorkspace(input.preparedWorkspace);
    const candidatePath = value.worktreePath ?? value.repository;
    const blocked = (
      reason: string,
      evidence: string[],
      currentBranch?: string,
    ): WorkspaceInspection => ({
      route: "blocked",
      repository: input.repository,
      baseBranch: input.baseBranch ?? value.baseBranch,
      baseRevision: value.baseRevision,
      ...(currentBranch === undefined ? {} : { currentBranch }),
      preExistingChangedPaths: [],
      reason,
      evidence,
    });
    if (value.repository !== input.repository) {
      return blocked(
        "The supplied prepared workspace does not own the requested repository path.",
        [value.repository, value.worktreePath ?? "no worktree path"],
      );
    }
    if (input.baseBranch !== undefined && input.baseBranch !== value.baseBranch) {
      return blocked("The supplied prepared workspace uses a different base branch.", [
        `requested=${input.baseBranch}`,
        `prepared=${value.baseBranch}`,
      ]);
    }
    try {
      const topLevel = path.resolve(await git(candidatePath, ["rev-parse", "--show-toplevel"]));
      const repositoryTopLevel = path.resolve(
        await git(value.repository, ["rev-parse", "--show-toplevel"]),
      );
      const candidateCommonDir = path.resolve(
        candidatePath,
        await git(candidatePath, ["rev-parse", "--git-common-dir"]),
      );
      const repositoryCommonDir = path.resolve(
        value.repository,
        await git(value.repository, ["rev-parse", "--git-common-dir"]),
      );
      const currentBranch = await git(candidatePath, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      const headRevision = await git(candidatePath, ["rev-parse", "HEAD"]);
      await git(candidatePath, ["cat-file", "-e", `${value.baseRevision}^{commit}`]);
      await git(candidatePath, ["show-ref", "--verify", `refs/heads/${value.workBranch}`]);
      const branchRevision = await git(candidatePath, [
        "rev-parse",
        `refs/heads/${value.workBranch}`,
      ]);
      await git(candidatePath, ["merge-base", "--is-ancestor", value.baseRevision, headRevision]);
      if (topLevel !== path.resolve(candidatePath)) {
        return blocked("The prepared workspace path no longer names its Git worktree.", [
          `prepared=${candidatePath}`,
          `actual=${topLevel}`,
        ]);
      }
      if (repositoryTopLevel !== path.resolve(value.repository)) {
        return blocked("The prepared workspace owner no longer names its Git worktree.", [
          `prepared=${value.repository}`,
          `actual=${repositoryTopLevel}`,
        ]);
      }
      if (candidateCommonDir !== repositoryCommonDir) {
        return blocked("The prepared worktree does not belong to the requested repository.", [
          `repositoryGitDir=${repositoryCommonDir}`,
          `worktreeGitDir=${candidateCommonDir}`,
        ]);
      }
      if (currentBranch !== value.workBranch || branchRevision !== headRevision) {
        return blocked(
          "The prepared workspace is no longer on its recorded task branch.",
          [
            `preparedBranch=${value.workBranch}`,
            `currentBranch=${currentBranch}`,
            `branchRevision=${branchRevision}`,
            `headRevision=${headRevision}`,
          ],
          currentBranch,
        );
      }
      if (
        value.mode === "defaultBranch" &&
        (value.workBranch !== value.baseBranch ||
          !value.directDefaultBranchAuthorized ||
          input.directDefaultBranchAuthorized !== true)
      ) {
        return blocked(
          "The prepared default-branch receipt no longer proves direct-work authority.",
          [
            `baseBranch=${value.baseBranch}`,
            `workBranch=${value.workBranch}`,
            `receiptAuthorized=${value.directDefaultBranchAuthorized}`,
            `requestAuthorized=${input.directDefaultBranchAuthorized === true}`,
          ],
          currentBranch,
        );
      }
      if (value.mode === "worktree") {
        const listing = await git(value.repository, ["worktree", "list", "--porcelain"]);
        const registered = listing.split("\n\n").some((entry) => {
          const lines = entry.split("\n");
          return (
            lines.includes(`worktree ${path.resolve(candidatePath)}`) &&
            lines.includes(`branch refs/heads/${value.workBranch}`)
          );
        });
        if (!registered) {
          return blocked(
            "The prepared worktree is no longer registered for its recorded task branch.",
            [`worktree=${candidatePath}`, `branch=${value.workBranch}`],
            currentBranch,
          );
        }
      }
      return {
        route: "ready",
        selectedMode: value.mode,
        preparedWorkspace: value,
        repository: value.repository,
        baseBranch: value.baseBranch,
        baseRevision: value.baseRevision,
        currentBranch,
        preExistingChangedPaths: value.preExistingChangedPaths,
        reason: "The prepared workspace was revalidated and adopted.",
        evidence: [
          ...value.evidence,
          `worktree=${topLevel}`,
          `branch=${currentBranch}`,
          `head=${headRevision}`,
          `baseRevision=${value.baseRevision}`,
        ],
      };
    } catch (error) {
      return blocked("The supplied prepared workspace is stale or unavailable.", [String(error)]);
    }
  }

  try {
    const repository = input.repository;
    const currentBranch = await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const localBranches = (
      await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    )
      .split("\n")
      .filter(Boolean);
    let discoveredDefault = localBranches.includes("main")
      ? "main"
      : localBranches.includes("master")
        ? "master"
        : currentBranch;
    try {
      discoveredDefault = (
        await git(repository, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
      ).replace(/^origin\//, "");
    } catch {
      // A local-only repository has no remote default-branch reference.
    }
    const baseBranch = input.baseBranch ?? discoveredDefault;
    const baseRevision = await git(repository, ["rev-parse", baseBranch]);
    const changes = await changedPaths(repository);
    const requested = input.workspaceMode ?? "auto";
    if (requested === "defaultBranch") {
      if (
        baseBranch !== discoveredDefault ||
        currentBranch !== baseBranch ||
        input.directDefaultBranchAuthorized !== true ||
        changes.length > 0
      ) {
        return {
          route: "blocked",
          repository,
          baseBranch,
          baseRevision,
          currentBranch,
          preExistingChangedPaths: changes,
          reason:
            "Direct default-branch work requires explicit authority, the actual base branch, and no pre-existing changes.",
          evidence: [
            `actualDefault=${discoveredDefault}`,
            `branch=${currentBranch}`,
            `authorized=${input.directDefaultBranchAuthorized === true}`,
            `changes=${changes.join(",") || "none"}`,
          ],
        };
      }
      const value = prepared(
        input,
        "defaultBranch",
        repository,
        baseBranch,
        baseRevision,
        currentBranch,
        changes,
        ["Actual default branch confirmed", "Direct work authority confirmed"],
      );
      return {
        route: "ready",
        selectedMode: "defaultBranch",
        preparedWorkspace: value,
        repository,
        baseBranch,
        baseRevision,
        currentBranch,
        preExistingChangedPaths: changes,
        reason: "Direct default-branch workspace confirmed.",
        evidence: value.evidence,
      };
    }
    if ((requested === "auto" || requested === "branch") && currentBranch !== baseBranch) {
      try {
        await git(repository, ["merge-base", "--is-ancestor", baseRevision, "HEAD"]);
      } catch {
        return {
          route: "blocked",
          repository,
          baseBranch,
          baseRevision,
          currentBranch,
          preExistingChangedPaths: changes,
          reason: "The current task branch is not based on the selected base revision.",
          evidence: [`baseRevision=${baseRevision}`, `branch=${currentBranch}`],
        };
      }
      const value = prepared(
        input,
        "branch",
        repository,
        baseBranch,
        baseRevision,
        currentBranch,
        changes,
        ["Existing non-default task branch adopted"],
      );
      return {
        route: "ready",
        selectedMode: "branch",
        preparedWorkspace: value,
        repository,
        baseBranch,
        baseRevision,
        currentBranch,
        preExistingChangedPaths: changes,
        reason: "Existing task branch adopted.",
        evidence: value.evidence,
      };
    }
    const selectedMode: PreparedWorkspaceMode =
      requested === "worktree" || (requested === "auto" && changes.length > 0)
        ? "worktree"
        : "branch";
    if (selectedMode === "branch" && changes.length > 0) {
      return {
        route: "blocked",
        repository,
        baseBranch,
        baseRevision,
        currentBranch,
        preExistingChangedPaths: changes,
        reason: "A task branch cannot be created in a dirty default-branch checkout.",
        evidence: changes,
      };
    }
    return {
      route: "propose",
      selectedMode,
      repository,
      baseBranch,
      baseRevision,
      currentBranch,
      preExistingChangedPaths: changes,
      reason: `A ${selectedMode} name is required.`,
      evidence: [`branch=${currentBranch}`, `changes=${changes.join(",") || "none"}`],
    };
  } catch (error) {
    return {
      route: "blocked",
      repository: input.repository,
      baseBranch: input.baseBranch ?? "unknown",
      preExistingChangedPaths: [],
      reason: "Workspace inspection failed.",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function validateBranchName(
  repository: string,
  branchName: string,
  baseBranch: string,
): Promise<string> {
  const branch = requireString(branchName, "branch proposal");
  if (branch === baseBranch || branch === "HEAD" || branch.startsWith("refs/")) {
    throw new Error("branch proposal is reserved or conflicts with the base branch");
  }
  await git(repository, ["check-ref-format", "--branch", branch]);
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      await git(repository, ["show-ref", "--verify", ref]);
      throw new Error(`branch already exists: ${branch}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("branch already exists:")) throw error;
    }
  }
  return branch;
}

export async function prepareWorkspace(
  input: WorkspacePreparationInput,
  inspection: WorkspaceInspection,
  proposal: BranchProposal,
): Promise<WorkspaceInspection> {
  if (
    inspection.route !== "propose" ||
    inspection.selectedMode === undefined ||
    inspection.baseRevision === undefined
  ) {
    return inspection;
  }
  try {
    const branchName = await validateBranchName(
      inspection.repository,
      proposal.branchName,
      inspection.baseBranch,
    );
    if (inspection.selectedMode === "branch") {
      await git(inspection.repository, ["switch", "-c", branchName, inspection.baseRevision]);
      const value = prepared(
        input,
        "branch",
        inspection.repository,
        inspection.baseBranch,
        inspection.baseRevision,
        branchName,
        inspection.preExistingChangedPaths,
        [...inspection.evidence, `Created branch ${branchName}`],
      );
      return {
        ...inspection,
        route: "ready",
        preparedWorkspace: value,
        currentBranch: branchName,
        reason: proposal.reason,
        evidence: value.evidence,
      };
    }
    const root = path.join(
      path.dirname(inspection.repository),
      `${path.basename(inspection.repository)}-worktrees`,
    );
    const slug = branchName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const worktreePath = path.join(root, slug);
    if (path.dirname(worktreePath) !== root)
      throw new Error("worktree path is outside the standard sibling directory");
    await git(inspection.repository, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      inspection.baseRevision,
    ]);
    const value = prepared(
      input,
      "worktree",
      inspection.repository,
      inspection.baseBranch,
      inspection.baseRevision,
      branchName,
      inspection.preExistingChangedPaths,
      [...inspection.evidence, `Created worktree ${worktreePath}`],
      worktreePath,
    );
    return {
      ...inspection,
      route: "ready",
      preparedWorkspace: value,
      currentBranch: branchName,
      reason: proposal.reason,
      evidence: value.evidence,
    };
  } catch (error) {
    return {
      ...inspection,
      route: "blocked",
      reason: "Workspace preparation failed.",
      evidence: [...inspection.evidence, error instanceof Error ? error.message : String(error)],
    };
  }
}

function parseProposal(value: unknown): BranchProposal {
  const record = requireRecord(value, "branch proposal");
  return {
    branchName: requireString(record.branchName, "branch proposal branchName"),
    reason: requireString(record.reason, "branch proposal reason"),
  };
}

export const workspacePreparationWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.workspace-preparation.v1",
  name: "workspace-preparation",
  input: parseWorkspacePreparationInput,
  startAt: "inspect",
  maxSteps: 5,
  exits: {
    ready: { from: "ready", validate: parsePreparedWorkspace },
    blocked: { from: "blocked", validate: (value: unknown) => value as WorkspaceInspection },
  },
  nodes: {
    inspect: action({
      effect: manualEffect("pi-workflows.workspace-preparation.inspect"),
      run: async ({ input }) => await inspectWorkspace(input as WorkspacePreparationInput),
    }),
    propose: agent({
      prompt: ({ outputs }) =>
        [
          "Propose one clear Git task branch name for this work.",
          "Return only the name and a short reason. Do not run Git or create anything.",
          `Workspace facts: ${JSON.stringify(outputs.inspect)}`,
        ].join("\n"),
      expectedOutput: '{ "branchName": "type/short-task-name", "reason": "why this name fits" }',
      validate: parseProposal,
    }),
    apply: action({
      effect: manualEffect("pi-workflows.workspace-preparation.apply"),
      run: async ({ input, outputs }) =>
        await prepareWorkspace(
          input as WorkspacePreparationInput,
          outputs.inspect as WorkspaceInspection,
          outputs.propose as BranchProposal,
        ),
    }),
    ready: compute({
      run: ({ outputs }) => {
        const result = (outputs.apply ?? outputs.inspect) as WorkspaceInspection;
        if (result.preparedWorkspace === undefined)
          throw new Error("workspace preparation has no ready result");
        return result.preparedWorkspace;
      },
    }),
    blocked: compute({ run: ({ outputs }) => outputs.apply ?? outputs.inspect }),
  },
  edges: [
    {
      from: "inspect",
      switch: { on: "$.route", cases: { ready: "ready", propose: "propose", blocked: "blocked" } },
    },
    { from: "propose", to: "apply" },
    { from: "apply", switch: { on: "$.route", cases: { ready: "ready", blocked: "blocked" } } },
  ],
});

export default workspacePreparationWorkflow;
