import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { encodeChannelLaunch } from "../channels/adapter-entry.js";
import {
  encodeChannelLine,
  parseChannelAdapterMessage,
  type ChannelAdapterLaunch,
  type ChannelAdapterMessage,
  type ChannelAdapterResponse,
} from "../channels/protocol.js";
import { ChildWorkerSupervisor, type SupervisedWorkerResult } from "./child-worker-supervisor.js";
import { HostProcessRegistry, type ProcessIdentity } from "./processes.js";
import type { WorkerOutcome } from "./state.js";

export class ChannelAdapterSupervisor {
  private readonly supervisor: ChildWorkerSupervisor<ChannelAdapterMessage, ChannelAdapterResponse>;

  constructor(
    readonly launch: ChannelAdapterLaunch,
    private readonly options: {
      registry: HostProcessRegistry;
      onMessage: (message: ChannelAdapterMessage) => Promise<ChannelAdapterResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      adapterEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {
    this.supervisor = new ChildWorkerSupervisor({
      label: `Telegram channel adapter ${launch.profile}`,
      registry: options.registry,
      onMessage: options.onMessage,
      parseMessage: parseChannelAdapterMessage,
      encodeResponse: encodeChannelLine,
      isReady: (message) => message.kind === "channel.ready",
      isTerminal: (message) => message.kind === "channel.exiting",
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  }

  async start(): Promise<void> {
    const builtEntry = fileURLToPath(new URL("../channels/adapter-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("../channels/adapter-entry.ts", import.meta.url));
    const adapterEntry = this.options.adapterEntryPath ?? builtEntry;
    const args =
      this.options.adapterEntryPath === undefined && !fs.existsSync(builtEntry)
        ? ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry]
        : [adapterEntry];
    await this.supervisor.start({
      args,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...this.options.env,
        PI_WORKFLOWS_CHANNEL_LAUNCH: encodeChannelLaunch(this.launch),
      },
    });
  }

  async wait(): Promise<SupervisedWorkerResult> {
    return await this.supervisor.wait();
  }

  async stop(outcome: WorkerOutcome = "cancelled"): Promise<void> {
    await this.supervisor.stop(outcome);
  }
}
