import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/render/ansi.js";
import { renderRunDetailLines } from "../src/viewer/render.js";
import {
  agent,
  compute,
  defineWorkflow,
  idempotentEffect,
  shell,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { validateWorkflowDefinition } from "../src/workflows/graph.js";
import { extractJsonValue } from "../src/workflows/json.js";
import { runShellAction } from "../src/workflows/shell.js";
import { createDefinitionSnapshot } from "../src/workflows/store.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

async function makeEngine(options: { executor?: ScriptedExecutor } = {}) {
  const databasePath = await makeStateDatabasePath("pi-workflows-fixes");
  return new WorkflowEngine({ executor: options.executor ?? new ScriptedExecutor(), databasePath });
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
        sleepy: shell({
          effect: idempotentEffect("test.timeout-shell"),
          timeoutMs: 150,
          exec: () => ({ command: "sleep", args: ["10"] }),
        }),
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

describe("checkpoint edges", () => {
  it("allows outgoing edges from checkpoint nodes for continuation runs", async () => {
    const { checkpoint } = await import("../src/workflows/definition.js");
    const workflow = defineWorkflow({
      name: "checkpoint-edge",
      startAt: "pause",
      nodes: { pause: checkpoint({}), after: compute({ run: () => 1 }) },
      edges: [{ from: "pause", to: "after" }],
    });
    // Continuation runs route after the checkpoint, so the edge is live.
    expect(() => validateWorkflowDefinition(workflow)).not.toThrow();
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
      nodes: {
        boom: shell({
          effect: idempotentEffect("test.failed-shell"),
          exec: () => ({ command: "sh", args: ["-c", "exit 7"] }),
        }),
      },
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
    expect(state.steps.at(-1)?.prompt).toContain("Please answer");
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
        sleepy: shell({
          effect: idempotentEffect("test.receipt-timeout"),
          timeoutMs: 150,
          exec: () => ({ command: "sleep", args: ["10"] }),
        }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("timed_out");
    expect(state.steps.at(-1)?.action).toMatchObject({ actionType: "shell", command: "sleep" });
  });
});

describe("observer isolation", () => {
  it("completes the run even when onEvent throws", async () => {
    const databasePath = await makeStateDatabasePath("pi-workflows-observer");
    const engine = new WorkflowEngine({
      executor: new ScriptedExecutor(),
      databasePath,
      onEvent: () => {
        throw new Error("UI exploded");
      },
    });
    const workflow = defineWorkflow({
      name: "observed",
      startAt: "noop",
      nodes: { noop: compute({ run: () => "done" }) },
      edges: [],
    });
    const { state } = await engine.run(workflow, {});
    expect(state.status).toBe("completed");
  });
});

describe("spawn failure receipts", () => {
  it("records a receipt when the executable does not exist", async () => {
    const workflow = defineWorkflow({
      name: "no-such-binary",
      startAt: "ghost",
      nodes: {
        ghost: shell({
          effect: idempotentEffect("test.spawn-failure"),
          exec: () => ({ command: "definitely-not-a-real-binary-xyz" }),
        }),
      },
      edges: [],
    });
    const { state } = await (await makeEngine()).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.steps.at(-1)?.action).toMatchObject({
      actionType: "shell",
      command: "definitely-not-a-real-binary-xyz",
      exitCode: null,
    });
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
    const { state, runId } = await engine.run(workflow, {});
    const lines = renderRunDetailLines(
      {
        runId,
        state,
        snapshot: createDefinitionSnapshot(workflow),
        sessionBinding: null,
        sessionEntries: [],
        sessionEvents: [],
        sessionCapture: null,
        sessionIntegrity: { status: "unavailable", diagnostics: [] },
        sessionSegments: [],
      },
      { width: 120, height: 100 },
    );
    const joined = lines.join("\n");
    expect(joined).toContain("cleared");
    expect(joined).not.toContain("\u001b[2J");
  });
});
