import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_TEMP_ROOT_ENV = "PI_WORKFLOWS_TEST_TEMP_ROOT";

let ownedRoot: string | undefined;
let previousRoot: string | undefined;
let previousConfigDir: string | undefined;

export function setup(): void {
  previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  if (previousRoot !== undefined) return;

  ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflows-tests-"));
  process.env[TEST_TEMP_ROOT_ENV] = ownedRoot;
  previousConfigDir = process.env.PI_WORKFLOWS_CONFIG_DIR;
  process.env.PI_WORKFLOWS_CONFIG_DIR = path.join(ownedRoot, "config");
}

export function teardown(): void {
  if (ownedRoot !== undefined) {
    fs.rmSync(ownedRoot, { force: true, recursive: true });
    ownedRoot = undefined;
  }
  if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
  if (previousConfigDir === undefined) delete process.env.PI_WORKFLOWS_CONFIG_DIR;
  else process.env.PI_WORKFLOWS_CONFIG_DIR = previousConfigDir;
  previousRoot = undefined;
  previousConfigDir = undefined;
}
