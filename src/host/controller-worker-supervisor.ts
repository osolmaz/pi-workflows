import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalJson, type JsonValue } from "../state/json.js";
import { ChildWorkerSupervisor, type SupervisedWorkerResult } from "./child-worker-supervisor.js";
import {
  encodeControllerWorkerLine,
  parseControllerWorkerMessage,
  type ControllerWorkerLaunchEnvelope,
  type ControllerWorkerMessage,
  type ControllerWorkerResponse,
} from "./controller-worker-protocol.js";
import { HostProcessRegistry, type ProcessIdentity } from "./processes.js";
import type { WorkerOutcome } from "./state.js";

export class ControllerWorkerSupervisor {
  private readonly supervisor: ChildWorkerSupervisor<
    ControllerWorkerMessage,
    ControllerWorkerResponse
  >;

  constructor(
    readonly envelope: ControllerWorkerLaunchEnvelope,
    private readonly options: {
      registry: HostProcessRegistry;
      onMessage: (message: ControllerWorkerMessage) => Promise<ControllerWorkerResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      workerEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {
    this.supervisor = new ChildWorkerSupervisor({
      label: "Controller worker",
      registry: options.registry,
      onMessage: options.onMessage,
      parseMessage: parseControllerWorkerMessage,
      encodeResponse: encodeControllerWorkerLine,
      isReady: (message) => message.operation === "worker.ready",
      isTerminal: (message) =>
        message.operation === "worker.finished" || message.operation === "worker.failed",
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  }

  async start(): Promise<void> {
    const builtEntry = fileURLToPath(new URL("./controller-worker-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./controller-worker-entry.ts", import.meta.url));
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
        PI_WORKFLOWS_CONTROLLER_WORKER_LAUNCH: Buffer.from(
          canonicalJson(this.envelope as unknown as JsonValue),
        ).toString("base64url"),
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
