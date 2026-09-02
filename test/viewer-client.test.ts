import { describe, expect, it, vi } from "vitest";
import type { WorkflowClient } from "../src/client/client.js";
import { materializeRunView } from "../src/client/materialize.js";
import type { JsonValue } from "../src/state/json.js";
import { firstRunView } from "../src/viewer/cli.js";
import { renderClientView } from "../src/viewer/tui.js";

describe("host client renderer", () => {
  it("rejects a missing one-shot run", async () => {
    const client = { getRun: vi.fn(async () => null) } as unknown as WorkflowClient;
    await expect(firstRunView(client, "missing-run")).rejects.toThrow(
      "Workflow run not found: missing-run",
    );
  });

  it("materializes paged history and referenced content", async () => {
    const hydrateContent = vi.fn(async (_runId: string, value: JsonValue) => {
      const hydrated = structuredClone(value) as Record<string, JsonValue>;
      const state = hydrated.state as Record<string, JsonValue>;
      state.finalOutput = { ready: true };
      const workflow = hydrated.workflow as Record<string, JsonValue>;
      workflow.content = {
        schema: "pi-workflows.definition-snapshot.v1",
        name: "paged",
        startAt: "one",
        nodes: { one: { nodeType: "compute" }, two: { nodeType: "compute" } },
        edges: [{ from: "one", to: "two" }],
      };
      hydrated.graphHistory = {
        steps: [
          { nodeId: "one", outcome: "ok" },
          { nodeId: "two", outcome: "ok" },
          { nodeId: "three", outcome: "ok" },
        ],
        transitions: ["one->two", "two->three"],
      };
      return hydrated;
    });
    const request = vi.fn(async () => ({
      schema: "pi-workflows.client.v1" as const,
      type: "response" as const,
      requestId: "page",
      outcome: "accepted" as const,
      receipt: {
        schema: "pi-workflows.run-page.v1",
        runId: "run-paged",
        revision: 7,
        kind: "steps",
        cursor: 0,
        start: 0,
        total: 3,
        items: [
          { nodeId: "one", outcome: "ok" },
          { nodeId: "two", outcome: "ok" },
        ],
      },
    }));
    const client = { request, hydrateContent } as unknown as WorkflowClient;

    const materialized = (await materializeRunView(client, {
      schema: "pi-workflows.run-view.v1",
      runId: "run-paged",
      revision: 7,
      state: {
        steps: [{ nodeId: "three", outcome: "ok" }],
        finalOutput: { $artifact: { path: "content/final.json" } },
      },
      stepStart: 2,
      stepTotal: 3,
      graphCursor: 2,
      graphSteps: [{ nodeId: "three", outcome: "ok" }],
      takenTransitions: [],
      graphHistory: { $artifact: { path: "content/graph-history.json" } },
      workflow: {
        schema: "pi-workflows.definition-snapshot.v1",
        name: "paged",
        startAt: "one",
        nodes: {},
        edges: [],
        content: { $artifact: { path: "content/workflow.json" } },
      },
      tracePage: { start: 0, total: 0, items: [] },
      session: {
        entryPage: { start: 0, total: 0, items: [] },
        eventPage: { start: 0, total: 0, items: [] },
      },
      settingsScopes: [],
      settingsStart: 0,
      settingsTotal: 0,
      followUpQueue: { items: [] },
      followUpStart: 0,
      followUpTotal: 0,
      updates: [],
      updateStart: 0,
      updateTotal: 0,
    })) as Record<string, JsonValue>;

    expect(request).toHaveBeenCalledWith({
      operation: "view.page",
      runId: "run-paged",
      expectedRevision: 7,
      payload: { kind: "steps", cursor: 0 },
    });
    expect((materialized.state as Record<string, JsonValue>).steps).toEqual([
      { nodeId: "one", outcome: "ok" },
      { nodeId: "two", outcome: "ok" },
      { nodeId: "three", outcome: "ok" },
    ]);
    expect((materialized.state as Record<string, JsonValue>).finalOutput).toEqual({ ready: true });
    expect(materialized.graphSteps).toEqual([
      { nodeId: "one", outcome: "ok" },
      { nodeId: "two", outcome: "ok" },
      { nodeId: "three", outcome: "ok" },
    ]);
    expect(materialized.takenTransitions).toEqual(["one->two", "two->three"]);
    expect((materialized.workflow as Record<string, JsonValue>).nodes).toEqual({
      one: { nodeType: "compute" },
      two: { nodeType: "compute" },
    });
    expect(hydrateContent).toHaveBeenCalledOnce();
  });

  it("rejects a page from another run revision", async () => {
    const client = {
      request: vi.fn(async () => ({
        outcome: "accepted",
        receipt: {
          schema: "pi-workflows.run-page.v1",
          runId: "run-paged",
          revision: 8,
          kind: "steps",
          cursor: 0,
          start: 0,
          total: 1,
          items: [{ nodeId: "one", outcome: "ok" }],
        },
      })),
      hydrateContent: vi.fn(async (_runId: string, value: JsonValue) => value),
    } as unknown as WorkflowClient;

    await expect(
      materializeRunView(client, {
        schema: "pi-workflows.run-view.v1",
        runId: "run-paged",
        revision: 7,
        state: { steps: [] },
        stepStart: 0,
        stepTotal: 1,
      }),
    ).rejects.toThrow("Workflow steps page changed while loading");
  });

  it("renders a completed run without exposing raw protocol JSON", () => {
    const lines = renderClientView(
      {
        schema: "pi-workflows.run-view.v1",
        runId: "run-1",
        manifest: { workflowName: "smoke" },
        display: { status: "completed", reason: null },
        state: {
          workflowName: "smoke",
          status: "completed",
          steps: [{ nodeId: "prepare", outcome: "ok" }],
          finalOutput: { ready: true },
        },
      },
      100,
      100,
      undefined,
      0,
    );

    expect(lines).toContain("workflow smoke");
    expect(lines).toContain("✓ completed · run run-1");
    expect(lines).toContain("> ✓ prepare · ok");
    expect(lines).toContain('output {"ready":true}');
  });

  it("renders every host status without inventing another reducer", () => {
    const cases = [
      ["running", "●"],
      ["waiting", "○"],
      ["paused", "‖"],
      ["queued", "…"],
      ["failed", "✗"],
      ["timed_out", "✗"],
      ["cancelled", "✗"],
      ["ambiguous", "!"],
    ] as const;
    for (const [status, glyph] of cases) {
      const lines = renderClientView(
        {
          schema: "pi-workflows.run-view.v1",
          runId: "run-1",
          manifest: { workflowName: "status" },
          display: { status, reason: null },
          state: { steps: [{ nodeId: "step", outcome: status }] },
        },
        100,
        100,
        undefined,
        0,
      );
      expect(lines[1]).toBe(`${glyph} ${status} · run run-1`);
    }
  });

  it("renders the exact host status and safe fallback values", () => {
    expect(
      renderClientView(
        {
          schema: "pi-workflows.run-view.v1",
          runId: "run\u001b[31m",
          manifest: {},
          display: { status: "ambiguous", reason: "check\u001b[31m" },
          state: { workflowName: "unsafe\u001b[31m", error: "failed\u001b[31m" },
        },
        100,
        100,
        undefined,
        0,
      ).join("\n"),
    ).not.toContain("\u001b");
    expect(renderClientView(null, 100, 100, undefined, 0)).toEqual(["null"]);
  });
});
