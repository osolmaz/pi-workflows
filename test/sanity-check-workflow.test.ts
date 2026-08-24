import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import sanityCheckWorkflow, {
  buildDetailedSanityCheckPrompt,
  buildReviewRequests,
  buildSanityCheckSummaryInput,
  buildVerificationRequest,
  collectContributionEvidence,
  formatSanityCheckReport,
  parseAgentJsonOutput,
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

describe("sanity-check workflow", () => {
  it("bounds malformed agent output errors without retaining model text", () => {
    const privateOutput = `PRIVATE_REPOSITORY_TEXT_${"x".repeat(100_000)}`;
    let error: unknown;
    try {
      parseAgentJsonOutput(privateOutput, "necessity");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Sanity Check agent necessity returned invalid JSON");
    expect((error as Error).message).not.toContain("PRIVATE_REPOSITORY_TEXT");
  });

  it("defaults to serial mode and validates input", () => {
    expect(parseSanityCheckInput(undefined)).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput(null)).toEqual({ mode: "serial" });
    expect(parseSanityCheckInput({})).toEqual({ mode: "serial" });
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
    expect(() => parseSanityCheckInput({ baseRef: 42 })).toThrow(/non-empty string/);
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

  it("bounds serialized evidence and review results below the session prompt limit", () => {
    const largeEvidence: ContributionEvidence = {
      ...evidence(),
      pullRequest: { available: true, data: { body: "x".repeat(200_000) } },
    };
    const reviewRequest = buildReviewRequests("serial", largeEvidence)[0];
    expect(reviewRequest?.prompt.length).toBeLessThan(96_000);
    expect(reviewRequest?.prompt).toContain("[input truncated]");

    const largeReview = { ...review(), acceptanceCase: "x".repeat(200_000) };
    const verification = buildVerificationRequest(largeEvidence, [largeReview]);
    expect(verification.prompt.length).toBeLessThan(96_000);
    expect(verification.prompt).toContain("[input truncated]");
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
    expect(
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [
            {
              ...areaResult("necessity"),
              assessment: "unclear",
              evidence: [],
              alternative: "Ask for the missing requirement.",
            },
          ],
        },
        ["necessity"],
      ).areas[0],
    ).toMatchObject({ assessment: "unclear", alternative: "Ask for the missing requirement." });

    for (const verdict of ["keep", "simplify", "refactor", "drop", "needs_evidence"] as const) {
      expect(parseSanityCheckResult(finalResult(verdict)).verdict).toBe(verdict);
    }
    expect(() => parseSanityCheckResult({ ...finalResult("keep"), verdict: "approve" })).toThrow(
      /verdict/,
    );
    expect(() => parseReviewOutput(null, areas)).toThrow(/must be an object/);
    expect(() =>
      parseReviewOutput(
        { ...review(["necessity"]), areas: [{ ...areaResult("necessity"), area: "bad" }] },
        ["necessity"],
      ),
    ).toThrow(/area is invalid/);
    expect(() =>
      parseReviewOutput(
        {
          ...review(["necessity"]),
          areas: [{ ...areaResult("necessity"), assessment: "maybe" }],
        },
        ["necessity"],
      ),
    ).toThrow(/assessment must be/);
    expect(() => parseReviewOutput({ ...review(), questions: "none" }, areas)).toThrow(
      /must be an array/,
    );
    expect(() =>
      parseReviewOutput({ ...review(), unknowns: Array.from({ length: 41 }, () => "x") }, areas),
    ).toThrow(/at most 40/);
  });

  it("shows the full report before a composed plain summary", () => {
    const result = parseSanityCheckResult(finalResult("keep"));
    const report = formatSanityCheckReport(result);
    expect(report).toContain("Sanity Check: keep");
    expect(report).toContain("src/a.ts :: feature");
    const detailed = formatSanityCheckReport({
      ...result,
      findings: [
        { ...result.findings[0]!, alternative: "Use the existing helper." },
        ...result.findings.slice(1),
      ],
      requiredChanges: ["Add the missing test."],
      questionsForContributor: ["Which user needs this?"],
      unknowns: ["Product intent is not recorded."],
    });
    expect(detailed).toContain("Alternative: Use the existing helper.");
    expect(detailed).toContain("Required changes:");
    expect(detailed).toContain("Questions for the contributor:");
    expect(detailed).toContain("Unknowns:");
    const longSummary = "x".repeat(20_000);
    const complete = formatSanityCheckReport({ ...result, summary: longSummary });
    expect(complete).toContain(longSummary);
    expect(complete).not.toContain("[report truncated]");

    const prompt = buildDetailedSanityCheckPrompt(result);
    expect(prompt).toContain("Reply with the report below verbatim");
    expect(prompt).toContain(report);
    const summary = buildSanityCheckSummaryInput(result, report);
    expect(summary).toMatchObject({
      source: { verdict: "keep", detailedReport: report },
      mustInclude: ["Verdict: keep"],
      maxChars: 2_000,
      maxSentences: 5,
      format: "mixed",
    });
    expect(() => buildSanityCheckSummaryInput(result, "A changed report")).toThrow(
      /did not match the verified report/,
    );

    expect(sanityCheckWorkflow.presentationPrompt).toBeUndefined();
    expect(sanityCheckWorkflow.maxSteps).toBe(8);
    expect(sanityCheckWorkflow.nodes.detailedReport).toMatchObject({
      nodeType: "agent",
      expectedOutput: { kind: "assistant-message" },
    });
    expect(sanityCheckWorkflow.nodes.detailedReport.expectedOutput).not.toHaveProperty("maxChars");
    expect(Object.keys(sanityCheckWorkflow.includes ?? {})).toEqual(["plainSummary"]);
    expect(sanityCheckWorkflow.nodes.finish).toMatchObject({ nodeType: "compute" });
    expect(sanityCheckWorkflow.edges).toEqual([
      { from: "prepare", to: "collectEvidence" },
      { from: "collectEvidence", to: "review" },
      { from: "review", to: "verify" },
      { from: "verify", to: "detailedReport" },
      { from: "detailedReport", to: "plainSummary" },
      { from: "plainSummary.completed", to: "finish" },
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
      await fs.writeFile(
        path.join(dir, "sample.txt"),
        `base\n${"working\n".repeat(2_000)}`,
        "utf8",
      );

      const result = await collectContributionEvidence(
        { mode: "serial", baseRef: stdout.trim() },
        dir,
        new AbortController().signal,
      );
      expect(result.repository).toBe(dir);
      expect(result.baseRef).toBe(stdout.trim());
      expect(result.committed.diff.text).toBe("");
      expect(result.workingTree.diff.text).toContain("+working");
      expect(result.workingTree.diff.truncated).toBe(true);
      expect(result.workingTree.status.text).toContain("sample.txt");
      expect(result.pullRequest.available).toBe(false);

      const defaultBase = await collectContributionEvidence(
        { mode: "serial" },
        dir,
        new AbortController().signal,
      );
      expect(defaultBase.baseRef).toBe(stdout.trim());
      expect(defaultBase.workingTree.diff.truncated).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
