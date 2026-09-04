#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkflowClient } from "../client/client.js";
import { materializeRunView } from "../client/materialize.js";
import { syncHerdrPlugin } from "../herdr/setup.js";
import type { JsonValue } from "../state/json.js";
import { verifyInactiveBackup } from "./backup.js";
import { renderClientView, runViewer } from "./tui.js";

const CLI_CLIENT_ID = "pi-workflows-cli";

const USAGE = `pi-workflows — workflow runs and managed resources

Usage:
  pi-workflows view [runId] [--once]
  pi-workflows runs
  pi-workflows resource-managers
  pi-workflows resource-manager <resource-manager> <key>
  pi-workflows state status
  pi-workflows state verify [inactive-backup]
  pi-workflows state backup <destination>
  pi-workflows state prune --before <timestamp> --dry-run
  pi-workflows state prune --before <timestamp> --backup <absolute-path> --apply
  pi-workflows server start
  pi-workflows server status
  pi-workflows server stop
  pi-workflows server run [-- <extra pi args>]
  pi-workflows herdr sync [--json]
  pi-workflows herdr setup [--json]

Active state is available only through the package-owned workflow server.
`;

export type CliArgs = {
  command: string;
  runId?: string;
  resourceManagerName?: string;
  resourceKey?: string;
  herdrAction?: string;
  serverAction?: "start" | "status" | "stop" | "run";
  stateAction?: "status" | "verify" | "backup" | "prune";
  backupDestination?: string;
  verifyBackup?: string;
  pruneBefore?: string;
  pruneApply?: boolean;
  once: boolean;
  json: boolean;
  piArgs?: string[] | undefined;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "view";
  if (
    ![
      "view",
      "runs",
      "resource-managers",
      "resource-manager",
      "state",
      "server",
      "herdr",
      "help",
    ].includes(command)
  ) {
    throw new Error(`Unknown command: ${command}`);
  }
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
  if (command === "server") {
    if (project !== undefined) throw new Error("The global server does not accept --project");
    const action = positionals[0];
    if (action !== "start" && action !== "status" && action !== "stop" && action !== "run") {
      throw new Error("server requires start, status, stop, or run");
    }
    if (positionals.length !== 1) throw new Error("server accepts one lifecycle action");
    if (piArgs.length > 0 && action !== "run") {
      throw new Error("Extra Pi arguments are available only for server run");
    }
    return { command, serverAction: action, once, json, piArgs };
  }
  if (command === "resource-manager") {
    if (positionals.length !== 2)
      throw new Error("resource-manager requires <resource-manager> and <key>");
    return {
      command,
      resourceManagerName: positionals[0] as string,
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
    if (action === "verify") {
      if (positionals.length > 2) throw new Error("state verify accepts one inactive backup path");
      return {
        command,
        stateAction: action,
        ...(positionals[1] === undefined ? {} : { verifyBackup: positionals[1] }),
        once,
        json,
      };
    }
    if (positionals.length !== 1) throw new Error(`state ${action} accepts no other arguments`);
    return { command, stateAction: action, once, json };
  }
  if (command === "herdr") {
    if (positionals.length !== 1 || !["sync", "setup"].includes(positionals[0] as string)) {
      throw new Error("herdr requires the sync or setup action");
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    if (args.command === "server") {
      return await runServer(args.serverAction as "start" | "status" | "stop" | "run", args.piArgs);
    }
    if (args.command === "herdr") {
      const result = syncHerdrPlugin(packageRoot());
      process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
      return 0;
    }
    if (
      args.command === "state" &&
      args.stateAction === "verify" &&
      args.verifyBackup !== undefined
    ) {
      verifyInactiveBackup(args.verifyBackup);
      process.stdout.write(`Inactive SQLite backup is valid: ${path.resolve(args.verifyBackup)}\n`);
      return 0;
    }

    if (
      args.command === "state" &&
      args.stateAction === "prune" &&
      args.backupDestination !== undefined &&
      !path.isAbsolute(args.backupDestination)
    ) {
      throw new Error("state prune backup path must be absolute");
    }

    const client = new WorkflowClient({ clientId: CLI_CLIENT_ID });
    try {
      await client.ensureRunning();
      if (args.command === "runs") {
        const runs = await firstRunsView(client);
        printJsonLines(runs);
        return 0;
      }
      if (args.command === "resource-managers" || args.command === "resource-manager") {
        const response = await client.request({
          operation:
            args.command === "resource-managers" ? "resourceManager.list" : "resourceManager.get",
          payload: {
            projectPath: process.cwd(),
            ...(args.command === "resource-manager"
              ? {
                  resourceManager: args.resourceManagerName as string,
                  key: args.resourceKey as string,
                }
              : {}),
          },
        });
        requireAccepted(response);
        process.stdout.write(`${JSON.stringify(response.receipt ?? null, null, 2)}\n`);
        return 0;
      }
      if (args.command === "state") {
        await runStateCommand(client, args);
        return 0;
      }
      if (args.command === "view") {
        if (args.once || !process.stdout.isTTY) {
          const view =
            args.runId === undefined
              ? await firstRunsView(client)
              : await firstRunView(client, args.runId);
          process.stdout.write(
            `${renderClientView(view, process.stdout.columns ?? 100, Number.MAX_SAFE_INTEGER, 0, 0).join("\n")}\n`,
          );
        } else {
          await runViewer({ client, runId: args.runId });
        }
        return 0;
      }
    } finally {
      await client.close();
    }
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

async function runStateCommand(client: WorkflowClient, args: CliArgs): Promise<void> {
  const operation =
    args.stateAction === "status"
      ? "state.status"
      : args.stateAction === "verify"
        ? "state.verify"
        : args.stateAction === "backup"
          ? "state.backup"
          : "state.prune";
  const payload: JsonValue =
    args.stateAction === "backup"
      ? { destination: path.resolve(args.backupDestination as string) }
      : args.stateAction === "prune"
        ? {
            before: args.pruneBefore as string,
            apply: args.pruneApply === true,
            ...(args.backupDestination === undefined
              ? {}
              : { backupPath: path.resolve(args.backupDestination) }),
          }
        : {};
  const durable =
    args.stateAction === "backup" || (args.stateAction === "prune" && args.pruneApply === true);
  const idempotencyKey = durable ? `state-${randomUUID()}` : undefined;
  const response =
    idempotencyKey === undefined
      ? await client.request({ operation, payload })
      : await client.requestDurable({ operation, payload, idempotencyKey });
  requireAccepted(response);
  process.stdout.write(`${JSON.stringify(response.receipt ?? {})}\n`);
}

async function runServer(
  action: "start" | "status" | "stop" | "run",
  piArgs: string[] | undefined,
): Promise<number> {
  if (action === "run") {
    const { WorkflowServer } = await import("../server/server.js");
    const server = new WorkflowServer({
      piArgs: piArgs ?? [],
      onLog: (message) => process.stdout.write(`[server] ${message}\n`),
    });
    await server.start();
    await new Promise<void>((resolve) => {
      const shutdown = () => void server.stop().then(resolve);
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
    return 0;
  }
  const client = new WorkflowClient({ clientId: CLI_CLIENT_ID });
  try {
    const response =
      action === "start"
        ? await client.ensureRunning()
        : await client.request({
            operation: action === "status" ? "server.status" : "server.stop",
          });
    process.stdout.write(`${JSON.stringify(response.receipt ?? {})}\n`);
    return response.outcome === "accepted" || response.outcome === "adopted" ? 0 : 1;
  } finally {
    await client.close();
  }
}

async function firstRunsView(client: WorkflowClient): Promise<JsonValue> {
  return await firstSubscriptionEvent((listener) => client.watchRuns(listener));
}

export async function firstRunView(client: WorkflowClient, runId: string): Promise<JsonValue> {
  const view = await client.getRun(runId);
  if (view === null) throw new Error(`Workflow run not found: ${runId}`);
  return await materializeRunView(client, view);
}

async function firstSubscriptionEvent(
  subscribe: (listener: (event: { payload: JsonValue }) => void) => Promise<() => Promise<void>>,
): Promise<JsonValue> {
  let resolveEvent!: (value: JsonValue) => void;
  const event = new Promise<JsonValue>((resolve) => {
    resolveEvent = resolve;
  });
  const unsubscribe = await subscribe((received) => resolveEvent(received.payload));
  try {
    return await event;
  } finally {
    await unsubscribe();
  }
}

function printJsonLines(value: JsonValue): void {
  if (!Array.isArray(value) || value.length === 0) {
    process.stdout.write("No workflow runs found.\n");
    return;
  }
  for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
}

function requireAccepted(response: { outcome: string; error?: string }): void {
  if (response.outcome !== "accepted" && response.outcome !== "adopted") {
    throw new Error(response.error ?? `Workflow server returned ${response.outcome}`);
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function requiredValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value) throw new Error(`${option} requires a path`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
