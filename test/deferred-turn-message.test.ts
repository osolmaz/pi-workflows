import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { WorkflowTurnIntentRecord } from "../src/controllers/sqlite.js";
import {
  buildDeferredTurnMessageView,
  DEFERRED_TURN_MESSAGE_SCHEMA,
  DEFERRED_TURN_MESSAGE_TYPE,
  deferredTurnMessageDetails,
  registerDeferredTurnMessageRenderer,
  type DeferredTurnMessageDetails,
} from "../src/extension/deferred-turn.js";
import type { TerminalDecision, TerminalReason } from "../src/extension/terminal-decision.js";

const theme = {
  bg: (_color: string, text: string) => text,
  fg: (_color: string, text: string) => text,
} as Theme;

const terminalDetails: DeferredTurnMessageDetails = {
  schema: DEFERRED_TURN_MESSAGE_SCHEMA,
  turnIntentId: "intent-1",
  runId: "run-1",
  cause: "terminal",
  presentation: {
    workflowName: "autoimplement",
    state: "completed",
    reasonKind: "completed",
    restart: { count: 0, limit: 3 },
  },
};

function decision(reason: TerminalReason): TerminalDecision {
  return {
    workflowName: "autoimplement",
    workflowSourceRef: "builtin:autoimplement",
    workflowSource: { kind: "builtin", id: "autoimplement", revision: "test" },
    definitionDigest: `sha256:${"a".repeat(64)}`,
    runId: "run-1",
    input: { task: "finish" },
    result: { done: true },
    state:
      reason.kind === "completed"
        ? "completed"
        : reason.kind === "cancelled"
          ? "cancelled"
          : reason.kind === "timedOut"
            ? "timed_out"
            : "failed",
    reason,
    restartNumber: 1,
    restartLimit: 3,
    history: [],
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
}

function intent(): WorkflowTurnIntentRecord {
  return {
    intentId: "intent-1",
    sourceEventId: "event-1",
    runId: "run-1",
    workflowRef: "autoimplement",
    targetSessionId: "session-1",
    cause: "terminal",
    nodeId: "$terminal",
    attemptId: null,
    fallbackFacts: {
      schema: "pi-workflows.deferred-turn-facts.v1",
      workflowName: "autoimplement",
      runId: "run-1",
      observedState: "completed",
      cause: "terminal",
      nodeId: "$terminal",
      attemptId: null,
      reason: null,
      handoff: false,
    },
    requestedAt: "2026-08-28T00:00:00.000Z",
    eligibleAt: "2026-08-28T00:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    resolutionMessageId: null,
    deliveryClaimExpiresAt: null,
  };
}

describe("deferred turn messages", () => {
  it("builds a compact terminal view without the model prompt", () => {
    const view = buildDeferredTurnMessageView(
      {
        content: 'Terminal facts: {"fingerprint":"secret"}\nExact workflow input: large',
        details: terminalDetails,
      },
      false,
    );

    expect(view).toEqual({
      title: "✓ autoimplement · completed",
      status: "run run-1 · restart 0/3",
    });
    expect(JSON.stringify(view)).not.toContain("Terminal facts");
    expect(JSON.stringify(view)).not.toContain("fingerprint");
    expect(JSON.stringify(view)).not.toContain("Exact workflow input");
  });

  it("shows structured metadata and complete safe content when expanded", () => {
    const view = buildDeferredTurnMessageView(
      {
        content: "Terminal facts:\n\u001b[31mfull content\u001b[0m\nWorkflow result: done",
        details: {
          ...terminalDetails,
          runId: "run\nunsafe",
          presentation: {
            ...terminalDetails.presentation!,
            workflowName: "auto\n\u001b[31mimplement\u001b[0m",
            state: "timed_out",
            reasonKind: "timedOut",
            restart: { count: 2, limit: 3 },
          },
        },
      },
      true,
    );

    expect(view.title).toBe("! auto implement · timed out");
    expect(view.status).toBe("run run unsafe · restart 2/3");
    expect(view.expandedText).toContain("Workflow: auto implement");
    expect(view.expandedText).toContain("Run id: run unsafe");
    expect(view.expandedText).toContain("Reason kind: timed out");
    expect(view.expandedText).toContain("Terminal facts:\nfull content\nWorkflow result: done");
    expect(view.expandedText).not.toContain("\u001b");
  });

  it.each([
    ["completed", "completed", "✓"],
    ["failed", "failed", "×"],
    ["timed_out", "timedOut", "!"],
    ["failed", "maxSteps", "×"],
    ["cancelled", "cancelled", "!"],
    ["failed", "launchFailed", "×"],
  ] as const)("renders %s with %s status", (state, reasonKind, glyph) => {
    const view = buildDeferredTurnMessageView(
      {
        content: "full",
        details: {
          ...terminalDetails,
          presentation: {
            workflowName: "workflow",
            state,
            reasonKind,
            restart: { count: 0, limit: 3 },
          },
        },
      },
      false,
    );

    expect(view.title.startsWith(`${glyph} workflow · `)).toBe(true);
  });

  it("renders ordinary and malformed fallback details safely", () => {
    const ordinary = buildDeferredTurnMessageView(
      {
        content: "Inspect state",
        details: {
          schema: DEFERRED_TURN_MESSAGE_SCHEMA,
          turnIntentId: "intent-2",
          runId: "run-2",
          cause: "launchFailed",
        },
      },
      false,
    );
    expect(ordinary).toEqual({
      title: "× Workflow · launch failed",
      status: "run run-2",
    });

    const malformed = buildDeferredTurnMessageView(
      { content: "Complete prompt", details: { schema: "wrong", presentation: null } },
      true,
    );
    expect(malformed.title).toBe("◆ Workflow · deferred turn");
    expect(malformed.status).toBeUndefined();
    expect(malformed.expandedText).toContain("Run id: unknown");
    expect(malformed.expandedText).toContain("Complete prompt");
  });

  it("builds bounded presentation details from fallback and terminal records", () => {
    expect(deferredTurnMessageDetails(intent())).toMatchObject({
      presentation: { workflowName: "autoimplement", state: "completed" },
    });
    expect(
      deferredTurnMessageDetails(intent(), decision({ kind: "maxSteps", message: "max steps" })),
    ).toMatchObject({
      presentation: {
        workflowName: "autoimplement",
        state: "failed",
        reasonKind: "maxSteps",
        restart: { count: 1, limit: 3 },
      },
    });

    const longIntent = intent();
    longIntent.fallbackFacts.workflowName = `unsafe\n\u001b[31m${"x".repeat(1_000)}`;
    const presentation = deferredTurnMessageDetails(longIntent).presentation;
    expect(presentation?.workflowName).not.toContain("\u001b");
    expect(presentation?.workflowName).not.toContain("\n");
    expect(presentation?.workflowName).toHaveLength(512);
    expect(presentation?.workflowName.endsWith("…")).toBe(true);
  });

  it("registers one width-safe collapsed and expanded renderer", () => {
    let registrations = 0;
    let renderer:
      | ((
          message: never,
          options: { expanded: boolean },
          renderTheme: Theme,
        ) => { render(width: number): string[] })
      | undefined;
    const pi = {
      registerMessageRenderer: (customType: string, candidate: typeof renderer) => {
        expect(customType).toBe(DEFERRED_TURN_MESSAGE_TYPE);
        registrations += 1;
        renderer = candidate;
      },
    } as unknown as ExtensionAPI;
    registerDeferredTurnMessageRenderer(pi);

    const message = {
      role: "custom",
      customType: DEFERRED_TURN_MESSAGE_TYPE,
      content: "Complete terminal decision content",
      display: true,
      details: terminalDetails,
      timestamp: Date.now(),
    };
    const collapsed = renderer?.(message as never, { expanded: false }, theme).render(32) ?? [];
    expect(registrations).toBe(1);
    expect(collapsed.join("\n")).toContain("autoimplement");
    expect(collapsed.join("\n")).not.toContain("Complete terminal decision content");
    expect(collapsed.every((line) => visibleWidth(line) <= 32)).toBe(true);

    const expanded = renderer?.(message as never, { expanded: true }, theme).render(40) ?? [];
    expect(expanded.join("\n")).toContain("Complete terminal decision content");
    expect(expanded.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});
