import { describe, expect, it } from "vitest";
import {
  parseWorkflowSubmissionInput,
  parseWorkflowToolInput,
  WorkflowSubmissionToolParameters,
  WorkflowToolParameters,
} from "../src/workflows/tool-input.js";

const update = {
  type: "progress",
  key: "items",
  data: { completed: 2, total: 5 },
};

describe("workflow tool input", () => {
  it.each([
    { action: "list" },
    { action: "list", offset: 10 },
    { action: "start", workflow: "monitor" },
    { action: "start", workflow: "monitor", input: { task: "check" } },
    { action: "restart", runId: "run-1", expectedRevision: 4 },
    { action: "change-settings", patch: [] },
    { action: "queue-follow-up", prompt: "later" },
    { action: "remove-follow-up", followUpId: "follow-up-1" },
    { action: "status" },
    { action: "status", runId: "run-1" },
    { action: "pause" },
    { action: "resume" },
    { action: "cancel" },
    { action: "cancel", runId: "run-1" },
    { action: "answer", requestId: "request-1", input: { approved: true } },
    { action: "answer", requestId: "request-1", input: null },
    { action: "update", requestId: "request-1", update },
    { action: "submit", requestId: "request-1", output: { result: "ok" } },
  ])("accepts the exact $action input", (input) => {
    expect(parseWorkflowToolInput(input)).toEqual(input);
  });

  it.each([
    null,
    { action: 1 },
    { action: "unknown" },
    { action: "start" },
    { action: "restart" },
    { action: "restart", runId: "run-1" },
    { action: "answer" },
    { action: "answer", runId: "run-1", input: true },
    { action: "submit", step: "check", attempt: "try-1", output: null },
    { action: "update", step: "check", attempt: "try-1", update },
    { action: "submit", requestId: "", output: null },
    { action: "change-settings" },
    { action: "queue-follow-up" },
    { action: "remove-follow-up" },
    { action: "update", requestId: "request-1" },
    { action: "submit", requestId: "request-1" },
    { action: "pause", runId: "run-1" },
    { action: "list", workflow: "monitor" },
    {
      action: "update",
      requestId: "request-1",
      update: { type: "progress", key: "items", data: [] },
    },
  ])("rejects invalid action input %#", (input) => {
    expect(() => parseWorkflowToolInput(input)).toThrow("Invalid workflow tool input");
  });

  it("reports integer requirements in plain text", () => {
    expect(() => parseWorkflowToolInput({ action: "list", offset: 1.5 })).toThrow(
      "offset must be an integer",
    );
  });

  it("keeps the RPC bridge limited to update and submit", () => {
    expect(
      parseWorkflowSubmissionInput({ action: "update", requestId: "request-1", update }),
    ).toEqual({ action: "update", requestId: "request-1", update });
    expect(
      parseWorkflowSubmissionInput({
        action: "submit",
        requestId: "request-1",
        output: null,
      }),
    ).toEqual({ action: "submit", requestId: "request-1", output: null });
    expect(() => parseWorkflowSubmissionInput({ action: "start", workflow: "monitor" })).toThrow(
      "Invalid workflow submission tool input",
    );
  });

  it("publishes provider-compatible object roots", () => {
    expect(WorkflowToolParameters).toMatchObject({
      type: "object",
      required: ["action"],
      properties: {
        action: {
          enum: [
            "list",
            "start",
            "restart",
            "change-settings",
            "queue-follow-up",
            "remove-follow-up",
            "status",
            "pause",
            "resume",
            "cancel",
            "answer",
            "update",
            "submit",
          ],
        },
      },
    });
    expect(WorkflowToolParameters).not.toHaveProperty("anyOf");
    expect(Object.keys(WorkflowToolParameters.properties).sort()).toEqual([
      "action",
      "expectedChangeNumber",
      "expectedRevision",
      "followUpId",
      "input",
      "offset",
      "output",
      "patch",
      "prompt",
      "requestId",
      "runId",
      "scopeId",
      "update",
      "workflow",
    ]);

    expect(WorkflowSubmissionToolParameters).toMatchObject({
      type: "object",
      required: ["action"],
      properties: { action: { enum: ["update", "submit"] } },
    });
    expect(WorkflowSubmissionToolParameters).not.toHaveProperty("anyOf");
    expect(Object.keys(WorkflowSubmissionToolParameters.properties).sort()).toEqual([
      "action",
      "output",
      "requestId",
      "update",
    ]);
  });
});
