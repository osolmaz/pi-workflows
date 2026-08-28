#!/usr/bin/env node
/**
 * Regenerate the golden layout fixtures under fixtures/layout/. See
 * test/helpers/layout-fixtures.ts for what they pin.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const run = promisify(execFile);
const jiti = createJiti(import.meta.url);
const { buildLayoutFixtures, fixturesDir } = await jiti.import(
  "../test/helpers/layout-fixtures.ts",
);

const outDir = fixturesDir();
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const fixtures = await buildLayoutFixtures();
for (const fixture of fixtures) {
  const file = path.join(outDir, `${fixture.name}.json`);
  await fs.writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}
const executable = process.platform === "win32" ? "oxfmt.cmd" : "oxfmt";
await run(path.resolve("node_modules", ".bin", executable), ["--write", outDir]);
console.log(`Wrote ${fixtures.length} fixtures to ${outDir}`);
