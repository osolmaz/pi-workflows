import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAutoimplementConcurrency,
  parseCiInspectionBatch,
  parsePublishedRepositories,
  parseVerificationCommandPlan,
  repositoryId,
  reviewerCommand,
} from "../src/builtins/autoimplement-command-batches.js";
import { makeTempDir } from "./helpers.js";

describe("autoimplement command batch contracts", () => {
  it("normalizes bounded concurrency", () => {
    expect(parseAutoimplementConcurrency(undefined)).toEqual({
      reviewer: 4,
      ciWatch: 4,
      verification: 2,
    });
    expect(parseAutoimplementConcurrency({ reviewer: 1 })).toEqual({
      reviewer: 1,
      ciWatch: 4,
      verification: 2,
    });
    expect(() => parseAutoimplementConcurrency({ reviewer: 9 })).toThrow(/1 through 8/);
    expect(() => parseAutoimplementConcurrency({ unknown: 1 })).toThrow(/not supported/);
  });

  it("derives stable repository ids and reviewer commands from publication", async () => {
    const repository = await makeTempDir("published-repository");
    const parsed = parsePublishedRepositories({
      repositories: [
        {
          repository,
          branch: "feat/demo",
          baseBranch: "main",
          headRevision: "abc123",
          pr: "https://example.test/pr/1",
          pushed: true,
        },
      ],
    });
    expect(parsed.repositories[0]).toMatchObject({
      id: repositoryId(repository),
      repository: path.resolve(repository),
      headRevision: "abc123",
    });
    expect(reviewerCommand(parsed.repositories[0]!)).toEqual({
      id: repositoryId(repository),
      command: "pi-reviewer",
      args: ["--base", "main"],
      cwd: path.resolve(repository),
      timeoutMs: 600_000,
      maxOutputChars: 1_000_000,
    });
  });

  it("rejects duplicate or incomplete publication records", async () => {
    const repository = await makeTempDir("duplicate-publication");
    const record = {
      repository,
      branch: "feat/demo",
      baseBranch: "main",
      headRevision: "abc123",
      pr: "https://example.test/pr/1",
      pushed: true,
    };
    expect(() => parsePublishedRepositories({ repositories: [record, record] })).toThrow(
      /duplicated/,
    );
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, pushed: false }] }),
    ).toThrow(/pushed must be true/);
  });

  it("accepts independent verification and rejects duplicate cwd or mutation commands", async () => {
    const first = await makeTempDir("verification-one");
    const second = await makeTempDir("verification-two");
    const command = (id: string, cwd: string) => ({
      id,
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd,
      timeoutMs: 60_000,
      maxOutputChars: 100_000,
    });
    expect(
      parseVerificationCommandPlan({
        commands: [command("one", first), command("two", second)],
        untested: [],
      }),
    ).toMatchObject({ commands: [{ id: "one" }, { id: "two" }] });
    expect(() =>
      parseVerificationCommandPlan({ commands: [command("one", first), command("two", first)] }),
    ).toThrow(/distinct working directories/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), command: "git", args: ["push"] }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: [{ ...command("bad", first), command: "npm", args: ["publish"] }],
      }),
    ).toThrow(/mutation or publication/);
    for (const wrapper of ["dash", "cmd.exe", "C:\\Windows\\System32\\PowerShell.exe"]) {
      expect(() =>
        parseVerificationCommandPlan({
          commands: [{ ...command("wrapper", first), command: wrapper, args: ["-c", "git push"] }],
        }),
      ).toThrow(/not allowed/);
    }
  });

  it("normalizes per-PR CI state and validates pending watch commands", async () => {
    const repository = await makeTempDir("ci-target");
    const id = repositoryId(repository);
    const parsed = parseCiInspectionBatch({
      targets: [
        {
          repository,
          headRevision: "abc123",
          pr: "https://example.test/pr/1",
          route: "pending",
          reason: "running",
          relatedFailures: [],
          unrelatedFailures: [],
          trackingCommand: {
            id,
            command: "gh",
            args: ["pr", "checks", "--watch"],
            cwd: repository,
            timeoutMs: 300_000,
            maxOutputChars: 100_000,
          },
        },
      ],
    });
    expect(parsed).toMatchObject({ route: "pending", targets: [{ id, route: "pending" }] });
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "pending",
            reason: "running",
            trackingCommand: {
              id,
              command: "gh",
              args: ["pr", "merge"],
              cwd: repository,
              timeoutMs: 1,
            },
          },
        ],
      }),
    ).toThrow(/not allowed/);
  });
});
