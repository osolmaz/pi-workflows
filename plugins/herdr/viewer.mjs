#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const runId = process.env.PI_WORKFLOWS_RUN_ID ?? "";

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(runId)) {
  fail("PI_WORKFLOWS_RUN_ID is missing or invalid.");
}
const paneId = process.env.HERDR_PANE_ID ?? "";
if (!/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u.test(paneId)) {
  fail("HERDR_PANE_ID is missing or invalid.");
}

const configuredHerdr = process.env.HERDR_BIN_PATH ?? "herdr";
const label = `piw · ${runId}`;
let herdr = configuredHerdr;
let labeled = renamePane(herdr, paneId, label);
if (labeled.error?.code === "ENOENT" && herdr !== "herdr") {
  herdr = "herdr";
  labeled = renamePane(herdr, paneId, label);
}
if (labeled.error) fail(`Could not label the Herdr viewer pane: ${labeled.error.message}`);
if (labeled.status !== 0) {
  fail(`Could not label the Herdr viewer pane: ${bounded(labeled.stderr) || "unknown error"}`);
}

const viewer = spawn("piw", [runId], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => viewer.kill(signal));
}
viewer.on("error", (error) => fail(`Could not start piw: ${error.message}`));
viewer.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

function renamePane(command, targetPaneId, targetLabel) {
  return spawnSync(command, ["pane", "rename", targetPaneId, targetLabel], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

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
