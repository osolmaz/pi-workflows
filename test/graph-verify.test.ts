import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/render/ansi.js";
import { renderGraphLines } from "../src/render/graph-render.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowEdge,
  WorkflowRunState,
  WorkflowStepRecord,
} from "../src/workflows/types.js";
import { verifyBoxedGraphRender } from "./helpers/graph-verify.js";

/**
 * Property tests: for randomly generated workflow shapes and every replay
 * position, the boxed render must contain every node exactly once inside an
 * unbroken box, and every edge must be traceable through the drawn
 * characters. See test/helpers/graph-verify.ts for the tracing rules.
 */

/** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

const NODE_TYPES = ["agent", "compute", "action", "checkpoint"] as const;
const CASE_KEYS = ["y", "n", "retry", "clean", "issues_found", "ship_it"];

function randomSnapshot(seed: number): WorkflowDefinitionSnapshot {
  const random = rng(seed);
  const nodeCount = 2 + Math.floor(random() * 9);
  const nodeIds = Array.from({ length: nodeCount }, (_v, i) => `n${i}`);
  const edges: WorkflowEdge[] = [];

  // Spine: connect every node from a random earlier node so all are reachable.
  for (let i = 1; i < nodeCount; i += 1) {
    const from = `n${Math.floor(random() * i)}`;
    edges.push({ from, to: `n${i}` });
  }
  // Extra forward/skip edges.
  for (let i = 0; i < Math.floor(random() * 3); i += 1) {
    const a = Math.floor(random() * nodeCount);
    const b = Math.floor(random() * nodeCount);
    if (a !== b) {
      edges.push({ from: `n${Math.min(a, b)}`, to: `n${Math.max(a, b)}` });
    }
  }
  // Loop edges back up the spine.
  for (let i = 0; i < Math.floor(random() * 2 + (seed % 3 === 0 ? 1 : 0)); i += 1) {
    const from = 1 + Math.floor(random() * (nodeCount - 1));
    const to = Math.floor(random() * from);
    edges.push({ from: `n${from}`, to: `n${to}` });
  }
  // Occasionally convert a node's out-edges into a labelled switch.
  if (random() < 0.6 && nodeCount >= 3) {
    const from = `n${Math.floor(random() * (nodeCount - 1))}`;
    const targets = [
      ...new Set([`n${nodeCount - 1}`, `n${1 + Math.floor(random() * (nodeCount - 1))}`]),
    ];
    const cases = Object.fromEntries(
      targets.map((target, index) => [CASE_KEYS[index % CASE_KEYS.length] as string, target]),
    );
    edges.push({ from, switch: { on: "$.route", cases } });
  }

  return {
    schema: "pi-workflows.definition-snapshot.v1",
    name: `random-${seed}`,
    startAt: "n0",
    nodes: Object.fromEntries(
      nodeIds.map((id) => [id, { nodeType: pick(random, [...NODE_TYPES]) }]),
    ),
    edges,
  };
}

/** A plausible step history: a random walk over the declared edges. */
function randomSteps(snapshot: WorkflowDefinitionSnapshot, seed: number): WorkflowStepRecord[] {
  const random = rng(seed * 31 + 7);
  const successors = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), ...targets]);
  }
  const steps: WorkflowStepRecord[] = [];
  let node = snapshot.startAt;
  const count = Math.floor(random() * 8);
  for (let i = 0; i < count; i += 1) {
    const startedAt = new Date(1_752_900_000_000 + i * 10_000);
    steps.push({
      attemptId: `a${i}`,
      nodeId: node,
      nodeType: "agent",
      outcome: random() < 0.15 ? "failed" : "ok",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + 5_000).toISOString(),
      promptText: null,
      output: { i },
    });
    const next = successors.get(node) ?? [];
    if (next.length === 0) {
      break;
    }
    node = pick(random, next);
  }
  return steps;
}

function makeState(
  snapshot: WorkflowDefinitionSnapshot,
  steps: WorkflowStepRecord[],
  seed: number,
): WorkflowRunState {
  const running = seed % 2 === 0 && steps.length > 0;
  return {
    runId: `run-${seed}`,
    workflowName: snapshot.name,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    status: running ? "running" : "completed",
    input: {},
    outputs: {},
    results: {},
    steps,
    ...(running
      ? {
          currentNode: steps.at(-1)?.nodeId as string,
          currentNodeStartedAt: "2026-01-01T00:00:50.000Z",
        }
      : {}),
  };
}

const NOW = new Date("2026-01-01T00:01:00.000Z");

describe("boxed graph render verification", () => {
  const seeds = Array.from({ length: 200 }, (_v, i) => i + 1);

  it.each(seeds)("random workflow seed %i renders every node and edge correctly", (seed) => {
    const snapshot = randomSnapshot(seed);
    const steps = randomSteps(snapshot, seed);
    const state = makeState(snapshot, steps, seed);

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
