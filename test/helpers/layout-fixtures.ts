import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../../src/render/ansi.js";
import { renderGraphLines } from "../../src/render/graph-render.js";
import { layoutGraph } from "../../src/render/graph.js";
import { compileWorkflowDefinition } from "../../src/workflows/composition.js";
import { loadWorkflowFile } from "../../src/workflows/loader.js";
import { createDefinitionSnapshot } from "../../src/workflows/store.js";
import type { WorkflowDefinitionSnapshot, WorkflowRunState } from "../../src/workflows/types.js";
import { makeRandomRunState, randomSnapshot, randomSteps } from "./random-workflows.js";

/**
 * Golden fixtures that pin the graph layout and text render across
 * implementations: the TypeScript viewer is the reference, and the Rust TUI
 * (tui/) must reproduce these byte-for-byte. Regenerate with
 * `npm run fixtures` after intentional algorithm changes and update both
 * sides together.
 */

export type LayoutFixtureFrame = {
  /** Replay position handed to the renderer (-1 = before any step). */
  stepIndex: number;
  nodeStyle: "line" | "box";
  /** ANSI-stripped render output. */
  lines: string[];
};

export type LayoutFixture = {
  name: string;
  snapshot: WorkflowDefinitionSnapshot;
  layout: {
    ranks: ReturnType<typeof layoutGraph>["ranks"];
    edges: ReturnType<typeof layoutGraph>["edges"];
    segments: ReturnType<typeof layoutGraph>["segments"];
    /** `rankOfNode` map serialized as a plain object. */
    rankOfNode: Record<string, number>;
  };
  state: WorkflowRunState;
  frames: LayoutFixtureFrame[];
};

const NOW = new Date("2026-01-01T00:01:00.000Z");
const RANDOM_SEEDS = Array.from({ length: 24 }, (_v, i) => i + 1);

const EXAMPLES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "workflows",
);

const EXAMPLE_FILES = [
  "autoplan.workflow.ts",
  "autoimplement.workflow.ts",
  "autoresearch.workflow.ts",
  "branch.workflow.ts",
  "echo.workflow.ts",
  "shell.workflow.ts",
  "two-turn.workflow.ts",
];

function freshState(snapshot: WorkflowDefinitionSnapshot): WorkflowRunState {
  return {
    schema: "pi-workflows.run-state.v1",
    traceSeq: 1,
    runId: `run-${snapshot.name}`,
    workflowName: snapshot.name,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
  };
}

function humanDecisionFixture(): LayoutFixture {
  const snapshot: WorkflowDefinitionSnapshot = {
    schema: "pi-workflows.definition-snapshot.v1",
    name: "human-multigate",
    startAt: "first",
    nodes: {
      first: {
        nodeType: "checkpoint",
        humanDecision: {
          audience: "operator",
          choices: { continue: { label: "Continue" }, stop: { label: "Stop" } },
        },
      },
      second: {
        nodeType: "checkpoint",
        humanDecision: {
          audience: "reviewer",
          choices: { continue: { label: "Continue" }, replan: { label: "Replan" } },
        },
      },
    },
    edges: [{ from: "first", to: "second" }],
  };
  const state: WorkflowRunState = {
    ...freshState(snapshot),
    status: "waiting",
    waitingOn: "second",
    finalOutput: {
      schema: "pi-workflows.human-decision-request.v1",
      decisionId: "decision-second",
      requestDigest: `sha256:${"e".repeat(64)}`,
      subjectDigest: `sha256:${"f".repeat(64)}`,
      presentationDigest: `sha256:${"c".repeat(64)}`,
      runId: "run-human-multigate",
      workflowName: "human-multigate",
      nodeId: "second",
      attemptId: "attempt-second",
      audience: "reviewer",
      title: "Review the readable plan",
      subject: { plan: "second" },
      presentation: {
        schema: "pi-workflows.decision-presentation.v1",
        summary: "Review the readable plan.",
        blocks: [],
      },
      revision: 1,
      choices: { continue: { label: "Continue" }, replan: { label: "Replan" } },
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    humanDecision: {
      schema: "pi-workflows.human-decision-receipt.v1",
      provenance: "human",
      decisionId: "decision-first",
      requestDigest: `sha256:${"a".repeat(64)}`,
      subjectDigest: `sha256:${"f".repeat(64)}`,
      presentationDigest: `sha256:${"c".repeat(64)}`,
      revision: 1,
      nodeId: "first",
      response: { choice: "continue" },
      acceptedAt: "2026-01-01T00:00:10.000Z",
      answerDigest: `sha256:${"b".repeat(64)}`,
    },
    steps: [
      {
        attemptId: "attempt-first",
        nodeId: "first",
        nodeType: "checkpoint",
        outcome: "ok",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        prompt: null,
        output: { choice: "continue" },
      },
      {
        attemptId: "attempt-second",
        nodeId: "second",
        nodeType: "checkpoint",
        outcome: "ok",
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
        prompt: null,
        output: {
          schema: "pi-workflows.human-decision-request.v1",
          decisionId: "decision-second",
          requestDigest: `sha256:${"e".repeat(64)}`,
        },
      },
    ],
  };
  return buildFixture("human-multigate", snapshot, state);
}

function buildFixture(
  name: string,
  snapshot: WorkflowDefinitionSnapshot,
  state: WorkflowRunState,
): LayoutFixture {
  const layout = layoutGraph(snapshot);
  const bundle = { state, snapshot };
  const frames: LayoutFixtureFrame[] = [];
  const positions = [...new Set([-1, state.steps.length - 1])];
  for (const stepIndex of positions) {
    for (const nodeStyle of ["line", "box"] as const) {
      frames.push({
        stepIndex,
        nodeStyle,
        lines: renderGraphLines(bundle, stepIndex, NOW, { nodeStyle }).map(stripAnsi),
      });
    }
  }
  return {
    name,
    snapshot,
    layout: {
      ranks: layout.ranks,
      edges: layout.edges,
      segments: layout.segments,
      rankOfNode: Object.fromEntries(layout.rankOfNode),
    },
    state,
    frames,
  };
}

export async function buildLayoutFixtures(): Promise<LayoutFixture[]> {
  const fixtures: LayoutFixture[] = [];
  for (const file of EXAMPLE_FILES) {
    const loaded = await loadWorkflowFile(path.join(EXAMPLES_DIR, file));
    const workflow = compileWorkflowDefinition(loaded);
    const snapshot = createDefinitionSnapshot(workflow);
    fixtures.push(buildFixture(`example-${workflow.name}`, snapshot, freshState(snapshot)));
  }
  fixtures.push(humanDecisionFixture());
  for (const seed of RANDOM_SEEDS) {
    const snapshot = randomSnapshot(seed);
    const steps = randomSteps(snapshot, seed);
    const state = makeRandomRunState(snapshot, steps, seed);
    fixtures.push(buildFixture(`random-${seed}`, snapshot, state));
  }
  return fixtures;
}

export function fixturesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "layout");
}
