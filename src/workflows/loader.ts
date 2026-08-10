import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { isWorkflowDefinition } from "./definition.js";
import type { WorkflowDefinition } from "./types.js";

const WORKFLOW_FILE_SUFFIXES = [".workflow.ts", ".workflow.js", ".workflow.mts", ".workflow.mjs"];

export type DiscoveredWorkflow = {
  name: string;
  path: string;
  source: "project" | "global" | "builtin" | "path";
};

export type WorkflowSearchPaths = {
  cwd: string;
  homeDir?: string;
};

/** Directories scanned for workflow files, in precedence order. */
export function workflowSearchDirs(
  options: WorkflowSearchPaths,
): { dir: string; source: "project" | "global" | "builtin" }[] {
  const homeDir = options.homeDir ?? os.homedir();
  const builtinDir = fileURLToPath(new URL("../builtins/", import.meta.url));
  return [
    { dir: path.join(options.cwd, ".pi", "workflows"), source: "project" },
    { dir: path.join(homeDir, ".pi", "agent", "workflows"), source: "global" },
    { dir: builtinDir, source: "builtin" },
  ];
}

/** SHA-256 of a workflow source file, recorded in run state for resume pinning. */
export async function hashWorkflowSource(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function isWorkflowFile(fileName: string): boolean {
  return WORKFLOW_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

export function workflowFileStem(filePath: string): string {
  const base = path.basename(filePath);
  const suffix = WORKFLOW_FILE_SUFFIXES.find((candidate) => base.endsWith(candidate));
  return suffix ? base.slice(0, -suffix.length) : base;
}

// Alias the package name to this module's own entry so workflow files can
// `import { agent } from "@osolmaz/pi-workflows"` whether the engine runs from src
// (tests, tsx) or from the built dist inside the installed package.
const SELF_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");

/** Load a workflow module from disk. The default export must be `defineWorkflow(...)`. */
export async function loadWorkflowFile(filePath: string): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(filePath);
  const jiti = createJiti(pathToFileURL(absolutePath).href, {
    interopDefault: true,
    moduleCache: false,
    alias: { "@osolmaz/pi-workflows": SELF_ENTRY },
  });
  const loaded = (await jiti.import(absolutePath, { default: true })) as unknown;
  if (!isWorkflowDefinition(loaded)) {
    throw new Error(`Workflow module must default-export defineWorkflow(...): ${absolutePath}`);
  }
  return loaded;
}

/** Discover named workflows in the project and global workflow directories. */
export async function discoverWorkflows(
  options: WorkflowSearchPaths,
): Promise<DiscoveredWorkflow[]> {
  const discovered: DiscoveredWorkflow[] = [];
  const seenNames = new Set<string>();
  for (const { dir, source } of workflowSearchDirs(options)) {
    for (const filePath of await listWorkflowFiles(dir)) {
      const name = workflowFileStem(filePath);
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      discovered.push({ name, path: filePath, source });
    }
  }
  return discovered;
}

async function listWorkflowFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isWorkflowFile(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Resolve a `/workflow` argument to a workflow file. Accepts a discovered
 * workflow name or a direct path to a `*.workflow.ts` file.
 */
export async function resolveWorkflowRef(
  ref: string,
  options: WorkflowSearchPaths,
): Promise<{ path: string; source: DiscoveredWorkflow["source"] }> {
  if (looksLikePath(ref)) {
    const absolutePath = path.resolve(options.cwd, ref);
    await fs.access(absolutePath);
    return { path: absolutePath, source: "path" };
  }
  const discovered = await discoverWorkflows(options);
  const match = discovered.find((workflow) => workflow.name === ref);
  if (!match) {
    const available = discovered.map((workflow) => workflow.name).join(", ") || "(none)";
    throw new Error(`Unknown workflow ${JSON.stringify(ref)}. Available workflows: ${available}`);
  }
  return { path: match.path, source: match.source };
}

function looksLikePath(ref: string): boolean {
  return (
    ref.includes("/") ||
    ref.includes("\\") ||
    WORKFLOW_FILE_SUFFIXES.some((suffix) => ref.endsWith(suffix))
  );
}
