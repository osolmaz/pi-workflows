import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parsePiJsonOutput,
  runIsolatedReviewSessions,
} from "../src/builtins/sanity-check-session.js";
import sanityCheckWorkflow, {
  buildReviewRequests,
  buildVerificationRequest,
  collectContributionEvidence,
  formatSanityCheckReport,
  parseReviewOutput,
  parseSanityCheckInput,
  parseSanityCheckResult,
  type ContributionEvidence,
  type SanityCheckArea,
  type SanityCheckReview,
  type SanityCheckVerdict,
} from "../src/builtins/sanity-check.workflow.js";

const execFileAsync = promisify(execFile);
const areas: SanityCheckArea[] = ["necessity", "duplication", "contracts", "scope_tests"];

function evidence(): ContributionEvidence {
  return {
    repository: "/tmp/repository",
    baseRef: "origin/main",
    headRevision: "abc123",
    pullRequest: { available: true, data: { title: "Change" } },
    committed: {
      stat: { text: "1 file changed", truncated: false },
      files: { text: "M\tsrc/a.ts", truncated: false },
      diff: { text: "+change", truncated: false },
    },
    workingTree: {
      status: { text: "", truncated: false },
      stat: { text: "", truncated: false },
      files: { text: "", truncated: false },
      diff: { text: "", truncated: false },
      untracked: { text: "", truncated: false },
    },
  };
}

function areaResult(area: SanityCheckArea) {
  return {
    area,
    assessment: "pass" as const,
    summary: `${area} is supported`,
    evidence: [{ path: "src/a.ts", symbol: "feature", detail: "direct evidence" }],
  };
}

function review(reviewAreas = areas): SanityCheckReview {
  return {
    areas: reviewAreas.map(areaResult),
    acceptanceCase: "The implementation directly satisfies the requirement.",
    questions: [],
    unknowns: [],
  };
}

function finalResult(verdict: SanityCheckVerdict) {
  return {
    verdict,
    summary: "The change is supported.",
    findings: areas.map(areaResult),
    requiredChanges: [],
    questionsForContributor: [],
    unknowns: [],
  };
}

function fakePiScript(body: string): string {
  return [
    body,
    "const text = JSON.stringify(result);",
    "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}})+'\\n');",
  ].join("\n");
}

describe("sanity-check workflow", () => {
  it("defaults to serial mode and validates input", () => {
    expect(parseSanityCheckInput(undefined)).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput({ baseRef: "origin/main" })).toEqual({
      mode: "serial",
      baseRef: "origin/main",
    });
    expect(parseSanityCheckInput({ mode: "parallel", baseRef: "main" })).toEqual({
      mode: "parallel",
      baseRef: "main",
    });
    expect(() => parseSanityCheckInput({ mode: "fast" })).toThrow(/serial or parallel/);
    expect(() => parseSanityCheckInput({ baseRef: "--output=x" })).toThrow(/plain Git reference/);
    expect(() => parseSanityCheckInput({ extra: true })).toThrow(/not supported/);
  });

  it("uses one complete review in serial mode and four focused reviews in parallel mode", () => {
    const serial = buildReviewRequests("serial", evidence());
    expect(serial).toHaveLength(1);
    for (const area of areas) expect(serial[0]?.prompt).toContain(area);
    expect(serial[0]?.prompt).toContain("strongest evidence-based case for accepting");
    expect(serial[0]?.prompt).toContain("exact file and symbol evidence");

    const parallel = buildReviewRequests("parallel", evidence());
    expect(parallel.map((request) => request.id)).toEqual(areas);
    for (const request of parallel) {
      expect(request.prompt).toContain(`Review areas: ${request.id}.`);
      expect(request.prompt).toContain("strongest evidence-based case for accepting");
    }
  });

  it("builds one verification session that removes unsupported claims", () => {
    const request = buildVerificationRequest(evidence(), [review()]);
    expect(request.id).toBe("verification");
    expect(request.prompt).toContain("Remove unsupported claims");
    expect(request.prompt).toContain("exact file and symbol");
    expect(request.prompt).toContain("Resolve conflicts");
    for (const verdict of ["keep", "simplify", "refactor", "drop", "needs_evidence"]) {
      expect(request.prompt).toContain(verdict);
    }
  });

  it("validates review coverage, acceptance cases, evidence, and every final verdict", () => {
    expect(parseReviewOutput(review(), areas)).toEqual(review());
    expect(() => parseReviewOutput({ ...review(), acceptanceCase: "" }, areas)).toThrow(
      /acceptanceCase/,
    );
    expect(() =>
      parseReviewOutput({ ...review(), areas: [areaResult("necessity")] }, areas),
    ).toThrow(/each requested area/);
    expect(() =>
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [{ ...areaResult("necessity"), evidence: [] }],
        },
        ["necessity"],
      ),
    ).toThrow(/requires evidence/);

    for (const verdict of ["keep", "simplify", "refactor", "drop", "needs_evidence"] as const) {
      expect(parseSanityCheckResult(finalResult(verdict)).verdict).toBe(verdict);
    }
    expect(() => parseSanityCheckResult({ ...finalResult("keep"), verdict: "approve" })).toThrow(
      /verdict/,
    );
  });

  it("formats a bounded final report with evidence and no presentation turn", () => {
    const result = parseSanityCheckResult(finalResult("keep"));
    const report = formatSanityCheckReport(result);
    expect(report).toContain("Sanity Check: keep");
    expect(report).toContain("src/a.ts :: feature");
    expect(sanityCheckWorkflow.presentationPrompt).toBeUndefined();
    expect(sanityCheckWorkflow.nodes.report).toMatchObject({ nodeType: "notify", kind: "final" });
    expect(sanityCheckWorkflow.edges).toEqual([
      { from: "prepare", to: "collectEvidence" },
      { from: "collectEvidence", to: "review" },
      { from: "review", to: "verify" },
      { from: "verify", to: "report" },
    ]);
  });

  it("collects committed and working-tree evidence with fixed Git commands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sanity-evidence-"));
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: dir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      await fs.writeFile(path.join(dir, "sample.txt"), "base\n", "utf8");
      await execFileAsync("git", ["add", "sample.txt"], { cwd: dir });
      await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      await fs.writeFile(path.join(dir, "sample.txt"), "base\nworking\n", "utf8");

      const result = await collectContributionEvidence(
        { mode: "serial", baseRef: stdout.trim() },
        dir,
        new AbortController().signal,
      );
      expect(result.repository).toBe(dir);
      expect(result.baseRef).toBe(stdout.trim());
      expect(result.committed.diff.text).toBe("");
      expect(result.workingTree.diff.text).toContain("+working");
      expect(result.workingTree.status.text).toContain("sample.txt");
      expect(result.pullRequest.available).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("isolated sanity-check sessions", () => {
  it("parses the final assistant JSON and rejects missing or failed output", () => {
    const output = `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: 'prefix {"answer":42}' }],
        stopReason: "stop",
      },
    })}\n`;
    expect(parsePiJsonOutput(output)).toEqual({ answer: 42 });
    expect(() => parsePiJsonOutput("noise\n")).toThrow(/no assistant JSON/);
    expect(() =>
      parsePiJsonOutput(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
        })}\n`,
      ),
    ).toThrow(/provider failed/);
  });

  it("starts temporary read-only sessions and removes their prompt files", async () => {
    const script = fakePiScript("const result = {args: process.argv.slice(1)};");
    const outputs = await runIsolatedReviewSessions(
      [
        { id: "first", prompt: "first prompt" },
        { id: "second", prompt: "second prompt" },
      ],
      process.cwd(),
      new AbortController().signal,
      { invocation: { command: process.execPath, prefixArgs: ["-e", script, "--"] } },
    );
    const first = outputs.first as { args: string[] };
    expect(Object.keys(outputs)).toEqual(["first", "second"]);
    expect(first.args).toEqual(
      expect.arrayContaining([
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--tools",
        "read,grep,find,ls",
      ]),
    );
    expect(first.args).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
    const promptArg = first.args.find((arg) => arg.startsWith("@"));
    expect(promptArg).toBeDefined();
    await expect(fs.stat((promptArg as string).slice(1))).rejects.toThrow();
  });

  it("fails clearly when a child times out", async () => {
    const script = "setTimeout(() => {}, 10000);";
    await expect(
      runIsolatedReviewSessions(
        [{ id: "slow", prompt: "wait" }],
        process.cwd(),
        new AbortController().signal,
        {
          invocation: { command: process.execPath, prefixArgs: ["-e", script, "--"] },
          timeoutMs: 20,
        },
      ),
    ).rejects.toThrow(/timedOut/);
  });
});
