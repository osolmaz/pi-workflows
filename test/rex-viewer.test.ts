import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { viewerPaneLabel, type WorkflowViewTarget } from "../src/extension/herdr-viewer.js";
import { RexWorkflowViewer } from "../src/extension/rex-viewer.js";
import { piwPackageVersion } from "../src/herdr/client.js";
import { makeTempDir } from "./helpers.js";

let clientBinary = "";

beforeAll(async () => {
  const directory = await makeTempDir("piw-rex-viewer-client");
  clientBinary = path.join(directory, "piw");
  await fs.writeFile(
    clientBinary,
    `#!/usr/bin/env node\nprocess.stdout.write("piw ${piwPackageVersion() ?? ""}\\n");\n`,
  );
  await fs.chmod(clientBinary, 0o755);
});

const target: WorkflowViewTarget = {
  runId: "20260818T120000Z-monitor-a1b2c3d4",
  workflowName: "monitor",
};
const label = viewerPaneLabel(target.runId);

function rexEnv(): NodeJS.ProcessEnv {
  return { REX_BLOCK: "block:caller", PIW_BIN: clientBinary };
}

function harness(blocks: unknown[], created: unknown) {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push([...args]);
    const stdout = args[0] === "block" && args[1] === "ls" ? { blocks } : created;
    return {
      stdout: JSON.stringify(stdout),
      stderr: "",
      code: 0,
      killed: false,
    };
  };
  return { calls, exec };
}

describe("RexWorkflowViewer", () => {
  it("is selected only inside Rex and never inside Herdr", async () => {
    expect(RexWorkflowViewer.detects({})).toBe(false);
    expect(RexWorkflowViewer.detects({ REX_BLOCK: "block:a", HERDR_ENV: "1" })).toBe(false);
    expect(RexWorkflowViewer.detects(rexEnv())).toBe(true);
    const h = harness([], {});
    await expect(new RexWorkflowViewer(h.exec, {}).probe()).resolves.toEqual({
      available: false,
      reason: "Pi is not running in Rex.",
    });
    await expect(new RexWorkflowViewer(h.exec, rexEnv()).probe()).resolves.toEqual({
      available: true,
    });
    expect(h.calls).toEqual([]);
  });

  it("splits beside the caller with the piw client contract", async () => {
    const h = harness([], { block_ids: ["block:new"] });
    const viewer = new RexWorkflowViewer(h.exec, rexEnv(), () => "/tmp/server.sock");

    await expect(viewer.open(target, "left", "/work")).resolves.toEqual({
      paneId: "block:new",
      reused: false,
    });
    expect(h.calls[1]).toEqual([
      "split",
      "--split",
      "left",
      "-b",
      "block:caller",
      "--label",
      label,
      "--cwd",
      "/work",
      "--shell=none",
      "--keep-open",
      "--json",
      "--",
      "/usr/bin/env",
      `PIW_BIN=${clientBinary}`,
      "PIW_NO_AUTOSTART=1",
      "PIW_SOCKET=/tmp/server.sock",
      clientBinary,
      target.runId,
    ]);
  });

  it("focuses an existing viewer instead of opening a duplicate", async () => {
    const h = harness([{ block_id: "block:old", label }], {});
    const viewer = new RexWorkflowViewer(h.exec, rexEnv());

    await expect(viewer.open(target, "right", "/work")).resolves.toEqual({
      paneId: "block:old",
      reused: true,
    });
    expect(h.calls.at(-1)).toEqual(["block", "focus", "block:old"]);
  });

  it("opens a window for tab and a labeled session block for workspace", async () => {
    const tab = harness([], { block_ids: ["block:tab"] });
    await new RexWorkflowViewer(tab.exec, rexEnv()).open(target, "tab", "/work");
    expect(tab.calls[1]?.slice(0, 3)).toEqual(["run", "--label", label]);

    const session = harness([], {
      initial_windows: [{ block_ids: ["block:ws"] }],
    });
    await new RexWorkflowViewer(session.exec, rexEnv()).open(target, "workspace", "/work");
    expect(session.calls[1]?.slice(0, 2)).toEqual(["new", "piw · monitor"]);
    expect(session.calls[2]).toEqual(["block", "rename", "block:ws", label]);
  });
});
