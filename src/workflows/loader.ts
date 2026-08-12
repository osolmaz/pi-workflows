import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { BuiltinWorkflowCatalog } from "./catalog.js";
import { isWorkflowDefinition } from "./definition.js";
import { WorkflowSourceChangedError } from "./errors.js";
import type { WorkflowDefinition, WorkflowSource } from "./types.js";

const WORKFLOW_FILE_SUFFIXES = [".workflow.ts", ".workflow.js", ".workflow.mts", ".workflow.mjs"];

export type DiscoveredWorkflow = {
  name: string;
  ref: string;
  source: "project" | "global" | "builtin" | "path";
};

export type WorkflowSearchPaths = {
  cwd: string;
  homeDir?: string;
};

export type ResolvedWorkflow = {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  sourceKind: DiscoveredWorkflow["source"];
};

/** Directories scanned for user workflow files, in precedence order. */
export function workflowSearchDirs(
  options: WorkflowSearchPaths,
): { dir: string; source: "project" | "global" }[] {
  const homeDir = options.homeDir ?? os.homedir();
  return [
    { dir: path.join(options.cwd, ".pi", "workflows"), source: "project" },
    { dir: path.join(homeDir, ".pi", "agent", "workflows"), source: "global" },
  ];
}

/** SHA-256 of a user workflow source file. */
export async function hashWorkflowSource(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(path.resolve(filePath)))
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

// Alias package imports to this process's workflow API. User files can reload,
// but their node constructors and validators remain from one engine version.
const SELF_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");

/** Load a user workflow module from disk. */
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

/** Discover user workflows first, then unshadowed catalog built-ins. */
export async function discoverWorkflows(
  options: WorkflowSearchPaths,
  catalog?: BuiltinWorkflowCatalog,
): Promise<DiscoveredWorkflow[]> {
  const discovered: DiscoveredWorkflow[] = [];
  const seenNames = new Set<string>();
  for (const { dir, source } of workflowSearchDirs(options)) {
    for (const filePath of await listWorkflowFiles(dir)) {
      const name = workflowFileStem(filePath);
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      discovered.push({ name, ref: filePath, source });
    }
  }
  for (const builtin of catalog?.list() ?? []) {
    if (seenNames.has(builtin.definition.name)) continue;
    seenNames.add(builtin.definition.name);
    discovered.push({ name: builtin.definition.name, ref: builtin.ref, source: "builtin" });
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

/** Resolve a workflow name, stable built-in ref, or direct user file path. */
export async function resolveWorkflowRef(
  ref: string,
  options: WorkflowSearchPaths,
  catalog?: BuiltinWorkflowCatalog,
): Promise<ResolvedWorkflow> {
  if (ref.startsWith("builtin:")) {
    const id = ref.slice("builtin:".length);
    const builtin = catalog?.get(id);
    if (builtin === undefined) throw new Error(`Unknown built-in workflow ${JSON.stringify(ref)}`);
    return {
      definition: builtin.definition,
      source: { kind: "builtin", id: builtin.id, revision: builtin.revision },
      sourceKind: "builtin",
    };
  }
  if (looksLikePath(ref)) {
    const absolutePath = path.resolve(options.cwd, ref);
    await fs.access(absolutePath);
    return {
      definition: await loadWorkflowFile(absolutePath),
      source: { kind: "file", path: absolutePath, hash: await hashWorkflowSource(absolutePath) },
      sourceKind: "path",
    };
  }
  const discovered = await discoverWorkflows(options, catalog);
  const match = discovered.find((workflow) => workflow.name === ref);
  if (match === undefined) {
    const available = discovered.map((workflow) => workflow.name).join(", ") || "(none)";
    throw new Error(`Unknown workflow ${JSON.stringify(ref)}. Available workflows: ${available}`);
  }
  if (match.source === "builtin") return await resolveWorkflowRef(match.ref, options, catalog);
  const absolutePath = path.resolve(match.ref);
  return {
    definition: await loadWorkflowFile(absolutePath),
    source: { kind: "file", path: absolutePath, hash: await hashWorkflowSource(absolutePath) },
    sourceKind: match.source,
  };
}

/** Resolve an already persisted canonical source. */
export async function resolveWorkflowSource(
  source: WorkflowSource,
  catalog?: BuiltinWorkflowCatalog,
  runId = source.kind === "builtin" ? `builtin:${source.id}` : source.path,
): Promise<WorkflowDefinition> {
  if (source.kind === "builtin") {
    if (catalog === undefined) throw new Error(`No built-in workflow catalog for ${source.id}`);
    return catalog.resolve(source, runId);
  }
  const actualHash = await hashWorkflowSource(source.path);
  if (actualHash !== source.hash) {
    throw new WorkflowSourceChangedError(runId);
  }
  return await loadWorkflowFile(source.path);
}

function looksLikePath(ref: string): boolean {
  return (
    ref.includes("/") ||
    ref.includes("\\") ||
    WORKFLOW_FILE_SUFFIXES.some((suffix) => ref.endsWith(suffix))
  );
}
