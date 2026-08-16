import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  buildWorkflowAgentStepView,
  registerWorkflowAgentStepMessageRenderer,
  WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA,
  WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
  type WorkflowAgentStepMessageDetails,
} from "../src/extension/step-message.js";

const theme = {
  bg: (_color: string, text: string) => text,
  fg: (_color: string, text: string) => text,
} as Theme;

const details: WorkflowAgentStepMessageDetails = {
  schema: WORKFLOW_AGENT_STEP_MESSAGE_SCHEMA,
  kind: "step",
  contract: {
    runId: "run-1",
    workflowName: "monitor",
    nodeId: "check",
    attemptId: "attempt-1",
    expectedOutput: `{ "route": "continue" }`,
  },
  presentation: {
    runTitle: "Watch deploy",
    statusDetail: "Checking the monitored target",
  },
};

describe("workflow agent-step messages", () => {
  it("builds a compact view without the model prompt", () => {
    const view = buildWorkflowAgentStepView(
      { content: "Large model instructions", details },
      false,
    );

    expect(view).toEqual({
      title: "▶ Watch deploy › check",
      status: "Checking the monitored target",
    });
    expect(JSON.stringify(view)).not.toContain("Large model instructions");
  });

  it("shows exact contract fields and the full prompt when expanded", () => {
    const view = buildWorkflowAgentStepView(
      {
        content: "First line\nSecond \u001b[31mline\u001b[0m",
        details: { ...details, kind: "reminder" },
      },
      true,
    );

    expect(view.title).toBe("↻ Watch deploy › check · reminder");
    expect(view.expandedText).toContain("Workflow: monitor");
    expect(view.expandedText).toContain("Run id: run-1");
    expect(view.expandedText).toContain("Attempt id: attempt-1");
    expect(view.expandedText).toContain(`Expected output: { "route": "continue" }`);
    expect(view.expandedText).toContain("First line\nSecond line");
    expect(view.expandedText).not.toContain("\u001b");
  });

  it("renders malformed details safely", () => {
    const view = buildWorkflowAgentStepView(
      { content: "Do work", details: { schema: "wrong", contract: null } },
      true,
    );

    expect(view.title).toBe("▶ Workflow › step");
    expect(view.expandedText).toContain("Run id: unknown");
    expect(view.expandedText).toContain("Do work");
  });

  it("registers a bounded renderer for collapsed and expanded views", () => {
    let renderer:
      | ((
          message: never,
          options: { expanded: boolean },
          renderTheme: Theme,
        ) => {
          render(width: number): string[];
        })
      | undefined;
    const pi = {
      registerMessageRenderer: (customType: string, candidate: typeof renderer) => {
        expect(customType).toBe(WORKFLOW_AGENT_STEP_MESSAGE_TYPE);
        renderer = candidate;
      },
    } as unknown as ExtensionAPI;
    registerWorkflowAgentStepMessageRenderer(pi);

    const message = {
      role: "custom",
      customType: WORKFLOW_AGENT_STEP_MESSAGE_TYPE,
      content: "Large model instructions",
      display: true,
      details,
      timestamp: Date.now(),
    };
    const collapsed = renderer?.(message as never, { expanded: false }, theme).render(32) ?? [];
    expect(collapsed.some((line) => line.includes("Watch deploy"))).toBe(true);
    expect(collapsed.join("\n")).not.toContain("Large model instructions");
    expect(collapsed.every((line) => visibleWidth(line) <= 32)).toBe(true);

    const expanded = renderer?.(message as never, { expanded: true }, theme).render(40) ?? [];
    expect(expanded.join("\n")).toContain("Large model instructions");
    expect(expanded.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});
