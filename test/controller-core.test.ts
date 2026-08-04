import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyStatusPatch,
  conditionFalse,
  conditionTrue,
  conditionUnknown,
  mergeConditions,
} from "../src/controllers/conditions.js";
import {
  assertValidControllerDefinition,
  defineController,
  isControllerDefinition,
} from "../src/controllers/definition.js";
import { ResourceNotFoundError } from "../src/controllers/errors.js";
import { canonicalJson, jsonFingerprint, parseStoredJson } from "../src/controllers/json.js";
import {
  controllerFileStem,
  controllerSearchDirs,
  discoverControllers,
  loadControllerFile,
} from "../src/controllers/loader.js";
import { requeue, requeueAfter, settled } from "../src/controllers/results.js";
import { controllerProjectScope, projectControllerStoreBaseDir } from "../src/controllers/store.js";
import { makeTempDir } from "./helpers.js";

describe("controller store scope", () => {
  it("derives a stable and isolated project directory", async () => {
    const first = await makeTempDir("pi-controller-project");
    const second = await makeTempDir("pi-controller-project");
    const home = await makeTempDir("pi-controller-home");
    expect(controllerProjectScope(first)).toHaveLength(24);
    expect(controllerProjectScope(first)).not.toBe(controllerProjectScope(second));
    expect(projectControllerStoreBaseDir(first, home)).toBe(
      path.join(
        home,
        ".pi",
        "agent",
        "workflows",
        "controllers",
        "projects",
        controllerProjectScope(first),
      ),
    );
  });

  it("uses the configured controller root without sharing project state", async () => {
    const first = await makeTempDir("pi-controller-project");
    const second = await makeTempDir("pi-controller-project");
    const root = await makeTempDir("pi-controller-root");
    vi.stubEnv("PI_WORKFLOWS_CONTROLLER_DIR", root);
    try {
      expect(projectControllerStoreBaseDir(first)).toBe(
        path.join(root, "projects", controllerProjectScope(first)),
      );
      expect(projectControllerStoreBaseDir(second)).not.toBe(projectControllerStoreBaseDir(first));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("controller definitions", () => {
  it("brands and validates controller definitions", () => {
    const controller = defineController({
      name: "pull-request",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    expect(isControllerDefinition(controller)).toBe(true);
    expect(defineController(controller)).toBe(controller);
    expect(() =>
      assertValidControllerDefinition({
        name: "Bad Name",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
      }),
    ).toThrow(/must match/);
    expect(() =>
      assertValidControllerDefinition({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
        timeoutMs: 0,
      }),
    ).toThrow(/positive/);
    expect(() => assertValidControllerDefinition(null as never)).toThrow(/object/);
    expect(() =>
      assertValidControllerDefinition({
        name: "demo",
        initialStatus: "bad" as never,
        reconcile: (ctx) => ctx.settled(),
      }),
    ).toThrow(/initialStatus/);
    expect(() =>
      assertValidControllerDefinition({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: "bad" as never,
      }),
    ).toThrow(/reconcile/);
  });
});

describe("controller conditions", () => {
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
      controllerStatus: { phase: "new" },
      workflowRun: { requestId: "r", state: "running" as const, attempt: 1 },
    };
    const preserved = applyStatusPatch(current, undefined, 2, "2026-08-04T00:00:00.000Z");
    expect(preserved.workflowRun).toEqual(current.workflowRun);
    const cleared = applyStatusPatch(
      current,
      { controllerStatus: { phase: "done" }, workflowRun: null },
      2,
      "2026-08-04T00:00:00.000Z",
    );
    expect(cleared).toEqual({
      observedGeneration: 2,
      conditions: [],
      controllerStatus: { phase: "done" },
    });
    const nullable = applyStatusPatch<{ phase: string } | null>(
      current,
      { controllerStatus: null },
      2,
      "2026-08-04T00:00:00.000Z",
    );
    expect(nullable.controllerStatus).toBeNull();
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

describe("controller JSON", () => {
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

describe("controller errors", () => {
  it("names missing resources", () => {
    expect(new ResourceNotFoundError("demo", "one").message).toContain("demo/one");
  });
});

describe("controller result helpers", () => {
  it("builds settled and requeue results", () => {
    expect(settled()).toEqual({ kind: "settled" });
    expect(settled({ controllerStatus: { ok: true } })).toMatchObject({ kind: "settled" });
    expect(requeue()).toEqual({ kind: "requeue" });
    expect(requeueAfter(25)).toEqual({ kind: "requeue", afterMs: 25 });
    expect(() => requeueAfter(0)).toThrow(/positive/);
  });
});

describe("controller discovery", () => {
  it("loads TypeScript controllers with project precedence", async () => {
    const cwd = await makeTempDir("pi-controller-loader");
    const home = await makeTempDir("pi-controller-home");
    const projectDir = path.join(cwd, ".pi", "controllers");
    const globalDir = path.join(home, ".pi", "agent", "controllers");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    const source = `
      import { defineController } from "@osolmaz/pi-workflows/controllers";
      export default defineController({
        name: "demo",
        initialStatus: () => ({}),
        reconcile: (ctx) => ctx.settled(),
      });
    `;
    await fs.writeFile(path.join(projectDir, "demo.controller.ts"), source);
    await fs.writeFile(path.join(globalDir, "demo.controller.ts"), source);
    await fs.writeFile(
      path.join(globalDir, "other.controller.ts"),
      source.replace('"demo"', '"other"'),
    );

    const discovered = await discoverControllers({ cwd, homeDir: home });
    expect(discovered.map((item) => [item.name, item.source])).toEqual([
      ["demo", "project"],
      ["other", "global"],
    ]);
    expect((await loadControllerFile(discovered[0]?.path as string)).name).toBe("demo");
    expect(controllerFileStem("x.controller.mts")).toBe("x");
    expect(controllerSearchDirs({ cwd, homeDir: home }).map((item) => item.dir)).toEqual([
      projectDir,
      globalDir,
    ]);
    expect(controllerSearchDirs({ cwd })[0]?.dir).toBe(projectDir);
  });

  it("rejects an unbranded module", async () => {
    const cwd = await makeTempDir("pi-controller-loader");
    const file = path.join(cwd, "bad.controller.ts");
    await fs.writeFile(file, "export default {};");
    await expect(loadControllerFile(file)).rejects.toThrow(/defineController/);
  });
});
