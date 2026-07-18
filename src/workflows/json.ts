export type JsonParseMode = "strict" | "fenced" | "compat";

type ParseAttempt = { ok: true; value: unknown } | { ok: false };

/**
 * Parse a JSON value out of model text. `strict` requires the whole text to
 * be JSON. `fenced` additionally accepts a ```json fenced block. `compat`
 * (the default) also scans for the first balanced JSON object or array
 * embedded in chatty output.
 */
export function parseJsonValue(text: string, options: { mode?: JsonParseMode } = {}): unknown {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    throw new Error("Expected JSON output, got empty text");
  }
  const mode = options.mode ?? "compat";

  const direct = tryParse(trimmed);
  if (direct.ok) {
    return direct.value;
  }

  if (mode === "fenced" || mode === "compat") {
    const fencedText = extractFencedJsonText(trimmed);
    if (fencedText !== null) {
      const fenced = tryParse(fencedText);
      if (fenced.ok) {
        return fenced.value;
      }
    }
  }

  if (mode === "compat") {
    for (const candidate of extractBalancedJsonCandidates(trimmed)) {
      const parsed = tryParse(candidate);
      if (parsed.ok) {
        return parsed.value;
      }
    }
  }

  throw new Error(`Could not parse JSON from text:\n${trimmed}`);
}

/** Strict parse: the whole text must be a JSON value. */
export function parseStrictJsonValue(text: string): unknown {
  return parseJsonValue(text, { mode: "strict" });
}

/** Default tolerant parser: direct JSON, then fenced, then embedded object. */
export function extractJsonValue(text: string): unknown {
  return parseJsonValue(text, { mode: "compat" });
}

function tryParse(text: string): ParseAttempt {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function extractFencedJsonText(text: string): string | null {
  const openingFenceIndex = text.indexOf("```");
  if (openingFenceIndex === -1) {
    return null;
  }

  let contentStart = openingFenceIndex + 3;
  if (
    text.slice(contentStart, contentStart + 4).toLowerCase() === "json" &&
    isFenceWhitespace(text[contentStart + 4])
  ) {
    contentStart += 4;
  }
  while (isFenceWhitespace(text[contentStart])) {
    contentStart += 1;
  }

  const closingFenceIndex = text.indexOf("```", contentStart);
  if (closingFenceIndex === -1) {
    return null;
  }
  return text.slice(contentStart, closingFenceIndex).trim();
}

function isFenceWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") {
      continue;
    }
    const candidate = scanBalanced(text, index);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function scanBalanced(text: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index] as string;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }

    const open = stack.at(-1);
    const matches = (open === "{" && char === "}") || (open === "[" && char === "]");
    if (!matches) {
      return null;
    }
    stack.pop();
    if (stack.length === 0) {
      return text.slice(startIndex, index + 1);
    }
  }

  return null;
}
