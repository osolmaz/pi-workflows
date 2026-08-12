import { describe, expect, it } from "vitest";
import { BuiltinWorkflowCatalog } from "../src/workflows/catalog.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";

function fixture(name = "fixture") {
  return defineWorkflow({
    name,
    startAt: "done",
    nodes: { done: compute({ run: () => true }) },
    edges: [],
  });
}

describe("BuiltinWorkflowCatalog", () => {
  it("resolves a stable built-in source without reading a file", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([{ id: "fixture", revision: "r1", definition }]);

    expect(catalog.resolve({ kind: "builtin", id: "fixture", revision: "r1" })).toBe(definition);
    expect(catalog.get("fixture")?.ref).toBe("builtin:fixture");
  });

  it("rejects changed revisions and duplicate identities", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([{ id: "fixture", revision: "r1", definition }]);

    expect(() => catalog.resolve({ kind: "builtin", id: "fixture", revision: "r2" })).toThrow(
      /Workflow source changed/,
    );
    expect(
      () =>
        new BuiltinWorkflowCatalog([
          { id: "fixture", revision: "r1", definition },
          { id: "fixture", revision: "r2", definition: fixture("other") },
        ]),
    ).toThrow(/Duplicate built-in workflow id/);
  });

  it("matches only proved legacy paths and hashes", () => {
    const catalog = new BuiltinWorkflowCatalog([
      {
        id: "fixture",
        revision: "r1",
        definition: fixture(),
        legacySources: [
          { workflowHash: "old", revision: "r1", pathSuffixes: ["/builtins/fixture.workflow.js"] },
        ],
      },
    ]);

    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
        workflowHash: "old",
      }),
    ).toMatchObject({ entry: { id: "fixture" }, revision: "r1" });
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/project/fixture.workflow.js",
        workflowHash: "old",
      }),
    ).toBeUndefined();
    expect(
      catalog.legacyPathEntry({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
      })?.id,
    ).toBe("fixture");
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "/package/dist/builtins/fixture.workflow.js",
        workflowHash: "changed",
      }),
    ).toBeUndefined();
  });
});
