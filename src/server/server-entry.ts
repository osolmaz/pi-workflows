#!/usr/bin/env node
import fs from "node:fs";
import { errorMessage } from "../workflows/errors.js";
import { WorkflowServer } from "./server.js";

async function main(): Promise<void> {
  const startupFd = process.env.PI_WORKFLOWS_STARTUP_FD === "3" ? 3 : undefined;
  const closeStartupChannel = (): void => {
    if (startupFd === undefined) return;
    try {
      fs.closeSync(startupFd);
    } catch {
      // The parent may have exited before startup settled.
    }
  };
  try {
    const databaseIndex = process.argv.indexOf("--database");
    const databasePath = databaseIndex < 0 ? undefined : process.argv[databaseIndex + 1];
    const server = new WorkflowServer({
      ...(databasePath === undefined ? {} : { databasePath }),
      ...(process.env.PI_WORKFLOWS_MAX_RUNNERS === undefined
        ? {}
        : { maxRunners: Number(process.env.PI_WORKFLOWS_MAX_RUNNERS) }),
      onLog: (message) => process.stderr.write(`[pi-workflows server] ${message}\n`),
    });
    const shutdown = () => void server.stop();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await server.start();
    closeStartupChannel();
  } catch (error) {
    const message = `${errorMessage(error)}\n`;
    if (startupFd === undefined) process.stderr.write(message);
    else {
      try {
        fs.writeSync(startupFd, message);
      } catch {
        // The parent may have exited before startup failed.
      }
      closeStartupChannel();
    }
    process.exitCode = 1;
  }
}

void main();
