import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { action, agent, compute, defineWorkflow } from "../workflows/definition.js";

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
  const output = await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (output.length === 0) return [];
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .sort();
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
    if (value.repository !== input.repository && value.worktreePath !== input.repository) {
      return {
        route: "blocked",
        repository: input.repository,
        baseBranch: input.baseBranch ?? value.baseBranch,
        preExistingChangedPaths: [],
        reason: "The supplied prepared workspace does not own the requested repository path.",
        evidence: [value.repository, value.worktreePath ?? "no worktree path"],
      };
    }
    return {
      route: "ready",
      selectedMode: value.mode,
      preparedWorkspace: value,
      repository: value.repository,
      baseBranch: value.baseBranch,
      baseRevision: value.baseRevision,
      currentBranch: value.workBranch,
      preExistingChangedPaths: value.preExistingChangedPaths,
      reason: "The prepared workspace was validated and adopted.",
      evidence: value.evidence,
    };
  }

  try {
    const repository = input.repository;
    const currentBranch = await git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const baseBranch = input.baseBranch ?? (await git(repository, ["branch", "--show-current"]));
    const baseRevision = await git(repository, ["rev-parse", baseBranch]);
    const changes = await changedPaths(repository);
    const requested = input.workspaceMode ?? "auto";
    if (requested === "defaultBranch") {
      if (
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
  try {
    await git(repository, ["show-ref", "--verify", `refs/heads/${branch}`]);
    throw new Error(`branch already exists: ${branch}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("branch already exists:")) throw error;
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
