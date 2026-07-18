import { describe, expect, it } from "vitest";
import { TimeoutError } from "../src/workflows/errors.js";
import { renderShellCommand, runShellAction } from "../src/workflows/shell.js";

describe("renderShellCommand", () => {
  it("renders commands with quoted args", () => {
    expect(renderShellCommand("git", ["status", "--short"])).toBe('git "status" "--short"');
    expect(renderShellCommand("ls", [])).toBe("ls");
  });
});

describe("runShellAction", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", "printf out; printf err >&2"],
    });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes stdin, env, and cwd", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", 'cat; printf %s "$MARKER"; pwd'],
      stdin: "piped|",
      env: { MARKER: "-mark-" },
      cwd: "/tmp",
    });
    expect(result.stdout).toContain("piped|-mark-");
    expect(result.stdout.trimEnd().endsWith("/tmp")).toBe(true);
  });

  it("rejects on non-zero exit unless allowed", async () => {
    await expect(runShellAction({ command: "sh", args: ["-c", "exit 3"] })).rejects.toThrow(
      /exit 3/,
    );
    const tolerated = await runShellAction({
      command: "sh",
      args: ["-c", "exit 3"],
      allowNonZeroExit: true,
    });
    expect(tolerated.exitCode).toBe(3);
  });

  it("times out long-running commands", async () => {
    await expect(runShellAction({ command: "sleep", args: ["5"], timeoutMs: 100 })).rejects.toThrow(
      TimeoutError,
    );
  });
});
