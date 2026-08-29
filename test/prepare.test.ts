import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "viewer", "cli.js");

describe("package preparation", () => {
  it("makes the generated command executable", { timeout: 30_000 }, () => {
    if (process.platform === "win32") return;
    rmSync(cliPath, { force: true });

    execFileSync(process.execPath, ["scripts/prepare.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    expect(statSync(cliPath).mode & 0o111).not.toBe(0);
  });
});
