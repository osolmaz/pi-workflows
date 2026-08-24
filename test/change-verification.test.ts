import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  changeVerificationWorkflow,
  classifyVerification,
  parseChangeVerificationInput,
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
  it("validates direct command and comparison contracts", async () => {
    const { repository, workspace } = await fixture("change-verification-validation");
    const base = check(repository, "process.exit(0)");
    expect(() => parseChangeVerificationInput(null)).toThrow(/object/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [{ ...base, command: "bash" }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [{ ...base, command: "git", args: ["status"] }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [{ ...base, cwd: path.join(repository, "other") }],
      }),
    ).toThrow(/prepared workspace/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [{ ...base, readOnly: false, baseEligible: true }],
      }),
    ).toThrow(/readOnly/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [{ ...base, findingFormat: "xml" }],
      }),
    ).toThrow(/findingFormat/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [base, base],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: "bad",
      }),
    ).toThrow(/array/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [
          {
            ...base,
            mechanicalFix: {
              command: process.execPath,
              args: [],
              files: ["/outside"],
              timeoutMs: 1_000,
              maxOutputChars: 1_000,
              expectedDiff: "format",
            },
          },
        ],
      }),
    ).toThrow(/stay inside/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [
          {
            ...base,
            mechanicalFix: {
              command: "rm",
              args: ["doc.txt"],
              files: ["doc.txt"],
              timeoutMs: 1_000,
              maxOutputChars: 1_000,
              expectedDiff: "remove stale output",
            },
          },
        ],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseChangeVerificationInput({
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [base],
        maxConcurrency: 0,
      }),
    ).toThrow(/maxConcurrency/);
  });

  it("uses a bounded model command plan only when checks are not supplied", async () => {
    const { repository, workspace } = await fixture("change-verification-plan-checks");
    const executor = new ScriptedExecutor().respond("planChecks", {
      output: { checks: [check(repository, "process.exit(0)")] },
    });
    const { state } = await run(
      { originatingWorkflow: "autodoc", qualifiedNode: "verify", workspace },
      executor,
    );
    expect(state.finalOutput).toMatchObject({ route: "ready" });
    expect(executor.requests.map((request) => request.contract.nodeId)).toEqual(["planChecks"]);
  });

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

  it("does not reuse candidate dependencies when dependency inputs differ", async () => {
    const { repository, workspace } = await fixture("change-verification-dependencies");
    await fs.writeFile(path.join(repository, "package.json"), '{"dependencies":{"demo":"2"}}\n');
    await fs.mkdir(path.join(repository, "node_modules"));
    const executor = new ScriptedExecutor().respond("judge", {
      output: {
        route: "blocked",
        reason: "Equivalent base dependencies are unavailable.",
        evidence: ["The candidate dependency inputs differ from the base revision."],
      },
    });
    const { state } = await run(
      {
        originatingWorkflow: "autoimplement",
        qualifiedNode: "localVerification",
        workspace,
        checks: [check(repository, 'console.error("dependency failure"); process.exit(1)')],
      },
      executor,
    );
    expect(state.finalOutput).toMatchObject({
      route: "blocked",
      unrelatedFailures: [],
      unknownFailures: [{ checkId: "docs" }],
      evidence: [
        expect.stringContaining("Created detached base worktree"),
        expect.stringContaining("dependency inputs differ from the base revision"),
        expect.stringContaining("Removed detached base worktree"),
        "The candidate dependency inputs differ from the base revision.",
      ],
    });
  });

  it("reuses candidate dependencies only when dependency inputs match", async () => {
    const { repository, workspace } = await fixture("change-verification-matching-dependencies");
    await fs.writeFile(path.join(repository, "package.json"), '{"dependencies":{"demo":"1"}}\n');
    await git(repository, ["add", "package.json"]);
    await git(repository, ["commit", "-m", "add dependencies"]);
    workspace.baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await fs.mkdir(path.join(repository, "node_modules"));
    const { state } = await run({
      originatingWorkflow: "autoimplement",
      qualifiedNode: "localVerification",
      workspace,
      checks: [check(repository, 'console.error("existing failure"); process.exit(1)')],
    });
    expect(state.finalOutput).toMatchObject({
      route: "ready",
      unrelatedFailures: [{ checkId: "docs" }],
      evidence: [
        expect.stringContaining("Created detached base worktree"),
        expect.stringContaining("dependency inputs match the base revision"),
        expect.stringContaining("Removed detached base worktree"),
      ],
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
    expect(
      executor.requests.find((request) => request.contract.nodeId === "semanticRepair")?.prompt,
    ).toContain(`Authorized scope: ${workspace.scope}`);
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

  it("rejects a mechanical fixer that changes an undeclared pre-existing file", async () => {
    const { repository, workspace } = await fixture("change-verification-fixer-boundary");
    await fs.writeFile(path.join(repository, "doc.txt"), "good\n");
    await fs.writeFile(path.join(repository, "outside.txt"), "base\n");
    await git(repository, ["add", "doc.txt", "outside.txt"]);
    await git(repository, ["commit", "-m", "baseline"]);
    workspace.baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "doc.txt"), "bad\n");
    await fs.writeFile(path.join(repository, "outside.txt"), "user work\n");
    const source =
      'const fs=require("fs"); if(fs.readFileSync("doc.txt","utf8").trim()!=="good"){process.exit(1)}';
    const fixer =
      'const fs=require("fs"); fs.writeFileSync("doc.txt","good\\n"); fs.writeFileSync("outside.txt","overwritten\\n")';
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
      route: "blocked",
      unknownFailures: [
        {
          checkId: "mechanical-fix-boundary",
          summary: expect.stringContaining("outside.txt"),
        },
      ],
      repairAttempts: [
        {
          kind: "mechanical",
          result: expect.stringContaining("restored all undeclared paths"),
        },
      ],
    });
    await expect(fs.readFile(path.join(repository, "outside.txt"), "utf8")).resolves.toBe(
      "user work\n",
    );
    await expect(fs.readFile(path.join(repository, "doc.txt"), "utf8")).resolves.toBe("good\n");
  });

  it("restores every supported undeclared path state after a rejected fixer", async () => {
    const { repository, workspace } = await fixture("change-verification-fixer-restoration");
    await fs.writeFile(path.join(repository, "doc.txt"), "good\n");
    await fs.writeFile(path.join(repository, "outside.txt"), "base\n");
    await fs.writeFile(path.join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await fs.writeFile(path.join(repository, "deleted.txt"), "delete me\n");
    await git(repository, ["add", "doc.txt", "outside.txt", "executable.sh", "deleted.txt"]);
    await git(repository, ["commit", "-m", "restoration baseline"]);
    workspace.baseRevision = await git(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "doc.txt"), "bad\n");
    await fs.rm(path.join(repository, "deleted.txt"));
    await fs.symlink("outside.txt", path.join(repository, "outside-link.txt"));
    const source =
      'const fs=require("fs"); if(fs.readFileSync("doc.txt","utf8").trim()!=="good"){process.exit(1)}';
    const fixer = [
      'const fs=require("fs")',
      'fs.writeFileSync("doc.txt","good\\n")',
      'fs.writeFileSync("outside.txt","overwritten\\n")',
      'fs.writeFileSync("executable.sh","broken\\n")',
      'fs.chmodSync("executable.sh",0o644)',
      'fs.writeFileSync("created.txt","created\\n")',
      'fs.unlinkSync("outside-link.txt")',
      'fs.writeFileSync("outside-link.txt","not a link\\n")',
      'fs.writeFileSync("deleted.txt","recreated\\n")',
    ].join(";");
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
      route: "blocked",
      repairAttempts: [
        {
          result: expect.stringContaining("restored all undeclared paths"),
        },
      ],
    });
    await expect(fs.readFile(path.join(repository, "outside.txt"), "utf8")).resolves.toBe("base\n");
    await expect(fs.readFile(path.join(repository, "executable.sh"), "utf8")).resolves.toBe(
      "#!/bin/sh\nexit 0\n",
    );
    expect((await fs.stat(path.join(repository, "executable.sh"))).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(path.join(repository, "outside-link.txt"))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(repository, "outside-link.txt"))).toBe("outside.txt");
    await expect(fs.access(path.join(repository, "created.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(repository, "deleted.txt"))).rejects.toThrow();
    await expect(fs.readFile(path.join(repository, "doc.txt"), "utf8")).resolves.toBe("good\n");
  });

  it("classifies complete direct evidence across related and unknown routes", () => {
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
    const baseCheck = check("/candidate", "");
    const related = classifyVerification(
      {
        originatingWorkflow: "autoimplement",
        qualifiedNode: "verify",
        workspace,
        checks: [baseCheck],
      },
      {
        checks: [baseCheck],
        candidate: batch([result("docs", "failed", "candidate")]),
        base: batch([result("docs", "succeeded", "", "/base", 0)]),
        baseEvidence: [],
        cleanupEvidence: [],
        repairAttempts: [],
      },
    );
    expect(related).toMatchObject({ route: "repairable", relatedFailures: [{ checkId: "docs" }] });
    const different = classifyVerification(
      {
        originatingWorkflow: "autoimplement",
        qualifiedNode: "verify",
        workspace,
        checks: [baseCheck],
      },
      {
        checks: [baseCheck],
        candidate: batch([result("docs", "failed", "candidate")]),
        base: batch([result("docs", "failed", "base", "/base")]),
        baseEvidence: [],
        cleanupEvidence: ["Base worktree cleanup failed: busy"],
        repairAttempts: [],
      },
    );
    expect(different).toMatchObject({
      route: "needsJudgment",
      unknownFailures: expect.arrayContaining([
        expect.objectContaining({ checkId: "docs" }),
        expect.objectContaining({ checkId: "base-cleanup" }),
      ]),
    });
    const untested = classifyVerification(
      {
        originatingWorkflow: "autodoc",
        qualifiedNode: "verify",
        workspace,
        checks: [baseCheck],
        untested: ["privacy check unavailable"],
      },
      {
        checks: [baseCheck],
        candidate: batch([result("docs", "succeeded", "")]),
        base: batch([result("docs", "succeeded", "", "/base")]),
        baseEvidence: [],
        cleanupEvidence: [],
        repairAttempts: [],
      },
    );
    expect(untested).toMatchObject({
      route: "needsJudgment",
      untestedChecks: [{ kind: "untested" }],
    });
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
