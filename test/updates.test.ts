import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { action, agent, defineWorkflow, shell } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { estimateProgress, formatProgressLine } from "../src/workflows/progress.js";
import type { WorkflowTraceEvent } from "../src/workflows/types.js";
import { validateWorkflowUpdate } from "../src/workflows/updates.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

async function engine(executor = new ScriptedExecutor()) {
  return {
    executor,
    engine: new WorkflowEngine({ executor, outputRoot: await makeTempDir("workflow-updates") }),
  };
}

describe("workflow updates", () => {
  it("persists function-action updates in trace order and projects the latest value", async () => {
    const { engine: runtime } = await engine();
    const workflow = defineWorkflow({
      name: "function-updates",
      startAt: "work",
      nodes: {
        work: action({
          run: async ({ publishUpdate }) => {
            await publishUpdate({ type: "progress", key: "overall", data: progress(1, 3) });
            await publishUpdate({ type: "progress", key: "overall", data: progress(2, 3) });
            return "done";
          },
        }),
      },
      edges: [],
    });

    const result = await runtime.run(workflow, {});
    expect(result.state.updates).toHaveLength(1);
    expect(result.state.updates?.[0]?.data.completed).toBe(2);
    const trace = (await fs.readFile(path.join(result.runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowTraceEvent);
    const updates = trace.filter((event) => event.type === "update_published");
    expect(updates).toHaveLength(2);
    expect(updates.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("accepts agent updates without completing the step and deduplicates delivery", async () => {
    const executor = new ScriptedExecutor().respond("check", async (request) => {
      const first = await request.publishUpdate?.(
        { type: "progress", key: "job", data: progress(4, 10) },
        "tool-call-1",
      );
      const duplicate = await request.publishUpdate?.(
        { type: "progress", key: "job", data: progress(9, 10) },
        "tool-call-1",
      );
      expect(duplicate).toEqual(first);
      const accepted = await request.accept({ ok: true });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
    const { engine: runtime } = await engine(executor);
    const workflow = defineWorkflow({
      name: "agent-updates",
      startAt: "check",
      nodes: { check: agent({ prompt: () => "check" }) },
      edges: [],
    });

    const result = await runtime.run(workflow, {});
    expect(result.state.status).toBe("completed");
    expect(result.state.updates).toHaveLength(1);
    expect(result.state.updates?.[0]?.data.completed).toBe(4);
  });

  it("parses shell update lines while retaining normal output", async () => {
    const { engine: runtime } = await engine();
    const workflow = defineWorkflow({
      name: "shell-updates",
      startAt: "work",
      nodes: {
        work: shell({
          exec: () => ({
            command: process.execPath,
            args: ["-e", "console.log(JSON.stringify({n:1})); console.log(JSON.stringify({n:2}))"],
          }),
          updates: {
            parseLine: ({ text }) => {
              const value = JSON.parse(text) as { n: number };
              return { type: "progress", key: "shell", data: progress(value.n, 2) };
            },
          },
        }),
      },
      edges: [],
    });

    const result = await runtime.run(workflow, {});
    expect(result.state.status).toBe("completed");
    expect(result.state.updates?.[0]?.data.completed).toBe(2);
    expect((result.state.finalOutput as { stdout: string }).stdout).toContain('{"n":2}');
  });

  it("validates update envelopes and progress fields", () => {
    expect(() => validateWorkflowUpdate({ type: "Bad", key: "x", data: {} })).toThrow(
      "update.type",
    );
    expect(() =>
      validateWorkflowUpdate({
        type: "progress",
        key: "x",
        data: { ...progress(2, 1) },
      }),
    ).toThrow("at least progress.completed");
  });
});

describe("progress estimation", () => {
  it("uses recent measured intervals and shows an ETA", () => {
    const estimate = estimateProgress(
      "overall",
      [
        { at: "2026-08-16T10:00:00.000Z", data: progress(0, 100) },
        { at: "2026-08-16T10:01:00.000Z", data: progress(20, 100) },
        { at: "2026-08-16T10:02:00.000Z", data: progress(40, 100) },
      ],
      new Date("2026-08-16T10:02:00.000Z"),
    );
    expect(estimate.sampleCount).toBe(3);
    expect(estimate.remainingMedianMs).toBe(180_000);
    expect(formatProgressLine(estimate, new Date("2026-08-16T10:02:00.000Z"))).toContain("ETA 3m");
  });

  it("uses a fresh target-supplied finish time", () => {
    const data = {
      ...progress(1, 10),
      sourceUpdatedAt: "2026-08-16T10:00:00.000Z",
      sourceEstimatedFinishAt: "2026-08-16T10:30:00.000Z",
    };
    const estimate = estimateProgress(
      "job",
      [{ at: "2026-08-16T10:00:01.000Z", data }],
      new Date("2026-08-16T10:10:00.000Z"),
    );
    expect(formatProgressLine(estimate, new Date("2026-08-16T10:10:00.000Z"))).toContain(
      "source ETA 20m",
    );
  });
});

function progress(completed: number, total: number) {
  return {
    schema: "pi-workflows.progress.v1" as const,
    status: "running" as const,
    completed,
    total,
    unit: "items",
  };
}
