import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
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
    expect(args).toMatchObject({
      command: "view",
      runId: "run-123",
      dir: "/tmp/runs",
      once: true,
    });
  });

  it("parses runs, controller, and help commands", () => {
    expect(parseCliArgs(["runs"]).command).toBe("runs");
    expect(
      parseCliArgs([
        "controller",
        "pull-request",
        "repo#1",
        "--controller-dir",
        "/tmp/controllers",
      ]),
    ).toMatchObject({
      command: "controller",
      controllerName: "pull-request",
      resourceKey: "repo#1",
      controllerDir: "/tmp/controllers",
    });
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(parseCliArgs(["herdr", "setup"])).toMatchObject({
      command: "herdr",
      herdrAction: "setup",
    });
  });

  it("parses the host command with project and passthrough args", () => {
    expect(parseCliArgs(["host"])).toMatchObject({ command: "host" });
    expect(parseCliArgs(["host", "--project", "/repo"])).toMatchObject({
      command: "host",
      project: "/repo",
    });
    expect(parseCliArgs(["host", "--", "--provider", "mock"])).toMatchObject({
      command: "host",
      piArgs: ["--provider", "mock"],
    });
    expect(() => parseCliArgs(["host", "--project"])).toThrow(/--project requires/);
  });

  it("rejects unknown flags, extra values, and missing option values", () => {
    expect(() => parseCliArgs(["view", "--nope"])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(["view", "--dir"])).toThrow(/--dir requires/);
    expect(() => parseCliArgs(["controllers", "--controller-dir"])).toThrow(/requires/);
    expect(() => parseCliArgs(["runs", "one", "two"])).toThrow(/Unexpected/);
  });
});

describe("pi-workflows CLI", () => {
  it("prints usage for help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout).toContain("pi-workflows — workflow runs and controller resources");
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
    expect(stdout).toContain("ƒ compute");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("one");
  });

  it("renders the run list with --once and no run id", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    await makeCompletedRun(outputRoot);
    expect(await main(["view", "--dir", outputRoot, "--once"])).toBe(0);
    expect(stdout).toContain("pi-workflows — runs");
  });

  it("lists and inspects controller resources without modifying the store", async () => {
    const controllerDir = await makeTempDir("pi-workflows-cli-controllers");
    const store = new SqliteControllerStore(path.join(controllerDir, "controller.sqlite"));
    const resource = store.putResource({
      controller: "pull-request",
      key: "repo#1",
      spec: { head: "abc" },
      initialStatus: { phase: "new" },
    });
    store.updateStatus({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: resource.metadata.resourceVersion,
      status: {
        observedGeneration: 1,
        controllerStatus: { phase: "ready" },
        conditions: [
          {
            type: "Ready",
            status: true,
            reason: "Complete",
            observedGeneration: 1,
            lastTransitionTime: "2026-08-04T00:00:00.000Z",
          },
        ],
      },
    });
    store.recordEvent({
      controller: "pull-request",
      key: "repo#1",
      type: "created",
      payload: { uid: resource.metadata.uid },
    });
    store.putResource({ controller: "other", key: "item", spec: {}, initialStatus: {} });
    store.close();

    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("pull-request  repo#1  generation=1  ready=true:Complete");
    stdout = "";
    expect(
      await main(["controller", "pull-request", "repo#1", "--controller-dir", controllerDir]),
    ).toBe(0);
    expect(stdout).toContain('"resource"');
    expect(stdout).toContain('"type": "created"');
  });

  it("reports missing and empty controller stores", async () => {
    const controllerDir = await makeTempDir("pi-workflows-cli-controllers");
    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("No controller resources found");
    stderr = "";
    expect(await main(["controller", "demo", "one", "--controller-dir", controllerDir])).toBe(1);
    expect(stderr).toContain("Controller store not found");

    const store = new SqliteControllerStore(path.join(controllerDir, "controller.sqlite"));
    store.close();
    stdout = "";
    expect(await main(["controllers", "--controller-dir", controllerDir])).toBe(0);
    expect(stdout).toContain("No controller resources found");
  });

  it("fails cleanly for unknown runs, bad args, and unknown commands", async () => {
    const outputRoot = await makeTempDir("pi-workflows-cli");
    expect(await main(["view", "nope", "--dir", outputRoot, "--once"])).toBe(1);
    expect(stderr).toContain("Run not found");

    expect(await main(["view", "--bogus"])).toBe(2);
    expect(stderr).toContain("Unknown argument");

    expect(await main(["controller", "missing"])).toBe(2);
    expect(stderr).toContain("requires <controller> and <key>");

    stderr = "";
    expect(await main(["herdr", "wrong"])).toBe(2);
    expect(stderr).toContain("herdr requires the setup action");

    stderr = "";
    expect(await main(["frobnicate"])).toBe(2);
    expect(stderr).toContain("Unknown command");
  });
});
