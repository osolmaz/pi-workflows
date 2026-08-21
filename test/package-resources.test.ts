import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const skillsRoot = path.join(repoRoot, "skills");

interface PackageManifest {
  version: string;
  files?: string[];
  pi?: {
    extensions?: string[];
    skills?: string[];
  };
}

function parseFrontmatter(markdown: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown);
  if (!match) return new Map();

  const body = match[1];
  if (body === undefined) return new Map();

  return new Map(
    body
      .split("\n")
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator < 0) return undefined;
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== undefined),
  );
}

async function skillFiles(): Promise<string[]> {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
    .sort();
}

describe("Pi package resources", () => {
  it("publishes the extension and skill directory", async () => {
    const manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageManifest;

    expect(manifest.files).toContain("skills");
    expect(manifest.files).toContain("plugins/herdr");
    expect(manifest.files).toContain("herdr-plugin.toml");
    expect(manifest.pi?.extensions).toEqual(["./src/extension/index.ts"]);
    expect(manifest.pi?.skills).toEqual(["./skills"]);

    const extensionPath = manifest.pi?.extensions?.[0];
    const skillPath = manifest.pi?.skills?.[0];
    if (extensionPath === undefined || skillPath === undefined) {
      throw new Error("Pi package resources are missing from package.json.");
    }
    await expect(fs.stat(path.join(repoRoot, extensionPath))).resolves.toBeDefined();
    await expect(fs.stat(path.join(repoRoot, skillPath))).resolves.toBeDefined();
  });

  it("ships one matching Herdr plugin from the package root", async () => {
    const manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageManifest;
    const herdrManifest = await fs.readFile(path.join(repoRoot, "herdr-plugin.toml"), "utf8");

    expect(herdrManifest).toContain('id = "osolmaz.pi-workflows"');
    expect(herdrManifest).toContain(`version = "${manifest.version}"`);
    expect(herdrManifest).toContain('command = ["node", "plugins/herdr/viewer.mjs"]');
    await expect(fs.stat(path.join(repoRoot, "plugins/herdr/viewer.mjs"))).resolves.toBeDefined();
  });

  it("ships valid uniquely named skills", async () => {
    const files = await skillFiles();
    expect(files.map((file) => path.relative(skillsRoot, file))).toEqual([
      "autodoc/SKILL.md",
      "autoimplement/SKILL.md",
      "autoplan/SKILL.md",
      "monitor/SKILL.md",
      "pi-workflows/SKILL.md",
    ]);

    const names: string[] = [];
    for (const file of files) {
      const markdown = await fs.readFile(file, "utf8");
      const frontmatter = parseFrontmatter(markdown);
      const name = frontmatter.get("name");
      const description = frontmatter.get("description");

      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(description?.length).toBeGreaterThan(0);
      if (name === undefined || description === undefined) {
        throw new Error(`${file} has incomplete frontmatter.`);
      }
      expect(description.length).toBeLessThanOrEqual(1024);
      names.push(name);
    }

    expect(new Set(names).size).toBe(names.length);
  });

  it("ships one-shot start contracts for built-in workflow skills", async () => {
    const expectedWorkflows = ["autodoc", "autoimplement", "autoplan", "monitor"] as const;

    for (const workflow of expectedWorkflows) {
      const markdown = await fs.readFile(path.join(skillsRoot, workflow, "SKILL.md"), "utf8");
      const exampleMatch = /```json\n([\s\S]*?)\n```/u.exec(markdown);
      const exampleText = exampleMatch?.[1];
      if (exampleText === undefined) {
        throw new Error(`${workflow} skill has no JSON start example.`);
      }
      const example = JSON.parse(exampleText) as {
        action?: unknown;
        workflow?: unknown;
        input?: Record<string, unknown>;
      };

      expect(markdown).toContain("## Start the workflow");
      expect(markdown.toLowerCase()).toContain("build the complete input");
      expect(example.action).toBe("start");
      expect(example.workflow).toBe(workflow);
      expect(example.input).toBeTypeOf("object");
    }

    const autoimplement = await fs.readFile(
      path.join(skillsRoot, "autoimplement", "SKILL.md"),
      "utf8",
    );
    expect(autoimplement).toContain('"repository": "/absolute/path/to/repository"');
    expect(autoimplement).toContain('"scope": "Only /absolute/path/to/repository.');
    expect(autoimplement).toContain('"merge": false');
    expect(autoimplement).toContain('"constraints": [');
  });

  it("keeps routine work moving without inventing paid-compute approval", async () => {
    const markdown = await fs.readFile(path.join(skillsRoot, "monitor", "SKILL.md"), "utf8");

    expect(markdown).toContain("A monitoring request does not grant spending approval");
    expect(markdown).toContain("continue without asking again");
    expect(markdown).toContain("Do not ask once per image, package, or task");
    expect(markdown).not.toContain("grants a default cumulative spending ceiling");
  });

  it("keeps local references in the workflow skill inside the package", async () => {
    const skillPath = path.join(skillsRoot, "pi-workflows", "SKILL.md");
    const markdown = await fs.readFile(skillPath, "utf8");
    const links = [...markdown.matchAll(/\[[^\]]+\]\((\.\.\/\.\.\/[^)]+)\)/gu)]
      .map((match) => match[1])
      .filter((link): link is string => link !== undefined);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      await expect(fs.stat(path.resolve(path.dirname(skillPath), link))).resolves.toBeDefined();
    }
  });
});
