import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeTempRoot,
  configureModelBudget,
  isExpectedWorkflowAbort,
  parseArgs,
  RpcSession,
  withTemporaryRoot,
} from "../scripts/live-e2e.mjs";

describe("installed live E2E script", () => {
  it("keeps provider and model as separate exact values", () => {
    expect(parseArgs(["--provider", "openai-codex", "--model", "gpt-5.6-luna"])).toMatchObject({
      model: "gpt-5.6-luna",
      provider: "openai-codex",
      runtimeOnly: false,
    });
    expect(parseArgs([])).toMatchObject({ runtimeOnly: true });
    expect(() => parseArgs(["--provider", "openai"])).toThrow(
      "requires both --provider and --model",
    );
  });

  it("bounds only the exact model in an isolated nonsecret configuration", async () => {
    const options = parseArgs([
      "--provider",
      "openrouter",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--max-output-tokens",
      "4096",
    ]);
    expect(options.maxOutputTokens).toBe(4096);
    for (const tokens of ["0", "-1", "1.5", "no", "9007199254740992"]) {
      expect(() => parseArgs(["--max-output-tokens", tokens])).toThrow("positive safe integer");
    }
    expect(() => parseArgs(["--max-output-tokens", "4096"])).toThrow("isolated generated profile");
    expect(() =>
      parseArgs([
        "--provider",
        "openrouter",
        "--model",
        "deepseek/deepseek-v4-flash",
        "--profile",
        "/existing",
        "--max-output-tokens",
        "4096",
      ]),
    ).toThrow("isolated generated profile");
    await withTemporaryRoot(async (root) => {
      await configureModelBudget(root, options);
      const expected = {
        providers: {
          openrouter: { modelOverrides: { "deepseek/deepseek-v4-flash": { maxTokens: 4096 } } },
        },
      };
      expect(JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"))).toEqual(
        expected,
      );
      expect(await fs.readdir(root)).toEqual(["models.json"]);
      await expect(configureModelBudget(root, options)).rejects.toMatchObject({ code: "EEXIST" });
    });
  });

  it("fails immediately on a provider error rather than waiting for a pending workflow", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new RpcSession(child, { root: "/tmp/pi-workflows-live-e2e-provider-error" });
    try {
      rpc.events.push({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "402: output allowance exceeds credit",
        },
      });
      await expect(rpc.assertHealthy()).rejects.toThrow("402: output allowance exceeds credit");
    } finally {
      await rpc.stop();
    }
  });

  it("matches expected aborts only to the exact saved work attempt and durable timeout", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "This operation was aborted",
        timestamp: 1,
      },
    };
    const input = {
      type: "custom_message",
      customType: "pi-workflows-step",
      details: { contract: { runId: "run", nodeId: "work", attemptId: "attempt" } },
    };
    const response = { type: "message", message: event.message };
    const entries = [input, response];
    const state = {
      runId: "run",
      steps: [{ nodeId: "work", attemptId: "attempt", outcome: "timed_out" }],
    };
    expect(isExpectedWorkflowAbort(event, entries, state, "run")).toBe(true);
    for (const outcome of ["pending", "ok", "failed"]) {
      expect(
        isExpectedWorkflowAbort(
          event,
          entries,
          { ...state, steps: [{ ...state.steps[0], outcome }] },
          "run",
        ),
      ).toBe(false);
    }
    expect(isExpectedWorkflowAbort(event, entries, state, "other-run")).toBe(false);
    expect(isExpectedWorkflowAbort(event, entries, { ...state, runId: "other-run" }, "run")).toBe(
      false,
    );
    expect(
      isExpectedWorkflowAbort(
        event,
        entries,
        { ...state, steps: [{ ...state.steps[0], attemptId: "other" }] },
        "run",
      ),
    ).toBe(false);
    expect(isExpectedWorkflowAbort(event, [input], state, "run")).toBe(false);
    expect(
      isExpectedWorkflowAbort(
        event,
        [input, { type: "message", message: { role: "user", content: "ordinary chat" } }, response],
        state,
        "run",
      ),
    ).toBe(false);
    expect(
      isExpectedWorkflowAbort(
        event,
        [
          { ...input, details: { contract: { ...input.details.contract, nodeId: "recover" } } },
          response,
        ],
        state,
        "run",
      ),
    ).toBe(false);
    expect(
      isExpectedWorkflowAbort(
        { ...event, message: { ...event.message, errorMessage: "402: no credit" } },
        entries,
        state,
        "run",
      ),
    ).toBe(false);
    expect(isExpectedWorkflowAbort(event, null, state, "run")).toBe(false);
    expect(isExpectedWorkflowAbort(event, entries, null, "run")).toBe(false);
  });

  it("accepts a verified intentional abort without masking a later provider failure", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new RpcSession(child, { root: "/tmp/pi-workflows-live-e2e-expected-abort" });
    const expected = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "This operation was aborted",
      },
    };
    let checks = 0;
    rpc.expectedModelAbort = async (event) => {
      checks++;
      return event === expected;
    };
    try {
      rpc.events.push(expected);
      await rpc.assertHealthy();
      await rpc.assertHealthy();
      expect(checks).toBe(1);
      rpc.events.push({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "402: no credit" },
      });
      await expect(rpc.assertHealthy()).rejects.toThrow("402: no credit");
    } finally {
      await rpc.stop();
    }
  });

  it("refuses cleanup outside one direct guarded temporary root", () => {
    expect(() => assertSafeTempRoot("/", "/tmp")).toThrow("Refusing unsafe");
    expect(() => assertSafeTempRoot(os.homedir(), "/tmp")).toThrow("Refusing unsafe");
    expect(() => assertSafeTempRoot("/tmp/parent/pi-workflows-live-e2e-child", "/tmp")).toThrow(
      "Refusing unsafe",
    );
    expect(assertSafeTempRoot("/tmp/pi-workflows-live-e2e-example", "/tmp")).toBe(
      "/tmp/pi-workflows-live-e2e-example",
    );
  });

  it("reports an unexpected Pi RPC exit immediately", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new RpcSession(child, {
      root: "/tmp/pi-workflows-live-e2e-rpc-exit",
    });
    await once(child, "close");

    await expect(rpc.assertHealthy()).rejects.toThrow("Pi RPC exited with code 7");
  });

  it("cleans the guarded root when the operation fails", async () => {
    let root = "";
    await expect(
      withTemporaryRoot(async (temporaryRoot) => {
        root = temporaryRoot;
        await fs.writeFile(path.join(temporaryRoot, "proof.txt"), "temporary\n");
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
