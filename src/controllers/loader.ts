import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { isControllerDefinition } from "./definition.js";
import type { AnyControllerDefinition } from "./types.js";

const CONTROLLER_FILE_SUFFIXES = [
  ".controller.ts",
  ".controller.js",
  ".controller.mts",
  ".controller.mjs",
];

export type DiscoveredController = {
  name: string;
  path: string;
  source: "project" | "global";
};

export function controllerSearchDirs(options: {
  cwd: string;
  homeDir?: string;
}): { dir: string; source: DiscoveredController["source"] }[] {
  const homeDir = options.homeDir ?? os.homedir();
  return [
    { dir: path.join(options.cwd, ".pi", "controllers"), source: "project" },
    { dir: path.join(homeDir, ".pi", "agent", "controllers"), source: "global" },
  ];
}

export function controllerFileStem(filePath: string): string {
  const base = path.basename(filePath);
  const suffix = CONTROLLER_FILE_SUFFIXES.find((candidate) => base.endsWith(candidate));
  return suffix === undefined ? base : base.slice(0, -suffix.length);
}

const CONTROLLER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
const WORKFLOW_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../workflows/index",
);

export async function loadControllerFile(filePath: string): Promise<AnyControllerDefinition> {
  const absolutePath = path.resolve(filePath);
  const jiti = createJiti(pathToFileURL(absolutePath).href, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      "@osolmaz/pi-workflows/controllers": CONTROLLER_ENTRY,
      "@osolmaz/pi-workflows": WORKFLOW_ENTRY,
    },
  });
  const loaded = (await jiti.import(absolutePath, { default: true })) as unknown;
  if (!isControllerDefinition(loaded)) {
    throw new Error(`Controller module must default-export defineController(...): ${absolutePath}`);
  }
  return loaded;
}

export async function discoverControllers(options: {
  cwd: string;
  homeDir?: string;
}): Promise<DiscoveredController[]> {
  const discovered: DiscoveredController[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of controllerSearchDirs(options)) {
    for (const filePath of await listControllerFiles(dir)) {
      const name = controllerFileStem(filePath);
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      discovered.push({ name, path: filePath, source });
    }
  }
  return discovered;
}

export async function loadDiscoveredControllers(options: {
  cwd: string;
  homeDir?: string;
}): Promise<AnyControllerDefinition[]> {
  return await Promise.all(
    (await discoverControllers(options)).map(async (entry) => await loadControllerFile(entry.path)),
  );
}

async function listControllerFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && CONTROLLER_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
}
