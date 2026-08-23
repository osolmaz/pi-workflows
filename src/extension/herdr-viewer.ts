import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HERDR_PLUGIN_ENTRYPOINT, HERDR_PLUGIN_ID } from "../herdr/constants.js";
export const PIW_SHORTCUT = "ctrl+shift+r";
export const PIW_SHORTCUT_HINT = "Ctrl+Shift+R piw";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_JSON_CHARS = 1_000_000;
const VIEWER_LABEL_PREFIX = "piw · ";

export const VIEWER_PLACEMENTS = ["right", "below", "left", "above", "tab", "workspace"] as const;

export type ViewerPlacement = (typeof VIEWER_PLACEMENTS)[number];

export type WorkflowViewTarget = {
  runId: string;
  workflowName: string;
};

export type HerdrCapability = { available: true } | { available: false; reason: string };

export type ViewerOpenResult = {
  paneId: string;
  reused: boolean;
  warning?: string;
};

type Exec = ExtensionAPI["exec"];

type HerdrPane = {
  paneId: string;
  tabId: string;
  workspaceId: string;
  label?: string;
};

type OpenedPane = {
  paneId: string;
  tabId: string;
  workspaceId: string;
};

export class HerdrWorkflowViewer {
  private readonly knownPanes = new Map<string, string>();
  private readonly opening = new Map<string, Promise<ViewerOpenResult>>();

  constructor(
    private readonly exec: Exec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async probe(): Promise<HerdrCapability> {
    if (this.env.HERDR_ENV !== "1") {
      return { available: false, reason: "Pi is not running in Herdr." };
    }
    try {
      await this.currentPane();
      const plugin = await this.runJson("herdr", [
        "plugin",
        "list",
        "--plugin",
        HERDR_PLUGIN_ID,
        "--json",
      ]);
      if (!pluginIsEnabled(plugin)) {
        return {
          available: false,
          reason: `Herdr plugin ${HERDR_PLUGIN_ID} is not linked and enabled.`,
        };
      }
      await this.run("piw", ["--version"]);
      return { available: true };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  }

  async focusExisting(target: WorkflowViewTarget): Promise<boolean> {
    return (await this.findAndFocus(target)) !== undefined;
  }

  async open(
    target: WorkflowViewTarget,
    placement: ViewerPlacement,
    cwd: string,
  ): Promise<ViewerOpenResult> {
    const pending = this.opening.get(target.runId);
    if (pending !== undefined) return await pending;

    const opening = this.openOnce(target, placement, cwd).finally(() => {
      if (this.opening.get(target.runId) === opening) this.opening.delete(target.runId);
    });
    this.opening.set(target.runId, opening);
    return await opening;
  }

  private async openOnce(
    target: WorkflowViewTarget,
    placement: ViewerPlacement,
    cwd: string,
  ): Promise<ViewerOpenResult> {
    const existingPaneId = await this.findAndFocus(target);
    if (existingPaneId !== undefined) {
      return { paneId: existingPaneId, reused: true };
    }

    const caller = await this.currentPane();
    if (placement === "workspace") {
      const opened = await this.openWorkspace(target, cwd);
      this.knownPanes.set(target.runId, opened.paneId);
      return { ...opened, reused: false };
    }

    const opened = await this.openPluginPane(target, placement, caller);
    if (placement === "left" || placement === "above") {
      try {
        await this.run("herdr", [
          "pane",
          "swap",
          "--source-pane",
          opened.paneId,
          "--target-pane",
          caller.paneId,
        ]);
      } catch (error) {
        await this.closePane(opened.paneId);
        throw error;
      }
    }
    this.knownPanes.set(target.runId, opened.paneId);
    return { paneId: opened.paneId, reused: false };
  }

  private async findAndFocus(target: WorkflowViewTarget): Promise<string | undefined> {
    const knownPaneId = this.knownPanes.get(target.runId);
    if (knownPaneId !== undefined) {
      try {
        await this.run("herdr", ["plugin", "pane", "focus", knownPaneId]);
        return knownPaneId;
      } catch {
        this.knownPanes.delete(target.runId);
      }
    }

    const existing = await this.find(target);
    if (existing === undefined) return undefined;
    try {
      await this.run("herdr", ["plugin", "pane", "focus", existing.paneId]);
      this.knownPanes.set(target.runId, existing.paneId);
      return existing.paneId;
    } catch {
      // The pane can close between the snapshot and focus request.
      return undefined;
    }
  }

  async find(target: WorkflowViewTarget): Promise<HerdrPane | undefined> {
    const snapshot = await this.runJson("herdr", ["api", "snapshot"]);
    return snapshotPanes(snapshot).find((pane) => pane.label === viewerPaneLabel(target.runId));
  }

  private async currentPane(): Promise<HerdrPane> {
    return parseCurrentPane(await this.runJson("herdr", ["pane", "current", "--current"]));
  }

  private async openPluginPane(
    target: WorkflowViewTarget,
    placement: Exclude<ViewerPlacement, "workspace">,
    caller: HerdrPane,
  ): Promise<OpenedPane> {
    const args = [
      "plugin",
      "pane",
      "open",
      "--plugin",
      HERDR_PLUGIN_ID,
      "--entrypoint",
      HERDR_PLUGIN_ENTRYPOINT,
      "--env",
      `PI_WORKFLOWS_RUN_ID=${target.runId}`,
      "--focus",
    ];
    if (placement === "tab") {
      args.push("--placement", "tab", "--workspace", caller.workspaceId);
    } else {
      args.push(
        "--placement",
        "split",
        "--target-pane",
        caller.paneId,
        "--direction",
        placement === "below" || placement === "above" ? "down" : "right",
      );
    }
    return parseOpenedPane(await this.runJson("herdr", args));
  }

  private async openWorkspace(
    target: WorkflowViewTarget,
    cwd: string,
  ): Promise<{ paneId: string; warning?: string }> {
    const created = parseCreatedWorkspace(
      await this.runJson("herdr", [
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        workspaceLabel(target.workflowName),
        "--no-focus",
      ]),
    );
    let opened: OpenedPane;
    try {
      opened = parseOpenedPane(
        await this.runJson("herdr", [
          "plugin",
          "pane",
          "open",
          "--plugin",
          HERDR_PLUGIN_ID,
          "--entrypoint",
          HERDR_PLUGIN_ENTRYPOINT,
          "--placement",
          "tab",
          "--workspace",
          created.workspaceId,
          "--env",
          `PI_WORKFLOWS_RUN_ID=${target.runId}`,
          "--focus",
        ]),
      );
    } catch (error) {
      await this.run("herdr", ["workspace", "close", created.workspaceId]).catch(() => undefined);
      throw error;
    }

    try {
      await this.run("herdr", ["tab", "close", created.bootstrapTabId]);
      return { paneId: opened.paneId };
    } catch (error) {
      return {
        paneId: opened.paneId,
        warning: `The piw viewer opened, but its empty bootstrap tab could not be closed: ${errorMessage(error)}`,
      };
    }
  }

  private async closePane(paneId: string): Promise<void> {
    await this.run("herdr", ["plugin", "pane", "close", paneId]).catch(() => undefined);
  }

  private async run(command: string, args: string[]): Promise<string> {
    const result = await this.exec(command, args, { timeout: COMMAND_TIMEOUT_MS });
    if (result.killed) {
      throw new Error(`${command} timed out.`);
    }
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`${command} failed: ${boundedText(message)}`);
    }
    return result.stdout;
  }

  private async runJson(command: string, args: string[]): Promise<unknown> {
    const stdout = await this.run(command, args);
    if (stdout.length > MAX_JSON_CHARS) {
      throw new Error(`${command} returned too much data.`);
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error(`${command} returned invalid JSON.`);
    }
  }
}

export function parseViewerPlacement(value: string): ViewerPlacement | undefined {
  return VIEWER_PLACEMENTS.find((placement) => placement === value);
}

export function viewerPaneLabel(runId: string): string {
  return `${VIEWER_LABEL_PREFIX}${runId}`;
}

function pluginIsEnabled(value: unknown): boolean {
  const result = recordValue(value, "result");
  const plugins = result === undefined ? undefined : arrayValue(result, "plugins");
  return (
    plugins?.some(
      (plugin) =>
        recordValue(plugin, "plugin_id") === HERDR_PLUGIN_ID &&
        recordValue(plugin, "enabled") === true,
    ) === true
  );
}

function parseCurrentPane(value: unknown): HerdrPane {
  const result = requiredRecord(value, "result", "Herdr pane response");
  return paneFromValue(requiredRecord(result, "pane", "Herdr pane response"));
}

function parseOpenedPane(value: unknown): OpenedPane {
  const result = requiredRecord(value, "result", "Herdr plugin pane response");
  const pluginPane = requiredRecord(result, "plugin_pane", "Herdr plugin pane response");
  return paneFromValue(requiredRecord(pluginPane, "pane", "Herdr plugin pane response"));
}

function parseCreatedWorkspace(value: unknown): {
  workspaceId: string;
  bootstrapTabId: string;
} {
  const result = requiredRecord(value, "result", "Herdr workspace response");
  const workspace = requiredRecord(result, "workspace", "Herdr workspace response");
  const rootPane = requiredRecord(result, "root_pane", "Herdr workspace response");
  return {
    workspaceId: requiredString(workspace, "workspace_id", "Herdr workspace response"),
    bootstrapTabId: requiredString(rootPane, "tab_id", "Herdr workspace response"),
  };
}

function snapshotPanes(value: unknown): HerdrPane[] {
  const result = requiredRecord(value, "result", "Herdr snapshot");
  const snapshot = requiredRecord(result, "snapshot", "Herdr snapshot");
  const panes = arrayValue(snapshot, "panes");
  if (panes === undefined) throw new Error("Herdr snapshot has no panes.");
  return panes.flatMap((pane) => {
    try {
      return [paneFromValue(pane)];
    } catch {
      return [];
    }
  });
}

function paneFromValue(value: unknown): HerdrPane {
  if (!isRecord(value)) throw new Error("Herdr returned an invalid pane.");
  const label = recordValue(value, "label");
  return {
    paneId: requiredString(value, "pane_id", "Herdr pane"),
    tabId: requiredString(value, "tab_id", "Herdr pane"),
    workspaceId: requiredString(value, "workspace_id", "Herdr pane"),
    ...(typeof label === "string" ? { label } : {}),
  };
}

function workspaceLabel(workflowName: string): string {
  const compact = workflowName.replace(/[\r\n\t]+/gu, " ").trim();
  return `piw · ${(compact || "workflow").slice(0, 60)}`;
}

function requiredRecord(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  const nested = value[key];
  if (!isRecord(nested)) throw new Error(`${label} has no ${key}.`);
  return nested;
}

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const nested = value[key];
  if (typeof nested !== "string" || nested.length === 0) {
    throw new Error(`${label} has no ${key}.`);
  }
  return nested;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function arrayValue(value: unknown, key: string): unknown[] | undefined {
  const nested = recordValue(value, key);
  return Array.isArray(nested) ? nested : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
