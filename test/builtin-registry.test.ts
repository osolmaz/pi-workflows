import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureBuiltinWorkflows } from "../src/workflows/builtin-registry.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { makeTempDir } from "./helpers.js";

const workflow = defineWorkflow({
  name: "fixture",
  startAt: "done",
  nodes: { done: compute({ run: () => true }) },
  edges: [],
});

describe("captureBuiltinWorkflows", () => {
  it("keeps a definition and source hash stable after its temp file changes", async () => {
    const dir = await makeTempDir("pi-workflows-builtins");
    const filePath = path.join(dir, "fixture.workflow.js");
    const aliasPath = path.join(dir, "fixture.workflow.ts");
    await fs.writeFile(filePath, "export default 'first';\n", "utf8");
    await fs.writeFile(aliasPath, "export default 'source alias';\n", "utf8");
    const captured = captureBuiltinWorkflows([
      { name: "fixture", definition: workflow, candidatePaths: [filePath, aliasPath] },
    ]);
    const before = captured.byName.get("fixture");

    await fs.writeFile(filePath, "export default 'second';\n", "utf8");

    expect(before?.definition).toBe(workflow);
    expect(captured.byPath.get(filePath)).toBe(before);
    expect(captured.byPath.get(aliasPath)).toBe(before);
    expect(captured.byName.get("fixture")?.sourceHash).toBe(before?.sourceHash);
  });

  it("rejects a built-in without a readable source file", () => {
    expect(() =>
      captureBuiltinWorkflows([
        { name: "missing", definition: workflow, candidatePaths: ["/missing/workflow.js"] },
      ]),
    ).toThrow(/Built-in workflow module is missing/);
  });
});
