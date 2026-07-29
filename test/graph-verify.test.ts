import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/render/ansi.js";
import { renderGraphLines } from "../src/render/graph-render.js";
import { verifyBoxedGraphRender } from "./helpers/graph-verify.js";
import { makeRandomRunState, randomSnapshot, randomSteps } from "./helpers/random-workflows.js";

/**
 * Property tests: for randomly generated workflow shapes and every replay
 * position, the boxed render must contain every node exactly once inside an
 * unbroken box, and every edge must be traceable through the drawn
 * characters. See test/helpers/graph-verify.ts for the tracing rules.
 */

const NOW = new Date("2026-01-01T00:01:00.000Z");

describe("boxed graph render verification", () => {
  const seeds = Array.from({ length: 200 }, (_v, i) => i + 1);

  it.each(seeds)("random workflow seed %i renders every node and edge correctly", (seed) => {
    const snapshot = randomSnapshot(seed);
    const steps = randomSteps(snapshot, seed);
    const state = makeRandomRunState(snapshot, steps, seed);

    // Verify at every replay position, not just the live view.
    for (let index = -1; index < steps.length; index += 1) {
      const lines = renderGraphLines({ state, snapshot }, index, NOW, { nodeStyle: "box" }).map(
        stripAnsi,
      );
      const { problems } = verifyBoxedGraphRender(snapshot, lines);
      expect(
        problems,
        `seed ${seed} step ${index}\n${lines.join("\n")}\n${problems.join("\n")}`,
      ).toEqual([]);

      // The line style must also render every node exactly once.
      const flat = renderGraphLines({ state, snapshot }, index, NOW).map(stripAnsi).join("\n");
      for (const nodeId of Object.keys(snapshot.nodes)) {
        const occurrences = flat.split(` ${nodeId} [`).length - 1;
        expect(occurrences, `seed ${seed} line-style node ${nodeId}`).toBe(1);
      }
    }
  });
});
