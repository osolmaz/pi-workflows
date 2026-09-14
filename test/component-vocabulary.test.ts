import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The component rename cutover replaced one vocabulary with another in place:
 * workflow server, workflow runner, resource manager, resource runner, and
 * managed resource. This check reads every surface that a user, a client, or a
 * maintainer can open today, including the dated records and the tests, and it
 * reads the name of every one of those files.
 *
 * Two files stay out of scope. A check that refuses a term must name that term,
 * so this file is exempt from its own rule. `package-lock.json` is generated
 * dependency metadata that names a third-party package we do not own.
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

/** The retired names also leave no trace in a file or directory name. */
const RETIRED_NAME = /host/iu;

const TEXT_SUFFIX = /\.(?:cjs|json|jsonc|js|md|mjs|mts|py|rs|sh|toml|ts|ya?ml)$/u;
const SKIP_DIRECTORY = new Set([".git", "coverage", "dist", "node_modules", "target"]);
const SKIP_FILE = new Set(["package-lock.json"]);

interface WalkedFile {
  /** Every file and directory the walk reaches, relative to the repository root. */
  relative: string;
  /** Text a reader can open, or null for a binary file. */
  text: string | null;
}

function walkedFiles(root: string): WalkedFile[] {
  const walked: WalkedFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory()) {
        walked.push({ relative, text: null });
        if (!SKIP_DIRECTORY.has(entry.name)) visit(target);
      } else if (
        TEXT_SUFFIX.test(entry.name) ||
        // A dotfile and an extensionless file such as `LICENSE` are text too.
        !entry.name.includes(".")
      ) {
        walked.push({ relative, text: fs.readFileSync(target, "utf8") });
      } else {
        walked.push({ relative, text: null });
      }
    }
  };
  visit(root);
  return walked;
}

describe("component naming cutover", () => {
  const root = process.cwd();
  const walked = walkedFiles(root);
  const files = walked
    .filter((file) => file.text !== null)
    .filter(
      (file) =>
        file.relative !== path.join("test", "component-vocabulary.test.ts") &&
        !SKIP_FILE.has(path.basename(file.relative)),
    );

  it("reads the surfaces a user or a client sees", () => {
    // Guard the guard: the sweep must reach the sources, the documentation, the
    // skills, the dated records, and the tests.
    const relative = files.map((file) => file.relative);
    for (const expected of [
      "src/server/server.ts",
      "docs/WORKFLOW_SERVER.md",
      "README.md",
      path.join("docs", "plans", "2026-09-12-current-workflow-state-plan.md"),
      path.join("test", "server.test.ts"),
    ]) {
      expect(relative, expected).toContain(expected);
    }
    expect(relative.some((file) => file.startsWith(`skills${path.sep}`))).toBe(true);
    expect(relative.some((file) => file.startsWith(`docs${path.sep}2026-`))).toBe(true);
  });

  it.each(RETIRED_TERMS)("keeps %s out of every current file", (term) => {
    const offenders = files.filter((file) => file.text?.includes(term));
    expect(
      offenders.map((file) => file.relative),
      term,
    ).toEqual([]);
  });

  it("keeps the retired wording out of every file and directory name", () => {
    const offenders = walked.filter((file) => RETIRED_NAME.test(file.relative));
    expect(offenders.map((file) => file.relative)).toEqual([]);
  });
});
