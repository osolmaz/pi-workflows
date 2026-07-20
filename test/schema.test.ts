import { describe, expect, it, vi } from "vitest";
import {
  action,
  agent,
  checkpoint,
  compute,
  defineWorkflow,
  isWorkflowDefinition,
  shell,
} from "../src/workflows/definition.js";
import {
  CancelledError,
  TimeoutError,
  errorMessage,
  isAbortLikeError,
} from "../src/workflows/errors.js";
import {
  createDefinitionSnapshot,
  readRunBundle,
  workflowRunsBaseDir,
} from "../src/workflows/store.js";
import type { WorkflowDefinition, WorkflowEdge } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

const validNodes = { start: compute({ run: () => 1 }) };

function define(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return defineWorkflow({
    name: "valid",
    startAt: "start",
    nodes: validNodes,
    edges: [],
    ...overrides,
  } as WorkflowDefinition);
}

describe("defineWorkflow validation", () => {
  it("accepts a valid workflow and brands it once", () => {
    const workflow = define({});
    expect(isWorkflowDefinition(workflow)).toBe(true);
    expect(defineWorkflow(workflow)).toBe(workflow);
  });

  it("rejects reserved workflow names claimed by /workflow subcommands", () => {
    for (const name of ["cancel", "list", "pause", "resume"]) {
      expect(() => define({ name })).toThrow(/reserved for \/workflow subcommands/);
    }
  });

  it("rejects missing or invalid top-level fields", () => {
    expect(() => define({ name: "" })).toThrow(/requires a name/);
    expect(() => define({ startAt: "" })).toThrow(/requires startAt/);
    expect(() => define({ title: 5 as never })).toThrow(/title must be a string or function/);
    expect(() => define({ maxSteps: 0 })).toThrow(/maxSteps must be a positive integer/);
    expect(() => define({ maxSteps: 1.5 })).toThrow(/maxSteps must be a positive integer/);
    expect(() => define({ nodes: {} })).toThrow(/at least one node/);
    expect(() => define({ nodes: [] as never })).toThrow(/must be an object/);
    expect(() => define({ edges: {} as never })).toThrow(/edges must be an array/);
  });

  it("rejects bad node ids and unknown node types", () => {
    expect(() => define({ nodes: { "bad id!": compute({ run: () => 1 }) } })).toThrow(/must match/);
    expect(() => define({ nodes: { x: { nodeType: "mystery" } as never } })).toThrow(
      /unknown nodeType/,
    );
  });

  it("rejects malformed edges", () => {
    const edge = (value: unknown) => define({ edges: [value as WorkflowEdge] });
    expect(() => edge({ to: "start" })).toThrow(/requires a from/);
    expect(() => edge({ from: "start", to: "" })).toThrow(/requires a to/);
    expect(() => edge({ from: "start", switch: { on: "", cases: { a: "start" } } })).toThrow(
      /switch\.on/,
    );
    expect(() => edge({ from: "start", switch: { on: "$.x", cases: {} } })).toThrow(
      /must not be empty/,
    );
    expect(() => edge({ from: "start", switch: { on: "$.x", cases: { a: 1 } } })).toThrow(
      /must map to a node id/,
    );
  });
});

describe("node constructors", () => {
  it("validates agent nodes", () => {
    expect(() => agent({ prompt: "nope" as never })).toThrow(/requires a prompt function/);
    expect(() => agent({ prompt: () => "p", expectedOutput: 5 as never })).toThrow(
      /expectedOutput/,
    );
    expect(() => agent({ prompt: () => "p", validate: "x" as never })).toThrow(/validate/);
    expect(() => agent({ prompt: () => "p", timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => agent({ prompt: () => "p", statusDetail: 1 as never })).toThrow(/statusDetail/);
    expect(agent({ prompt: () => "p" }).nodeType).toBe("agent");
  });

  it("validates compute nodes", () => {
    expect(() => compute({ run: "nope" as never })).toThrow(/requires a run function/);
  });

  it("validates action nodes", () => {
    expect(() => action({} as never)).toThrow(/exactly one of run or exec/);
    expect(() => action({ run: () => 1, exec: () => ({ command: "x" }) } as never)).toThrow(
      /exactly one of run or exec/,
    );
    expect(() => action({ exec: () => ({ command: "x" }), parse: "y" as never })).toThrow(/parse/);
    expect(action({ run: () => 1 }).nodeType).toBe("action");
    expect(action({ exec: () => ({ command: "x" }) }).nodeType).toBe("action");
  });

  it("validates shell nodes", () => {
    expect(() => shell({ exec: undefined as never })).toThrow(/requires an exec function/);
    expect(() => shell({ exec: () => ({ command: "x" }), parse: 1 as never })).toThrow(/parse/);
    expect(shell({ exec: () => ({ command: "x" }) }).nodeType).toBe("action");
  });

  it("validates checkpoint nodes", () => {
    expect(() => checkpoint({ summary: 1 as never })).toThrow(/summary/);
    expect(() => checkpoint({ run: "x" as never })).toThrow(/run/);
    expect(checkpoint().nodeType).toBe("checkpoint");
  });
});

describe("errors helpers", () => {
  it("describes timeouts and cancellations", () => {
    const timeout = new TimeoutError(1500);
    expect(timeout.message).toBe("Timed out after 1500ms");
    expect(timeout.timeoutMs).toBe(1500);
    expect(new CancelledError().message).toContain("cancelled");
  });

  it("detects abort-like errors", () => {
    expect(isAbortLikeError(new CancelledError())).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isAbortLikeError(abort)).toBe(true);
    expect(isAbortLikeError(new Error("other"))).toBe(false);
    expect(isAbortLikeError("nope")).toBe(false);
  });

  it("stringifies unknown error values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("definition snapshots", () => {
  it("captures per-node metadata for every node type", () => {
    const workflow = define({
      nodes: {
        start: agent({
          prompt: () => "p",
          expectedOutput: "{}",
          timeoutMs: 1000,
          statusDetail: "thinking",
        }),
        act: shell({ exec: () => ({ command: "true" }) }),
        fn: action({ run: () => 1 }),
        stop: checkpoint({ summary: "pause here" }),
      },
      edges: [
        { from: "start", to: "act" },
        { from: "act", to: "fn" },
        { from: "fn", to: "stop" },
      ],
    });
    const snapshot = createDefinitionSnapshot(workflow);
    expect(snapshot.nodes.start).toEqual({
      nodeType: "agent",
      expectedOutput: "{}",
      timeoutMs: 1000,
      statusDetail: "thinking",
    });
    expect(snapshot.nodes.act).toEqual({ nodeType: "action", actionExecution: "shell" });
    expect(snapshot.nodes.fn).toEqual({ nodeType: "action", actionExecution: "function" });
    expect(snapshot.nodes.stop).toEqual({ nodeType: "checkpoint", summary: "pause here" });
  });
});

describe("store misc", () => {
  it("honors the PI_WORKFLOWS_RUNS_DIR override", () => {
    vi.stubEnv("PI_WORKFLOWS_RUNS_DIR", "/tmp/custom-runs");
    try {
      expect(workflowRunsBaseDir()).toBe("/tmp/custom-runs");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null for unreadable bundles", async () => {
    const dir = await makeTempDir("pi-workflows-junk");
    expect(await readRunBundle(dir)).toBeNull();
  });
});
