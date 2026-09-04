#!/usr/bin/env node
import { errorMessage } from "../workflows/errors.js";
import { WorkflowServer } from "./server.js";

async function main(): Promise<void> {
  const databaseIndex = process.argv.indexOf("--database");
  const databasePath = databaseIndex < 0 ? undefined : process.argv[databaseIndex + 1];
  const server = new WorkflowServer({
    ...(databasePath === undefined ? {} : { databasePath }),
    onLog: (message) => process.stderr.write(`[pi-workflows server] ${message}\n`),
  });
  const shutdown = () => void server.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.start();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
