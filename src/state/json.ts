export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function parseJson(text: string): JsonValue {
  return normalizeJson(JSON.parse(text) as unknown);
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Only plain objects can be stored as canonical JSON");
    }
    const input = value as Record<string, unknown>;
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item === undefined) {
        continue;
      }
      output[key] = normalizeJson(item);
    }
    return output;
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`);
}
