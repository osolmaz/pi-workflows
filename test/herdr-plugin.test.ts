import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers.js";

const VIEWER_ENTRY = path.resolve("plugins/herdr/viewer.mjs");

async function writeFakeCommand(directory: string, name: string): Promise<void> {
  const commandPath = path.join(directory, name);
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(
  process.env.TEST_COMMAND_LOG,
  JSON.stringify({ command: path.basename(process.argv[1]), args: process.argv.slice(2) }) + "\\n",
);
`,
  );
  await fs.chmod(commandPath, 0o700);
}

describe("Herdr piw plugin", () => {
  it.skipIf(process.platform === "win32")(
    "uses PATH when Herdr provides a deleted executable path",
    async () => {
      const root = await makeTempDir("pi-workflows-herdr-plugin");
      const binaryDirectory = path.join(root, "bin");
      const commandLog = path.join(root, "commands.jsonl");
      await fs.mkdir(binaryDirectory);
      await Promise.all([
        writeFakeCommand(binaryDirectory, "herdr"),
        writeFakeCommand(binaryDirectory, "piw"),
      ]);

      const child = spawn(process.execPath, [VIEWER_ENTRY], {
        env: {
          HERDR_BIN_PATH: path.join(root, "removed-herdr"),
          HERDR_PANE_ID: "w1:p1",
          PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          PI_WORKFLOWS_RUN_ID: "20260903T120000Z-autoplan-test",
          TEST_COMMAND_LOG: commandLog,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const [code] = (await once(child, "close")) as [number | null];

      expect(code, stderr).toBe(0);
      const calls = (await fs.readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[] });
      expect(calls).toEqual([
        {
          command: "herdr",
          args: ["pane", "rename", "w1:p1", "piw · 20260903T120000Z-autoplan-test"],
        },
        { command: "piw", args: ["20260903T120000Z-autoplan-test"] },
      ]);
    },
  );
});
