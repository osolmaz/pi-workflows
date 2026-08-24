import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  changeVerificationWorkflow,
  classifyVerification,
  type ChangeVerificationInput,
  type VerificationCheck,
} from "../src/builtins/change-verification.workflow.js";
import {
  PREPARED_WORKSPACE_SCHEMA,
  type PreparedWorkspace,
} from "../src/builtins/workspace-preparation.workflow.js";
import type { CommandBatchItemResult, CommandBatchResult } from "../src/workflows/command-batch.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { makeStateDatabasePath, makeTempDir, ScriptedExecutor } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture(
  name: string,
): Promise<{ repository: string; workspace: PreparedWorkspace }> {
  const repository = await makeTempDir(name);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repository, "README.md"), "base\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "base"]);
  const baseRevision = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "-c", "feat/test"]);
  return {
    repository,
    workspace: {
      schema: PREPARED_WORKSPACE_SCHEMA,
      mode: "branch",
      repository,
      baseBranch: "main",
      baseRevision,
      workBranch: "feat/test",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: ["test fixture"],
      scope: `Only ${repository}`,
    },
  };
}

function check(
  repository: string,
  source: string,
  mechanicalFix?: VerificationCheck["mechanicalFix"],
): VerificationCheck {
  return {
    id: "docs",
    command: process.execPath,
    args: ["-e", source],
    cwd: repository,
    timeoutMs: 10_000,
    maxOutputChars: 100_000,
    readOnly: true,
    baseEligible: true,
    changedFileScope: false,
    findingFormat: "text",
    ...(mechanicalFix === undefined ? {} : { mechanicalFix }),
  };
}

async function run(input: ChangeVerificationInput, executor = new ScriptedExecutor()) {
  return await new WorkflowEngine({
    executor,
    databasePath: await makeStateDatabasePath("change-verification"),
  }).run(changeVerificationWorkflow, input);
}

function result(
  id: string,
  outcome: CommandBatchItemResult["outcome"],
  stdout: string,
  cwd = "/candidate",
  exitCode = outcome === "succeeded" ? 0 : 1,
): CommandBatchItemResult {
  return {
    id,
    outcome,
    command: "check",
    args: [],
    cwd,
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    durationMs: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function batch(items: CommandBatchItemResult[]): CommandBatchResult {
  return {
    schema: "pi-workflows.command-batch-result.v1",
    items,
    completed: items.length,
    total: items.length,
  };
}

describe("change verification", () => {
  it("reports the same candidate and base backlog as unrelated and continues", async () => {
    const { repository, workspace } = await fixture("change-verification-baseline");
    const { state } = await run({
      originatingWorkflow: "autodoc",
      qualifiedNode: "documentation/verification",
      workspace,
      checks: [
        check(
          repository,
          'console.error("30 renames, 32 frontmatter insertions, 8 reference updates"); process.exit(1)',
        ),
      ],
    });
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      route: "ready",
      relatedFailures: [],
      unrelatedFailures: [{ checkId: "docs" }],
    });
  });

  it("classifies a candidate-only failure as related", async () => {
    const { repository, workspace } = await fixture("change-verification-related");
    await fs.writeFile(path.join(repository, "candidate.txt"), "bad\n");
    const source =
      'const fs=require("fs"); if(fs.existsSync("candidate.txt")){console.error("candidate failure");process.exit(1)}';
    const executor = new ScriptedExecutor().respond("semanticRepair", {
      output: { changedFiles: [], result: "No safe repair in this fixture." },
    });
    const { state } = await run(
      {
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [check(repository, source)],
        plan: { test: true },
      },
      executor,
    );
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      route: "blocked",
      relatedFailures: [{ checkId: "docs" }],
    });
  });

  it("records a base-only failure as fixed by the candidate", async () => {
    const { repository, workspace } = await fixture("change-verification-fixed");
    await fs.writeFile(path.join(repository, "old.txt"), "old\n");
    await git(repository, ["add", "old.txt"]);
    await git(repository, ["commit", "-m", "baseline failure"]);
    workspace.baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await fs.rm(path.join(repository, "old.txt"));
    const source =
      'const fs=require("fs"); if(fs.existsSync("old.txt")){console.error("old failure");process.exit(1)}';
    const { state } = await run({
      originatingWorkflow: "autoimplement",
      qualifiedNode: "localVerification",
      workspace,
      checks: [check(repository, source)],
    });
    expect(state.finalOutput).toMatchObject({
      route: "ready",
      fixedBaselineFailures: [{ checkId: "docs" }],
    });
  });

  it("keeps missing, timed-out, and truncated evidence unknown", async () => {
    const workspace: PreparedWorkspace = {
      schema: PREPARED_WORKSPACE_SCHEMA,
      mode: "branch",
      repository: "/candidate",
      baseBranch: "main",
      baseRevision: "abc",
      workBranch: "feat/x",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: [],
      scope: "Only /candidate",
    };
    const candidate = result("docs", "timedOut", "partial");
    candidate.stdoutTruncated = true;
    const classified = classifyVerification(
      {
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [check("/candidate", "")],
      },
      {
        checks: [check("/candidate", "")],
        candidate: batch([candidate]),
        base: batch([]),
        baseEvidence: ["unavailable"],
        cleanupEvidence: [],
        repairAttempts: [],
      },
    );
    expect(classified.route).toBe("needsJudgment");
    expect(classified.unknownFailures).toHaveLength(1);
  });

  it("runs an allowlisted mechanical fix, checks its file boundary, and rechecks", async () => {
    const { repository, workspace } = await fixture("change-verification-mechanical");
    await fs.writeFile(path.join(repository, "doc.txt"), "good\n");
    await git(repository, ["add", "doc.txt"]);
    await git(repository, ["commit", "-m", "good baseline"]);
    workspace.baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "doc.txt"), "bad\n");
    const source =
      'const fs=require("fs"); if(fs.readFileSync("doc.txt","utf8").trim()!=="good"){console.error("bad format");process.exit(1)}';
    const fixer = 'require("fs").writeFileSync("doc.txt","good\\n")';
    const { state } = await run({
      originatingWorkflow: "autodoc",
      qualifiedNode: "verify",
      workspace,
      checks: [
        check(repository, source, {
          command: process.execPath,
          args: ["-e", fixer],
          files: ["doc.txt"],
          timeoutMs: 10_000,
          maxOutputChars: 100_000,
          expectedDiff: "doc.txt formatted",
        }),
      ],
      changedFiles: ["doc.txt"],
    });
    expect(state.finalOutput).toMatchObject({
      route: "ready",
      repairAttempts: [{ kind: "mechanical" }],
    });
    await expect(fs.readFile(path.join(repository, "doc.txt"), "utf8")).resolves.toBe("good\n");
  });

  it("normalizes finding order through stable JSON ids", () => {
    const workspace: PreparedWorkspace = {
      schema: PREPARED_WORKSPACE_SCHEMA,
      mode: "branch",
      repository: "/candidate",
      baseBranch: "main",
      baseRevision: "abc",
      workBranch: "feat/x",
      directDefaultBranchAuthorized: false,
      preExistingChangedPaths: [],
      evidence: [],
      scope: "Only /candidate",
    };
    const jsonCheck = { ...check("/candidate", ""), findingFormat: "json" as const };
    const candidate = result("docs", "failed", JSON.stringify([{ id: "b" }, { id: "a" }]));
    const baseResult = result(
      "docs",
      "failed",
      JSON.stringify([{ id: "a" }, { id: "b" }]),
      "/tmp/base",
    );
    const classified = classifyVerification(
      { originatingWorkflow: "autodoc", qualifiedNode: "verify", workspace, checks: [jsonCheck] },
      {
        checks: [jsonCheck],
        candidate: batch([candidate]),
        base: batch([baseResult]),
        baseEvidence: [],
        cleanupEvidence: [],
        repairAttempts: [],
      },
    );
    expect(classified.route).toBe("ready");
    expect(classified.unrelatedFailures).toHaveLength(1);
  });
});
