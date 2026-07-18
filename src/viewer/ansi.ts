const COLOR_ENABLED =
  process.env.NO_COLOR === undefined && process.env.PI_WORKFLOWS_NO_COLOR === undefined;

function wrap(code: string, text: string): string {
  return COLOR_ENABLED ? `\u001b[${code}m${text}\u001b[0m` : text;
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

export function stripAnsi(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b" && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && !/[A-Za-z]/.test(text[index] as string)) {
        index += 1;
      }
      index += 1;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

/** Truncate to a visible width, keeping ANSI sequences intact by stripping them first when needed. */
export function fitWidth(text: string, width: number): string {
  if (visibleLength(text) <= width) {
    return text;
  }
  const plain = stripAnsi(text);
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}
