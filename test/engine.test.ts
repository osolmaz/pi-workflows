import { describe, expect, it } from "vitest";
import { decision, decisionEdge } from "../src/workflows/decision.js";
import {
  agent,
  assistantMessage,
  checkpoint,
  compute,
  defineWorkflow,
  idempotentEffect,
  shell,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore, readWorkflowRun } from "../src/workflows/store.js";
import type { WorkflowTraceEvent } from "../src/workflows/types.js";
import { makeStateDatabasePath, ScriptedExecutor, waitUntil } from "./helpers.js";

async function makeEngine(
  executor: ScriptedExecutor,
  options: { maxSteps?: number; defaultNodeTimeoutMs?: number } = {},
) {
  const databasePath = await makeStateDatabasePath("pi-workflows-engine");
  const events: WorkflowTraceEvent[] = [];
  const engine = new WorkflowEngine({
    executor,
    databasePath,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { engine, databasePath, events };
}

describe("WorkflowEngine", () => {
  it("awaits onRunStarted so session binding precedes node and terminal events", async () => {
    const workflow = defineWorkflow({
      name: "fast",
      startAt: "one",
      nodes: { one: compute({ run: () => 1 }) },
      edges: [],
    });
    const databasePath = await makeStateDatabasePath("pi-workflows-engine");
    const store = new WorkflowRunStore(databasePath);
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      store,
      onRunStarted: async (runId, state) => {
        await store.writeSessionBinding(runId, {
          schema: "pi-workflows.session-binding.v1",
          runId: state.runId,
          piSessionId: "s1",
          cwd: "/tmp",
          boundAt: new Date().toISOString(),
        });
      },
    });

    const { runId, state } = await engine.run(workflow, {});

    const trace = store.readRun(runId, { includeTrace: true })?.traceEvents ?? [];
    expect(trace.map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "session_bound",
      "node_started",
      "node_finished",
      "run_completed",
    ]);
    // The terminal projection reflects the whole trace.
    expect(state.traceSeq).toBe(trace.at(-1)?.seq);
    expect(store.readRun(runId)?.sessionBinding?.piSessionId).toBe("s1");
  });

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
    const { engine, databasePath, events } = await makeEngine(executor);

    const { state, runId } = await engine.run(workflow, { q: "6x7" });

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ final: "42" });
    expect(state.steps.map((step) => step.nodeId)).toEqual(["ask", "summarize"]);
    expect(events.at(-1)?.type).toBe("run_completed");

    const bundle = readWorkflowRun(runId, { databasePath, includeTrace: true });
    expect(bundle?.state.status).toBe("completed");
    expect(bundle?.snapshot.nodes.ask?.nodeType).toBe("agent");

    const lines = bundle?.traceEvents ?? [];
    expect(lines[0]?.type).toBe("run_created");
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_line, index) => index + 1));
  });

  it("pauses at the step boundary and resumes", async () => {
    const engineRef: { engine?: WorkflowEngine } = {};
    const workflow = defineWorkflow({
      name: "pausable",
      startAt: "first",
      nodes: {
        // Pausing from inside the node proves the current step still
        // finishes before the hold takes effect.
        first: compute({
          run: () => {
            engineRef.engine?.pause();
            return 1;
          },
        }),
        second: compute({ run: () => 2 }),
      },
      edges: [{ from: "first", to: "second" }],
    });
    const executor = new ScriptedExecutor();
    const { engine, events } = await makeEngine(executor);
    engineRef.engine = engine;

    const running = engine.run(workflow, {});
    await waitUntil(() => events.some((event) => event.type === "run_paused"));
    // The step that requested the pause completed; the next never started.
    const finishedNodes = events.filter((event) => event.type === "node_finished");
    expect(finishedNodes.map((event) => event.nodeId)).toEqual(["first"]);
    expect(events.filter((event) => event.type === "node_started")).toHaveLength(1);
    expect(engine.pauseRequested).toBe(true);

    engine.resume();
    const { state } = await running;

    expect(state.status).toBe("completed");
    expect(state.paused).toBeUndefined();
    expect(state.steps.map((step) => step.nodeId)).toEqual(["first", "second"]);
    const types = events.map((event) => event.type);
    expect(types.indexOf("run_paused")).toBeLessThan(types.indexOf("run_resumed"));
  });

  it("cancel releases a paused run and marks it cancelled", async () => {
    const engineRef: { engine?: WorkflowEngine } = {};
    const workflow = defineWorkflow({
      name: "pause-cancel",
      startAt: "first",
      nodes: {
        first: compute({
          run: () => {
            engineRef.engine?.pause();
            return 1;
          },
        }),
        second: compute({ run: () => 2 }),
      },
      edges: [{ from: "first", to: "second" }],
    });
    const executor = new ScriptedExecutor();
    const { engine, events } = await makeEngine(executor);
    engineRef.engine = engine;

    const running = engine.run(workflow, {});
    await waitUntil(() => events.some((event) => event.type === "run_paused"));

    engine.cancel();
    const { state } = await running;
    expect(state.status).toBe("cancelled");
    expect(state.paused).toBeUndefined();
    expect(state.steps.map((step) => step.nodeId)).toEqual(["first"]);
  });

  it("appends the step contract to agent prompts", async () => {
    const workflow = defineWorkflow({
      name: "contract",
      title: "Contract run",
      startAt: "ask",
      nodes: {
        ask: agent({
          prompt: () => "Base prompt",
          expectedOutput: `{ "x": 1 }`,
          statusDetail: "Checking the contract",
        }),
      },
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
    expect(prompt).toContain(
      `{"action": "submit", "step": "ask", "attempt": "${attemptId}", "output": <your result>}`,
    );
    expect(prompt).toContain(`Expected output: { "x": 1 }`);
    expect(request?.presentation).toEqual({
      runTitle: "Contract run",
      statusDetail: "Checking the contract",
    });
    expect(prompt).toContain("This workflow scope has no editable settings.");
    expect(prompt).not.toContain("queue-follow-up");
  });

  it("uses exact visible text for assistant-message agent output", async () => {
    const workflow = defineWorkflow({
      name: "assistant-contract",
      startAt: "present",
      nodes: {
        present: agent({
          prompt: () => "Explain it plainly",
          expectedOutput: assistantMessage(),
        }),
      },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("present", (request) => {
      expect(request.contract).toMatchObject({ completion: "assistant" });
      expect(request.contract.maxOutputChars).toBeUndefined();
      expect(request.prompt).toContain("Reply with a normal assistant message.");
      expect(request.prompt).not.toContain('"action": "submit"');
      return {
        output: '{"visible":"text"}',
        assistantMessage: { sha256: "a".repeat(64), entryId: "assistant-1" },
        conversation: { firstEntryId: "prompt-1", lastEntryId: "assistant-1" },
      };
    });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toBe('{"visible":"text"}');
    expect(state.steps[0]).toMatchObject({
      output: '{"visible":"text"}',
      assistantMessage: { entryId: "assistant-1", sha256: "a".repeat(64) },
      conversation: { firstEntryId: "prompt-1", lastEntryId: "assistant-1" },
    });
  });

  it("parks for an origin session and resumes the same assistant attempt", async () => {
    const workflow = defineWorkflow({
      name: "assistant-resume",
      startAt: "present",
      nodes: {
        present: agent({ prompt: () => "Present", expectedOutput: assistantMessage() }),
      },
      edges: [],
    });
    const databasePath = await makeStateDatabasePath("pi-workflows-assistant-resume");
    const parkedExecutor = {
      assistantMessageMode: "park" as const,
      runAgentStep: async () => {
        throw new Error("parked executor must not receive a prompt");
      },
    };
    const parkedEngine = new WorkflowEngine({ executor: parkedExecutor, databasePath });
    const parked = await parkedEngine.run(workflow, {});
    const attemptId = parked.state.currentAttemptId;
    expect(parked.state).toMatchObject({
      status: "running",
      currentNode: "present",
      statusDetail: "waiting for origin Pi session",
    });

    const visibleExecutor = new ScriptedExecutor().respond("present", (request) => {
      expect(request.contract.attemptId).toBe(attemptId);
      return { output: "visible", assistantMessage: { sha256: "b".repeat(64) } };
    });
    const resumedEngine = new WorkflowEngine({ executor: visibleExecutor, databasePath });
    const resumed = await resumedEngine.resumeRun(workflow, parked.state.runId);

    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.finalOutput).toBe("visible");
    expect(resumed.state.steps).toHaveLength(1);
    expect(resumed.state.steps[0]?.attemptId).toBe(attemptId);
  });

  it("fails assistant completion when no visible executor or origin exists", async () => {
    const workflow = defineWorkflow({
      name: "assistant-unsupported",
      startAt: "present",
      nodes: {
        present: agent({ prompt: () => "Present", expectedOutput: assistantMessage() }),
      },
      edges: [],
    });
    const unsupported = {
      runAgentStep: async () => ({ output: "must not run" }),
    };
    const databasePath = await makeStateDatabasePath("pi-workflows-assistant-unsupported");
    const engine = new WorkflowEngine({ executor: unsupported, databasePath });

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/requires an origin Pi session/);
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
      },
      edges: [],
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
          effect: idempotentEffect("test.shell-receipt"),
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

  it("resolves a node timeout from run context", async () => {
    const workflow = defineWorkflow({
      name: "derived-timeout",
      startAt: "ask",
      nodes: {
        ask: agent({
          prompt: () => "?",
          timeoutMs: ({ input }) => (input as { timeoutMs: number }).timeoutMs,
        }),
      },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { hang: true });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, { timeoutMs: 25 });

    expect(state.status).toBe("timed_out");
    expect(state.results.ask?.durationMs).toBeGreaterThanOrEqual(20);
  });

  it("allows a fixed null timeout to outlive the engine default", async () => {
    const workflow = defineWorkflow({
      name: "no-timeout",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?", timeoutMs: null }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const accepted = await request.accept({ completed: true });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
    const { engine } = await makeEngine(executor, { defaultNodeTimeoutMs: 20 });

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ completed: true });
  });

  it("allows a derived null timeout and keeps cancellation active", async () => {
    const workflow = defineWorkflow({
      name: "derived-no-timeout",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?", timeoutMs: () => null }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { hang: true });
    const { engine } = await makeEngine(executor, { defaultNodeTimeoutMs: 20 });

    const runPromise = engine.run(workflow, {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    engine.cancel();
    const { state } = await runPromise;

    expect(state.status).toBe("cancelled");
    expect(state.results.ask?.outcome).toBe("cancelled");
  });

  it("fails before dispatch when a derived timeout is invalid", async () => {
    const workflow = defineWorkflow({
      name: "bad-derived-timeout",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "?", timeoutMs: () => 0 }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { output: {} });
    const { engine } = await makeEngine(executor);

    const { state } = await engine.run(workflow, {});

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/timeoutMs must resolve to a finite positive number/);
    expect(executor.requests).toHaveLength(0);
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
