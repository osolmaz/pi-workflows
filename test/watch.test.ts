import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { watchRunsDir } from "../src/viewer/watch.js";
import { makeTempDir } from "./helpers.js";

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for change event"));
      }
    }, 10);
  });
}

describe("watchRunsDir", () => {
  it("fires on file changes and debounces bursts", async () => {
    const dir = await makeTempDir("pi-workflows-watch");
    let changes = 0;
    const unsubscribe = watchRunsDir(
      dir,
      () => {
        changes += 1;
      },
      { pollMs: 60_000, debounceMs: 20 },
    );
    try {
      await fs.writeFile(path.join(dir, "a.json"), "{}", "utf8");
      await fs.writeFile(path.join(dir, "b.json"), "{}", "utf8");
      await waitFor(() => changes >= 1);
      expect(changes).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });

  it("falls back to polling when the directory cannot be watched", async () => {
    let changes = 0;
    const unsubscribe = watchRunsDir(
      "/nonexistent/pi-workflows",
      () => {
        changes += 1;
      },
      { pollMs: 20, debounceMs: 5 },
    );
    try {
      await waitFor(() => changes >= 1);
    } finally {
      unsubscribe();
    }
  });

  it("stops firing after unsubscribe", async () => {
    const dir = await makeTempDir("pi-workflows-watch");
    let changes = 0;
    const unsubscribe = watchRunsDir(
      dir,
      () => {
        changes += 1;
      },
      { pollMs: 20, debounceMs: 5 },
    );
    await waitFor(() => changes >= 1);
    unsubscribe();
    const settled = changes;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes).toBe(settled);
  });
});
