import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCommandBatch,
  validateCommandBatchRequest,
  type CommandBatchItem,
} from "../src/workflows/command-batch.js";
import { makeTempDir } from "./helpers.js";

function item(
  id: string,
  cwd: string,
  script = "process.stdout.write('ok')",
  timeoutMs = 2_000,
  maxOutputChars = 1_000,
): CommandBatchItem {
  return {
    id,
    command: process.execPath,
    args: ["-e", script],
    cwd,
    timeoutMs,
    maxOutputChars,
  };
}

describe("command batch validation", () => {
  it("normalizes valid requests and accepts an empty batch", async () => {
    expect(validateCommandBatchRequest({ items: [], maxConcurrency: 2 })).toEqual({
      items: [],
      maxConcurrency: 2,
    });
    await expect(runCommandBatch({ items: [], maxConcurrency: 2 })).resolves.toEqual({
      schema: "pi-workflows.command-batch-result.v1",
      items: [],
      completed: 0,
      total: 0,
    });
  });

  it("rejects malformed requests, items, and limits", async () => {
    const cwd = await makeTempDir("command-batch-validation");
    const valid = item("one", cwd);
    for (const request of [null, [], "bad"]) {
      expect(() => validateCommandBatchRequest(request)).toThrow(/must be an object/);
    }
    expect(() =>
      validateCommandBatchRequest({ items: [], maxConcurrency: 1, unknown: true }),
    ).toThrow(/unknown is not supported/);
    expect(() => validateCommandBatchRequest({ items: "bad", maxConcurrency: 1 })).toThrow(
      /must be an array/,
    );
    expect(() =>
      validateCommandBatchRequest({
        items: Array.from({ length: 65 }, () => valid),
        maxConcurrency: 1,
      }),
    ).toThrow(/at most 64/);
    expect(() =>
      validateCommandBatchRequest({ items: [valid, { ...valid }], maxConcurrency: 1 }),
    ).toThrow(/duplicated/);
    expect(() => validateCommandBatchRequest({ items: [null], maxConcurrency: 1 })).toThrow(
      /must be an object/,
    );
    for (const bad of [
      { ...valid, id: "" },
      { ...valid, id: "invalid id" },
      { ...valid, command: "" },
      { ...valid, args: "bad" },
      { ...valid, args: [1] },
      { ...valid, cwd: "" },
      { ...valid, cwd: "relative" },
      { ...valid, timeoutMs: 0 },
      { ...valid, timeoutMs: 3_600_001 },
      { ...valid, maxOutputChars: 0 },
      { ...valid, maxOutputChars: 1_000_001 },
    ]) {
      expect(() => validateCommandBatchRequest({ items: [bad], maxConcurrency: 1 })).toThrow();
    }
    expect(() =>
      validateCommandBatchRequest({
        items: [{ ...valid, shell: true }],
        maxConcurrency: 1,
      }),
    ).toThrow(/shell is not supported/);
    for (const maxConcurrency of [0, 9, 1.5, "1"]) {
      expect(() => validateCommandBatchRequest({ items: [valid], maxConcurrency })).toThrow(
        /maxConcurrency/,
      );
    }
  });
});

describe("runCommandBatch", () => {
  it("returns results in input order while commands finish out of order", async () => {
    const cwd = await makeTempDir("command-batch-order");
    const result = await runCommandBatch({
      items: [
        item("slow", cwd, "setTimeout(() => process.stdout.write('slow'), 120)"),
        item("fast", cwd, "process.stdout.write('fast')"),
      ],
      maxConcurrency: 2,
    });
    expect(result.items.map((entry) => entry.id)).toEqual(["slow", "fast"]);
    expect(result.items.map((entry) => entry.stdout)).toEqual(["slow", "fast"]);
    expect(result.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
  });

  it("enforces the concurrency limit", async () => {
    const cwd = await makeTempDir("command-batch-concurrency");
    const log = path.join(cwd, "events.log");
    const script = (id: string) =>
      [
        "const fs = require('node:fs');",
        `const log = ${JSON.stringify(log)};`,
        `fs.appendFileSync(log, 'start ${id} ' + Date.now() + '\\n');`,
        `setTimeout(() => { fs.appendFileSync(log, 'end ${id} ' + Date.now() + '\\n'); }, 100);`,
      ].join("\n");
    await runCommandBatch({
      items: ["a", "b", "c", "d"].map((id) => item(id, cwd, script(id))),
      maxConcurrency: 2,
    });
    const events = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    let active = 0;
    let maximum = 0;
    for (const [kind] of events) {
      active += kind === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("isolates nonzero exits, spawn failures, and timeouts", async () => {
    const cwd = await makeTempDir("command-batch-failures");
    const result = await runCommandBatch({
      items: [
        item("success", cwd),
        item("exit", cwd, "process.stderr.write('bad'); process.exit(3)"),
        { ...item("spawn", cwd), command: path.join(cwd, "missing") },
        item("timeout", cwd, "setTimeout(() => {}, 1000)", 50),
      ],
      maxConcurrency: 4,
    });
    expect(result.items.map((entry) => entry.outcome)).toEqual([
      "succeeded",
      "failed",
      "failed",
      "timedOut",
    ]);
    expect(result.items[1]).toMatchObject({ exitCode: 3, stderr: "bad" });
    expect(result.items[2]?.error).toBeTruthy();
    expect(result.items[3]?.error).toMatch(/Timed out/);
  });

  it("reports output truncation", async () => {
    const cwd = await makeTempDir("command-batch-truncation");
    const result = await runCommandBatch({
      items: [item("large", cwd, "process.stdout.write('abcdef')", 1_000, 3)],
      maxConcurrency: 1,
    });
    expect(result.items[0]).toMatchObject({
      outcome: "succeeded",
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(result.items[0]?.stdout).toContain("output truncated");
  });

  it("publishes settlement callbacks with observed counts", async () => {
    const cwd = await makeTempDir("command-batch-callback");
    const updates: Array<{ id: string; completed: number; total: number }> = [];
    await runCommandBatch(
      {
        items: [item("one", cwd), item("two", cwd)],
        maxConcurrency: 1,
      },
      {
        onItemSettled: (result, completed, total) => {
          updates.push({ id: result.id, completed, total });
        },
      },
    );
    expect(updates).toEqual([
      { id: "one", completed: 1, total: 2 },
      { id: "two", completed: 2, total: 2 },
    ]);
  });

  it("keeps settlement callback failures observational", async () => {
    const cwd = await makeTempDir("command-batch-callback-failure");
    const result = await runCommandBatch(
      {
        items: [item("one", cwd), item("two", cwd)],
        maxConcurrency: 1,
      },
      {
        onItemSettled: () => {
          throw new Error("update unavailable");
        },
      },
    );
    expect(result).toMatchObject({
      completed: 2,
      items: [{ outcome: "succeeded" }, { outcome: "succeeded" }],
    });
  });

  it("replays a whole unaccepted read-only batch after interruption", async () => {
    const cwd = await makeTempDir("command-batch-replay");
    const log = path.join(cwd, "runs.log");
    const command = (id: string) =>
      item(
        id,
        cwd,
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(id)} + '\\n')`,
      );
    const request = { items: [command("one"), command("two")], maxConcurrency: 2 };
    const first = await runCommandBatch(request);
    const replay = await runCommandBatch(request);
    expect(first.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
    expect(replay.items.every((entry) => entry.outcome === "succeeded")).toBe(true);
    expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual([
      "one",
      "one",
      "two",
      "two",
    ]);
  });

  it("returns cancelled results without starting work when already aborted", async () => {
    const cwd = await makeTempDir("command-batch-pre-abort");
    const controller = new AbortController();
    controller.abort();
    const result = await runCommandBatch(
      { items: [item("one", cwd)], maxConcurrency: 1 },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      completed: 0,
      items: [{ id: "one", outcome: "cancelled", durationMs: 0 }],
    });
  });

  it("stops active work and does not start queued commands after abort", async () => {
    const cwd = await makeTempDir("command-batch-abort");
    const log = path.join(cwd, "started.log");
    const script = [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, 'started\\n');`,
      "setTimeout(() => {}, 5_000);",
    ].join("\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const result = await runCommandBatch(
      {
        items: [item("one", cwd, script, 10_000), item("two", cwd, script, 10_000)],
        maxConcurrency: 1,
      },
      { signal: controller.signal },
    );
    const starts = (await fs.readFile(log, "utf8")).trim().split("\n");
    expect(starts).toHaveLength(1);
    expect(result.items.map((entry) => entry.outcome)).toEqual(["cancelled", "cancelled"]);
  });
});
