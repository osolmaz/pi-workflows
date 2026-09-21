import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { piwPackageVersion } from "../src/herdr/client.js";
import { makeTempDir } from "./helpers.js";

const viewerScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/herdr/viewer.mjs",
);
const packageVersion = piwPackageVersion() ?? "";
const runId = "20260818T120000Z-monitor-a1b2c3d4";

async function writeExecutable(file: string, source: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
  await fs.chmod(file, 0o755);
  return file;
}

/** A client that records the run id it was launched with, and answers `--version` like the real one. */
async function writeClient(directory: string, version: string, argsFile: string): Promise<string> {
  return await writeExecutable(
    path.join(directory, "piw"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "--version") {
  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
}
process.stdout.write("piw ${version}\\n");
`,
  );
}

async function writeHerdr(directory: string, argsFile: string): Promise<string> {
  return await writeExecutable(
    path.join(directory, "herdr"),
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
`,
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function exists(file: string): Promise<boolean> {
  return await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

describe("Herdr piw plugin launcher", () => {
  it("labels the pane and opens the exact run id with the resolved client", async () => {
    const temp = await makeTempDir("pi-workflows-herdr-viewer");
    const herdrArgs = path.join(temp, "herdr-args.json");
    const piwArgs = path.join(temp, "piw-args.json");
    const herdr = await writeHerdr(path.join(temp, "bin"), herdrArgs);
    const client = await writeClient(path.join(temp, "client"), packageVersion, piwArgs);

    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "w1:p2",
        HERDR_ARGS_FILE: herdrArgs,
        PATH: process.env.PATH ?? "",
        PIW_BIN: client,
        PI_WORKFLOWS_RUN_ID: runId,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    await expect(readJson(herdrArgs)).resolves.toEqual([
      "pane",
      "rename",
      "w1:p2",
      `piw · ${runId}`,
    ]);
    await expect(readJson(piwArgs)).resolves.toEqual([runId]);
  });

  it("keeps a stale client visible with a failure label instead of running it", async () => {
    const temp = await makeTempDir("pi-workflows-herdr-viewer-stale");
    const herdrArgs = path.join(temp, "herdr-args.json");
    const piwArgs = path.join(temp, "piw-args.json");
    const herdr = await writeHerdr(path.join(temp, "bin"), herdrArgs);
    const stale = await writeClient(path.join(temp, "client"), "0.16.8", piwArgs);

    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "w1:p2",
        HERDR_ARGS_FILE: herdrArgs,
        PATH: process.env.PATH ?? "",
        PIW_BIN: stale,
        PI_WORKFLOWS_RUN_ID: runId,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.16.8");
    expect(result.stderr).toContain(packageVersion);
    expect(result.stderr).toContain(`cargo install pi-workflows --version ${packageVersion}`);
    // This harness has no terminal, so the pane prints the message and exits nonzero instead.
    expect(result.stderr).not.toContain("Press Enter to close this pane.");
    const label = (await readJson(herdrArgs)) as string[];
    expect(label.slice(0, 3)).toEqual(["pane", "rename", "w1:p2"]);
    expect(label[3]?.startsWith("piw · failed · ")).toBe(true);
    expect(await exists(piwArgs)).toBe(false);
  });

  it("keeps a missing client visible and names the install command", async () => {
    const temp = await makeTempDir("pi-workflows-herdr-viewer-missing");
    const herdrArgs = path.join(temp, "herdr-args.json");
    const herdr = await writeHerdr(path.join(temp, "bin"), herdrArgs);
    const pathWithoutPiw = path.join(temp, "path-without-piw");
    await fs.mkdir(pathWithoutPiw);
    await fs.symlink(process.execPath, path.join(pathWithoutPiw, "node"));

    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "w1:p2",
        HERDR_ARGS_FILE: herdrArgs,
        PATH: pathWithoutPiw,
        PI_WORKFLOWS_RUN_ID: runId,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not find a piw client.");
    expect(result.stderr).toContain(`cargo install pi-workflows --version ${packageVersion}`);
    const label = (await readJson(herdrArgs)) as string[];
    expect(label[3]?.startsWith("piw · failed · ")).toBe(true);
  });

  it("reports a resolver that is missing from the package", async () => {
    const temp = await makeTempDir("pi-workflows-herdr-viewer-unbuilt");
    const herdrArgs = path.join(temp, "herdr-args.json");
    const piwArgs = path.join(temp, "piw-args.json");
    const herdr = await writeHerdr(path.join(temp, "bin"), herdrArgs);
    const client = await writeClient(path.join(temp, "client"), packageVersion, piwArgs);
    const copiedViewer = await writeExecutable(
      path.join(temp, "plugins", "herdr", "viewer.mjs"),
      await fs.readFile(viewerScript, "utf8"),
    );

    const result = spawnSync(process.execPath, [copiedViewer], {
      encoding: "utf8",
      env: {
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: "w1:p2",
        HERDR_ARGS_FILE: herdrArgs,
        PATH: process.env.PATH ?? "",
        PIW_BIN: client,
        PI_WORKFLOWS_RUN_ID: runId,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/herdr/client.js");
    expect(result.stderr).toContain("Reinstall @osolmaz/pi-workflows");
    const label = (await readJson(herdrArgs)) as string[];
    expect(label[3]?.startsWith("piw · failed · ")).toBe(true);
  });

  it("rejects an invalid run id", () => {
    const result = spawnSync(process.execPath, [viewerScript], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        PI_WORKFLOWS_RUN_ID: "../bad",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PI_WORKFLOWS_RUN_ID is missing or invalid");
  });
});
