#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const RESOLVER_PATH = "dist/herdr/client.js";
const RESOLVER_URL = new URL(`../../${RESOLVER_PATH}`, import.meta.url);
const FAILURE_LABEL_LIMIT = 60;

const runId = process.env.PI_WORKFLOWS_RUN_ID ?? "";
const paneId = process.env.HERDR_PANE_ID ?? "";
const configuredHerdr = process.env.HERDR_BIN_PATH ?? "herdr";
let herdr = configuredHerdr;

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(runId)) {
  failWithoutPane("PI_WORKFLOWS_RUN_ID is missing or invalid.");
}
if (!/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u.test(paneId)) {
  failWithoutPane("HERDR_PANE_ID is missing or invalid.");
}

// Resolve the client before anything else: a stale client must not look like a healthy pane.
const helper = await loadResolver();
const inspection = helper.inspectPiwClient({ env: process.env });
if (inspection.ok === false) {
  await failVisible(inspection.message);
}

const labeled = await renamePane(paneId, `piw · ${runId}`);
if (labeled.error !== undefined) {
  process.stderr.write(`Could not label the Herdr viewer pane: ${labeled.error.message}\n`);
  process.exit(1);
}
if (labeled.status !== 0) {
  process.stderr.write(
    `Could not label the Herdr viewer pane: ${bounded(labeled.stderr) || "unknown error"}\n`,
  );
  process.exit(1);
}

const viewer = spawn(inspection.path, [runId], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => viewer.kill(signal));
}
viewer.on("error", (error) => {
  void failVisible(`Could not start ${inspection.path}: ${error.message}`);
});
viewer.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

/**
 * The pane loads the resolver that ships with the package instead of repeating the resolution
 * order, so the pane and the Pi session can never disagree about which client is correct.
 */
async function loadResolver() {
  try {
    return await import(RESOLVER_URL.href);
  } catch (error) {
    await failVisible(
      `The piw client resolver could not be loaded from ${RESOLVER_PATH}: ${errorMessage(error)}. Reinstall @osolmaz/pi-workflows so the package ships its compiled files.`,
    );
  }
  return undefined;
}

/**
 * A pane that cannot run keeps its message on screen and states the failure in its label, so the
 * outcome stays visible in the pane title instead of a pane that closes.
 */
async function failVisible(reason) {
  await renamePane(paneId, `piw · failed · ${bounded(reason, FAILURE_LABEL_LIMIT)}`);
  process.stderr.write(`${reason}\n`);
  if (process.stdin.isTTY === true) {
    process.stderr.write("Press Enter to close this pane.\n");
    await once(process.stdin, "data");
    process.stdin.pause();
  }
  process.exit(1);
}

function failWithoutPane(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function renamePane(targetPaneId, targetLabel) {
  let result = rename(herdr, targetPaneId, targetLabel);
  if (result.error?.code === "ENOENT" && herdr !== "herdr") {
    herdr = "herdr";
    result = rename(herdr, targetPaneId, targetLabel);
  }
  return result;
}

function rename(command, targetPaneId, targetLabel) {
  return spawnSync(command, ["pane", "rename", targetPaneId, targetLabel], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value, limit = 300) {
  const compact = String(value ?? "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}
