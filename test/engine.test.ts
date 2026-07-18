import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decision, decisionEdge } from "../src/workflows/decision.js";
import { agent, checkpoint, compute, defineWorkflow, shell } from "../src/workflows/definition.js";
import { WorkflowEngine, appendStepContract } from "../src/workflows/engine.js";
import { readRunBundle } from "../src/workflows/store.js";
import type { WorkflowTraceEvent } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function makeEngine(
  executor: ScriptedExecutor,
  options: { maxSteps?: number; defaultNodeTimeoutMs?: number } = {},
) {
  const outputRoot = await makeTempDir("pi-workflows-engine");
  const events: WorkflowTraceEvent[] = [];
  const engine = new WorkflowEngine({
    executor,
    outputRoot,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { engine, outputRoot, events };
}

describe("WorkflowEngine", () => {
  it("runs a linear agent + compute workflow to completion", async () => {
    const workflow = defineWorkflow({
      name: "linear",
      startAt: "ask",
      nodes: {
        ask: agent({ prompt: () => "Question?", expectedOutput: `{ "answer": "text" }` }),
        summarize: compute({
          run: ({ outputs }) => ({ final: (outputs.ask as { answer: string }).answer }),
        }),
      },
      edges: [{ from: "ask", to: "summarize" }],
    });
    const executor = new ScriptedExecutor().respond("ask", { output: { answer: "42" } });
    const { engine, events } = await makeEngine(executor);

    const { state, runDir } = await engine.run(workflow, { q: "6x7" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ final: "42" });
    expect(state.steps.map((step) => step.nodeId)).toEqual(["ask", "summarize"]);
    expect(events.at(-1)?.type).toBe("run_completed");

    const bundle = await readRunBundle(runDir);
    expect(bundle?.state.status).toBe("completed");
    expect(bundle?.manifest.status).toBe("completed");
    expect(bundle?.snapshot?.nodes.ask?.nodeType).toBe("agent");

    const trace = await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8");
    const lines = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkflowTraceEvent);
    expect(lines[0]?.type).toBe("run_started");
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_line, index) => index + 1));
  });

  it("appends the step contract to agent prompts", async () => {
    const workflow = defineWorkflow({
      name: "contract",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "Base prompt", expectedOutput: `{ "x": 1 }` }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { output: { x: 1 } });
    const { engine } = await makeEngine(executor);

    await engine.run(workflow, {});

    const request = executor.requests[0];
    const prompt = request?.prompt ?? "";
    const attemptId = request?.contract.attemptId ?? "";
    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("Workflow step contract");
    expect(prompt).toContain(`{"step": "ask", "attempt": "${attemptId}", "output": <your result>}`);
    expect(prompt).toContain(`Expected output: { "x": 1 }`);
    expect(prompt).toBe(
      appendStepContract("Base prompt", "contract", "ask", attemptId, `{ "x": 1 }`),
    );
  });

  it("routes decisions through switch edges", async () => {
    const choices = ["y", "n"] as const;
    const workflow = defineWorkflow({
      name: "routed",
      startAt: "pick",
      nodes: {
        pick: decision({ choices, question: "Same?" }),
        yes_lane: compute({ run: () => "yes" }),
        no_lane: compute({ run: () => "no" }),
      },
      edges: [decisionEdge({ from: "pick", choices, cases: { y: "yes_lane", n: "no_lane" } })],
    });
    const executor = new ScriptedExecutor().respond("pick", {
      output: { route: "n", reason: "differs" },
    });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toEqual(["pick", "no_lane"]);
    expect(state.finalOutput).toBe("no");
  });

  it("pauses at checkpoints with waiting status", async () => {
    const workflow = defineWorkflow({
      name: "paused",
      startAt: "hold",
      nodes: {
        hold: checkpoint({ summary: "needs review" }),
        after: compute({ run: () => "never" }),
      },
      edges: [{ from: "hold", to: "after" }],
    });
    const { engine } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toBe("hold");
    expect(state.finalOutput).toEqual({ summary: "needs review" });
    expect(state.steps.map((step) => step.nodeId)).toEqual(["hold"]);
  });

  it("runs shell actions and records receipts", async () => {
    const workflow = defineWorkflow({
      name: "shelly",
      startAt: "echo",
      nodes: {
        echo: shell({
          exec: () => ({ command: "printf", args: ["%s", "hi"] }),
          parse: (result) => ({ stdout: result.stdout }),
        }),
      },
      edges: [],
    });
    const { engine } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ stdout: "hi" });
    expect(state.steps[0]?.action).toMatchObject({
      actionType: "shell",
      command: "printf",
      exitCode: 0,
    });
  });

  it("fails the run when a node fails without outcome routing", async () => {
    const workflow = defineWorkflow({
      name: "broken",
      startAt: "boom",
      nodes: { boom: compute({ run: () => Promise.reject(new Error("kaput")) }) },
      edges: [],
    });
    const { engine, events } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("failed");
    expect(state.error).toBe("kaput");
    expect(state.results.boom?.outcome).toBe("failed");
    expect(events.at(-1)?.type).toBe("run_failed");
  });

  it("routes failures through $result.outcome switch edges", async () => {
    const workflow = defineWorkflow({
      name: "recovering",
      startAt: "boom",
      nodes: {
        boom: compute({ run: () => Promise.reject(new Error("kaput")) }),
        recover: compute({ run: () => "recovered" }),
      },
      edges: [{ from: "boom", switch: { on: "$result.outcome", cases: { failed: "recover" } } }],
    });
    const { engine } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toBe("recovered");
  });

  it("times out hung agent steps", async () => {
    const workflow = defineWorkflow({
      name: "hung",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?", timeoutMs: 50 }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { hang: true });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("timed_out");
    expect(state.results.ask?.outcome).toBe("timed_out");
  });

  it("supports cancel() while an agent step is pending", async () => {
    const workflow = defineWorkflow({
      name: "cancellable",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { hang: true });
    const { engine } = await makeEngine(executor);

    const runPromise = engine.run(workflow, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.cancel();
    const { state } = await runPromise;

    expect(state.status).toBe("cancelled");
    expect(state.results.ask?.outcome).toBe("cancelled");
  });

  it("supports validation retry loops within one step", async () => {
    const workflow = defineWorkflow({
      name: "validating",
      startAt: "pick",
      nodes: { pick: decision({ choices: ["a", "b"] as const, question: "?" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("pick", async (request) => {
      const first = await request.accept({ route: "zzz" });
      expect(first.ok).toBe(false);
      const second = await request.accept({ route: "b" });
      if (!second.ok) {
        throw new Error("expected acceptance");
      }
      return { output: second.value };
    });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.outputs.pick).toEqual({ route: "b" });
  });

  it("normalizes string outputs containing JSON", async () => {
    const workflow = defineWorkflow({
      name: "stringy",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { output: `{"answer":"parsed"}` });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.outputs.ask).toEqual({ answer: "parsed" });
  });

  it("keeps plain-string outputs that are not JSON", async () => {
    const workflow = defineWorkflow({
      name: "plain",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { output: "just text" });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.outputs.ask).toBe("just text");
  });

  it("enforces maxSteps against loops", async () => {
    const workflow = defineWorkflow({
      name: "looping",
      maxSteps: 5,
      startAt: "spin",
      nodes: { spin: compute({ run: () => ({ next: "spin" }) }) },
      edges: [{ from: "spin", to: "spin" }],
    });
    const { engine } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/maxSteps=5/);
  });

  it("loops through fix cycles like autoimplement", async () => {
    const choices = ["clean", "issues_found"] as const;
    const workflow = defineWorkflow({
      name: "fixloop",
      startAt: "verify",
      nodes: {
        verify: agent({ prompt: () => "verify" }),
        review: decision({ choices, question: "clean?" }),
        fix: agent({ prompt: () => "fix" }),
        done: compute({ run: () => "done" }),
      },
      edges: [
        { from: "verify", to: "review" },
        decisionEdge({ from: "review", choices, cases: { clean: "done", issues_found: "fix" } }),
        { from: "fix", to: "verify" },
      ],
    });
    const executor = new ScriptedExecutor()
      .respond("verify", { output: { passed: true } })
      .respond(
        "review",
        { output: { route: "issues_found", reason: "bug" } },
        { output: { route: "clean", reason: "ok" } },
      )
      .respond("fix", { output: { fixed: "bug" } });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => step.nodeId)).toEqual([
      "verify",
      "review",
      "fix",
      "verify",
      "review",
      "done",
    ]);
  });

  it("resolves run titles from functions", async () => {
    const workflow = defineWorkflow({
      name: "titled",
      title: ({ input }) => `run for ${(input as { task: string }).task}`,
      startAt: "noop",
      nodes: { noop: compute({ run: () => null }) },
      edges: [],
    });
    const { engine } = await makeEngine(new ScriptedExecutor());

    const { state } = await engine.run(workflow, { task: "X" });

    expect(state.runTitle).toBe("run for X");
  });
});
