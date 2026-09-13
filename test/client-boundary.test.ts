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

  it("keeps the Rust client operations equal to the version-1 schema", () => {
    const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const rust = /const OPERATIONS: &\[&str\] = &\[([\s\S]*?)\];/u.exec(
      read("tui/src/protocol.rs"),
    );
    expect(rust).not.toBeNull();
    const parsed = [...(rust?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map(
      (entry) => entry[1] as string,
    );
    const schema = JSON.parse(read("protocol/client.v1.schema.json")) as {
      oneOf: { properties?: { operation?: { enum?: string[] } } }[];
    };
    const enumerated =
      schema.oneOf.find((branch) => branch.properties?.operation?.enum !== undefined)?.properties
        ?.operation?.enum ?? [];
    expect(parsed.length).toBeGreaterThan(0);
    // The schema describes the one version-1 protocol that both clients parse, so an
    // operation missing from the Rust list would refuse a valid request.
    expect([...parsed].sort()).toEqual([...enumerated].sort());
    // The node window the widget pages with is part of that version-1 protocol.
    expect(enumerated).toContain("view.session.window");
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
