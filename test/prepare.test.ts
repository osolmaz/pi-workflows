import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("package preparation", () => {
  it("makes the generated command executable", { timeout: 30_000 }, () => {
    if (process.platform === "win32") return;
    const packageRoot = mkdtempSync(path.join(tmpdir(), "pi-workflows-prepare-"));

    try {
      for (const entry of [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src",
        "scripts",
      ]) {
        cpSync(path.join(repoRoot, entry), path.join(packageRoot, entry), { recursive: true });
      }
      symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(packageRoot, "node_modules"),
        "dir",
      );

      execFileSync(process.execPath, ["scripts/prepare.mjs"], {
        cwd: packageRoot,
        stdio: "pipe",
      });

      expect(statSync(path.join(packageRoot, "dist", "viewer", "cli.js")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});
