#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { listRunBundles, readRunBundle, workflowRunsBaseDir } from "../workflows/store.js";
import {
  formatDuration,
  renderRunDetailLines,
  renderRunListLines,
  runElapsedMs,
  statusLabel,
} from "./render.js";
import { runViewer } from "./tui.js";

const USAGE = `pi-workflows — live terminal viewer for pi workflow runs

Usage:
  pi-workflows view [runId] [--dir <runsDir>] [--once]
  pi-workflows runs [--dir <runsDir>]

Commands:
  view   Open the live TUI viewer. With --once, print a snapshot and exit.
  runs   List recent workflow runs.

Options:
  --dir <runsDir>   Runs directory (default: ~/.pi/agent/workflows/runs)
  --once            Render once to stdout without the interactive TUI
`;

type CliArgs = {
  command: string;
  runId?: string | undefined;
  dir: string;
  once: boolean;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "view";
  let dir = workflowRunsBaseDir();
  let once = false;
  let runId: string | undefined;

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--dir") {
      const value = args.shift();
      if (!value) {
        throw new Error("--dir requires a path");
      }
      dir = value;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", dir, once };
    } else if (!arg.startsWith("-") && runId === undefined) {
      runId = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, runId, dir, once };
}

async function printRuns(dir: string): Promise<void> {
  const bundles = await listRunBundles(dir);
  if (bundles.length === 0) {
    process.stdout.write(`No workflow runs found in ${dir}\n`);
    return;
  }
  for (const bundle of bundles) {
    const state = bundle.state;
    const title = state.runTitle ? ` — ${state.runTitle}` : "";
    process.stdout.write(
      `${statusLabel(state.status)}  ${state.workflowName}${title}  ${state.runId}  ${formatDuration(
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
  const bundle = await readRunBundle(match.runDir);
  if (!bundle) {
    throw new Error(`Run bundle unreadable: ${match.runDir}`);
  }
  process.stdout.write(`${renderRunDetailLines(bundle, size).join("\n")}\n`);
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

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
