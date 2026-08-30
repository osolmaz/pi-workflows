#!/usr/bin/env node
import { errorMessage } from "../workflows/errors.js";
import { WorkflowHost } from "./runner.js";

async function main(): Promise<void> {
  const databaseIndex = process.argv.indexOf("--database");
  const databasePath = databaseIndex < 0 ? undefined : process.argv[databaseIndex + 1];
  const host = new WorkflowHost({
    ...(databasePath === undefined ? {} : { databasePath }),
    onLog: (message) => process.stderr.write(`[pi-workflows host] ${message}\n`),
  });
  const shutdown = () => void host.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await host.start();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
