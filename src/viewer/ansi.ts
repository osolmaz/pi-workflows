import { sanitizeText, stripAnsi } from "../workflows/text.js";

export { sanitizeText, stripAnsi };

/**
 * Colors are on for interactive terminals only, so piped output stays clean.
 * `NO_COLOR`/`PI_WORKFLOWS_NO_COLOR` force them off; `FORCE_COLOR` forces
 * them on. Evaluated per call so env changes (tests) take effect.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.PI_WORKFLOWS_NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true;
}

function wrap(code: string, text: string): string {
  return colorEnabled() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const ansi = {
  bold: (text: string) => wrap("1", text),
  dim: (text: string) => wrap("2", text),
  red: (text: string) => wrap("31", text),
  green: (text: string) => wrap("32", text),
  yellow: (text: string) => wrap("33", text),
  blue: (text: string) => wrap("34", text),
  magenta: (text: string) => wrap("35", text),
  cyan: (text: string) => wrap("36", text),
};

/** Visible length of a string, ignoring ANSI escape sequences. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** Truncate to a visible width, keeping ANSI sequences intact by stripping them first when needed. */
export function fitWidth(text: string, width: number): string {
  if (visibleLength(text) <= width) {
    return text;
  }
  const plain = stripAnsi(text);
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}
