import { describe, expect, it } from "vitest";
import { renderClientView } from "../src/viewer/tui.js";

describe("host client renderer", () => {
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
    expect(lines).toContain("  ✓ prepare · ok");
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
