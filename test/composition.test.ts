import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileWorkflowDefinition, compositionMetadata } from "../src/workflows/composition.js";
import {
  checkpoint,
  compute,
  defineWorkflow,
  defineWorkflowRegistry,
  includedResult,
  includeWorkflow,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { validateWorkflowDefinition } from "../src/workflows/graph.js";
import { readRunBundle } from "../src/workflows/store.js";
import type { WorkflowDefinition, WorkflowTraceEvent } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

function childWorkflow() {
  return defineWorkflow({
    name: "child",
    input: (value): { task: string } => {
      if (value === null || typeof value !== "object") throw new Error("input must be an object");
      const task = (value as { task?: unknown }).task;
      if (typeof task !== "string") throw new Error("task must be a string");
      return { task };
    },
    startAt: "work",
    exits: {
      ready: {
        from: "finish",
        validate: (value: unknown): { result: string } => value as { result: string },
      },
      blocked: {
        from: "blocked",
        validate: (value: unknown): { reason: string } => value as { reason: string },
      },
    },
    nodes: {
      work: compute({
        run: ({ input, outputs, state }) => ({
          task: (input as { task: string }).task,
          clean: Object.keys(outputs).length === 0 && state.steps.length === 0,
          route: (input as { task: string }).task === "block" ? "blocked" : "ready",
        }),
      }),
      finish: compute({
        run: ({ outputs }) => ({
          result: `${(outputs.work as { task: string }).task}:done`,
          clean: (outputs.work as { clean: boolean }).clean,
        }),
      }),
      blocked: compute({ run: () => ({ reason: "blocked" }) }),
    },
    edges: [
      {
        from: "work",
        switch: { on: "$.route", cases: { ready: "finish", blocked: "blocked" } },
      },
    ],
    maxSteps: 4,
  });
}

describe("workflow composition", () => {
  it("builds typed registries and validates included result exits", () => {
    const child = childWorkflow();
    expect(defineWorkflowRegistry({ child }).child).toBe(child);
    expect(() => defineWorkflowRegistry({ one: child, two: child })).toThrow(/duplicate/);
    expect(includedResult(child, { exit: "ready", output: { result: "ok" } })).toEqual({
      exit: "ready",
      output: { result: "ok" },
    });
    expect(() => includedResult(child, { exit: "missing", output: {} })).toThrow(/unknown exit/);
    expect(() => includedResult(child, null)).toThrow(/must be an object/);
    expect(() => includedResult(child, { exit: "ready" })).toThrow(/requires output/);
  });

  it("runs a typed child and exposes only its named result", async () => {
    const child = childWorkflow();
    const parent = defineWorkflow({
      name: "parent",
      startAt: "start",
      includes: {
        repair: includeWorkflow(child, {
          input: ({ outputs }) => ({ task: String(outputs.start) }),
        }),
      },
      nodes: {
        start: compute({ run: () => "demo" }),
        finish: compute({
          run: ({ outputs }) => ({ result: outputs.repair, keys: Object.keys(outputs).sort() }),
        }),
      },
      edges: [
        { from: "start", to: "repair" },
        { from: "repair.ready", to: "finish" },
      ],
    });
    const compiled = compileWorkflowDefinition(parent);
    validateWorkflowDefinition(compiled);
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      outputRoot: await makeTempDir("pi-workflows-composition"),
    });

    const { runDir, state } = await engine.run(compiled, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({
      result: {
        exit: "ready",
        output: { result: "demo:done", clean: true },
      },
      keys: ["repair", "start"],
    });
    expect(state.steps.map((step) => step.nodeId)).toEqual([
      "start",
      "repair",
      "repair/work",
      "repair/finish",
      "repair/__piw_exit_ready",
      "finish",
    ]);
    const bundle = await readRunBundle(runDir);
    expect(bundle?.snapshot?.composition?.mounts).toHaveLength(1);
    const trace = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowTraceEvent);
    expect(trace.filter((event) => event.type === "include_entered")).toHaveLength(1);
    expect(trace.filter((event) => event.type === "include_exited")).toHaveLength(1);
  });

  it("starts every re-entry with empty child-local state", async () => {
    const child = childWorkflow();
    const parent = defineWorkflow({
      name: "repeat-parent",
      startAt: "start",
      maxSteps: 20,
      includes: {
        repair: includeWorkflow(child, {
          input: ({ outputs }) => ({
            task: String((outputs.decide as { count?: number } | undefined)?.count ?? 0),
          }),
        }),
      },
      nodes: {
        start: compute({ run: () => ({}) }),
        decide: compute({
          run: ({ outputs }) => {
            const previous = outputs.decide as { count?: number } | undefined;
            const count = (previous?.count ?? 0) + 1;
            const childResult = outputs.repair as {
              output: { clean: boolean };
            };
            return { count, clean: childResult.output.clean, route: count < 2 ? "repeat" : "done" };
          },
        }),
        finish: compute({ run: ({ outputs }) => outputs.decide }),
      },
      edges: [
        { from: "start", to: "repair" },
        { from: "repair.ready", to: "decide" },
        { from: "decide", switch: { on: "$.route", cases: { repeat: "repair", done: "finish" } } },
      ],
    });
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      outputRoot: await makeTempDir("pi-workflows-composition-repeat"),
    });

    const { state } = await engine.run(parent, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({ count: 2, clean: true });
    expect(state.steps.filter((step) => step.nodeId === "repair")).toHaveLength(2);
  });

  it("supports nested mounts of one reusable definition", async () => {
    const leaf = childWorkflow();
    const middle = defineWorkflow({
      name: "middle",
      startAt: "start",
      includes: {
        inner: includeWorkflow(leaf, { input: () => ({ task: "nested" }) }),
      },
      exits: { ready: { from: "finish" } },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: ({ outputs }) => outputs.inner }),
      },
      edges: [
        { from: "start", to: "inner" },
        { from: "inner.ready", to: "finish" },
      ],
    });
    const outer = defineWorkflow({
      name: "outer",
      startAt: "start",
      includes: { middle: includeWorkflow(middle) },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: ({ outputs }) => outputs.middle }),
      },
      edges: [
        { from: "start", to: "middle" },
        { from: "middle.ready", to: "finish" },
      ],
    });
    const compiled = compileWorkflowDefinition(outer);
    const mounts = compositionMetadata(compiled)?.snapshot.mounts ?? [];
    expect(mounts.map((mount) => mount.mountPath.join("/"))).toEqual(["middle", "middle/inner"]);
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      outputRoot: await makeTempDir("pi-workflows-composition-nested"),
    });

    const { state } = await engine.run(compiled, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toMatchObject({
      exit: "ready",
      output: { exit: "ready", output: { result: "nested:done" } },
    });
  });

  it("continues from a checkpoint inside an included workflow", async () => {
    const child = defineWorkflow({
      name: "checkpoint-child",
      startAt: "gate",
      exits: { ready: { from: "finish" } },
      nodes: {
        gate: checkpoint({ run: () => ({ approved: true }) }),
        finish: compute({ run: ({ outputs }) => outputs.gate }),
      },
      edges: [{ from: "gate", to: "finish" }],
    });
    const parent = defineWorkflow({
      name: "checkpoint-parent",
      startAt: "start",
      includes: { child: includeWorkflow(child) },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: ({ outputs }) => outputs.child }),
      },
      edges: [
        { from: "start", to: "child" },
        { from: "child.ready", to: "finish" },
      ],
    });
    const outputRoot = await makeTempDir("pi-workflows-composition-checkpoint");
    const engine = new WorkflowEngine({ executor: new ScriptedExecutor(), outputRoot });

    const waiting = await engine.run(parent, {});
    expect(waiting.state.status).toBe("waiting");
    expect(waiting.state.waitingOn).toBe("child/gate");

    const continuation = await engine.continueRun(parent, waiting.state.runId, { answer: "yes" });
    expect(continuation.state.status).toBe("completed");
    expect(continuation.state.finalOutput).toEqual({
      exit: "ready",
      output: { approved: true },
    });
  });

  it("enforces a child maxSteps limit per invocation", async () => {
    const child = defineWorkflow({
      name: "bounded-child",
      startAt: "one",
      maxSteps: 1,
      exits: { ready: { from: "two" } },
      nodes: {
        one: compute({ run: () => 1 }),
        two: compute({ run: () => 2 }),
      },
      edges: [{ from: "one", to: "two" }],
    });
    const parent = defineWorkflow({
      name: "bounded-parent",
      startAt: "start",
      includes: { child: includeWorkflow(child) },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [
        { from: "start", to: "child" },
        { from: "child.ready", to: "finish" },
      ],
    });
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      outputRoot: await makeTempDir("pi-workflows-composition-limit"),
    });

    const { state } = await engine.run(parent, {});

    expect(state.status).toBe("failed");
    expect(state.error).toContain("bounded-child");
    expect(state.error).toContain("maxSteps=1");
  });

  it("applies an ancestor child limit before nested side effects", async () => {
    const sideEffect = vi.fn(() => ({ done: true }));
    const inner = defineWorkflow({
      name: "inner-limit",
      startAt: "work",
      exits: { ready: { from: "work" } },
      nodes: { work: compute({ run: sideEffect }) },
      edges: [],
    });
    const middle = defineWorkflow({
      name: "middle-limit",
      startAt: "start",
      maxSteps: 1,
      includes: { inner: includeWorkflow(inner) },
      exits: { ready: { from: "finish" } },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [
        { from: "start", to: "inner" },
        { from: "inner.ready", to: "finish" },
      ],
    });
    const parent = defineWorkflow({
      name: "ancestor-limit",
      startAt: "start",
      includes: { middle: includeWorkflow(middle) },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [
        { from: "start", to: "middle" },
        { from: "middle.ready", to: "finish" },
      ],
    });
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      outputRoot: await makeTempDir("pi-workflows-composition-ancestor-limit"),
    });

    const { state } = await engine.run(parent, {});

    expect(state.status).toBe("failed");
    expect(state.error).toContain("middle-limit");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("rejects an included child terminal path without a named exit", () => {
    const child = defineWorkflow({
      name: "partial-exits",
      startAt: "choose",
      exits: { ready: { from: "ready" } },
      nodes: {
        choose: compute({ run: () => ({ route: "ready" }) }),
        ready: compute({ run: () => ({ ok: true }) }),
        undeclared: compute({ run: () => ({ ok: false }) }),
      },
      edges: [
        {
          from: "choose",
          switch: { on: "$.route", cases: { ready: "ready", other: "undeclared" } },
        },
      ],
    });
    const parent = defineWorkflow({
      name: "partial-parent",
      startAt: "start",
      includes: { child: includeWorkflow(child) },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [
        { from: "start", to: "child" },
        { from: "child.ready", to: "finish" },
      ],
    });

    expect(() => compileWorkflowDefinition(parent)).toThrow(/terminal nodes without named exits/);
  });

  it("rejects recursive direct includes", () => {
    const a: WorkflowDefinition = defineWorkflow({
      name: "a",
      startAt: "start",
      exits: { ready: { from: "finish" } },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [{ from: "start", to: "finish" }],
    });
    const b: WorkflowDefinition = defineWorkflow({
      name: "b",
      startAt: "start",
      exits: { ready: { from: "finish" } },
      nodes: {
        start: compute({ run: () => ({}) }),
        finish: compute({ run: () => ({}) }),
      },
      edges: [{ from: "start", to: "finish" }],
    });
    a.includes = { b: includeWorkflow(b) };
    a.edges = [
      { from: "start", to: "b" },
      { from: "b.ready", to: "finish" },
    ];
    b.includes = { a: includeWorkflow(a) };
    b.edges = [
      { from: "start", to: "a" },
      { from: "a.ready", to: "finish" },
    ];

    expect(() => compileWorkflowDefinition(a)).toThrow(/cycle/i);
  });

  it("checks direct child input and exit types at compile time", () => {
    const child = childWorkflow();
    const included = includeWorkflow(child, { input: () => ({ task: "valid" }) });
    includeWorkflow(child, {
      // @ts-expect-error task must be a string
      input: () => ({ task: 42 }),
    });
    defineWorkflow({
      name: "typed-parent",
      startAt: "start",
      includes: { child: included },
      nodes: { start: compute({ run: () => ({}) }) },
      edges: [
        { from: "start", to: "child" },
        // @ts-expect-error missing is not a declared child exit
        { from: "child.missing", to: "start" },
      ],
    });
  });
});
