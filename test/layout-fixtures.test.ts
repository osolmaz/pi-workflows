import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLayoutFixtures, fixturesDir } from "./helpers/layout-fixtures.js";

/**
 * The committed fixtures must match what the current code generates; the Rust
 * TUI's parity tests read the same files. On intentional layout or render
 * changes, run `npm run fixtures` and update both implementations together.
 */
describe("layout fixtures", () => {
  it("match the committed golden files exactly", async () => {
    const fixtures = await buildLayoutFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    const dir = fixturesDir();
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual(fixtures.map((fixture) => `${fixture.name}.json`).sort());

    for (const fixture of fixtures) {
      const committed = JSON.parse(
        await fs.readFile(path.join(dir, `${fixture.name}.json`), "utf8"),
      ) as unknown;
      expect(committed, fixture.name).toEqual(JSON.parse(JSON.stringify(fixture)));
    }
  }, 30_000);
});
