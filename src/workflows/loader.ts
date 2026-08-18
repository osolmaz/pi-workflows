import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { BuiltinWorkflowCatalog } from "./catalog.js";
import {
  compileWorkflowDefinition,
  compositionMetadata,
  type WorkflowCompositionSourceMap,
} from "./composition.js";
import { defineWorkflow, isWorkflowDefinition } from "./definition.js";
import { WorkflowSourceChangedError } from "./errors.js";
import type {
  WorkflowDefinition,
  WorkflowIncludeDefinition,
  WorkflowMountedSource,
  WorkflowSource,
} from "./types.js";

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
  sources: WorkflowMountedSource[];
  sourceKind: DiscoveredWorkflow["source"];
};

type SingleResolvedWorkflow = Omit<ResolvedWorkflow, "sources">;

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
const BUILTINS_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "builtins",
  "index",
);

/** Load a user workflow module from disk. */
export async function loadWorkflowFile(filePath: string): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(filePath);
  const jiti = createJiti(pathToFileURL(absolutePath).href, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      "@osolmaz/pi-workflows/builtins": BUILTINS_ENTRY,
      "@osolmaz/pi-workflows": SELF_ENTRY,
      "pi-workflows": SELF_ENTRY,
    },
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

/** Resolve a workflow and every nested include before returning it. */
export async function resolveWorkflowRef(
  ref: string,
  options: WorkflowSearchPaths,
  catalog?: BuiltinWorkflowCatalog,
): Promise<ResolvedWorkflow> {
  const root = await resolveSingleWorkflowRef(ref, options, catalog, options.cwd);
  const sourceMap: WorkflowCompositionSourceMap = new Map([[root.definition, root.source]]);
  const activeSources: string[] = [];
  const definition = await resolveIncludes(
    root.definition,
    sourceBaseDir(root.source),
    options,
    catalog,
    sourceMap,
    activeSources,
    sourceKey(root.source),
  );
  const compiled = compileWorkflowDefinition(definition, {
    rootSource: root.source,
    sourceMap,
  });
  return {
    definition: compiled,
    source: root.source,
    sources: compositionMetadata(compiled)?.sources ?? [],
    sourceKind: root.sourceKind,
  };
}

async function resolveSingleWorkflowRef(
  ref: string,
  options: WorkflowSearchPaths,
  catalog: BuiltinWorkflowCatalog | undefined,
  relativeBase: string,
): Promise<SingleResolvedWorkflow> {
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
    const absolutePath = path.resolve(relativeBase, ref);
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
  const resolved = await resolveSingleWorkflowRef(match.ref, options, catalog, options.cwd);
  return { ...resolved, sourceKind: match.source };
}

async function resolveIncludes(
  workflow: WorkflowDefinition,
  baseDir: string | undefined,
  options: WorkflowSearchPaths,
  catalog: BuiltinWorkflowCatalog | undefined,
  sourceMap: WorkflowCompositionSourceMap,
  activeSources: string[],
  currentSourceKey: string,
): Promise<WorkflowDefinition> {
  const cycleAt = activeSources.indexOf(currentSourceKey);
  if (cycleAt >= 0) {
    throw new Error(
      `Workflow include source cycle: ${[...activeSources.slice(cycleAt), currentSourceKey].join(" -> ")}`,
    );
  }
  activeSources.push(currentSourceKey);
  const resolvedIncludes: Record<string, WorkflowIncludeDefinition> = {};
  for (const [mountName, include] of Object.entries(workflow.includes ?? {})) {
    let child: WorkflowDefinition;
    let childSource: WorkflowSource | undefined;
    let childBaseDir = baseDir;
    if (typeof include.workflow === "string") {
      if (
        baseDir === undefined &&
        looksLikePath(include.workflow) &&
        !path.isAbsolute(include.workflow)
      ) {
        throw new Error(
          `Built-in workflow ${workflow.name} cannot resolve relative include ${include.workflow}`,
        );
      }
      const resolved = await resolveSingleWorkflowRef(
        include.workflow,
        options,
        catalog,
        baseDir ?? options.cwd,
      );
      child = resolved.definition;
      childSource = resolved.source;
      childBaseDir = sourceBaseDir(resolved.source);
    } else {
      child = include.workflow;
      childSource = await sourceForDirectDefinition(child, catalog);
      childBaseDir = childSource ? sourceBaseDir(childSource) : baseDir;
    }
    if (childSource !== undefined) sourceMap.set(child, childSource);
    assertContractCompatible(include, child, mountName);
    const childKey = childSource ? sourceKey(childSource) : `memory:${child.name}`;
    const resolvedChild = await resolveIncludes(
      child,
      childBaseDir,
      options,
      catalog,
      sourceMap,
      activeSources,
      childKey,
    );
    if (childSource !== undefined) sourceMap.set(resolvedChild, childSource);
    resolvedIncludes[mountName] = { ...include, workflow: resolvedChild };
  }
  activeSources.pop();
  if (Object.keys(resolvedIncludes).length === 0) return workflow;
  const resolved = defineWorkflow({ ...workflow, includes: resolvedIncludes });
  const ownSource = sourceMap.get(workflow);
  if (ownSource !== undefined) sourceMap.set(resolved, ownSource);
  return resolved;
}

async function sourceForDirectDefinition(
  workflow: WorkflowDefinition,
  catalog?: BuiltinWorkflowCatalog,
): Promise<WorkflowSource | undefined> {
  const builtin = catalog?.sourceForDefinition(workflow);
  if (builtin !== undefined) return builtin;
  if (workflow.source === undefined) return undefined;
  let filePath: string;
  try {
    filePath = fileURLToPath(workflow.source);
  } catch {
    throw new Error(`Workflow ${workflow.name} source must be a file URL: ${workflow.source}`);
  }
  return { kind: "file", path: filePath, hash: await hashWorkflowSource(filePath) };
}

function assertContractCompatible(
  include: WorkflowIncludeDefinition,
  child: WorkflowDefinition,
  mountName: string,
): void {
  if (include.contract === undefined) return;
  if (
    include.contract.contractId !== undefined &&
    child.contractId !== include.contract.contractId
  ) {
    throw new Error(
      `Workflow include ${mountName} contract mismatch: expected ${include.contract.contractId}; got ${child.contractId ?? "none"}`,
    );
  }
  const expected = Object.keys(include.contract.exits ?? {}).sort();
  const actual = Object.keys(child.exits ?? {}).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `Workflow include ${mountName} exit contract mismatch: expected ${expected.join(", ") || "none"}; got ${actual.join(", ") || "none"}`,
    );
  }
  if ((include.contract.input === undefined) !== (child.input === undefined)) {
    throw new Error(`Workflow include ${mountName} input contract mismatch`);
  }
}

function sourceBaseDir(source: WorkflowSource): string | undefined {
  return source.kind === "file" ? path.dirname(source.path) : undefined;
}

function sourceKey(source: WorkflowSource): string {
  return source.kind === "file"
    ? `file:${source.path}:${source.hash}`
    : `builtin:${source.id}:${source.revision}`;
}

/** Resolve an already persisted canonical source and its includes. */
export async function resolveWorkflowSource(
  source: WorkflowSource,
  catalog?: BuiltinWorkflowCatalog,
  runId = source.kind === "builtin" ? `builtin:${source.id}` : source.path,
  options: WorkflowSearchPaths = { cwd: process.cwd() },
): Promise<WorkflowDefinition> {
  if (source.kind === "builtin") {
    if (catalog === undefined) throw new Error(`No built-in workflow catalog for ${source.id}`);
    catalog.resolve(source, runId);
    return (await resolveWorkflowRef(`builtin:${source.id}`, options, catalog)).definition;
  }
  const actualHash = await hashWorkflowSource(source.path);
  if (actualHash !== source.hash) throw new WorkflowSourceChangedError(runId);
  return (await resolveWorkflowRef(source.path, options, catalog)).definition;
}

function looksLikePath(ref: string): boolean {
  return (
    ref.includes("/") ||
    ref.includes("\\") ||
    WORKFLOW_FILE_SUFFIXES.some((suffix) => ref.endsWith(suffix))
  );
}
