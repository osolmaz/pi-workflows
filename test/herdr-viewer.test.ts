import { describe, expect, it } from "vitest";
import {
  HerdrWorkflowViewer,
  parseViewerPlacement,
  PIW_SHORTCUT,
  viewerPaneLabel,
  type WorkflowViewTarget,
} from "../src/extension/herdr-viewer.js";

const target: WorkflowViewTarget = {
  runId: "20260818T120000Z-monitor-a1b2c3d4",
  workflowName: "monitor",
  runDir: "/tmp/runs/20260818T120000Z-monitor-a1b2c3d4",
};

type Call = { command: string; args: string[] };
type Reply = { stdout?: string; stderr?: string; code?: number; killed?: boolean };

function execHarness(respond: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const exec = async (command: string, args: string[]) => {
    const call = { command, args: [...args] };
    calls.push(call);
    const reply = await respond(call);
    return {
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      code: reply.code ?? 0,
      killed: reply.killed ?? false,
    };
  };
  return { calls, exec };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function currentPane() {
  return {
    id: "current",
    result: {
      type: "pane_current",
      pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
    },
  };
}

function snapshot(panes: unknown[] = []) {
  return { id: "snapshot", result: { type: "snapshot", snapshot: { panes } } };
}

function openedPane(paneId = "w1:p2", tabId = "w1:t1", workspaceId = "w1") {
  return {
    id: "open",
    result: {
      type: "plugin_pane_opened",
      plugin_pane: {
        pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId },
      },
    },
  };
}

function commandKey(call: Call): string {
  return `${call.command} ${call.args.join(" ")}`;
}

describe("HerdrWorkflowViewer", () => {
  it("does no work outside Herdr", async () => {
    const harness = execHarness(() => ({}));
    const viewer = new HerdrWorkflowViewer(harness.exec, {});

    await expect(viewer.probe()).resolves.toEqual({
      available: false,
      reason: "Pi is not running in Herdr.",
    });
    expect(harness.calls).toEqual([]);
  });

  it("checks the caller, linked plugin, and piw", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin list")) {
        return {
          stdout: json({
            result: {
              plugins: [{ plugin_id: "osolmaz.pi-workflows", enabled: true }],
            },
          }),
        };
      }
      if (key === "piw --version") return { stdout: "piw 0.1.0\n" };
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.probe()).resolves.toEqual({ available: true });
    expect(harness.calls.map(commandKey)).toEqual([
      "herdr pane current --current",
      "herdr plugin list --plugin osolmaz.pi-workflows --json",
      "piw --version",
    ]);
  });

  it("reports unavailable plugin, piw, and malformed Herdr responses", async () => {
    const missingPlugin = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin list")) {
        return {
          stdout: json({
            result: {
              plugins: [
                { plugin_id: "osolmaz.pi-workflows", enabled: false },
                { plugin_id: "other.plugin", enabled: true },
                null,
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected command: ${key}`);
    });
    await expect(
      new HerdrWorkflowViewer(missingPlugin.exec, { HERDR_ENV: "1" }).probe(),
    ).resolves.toEqual({
      available: false,
      reason: "Herdr plugin osolmaz.pi-workflows is not linked and enabled.",
    });

    const missingPiw = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin list")) {
        return {
          stdout: json({
            result: { plugins: [{ plugin_id: "osolmaz.pi-workflows", enabled: true }] },
          }),
        };
      }
      if (key === "piw --version") return { code: 1, stderr: "piw missing" };
      throw new Error(`Unexpected command: ${key}`);
    });
    await expect(
      new HerdrWorkflowViewer(missingPiw.exec, { HERDR_ENV: "1" }).probe(),
    ).resolves.toEqual({ available: false, reason: "piw failed: piw missing" });

    const malformed = execHarness(() => ({ stdout: "not json" }));
    await expect(
      new HerdrWorkflowViewer(malformed.exec, { HERDR_ENV: "1" }).probe(),
    ).resolves.toEqual({ available: false, reason: "herdr returned invalid JSON." });
  });

  it("bounds command, timeout, and malformed snapshot failures", async () => {
    const killed = execHarness(() => ({ killed: true }));
    await expect(new HerdrWorkflowViewer(killed.exec, { HERDR_ENV: "1" }).probe()).resolves.toEqual(
      { available: false, reason: "herdr timed out." },
    );

    const large = execHarness(() => ({ stdout: "x".repeat(1_000_001) }));
    await expect(new HerdrWorkflowViewer(large.exec, { HERDR_ENV: "1" }).probe()).resolves.toEqual({
      available: false,
      reason: "herdr returned too much data.",
    });

    const missingPanes = execHarness(() => ({ stdout: json({ result: { snapshot: {} } }) }));
    await expect(
      new HerdrWorkflowViewer(missingPanes.exec, { HERDR_ENV: "1" }).find(target),
    ).rejects.toThrow("snapshot has no panes");

    const longFailure = execHarness(() => ({ code: 1, stderr: "x".repeat(400) }));
    const capability = await new HerdrWorkflowViewer(longFailure.exec, {
      HERDR_ENV: "1",
    }).probe();
    expect(capability.available).toBe(false);
    if (!capability.available) {
      expect(capability.reason.length).toBeLessThan(330);
      expect(capability.reason).toMatch(/…$/u);
    }
  });

  it("opens right and below splits with exact argv and run environment", async () => {
    for (const placement of ["right", "below"] as const) {
      const harness = execHarness((call) => {
        const key = commandKey(call);
        if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
        if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
        if (key.includes("plugin pane open")) return { stdout: json(openedPane()) };
        throw new Error(`Unexpected command: ${key}`);
      });
      const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

      await expect(viewer.open(target, placement, "/repo")).resolves.toEqual({
        paneId: "w1:p2",
        reused: false,
      });
      const open = harness.calls.find(
        (call) => call.args.slice(0, 3).join(" ") === "plugin pane open",
      );
      expect(open?.command).toBe("herdr");
      expect(open?.args).toContain(`PI_WORKFLOWS_RUN_ID=${target.runId}`);
      expect(open?.args).toContain(`PI_WORKFLOWS_RUN_DIR=${target.runDir}`);
      expect(open?.args).toContain("--target-pane");
      expect(open?.args.at(-1)).toBe(placement === "below" ? "down" : "right");
    }
  });

  it("places left and above by splitting and swapping explicit panes", async () => {
    for (const placement of ["left", "above"] as const) {
      const harness = execHarness((call) => {
        const key = commandKey(call);
        if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
        if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
        if (key.includes("plugin pane open")) return { stdout: json(openedPane()) };
        if (key === "herdr pane swap --source-pane w1:p2 --target-pane w1:p1") return {};
        throw new Error(`Unexpected command: ${key}`);
      });
      const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

      await viewer.open(target, placement, "/repo");
      expect(harness.calls.map(commandKey)).toContain(
        "herdr pane swap --source-pane w1:p2 --target-pane w1:p1",
      );
    }
  });

  it("closes a new split when left-side placement cannot swap", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin pane open")) return { stdout: json(openedPane()) };
      if (key.includes("pane swap")) return { code: 1, stderr: "swap failed" };
      if (key === "herdr plugin pane close w1:p2") return {};
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.open(target, "left", "/repo")).rejects.toThrow("swap failed");
    expect(harness.calls.map(commandKey)).toContain("herdr plugin pane close w1:p2");
  });

  it("opens a tab in the caller workspace", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin pane open")) return { stdout: json(openedPane("w1:p2", "w1:t2")) };
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await viewer.open(target, "tab", "/repo");
    const open = harness.calls.find(
      (call) => call.args.slice(0, 3).join(" ") === "plugin pane open",
    );
    expect(open?.args).toContain("tab");
    expect(open?.args).toContain("w1");
    expect(open?.args).not.toContain("--target-pane");
  });

  it("rejects malformed pane and workspace creation responses", async () => {
    const malformedPane = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin pane open")) return { stdout: json({ result: {} }) };
      throw new Error(`Unexpected command: ${key}`);
    });
    await expect(
      new HerdrWorkflowViewer(malformedPane.exec, { HERDR_ENV: "1" }).open(
        target,
        "right",
        "/repo",
      ),
    ).rejects.toThrow("plugin pane response has no plugin_pane");

    const malformedWorkspace = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("workspace create")) return { stdout: json({ result: {} }) };
      throw new Error(`Unexpected command: ${key}`);
    });
    await expect(
      new HerdrWorkflowViewer(malformedWorkspace.exec, { HERDR_ENV: "1" }).open(
        target,
        "workspace",
        "/repo",
      ),
    ).rejects.toThrow("workspace response has no workspace");
  });

  it("creates a plugin tab in a new workspace and removes its bootstrap tab", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("workspace create")) {
        return {
          stdout: json({
            result: {
              workspace: { workspace_id: "w2" },
              root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
            },
          }),
        };
      }
      if (key.includes("plugin pane open")) {
        return { stdout: json(openedPane("w2:p2", "w2:t2", "w2")) };
      }
      if (key === "herdr tab close w2:t1") return {};
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.open(target, "workspace", "/repo")).resolves.toEqual({
      paneId: "w2:p2",
      reused: false,
    });
    expect(harness.calls.map(commandKey)).toContain("herdr tab close w2:t1");
  });

  it("keeps a launched workspace viewer when bootstrap-tab cleanup fails", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("workspace create")) {
        return {
          stdout: json({
            result: {
              workspace: { workspace_id: "w2" },
              root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
            },
          }),
        };
      }
      if (key.includes("plugin pane open")) {
        return { stdout: json(openedPane("w2:p2", "w2:t2", "w2")) };
      }
      if (key === "herdr tab close w2:t1") return { code: 1, stderr: "temporary failure" };
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    const result = await viewer.open(target, "workspace", "/repo");
    expect(result).toMatchObject({ paneId: "w2:p2", reused: false });
    expect(result.warning).toContain("viewer opened");
    expect(harness.calls.map(commandKey)).not.toContain("herdr workspace close w2");
  });

  it("rolls back a new workspace after plugin launch failure", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("workspace create")) {
        return {
          stdout: json({
            result: {
              workspace: { workspace_id: "w2" },
              root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
            },
          }),
        };
      }
      if (key.includes("plugin pane open")) return { code: 1, stderr: "launch failed" };
      if (key === "herdr workspace close w2") return {};
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.open(target, "workspace", "/repo")).rejects.toThrow("launch failed");
    expect(harness.calls.map(commandKey)).toContain("herdr workspace close w2");
  });

  it("rediscovers and focuses an existing viewer by its pane label", async () => {
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") {
        return {
          stdout: json(
            snapshot([
              null,
              {
                pane_id: "w9:p4",
                tab_id: "w9:t2",
                workspace_id: "w9",
                label: viewerPaneLabel(target.runId),
              },
            ]),
          ),
        };
      }
      if (key === "herdr plugin pane focus w9:p4") return {};
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.open(target, "right", "/repo")).resolves.toEqual({
      paneId: "w9:p4",
      reused: true,
    });
    expect(harness.calls.map(commandKey)).toEqual([
      "herdr api snapshot",
      "herdr plugin pane focus w9:p4",
    ]);
  });

  it("serializes concurrent opens before the launcher labels its pane", async () => {
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const harness = execHarness(async (call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") return { stdout: json(snapshot()) };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin pane open")) {
        await openGate;
        return { stdout: json(openedPane()) };
      }
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    const first = viewer.open(target, "right", "/repo");
    const second = viewer.open(target, "below", "/repo");
    await Promise.resolve();
    releaseOpen?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { paneId: "w1:p2", reused: false },
      { paneId: "w1:p2", reused: false },
    ]);
    expect(
      harness.calls.filter((call) => call.args.slice(0, 3).join(" ") === "plugin pane open"),
    ).toHaveLength(1);
  });

  it("opens a replacement when a discovered viewer closes before focus", async () => {
    let snapshots = 0;
    const harness = execHarness((call) => {
      const key = commandKey(call);
      if (key === "herdr api snapshot") {
        snapshots += 1;
        return {
          stdout: json(
            snapshot(
              snapshots === 1
                ? [
                    {
                      pane_id: "w9:p4",
                      tab_id: "w9:t2",
                      workspace_id: "w9",
                      label: viewerPaneLabel(target.runId),
                    },
                  ]
                : [],
            ),
          ),
        };
      }
      if (key === "herdr plugin pane focus w9:p4") return { code: 1, stderr: "pane closed" };
      if (key === "herdr pane current --current") return { stdout: json(currentPane()) };
      if (key.includes("plugin pane open")) return { stdout: json(openedPane()) };
      throw new Error(`Unexpected command: ${key}`);
    });
    const viewer = new HerdrWorkflowViewer(harness.exec, { HERDR_ENV: "1" });

    await expect(viewer.open(target, "right", "/repo")).resolves.toEqual({
      paneId: "w1:p2",
      reused: false,
    });
  });

  it("parses placements and uses the requested Ctrl+Shift shortcut", () => {
    expect(parseViewerPlacement("workspace")).toBe("workspace");
    expect(parseViewerPlacement("diagonal")).toBeUndefined();
    expect(PIW_SHORTCUT).toBe("ctrl+shift+r");
  });
});
