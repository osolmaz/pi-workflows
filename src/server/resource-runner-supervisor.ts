import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { ChildRunnerSupervisor, type SupervisedRunnerResult } from "./child-runner-supervisor.js";
import { ServerProcessRegistry, type ProcessIdentity } from "./processes.js";
import {
  encodeResourceRunnerLine,
  parseResourceRunnerMessage,
  type ResourceRunnerLaunchEnvelope,
  type ResourceRunnerMessage,
  type ResourceRunnerResponse,
} from "./resource-runner-protocol.js";
import type { RunnerOutcome } from "./state.js";

export class ResourceRunnerSupervisor {
  private readonly supervisor: ChildRunnerSupervisor<ResourceRunnerMessage, ResourceRunnerResponse>;

  constructor(
    readonly envelope: ResourceRunnerLaunchEnvelope,
    private readonly options: {
      registry: ServerProcessRegistry;
      onMessage: (message: ResourceRunnerMessage) => Promise<ResourceRunnerResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      runnerEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {
    this.supervisor = new ChildRunnerSupervisor({
      label: "Resource runner",
      registry: options.registry,
      onMessage: options.onMessage,
      parseMessage: parseResourceRunnerMessage,
      encodeResponse: encodeResourceRunnerLine,
      isReady: (message) => message.operation === "runner.ready",
      isTerminal: (message) =>
        message.operation === "runner.finished" || message.operation === "runner.failed",
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  }

  async start(): Promise<void> {
    const builtEntry = fileURLToPath(new URL("./resource-runner-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./resource-runner-entry.ts", import.meta.url));
    const runnerEntry = this.options.runnerEntryPath ?? builtEntry;
    const args =
      this.options.runnerEntryPath === undefined && !fs.existsSync(builtEntry)
        ? ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry]
        : [runnerEntry];
    await this.supervisor.start({
      args,
      cwd: this.envelope.projectPath,
      env: {
        ...process.env,
        ...this.options.env,
        PI_WORKFLOWS_RESOURCE_RUNNER_LAUNCH: Buffer.from(
          canonicalJson(this.envelope as unknown as JsonValue),
        ).toString("base64url"),
      },
    });
  }

  async wait(): Promise<SupervisedRunnerResult> {
    return await this.supervisor.wait();
  }

  async stop(outcome: RunnerOutcome = "cancelled"): Promise<void> {
    await this.supervisor.stop(outcome);
  }
}
