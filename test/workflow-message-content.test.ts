import { describe, expect, it } from "vitest";
import {
  decisionWorkflowMessageContent,
  followUpWorkflowMessageContent,
  notificationWorkflowMessageContent,
  stepWorkflowMessageContent,
  terminalWorkflowMessageContent,
} from "../src/workflows/workflow-message-content.js";

function agentContract(completion: "submit" | "assistant" = "submit") {
  return {
    runId: "run-1",
    workflowName: "test",
    nodeId: "step",
    attemptId: "attempt-1",
    completion,
  };
}

describe("workflow message content", () => {
  it("builds step messages with the complete stored contract", () => {
    expect(
      stepWorkflowMessageContent({
        workflowMessageId: "message-1",
        requestId: "request-1",
        reason: "initial",
        contract: {
          prompt: "Do the work.",
          presentation: { title: "Work" },
          contract: agentContract(),
        },
      }),
    ).toMatchObject({
      customType: "pi-workflows-step",
      content: "Do the work.",
      display: true,
      triggerTurn: true,
      details: {
        workflowMessageId: "message-1",
        requestId: "request-1",
        reason: "initial",
        presentation: { title: "Work" },
        contract: { completion: "submit" },
      },
    });

    expect(
      stepWorkflowMessageContent({
        workflowMessageId: "message-2",
        requestId: "request-2",
        reason: "resumed",
        contract: { prompt: 1, contract: agentContract("assistant") },
      }),
    ).toMatchObject({
      content: "Continue the workflow step.",
      details: { reason: "resumed", contract: { completion: "assistant" } },
    });
  });

  it("rejects malformed step contracts", () => {
    expect(() =>
      stepWorkflowMessageContent({
        workflowMessageId: "message-1",
        requestId: "request-1",
        reason: "initial",
        contract: null,
      }),
    ).toThrow("Stored workflow step contract is invalid");

    for (const contract of [
      {},
      { ...agentContract(), runId: 1 },
      { ...agentContract(), workflowName: 1 },
      { ...agentContract(), nodeId: 1 },
      { ...agentContract(), attemptId: 1 },
      { ...agentContract(), completion: "other" },
    ]) {
      expect(() =>
        stepWorkflowMessageContent({
          workflowMessageId: "message-1",
          requestId: "request-1",
          reason: "initial",
          contract: { contract },
        }),
      ).toThrow("Stored workflow agent contract is invalid");
    }
  });

  it("renders every supported human decision block and choice", () => {
    const content = decisionWorkflowMessageContent({
      workflowMessageId: "message-1",
      requestId: "request-1",
      runId: "run-1",
      contract: {
        title: "Approve",
        presentation: {
          summary: "Review the change.",
          blocks: [
            { kind: "paragraph", text: "Paragraph" },
            { kind: "section", title: "Section" },
            { kind: "preformatted", text: "code" },
            { kind: "bullets", items: ["one", "two"] },
            {
              kind: "fields",
              items: [
                { label: "Risk", value: "Low" },
                { label: 1, value: "ignored" },
              ],
            },
            null,
            { kind: "unknown" },
          ],
        },
        choices: {
          continue: { label: "Continue" },
          replan: { input: { prompt: "What changes?" } },
          malformed: null,
        },
      },
    });
    expect(content).toMatchObject({
      customType: "pi-workflows-interaction",
      display: true,
      triggerTurn: false,
      details: { kind: "decision", runId: "run-1" },
    });
    expect(content.content).toContain("Approve");
    expect(content.content).toContain("Review the change.");
    expect(content.content).toContain("Paragraph");
    expect(content.content).toContain("Section");
    expect(content.content).toContain("- one\n- two");
    expect(content.content).toContain("Risk: Low");
    expect(content.content).toContain("replan: replan; input: What changes?");
    expect(content.content).toContain("malformed: malformed");

    expect(
      decisionWorkflowMessageContent({
        workflowMessageId: "message-2",
        requestId: "request-2",
        runId: "run-2",
        contract: {},
      }).content,
    ).toContain("Workflow decision");
    expect(() =>
      decisionWorkflowMessageContent({
        workflowMessageId: "message-3",
        requestId: "request-3",
        runId: "run-3",
        contract: [] as never,
      }),
    ).toThrow("Stored workflow decision contract is invalid");
  });

  it("builds notification, terminal, and follow-up messages", () => {
    expect(
      notificationWorkflowMessageContent({
        workflowMessageId: "notification-message",
        notificationId: "notification-1",
        runId: "run-1",
        kind: "progress",
        content: "Half done.",
      }),
    ).toMatchObject({ customType: "pi-workflows-notification", triggerTurn: false });
    expect(
      terminalWorkflowMessageContent({
        workflowMessageId: "terminal-message",
        runId: "run-1",
        content: "Done.",
        details: { outcome: "completed" },
      }),
    ).toMatchObject({ customType: "pi-workflows-presentation", display: false, triggerTurn: true });
    expect(
      followUpWorkflowMessageContent({
        workflowMessageId: "follow-up-message",
        followUpId: "follow-up-1",
        runId: "run-1",
        prompt: "Continue normal work.",
      }),
    ).toMatchObject({ customType: "pi-workflows-follow-up", display: true, triggerTurn: true });
  });
});
