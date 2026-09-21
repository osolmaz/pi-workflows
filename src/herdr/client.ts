import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The client contract for the Herdr viewer pane. The Pi session owns the workflow server and the
 * client version, so it resolves the `piw` client once and hands the pane an absolute path plus
 * these variables. A pane then draws one run, checks nothing about `PATH`, and starts no server.
 */
export const PIW_BIN_ENV = "PIW_BIN";
export const PIW_SOCKET_ENV = "PIW_SOCKET";
export const PIW_NO_AUTOSTART_ENV = "PIW_NO_AUTOSTART";

const VERSION_TIMEOUT_MS = 5_000;

/** Platform names for the optional platform package, so a prebuilt client can ship later. */
const PLATFORM_SEGMENTS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

export type PiwClientSource = "PIW_BIN" | "package" | "PATH";

export type PiwClientInspection =
  | {
      ok: true;
      path: string;
      source: PiwClientSource;
      version: string;
      expectedVersion: string;
    }
  | { ok: false; kind: "missing" | "mismatch"; message: string };

export type PiwVersionCheck =
  | { compatible: true; version: string }
  | { compatible: false; reason: string };

export type PiwClientOptions = {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  readVersion?: (file: string) => string | undefined;
};

/**
 * crates.io owns the client binary. The version check binds that distribution to this package, so
 * the failure message names the one command that resolves it.
 */
export function installHint(expectedVersion: string): string {
  return `Install the matching client with: cargo install pi-workflows --version ${expectedVersion}`;
}

export function piwPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function piwPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const segment = PLATFORM_SEGMENTS[platform];
  return segment === undefined ? undefined : `@osolmaz/piw-${segment}-${arch}`;
}

export function piwBinaryNames(
  platform: NodeJS.Platform = process.platform,
): [string, ...string[]] {
  return platform === "win32" ? ["piw.exe", "piw"] : ["piw"];
}

export function piwPackageBinaryPath(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const packageName = piwPlatformPackageName(platform, arch);
  if (packageName === undefined) {
    return undefined;
  }
  return path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
    "bin",
    piwBinaryNames(platform)[0],
  );
}

export function piwPackageVersion(root: string = piwPackageRoot()): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Tolerates a `piw ` prefix, a tab, and a leading `v`, so every client build reports a version. */
export function parsePiwVersion(output: string | undefined): string | undefined {
  const line = (output ?? "").split("\n")[0]?.trim() ?? "";
  const match = /^(?:piw\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(line);
  return match?.[1];
}

export function checkPiwVersion(
  actual: string | undefined,
  expected: string,
  clientPath: string,
): PiwVersionCheck {
  if (actual === undefined) {
    return {
      compatible: false,
      reason: `The client at ${clientPath} did not report a parseable version, so it cannot be compared with ${expected}. ${installHint(expected)}`,
    };
  }
  if (actual !== expected) {
    return {
      compatible: false,
      reason: `The client at ${clientPath} is ${actual} but this pi-workflows package is ${expected}. ${installHint(expected)}`,
    };
  }
  return { compatible: true, version: actual };
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return pathEntries(env)
    .map((directory) => path.join(directory, name))
    .find((candidate) => isExecutableFile(candidate));
}

export function readPiwVersion(file: string): string | undefined {
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS });
  if (result.error !== undefined && result.error !== null) {
    return undefined;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return undefined;
  }
  return parsePiwVersion(typeof result.stdout === "string" ? result.stdout : undefined);
}

/**
 * Resolve the client once. Resolution order: an explicit `PIW_BIN`; the package-local platform
 * binary when a platform package is installed; then the first `piw` on `PATH`, which keeps the
 * behavior of a machine with no package-local binary. An explicit `PIW_BIN` that is unusable is a
 * loud failure rather than a silent `PATH` fallback.
 */
export function inspectPiwClient(options: PiwClientOptions = {}): PiwClientInspection {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const root = options.packageRoot ?? piwPackageRoot();
  const expectedVersion = piwPackageVersion(root);
  if (expectedVersion === undefined) {
    return {
      ok: false,
      kind: "missing",
      message: `The pi-workflows package at ${root} has no readable version, so no client can be checked. Reinstall @osolmaz/pi-workflows.`,
    };
  }

  const explicit = env[PIW_BIN_ENV]?.trim() ?? "";
  if (explicit.length > 0) {
    if (!isExecutableFile(explicit)) {
      return {
        ok: false,
        kind: "missing",
        message: `${PIW_BIN_ENV} points at ${explicit}, which is not an executable file. ${installHint(expectedVersion)}`,
      };
    }
    return inspectCandidate(explicit, "PIW_BIN", expectedVersion, options.readVersion);
  }

  const packageBinary = piwPackageBinaryPath(root, platform, options.arch ?? process.arch);
  if (packageBinary !== undefined && isExecutableFile(packageBinary)) {
    return inspectCandidate(packageBinary, "package", expectedVersion, options.readVersion);
  }

  const fromPath = findPiWOnPath(env, platform);
  if (fromPath !== undefined) {
    return inspectCandidate(fromPath, "PATH", expectedVersion, options.readVersion);
  }

  return {
    ok: false,
    kind: "missing",
    message: `Could not find a piw client. Tried ${triedLocations(packageBinary, env)}. ${installHint(expectedVersion)}`,
  };
}

export function piwPaneEnvironment(clientPath: string, socketPath?: string): string[] {
  const entries = [`${PIW_BIN_ENV}=${clientPath}`, `${PIW_NO_AUTOSTART_ENV}=1`];
  const socket = socketPath?.trim() ?? "";
  if (socket.length > 0) {
    entries.push(`${PIW_SOCKET_ENV}=${socket}`);
  }
  return entries;
}

function findPiWOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  for (const name of piwBinaryNames(platform)) {
    const found = findOnPath(name, env);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function inspectCandidate(
  file: string,
  source: PiwClientSource,
  expectedVersion: string,
  readVersion: ((file: string) => string | undefined) | undefined,
): PiwClientInspection {
  const version = (readVersion ?? readPiwVersion)(file);
  const check = checkPiwVersion(version, expectedVersion, file);
  if (check.compatible === false) {
    return { ok: false, kind: "mismatch", message: check.reason };
  }
  return { ok: true, path: file, source, version: check.version, expectedVersion };
}

function triedLocations(packageBinary: string | undefined, env: NodeJS.ProcessEnv): string {
  const locations = [
    packageBinary ?? "the package-local platform binary",
    `the PATH entries ${pathEntries(env).join(", ") || "(none)"}`,
  ];
  return locations.join(", then ");
}
