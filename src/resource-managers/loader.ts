import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { isResourceManagerDefinition } from "./definition.js";
import type { AnyResourceManagerDefinition } from "./types.js";

const RESOURCE_MANAGER_FILE_SUFFIXES = [
  ".resource-manager.ts",
  ".resource-manager.js",
  ".resource-manager.mts",
  ".resource-manager.mjs",
];

export type DiscoveredResourceManager = {
  name: string;
  path: string;
  source: "project" | "global";
};

export function resourceManagerSearchDirs(options: {
  cwd: string;
  homeDir?: string;
}): { dir: string; source: DiscoveredResourceManager["source"] }[] {
  const homeDir = options.homeDir ?? os.homedir();
  return [
    { dir: path.join(options.cwd, ".pi", "resource-managers"), source: "project" },
    { dir: path.join(homeDir, ".pi", "agent", "resource-managers"), source: "global" },
  ];
}

export function resourceManagerFileStem(filePath: string): string {
  const base = path.basename(filePath);
  const suffix = RESOURCE_MANAGER_FILE_SUFFIXES.find((candidate) => base.endsWith(candidate));
  return suffix === undefined ? base : base.slice(0, -suffix.length);
}

const RESOURCE_MANAGER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
const WORKFLOW_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../workflows/index",
);

export async function loadResourceManagerFile(
  filePath: string,
): Promise<AnyResourceManagerDefinition> {
  const absolutePath = path.resolve(filePath);
  const jiti = createJiti(pathToFileURL(absolutePath).href, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      "@osolmaz/pi-workflows/resource-managers": RESOURCE_MANAGER_ENTRY,
      "@osolmaz/pi-workflows": WORKFLOW_ENTRY,
    },
  });
  const loaded = (await jiti.import(absolutePath, { default: true })) as unknown;
  if (!isResourceManagerDefinition(loaded)) {
    throw new Error(
      `ResourceManager module must default-export defineResourceManager(...): ${absolutePath}`,
    );
  }
  return loaded;
}

export async function discoverResourceManagers(options: {
  cwd: string;
  homeDir?: string;
}): Promise<DiscoveredResourceManager[]> {
  const discovered: DiscoveredResourceManager[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of resourceManagerSearchDirs(options)) {
    for (const filePath of await listResourceManagerFiles(dir)) {
      const name = resourceManagerFileStem(filePath);
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      discovered.push({ name, path: filePath, source });
    }
  }
  return discovered;
}

export async function loadDiscoveredResourceManagers(options: {
  cwd: string;
  homeDir?: string;
}): Promise<AnyResourceManagerDefinition[]> {
  return await Promise.all(
    (await discoverResourceManagers(options)).map(
      async (entry) => await loadResourceManagerFile(entry.path),
    ),
  );
}

async function listResourceManagerFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        RESOURCE_MANAGER_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
}
