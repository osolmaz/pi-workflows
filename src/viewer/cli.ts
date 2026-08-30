#!/usr/bin/env node
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SqliteControllerStore } from "../controllers/sqlite.js";
import { syncHerdrPlugin } from "../herdr/setup.js";
import { WorkflowHostClient } from "../host/client.js";
import { sanitizeText } from "../render/ansi.js";
import { StateDatabase } from "../state/database.js";
import { pruneState } from "../state/prune.js";
import { WorkflowRunStore, workflowStateDatabasePath } from "../workflows/store.js";
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
  pi-workflows view [runId] [--once]
  pi-workflows runs
  pi-workflows controllers
  pi-workflows controller <controller> <key>
  pi-workflows state status|verify
  pi-workflows state backup <destination>
  pi-workflows state prune --before <timestamp> --dry-run
  pi-workflows state prune --before <timestamp> --backup <absolute-path> --apply
  pi-workflows host start
  pi-workflows host status
  pi-workflows host stop
  pi-workflows host run [-- <extra pi args>]
  pi-workflows herdr sync [--json]
  pi-workflows herdr setup [--json]

All commands use ~/.pi/agent/workflows/state.sqlite.
`;

export type CliArgs = {
  command: string;
  runId?: string;
  controllerName?: string;
  resourceKey?: string;
  herdrAction?: string;
  hostAction?: "start" | "status" | "stop" | "run";
  stateAction?: "status" | "verify" | "backup" | "prune";
  backupDestination?: string;
  pruneBefore?: string;
  pruneApply?: boolean;
  once: boolean;
  json: boolean;
  piArgs?: string[] | undefined;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "view";
  let once = false;
  let json = false;
  let project: string | undefined;
  let pruneBefore: string | undefined;
  let backupDestination: string | undefined;
  let pruneApply = false;
  let pruneDryRun = false;
  const positionals: string[] = [];
  const piArgs: string[] = [];

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--project") project = requiredValue(args, "--project");
    else if (arg === "--before") pruneBefore = requiredValue(args, "--before");
    else if (arg === "--backup") backupDestination = requiredValue(args, "--backup");
    else if (arg === "--apply") pruneApply = true;
    else if (arg === "--dry-run") pruneDryRun = true;
    else if (arg === "--once") once = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return { command: "help", once, json };
    else if (arg === "--") piArgs.push(...args.splice(0));
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
    else positionals.push(arg);
  }

  if (command !== "herdr" && json) throw new Error("--json is available only for herdr sync");
  if (command === "host") {
    if (project !== undefined) throw new Error("The global host does not accept --project");
    const action = positionals[0];
    if (action !== "start" && action !== "status" && action !== "stop" && action !== "run") {
      throw new Error("host requires start, status, stop, or run");
    }
    if (positionals.length !== 1) throw new Error("host accepts one lifecycle action");
    if (piArgs.length > 0 && action !== "run") {
      throw new Error("Extra Pi arguments are available only for host run");
    }
    return { command, hostAction: action, once, json, piArgs };
  }
  if (command === "controller") {
    if (positionals.length !== 2) throw new Error("controller requires <controller> and <key>");
    return {
      command,
      controllerName: positionals[0] as string,
      resourceKey: positionals[1] as string,
      once,
      json,
    };
  }
  if (command === "state") {
    const action = positionals[0];
    if (action !== "status" && action !== "verify" && action !== "backup" && action !== "prune") {
      throw new Error("state requires status, verify, backup, or prune");
    }
    if (action === "prune") {
      if (positionals.length !== 1) throw new Error("state prune accepts no positional arguments");
      if (pruneBefore === undefined) throw new Error("state prune requires --before <timestamp>");
      if (pruneApply === pruneDryRun) {
        throw new Error("state prune requires exactly one of --dry-run or --apply");
      }
      if (pruneApply && backupDestination === undefined) {
        throw new Error("state prune --apply requires --backup <absolute-path>");
      }
      if (pruneDryRun && backupDestination !== undefined) {
        throw new Error("state prune --dry-run does not accept --backup");
      }
      return {
        command,
        stateAction: action,
        pruneBefore,
        pruneApply,
        ...(backupDestination === undefined ? {} : { backupDestination }),
        once,
        json,
      };
    }
    if (action === "backup") {
      if (positionals.length !== 2) throw new Error("state backup requires <destination>");
      return {
        command,
        stateAction: action,
        backupDestination: positionals[1] as string,
        once,
        json,
      };
    }
    if (positionals.length !== 1) throw new Error(`state ${action} accepts no other arguments`);
    return { command, stateAction: action, once, json };
  }
  if (command === "herdr") {
    if (positionals.length !== 1 || !["sync", "setup"].includes(positionals[0] as string)) {
      throw new Error("herdr requires the sync action");
    }
    return { command, herdrAction: positionals[0] as string, once, json };
  }
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  return {
    command,
    ...(positionals[0] === undefined ? {} : { runId: positionals[0] }),
    once,
    json,
  };
}

function printRuns(databasePath: string): void {
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    const runs = store.listRuns();
    if (runs.length === 0) {
      process.stdout.write("No workflow runs found.\n");
      return;
    }
    for (const run of runs) {
      const state = run.state;
      const title = state.runTitle ? ` — ${sanitizeText(state.runTitle)}` : "";
      process.stdout.write(
        `${statusLabel(state.status)}  ${sanitizeText(state.workflowName)}${title}  ${state.runId}  ${formatDuration(runElapsedMs(state))}\n`,
      );
    }
  } finally {
    store.close();
  }
}

function printOnce(databasePath: string, runId: string | undefined): void {
  const store = new WorkflowRunStore(databasePath, { readOnly: true });
  try {
    const size = { width: process.stdout.columns ?? 100, height: 1_000 };
    if (runId === undefined) {
      process.stdout.write(`${renderRunListLines(store.listRuns(), 0, size).join("\n")}\n`);
      return;
    }
    const run = store.readRun(runId, { includeTrace: true });
    if (run === null) throw new Error(`Run not found: ${runId}`);
    process.stdout.write(`${renderRunDetailLines(run, size).join("\n")}\n`);
  } finally {
    store.close();
  }
}

function printControllers(databasePath: string): void {
  const store = openControllerStore(databasePath);
  if (store === undefined) {
    process.stdout.write("No controller resources found.\n");
    return;
  }
  try {
    const resources = store.listResources();
    if (resources.length === 0) {
      process.stdout.write("No controller resources found.\n");
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

function printController(databasePath: string, controller: string, key: string): void {
  const store = openControllerStore(databasePath);
  if (store === undefined) throw new Error("Controller state database not found");
  try {
    const resource = store.getResource({ controller, key });
    if (resource === undefined)
      throw new Error(`Controller resource not found: ${controller}/${key}`);
    process.stdout.write(
      `${JSON.stringify(
        {
          resource,
          effects: store.listEffects(resource.metadata.uid),
          workflows: store.listWorkflows(resource.metadata.uid),
          events: store.listEvents({ controller, key, limit: 50 }),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    store.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const databasePath = workflowStateDatabasePath();
  try {
    if (args.command === "runs") {
      printRuns(databasePath);
      return 0;
    }
    if (args.command === "controllers") {
      printControllers(databasePath);
      return 0;
    }
    if (args.command === "controller") {
      printController(databasePath, args.controllerName as string, args.resourceKey as string);
      return 0;
    }
    if (args.command === "state") {
      await runStateCommand(databasePath, args);
      return 0;
    }
    if (args.command === "host") {
      return await runHost(args.hostAction as "start" | "status" | "stop" | "run", args.piArgs);
    }
    if (args.command === "herdr") {
      const result = syncHerdrPlugin(packageRoot());
      process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
      return 0;
    }
    if (args.command === "view") {
      if (args.once || !process.stdout.isTTY) printOnce(databasePath, args.runId);
      else await runViewer({ databasePath, runId: args.runId });
      return 0;
    }
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runStateCommand(databasePath: string, args: CliArgs): Promise<void> {
  if (args.stateAction === "prune") {
    const report = await pruneState(databasePath, {
      before: args.pruneBefore as string,
      apply: args.pruneApply === true,
      ...(args.backupDestination === undefined ? {} : { backupPath: args.backupDestination }),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (args.stateAction === "backup") {
    const state = new StateDatabase({ filePath: databasePath });
    try {
      await state.backup(path.resolve(args.backupDestination as string));
      process.stdout.write(`Backup verified: ${path.resolve(args.backupDestination as string)}\n`);
    } finally {
      state.close();
    }
    return;
  }
  const state = new StateDatabase({ filePath: databasePath, mode: "read-only" });
  try {
    state.integrityCheck();
    if (args.stateAction === "verify") {
      process.stdout.write("SQLite state is valid.\n");
      return;
    }
    const counts = state.connection
      .prepare(
        `SELECT
           (SELECT count(*) FROM runs) AS runs,
           (SELECT count(*) FROM controller_resources) AS controllers,
           (SELECT count(*) FROM human_decisions) AS decisions,
           (SELECT count(*) FROM workflow_settings) AS settingsScopes,
           (SELECT count(*) FROM workflow_follow_ups WHERE status IN ('queued', 'pending_presentation', 'ready')) AS pendingFollowUps,
           (SELECT count(*) FROM effects WHERE status IN ('pending', 'applying', 'ambiguous')) AS unsettledEffects,
           (SELECT count(*) FROM leases
            WHERE owner_id IS NOT NULL AND expires_at > ?) AS activeLeases`,
      )
      .get(Date.now());
    process.stdout.write(
      `Database: ${databasePath}\nSize: ${fs.statSync(databasePath).size} bytes\n${JSON.stringify(counts)}\n`,
    );
  } finally {
    state.close();
  }
}

async function runHost(
  action: "start" | "status" | "stop" | "run",
  piArgs: string[] | undefined,
): Promise<number> {
  if (action === "run") {
    const { WorkflowHost } = await import("../host/runner.js");
    const host = new WorkflowHost({
      piArgs: piArgs ?? [],
      onLog: (message) => process.stdout.write(`[host] ${message}\n`),
    });
    await host.start();
    await new Promise<void>((resolve) => {
      const shutdown = () => void host.stop().then(resolve);
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
    return 0;
  }
  const client = new WorkflowHostClient();
  if (action === "start") {
    const response = await client.ensureRunning();
    process.stdout.write(`${JSON.stringify(response.receipt ?? {})}\n`);
    return response.outcome === "accepted" || response.outcome === "adopted" ? 0 : 1;
  }
  const response = await client.request({
    operation: action === "status" ? "host.status" : "host.stop",
  });
  process.stdout.write(`${JSON.stringify(response.receipt ?? {})}\n`);
  return response.outcome === "accepted" || response.outcome === "adopted" ? 0 : 1;
}

function openControllerStore(databasePath: string): SqliteControllerStore | undefined {
  if (!fs.existsSync(databasePath)) return undefined;
  return new SqliteControllerStore(databasePath, { readOnly: true });
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function requiredValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value) throw new Error(`${option} requires a path`);
  return value;
}

const entryPath = process.argv[1];
const resolvedEntry = entryPath === undefined ? undefined : realpathSyncSafe(entryPath);
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
