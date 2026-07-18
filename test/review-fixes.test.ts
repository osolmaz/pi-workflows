import { describe, expect, it } from "vitest";
import { ConversationStepExecutor, type PromptDelivery } from "../src/extension/executor.js";
import { sanitizeText } from "../src/viewer/ansi.js";
import { renderRunDetailLines } from "../src/viewer/render.js";
import { agent, compute, defineWorkflow, shell } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
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
    const staleSubmission = executor.submit("first", {});

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
    const fresh = await executor.submit("first", { ok: 1 });
    expect(fresh.accepted).toBe(true);
    await expect(secondStep).resolves.toEqual({ output: { ok: 1 } });
  });
});

describe("terminal output sanitization", () => {
  it("strips ANSI and control characters from untrusted text", () => {
    expect(sanitizeText("\u001b[2Jwiped\u0007bell")).toBe("wipedbell");
    expect(sanitizeText("plain text")).toBe("plain text");
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
