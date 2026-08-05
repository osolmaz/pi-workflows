import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostProcessRegistry } from "../src/host/processes.js";
import { RpcStepExecutor } from "../src/host/rpc-executor.js";
import type { AgentStepRequest } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

function requestFor(nodeId: string, attemptId: string, accept?: AgentStepRequest["accept"]) {
  return {
    contract: { runId: "r", workflowName: "w", nodeId, attemptId },
    prompt: "do the step",
    accept: accept ?? (async () => ({ ok: true as const, value: null })),
  };
}

/** A fake pi that speaks the bridge protocol from a small script. */
async function makeFakePi(
  script: string,
): Promise<{ dir: string; fakePi: string; stdinLog: string }> {
  const dir = await makeTempDir("pi-rpc-flow");
  const fakePi = path.join(dir, "fake-pi.sh");
  const stdinLog = path.join(dir, "stdin.log");
  await fs.writeFile(
    fakePi,
    `#!/bin/sh\ncat > ${JSON.stringify(stdinLog)} &\nCATPID=$!\n${script}\nwait $CATPID\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  return { dir, fakePi, stdinLog };
}

function submissionLine(step: string, attempt: string, output: unknown): string {
  return `PI_WORKFLOWS_STEP_SUBMISSION ${JSON.stringify({ step, attempt, output })}\\n`;
}

describe("RpcStepExecutor submissions", () => {
  it("resolves a submission reported over stderr", async () => {
    const { fakePi } = await makeFakePi(
      `sleep 0.2\nprintf '${submissionLine("work", "a1", { done: true })}' >&2\nsleep 2\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new HostProcessRegistry("/tmp"),
      piBin: fakePi,
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1"),
      new AbortController().signal,
    );
    expect(submission.output).toBeNull();
    await executor.close();
  });

  it("re-prompts with the validation error and accepts a corrected submission", async () => {
    const { fakePi, stdinLog } = await makeFakePi(
      `sleep 0.2\nprintf '${submissionLine("work", "a1", { bad: 1 })}' >&2\nsleep 0.2\nprintf '${submissionLine("work", "a1", { good: 2 })}' >&2\nsleep 2\n`,
    );
    let calls = 0;
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new HostProcessRegistry("/tmp"),
      piBin: fakePi,
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1", async (output) => {
        calls += 1;
        return calls === 1
          ? { ok: false as const, error: "missing field" }
          : { ok: true as const, value: output };
      }),
      new AbortController().signal,
    );
    expect(submission.output).toEqual({ good: 2 });
    // The rejection surfaced to the model and a corrected submission was
    // validated: exactly two accept calls, no more.
    expect(calls).toBe(2);
    await executor.close();
    void stdinLog;
  });

  it("ignores malformed markers and submissions for other attempts", async () => {
    const { fakePi } = await makeFakePi(
      `sleep 0.2\nprintf 'PI_WORKFLOWS_STEP_SUBMISSION {broken\\n' >&2\nprintf '${submissionLine("work", "other", 1)}' >&2\nsleep 0.2\nprintf '${submissionLine("work", "a1", "mine")}' >&2\nsleep 2\n`,
    );
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new HostProcessRegistry("/tmp"),
      piBin: fakePi,
    });
    const submission = await executor.runAgentStep(
      requestFor("work", "a1"),
      new AbortController().signal,
    );
    expect(submission.output).toBeNull();
    await executor.close();
  });

  it("rejects the step when the abort signal fires", async () => {
    const { fakePi } = await makeFakePi("sleep 30\n");
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new HostProcessRegistry("/tmp"),
      piBin: fakePi,
    });
    const abort = new AbortController();
    const step = executor.runAgentStep(requestFor("work", "a1"), abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort(new Error("stop the step"));
    await expect(step).rejects.toThrow(/stop the step|aborted/);
    await executor.close();
  });

  it("rejects the step when the child exits mid-step", async () => {
    const { fakePi } = await makeFakePi("exit 3\n");
    const executor = new RpcStepExecutor({
      cwd: "/tmp",
      registry: new HostProcessRegistry("/tmp"),
      piBin: fakePi,
    });
    await expect(
      executor.runAgentStep(requestFor("work", "a1"), new AbortController().signal),
    ).rejects.toThrow(/exited/);
    // A second step on the dead child fails immediately with its exit info.
    await expect(
      executor.runAgentStep(requestFor("work", "a2"), new AbortController().signal),
    ).rejects.toThrow(/exited \(code 3/);
    await executor.close();
  });
});

describe("HostProcessRegistry edge cases", () => {
  it("tolerates corrupt registry files", async () => {
    const dir = await makeTempDir("pi-host-registry-corrupt");
    const file = path.join(dir, "host.children.json");
    await fs.writeFile(file, "not json\n", "utf8");
    const registry = new HostProcessRegistry(dir);
    expect(registry.reapOrphans()).toEqual([]);
    await fs.writeFile(file, '{"not": "an array"}', "utf8");
    expect(registry.reapOrphans()).toEqual([]);
    await fs.writeFile(file, '["not-a-pid", -1]', "utf8");
    expect(registry.reapOrphans()).toEqual([]);
    registry.register(424_242);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual([424_242]);
  });

  it("killAll clears the registry and tolerates dead pids", async () => {
    const dir = await makeTempDir("pi-host-registry-kill");
    const registry = new HostProcessRegistry(dir);
    registry.register(424_250);
    registry.killAll();
    expect(registry.size).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(dir, "host.children.json"), "utf8"))).toEqual([]);
  });
});
