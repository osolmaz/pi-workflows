import { WorkflowEngine } from "../workflows/engine.js";
import {
  createRunId,
  readLastTraceEvent,
  readRunBundle,
  type WorkflowRunStore,
} from "../workflows/store.js";
import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "../workflows/types.js";
import type {
  ControllerWorkflowScheduler,
  WorkflowSchedulerRequest,
  WorkflowSchedulerResult,
} from "./workflows.js";

export type ResolvedChildWorkflow = {
  workflow: WorkflowDefinition;
  workflowPath?: string;
};

export type WorkflowEngineSchedulerOptions = {
  store: WorkflowRunStore;
  resolveWorkflow: (name: string) => Promise<ResolvedChildWorkflow>;
  createEngine: (request: WorkflowSchedulerRequest) => WorkflowEngine;
};

export class WorkflowEngineScheduler implements ControllerWorkflowScheduler {
  private readonly active = new Map<string, { runId: string; promise: Promise<void> }>();

  constructor(private readonly options: WorkflowEngineSchedulerOptions) {}

  async ensure(
    request: WorkflowSchedulerRequest,
    signal: AbortSignal,
    onComplete: (result: WorkflowSchedulerResult) => void,
  ): Promise<WorkflowSchedulerResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Workflow scheduling aborted");
    }
    const activeKey = requestKey(request);
    const active = this.active.get(activeKey);
    if (active !== undefined) {
      return { state: "running", runId: active.runId };
    }

    if (request.runId !== undefined) {
      const bundle = await readRunBundle(this.options.store.runDirFor(request.runId));
      if (bundle !== null) {
        if (bundle.state.status === "running") {
          await this.options.store.markRunInterrupted(request.runId);
          return { state: "interrupted", runId: request.runId };
        }
        const lastTraceEvent = await readLastTraceEvent(bundle.runDir, bundle.manifest.paths.trace);
        return resultFromStatus(
          bundle.state.status,
          request.runId,
          bundle.state.error,
          lastTraceEvent?.type === "run_interrupted",
        );
      }
    }

    const resolved = await this.options.resolveWorkflow(request.workflow);
    const runId = request.runId ?? createRunId(resolved.workflow.name);
    const engine = this.options.createEngine(request);
    const promise = engine
      .run(resolved.workflow, request.input, {
        runId,
        ...(resolved.workflowPath !== undefined ? { workflowPath: resolved.workflowPath } : {}),
      })
      .then((result) => {
        callCompletion(onComplete, resultFromRun(result));
      })
      .catch((error: unknown) => {
        callCompletion(onComplete, {
          state: "failed",
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.active.delete(activeKey);
      });
    this.active.set(activeKey, { runId, promise });
    return { state: "running", runId };
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.promise));
  }
}

function callCompletion(
  callback: (result: WorkflowSchedulerResult) => void,
  result: WorkflowSchedulerResult,
): void {
  try {
    callback(result);
  } catch {
    // A later reconciliation recovers completion from the immutable run bundle.
  }
}

function requestKey(request: WorkflowSchedulerRequest): string {
  return `${request.requestId}:${request.attempt}`;
}

function resultFromRun(result: WorkflowRunResult): WorkflowSchedulerResult {
  return resultFromStatus(result.state.status, result.state.runId, result.state.error);
}

function resultFromStatus(
  status: WorkflowRunStatus,
  runId: string,
  error?: string,
  interrupted = false,
): WorkflowSchedulerResult {
  if (interrupted) {
    return { state: "interrupted", runId, ...(error !== undefined ? { error } : {}) };
  }
  switch (status) {
    case "running":
      return { state: "running", runId };
    case "waiting":
      return { state: "waiting", runId };
    case "completed":
      return { state: "succeeded", runId };
    case "failed":
    case "timed_out":
    case "cancelled":
      return { state: "failed", runId, ...(error !== undefined ? { error } : {}) };
  }
}
