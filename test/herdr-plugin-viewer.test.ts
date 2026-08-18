import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers.js";

const viewerScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/herdr/viewer.mjs",
);

describe("Herdr piw plugin launcher", () => {
  it("sets a discoverable title and opens the exact run bundle with argv", async () => {
    const temp = await makeTempDir("pi-workflows-herdr-viewer");
    const bin = path.join(temp, "bin");
    const runId = "20260818T120000Z-monitor-a1b2c3d4";
    const runDir = path.join(temp, runId);
    const herdrArgs = path.join(temp, "herdr-args.json");
    const piwArgs = path.join(temp, "piw-args.json");
    await fs.mkdir(bin);
    await fs.mkdir(runDir);
    await fs.writeFile(path.join(runDir, "manifest.json"), "{}\n");
    const herdr = path.join(bin, "herdr");
    const piw = path.join(bin, "piw");
    await fs.writeFile(
      herdr,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.HERDR_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await fs.writeFile(
      piw,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PIW_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await fs.chmod(herdr, 0o755);
    await fs.chmod(piw, 0o755);

    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "w1:p2",
        HERDR_ARGS_FILE: herdrArgs,
        PIW_ARGS_FILE: piwArgs,
        PI_WORKFLOWS_RUN_ID: runId,
        PI_WORKFLOWS_RUN_DIR: runDir,
      },
    });

    expect(result.status).toBe(0);
    await expect(fs.readFile(herdrArgs, "utf8").then(JSON.parse)).resolves.toEqual([
      "pane",
      "rename",
      "w1:p2",
      `piw · ${runId}`,
    ]);
    await expect(fs.readFile(piwArgs, "utf8").then(JSON.parse)).resolves.toEqual([runDir]);
  });

  it("rejects a run directory that does not match the run id", async () => {
    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_WORKFLOWS_RUN_ID: "run-one",
        PI_WORKFLOWS_RUN_DIR: "/tmp/run-two",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute bundle directory for the selected run");
  });
});
