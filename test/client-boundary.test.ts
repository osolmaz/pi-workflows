import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string, suffix: RegExp): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target, suffix));
    else if (suffix.test(entry.name)) files.push(target);
  }
  return files;
}

describe("unified workflow client boundary", () => {
  it("keeps active SQLite access out of every production client", () => {
    const roots = ["src/extension", "src/client", "src/viewer", "tui/src"];
    const files = roots.flatMap((root) =>
      sourceFiles(path.join(process.cwd(), root), /\.(?:rs|ts)$/u),
    );
    for (const file of files) {
      if (file.endsWith(path.join("src", "viewer", "backup.ts"))) continue;
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(
        /new\s+StateDatabase\s*\(|better-sqlite3|rusqlite|Connection::open/u,
      );
    }
  });

  it("keeps only the version-1 client protocol in production clients", () => {
    const roots = ["src/extension", "src/client", "src/viewer", "tui/src"];
    const source = roots
      .flatMap((root) => sourceFiles(path.join(process.cwd(), root), /\.(?:rs|ts)$/u))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("pi-workflows.replay");
    expect(source).not.toContain("pi-workflows.host-request");
    expect(source).not.toContain("pi-workflows.host-response");
  });
});
