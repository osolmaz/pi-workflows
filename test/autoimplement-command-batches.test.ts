import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAutoimplementConcurrency,
  parseCiCommand,
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
    expect(
      parsePublishedRepositories({
        repositories: [
          {
            repository,
            branch: "feat/demo",
            baseBranch: "main",
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            pushed: true,
            dependencyFingerprint: "sha256:dependency",
          },
        ],
      }).repositories[0],
    ).toMatchObject({ dependencyFingerprint: "sha256:dependency" });
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
    expect(() => parsePublishedRepositories({ repositories: [] })).toThrow(/non-empty/);
    expect(() =>
      parsePublishedRepositories({
        repositories: Array.from({ length: 65 }, (_, index) => ({
          ...record,
          repository: path.join(repository, String(index)),
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parsePublishedRepositories({ repositories: [{ ...record, repository: "relative" }] }),
    ).toThrow(/absolute/);
    expect(() =>
      parsePublishedRepositories({
        repositories: [{ ...record, dependencyFingerprint: 1 }],
      }),
    ).toThrow(/non-empty string/);
  });

  it("accepts multiple verification commands per cwd and rejects mutation commands", async () => {
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
    expect(() => parseVerificationCommandPlan({ commands: [] })).toThrow(/non-empty/);
    expect(
      parseVerificationCommandPlan({
        commands: [command("one", first), command("two", first)],
      }),
    ).toMatchObject({
      commands: [
        { id: "one", cwd: first },
        { id: "two", cwd: first },
      ],
    });
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
    expect(() =>
      parseVerificationCommandPlan({
        commands: [command("verify", first), command("verify", second)],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseVerificationCommandPlan({ commands: [command("invalid id", first)] }),
    ).toThrow(/id is invalid/);
    expect(() =>
      parseVerificationCommandPlan({
        commands: Array.from({ length: 65 }, (_, index) =>
          command(`verify-${index}`, path.join(first, String(index))),
        ),
      }),
    ).toThrow(/at most 64/);
  });

  it("normalizes per-PR CI state and validates pending watch commands", async () => {
    const repository = await makeTempDir("ci-target");
    const id = repositoryId(repository);
    const pr = "https://example.test/pr/1";
    const parsed = parseCiInspectionBatch({
      targets: [
        {
          repository,
          headRevision: "abc123",
          pr,
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
    expect(parsed).toMatchObject({
      route: "pending",
      targets: [
        {
          id,
          route: "pending",
          trackingCommand: { args: ["pr", "checks", pr, "--watch"] },
        },
      ],
    });
    for (const route of ["green", "failed", "unavailable"] as const) {
      expect(
        parseCiInspectionBatch({
          targets: [
            {
              repository,
              headRevision: "abc123",
              pr: "https://example.test/pr/1",
              route,
              reason: route,
            },
          ],
        }).route,
      ).toBe(route);
    }
    expect(() => parseCiInspectionBatch({ targets: [] })).toThrow(/non-empty/);
    expect(() =>
      parseCiInspectionBatch({
        targets: Array.from({ length: 65 }, (_, index) => ({
          repository: path.join(repository, String(index)),
          headRevision: "abc123",
          pr: `https://example.test/pr/${index}`,
          route: "green",
          reason: "green",
        })),
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "green",
            reason: "green",
          },
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "green",
            reason: "green",
          },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseCiInspectionBatch({
        targets: [
          {
            repository,
            headRevision: "abc123",
            pr: "https://example.test/pr/1",
            route: "unknown",
            reason: "unknown",
          },
        ],
      }),
    ).toThrow(/route is invalid/);
    const command = {
      id,
      command: "gh",
      args: ["pr", "checks", "--watch"],
      cwd: repository,
      timeoutMs: 300_000,
      maxOutputChars: 100_000,
    };
    expect(
      parseCiCommand({ ...command, args: ["run", "watch", "123"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    expect(
      parseCiCommand({ ...command, args: ["pr", "checks", pr, "--watch"] }, id, repository, pr),
    ).toMatchObject({
      args: ["pr", "checks", pr, "--watch"],
    });
    for (const invalid of [
      { ...command, id: "wrong" },
      { ...command, command: "git" },
      { ...command, args: "bad" },
      { ...command, cwd: path.join(repository, "other") },
      { ...command, timeoutMs: 0 },
      { ...command, maxOutputChars: 0 },
      { ...command, args: ["pr", "merge"] },
      { ...command, args: ["pr", "checks", "https://example.test/pr/2", "--watch"] },
      { ...command, args: ["pr", "checks", pr, "--watch", "--repo", "other/repo"] },
      { ...command, args: ["run", "watch", "123", "--repo", "other/repo"] },
    ]) {
      expect(() => parseCiCommand(invalid, id, repository, pr)).toThrow();
    }
  });
});
