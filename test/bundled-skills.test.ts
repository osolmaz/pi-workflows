import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "skills");

function skill(name: string): string {
  return readFileSync(path.join(skillRoot, name, "SKILL.md"), "utf8");
}

describe("bundled workflow skills", () => {
  it("ships one matching skill for each operator-facing built-in", () => {
    const names = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual(["autodoc", "autoimplement", "autoplan", "monitor", "pi-workflows"]);
    for (const name of names) {
      expect(skill(name)).toContain(`name: ${name}`);
    }
  });

  it.each(["autodoc", "autoimplement", "autoplan"])(
    "routes %s through its built-in workflow",
    (name) => {
      expect(skill(name)).toContain(`built-in \`${name}\` workflow`);
    },
  );

  it("routes monitor through its built-in workflow", () => {
    expect(skill("monitor")).toContain("built-in Pi `monitor` workflow");
  });

  it("keeps initial planning out of autoimplement and autodoc", () => {
    expect(skill("autoimplement")).toContain("Do not devise an initial plan");
    expect(skill("autodoc")).toContain("It does not choose, devise, improve, or revise");
  });
});
