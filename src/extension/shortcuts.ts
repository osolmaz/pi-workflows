import fs from "node:fs";
import path from "node:path";
import { decisionConfigDir } from "../channels/config.js";
import { errorMessage } from "../workflows/errors.js";
import { PIW_SHORTCUT } from "./herdr-viewer.js";

/** Schema identifier of the optional scroll shortcut file. */
export const SHORTCUTS_SCHEMA = "pi-workflows.shortcuts.v1";
/** File name of the optional scroll shortcut file inside the config directory. */
export const SHORTCUTS_FILENAME = "shortcuts.json";

/** Resolved scroll shortcuts; `null` means the direction stays unregistered. */
export type ScrollShortcuts = {
  scrollUp: string | null;
  scrollDown: string | null;
};

/** Behavior with no configuration file, which is also the historical default. */
export const DEFAULT_SCROLL_SHORTCUTS: ScrollShortcuts = {
  scrollUp: "shift+up",
  scrollDown: "shift+down",
};

export type LoadedScrollShortcuts = {
  shortcuts: ScrollShortcuts;
  notices: string[];
  path: string;
};

/** Reads the shortcut file; injectable so tests never touch the real config directory. */
export type ShortcutReader = (filePath: string) => string;

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;

const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);

const SYMBOL_KEYS = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
]);

const SCROLL_FIELDS = ["scrollUp", "scrollDown"] as const;

// Pi lowercases a key identifier before matching, and spells these two keys in
// camel case. Keep the documented spelling so the widget hint stays readable.
const KEY_SPELLINGS: Record<string, string> = {
  pageup: "pageUp",
  pagedown: "pageDown",
};

type ScrollField = (typeof SCROLL_FIELDS)[number];

const FIELD_LABELS: Record<ScrollField, string> = {
  scrollUp: "scroll-up",
  scrollDown: "scroll-down",
};

function isKeyName(key: string): boolean {
  if (/^[a-z]$/.test(key)) return true;
  if (/^[0-9]$/.test(key)) return true;
  if (/^f([1-9]|1[0-2])$/.test(key)) return true;
  return SPECIAL_KEYS.has(key) || SYMBOL_KEYS.has(key);
}

/**
 * Normalize one shortcut to the canonical lowercase `modifier+key` form Pi
 * matches, or return `null` when Pi's documented key format rejects it.
 */
export function normalizeScrollShortcut(value: string): string | null {
  const parts = value.trim().toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length === 0) return null;
  if (!modifiers.every((modifier) => (MODIFIERS as readonly string[]).includes(modifier))) {
    return null;
  }
  if (!isKeyName(key)) return null;
  const unique = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  return [...unique, KEY_SPELLINGS[key] ?? key].join("+");
}

function splitShortcut(value: string): { modifiers: string[]; key: string } {
  const parts = value.split("+");
  return { modifiers: parts.slice(0, -1), key: parts[parts.length - 1] ?? "" };
}

/**
 * Label for the widget controls line. Both directions share one arrow hint when
 * they use the same modifiers and the up/down arrows, and are listed in full
 * otherwise. `undefined` means scrolling is off in both directions.
 */
export function scrollShortcutHint(shortcuts: ScrollShortcuts): string | undefined {
  const { scrollUp, scrollDown } = shortcuts;
  if (scrollUp === null && scrollDown === null) return undefined;
  if (scrollUp === null) return scrollDown ?? undefined;
  if (scrollDown === null) return scrollUp;
  const up = splitShortcut(scrollUp);
  const down = splitShortcut(scrollDown);
  if (
    up.key === "up" &&
    down.key === "down" &&
    up.modifiers.join("+") === down.modifiers.join("+")
  ) {
    return `${up.modifiers.join("+")}+↑/↓ scroll`;
  }
  return `${scrollUp} · ${scrollDown}`;
}

function shortcutPath(configDir: string): string {
  return path.join(configDir, SHORTCUTS_FILENAME);
}

function unregistered(filePath: string, problem: string): LoadedScrollShortcuts {
  return {
    shortcuts: { scrollUp: null, scrollDown: null },
    notices: [
      `pi-workflows: ${problem}. The scroll shortcuts stay unregistered until ${filePath} is fixed.`,
    ],
    path: filePath,
  };
}

/**
 * Read the optional scroll shortcut configuration. A missing file keeps the
 * defaults, a broken file registers nothing, and a broken field unregisters
 * only that direction. A failure never falls back to a default.
 */
export function loadScrollShortcuts(
  options: { configDir?: string; read?: ShortcutReader } = {},
): LoadedScrollShortcuts {
  const configDir = options.configDir ?? decisionConfigDir();
  const filePath = shortcutPath(configDir);
  const read = options.read ?? ((target: string) => fs.readFileSync(target, "utf8"));

  let raw: string;
  try {
    raw = read(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { shortcuts: { ...DEFAULT_SCROLL_SHORTCUTS }, notices: [], path: filePath };
    }
    return unregistered(filePath, `cannot read ${filePath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return unregistered(filePath, `${filePath} is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unregistered(filePath, `${filePath} must hold a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (!("schema" in record)) {
    return unregistered(filePath, `${filePath} is missing the schema field ${SHORTCUTS_SCHEMA}`);
  }
  if (record.schema !== SHORTCUTS_SCHEMA) {
    return unregistered(
      filePath,
      `${filePath} declares schema ${JSON.stringify(record.schema)}, expected ${SHORTCUTS_SCHEMA}`,
    );
  }

  const shortcuts: ScrollShortcuts = { ...DEFAULT_SCROLL_SHORTCUTS };
  const notices: string[] = [];
  for (const field of SCROLL_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value === null) {
      shortcuts[field] = null;
      continue;
    }
    const normalized = typeof value === "string" ? normalizeScrollShortcut(value) : null;
    if (normalized === null) {
      shortcuts[field] = null;
      notices.push(
        `pi-workflows: ${filePath} sets ${field} to ${JSON.stringify(value)}, which is not a documented Pi key id. The ${FIELD_LABELS[field]} shortcut stays unregistered.`,
      );
      continue;
    }
    if (normalized === PIW_SHORTCUT) {
      shortcuts[field] = null;
      notices.push(
        `pi-workflows: ${filePath} sets ${field} to ${normalized}, which is reserved for /piw. The ${FIELD_LABELS[field]} shortcut stays unregistered.`,
      );
      continue;
    }
    shortcuts[field] = normalized;
  }

  if (shortcuts.scrollUp !== null && shortcuts.scrollUp === shortcuts.scrollDown) {
    notices.push(
      `pi-workflows: ${filePath} sets scrollUp and scrollDown to the same key ${shortcuts.scrollUp}. Only the scroll-up shortcut stays registered.`,
    );
    shortcuts.scrollDown = null;
  }

  return { shortcuts, notices, path: filePath };
}
