import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parsePiJsonOutput,
  resolvePiInvocation,
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

  it("formats a bounded final report with evidence and no presentation turn", () => {
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
    expect(formatSanityCheckReport({ ...result, summary: "x".repeat(20_000) })).toContain(
      "[report truncated]",
    );
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

describe("isolated sanity-check sessions", () => {
  it("validates request identities and prompt bounds before spawning", async () => {
    const signal = new AbortController().signal;
    await expect(runIsolatedReviewSessions([], process.cwd(), signal)).resolves.toEqual({});
    await expect(
      runIsolatedReviewSessions([{ id: "bad id", prompt: "x" }], process.cwd(), signal),
    ).rejects.toThrow(/Invalid isolated review id/);
    await expect(
      runIsolatedReviewSessions(
        [
          { id: "same", prompt: "x" },
          { id: "same", prompt: "y" },
        ],
        process.cwd(),
        signal,
      ),
    ).rejects.toThrow(/Duplicate isolated review id/);
    await expect(
      runIsolatedReviewSessions(
        [{ id: "large", prompt: "x".repeat(96_001) }],
        process.cwd(),
        signal,
      ),
    ).rejects.toThrow(/exceeds 96000 characters/);
    expect(resolvePiInvocation()).toEqual({ command: "pi", prefixArgs: [] });

    const originalArgv = [...process.argv];
    try {
      process.argv.splice(
        0,
        process.argv.length,
        "node",
        "/tmp/pi",
        "--offline",
        "--provider",
        "mock",
        "--model",
        "mock-model",
        "--thinking",
        "high",
        "--ignored",
      );
      expect(resolvePiInvocation()).toEqual({
        command: process.execPath,
        prefixArgs: [
          "/tmp/pi",
          "--offline",
          "--provider",
          "mock",
          "--model",
          "mock-model",
          "--thinking",
          "high",
        ],
      });
      process.argv.splice(0, process.argv.length, "node", "/tmp/pi", "--provider");
      expect(resolvePiInvocation()).toEqual({ command: process.execPath, prefixArgs: ["/tmp/pi"] });
      process.argv.splice(
        0,
        process.argv.length,
        "node",
        path.join("/tmp", "pi-coding-agent", "dist", "cli.js"),
        "--offline",
      );
      expect(resolvePiInvocation()).toEqual({
        command: process.execPath,
        prefixArgs: [path.join("/tmp", "pi-coding-agent", "dist", "cli.js"), "--offline"],
      });
      process.argv.splice(0, process.argv.length, "node", "/tmp/other-package/cli.js");
      expect(resolvePiInvocation()).toEqual({ command: "pi", prefixArgs: [] });
      process.argv.splice(0, process.argv.length, "node", "/$bunfs/root/pi");
      expect(resolvePiInvocation()).toEqual({ command: "pi", prefixArgs: [] });
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

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
    expect(
      parsePiJsonOutput(
        [
          JSON.stringify({ type: "message_end", message: null }),
          JSON.stringify({ type: "message_end", message: [] }),
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "image" }, { type: "text", text: '{"answer":41}' }],
              stopReason: "stop",
            },
          }),
        ].join("\n"),
      ),
    ).toEqual({ answer: 41 });
    expect(
      parsePiJsonOutput(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: '{"answer":43}', stopReason: "stop" },
        })}\n`,
      ),
    ).toEqual({ answer: 43 });
    expect(() => parsePiJsonOutput("noise\n")).toThrow(/no assistant JSON/);
    expect(() =>
      parsePiJsonOutput(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
        })}\n`,
      ),
    ).toThrow(/provider failed/);
    expect(() =>
      parsePiJsonOutput(
        `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "aborted" },
        })}\n`,
      ),
    ).toThrow(/stopped with aborted/);
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
      {
        invocation: { command: process.execPath, prefixArgs: ["-e", script, "--"] },
        timeoutMs: 10_000,
        maxOutputChars: 100_000,
        maxConcurrency: 1,
      },
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
        "--no-context-files",
        "--tools",
        "read,grep,find,ls",
      ]),
    );
    expect(first.args).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
    const promptArg = first.args.find((arg) => arg.startsWith("@"));
    expect(promptArg).toBeDefined();
    await expect(fs.stat((promptArg as string).slice(1))).rejects.toThrow();
  });

  it("fails clearly for child process and output errors", async () => {
    await expect(
      runIsolatedReviewSessions(
        [{ id: "failed", prompt: "fail" }],
        process.cwd(),
        new AbortController().signal,
        {
          invocation: {
            command: process.execPath,
            prefixArgs: ["-e", "process.stderr.write('failed'); process.exit(2)", "--"],
          },
        },
      ),
    ).rejects.toThrow(/failed/);

    const verbose = "process.stdout.write('x'.repeat(1000));";
    await expect(
      runIsolatedReviewSessions(
        [{ id: "verbose", prompt: "verbose" }],
        process.cwd(),
        new AbortController().signal,
        {
          invocation: { command: process.execPath, prefixArgs: ["-e", verbose, "--"] },
          maxOutputChars: 100,
        },
      ),
    ).rejects.toThrow(/exceeded its output limit/);

    const invalid =
      "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'not JSON'}],stopReason:'stop'}})+'\\n');";
    await expect(
      runIsolatedReviewSessions(
        [{ id: "invalid", prompt: "invalid" }],
        process.cwd(),
        new AbortController().signal,
        { invocation: { command: process.execPath, prefixArgs: ["-e", invalid, "--"] } },
      ),
    ).rejects.toThrow(/invalid output/);
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
