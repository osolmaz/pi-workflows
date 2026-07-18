import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkflows,
  loadWorkflowFile,
  resolveWorkflowRef,
  workflowFileStem,
} from "../src/workflows/loader.js";
import { makeTempDir } from "./helpers.js";

const REPO_ROOT = path.resolve(__dirname, "..");
const ECHO_EXAMPLE = path.join(REPO_ROOT, "examples", "workflows", "echo.workflow.ts");

async function makeSearchDirs() {
  const cwd = await makeTempDir("pi-workflows-cwd");
  const homeDir = await makeTempDir("pi-workflows-home");
  await fs.mkdir(path.join(cwd, ".pi", "workflows"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".pi", "agent", "workflows"), { recursive: true });
  return { cwd, homeDir };
}

async function copyExample(targetDir: string, fileName: string): Promise<string> {
  const target = path.join(targetDir, fileName);
  let source = await fs.readFile(ECHO_EXAMPLE, "utf8");
  source = source.replace(
    `from "pi-workflows"`,
    `from ${JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "index.ts"))}`,
  );
  await fs.writeFile(target, source, "utf8");
  return target;
}

describe("workflowFileStem", () => {
  it("strips workflow suffixes", () => {
    expect(workflowFileStem("/a/b/echo.workflow.ts")).toBe("echo");
    expect(workflowFileStem("/a/b/echo.workflow.js")).toBe("echo");
  });
});

describe("discoverWorkflows", () => {
  it("finds project and global workflows, project first", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await copyExample(path.join(cwd, ".pi", "workflows"), "local.workflow.ts");
    await copyExample(path.join(homeDir, ".pi", "agent", "workflows"), "global.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir });

    expect(discovered.map((w) => [w.name, w.source])).toEqual([
      ["local", "project"],
      ["global", "global"],
    ]);
  });

  it("prefers project workflows on name collisions", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await copyExample(path.join(cwd, ".pi", "workflows"), "same.workflow.ts");
    await copyExample(path.join(homeDir, ".pi", "agent", "workflows"), "same.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source).toBe("project");
  });

  it("returns empty for missing directories", async () => {
    const cwd = await makeTempDir("pi-workflows-empty");
    const homeDir = await makeTempDir("pi-workflows-empty-home");
    expect(await discoverWorkflows({ cwd, homeDir })).toEqual([]);
  });
});

describe("loadWorkflowFile", () => {
  it("loads a workflow module via jiti", async () => {
    const workflow = await loadWorkflowFile(ECHO_EXAMPLE);
    expect(workflow.name).toBe("echo");
    expect(workflow.startAt).toBe("reply");
  });

  it("rejects modules that do not export defineWorkflow", async () => {
    const dir = await makeTempDir("pi-workflows-bad");
    const badPath = path.join(dir, "bad.workflow.ts");
    await fs.writeFile(badPath, "export default { name: 'nope' };\n", "utf8");
    await expect(loadWorkflowFile(badPath)).rejects.toThrow(/defineWorkflow/);
  });
});

describe("resolveWorkflowRef", () => {
  it("resolves names to discovered workflows", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const target = await copyExample(path.join(cwd, ".pi", "workflows"), "mine.workflow.ts");

    const resolved = await resolveWorkflowRef("mine", { cwd, homeDir });

    expect(resolved).toEqual({ path: target, source: "project" });
  });

  it("resolves direct paths", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const resolved = await resolveWorkflowRef(ECHO_EXAMPLE, { cwd, homeDir });
    expect(resolved).toEqual({ path: ECHO_EXAMPLE, source: "path" });
  });

  it("lists available names for unknown refs", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await copyExample(path.join(cwd, ".pi", "workflows"), "known.workflow.ts");
    await expect(resolveWorkflowRef("unknown", { cwd, homeDir })).rejects.toThrow(/known/);
  });
});
