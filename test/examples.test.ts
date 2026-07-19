import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { loadWorkflowFile } from "../src/workflows/loader.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

/**
 * Every workflow shipped in examples/ must load, validate, and — for the
 * loop-shaped ones — actually run through the engine with scripted agents.
 */

const EXAMPLES_DIR = path.resolve(__dirname, "..", "examples", "workflows");

describe("shipped examples", () => {
  it("loads and validates every example workflow", async () => {
    const files = (await fs.readdir(EXAMPLES_DIR)).filter((file) => file.endsWith(".workflow.ts"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const workflow = await loadWorkflowFile(path.join(EXAMPLES_DIR, file));
      expect(workflow.name, file).toBeTruthy();
    }
  });

  it("runs the autoresearch loop through setup, generations, and conclusions", async () => {
    const workflow = await loadWorkflowFile(path.join(EXAMPLES_DIR, "autoresearch.workflow.ts"));
    const executor = new ScriptedExecutor()
      .respond("setup", {
        output: {
          dir: "research/loop",
          keepCriterion: "auc 1.0 and loo 18/18, maximize margin",
          baseline: "auc=0.61",
        },
      })
      .respond(
        "experiment",
        {
          output: {
            generation: "gen 1: order statistics",
            best: "auc=0.90",
            kept: false,
            next: "spine percentile",
          },
        },
        {
          output: {
            generation: "gen 2: spine percentile",
            best: "auc=1.0 margin=+17%",
            kept: true,
            next: null,
          },
        },
      )
      .respond(
        "assess",
        { output: { route: "continue", reason: "gen 1 failed but pointed at the spine" } },
        { output: { route: "plateau", reason: "margin stable across neighboring percentiles" } },
      )
      .respond("conclude", {
        output: {
          outcome: "plateau",
          winner: "spine percentile, auc=1.0 margin=+17% loo=18/18",
          journal: "research/loop/journal.md",
        },
      });
    const engine = new WorkflowEngine({
      executor,
      outputRoot: await makeTempDir("pi-workflows-autoresearch"),
    });

    const { state } = await engine.run(workflow, { goal: "separate group A from group B" });

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toEqual([
      "setup",
      "experiment",
      "assess",
      "experiment",
      "assess",
      "conclude",
      "finalize",
    ]);
    expect(state.runTitle).toBe("autoresearch: separate group A from group B");
    const final = state.finalOutput as { conclusions: { outcome: string } };
    expect(final.conclusions.outcome).toBe("plateau");
  });
});
