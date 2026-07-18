import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCliArgs } from "../src/viewer/cli.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function makeCompletedRun(outputRoot: string): Promise<string> {
  const workflow = defineWorkflow({
    name: "cli-demo",
    startAt: "one",
    nodes: { one: compute({ run: () => ({ ok: true }) }) },
    edges: [],
  });
  const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });
  const { state } = await engine.run(workflow, {});
  return state.runId;
}

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCliArgs", () => {
  it("defaults to view with the standard runs dir", () => {
    const args = parseCliArgs([]);
    expect(args.command).toBe("view");
    expect(args.dir).toContain(path.join(".pi", "agent", "workflows", "runs"));
    expect(args.once).toBe(false);
  });

  it("parses command, run id, dir, and once", () => {
    const args = parseCliArgs(["view", "run-123", "--dir", "/tmp/runs", "--once"]);
    expect(args).toEqual({ command: "view", runId: "run-123", dir: "/tmp/runs", once: true });
  });

  it("parses runs command and help", () => {
    expect(parseCliArgs(["runs"]).command).toBe("runs");
    expect(parseCliArgs(["--help"]).command).toBe("help");
  });

  it("rejects unknown flags and missing --dir values", () => {
    expect(() => parseCliArgs(["view", "--nope"])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(["view", "--dir"])).toThrow(/--dir requires/);
  });
});

describe("pi-workflows CLI", () => {
  it("prints usage for help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout).toContain("pi-workflows — live terminal viewer");
  });

  it("lists runs", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    const runId = await makeCompletedRun(outputRoot);
    expect(await main(["runs", "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain(runId);
    expect(stdout).toContain("completed");
  });

  it("reports an empty runs dir", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    expect(await main(["runs", "--dir", outputRoot])).toBe(0);
    expect(stdout).toContain("No workflow runs found");
  });

  it("renders a run detail snapshot with --once", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    const runId = await makeCompletedRun(outputRoot);
    expect(await main(["view", runId, "--dir", outputRoot, "--once"])).toBe(0);
    expect(stdout).toContain("workflow cli-demo");
    expect(stdout).toContain("one [compute]");
  });

  it("renders the run list with --once and no run id", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    await makeCompletedRun(outputRoot);
    expect(await main(["view", "--dir", outputRoot, "--once"])).toBe(0);
    expect(stdout).toContain("pi-workflows — runs");
  });

  it("fails cleanly for unknown runs, bad args, and unknown commands", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    expect(await main(["view", "nope", "--dir", outputRoot, "--once"])).toBe(1);
    expect(stderr).toContain("Run not found");

    expect(await main(["view", "--bogus"])).toBe(2);
    expect(stderr).toContain("Unknown argument");

    expect(await main(["frobnicate"])).toBe(2);
    expect(stderr).toContain("Unknown command");
  });
});
