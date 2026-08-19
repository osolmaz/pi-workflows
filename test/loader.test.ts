import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
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
    `from "@osolmaz/pi-workflows"`,
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

    const discovered = await discoverWorkflows({ cwd, homeDir }, builtinWorkflowCatalog);

    expect(discovered.map((w) => [w.name, w.source])).toEqual([
      ["local", "project"],
      ["global", "global"],
      ["autoplan", "builtin"],
      ["autodoc", "builtin"],
      ["autoimplement", "builtin"],
      ["plan-approval", "builtin"],
      ["monitor", "builtin"],
    ]);
  });

  it("prefers project workflows on name collisions", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await copyExample(path.join(cwd, ".pi", "workflows"), "same.workflow.ts");
    await copyExample(path.join(homeDir, ".pi", "agent", "workflows"), "same.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir }, builtinWorkflowCatalog);

    expect(discovered).toHaveLength(6);
    expect(discovered[0]?.source).toBe("project");
    expect(discovered.slice(1).map((item) => item.name)).toEqual([
      "autoplan",
      "autodoc",
      "autoimplement",
      "plan-approval",
      "monitor",
    ]);
  });

  it("returns the built-in monitor for missing user directories", async () => {
    const cwd = await makeTempDir("pi-workflows-empty");
    const homeDir = await makeTempDir("pi-workflows-empty-home");
    expect(
      (await discoverWorkflows({ cwd, homeDir }, builtinWorkflowCatalog)).map((item) => item.name),
    ).toEqual(["autoplan", "autodoc", "autoimplement", "plan-approval", "monitor"]);
  });

  it("lets a project workflow override the built-in monitor", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const target = await copyExample(path.join(cwd, ".pi", "workflows"), "monitor.workflow.ts");

    const discovered = await discoverWorkflows({ cwd, homeDir }, builtinWorkflowCatalog);

    expect(discovered.filter((workflow) => workflow.name === "monitor")).toEqual([
      { name: "monitor", ref: target, source: "project" },
    ]);
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

    const resolved = await resolveWorkflowRef("mine", { cwd, homeDir }, builtinWorkflowCatalog);

    expect(resolved.sourceKind).toBe("project");
    expect(resolved.source).toMatchObject({ kind: "file", path: target });
    expect(resolved.definition.name).toBe("echo");
  });

  it("resolves and loads the built-in monitor", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const resolved = await resolveWorkflowRef("monitor", { cwd, homeDir }, builtinWorkflowCatalog);

    expect(resolved.sourceKind).toBe("builtin");
    expect(resolved.source).toEqual({ kind: "builtin", id: "monitor", revision: "7" });
    expect(resolved.definition.name).toBe("monitor");
    expect(resolved.sources.map((item) => item.mountPath.join("/"))).toEqual([
      "approval",
      "documentation",
      "implementation",
      "implementation/approval",
      "implementation/documentation",
      "implementation/redesign",
      "initialDesign",
    ]);
  });

  it("resolves relative nested includes and records their source", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const dir = path.join(cwd, ".pi", "workflows");
    const api = JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "index.ts"));
    const child = path.join(dir, "child.workflow.ts");
    const parent = path.join(dir, "parent.workflow.ts");
    await fs.writeFile(
      child,
      `import { compute, defineWorkflow } from ${api};\nexport default defineWorkflow({ name: "child", startAt: "done", exits: { ready: { from: "done" } }, nodes: { done: compute({ run: () => ({ ok: true }) }) }, edges: [] });\n`,
      "utf8",
    );
    await fs.writeFile(
      parent,
      `import { compute, defineWorkflow, includeWorkflow } from ${api};\nexport default defineWorkflow({ name: "parent", startAt: "start", includes: { child: includeWorkflow({ workflow: "./child.workflow.ts" }) }, nodes: { start: compute({ run: () => ({}) }), finish: compute({ run: ({ outputs }) => outputs.child }) }, edges: [{ from: "start", to: "child" }, { from: "child.ready", to: "finish" }] });\n`,
      "utf8",
    );

    const resolved = await resolveWorkflowRef(parent, { cwd, homeDir }, builtinWorkflowCatalog);

    expect(resolved.sources).toEqual([
      expect.objectContaining({
        mountPath: ["child"],
        workflowName: "child",
        source: expect.objectContaining({ kind: "file", path: child }),
      }),
    ]);
    expect(resolved.definition.nodes).toHaveProperty("child/done");
  });

  it("rejects nested source cycles before a run starts", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const dir = path.join(cwd, ".pi", "workflows");
    const api = JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "index.ts"));
    const a = path.join(dir, "a.workflow.ts");
    const b = path.join(dir, "b.workflow.ts");
    const source = (name: string, child: string) =>
      `import { compute, defineWorkflow, includeWorkflow } from ${api};\nexport default defineWorkflow({ name: ${JSON.stringify(name)}, startAt: "start", includes: { child: includeWorkflow({ workflow: ${JSON.stringify(child)} }) }, exits: { ready: { from: "finish" } }, nodes: { start: compute({ run: () => ({}) }), finish: compute({ run: () => ({}) }) }, edges: [{ from: "start", to: "child" }, { from: "child.ready", to: "finish" }] });\n`;
    await fs.writeFile(a, source("a", "./b.workflow.ts"), "utf8");
    await fs.writeFile(b, source("b", "./a.workflow.ts"), "utf8");

    await expect(resolveWorkflowRef(a, { cwd, homeDir }, builtinWorkflowCatalog)).rejects.toThrow(
      /source cycle/i,
    );
  });

  it("rejects a project override that changes a registered child contract", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const dir = path.join(cwd, ".pi", "workflows");
    const api = JSON.stringify(path.join(REPO_ROOT, "src", "workflows", "index.ts"));
    await fs.writeFile(
      path.join(dir, "autoplan.workflow.ts"),
      `import { compute, defineWorkflow } from ${api};\nexport default defineWorkflow({ name: "autoplan", startAt: "done", exits: { wrong: { from: "done" } }, nodes: { done: compute({ run: () => ({}) }) }, edges: [] });\n`,
      "utf8",
    );

    await expect(
      resolveWorkflowRef("builtin:monitor", { cwd, homeDir }, builtinWorkflowCatalog),
    ).rejects.toThrow(/contract mismatch/i);
  });

  it("resolves direct paths", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    const resolved = await resolveWorkflowRef(
      ECHO_EXAMPLE,
      { cwd, homeDir },
      builtinWorkflowCatalog,
    );
    expect(resolved.sourceKind).toBe("path");
    expect(resolved.source).toMatchObject({ kind: "file", path: ECHO_EXAMPLE });
  });

  it("lists available names for unknown refs", async () => {
    const { cwd, homeDir } = await makeSearchDirs();
    await copyExample(path.join(cwd, ".pi", "workflows"), "known.workflow.ts");
    await expect(
      resolveWorkflowRef("unknown", { cwd, homeDir }, builtinWorkflowCatalog),
    ).rejects.toThrow(/known/);
  });
});
