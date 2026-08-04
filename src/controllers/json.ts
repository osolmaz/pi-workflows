import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export function assertJsonValue(value: unknown, description: string): asserts value is JsonValue {
  normalizeJson(value, description, new Set());
}

export function canonicalJson(value: unknown, description = "value"): string {
  return JSON.stringify(normalizeJson(value, description, new Set()));
}

export function jsonFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseStoredJson<T>(value: string, description: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${description} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertJsonValue(parsed, description);
  return parsed as T;
}

function normalizeJson(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} is not JSON-serializable`);
  }
  if (seen.has(value)) {
    throw new Error(`${path} contains a cycle`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJson(item, `${path}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain objects and arrays`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalizeJson((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
