import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HERDR_PLUGIN_ID } from "./constants.js";

export type HerdrSetupResult = {
  changed: boolean;
  message: string;
};

type Spawn = (command: string, args: readonly string[]) => SpawnSyncReturns<string>;

export function setupHerdrPlugin(packageRoot: string, spawn: Spawn = runCommand): HerdrSetupResult {
  const root = path.resolve(packageRoot);
  const manifest = path.join(root, "herdr-plugin.toml");
  if (!fs.existsSync(manifest)) {
    throw new Error(`Herdr plugin manifest not found: ${manifest}`);
  }

  const listed = spawn("herdr", ["plugin", "list", "--plugin", HERDR_PLUGIN_ID, "--json"]);
  if (listed.error) throw new Error(`Could not run Herdr: ${listed.error.message}`);
  if (listed.status !== 0) {
    throw new Error(`Could not inspect Herdr plugins: ${bounded(listed.stderr || listed.stdout)}`);
  }
  const installed = installedPlugin(listed.stdout);
  if (installed !== undefined) {
    if (path.resolve(installed.root) !== root) {
      throw new Error(
        `Herdr plugin ${HERDR_PLUGIN_ID} is already registered from ${installed.root}. Unlink it before linking ${root}.`,
      );
    }
    if (installed.enabled) {
      return { changed: false, message: `Herdr plugin ${HERDR_PLUGIN_ID} is already linked.` };
    }
    const enabled = spawn("herdr", ["plugin", "enable", HERDR_PLUGIN_ID]);
    if (enabled.error) throw new Error(`Could not run Herdr: ${enabled.error.message}`);
    if (enabled.status !== 0) {
      throw new Error(
        `Could not enable the Herdr plugin: ${bounded(enabled.stderr || enabled.stdout)}`,
      );
    }
    return { changed: true, message: `Enabled Herdr plugin ${HERDR_PLUGIN_ID}.` };
  }

  const linked = spawn("herdr", ["plugin", "link", root]);
  if (linked.error) throw new Error(`Could not run Herdr: ${linked.error.message}`);
  if (linked.status !== 0) {
    throw new Error(`Could not link the Herdr plugin: ${bounded(linked.stderr || linked.stdout)}`);
  }
  return { changed: true, message: `Linked Herdr plugin ${HERDR_PLUGIN_ID} from ${root}.` };
}

function installedPlugin(stdout: string): { root: string; enabled: boolean } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Herdr returned invalid plugin JSON.");
  }
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.plugins)) {
    throw new Error("Herdr returned an invalid plugin list.");
  }
  for (const plugin of value.result.plugins) {
    if (
      isRecord(plugin) &&
      plugin.plugin_id === HERDR_PLUGIN_ID &&
      typeof plugin.plugin_root === "string" &&
      typeof plugin.enabled === "boolean"
    ) {
      return { root: plugin.plugin_root, enabled: plugin.enabled };
    }
  }
  return undefined;
}

function runCommand(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function bounded(value: string): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
