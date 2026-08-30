import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateAcceptedAssistantSubmission } from "../src/host/worker-entry.js";
import type { AgentStepContract, AgentStepSubmission } from "../src/workflows/types.js";

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
