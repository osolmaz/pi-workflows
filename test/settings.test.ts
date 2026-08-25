import { describe, expect, it } from "vitest";
import {
  allowSettingsPath,
  applyWorkflowSettingsPatch,
  resolveInitialWorkflowSettings,
  settingsRoute,
  settingsRuleForPath,
  workflowSettings,
  workflowSettingsScopeId,
} from "../src/workflows/settings.js";

function parseSettings(value: unknown): { merge: "allow" | "forbid"; items: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be an object");
  }
  const input = value as { merge?: unknown; items?: unknown };
  if ((input.merge !== "allow" && input.merge !== "forbid") || !Array.isArray(input.items)) {
    throw new Error("invalid settings");
  }
  if (!input.items.every((item) => typeof item === "string")) {
    throw new Error("invalid items");
  }
  return { merge: input.merge, items: [...input.items] };
}

const definition = workflowSettings({
  initial: { merge: "allow" as const, items: [] as string[] },
  parse: parseSettings,
  paths: [
    allowSettingsPath("/merge", {
      read: ["session", "human"],
      replace: ["human"],
    }),
    allowSettingsPath("/items", {
      read: ["session", "human"],
      add: ["session", "human"],
      remove: ["session", "human"],
      replace: ["session", "human"],
    }),
  ],
  validateChange: ({ before, after, actor }) => {
    if (actor.type === "session" && before.merge === "forbid" && after.merge === "allow") {
      throw new Error("session cannot grant merge authority");
    }
  },
});

describe("workflow settings", () => {
  it("builds stable root and child scope IDs", () => {
    expect(workflowSettingsScopeId("run-1", "", 1)).toBe("run-1:$root:1");
    expect(workflowSettingsScopeId("run-1", "child", 2)).toBe("run-1:child:2");
    expect(() => workflowSettingsScopeId("run-1", "", 0)).toThrow(/positive integer/);
  });

  it("resolves and validates the initial value", async () => {
    await expect(resolveInitialWorkflowSettings(definition, null)).resolves.toMatchObject({
      settings: { merge: "allow", items: [] },
      json: { merge: "allow", items: [] },
    });
  });

  it("resolves an input-derived initial value and rejects invalid initial settings", async () => {
    const derived = workflowSettings<{ value: string }, { seed: string }>({
      initial: (input) => ({ value: input.seed }),
      parse: (value) => {
        if ((value as { value?: unknown }).value === "bad") throw new Error("bad initial value");
        return value as { value: string };
      },
      paths: [allowSettingsPath("/value", { replace: ["human"] })],
    });
    await expect(resolveInitialWorkflowSettings(derived, { seed: "ok" })).resolves.toMatchObject({
      settings: { value: "ok" },
    });
    await expect(resolveInitialWorkflowSettings(derived, { seed: "bad" })).rejects.toThrow(
      /bad initial/,
    );
  });

  it("applies allowed session changes and preserves the exact patch", async () => {
    const patch = [{ op: "add" as const, path: "/items/-", value: "check CI" }];
    const result = await applyWorkflowSettingsPatch(
      definition,
      { merge: "allow", items: [] },
      patch,
      { type: "session", id: "session-1" },
      "workflow-tool",
    );
    expect(result.patch).toEqual(patch);
    expect(result.settings).toEqual({ merge: "allow", items: ["check CI"] });
  });

  it("denies paths and actor permissions by default", async () => {
    await expect(
      applyWorkflowSettingsPatch(
        definition,
        { merge: "allow", items: [] },
        [{ op: "replace", path: "/merge", value: "forbid" }],
        { type: "session" },
        "workflow-tool",
      ),
    ).rejects.toThrow(/not allowed/);
    await expect(
      applyWorkflowSettingsPatch(
        definition,
        { merge: "allow", items: [] },
        [{ op: "add", path: "/unknown", value: true }],
        { type: "human" },
        "interactive-command",
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("checks both source permissions for move", async () => {
    const noSourceRead = workflowSettings({
      initial: { a: "x", b: "y" },
      parse: (value) => value as { a: string; b: string },
      paths: [
        allowSettingsPath("/a", { remove: ["human"] }),
        allowSettingsPath("/b", { replace: ["human"] }),
      ],
    });
    await expect(
      applyWorkflowSettingsPatch(
        noSourceRead,
        { a: "x", b: "y" },
        [{ op: "move", from: "/a", path: "/b" }],
        { type: "human" },
        "interactive-command",
      ),
    ).rejects.toThrow(/read is not allowed/);
  });

  it("applies test, copy, and move only with source and destination permissions", async () => {
    const copyMove = workflowSettings({
      initial: { source: { value: 1 }, target: null as unknown },
      parse: (value) => value as { source?: { value: number }; target: unknown },
      paths: [
        allowSettingsPath("/source", { read: ["human"], remove: ["human"] }),
        allowSettingsPath("/target", { replace: ["human"] }),
      ],
    });
    await expect(
      applyWorkflowSettingsPatch(
        copyMove,
        { source: { value: 1 }, target: null },
        [
          { op: "test", path: "/source/value", value: 1 },
          { op: "copy", from: "/source", path: "/target" },
          { op: "move", from: "/source", path: "/target" },
        ],
        { type: "human" },
        "interactive-command",
      ),
    ).resolves.toMatchObject({ settings: { target: { value: 1 } } });
  });

  it("uses the most specific path rule on segment boundaries", () => {
    const root = allowSettingsPath("", { add: ["session"] });
    const child = allowSettingsPath("/items/private", { add: ["human"] });
    expect(settingsRuleForPath([root, child], "/items/public")).toBe(root);
    expect(settingsRuleForPath([root, child], "/items/private/value")).toBe(child);
    expect(settingsRuleForPath([child], "/items/privateish")).toBeUndefined();
  });

  it("rejects parser normalization and cross-field failures", async () => {
    const normalizing = workflowSettings({
      initial: { value: "x" },
      parse: (value) => ({ value: String((value as { value: unknown }).value).trim() }),
      paths: [allowSettingsPath("/value", { replace: ["human"] })],
    });
    await expect(
      applyWorkflowSettingsPatch(
        normalizing,
        { value: "x" },
        [{ op: "replace", path: "/value", value: " y " }],
        { type: "human" },
        "interactive-command",
      ),
    ).rejects.toThrow(/without changing/);

    const guarded = workflowSettings({
      initial: { merge: "forbid" as const, items: [] as string[] },
      parse: parseSettings,
      paths: [allowSettingsPath("/merge", { replace: ["session"] })],
      validateChange: ({ before, after, actor }) => {
        if (actor.type === "session" && before.merge === "forbid" && after.merge === "allow") {
          throw new Error("session cannot grant merge authority");
        }
      },
    });
    await expect(
      applyWorkflowSettingsPatch(
        guarded,
        { merge: "forbid", items: [] },
        [{ op: "replace", path: "/merge", value: "allow" }],
        { type: "session" },
        "workflow-tool",
      ),
    ).rejects.toThrow(/cannot grant/);
  });

  it("rejects invalid settings and path declarations", () => {
    expect(() => workflowSettings({ initial: {}, parse: null as never, paths: [] })).toThrow(
      /parse must be a function/,
    );
    expect(() =>
      workflowSettings({ initial: {}, parse: (value) => value, paths: null as never }),
    ).toThrow(/paths must be an array/);
    expect(() =>
      workflowSettings({ initial: {}, parse: (value) => value, paths: [], description: " " }),
    ).toThrow(/description must not be empty/);
    expect(() =>
      workflowSettings({
        initial: {},
        parse: (value) => value,
        paths: [],
        validateChange: 1 as never,
      }),
    ).toThrow(/validateChange must be a function/);
    expect(() => allowSettingsPath("/x", {})).toThrow(/grants no permissions/);
    expect(() => allowSettingsPath("/x", { add: ["invalid" as "human"] })).toThrow(
      /Unknown workflow settings actor/,
    );
    expect(() => allowSettingsPath("/x", { unknown: ["human"] } as never)).toThrow(
      /Unknown workflow settings permission/,
    );
    expect(() =>
      workflowSettings({
        initial: {},
        parse: (value) => value,
        paths: [{ path: "/x", permissions: { unknown: ["human"] } } as never],
      }),
    ).toThrow(/Unknown workflow settings permission/);
    expect(() => allowSettingsPath("/x", { add: [] })).toThrow(/requires actors/);
    expect(() =>
      workflowSettings({
        initial: { x: 1 },
        parse: (value) => value as { x: number },
        paths: [
          allowSettingsPath("/x", { replace: ["human"] }),
          allowSettingsPath("/x", { replace: ["session"] }),
        ],
      }),
    ).toThrow(/Conflicting/);
  });

  it("marks settings routes as pure compute nodes", () => {
    const route = settingsRoute({ run: ({ settings }) => settings });
    expect(route).toMatchObject({ nodeType: "compute", settingsRoute: true });
  });
});
