import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  executeWorkerRunCommand,
  validateAcceptedAssistantSubmission,
} from "../src/host/worker-entry.js";
import type { WorkflowEngine } from "../src/workflows/engine.js";
import type {
  AgentStepContract,
  AgentStepSubmission,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowSource,
} from "../src/workflows/types.js";

const contract: AgentStepContract = {
  runId: "run-1",
  workflowName: "example",
  nodeId: "present",
  attemptId: "attempt-1",
  completion: "assistant",
  maxOutputChars: 20,
};

function submission(output = "Visible response."): AgentStepSubmission {
  const entryId = "assistant-entry";
  return {
    output,
    assistantMessage: {
      sha256: createHash("sha256").update(output).digest("hex"),
      entryId,
      maxChars: 20,
      recovered: true,
    },
    conversation: { firstEntryId: "prompt-entry", lastEntryId: entryId },
  };
}

describe("workflow worker run commands", () => {
  it("starts a restart as a fresh run instead of a continuation", async () => {
    const result = { runId: "restart-1", state: {} } as WorkflowRunResult;
    const engine = {
      run: vi.fn().mockResolvedValue(result),
      resumeRun: vi.fn(),
      continueRun: vi.fn(),
    } as unknown as Pick<WorkflowEngine, "run" | "resumeRun" | "continueRun">;
    const workflow = {} as WorkflowDefinition;
    const source: WorkflowSource = { kind: "builtin", id: "demo", revision: "test" };

    await expect(
      executeWorkerRunCommand(engine, workflow, "restart-1", source, {
        kind: "restart",
        input: { task: "again" },
      }),
    ).resolves.toBe(result);

    expect(engine.run).toHaveBeenCalledWith(
      workflow,
      { task: "again" },
      {
        runId: "restart-1",
        workflowSource: source,
      },
    );
    expect(engine.continueRun).not.toHaveBeenCalled();
  });

  it("uses continuation only for an explicit continuation command", async () => {
    const result = { runId: "continuation-1", state: {} } as WorkflowRunResult;
    const engine = {
      run: vi.fn(),
      resumeRun: vi.fn(),
      continueRun: vi.fn().mockResolvedValue(result),
    } as unknown as Pick<WorkflowEngine, "run" | "resumeRun" | "continueRun">;
    const workflow = {} as WorkflowDefinition;
    const source: WorkflowSource = { kind: "builtin", id: "demo", revision: "test" };

    await expect(
      executeWorkerRunCommand(engine, workflow, "continuation-1", source, {
        kind: "continue",
        parentRunId: "parent-1",
        input: { answer: true },
      }),
    ).resolves.toBe(result);

    expect(engine.continueRun).toHaveBeenCalledWith(
      workflow,
      "parent-1",
      { answer: true },
      {
        runId: "continuation-1",
        workflowSource: source,
      },
    );
    expect(engine.run).not.toHaveBeenCalled();
  });
});

describe("workflow worker assistant interaction validation", () => {
  it("accepts a matching durable visible-response receipt", () => {
    expect(validateAcceptedAssistantSubmission(submission(), contract)).toEqual({
      ok: true,
      value: submission(),
    });
  });

  it("rejects content that does not match its receipt", () => {
    const value = submission();
    value.output = "Changed response.";
    expect(validateAcceptedAssistantSubmission(value, contract)).toEqual({
      ok: false,
      error: "Assistant response receipt is invalid",
    });
  });

  it("rejects a response above the workflow limit", () => {
    expect(validateAcceptedAssistantSubmission(submission("x".repeat(21)), contract)).toEqual({
      ok: false,
      error: "Assistant response has 21 characters, above the configured limit of 20",
    });
  });
});
