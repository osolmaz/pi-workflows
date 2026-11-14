import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectPiwClient, piwPaneEnvironment } from "../herdr/client.js";
import {
  viewerPaneLabel,
  type HerdrCapability,
  type ViewerOpenResult,
  type ViewerPlacement,
  type WorkflowViewTarget,
} from "./herdr-viewer.js";

const COMMAND_TIMEOUT_MS = 5_000;

type Exec = ExtensionAPI["exec"];

/**
 * Opens piw in a Rex block. Rex needs no plugin: the block runs the resolved client directly, so
 * the same PIW_BIN, PIW_SOCKET, and PIW_NO_AUTOSTART contract reaches the viewer through env(1).
 * Placements map to Rex resources: a split beside the caller, a window for "tab", and a session
 * for "workspace".
 */
export class RexWorkflowViewer {
  private readonly opening = new Map<string, Promise<ViewerOpenResult>>();

  constructor(
    private readonly exec: Exec,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly socketPath: () => string | undefined = () => undefined,
  ) {}

  static detects(env: NodeJS.ProcessEnv): boolean {
    return env.HERDR_ENV !== "1" && (env.REX_BLOCK ?? "").length > 0;
  }

  async probe(): Promise<HerdrCapability> {
    if (!RexWorkflowViewer.detects(this.env)) {
      return { available: false, reason: "Pi is not running in Rex." };
    }
    const client = inspectPiwClient({ env: this.env });
    return client.ok ? { available: true } : { available: false, reason: client.message };
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
    // Resolve the client first: a stale client must not reuse or focus an existing block.
    const client = inspectPiwClient({ env: this.env });
    if (!client.ok) {
      throw new Error(client.message);
    }
    const existing = await this.findAndFocus(target);
    if (existing !== undefined) {
      return { paneId: existing, reused: true };
    }

    const label = viewerPaneLabel(target.runId);
    const command = [
      "--",
      "/usr/bin/env",
      ...piwPaneEnvironment(client.path, this.socketPath()),
      client.path,
      target.runId,
    ];
    const common = ["--cwd", cwd, "--shell=none", "--keep-open", "--json"];
    let args: string[];
    if (placement === "workspace") {
      args = ["new", `piw · ${target.workflowName.slice(0, 60)}`, ...common, ...command];
    } else if (placement === "tab") {
      args = ["run", "--label", label, ...common, ...command];
    } else {
      const anchor = this.env.REX_BLOCK ?? "";
      args = ["split", "--split", placement, "-b", anchor, "--label", label, ...common, ...command];
    }
    const blockId = createdBlockId(await this.run(args));
    if (blockId === undefined) throw new Error("rex returned no block for the piw viewer.");
    // rex new labels the session, not its block; the block label is what a later open looks up.
    if (placement === "workspace") await this.run(["block", "rename", blockId, label]);
    return { paneId: blockId, reused: false };
  }

  private async findAndFocus(target: WorkflowViewTarget): Promise<string | undefined> {
    const label = viewerPaneLabel(target.runId);
    let blockId: string | undefined;
    try {
      // shortcut: rex lists JSON for one session only, so a "workspace" viewer in its own session
      // is not found and can be duplicated; walk `rex ls --json` if that matters.
      blockId = blockWithLabel(JSON.parse(await this.run(["block", "ls", "--json"])), label);
    } catch {
      return undefined;
    }
    if (blockId === undefined) return undefined;
    try {
      await this.run(["block", "focus", blockId]);
      return blockId;
    } catch {
      // The block can close between the listing and the focus request.
      return undefined;
    }
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.exec("rex", args, {
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.killed) {
      throw new Error("rex timed out.");
    }
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`rex failed: ${message.replace(/\s+/gu, " ").slice(0, 300)}`);
    }
    return result.stdout;
  }
}

function blockWithLabel(listing: unknown, label: string): string | undefined {
  const blocks = (listing as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks as { block_id?: unknown; label?: unknown }[]) {
    if (block?.label === label && typeof block.block_id === "string") return block.block_id;
  }
  return undefined;
}

function createdBlockId(stdout: string): string | undefined {
  try {
    const created = JSON.parse(stdout) as {
      block_ids?: unknown;
      initial_windows?: { block_ids?: unknown }[];
    };
    const ids = created.block_ids ?? created.initial_windows?.[0]?.block_ids;
    return Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : undefined;
  } catch {
    return undefined;
  }
}
