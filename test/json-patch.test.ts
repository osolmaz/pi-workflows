import { describe, expect, it } from "vitest";
import {
  MAX_JSON_PATCH_BYTES,
  MAX_JSON_PATCH_OPERATIONS,
  MAX_JSON_POINTER_BYTES,
  applyJsonPatch,
  encodeJsonPointer,
  jsonPointerTarget,
  parseJsonPointer,
  validateJsonPatch,
} from "../src/workflows/json-patch.js";

const source = {
  name: "old",
  nested: { enabled: true, value: 1 },
  items: ["a", "b"],
};

describe("RFC 6901 JSON Pointer", () => {
  it("parses the root and escaped segments", () => {
    expect(parseJsonPointer("")).toEqual([]);
    expect(parseJsonPointer("/a~1b/~0key/")).toEqual(["a/b", "~key", ""]);
    expect(encodeJsonPointer(["a/b", "~key", ""])).toBe("/a~1b/~0key/");
  });

  it("rejects malformed and oversized pointers", () => {
    expect(() => parseJsonPointer("missing-slash")).toThrow(/Invalid JSON Pointer/);
    expect(() => parseJsonPointer("/bad~2escape")).toThrow(/Invalid JSON Pointer escape/);
    expect(() => parseJsonPointer(`/${"x".repeat(MAX_JSON_POINTER_BYTES + 1)}`)).toThrow(
      /cannot exceed/,
    );
  });

  it("reads only own properties", () => {
    expect(jsonPointerTarget({ constructor: "safe" }, "/constructor")).toEqual({
      exists: true,
      value: "safe",
    });
    expect(jsonPointerTarget({}, "/toString")).toEqual({ exists: false });
  });
});

describe("RFC 6902 JSON Patch", () => {
  it("applies add, remove, replace, copy, move, and test atomically", () => {
    const result = applyJsonPatch(source, [
      { op: "test", path: "/nested/enabled", value: true },
      { op: "replace", path: "/name", value: "new" },
      { op: "add", path: "/items/1", value: "inserted" },
      { op: "copy", from: "/nested", path: "/copy" },
      { op: "move", from: "/nested/value", path: "/moved" },
      { op: "remove", path: "/nested/enabled" },
    ]);

    expect(result).toEqual({
      name: "new",
      nested: {},
      items: ["a", "inserted", "b"],
      copy: { enabled: true, value: 1 },
      moved: 1,
    });
    expect(source).toEqual({
      name: "old",
      nested: { enabled: true, value: 1 },
      items: ["a", "b"],
    });
  });

  it("supports root replacement and array append", () => {
    expect(applyJsonPatch(source, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
    expect(applyJsonPatch({ items: [] }, [{ op: "add", path: "/items/-", value: "x" }])).toEqual({
      items: ["x"],
    });
  });

  it("uses post-removal indexes for moves in one array", () => {
    expect(applyJsonPatch(["a", "b", "c"], [{ op: "move", from: "/0", path: "/2" }])).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("deep-copies copied values", () => {
    const result = applyJsonPatch({ value: { n: 1 } }, [
      { op: "copy", from: "/value", path: "/copy" },
      { op: "replace", path: "/copy/n", value: 2 },
    ]);
    expect(result).toEqual({ value: { n: 1 }, copy: { n: 2 } });
  });

  it("keeps prototype-like keys as normal JSON properties", () => {
    const result = applyJsonPatch({}, [
      { op: "add", path: "/__proto__", value: { polluted: true } },
      { op: "add", path: "/constructor", value: "value" },
    ]) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ polluted: true });
    expect(result.constructor).toBe("value");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects failed tests without changing the source", () => {
    const value = { count: 1 };
    expect(() =>
      applyJsonPatch(value, [
        { op: "replace", path: "/count", value: 2 },
        { op: "test", path: "/count", value: 3 },
      ]),
    ).toThrow(/test failed/);
    expect(value).toEqual({ count: 1 });
  });

  it("rejects missing paths, invalid indexes, and invalid moves", () => {
    expect(() => applyJsonPatch(source, [{ op: "remove", path: "/missing" }])).toThrow(
      /does not exist/,
    );
    expect(() => applyJsonPatch(source, [{ op: "add", path: "/items/4", value: "x" }])).toThrow(
      /does not exist/,
    );
    expect(() => applyJsonPatch(source, [{ op: "add", path: "/items/01", value: "x" }])).toThrow(
      /array index/,
    );
    expect(() =>
      applyJsonPatch(source, [{ op: "move", from: "/nested", path: "/nested/new" }]),
    ).toThrow(/inside its source/);
    expect(() => applyJsonPatch(source, [{ op: "remove", path: "" }])).toThrow(/document root/);
  });

  it("rejects unknown fields, missing values, non-JSON values, and unknown operations", () => {
    expect(() => validateJsonPatch([{ op: "remove", path: "/name", extra: true }])).toThrow(
      /unknown field/,
    );
    expect(() => validateJsonPatch([{ op: "add", path: "/name" }])).toThrow(/requires value/);
    expect(() => validateJsonPatch([{ op: "add", path: "/name", value: undefined }])).toThrow(
      /not valid JSON/,
    );
    expect(() => validateJsonPatch([{ op: "increment", path: "/name" }])).toThrow(/Unknown/);
  });

  it("enforces operation, patch-byte, and result-byte limits at exact boundaries", () => {
    const exactCount = Array.from({ length: MAX_JSON_PATCH_OPERATIONS }, () => ({
      op: "test" as const,
      path: "",
      value: {},
    }));
    expect(validateJsonPatch(exactCount)).toHaveLength(MAX_JSON_PATCH_OPERATIONS);
    expect(() => validateJsonPatch([...exactCount, exactCount[0]])).toThrow(/more than/);

    const oversized = "x".repeat(MAX_JSON_PATCH_BYTES);
    expect(() => validateJsonPatch([{ op: "add", path: "/x", value: oversized }])).toThrow(
      /cannot exceed/,
    );
  });
});
