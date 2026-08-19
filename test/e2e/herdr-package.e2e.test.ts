import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("packed Herdr plugin synchronization", () => {
  it("runs from packed hoisted and nested package layouts with spaces", async () => {
    const temp = await makeTempDir("pi-workflows-packed-herdr");
    const packs = path.join(temp, "packs");
    const bin = path.join(temp, "fake bin");
    await fs.mkdir(packs);
    await fs.mkdir(bin);

    const sourceManifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };
    const archiveName = execFileSync("npm", ["pack", "--silent", "--pack-destination", packs], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const archive = path.join(packs, archiveName.split("\n").at(-1) as string);
    const herdr = path.join(bin, "herdr");
    await fs.writeFile(
      herdr,
      `#!/usr/bin/env node\nconst path = require("node:path");\nconst root = process.env.TEST_PLUGIN_ROOT;\nconst pkg = require(path.join(root, "package.json"));\nprocess.stdout.write(JSON.stringify({ result: { plugins: [{ plugin_id: "osolmaz.pi-workflows", plugin_root: root, manifest_path: path.join(root, "herdr-plugin.toml"), version: pkg.version, enabled: true }] } }));\n`,
    );
    await fs.chmod(herdr, 0o755);

    const packageRoots = [
      path.join(temp, "hoisted install with spaces", "node_modules", "@osolmaz", "pi-workflows"),
      path.join(
        temp,
        "workspace with spaces",
        "packages",
        "wrapper",
        "node_modules",
        "@osolmaz",
        "pi-workflows",
      ),
    ];

    for (const [index, packageRoot] of packageRoots.entries()) {
      const extract = path.join(temp, `extract-${index}`);
      await fs.mkdir(extract);
      execFileSync("tar", ["-xzf", archive, "-C", extract]);
      await fs.mkdir(path.dirname(packageRoot), { recursive: true });
      await fs.rename(path.join(extract, "package"), packageRoot);
      await fs.symlink(path.join(repoRoot, "node_modules"), path.join(packageRoot, "node_modules"));

      const result = spawnSync(
        process.execPath,
        [path.join(packageRoot, "dist", "viewer", "cli.js"), "herdr", "sync", "--json"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            TEST_PLUGIN_ROOT: packageRoot,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "pi-workflows.herdr-sync.v1",
        status: "unchanged",
        changed: false,
        expectedVersion: sourceManifest.version,
        effectiveVersion: sourceManifest.version,
        enabled: true,
      });
      await expect(fs.stat(path.join(packageRoot, "herdr-plugin.toml"))).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(packageRoot, "plugins", "herdr", "viewer.mjs")),
      ).resolves.toBeDefined();
    }
  });
});
