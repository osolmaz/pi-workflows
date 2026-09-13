import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The component rename cutover replaced one vocabulary with another in place:
 * workflow server, workflow runner, resource manager, resource runner, and
 * managed resource. Dated plan records under `docs/plans` and `docs/2026-*.md`
 * keep their original wording, because they describe the state at their date, so
 * this check reads only the surfaces a user or a client sees today.
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

function sourceFiles(root: string, suffix: RegExp): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target, suffix));
    else if (suffix.test(entry.name)) files.push(target);
  }
  return files;
}

function assertCurrentVocabulary(file: string): void {
  const source = fs.readFileSync(file, "utf8");
  for (const term of RETIRED_TERMS) {
    expect(source, `${file} contains ${term}`).not.toContain(term);
  }
}

describe("component naming cutover", () => {
  it("keeps the retired component vocabulary out of current sources", () => {
    const roots = ["src", "protocol", "scripts", "tui/src"];
    const files = roots.flatMap((root) =>
      sourceFiles(path.join(process.cwd(), root), /\.(?:json|mjs|rs|ts)$/u),
    );
    // Files outside the scanned roots also name current components.
    files.push(path.join(process.cwd(), "tui", "Cargo.toml"));
    files.push(path.join(process.cwd(), "package.json"));
    for (const file of files) assertCurrentVocabulary(file);
  });

  it("keeps the retired component vocabulary out of current documentation", () => {
    const docs = fs
      .readdirSync(path.join(process.cwd(), "docs"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          // A dated record keeps the wording of its own date.
          !/^\d{4}-\d{2}-\d{2}-/u.test(entry.name),
      )
      .map((entry) => path.join(process.cwd(), "docs", entry.name));
    docs.push(path.join(process.cwd(), "README.md"));
    for (const file of docs) assertCurrentVocabulary(file);
  });
});
