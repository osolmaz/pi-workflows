import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../state/json.js";
import { ChildWorkerSupervisor, type SupervisedWorkerResult } from "./child-worker-supervisor.js";
import { HostProcessRegistry, type ProcessIdentity } from "./processes.js";
import type { WorkerLaunchEnvelope, WorkerOutcome } from "./state.js";
import {
  encodeWorkerLine,
  parseWorkerMessage,
  type WorkerMessage,
  type WorkerResponse,
} from "./worker-protocol.js";

export type WorkflowWorkerResult = SupervisedWorkerResult;

export class WorkflowWorkerSupervisor {
  private readonly supervisor: ChildWorkerSupervisor<WorkerMessage, WorkerResponse>;

  constructor(
    readonly envelope: WorkerLaunchEnvelope,
    private readonly options: {
      registry: HostProcessRegistry;
      onMessage: (message: WorkerMessage) => Promise<WorkerResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      workerEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {
    this.supervisor = new ChildWorkerSupervisor({
      label: "Workflow worker",
      registry: options.registry,
      onMessage: options.onMessage,
      parseMessage: parseWorkerMessage,
      encodeResponse: encodeWorkerLine,
      isReady: (message) => message.kind === "worker.ready",
      isTerminal: (message) => message.kind === "worker.exiting",
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  }

  async start(): Promise<void> {
    const builtEntry = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
    const workerEntry = this.options.workerEntryPath ?? builtEntry;
    const args =
      this.options.workerEntryPath === undefined && !fs.existsSync(builtEntry)
        ? ["--import", createRequire(import.meta.url).resolve("tsx"), sourceEntry]
        : [workerEntry];
    await this.supervisor.start({
      args,
      cwd: this.envelope.projectPath,
      env: {
        ...process.env,
        ...this.options.env,
        PI_WORKFLOWS_WORKER_LAUNCH: Buffer.from(canonicalJson(this.envelope)).toString("base64url"),
      },
    });
  }

  async wait(): Promise<WorkflowWorkerResult> {
    return await this.supervisor.wait();
  }

  async stop(outcome: WorkerOutcome = "cancelled"): Promise<void> {
    await this.supervisor.stop(outcome);
  }
}
