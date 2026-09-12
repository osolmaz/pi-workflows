import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCROLL_SHORTCUTS,
  loadScrollShortcuts,
  normalizeScrollShortcut,
  scrollShortcutHint,
  SHORTCUTS_FILENAME,
  SHORTCUTS_SCHEMA,
} from "../src/extension/shortcuts.js";
import { makeTempDir } from "./helpers.js";

async function makeConfigDir(): Promise<string> {
  return await makeTempDir("pi-workflows-shortcuts");
}

function readerFor(content: string): () => string {
  return () => content;
}

function configText(value: unknown): string {
  return JSON.stringify(value);
}

describe("loadScrollShortcuts", () => {
  it("keeps the defaults when the file is absent", async () => {
    const configDir = await makeConfigDir();
    const loaded = loadScrollShortcuts({ configDir });

    expect(loaded.shortcuts).toEqual(DEFAULT_SCROLL_SHORTCUTS);
    expect(loaded.notices).toEqual([]);
    expect(loaded.path).toBe(path.join(configDir, SHORTCUTS_FILENAME));
  });

  it("reads a remap from the config directory", async () => {
    const configDir = await makeConfigDir();
    await fs.writeFile(
      loadedPath(configDir),
      configText({
        schema: SHORTCUTS_SCHEMA,
        scrollUp: "ctrl+alt+up",
        scrollDown: "ctrl+alt+down",
      }),
    );

    const loaded = loadScrollShortcuts({ configDir });

    expect(loaded.shortcuts).toEqual({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" });
    expect(loaded.notices).toEqual([]);
  });

  it("keeps the default of an omitted field and normalizes the other", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollUp: "Alt+Ctrl+PageUp" })),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: "ctrl+alt+pageUp", scrollDown: "shift+down" });
    expect(loaded.notices).toEqual([]);
  });

  it("removes one direction with null", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollUp: null })),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: "shift+down" });
    expect(loaded.notices).toEqual([]);
  });

  it("removes both directions with null", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollUp: null, scrollDown: null })),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
    expect(loaded.notices).toEqual([]);
  });

  it("ignores unknown fields", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollLeft: "ctrl+left" })),
    });

    expect(loaded.shortcuts).toEqual(DEFAULT_SCROLL_SHORTCUTS);
    expect(loaded.notices).toEqual([]);
  });

  it("registers nothing when the file is not valid JSON", () => {
    const loaded = loadScrollShortcuts({ configDir: "/tmp/config", read: readerFor("{ oops") });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
    expect(loaded.notices).toHaveLength(1);
    expect(loaded.notices[0]).toMatch(
      /^pi-workflows: \/tmp\/config\/shortcuts\.json is not valid JSON: /,
    );
    expect(loaded.notices[0]).toContain(
      "The scroll shortcuts stay unregistered until /tmp/config/shortcuts.json is fixed.",
    );
  });

  it("registers nothing when the file is not an object", () => {
    for (const content of ["[]", '"scrollUp"', "42", "null"]) {
      const loaded = loadScrollShortcuts({ configDir: "/tmp/config", read: readerFor(content) });
      expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
      expect(loaded.notices).toEqual([
        `pi-workflows: /tmp/config/shortcuts.json must hold a JSON object. The scroll shortcuts stay unregistered until /tmp/config/shortcuts.json is fixed.`,
      ]);
    }
  });

  it("registers nothing when the schema field is missing", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ scrollUp: "ctrl+alt+up" })),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
    expect(loaded.notices).toEqual([
      `pi-workflows: /tmp/config/shortcuts.json is missing the schema field ${SHORTCUTS_SCHEMA}. The scroll shortcuts stay unregistered until /tmp/config/shortcuts.json is fixed.`,
    ]);
  });

  it("registers nothing when the schema is unknown", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(configText({ schema: "pi-workflows.shortcuts.v2", scrollUp: "ctrl+alt+up" })),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
    expect(loaded.notices).toEqual([
      `pi-workflows: /tmp/config/shortcuts.json declares schema "pi-workflows.shortcuts.v2", expected ${SHORTCUTS_SCHEMA}. The scroll shortcuts stay unregistered until /tmp/config/shortcuts.json is fixed.`,
    ]);
  });

  it("unregisters only the field with an unsupported value", () => {
    const cases: Array<{ value: unknown; rendered: string }> = [
      { value: "meta+up", rendered: '"meta+up"' },
      { value: "shift+banana", rendered: '"shift+banana"' },
      { value: "up", rendered: '"up"' },
      { value: "shift+f13", rendered: '"shift+f13"' },
      { value: 42, rendered: "42" },
      { value: true, rendered: "true" },
    ];

    for (const testCase of cases) {
      const loaded = loadScrollShortcuts({
        configDir: "/tmp/config",
        read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollUp: testCase.value })),
      });

      expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: "shift+down" });
      expect(loaded.notices).toEqual([
        `pi-workflows: /tmp/config/shortcuts.json sets scrollUp to ${testCase.rendered}, which is not a documented Pi key id. The scroll-up shortcut stays unregistered.`,
      ]);
    }
  });

  it("rejects the shortcut reserved for the workflow viewer", () => {
    for (const value of ["ctrl+shift+r", "shift+ctrl+r", "CTRL+SHIFT+R"]) {
      const loaded = loadScrollShortcuts({
        configDir: "/tmp/config",
        read: readerFor(configText({ schema: SHORTCUTS_SCHEMA, scrollDown: value })),
      });

      expect(loaded.shortcuts).toEqual({ scrollUp: "shift+up", scrollDown: null });
      expect(loaded.notices).toEqual([
        "pi-workflows: /tmp/config/shortcuts.json sets scrollDown to ctrl+shift+r, which is reserved for /piw. The scroll-down shortcut stays unregistered.",
      ]);
    }
  });

  it("keeps only the scroll-up direction when both directions repeat one key", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(
        configText({ schema: SHORTCUTS_SCHEMA, scrollUp: "ctrl+up", scrollDown: "ctrl+up" }),
      ),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: "ctrl+up", scrollDown: null });
    expect(loaded.notices).toEqual([
      "pi-workflows: /tmp/config/shortcuts.json sets scrollUp and scrollDown to the same key ctrl+up. Only the scroll-up shortcut stays registered.",
    ]);
  });

  it("sets the duplicate key aside when the other field is already invalid", () => {
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: readerFor(
        configText({ schema: SHORTCUTS_SCHEMA, scrollUp: "ctrl+up", scrollDown: "ctrl+up+up" }),
      ),
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: "ctrl+up", scrollDown: null });
    expect(loaded.notices).toHaveLength(1);
    expect(loaded.notices[0]).toContain('sets scrollDown to "ctrl+up+up"');
  });

  it("registers nothing when the file cannot be read", () => {
    const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const loaded = loadScrollShortcuts({
      configDir: "/tmp/config",
      read: () => {
        throw failure;
      },
    });

    expect(loaded.shortcuts).toEqual({ scrollUp: null, scrollDown: null });
    expect(loaded.notices).toEqual([
      "pi-workflows: cannot read /tmp/config/shortcuts.json: EACCES: permission denied. The scroll shortcuts stay unregistered until /tmp/config/shortcuts.json is fixed.",
    ]);
  });
});

describe("normalizeScrollShortcut", () => {
  it("accepts the documented key format", () => {
    const accepted = [
      "shift+up",
      "ctrl+alt+down",
      "super+k",
      "ctrl+1",
      "alt+f12",
      "ctrl+space",
      "ctrl+[",
      "shift+pageup",
      "Ctrl+Shift+X",
    ];

    expect(accepted.map((value) => normalizeScrollShortcut(value))).toEqual([
      "shift+up",
      "ctrl+alt+down",
      "super+k",
      "ctrl+1",
      "alt+f12",
      "ctrl+space",
      "ctrl+[",
      "shift+pageUp",
      "ctrl+shift+x",
    ]);
  });

  it("rejects a missing modifier, an unknown modifier, and an unknown key", () => {
    expect(normalizeScrollShortcut("up")).toBeNull();
    expect(normalizeScrollShortcut("meta+up")).toBeNull();
    expect(normalizeScrollShortcut("shift+f13")).toBeNull();
    expect(normalizeScrollShortcut("shift+banana")).toBeNull();
    expect(normalizeScrollShortcut("shift+")).toBeNull();
    expect(normalizeScrollShortcut("ctrl++up")).toBeNull();
  });
});

describe("scrollShortcutHint", () => {
  it("renders the shared modifier prefix with both arrows", () => {
    expect(scrollShortcutHint(DEFAULT_SCROLL_SHORTCUTS)).toBe("shift+↑/↓ scroll");
    expect(scrollShortcutHint({ scrollUp: "ctrl+alt+up", scrollDown: "ctrl+alt+down" })).toBe(
      "ctrl+alt+↑/↓ scroll",
    );
  });

  it("lists both keys when the modifiers differ", () => {
    expect(scrollShortcutHint({ scrollUp: "ctrl+up", scrollDown: "alt+down" })).toBe(
      "ctrl+up · alt+down",
    );
    expect(scrollShortcutHint({ scrollUp: "shift+down", scrollDown: "shift+up" })).toBe(
      "shift+down · shift+up",
    );
    expect(scrollShortcutHint({ scrollUp: "shift+pageUp", scrollDown: "shift+pageDown" })).toBe(
      "shift+pageUp · shift+pageDown",
    );
  });

  it("renders one key alone when one direction is enabled", () => {
    expect(scrollShortcutHint({ scrollUp: "ctrl+alt+up", scrollDown: null })).toBe("ctrl+alt+up");
    expect(scrollShortcutHint({ scrollUp: null, scrollDown: "ctrl+alt+down" })).toBe(
      "ctrl+alt+down",
    );
  });

  it("renders nothing when both directions are off", () => {
    expect(scrollShortcutHint({ scrollUp: null, scrollDown: null })).toBeUndefined();
  });
});

function loadedPath(configDir: string): string {
  return path.join(configDir, SHORTCUTS_FILENAME);
}
