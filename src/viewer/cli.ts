#!/usr/bin/env node
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteControllerStore } from "../controllers/sqlite.js";
import { projectControllerStoreBaseDir } from "../controllers/store.js";
import { sanitizeText } from "../render/ansi.js";
import { listRunBundles, readRunBundle, workflowRunsBaseDir } from "../workflows/store.js";
import {
  formatDuration,
  renderRunDetailLines,
  renderRunListLines,
  runElapsedMs,
  statusLabel,
} from "./render.js";
import { runViewer } from "./tui.js";

const USAGE = `pi-workflows — workflow runs and controller resources

Usage:
  pi-workflows view [runId] [--dir <runsDir>] [--once]
  pi-workflows runs [--dir <runsDir>]
  pi-workflows controllers [--controller-dir <dir>]
  pi-workflows controller <controller> <key> [--controller-dir <dir>]
  pi-workflows host [--project <dir>] [-- <extra pi args>]

Commands:
  view          Open the live workflow TUI. With --once, print a snapshot.
  runs          List recent workflow runs.
  controllers   List durable controller resources.
  controller    Show one resource, its effects, child workflows, and events.
  host          Run the always-on workflow host in the foreground.

Options:
  --dir <runsDir>          Runs directory (default: ~/.pi/agent/workflows/runs)
  --controller-dir <dir>  Controller directory (default: project-scoped local store)
  --once                   Render once without the interactive TUI
  --project <dir>          Project directory for the host (default: cwd)
`;

export type CliArgs = {
  command: string;
  runId?: string;
  controllerName?: string;
  resourceKey?: string;
  dir: string;
  controllerDir: string;
  once: boolean;
  project?: string | undefined;
  piArgs?: string[] | undefined;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "view";
  let dir = workflowRunsBaseDir();
  let controllerDir = projectControllerStoreBaseDir(process.cwd());
  let once = false;
  const positionals: string[] = [];
  let project: string | undefined;
  const piArgs: string[] = [];

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--dir") {
      dir = requiredValue(args, "--dir");
    } else if (arg === "--controller-dir") {
      controllerDir = requiredValue(args, "--controller-dir");
    } else if (arg === "--project") {
      project = requiredValue(args, "--project");
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", dir, controllerDir, once };
    } else if (arg === "--") {
      piArgs.push(...args.splice(0));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (command === "host") {
    return { command, dir, controllerDir, once, project, piArgs };
  }

  if (command === "controller") {
    if (positionals.length !== 2) {
      throw new Error("controller requires <controller> and <key>");
    }
    return {
      command,
      controllerName: positionals[0] as string,
      resourceKey: positionals[1] as string,
      dir,
      controllerDir,
      once,
    };
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  return {
    command,
    ...(positionals[0] !== undefined ? { runId: positionals[0] } : {}),
    dir,
    controllerDir,
    once,
  };
}

async function printRuns(dir: string): Promise<void> {
  const bundles = await listRunBundles(dir);
  if (bundles.length === 0) {
    process.stdout.write(`No workflow runs found in ${dir}\n`);
    return;
  }
  for (const bundle of bundles) {
    const state = bundle.state;
    const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
    process.stdout.write(
      `${statusLabel(state.status)}  ${sanitizeText(state.workflowName)}${title}  ${state.runId}  ${formatDuration(
        runElapsedMs(state),
      )}\n`,
    );
  }
}

async function printOnce(dir: string, runId: string | undefined): Promise<void> {
  const bundles = await listRunBundles(dir);
  const size = { width: process.stdout.columns ?? 100, height: 1_000 };
  if (runId === undefined) {
    process.stdout.write(`${renderRunListLines(bundles, 0, size).join("\n")}\n`);
    return;
  }
  const match = bundles.find((bundle) => bundle.state.runId === runId);
  if (!match) {
    throw new Error(`Run not found: ${runId}`);
  }
  const bundle = await readRunBundle(match.runDir, { includeTrace: true });
  if (!bundle) {
    throw new Error(`Run bundle unreadable: ${match.runDir}`);
  }
  process.stdout.write(`${renderRunDetailLines(bundle, size).join("\n")}\n`);
}

function printControllers(controllerDir: string): void {
  const store = openControllerStore(controllerDir);
  if (store === undefined) {
    process.stdout.write(`No controller resources found in ${controllerDir}\n`);
    return;
  }
  try {
    const resources = store.listResources();
    if (resources.length === 0) {
      process.stdout.write(`No controller resources found in ${controllerDir}\n`);
      return;
    }
    for (const resource of resources) {
      const condition =
        resource.status.conditions.find((item) => item.type === "Ready") ??
        resource.status.conditions[0];
      const conditionText =
        condition === undefined
          ? "unknown"
          : `${String(condition.status)}:${sanitizeText(condition.reason)}`;
      process.stdout.write(
        `${sanitizeText(resource.metadata.controller)}  ${sanitizeText(resource.metadata.key)}  generation=${resource.metadata.generation}  ready=${conditionText}\n`,
      );
    }
  } finally {
    store.close();
  }
}

function printController(controllerDir: string, controller: string, key: string): void {
  const store = openControllerStore(controllerDir);
  if (store === undefined) {
    throw new Error(`Controller store not found in ${controllerDir}`);
  }
  try {
    const resource = store.getResource({ controller, key });
    if (resource === undefined) {
      throw new Error(`Controller resource not found: ${controller}/${key}`);
    }
    const value = {
      resource,
      effects: store.listEffects(resource.metadata.uid),
      workflows: store.listWorkflows(resource.metadata.uid),
      events: store.listEvents({ controller, key, limit: 50 }),
    };
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    store.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  try {
    if (args.command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (args.command === "runs") {
      await printRuns(args.dir);
      return 0;
    }
    if (args.command === "controllers") {
      printControllers(args.controllerDir);
      return 0;
    }
    if (args.command === "controller") {
      printController(
        args.controllerDir,
        args.controllerName as string,
        args.resourceKey as string,
      );
      return 0;
    }
    if (args.command === "host") {
      return await runHost(args.project ?? process.cwd(), args.piArgs);
    }
    if (args.command === "view") {
      if (args.once || !process.stdout.isTTY) {
        await printOnce(args.dir, args.runId);
        return 0;
      }
      await runViewer({ runsDir: args.dir, runId: args.runId });
      return 0;
    }
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runHost(project: string, piArgs: string[] | undefined): Promise<number> {
  const { WorkflowHost } = await import("../host/runner.js");
  const host = new WorkflowHost({
    cwd: project,
    piArgs: piArgs ?? [],
    onLog: (message) => process.stdout.write(`[host] ${message}\n`),
  });
  await host.start();
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void host.stop().then(() => resolve());
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
  return 0;
}

function openControllerStore(controllerDir: string): SqliteControllerStore | undefined {
  const file = path.join(controllerDir, "controller.sqlite");
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return new SqliteControllerStore(file, { readOnly: true });
}

function requiredValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

const entryPath = process.argv[1];
const resolvedEntry = entryPath !== undefined ? realpathSyncSafe(entryPath) : undefined;
if (resolvedEntry !== undefined && import.meta.url === pathToFileURL(resolvedEntry).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}

function realpathSyncSafe(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
