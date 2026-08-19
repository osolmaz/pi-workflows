import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HERDR_PLUGIN_ID } from "./constants.js";

const PACKAGE_NAME = "@osolmaz/pi-workflows";
const MANIFEST_NAME = "herdr-plugin.toml";
const VIEWER_PATH = "plugins/herdr/viewer.mjs";
const RESULT_SCHEMA = "pi-workflows.herdr-sync.v1" as const;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export type HerdrSyncStatus = "linked" | "relinked" | "enabled" | "unchanged" | "unavailable";

export type HerdrSyncResult = {
  schema: typeof RESULT_SCHEMA;
  status: HerdrSyncStatus;
  changed: boolean;
  pluginId: string;
  expectedVersion: string;
  effectiveVersion: string | null;
  enabled: boolean | null;
  runningPiProcessesNeedReload: true;
  message: string;
};

export type HerdrSetupResult = HerdrSyncResult;

type Spawn = (command: string, args: readonly string[]) => SpawnSyncReturns<string>;

type PluginPackage = {
  root: string;
  manifestPath: string;
  version: string;
};

type InstalledPlugin = {
  root: string;
  manifestPath: string;
  version: string;
  enabled: boolean;
  warnings: string[];
};

type Inspection = { available: true; plugin: InstalledPlugin | undefined } | { available: false };

type MutationResult = { ok: true } | { ok: false; error: string };

type RollbackTarget = { package: PluginPackage; enabled: boolean };

export function syncHerdrPlugin(packageRoot: string, spawn: Spawn = runCommand): HerdrSyncResult {
  const expected = preflightPackage(packageRoot);
  const initial = inspectHerdr(spawn, true);
  if (!initial.available) {
    return result("unavailable", false, expected.version, undefined);
  }

  const installed = initial.plugin;
  if (installed === undefined) {
    const linked = mutate(spawn, "link", [expected.root]);
    const adopted = verifyOrExplain(spawn, expected);
    if (adopted.plugin !== undefined && matchesExpected(adopted.plugin, expected, true)) {
      return result("linked", true, expected.version, adopted.plugin);
    }
    throw mutationError("link", linked, adopted.problem);
  }

  if (matchesExpected(installed, expected, true)) {
    return result("unchanged", false, expected.version, installed);
  }

  if (matchesExpected(installed, expected, false) && !installed.enabled) {
    const enabled = mutate(spawn, "enable", [HERDR_PLUGIN_ID]);
    const adopted = verifyOrExplain(spawn, expected);
    if (adopted.plugin !== undefined && matchesExpected(adopted.plugin, expected, true)) {
      return result("enabled", true, expected.version, adopted.plugin);
    }
    throw mutationError("enable", enabled, adopted.problem);
  }

  const rollback = rollbackTarget(installed);
  const unlinked = mutate(spawn, "unlink", [HERDR_PLUGIN_ID]);
  const afterUnlink = inspectHerdr(spawn, false);
  if (!afterUnlink.available) throw new Error("Herdr became unavailable during synchronization.");
  if (afterUnlink.plugin !== undefined) {
    if (matchesExpected(afterUnlink.plugin, expected, true)) {
      return result("relinked", true, expected.version, afterUnlink.plugin);
    }
    throw mutationError(
      "unlink the stale registration",
      unlinked,
      "Herdr still reports a conflicting registration.",
    );
  }

  const linked = mutate(spawn, "link", [expected.root]);
  const adopted = verifyOrExplain(spawn, expected);
  if (adopted.plugin !== undefined && matchesExpected(adopted.plugin, expected, true)) {
    return result("relinked", true, expected.version, adopted.plugin);
  }

  const rollbackMessage = restorePrevious(spawn, expected, rollback);
  throw new Error(
    `${mutationError("link the current package", linked, adopted.problem).message} ${rollbackMessage}`,
  );
}

/** Compatibility alias for callers that used the original setup API. */
export function setupHerdrPlugin(packageRoot: string, spawn: Spawn = runCommand): HerdrSetupResult {
  return syncHerdrPlugin(packageRoot, spawn);
}

function preflightPackage(packageRoot: string): PluginPackage {
  const requestedRoot = path.resolve(packageRoot);
  let root: string;
  try {
    root = fs.realpathSync(requestedRoot);
  } catch (error) {
    throw new Error(`Pi Workflows package root is missing: ${requestedRoot}`, { cause: error });
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Pi Workflows package root is not a directory: ${requestedRoot}`);
  }
  const packagePath = checkedRegularFile(root, "package.json");
  const manifestPath = checkedRegularFile(root, MANIFEST_NAME);
  const packageJson = parseJsonObject(fs.readFileSync(packagePath, "utf8"), "package.json");
  if (packageJson["name"] !== PACKAGE_NAME) {
    throw new Error(`Unexpected Pi Workflows package name in ${packagePath}.`);
  }
  const packageVersion = packageJson["version"];
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error(`Pi Workflows package version is missing in ${packagePath}.`);
  }

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const topLevelManifest = manifest.split(/^\s*\[\[/mu, 1)[0] ?? "";
  const pluginId = tomlString(topLevelManifest, "id", manifestPath);
  const pluginVersion = tomlString(topLevelManifest, "version", manifestPath);
  tomlString(topLevelManifest, "min_herdr_version", manifestPath);
  const platforms = tomlStringArray(topLevelManifest, "platforms", manifestPath);
  const command = tomlStringArray(manifest, "command", manifestPath);
  if (pluginId !== HERDR_PLUGIN_ID) {
    throw new Error(`Unexpected Herdr plugin ID in ${manifestPath}.`);
  }
  if (pluginVersion !== packageVersion) {
    throw new Error(`Herdr plugin version does not match package version ${packageVersion}.`);
  }
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  if (!platforms.includes(platform)) {
    throw new Error(`Herdr plugin does not support platform ${platform}.`);
  }
  if (command.length !== 2 || command[0] !== "node" || command[1] !== VIEWER_PATH) {
    throw new Error(`Unexpected Herdr plugin viewer command in ${manifestPath}.`);
  }
  checkedRegularFile(root, VIEWER_PATH);
  return { root, manifestPath, version: packageVersion };
}

function checkedRegularFile(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target)) {
    throw new Error(`Package file escapes the package root: ${relativePath}`);
  }
  const stat = statOrThrow(target, `Package file ${relativePath}`);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Package file is not a regular file: ${relativePath}`);
  }
  const real = fs.realpathSync(target);
  if (!isWithin(root, real)) {
    throw new Error(`Package file resolves outside the package root: ${relativePath}`);
  }
  return real;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function statOrThrow(target: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${label} is missing: ${target}`, { cause: error });
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object.`);
  return value;
}

function tomlString(text: string, key: string, manifestPath: string): string {
  const expressions = matches(
    text,
    new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$`, "gmu"),
  );
  if (expressions.length !== 1) {
    throw new Error(`Herdr manifest must contain one ${key} string: ${manifestPath}`);
  }
  try {
    const value: unknown = JSON.parse(expressions[0] as string);
    if (typeof value !== "string" || value.length === 0) throw new Error("empty string");
    return value;
  } catch (error) {
    throw new Error(`Herdr manifest has an invalid ${key} string: ${manifestPath}`, {
      cause: error,
    });
  }
}

function tomlStringArray(text: string, key: string, manifestPath: string): string[] {
  const expressions = matches(
    text,
    new RegExp(
      String.raw`^\s*${escapeRegExp(key)}\s*=\s*(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])\s*(?:#.*)?$`,
      "gmu",
    ),
  );
  if (expressions.length !== 1) {
    throw new Error(`Herdr manifest must contain one ${key} string array: ${manifestPath}`);
  }
  try {
    const value: unknown = JSON.parse(expressions[0] as string);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string")
    ) {
      throw new Error("invalid string array");
    }
    return value as string[];
  } catch (error) {
    throw new Error(`Herdr manifest has an invalid ${key} string array: ${manifestPath}`, {
      cause: error,
    });
  }
}

function matches(text: string, expression: RegExp): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(expression)) {
    const value = match[1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function inspectHerdr(spawn: Spawn, allowUnavailable: boolean): Inspection {
  const listed = spawn("herdr", ["plugin", "list", "--plugin", HERDR_PLUGIN_ID, "--json"]);
  if (listed.error !== undefined) {
    if (allowUnavailable && errorCode(listed.error) === "ENOENT") return { available: false };
    throw new Error(`Could not run Herdr: ${listed.error.message}`);
  }
  if (listed.status !== 0) {
    throw new Error(`Could not inspect Herdr plugins: ${bounded(listed.stderr || listed.stdout)}`);
  }
  return { available: true, plugin: installedPlugin(listed.stdout) };
}

function installedPlugin(stdout: string): InstalledPlugin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Herdr returned invalid plugin JSON.");
  }
  if (
    !isRecord(value) ||
    !isRecord(value["result"]) ||
    !Array.isArray(value["result"]["plugins"])
  ) {
    throw new Error("Herdr returned an invalid plugin list.");
  }
  const candidates = value["result"]["plugins"].filter(
    (plugin) => isRecord(plugin) && plugin["plugin_id"] === HERDR_PLUGIN_ID,
  );
  if (candidates.length > 1) {
    throw new Error(`Herdr returned duplicate records for ${HERDR_PLUGIN_ID}.`);
  }
  const candidate = candidates[0];
  if (candidate === undefined) return undefined;
  if (
    !isRecord(candidate) ||
    typeof candidate["plugin_root"] !== "string" ||
    typeof candidate["manifest_path"] !== "string" ||
    typeof candidate["version"] !== "string" ||
    typeof candidate["enabled"] !== "boolean"
  ) {
    throw new Error(`Herdr returned an incomplete record for ${HERDR_PLUGIN_ID}.`);
  }
  return {
    root: normalizedPath(candidate["plugin_root"]),
    manifestPath: normalizedPath(candidate["manifest_path"]),
    version: candidate["version"],
    enabled: candidate["enabled"],
    warnings: pluginWarnings(candidate),
  };
}

function pluginWarnings(plugin: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of ["warning", "manifest_warning"] as const) {
    const value = plugin[key];
    if (typeof value === "string" && value.trim().length > 0) warnings.push(value.trim());
  }
  const many = plugin["warnings"];
  if (many !== undefined) {
    if (!Array.isArray(many) || many.some((item) => typeof item !== "string")) {
      throw new Error(`Herdr returned invalid warnings for ${HERDR_PLUGIN_ID}.`);
    }
    warnings.push(...many.filter((item) => item.trim().length > 0).map((item) => item.trim()));
  }
  return warnings;
}

function matchesExpected(
  installed: InstalledPlugin,
  expected: PluginPackage,
  requireEnabled: boolean,
): boolean {
  return (
    installed.root === normalizedPath(expected.root) &&
    installed.manifestPath === normalizedPath(expected.manifestPath) &&
    installed.version === expected.version &&
    (!requireEnabled || installed.enabled) &&
    installed.warnings.length === 0
  );
}

function rollbackTarget(installed: InstalledPlugin): RollbackTarget | undefined {
  try {
    const previous = preflightPackage(installed.root);
    return matchesExpected(installed, previous, installed.enabled)
      ? { package: previous, enabled: installed.enabled }
      : undefined;
  } catch {
    return undefined;
  }
}

function restorePrevious(
  spawn: Spawn,
  expected: PluginPackage,
  previous: RollbackTarget | undefined,
): string {
  if (previous === undefined) return "The previous registration could not be restored.";
  try {
    const current = inspectHerdr(spawn, false);
    if (!current.available)
      return "Herdr became unavailable; the previous registration was not restored.";
    if (current.plugin !== undefined) {
      if (!matchesExpected(current.plugin, expected, current.plugin.enabled)) {
        return "A different registration appeared; the previous registration was not restored.";
      }
      const removed = mutate(spawn, "unlink", [HERDR_PLUGIN_ID]);
      if (!removed.ok) return `The previous registration was not restored: ${removed.error}`;
    }
    const args = previous.enabled ? [previous.package.root] : [previous.package.root, "--disabled"];
    const restored = mutate(spawn, "link", args);
    if (!restored.ok) return `The previous registration was not restored: ${restored.error}`;
    const verified = inspectHerdr(spawn, false);
    if (
      verified.available &&
      verified.plugin !== undefined &&
      matchesExpected(verified.plugin, previous.package, previous.enabled) &&
      verified.plugin.enabled === previous.enabled
    ) {
      return "The previous registration was restored.";
    }
    return "Herdr did not verify the restored registration.";
  } catch (error) {
    return `The previous registration was not restored: ${bounded(errorMessage(error))}`;
  }
}

function verifyOrExplain(
  spawn: Spawn,
  expected: PluginPackage,
): { plugin?: InstalledPlugin; problem: string } {
  try {
    const inspected = inspectHerdr(spawn, false);
    if (!inspected.available) return { problem: "Herdr became unavailable." };
    if (inspected.plugin === undefined) return { problem: "Herdr reports no plugin registration." };
    if (matchesExpected(inspected.plugin, expected, true)) {
      return { plugin: inspected.plugin, problem: "" };
    }
    return {
      plugin: inspected.plugin,
      problem: "Herdr did not report the expected healthy registration.",
    };
  } catch (error) {
    return { problem: errorMessage(error) };
  }
}

function mutate(spawn: Spawn, action: string, args: readonly string[]): MutationResult {
  const changed = spawn("herdr", ["plugin", action, ...args]);
  if (changed.error !== undefined) return { ok: false, error: changed.error.message };
  if (changed.status !== 0) {
    return { ok: false, error: bounded(changed.stderr || changed.stdout) };
  }
  return { ok: true };
}

function mutationError(action: string, mutation: MutationResult, verification: string): Error {
  const command = mutation.ok ? "The command completed" : `The command failed: ${mutation.error}`;
  return new Error(`Could not ${action} the Herdr plugin. ${command}. ${verification}`);
}

function result(
  status: HerdrSyncStatus,
  changed: boolean,
  expectedVersion: string,
  effective: InstalledPlugin | undefined,
): HerdrSyncResult {
  const messages: Record<HerdrSyncStatus, string> = {
    linked: `Linked Herdr plugin ${HERDR_PLUGIN_ID}.`,
    relinked: `Repaired Herdr plugin ${HERDR_PLUGIN_ID}.`,
    enabled: `Enabled Herdr plugin ${HERDR_PLUGIN_ID}.`,
    unchanged: `Herdr plugin ${HERDR_PLUGIN_ID} is current.`,
    unavailable: "Herdr is not installed; plugin synchronization was skipped.",
  };
  return {
    schema: RESULT_SCHEMA,
    status,
    changed,
    pluginId: HERDR_PLUGIN_ID,
    expectedVersion,
    effectiveVersion: effective?.version ?? null,
    enabled: effective?.enabled ?? null,
    runningPiProcessesNeedReload: true,
    message: messages[status],
  };
}

function runCommand(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
  });
}

function errorCode(error: Error): string | undefined {
  const value = error as Error & { code?: unknown };
  return typeof value.code === "string" ? value.code : undefined;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function bounded(value: string): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
