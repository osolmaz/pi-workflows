#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const runId = process.env.PI_WORKFLOWS_RUN_ID ?? "";
const runDir = process.env.PI_WORKFLOWS_RUN_DIR ?? "";

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(runId)) {
  fail("PI_WORKFLOWS_RUN_ID is missing or invalid.");
}
if (!path.isAbsolute(runDir) || path.basename(runDir) !== runId) {
  fail("PI_WORKFLOWS_RUN_DIR must be the absolute bundle directory for the selected run.");
}
if (!fs.existsSync(path.join(runDir, "manifest.json"))) {
  fail(`Workflow bundle not found: ${runDir}`);
}

const paneId = process.env.HERDR_PANE_ID ?? "";
if (!/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u.test(paneId)) {
  fail("HERDR_PANE_ID is missing or invalid.");
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const label = `piw · ${runId}`;
const labeled = spawnSync(herdr, ["pane", "rename", paneId, label], {
  encoding: "utf8",
  stdio: ["ignore", "ignore", "pipe"],
});
if (labeled.error) fail(`Could not label the Herdr viewer pane: ${labeled.error.message}`);
if (labeled.status !== 0) {
  fail(`Could not label the Herdr viewer pane: ${bounded(labeled.stderr) || "unknown error"}`);
}

const viewer = spawn("piw", [runDir], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => viewer.kill(signal));
}
viewer.on("error", (error) => fail(`Could not start piw: ${error.message}`));
viewer.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function bounded(value) {
  const compact = String(value ?? "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`;
}
