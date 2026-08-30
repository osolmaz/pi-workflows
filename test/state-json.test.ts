import { describe, expect, it } from "vitest";
import { canonicalJson, parseJson } from "../src/state/json.js";

describe("canonical state JSON", () => {
  it("normalizes numeric and object edge cases", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ z: 1, omitted: undefined, a: 2 })).toBe('{"a":2,"z":1}');
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2 });
    expect(canonicalJson(nullPrototype)).toBe('{"b":2}');
  });

  it("rejects values that durable JSON cannot represent", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("JSON numbers must be finite");
    expect(() => canonicalJson(new Date(0))).toThrow(
      "Only plain objects can be stored as canonical JSON",
    );
    expect(() => canonicalJson(undefined)).toThrow("Unsupported JSON value type: undefined");
    expect(() => canonicalJson([undefined])).toThrow("Unsupported JSON value type: undefined");
  });

  it("normalizes parsed values through the same path", () => {
    expect(parseJson('{"b":2,"a":1}')).toEqual({ a: 1, b: 2 });
  });
});
