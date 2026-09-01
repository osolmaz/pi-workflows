import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_TEMP_ROOT_ENV = "PI_WORKFLOWS_TEST_TEMP_ROOT";

let ownedRoot: string | undefined;
let previousRoot: string | undefined;

export function setup(): void {
  previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  if (previousRoot !== undefined) return;

  ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflows-tests-"));
  process.env[TEST_TEMP_ROOT_ENV] = ownedRoot;
}

export function teardown(): void {
  if (ownedRoot !== undefined) {
    fs.rmSync(ownedRoot, { force: true, recursive: true });
    ownedRoot = undefined;
  }
  if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
  previousRoot = undefined;
}
