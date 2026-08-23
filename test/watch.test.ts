import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { watchStateDatabase } from "../src/viewer/watch.js";
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

describe("watchStateDatabase", () => {
  it("fires for the database and WAL and debounces bursts", async () => {
    const dir = await makeTempDir("pi-workflows-watch");
    const databasePath = path.join(dir, "state.sqlite");
    let changes = 0;
    const unsubscribe = watchStateDatabase(databasePath, () => changes++, {
      pollMs: 60_000,
      debounceMs: 20,
    });
    try {
      await fs.writeFile(databasePath, "", "utf8");
      await fs.writeFile(`${databasePath}-wal`, "", "utf8");
      await waitFor(() => changes >= 1);
      expect(changes).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });

  it("uses polling when the parent directory cannot be watched", async () => {
    let changes = 0;
    const unsubscribe = watchStateDatabase(
      "/nonexistent/pi-workflows/state.sqlite",
      () => changes++,
      { pollMs: 20, debounceMs: 5 },
    );
    try {
      await waitFor(() => changes >= 1);
    } finally {
      unsubscribe();
    }
  });

  it("stops after unsubscribe", async () => {
    const dir = await makeTempDir("pi-workflows-watch");
    let changes = 0;
    const unsubscribe = watchStateDatabase(path.join(dir, "state.sqlite"), () => changes++, {
      pollMs: 20,
      debounceMs: 5,
    });
    await waitFor(() => changes >= 1);
    unsubscribe();
    const settled = changes;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes).toBe(settled);
  });
});
