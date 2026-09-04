import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyStatusPatch,
  conditionFalse,
  conditionTrue,
  conditionUnknown,
  mergeConditions,
} from "../src/resource-managers/conditions.js";
import {
  assertValidResourceManagerDefinition,
  defineResourceManager,
  isResourceManagerDefinition,
} from "../src/resource-managers/definition.js";
import { ManagedResourceNotFoundError } from "../src/resource-managers/errors.js";
import { canonicalJson, jsonFingerprint, parseStoredJson } from "../src/resource-managers/json.js";
import {
  resourceManagerFileStem,
  resourceManagerSearchDirs,
  discoverResourceManagers,
  loadResourceManagerFile,
} from "../src/resource-managers/loader.js";
import { requeue, requeueAfter, settled } from "../src/resource-managers/results.js";
import { makeTempDir } from "./helpers.js";

describe("resource manager definitions", () => {
  it("brands and validates resource manager definitions", () => {
    const controller = defineResourceManager({
      name: "pull-request",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    expect(isResourceManagerDefinition(controller)).toBe(true);
    expect(defineResourceManager(controller)).toBe(controller);
    expect(() =>
      assertValidResourceManagerDefinition({
        name: "Bad Name",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
      }),
    ).toThrow(/must match/);
    expect(() =>
      assertValidResourceManagerDefinition({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
        timeoutMs: 0,
      }),
    ).toThrow(/positive/);
    expect(() => assertValidResourceManagerDefinition(null as never)).toThrow(/object/);
    expect(() =>
      assertValidResourceManagerDefinition({
        name: "demo",
        initialStatus: "bad" as never,
        reconcile: (ctx) => ctx.settled(),
      }),
    ).toThrow(/initialStatus/);
    expect(() =>
      assertValidResourceManagerDefinition({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: "bad" as never,
      }),
    ).toThrow(/reconcile/);
  });
});

describe("resource manager conditions", () => {
  it("merges by type and changes transition time only when status changes", () => {
    const first = mergeConditions(
      [],
      [conditionUnknown("Ready", "Checking")],
      1,
      "2026-08-04T00:00:00.000Z",
    );
    const sameStatus = mergeConditions(
      first,
      [conditionUnknown("Ready", "StillChecking", "waiting")],
      2,
      "2026-08-04T00:01:00.000Z",
    );
    const changed = mergeConditions(
      sameStatus,
      [conditionTrue("Ready", "Complete")],
      2,
      "2026-08-04T00:02:00.000Z",
    );
    expect(sameStatus[0]?.lastTransitionTime).toBe(first[0]?.lastTransitionTime);
    expect(sameStatus[0]?.observedGeneration).toBe(2);
    expect(changed[0]?.lastTransitionTime).toBe("2026-08-04T00:02:00.000Z");
    expect(conditionFalse("Healthy", "Failed").status).toBe(false);
  });

  it("applies status and workflow patches", () => {
    const current = {
      observedGeneration: 1,
      conditions: [],
      resourceManagerStatus: { phase: "new" },
      workflowRun: { requestId: "r", state: "running" as const, attempt: 1 },
    };
    const preserved = applyStatusPatch(current, undefined, 2, "2026-08-04T00:00:00.000Z");
    expect(preserved.workflowRun).toEqual(current.workflowRun);
    const cleared = applyStatusPatch(
      current,
      { resourceManagerStatus: { phase: "done" }, workflowRun: null },
      2,
      "2026-08-04T00:00:00.000Z",
    );
    expect(cleared).toEqual({
      observedGeneration: 2,
      conditions: [],
      resourceManagerStatus: { phase: "done" },
    });
    const nullable = applyStatusPatch<{ phase: string } | null>(
      current,
      { resourceManagerStatus: null },
      2,
      "2026-08-04T00:00:00.000Z",
    );
    expect(nullable.resourceManagerStatus).toBeNull();
    expect(() =>
      mergeConditions(
        [],
        [conditionTrue("Ready", "One"), conditionTrue("Ready", "Two")],
        1,
        "2026-08-04T00:00:00.000Z",
      ),
    ).toThrow(/more than once/);
    expect(() => conditionTrue("", "Reason")).toThrow(/type/);
    expect(() => conditionTrue("Ready", "")).toThrow(/reason/);
    expect(() =>
      mergeConditions(
        [],
        [{ type: "Ready", status: "bad" as never, reason: "Broken" }],
        1,
        "2026-08-04T00:00:00.000Z",
      ),
    ).toThrow(/status/);
  });
});

describe("resource manager JSON", () => {
  it("canonicalizes keys and fingerprints equal values equally", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(jsonFingerprint({ b: 2, a: 1 })).toBe(jsonFingerprint({ a: 1, b: 2 }));
  });

  it("rejects cycles and unsupported values", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(/cycle/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/not JSON/);
    expect(() => parseStoredJson("{", "broken")).toThrow(/invalid JSON/);
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "plain failure";
    });
    expect(() => parseStoredJson("{}", "broken")).toThrow("plain failure");
    parse.mockRestore();
  });
});

describe("resource manager errors", () => {
  it("names missing resources", () => {
    expect(new ManagedResourceNotFoundError("demo", "one").message).toContain("demo/one");
  });
});

describe("resource manager result helpers", () => {
  it("builds settled and requeue results", () => {
    expect(settled()).toEqual({ kind: "settled" });
    expect(settled({ resourceManagerStatus: { ok: true } })).toMatchObject({ kind: "settled" });
    expect(requeue()).toEqual({ kind: "requeue" });
    expect(requeueAfter(25)).toEqual({ kind: "requeue", afterMs: 25 });
    expect(() => requeueAfter(0)).toThrow(/positive/);
  });
});

describe("resource manager discovery", () => {
  it("loads TypeScript resource managers with project precedence", async () => {
    const cwd = await makeTempDir("pi-resource-manager-loader");
    const home = await makeTempDir("pi-resource-manager-home");
    const projectDir = path.join(cwd, ".pi", "resource-managers");
    const globalDir = path.join(home, ".pi", "agent", "resource-managers");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    const source = `
      import { defineResourceManager } from "@osolmaz/pi-workflows/resource-managers";
      export default defineResourceManager({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
      });
    `;
    await fs.writeFile(path.join(projectDir, "demo.resource-manager.ts"), source);
    await fs.writeFile(path.join(globalDir, "demo.resource-manager.ts"), source);
    await fs.writeFile(
      path.join(globalDir, "other.resource-manager.ts"),
      source.replace('"demo"', '"other"'),
    );

    const discovered = await discoverResourceManagers({ cwd, homeDir: home });
    expect(discovered.map((item) => [item.name, item.source])).toEqual([
      ["demo", "project"],
      ["other", "global"],
    ]);
    expect((await loadResourceManagerFile(discovered[0]?.path as string)).name).toBe("demo");
    expect(resourceManagerFileStem("x.resource-manager.mts")).toBe("x");
    expect(resourceManagerSearchDirs({ cwd, homeDir: home }).map((item) => item.dir)).toEqual([
      projectDir,
      globalDir,
    ]);
    expect(resourceManagerSearchDirs({ cwd })[0]?.dir).toBe(projectDir);
  });

  it("rejects an unbranded module", async () => {
    const cwd = await makeTempDir("pi-resource-manager-loader");
    const file = path.join(cwd, "bad.resource-manager.ts");
    await fs.writeFile(file, "export default {};");
    await expect(loadResourceManagerFile(file)).rejects.toThrow(/defineResourceManager/);
  });
});
