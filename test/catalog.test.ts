import { describe, expect, it } from "vitest";
import { builtinWorkflowCatalog } from "../src/builtins/catalog.js";
import { BuiltinWorkflowCatalog } from "../src/workflows/catalog.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { BuiltinWorkflowRevisionChangedError } from "../src/workflows/errors.js";

function fixture(name = "fixture") {
  return defineWorkflow({
    name,
    startAt: "done",
    nodes: { done: compute({ run: () => true }) },
    edges: [],
  });
}

describe("BuiltinWorkflowCatalog", () => {
  it("ships stable built-in revisions", () => {
    expect(builtinWorkflowCatalog.get("plain-summary")?.revision).toBe("1");
    expect(builtinWorkflowCatalog.get("autoplan")?.revision).toBe("2");
    expect(builtinWorkflowCatalog.get("autoimplement")?.revision).toBe("9");
    expect(builtinWorkflowCatalog.get("monitor")?.revision).toBe("11");
    expect(builtinWorkflowCatalog.get("plan-approval")?.revision).toBe("4");
    expect(builtinWorkflowCatalog.get("sanity-check")?.revision).toBe("3");
  });

  it("rejects unfinished Sanity Check revision 2 with restart guidance", () => {
    expect(() =>
      builtinWorkflowCatalog.resolve(
        { kind: "builtin", id: "sanity-check", revision: "2" },
        "old-sanity-check",
      ),
    ).toThrow(/cancel run old-sanity-check, then start sanity-check again/);
  });

  it("resolves a stable built-in source without reading a file", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([{ id: "fixture", revision: "r1", definition }]);

    expect(catalog.resolve({ kind: "builtin", id: "fixture", revision: "r1" })).toBe(definition);
    expect(catalog.get("fixture")?.ref).toBe("builtin:fixture");
  });

  it("rejects changed revisions with restart guidance and duplicate identities", () => {
    const definition = fixture();
    const catalog = new BuiltinWorkflowCatalog([{ id: "fixture", revision: "r1", definition }]);

    expect(() =>
      catalog.resolve({ kind: "builtin", id: "fixture", revision: "r2" }, "old-run"),
    ).toThrow(BuiltinWorkflowRevisionChangedError);
    expect(() =>
      catalog.resolve({ kind: "builtin", id: "fixture", revision: "r2" }, "old-run"),
    ).toThrow(/cancel run old-run, then start fixture again/);
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
    expect(
      catalog.matchLegacy({
        workflowName: "fixture",
        workflowPath: "C:\\package\\dist\\builtins\\fixture.workflow.js",
        workflowHash: "old",
      })?.entry.id,
    ).toBe("fixture");
  });
});
