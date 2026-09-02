import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CHILD_FILES = [
  "src/channels/adapter-entry.ts",
  "src/channels/protocol.ts",
  "src/channels/telegram.ts",
];

describe("channel adapter process boundary", () => {
  it("does not import SQLite, workflow loading, or workflow state stores", async () => {
    for (const relativePath of CHILD_FILES) {
      const source = await fs.readFile(path.resolve(relativePath), "utf8");
      expect(source, relativePath).not.toMatch(
        /better-sqlite3|state\/database|workflows\/(?:loader|store|human-decision)/u,
      );
    }
  });
});
