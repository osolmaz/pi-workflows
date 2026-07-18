import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConversationStepExecutor, type PromptDelivery } from "../src/extension/executor.js";
import { sanitizeText } from "../src/viewer/ansi.js";
import { renderRunDetailLines } from "../src/viewer/render.js";
import { agent, compute, defineWorkflow, shell } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { validateWorkflowDefinition } from "../src/workflows/graph.js";
import { extractJsonValue } from "../src/workflows/json.js";
import { runShellAction } from "../src/workflows/shell.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import type { AgentStepRequest } from "../src/workflows/types.js";
import { ScriptedExecutor, makeTempDir } from "./helpers.js";

async function makeEngine(options: { executor?: ScriptedExecutor } = {}) {
  const outputRoot = await makeTempDir("pi-workflows-fixes");
  return new WorkflowEngine({ executor: options.executor ?? new ScriptedExecutor(), outputRoot });
}

describe("timeouts and cancellation for local nodes", () => {
  it("times out a compute node that never settles", async () => {
    const workflow = defineWorkflow({
      name: "hung-compute",
      startAt: "spin",
      nodes: { spin: compute({ timeoutMs: 100, run: () => new Promise(() => {}) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");
    expect(state.results.spin?.outcome).toBe("timed_out");
  });

  it("cancels a compute node that never settles", async () => {
    const workflow = defineWorkflow({
      name: "cancel-compute",
      startAt: "spin",
      nodes: { spin: compute({ run: () => new Promise(() => {}) }) },
      edges: [],
    });
    const engine = await makeEngine();
    const runPromise = engine.run(workflow, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    engine.cancel();
    const { state } = await runPromise;
    expect(state.status).toBe("cancelled");
  });

  it("exposes an abort signal that fires when the node times out", async () => {
    let sawAbort = false;
    const workflow = defineWorkflow({
      name: "cooperative",
      startAt: "spin",
      nodes: {
        spin: compute({
          timeoutMs: 100,
          run: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                sawAbort = true;
                reject(signal.reason);
              });
            }),
        }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");
    expect(sawAbort).toBe(true);
  });

  it("kills a shell action without its own timeout when the node times out", async () => {
    const workflow = defineWorkflow({
      name: "hung-shell",
      startAt: "sleepy",
      nodes: {
        sleepy: shell({ timeoutMs: 150, exec: () => ({ command: "sleep", args: ["10"] }) }),
      },
      edges: [],
    });
    const started = Date.now();
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("abort-like errors from callbacks", () => {
  it("marks the run cancelled when a node throws an AbortError", async () => {
    const workflow = defineWorkflow({
      name: "abortish",
      startAt: "boom",
      nodes: {
        boom: compute({
          run: () => {
            const error = new Error("aborted externally");
            error.name = "AbortError";
            throw error;
          },
        }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.results.boom?.outcome).toBe("cancelled");
    expect(state.status).toBe("cancelled");
  });
});

describe("unserializable node outputs", () => {
  it("fails the node instead of corrupting the persisted state", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const workflow = defineWorkflow({
      name: "cyclic-output",
      startAt: "bad",
      nodes: { bad: compute({ run: () => cyclic }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/non-JSON-serializable/);
    expect(() => JSON.stringify(state)).not.toThrow();
  });

  it("rejects values that stringify but do not round-trip", async () => {
    for (const value of [Number.NaN, () => 1, { when: new Date() }, { drop: undefined, keep: 1 }]) {
      const workflow = defineWorkflow({
        name: "lossy-output",
        startAt: "bad",
        nodes: { bad: compute({ run: () => value }) },
        edges: [],
      });
      const { state } = await (await makeEngine()).run(workflow, {});
      expect(state.status).toBe("failed");
      expect(state.error).toMatch(/round-trip|non-JSON/);
    }
  });

  it("accepts plain JSON values", async () => {
    const workflow = defineWorkflow({
      name: "clean-output",
      startAt: "good",
      nodes: { good: compute({ run: () => ({ list: [1, "two", null, { nested: true }] }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("completed");
  });

  it("normalizes an undefined output to null", async () => {
    const workflow = defineWorkflow({
      name: "void-output",
      startAt: "quiet",
      nodes: { quiet: compute({ run: () => undefined }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("completed");
    expect(state.outputs.quiet).toBeNull();
    expect(JSON.parse(JSON.stringify(state)).outputs).toHaveProperty("quiet");
  });
});

describe("shell output capture", () => {
  it("waits for stdio to close so backgrounded writers are captured", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", "(sleep 0.1; printf late) & printf early"],
    });
    expect(result.stdout).toBe("earlylate");
  });

  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    await expect(
      runShellAction({
        command: "sh",
        args: ["-c", "(sleep 5; printf late) & sleep 5"],
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/Timed out/);
    // With only the direct child killed, the backgrounded descendant would
    // hold the stdio pipes open for the full 5 seconds.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("stale outputs on repeated attempts", () => {
  it("removes a previous success from outputs when the retry fails", async () => {
    let calls = 0;
    const workflow = defineWorkflow({
      name: "flaky-loop",
      startAt: "work",
      nodes: {
        work: compute({
          run: () => {
            calls += 1;
            if (calls > 1) {
              throw new Error("second attempt failed");
            }
            return { attempt: calls };
          },
        }),
        again: compute({ run: () => "loop" }),
        recover: compute({ run: ({ outputs }) => ({ sawStaleOutput: "work" in outputs }) }),
      },
      edges: [
        {
          from: "work",
          switch: { on: "$result.outcome", cases: { ok: "again", failed: "recover" } },
        },
        { from: "again", to: "work" },
      ],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("completed");
    expect(state.finalOutput).toEqual({ sawStaleOutput: false });
    expect(state.outputs).not.toHaveProperty("work");
  });
});

describe("run input validation", () => {
  it("rejects non-round-tripping input before any bundle is written", async () => {
    const engine = await makeEngine();
    const workflow = defineWorkflow({
      name: "input-check",
      startAt: "noop",
      nodes: { noop: compute({ run: () => 1 }) },
      edges: [],
    });
    await expect(engine.run(workflow, { when: new Date() })).rejects.toThrow(/round-trip/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(engine.run(workflow, cyclic)).rejects.toThrow(/non-JSON-serializable/);
  });

  it("normalizes undefined input to null", async () => {
    const workflow = defineWorkflow({
      name: "input-null",
      startAt: "echo",
      nodes: { echo: compute({ run: ({ input }) => ({ input }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, undefined);
    expect(state.status).toBe("completed");
    expect(state.input).toBeNull();
  });
});

describe("unreachable nodes", () => {
  it("rejects a workflow with a node no path can reach", async () => {
    const workflow = defineWorkflow({
      name: "island",
      startAt: "a",
      nodes: { a: compute({ run: () => 1 }), b: compute({ run: () => 2 }) },
      edges: [],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/unreachable nodes: b/);
  });
});

describe("reserved node ids", () => {
  it("rejects node ids that shadow Object prototype members", () => {
    for (const nodeId of ["__proto__", "constructor", "toString"]) {
      expect(() =>
        defineWorkflow({
          name: "reserved",
          startAt: nodeId,
          nodes: { [nodeId]: compute({ run: () => 1 }) },
          edges: [],
        }),
      ).toThrow(/shadows an Object prototype member|must match/);
    }
  });
});

describe("prototype-polluting node ids", () => {
  it("rejects a start node that only exists on Object.prototype", () => {
    const workflow = defineWorkflow({
      name: "proto-start",
      startAt: "toString",
      nodes: { real: compute({ run: () => 1 }) },
      edges: [],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/start node is missing: toString/);
  });

  it("rejects an edge target that only exists on Object.prototype", () => {
    const workflow = defineWorkflow({
      name: "proto-edge",
      startAt: "real",
      nodes: { real: compute({ run: () => 1 }) },
      edges: [{ from: "real", to: "hasOwnProperty" }],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(/unknown to-node: hasOwnProperty/);
  });
});

describe("non-finite timeouts", () => {
  it("rejects NaN and Infinity timeouts at definition time", () => {
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        defineWorkflow({
          name: "bad-timeout",
          startAt: "spin",
          nodes: { spin: compute({ timeoutMs, run: () => 1 }) },
          edges: [],
        }),
      ).toThrow(/finite positive number/);
    }
  });
});

describe("prompt delivery failures", () => {
  it("clears the pending step so a recovery step can run", async () => {
    let failFirst = true;
    const executor = new ConversationStepExecutor({
      sendPrompt: () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("delivery failed");
        }
      },
    });
    const request = (nodeId: string): AgentStepRequest => ({
      contract: { runId: "r", workflowName: "w", nodeId, attemptId: nodeId },
      prompt: nodeId,
      accept: async (output) => ({ ok: true, value: output }),
    });
    await expect(executor.runAgentStep(request("a"), new AbortController().signal)).rejects.toThrow(
      /delivery failed/,
    );
    expect(executor.pendingStepId).toBeNull();
    const second = executor.runAgentStep(request("b"), new AbortController().signal);
    await expect(executor.submit("b", "b", { done: true })).resolves.toMatchObject({
      accepted: true,
    });
    await expect(second).resolves.toEqual({ output: { done: true } });
  });
});

describe("hung validation after the step is cleared", () => {
  it("unblocks the submit call when the step times out mid-validation", async () => {
    const executor = new ConversationStepExecutor({ sendPrompt: () => {} });
    const request: AgentStepRequest = {
      contract: { runId: "r", workflowName: "w", nodeId: "step", attemptId: "a1" },
      prompt: "step",
      accept: () => new Promise(() => {}), // validation never settles
    };
    const abort = new AbortController();
    const stepPromise = executor.runAgentStep(request, abort.signal);
    const submission = executor.submit("step", "a1", {});

    abort.abort(new Error("timed out"));
    await expect(stepPromise).rejects.toThrow(/timed out/);

    // Without the cleared-race, this await would hang forever and block pi's
    // tool execution.
    const result = await submission;
    expect(result.accepted).toBe(false);
    expect(result.message).toMatch(/no longer awaiting/);
  });
});

describe("checkpoint edges", () => {
  it("rejects outgoing edges from checkpoint nodes", async () => {
    const { checkpoint } = await import("../src/workflows/definition.js");
    const workflow = defineWorkflow({
      name: "checkpoint-edge",
      startAt: "pause",
      nodes: { pause: checkpoint({}), after: compute({ run: () => 1 }) },
      edges: [{ from: "pause", to: "after" }],
    });
    expect(() => validateWorkflowDefinition(workflow)).toThrow(
      /checkpoint node must not declare an outgoing edge/,
    );
  });
});

describe("late prompt continuations", () => {
  it("does not persist agent_prompt_sent after the node timed out", async () => {
    let resolvePrompt: ((value: string) => void) | undefined;
    const workflow = defineWorkflow({
      name: "slow-prompt",
      startAt: "ask",
      nodes: {
        ask: agent({
          timeoutMs: 100,
          prompt: () =>
            new Promise<string>((resolve) => {
              resolvePrompt = resolve;
            }),
        }),
      },
      edges: [],
    });
    const { state, runDir } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");

    // The stale continuation resolves after the run is terminal.
    resolvePrompt?.("late prompt");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const trace = await fs.readFile(`${runDir}/trace.ndjson`, "utf8");
    const types = trace
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).not.toContain("agent_prompt_sent");
    expect(types.at(-1)).toBe("run_timed_out");
  });
});

describe("stale submissions after a step is replaced", () => {
  it("does not clear a newer pending step", async () => {
    const sent: PromptDelivery[] = [];
    const executor = new ConversationStepExecutor({ sendPrompt: (d) => sent.push(d) });

    let releaseAccept: (() => void) | undefined;
    const slowRequest: AgentStepRequest = {
      contract: { runId: "r", workflowName: "w", nodeId: "first", attemptId: "a1" },
      prompt: "first",
      accept: () =>
        new Promise((resolve) => {
          releaseAccept = () => resolve({ ok: true, value: { late: true } });
        }),
    };

    const firstAbort = new AbortController();
    const firstStep = executor.runAgentStep(slowRequest, firstAbort.signal);
    const staleSubmission = executor.submit("first", "a1", {});

    // The step times out while validation is still pending, and the engine
    // moves on to a new step.
    firstAbort.abort(new Error("timed out"));
    await expect(firstStep).rejects.toThrow(/timed out/);

    const secondRequest: AgentStepRequest = {
      contract: { runId: "r", workflowName: "w", nodeId: "first", attemptId: "a2" },
      prompt: "retry",
      accept: async (output) => ({ ok: true, value: output }),
    };
    const secondStep = executor.runAgentStep(secondRequest, new AbortController().signal);

    releaseAccept?.();
    const stale = await staleSubmission;
    expect(stale.accepted).toBe(false);
    expect(stale.message).toMatch(/no longer awaiting/);

    // The newer step is still submittable.
    const fresh = await executor.submit("first", "a2", { ok: 1 });
    expect(fresh.accepted).toBe(true);
    await expect(secondStep).resolves.toEqual({ output: { ok: 1 } });
  });
});

describe("switch path validation", () => {
  it("rejects unsupported switch paths at definition time", () => {
    expect(() =>
      defineWorkflow({
        name: "bad-path",
        startAt: "a",
        nodes: { a: compute({ run: () => 1 }), b: compute({ run: () => 2 }) },
        edges: [{ from: "a", switch: { on: "route", cases: { x: "b" } } }],
      }),
    ).toThrow(/switch\.on must start with/);
  });
});

describe("hung title resolution", () => {
  it("can be cancelled before any node runs", async () => {
    const workflow = defineWorkflow({
      name: "hung-title",
      title: () => new Promise<string>(() => {}),
      startAt: "noop",
      nodes: { noop: compute({ run: () => 1 }) },
      edges: [],
    });
    const engine = await makeEngine();
    const runPromise = engine.run(workflow, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    engine.cancel();
    await expect(runPromise).rejects.toThrow(/cancelled/i);
  });
});

describe("validator results that are not JSON", () => {
  it("returns a retryable validation error instead of accepting", async () => {
    const attempts: unknown[] = [];
    const workflow = defineWorkflow({
      name: "bad-validator",
      startAt: "step",
      nodes: {
        step: agent({
          prompt: () => "?",
          validate: (output) =>
            (output as { fix?: boolean }).fix ? { fixed: true } : { when: new Date() },
        }),
      },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("step", async (request) => {
      const first = await request.accept({ fix: false });
      attempts.push(first);
      const second = await request.accept({ fix: true });
      if (!second.ok) {
        throw new Error("expected the corrected output to be accepted");
      }
      return { output: second.value };
    });
    const { state } = await (await makeEngine({ executor })).run(workflow, {});
    expect(state.status).toBe("completed");
    expect(attempts[0]).toMatchObject({ ok: false });
    expect((attempts[0] as { error: string }).error).toMatch(/round-trip/);
  });
});

describe("failure metadata retention", () => {
  it("keeps the shell action receipt when the command fails", async () => {
    const workflow = defineWorkflow({
      name: "failing-shell",
      startAt: "boom",
      nodes: { boom: shell({ exec: () => ({ command: "sh", args: ["-c", "exit 7"] }) }) },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("failed");
    const step = state.steps.at(-1);
    expect(step?.action).toMatchObject({ actionType: "shell", exitCode: 7 });
    expect(step).toHaveProperty("output", null);
  });

  it("keeps the agent prompt when the step fails after delivery", async () => {
    const workflow = defineWorkflow({
      name: "failing-agent",
      startAt: "ask",
      nodes: { ask: agent({ prompt: () => "Please answer" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("ask", { error: "executor gave up" });
    const { state } = await (await makeEngine({ executor })).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.steps.at(-1)?.promptText).toContain("Please answer");
  });
});

describe("shell robustness", () => {
  it("survives a child that exits without consuming stdin", async () => {
    // 1 MiB of stdin against a child that closes stdin immediately (EPIPE).
    const result = await runShellAction({
      command: "sh",
      args: ["-c", "exec 0<&-; printf ok"],
      stdin: "x".repeat(1_048_576),
      allowNonZeroExit: true,
    });
    expect(result.stdout).toBe("ok");
  });

  it("refuses to spawn when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const marker = `${Date.now()}-no-spawn`;
    await expect(
      runShellAction({ command: "sh", args: ["-c", `touch /tmp/${marker}`] }, abort.signal),
    ).rejects.toThrow(/cancelled/i);
    await expect(fs.access(`/tmp/${marker}`)).rejects.toThrow();
  });

  it("keeps the shell receipt when the node-level timeout kills the command", async () => {
    const workflow = defineWorkflow({
      name: "receipt-on-timeout",
      startAt: "sleepy",
      nodes: {
        sleepy: shell({ timeoutMs: 150, exec: () => ({ command: "sleep", args: ["10"] }) }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");
    expect(state.steps.at(-1)?.action).toMatchObject({ actionType: "shell", command: "sleep" });
  });
});

describe("embedded JSON extraction bounds", () => {
  it("stays fast on pathological brace floods", () => {
    const started = Date.now();
    expect(() => extractJsonValue("{".repeat(20_000))).toThrow(/Could not parse/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still finds JSON embedded in chatty text", () => {
    expect(extractJsonValue('Sure! Here you go: {"route":"y"} — done.')).toEqual({ route: "y" });
  });
});

describe("bounded shell output", () => {
  it("truncates output beyond maxOutputChars", async () => {
    const result = await runShellAction({
      command: "sh",
      args: ["-c", "yes x | head -c 100000"],
      maxOutputChars: 1_000,
    });
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stdout).toContain("[output truncated]");
  });
});

describe("terminal output sanitization", () => {
  it("strips ANSI and control characters from untrusted text", () => {
    expect(sanitizeText("\u001b[2Jwiped\u0007bell")).toBe("wipedbell");
    expect(sanitizeText("plain text")).toBe("plain text");
  });

  it("collapses line breaks and tabs so one value stays one line", () => {
    expect(sanitizeText("line1\nline2\r\n\tline3")).toBe("line1 line2 line3");
  });

  it("keeps model-controlled escape sequences out of rendered runs", async () => {
    const workflow = defineWorkflow({
      name: "hostile",
      startAt: "reply",
      nodes: { reply: agent({ prompt: () => "?" }) },
      edges: [],
    });
    const executor = new ScriptedExecutor().respond("reply", {
      output: { text: "\u001b[2J\u001b[H cleared" },
    });
    const engine = await makeEngine({ executor });
    const { state, runDir } = await engine.run(workflow, {});
    const lines = renderRunDetailLines(
      { runDir, manifest: null as never, state, snapshot: createDefinitionSnapshot(workflow) },
      { width: 120, height: 100 },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("cleared");
    expect(joined).not.toContain("\u001b[2J");
  });
});
