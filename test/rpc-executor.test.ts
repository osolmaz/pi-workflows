import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostProcessRegistry } from "../src/host/processes.js";
import { RpcStepExecutor } from "../src/host/rpc-executor.js";
import { makeTempDir, waitUntil } from "./helpers.js";

describe("RpcStepExecutor spawn", () => {
  it("spawns children with extension isolation", async () => {
    const dir = await makeTempDir("pi-rpc-args");
    const argsFile = path.join(dir, "argv.txt");
    const fakePi = path.join(dir, "fake-pi.sh");
    await fs.writeFile(
      fakePi,
      `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
sleep 60
`,
      { encoding: "utf8", mode: 0o755 },
    );
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({ cwd: dir, registry, piBin: fakePi });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;

    const args = await fs.readFile(argsFile, "utf8");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("rpc-bridge");
    // The bridge is the only extension the child loads.
    const noExtensionsIndex = args.indexOf("--no-extensions");
    const bridgeIndex = args.indexOf("-e\n");
    expect(noExtensionsIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeGreaterThan(noExtensionsIndex);
  });

  it("fails the step instead of crashing when pi is missing", async () => {
    const dir = await makeTempDir("pi-rpc-missing");
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({
      cwd: dir,
      registry,
      piBin: path.join(dir, "definitely-not-a-real-pi-binary"),
    });
    const abort = new AbortController();
    const result = await executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
    expect(result).not.toBe("resolved");
    await executor.close();
  });
});

describe("RpcStepExecutor.close", () => {
  it("kills the whole process group, including grandchildren", async () => {
    const dir = await makeTempDir("pi-rpc-close");
    // A fake pi that leaves a grandchild behind: the parent sleeps while a
    // child sleeps in the same group.
    const fakePi = path.join(dir, "fake-pi.sh");
    await fs.writeFile(fakePi, "#!/bin/sh\nsleep 60 &\nexec sleep 60\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const registry = new HostProcessRegistry(dir);
    const executor = new RpcStepExecutor({ cwd: dir, registry, piBin: fakePi });
    const abort = new AbortController();
    const stepPromise = executor
      .runAgentStep(
        {
          contract: { runId: "r", workflowName: "w", nodeId: "n", attemptId: "a" },
          prompt: "hi",
          accept: async () => ({ ok: true as const, value: null }),
        },
        abort.signal,
      )
      .catch((error: unknown) => error);
    // Give the child a moment to spawn, then close and abort the step.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = (executor as unknown as { child: { pid?: number } | null }).child?.pid;
    expect(pid).toBeDefined();
    await executor.close();
    abort.abort(new Error("done"));
    await stepPromise;
    // The entire group is gone: a group probe fails, and the registry is empty.
    await waitUntil(() => {
      try {
        process.kill(-(pid as number), 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(-(pid as number), 0)).toThrow();
    expect(registry.size).toBe(0);
  });
});
