import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../state/json.js";
import { ChildRunnerSupervisor, type SupervisedRunnerResult } from "./child-runner-supervisor.js";
import { ServerProcessRegistry, type ProcessIdentity } from "./processes.js";
import type { WorkflowRunnerLaunchEnvelope, RunnerOutcome } from "./state.js";
import {
  MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
  encodeRunnerLine,
  parseRunnerMessage,
  type WorkflowRunnerMessage,
  type WorkflowRunnerResponse,
} from "./workflow-runner-protocol.js";

export type WorkflowRunnerResult = SupervisedRunnerResult;

export class WorkflowRunnerSupervisor {
  private readonly supervisor: ChildRunnerSupervisor<WorkflowRunnerMessage, WorkflowRunnerResponse>;

  constructor(
    readonly envelope: WorkflowRunnerLaunchEnvelope,
    private readonly options: {
      registry: ServerProcessRegistry;
      onMessage: (message: WorkflowRunnerMessage) => Promise<WorkflowRunnerResponse>;
      env?: Record<string, string>;
      startupTimeoutMs?: number;
      runnerEntryPath?: string;
      onSpawn?: (identity: ProcessIdentity) => void;
      onDiagnostic?: (message: string) => void;
    },
  ) {
    this.supervisor = new ChildRunnerSupervisor({
      label: "Workflow runner",
      registry: options.registry,
      onMessage: options.onMessage,
      parseMessage: parseRunnerMessage,
      encodeResponse: encodeRunnerLine,
      isReady: (message) => message.kind === "runner.ready",
      isTerminal: (message) => message.kind === "runner.exiting",
      maxMessageBytes: MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
      oversizedMessage: "Runner protocol message exceeds 1 MiB",
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    });
  }

  async start(): Promise<void> {
    const builtEntry = fileURLToPath(new URL("./workflow-runner-entry.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./workflow-runner-entry.ts", import.meta.url));
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
        PI_WORKFLOWS_WORKFLOW_RUNNER_LAUNCH: Buffer.from(canonicalJson(this.envelope)).toString(
          "base64url",
        ),
      },
    });
  }

  async wait(): Promise<WorkflowRunnerResult> {
    return await this.supervisor.wait();
  }

  async stop(outcome: RunnerOutcome = "cancelled"): Promise<void> {
    await this.supervisor.stop(outcome);
  }
}
