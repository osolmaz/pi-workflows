import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The component rename cutover replaced one vocabulary with another in place:
 * workflow server, workflow runner, resource manager, resource runner, and
 * managed resource. This check reads every surface that a user, a client, or a
 * maintainer can see today.
 *
 * Three kinds of file stay out of scope. A dated record keeps the wording of its
 * own date, because it describes the state at that date. A test may build an
 * invalid old value on purpose, to prove that the product refuses it. Generated
 * dependency metadata is not ours to edit.
 */
const RETIRED_TERMS = [
  "hosted",
  "hostId",
  "host_id",
  "hostEpoch",
  "host_epoch",
  "hostRequest",
  "hostResponse",
  '"host"',
  "'host'",
];

const TEXT_SUFFIX = /\.(?:cjs|json|jsonc|js|md|mjs|mts|py|rs|sh|toml|ts|ya?ml)$/u;
const DATED_RECORD = /^\d{4}-\d{2}-\d{2}-/u;
const SKIP_DIRECTORY = new Set([".git", "coverage", "dist", "node_modules", "target"]);
const SKIP_FILE = new Set(["package-lock.json"]);

function readableFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORY.has(entry.name)) files.push(...readableFiles(target));
    } else if (
      TEXT_SUFFIX.test(entry.name) ||
      // A dotfile and an extensionless file such as `LICENSE` are text too.
      !entry.name.includes(".")
    ) {
      files.push(target);
    }
  }
  return files;
}

describe("component naming cutover", () => {
  const root = process.cwd();
  const files = readableFiles(root).filter(
    (file) =>
      !path.relative(root, file).startsWith(`test${path.sep}`) &&
      !DATED_RECORD.test(path.basename(file)) &&
      !SKIP_FILE.has(path.basename(file)),
  );

  it("reads the surfaces a user or a client sees", () => {
    // Guard the guard: the sweep must reach the sources and the documentation.
    const relative = files.map((file) => path.relative(root, file));
    for (const expected of ["src/server/server.ts", "docs/WORKFLOW_SERVER.md", "README.md"]) {
      expect(relative, expected).toContain(expected);
    }
    expect(relative.some((file) => file.startsWith(`skills${path.sep}`))).toBe(true);
  });

  it.each(RETIRED_TERMS)("keeps %s out of every current surface", (term) => {
    const offenders = files.filter((file) => fs.readFileSync(file, "utf8").includes(term));
    expect(
      offenders.map((file) => path.relative(root, file)),
      term,
    ).toEqual([]);
  });
});
