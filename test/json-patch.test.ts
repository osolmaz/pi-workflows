import { describe, expect, it } from "vitest";
import {
  MAX_JSON_PATCH_BYTES,
  MAX_JSON_PATCH_OPERATIONS,
  MAX_JSON_POINTER_BYTES,
  applyJsonPatch,
  cloneJson,
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
    expect(() => parseJsonPointer(5 as never)).toThrow(/must be a string/);
    expect(() => parseJsonPointer("missing-slash")).toThrow(/Invalid JSON Pointer/);
    expect(() => parseJsonPointer("/bad~2escape")).toThrow(/Invalid JSON Pointer escape/);
    expect(() => parseJsonPointer(`/${"x".repeat(MAX_JSON_POINTER_BYTES + 1)}`)).toThrow(
      /cannot exceed/,
    );
  });

  it("reads roots, arrays, primitives, and only own properties", () => {
    expect(encodeJsonPointer([])).toBe("");
    expect(jsonPointerTarget({ value: 1 }, "")).toEqual({
      exists: true,
      value: { value: 1 },
    });
    expect(jsonPointerTarget(["a"], "/1")).toEqual({ exists: false });
    expect(jsonPointerTarget({ value: 1 }, "/value/child")).toEqual({ exists: false });
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

  it("supports root operations and array append", () => {
    expect(applyJsonPatch(source, [{ op: "add", path: "", value: [0] }])).toEqual([0]);
    expect(applyJsonPatch(source, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
    expect(applyJsonPatch({ a: 1 }, [{ op: "test", path: "", value: { a: 1 } }])).toEqual({
      a: 1,
    });
    expect(applyJsonPatch({ a: 1 }, [{ op: "copy", from: "", path: "/copy" }])).toEqual({
      a: 1,
      copy: { a: 1 },
    });
    expect(applyJsonPatch({ items: [] }, [{ op: "add", path: "/items/-", value: "x" }])).toEqual({
      items: ["x"],
    });
  });

  it("uses post-removal indexes and handles same-path and root moves", () => {
    expect(applyJsonPatch(["a", "b", "c"], [{ op: "move", from: "/0", path: "/2" }])).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(applyJsonPatch({ a: 1 }, [{ op: "move", from: "/a", path: "/a" }])).toEqual({ a: 1 });
    expect(() => applyJsonPatch({ a: 1 }, [{ op: "move", from: "", path: "/a" }])).toThrow(
      /document root/,
    );
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
    expect(() => applyJsonPatch(source, [{ op: "replace", path: "/items/2", value: "x" }])).toThrow(
      /does not exist/,
    );
    expect(() => applyJsonPatch(source, [{ op: "replace", path: "/missing", value: "x" }])).toThrow(
      /does not exist/,
    );
    expect(() => applyJsonPatch({ value: 1 }, [{ op: "add", path: "/value/x", value: 2 }])).toThrow(
      /does not exist/,
    );
    expect(() => applyJsonPatch({ items: [] }, [{ op: "remove", path: "/items/0" }])).toThrow(
      /does not exist/,
    );
    expect(() =>
      applyJsonPatch({ items: [1] }, [{ op: "copy", from: "/items/1", path: "/x" }]),
    ).toThrow(/does not exist/);
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
    expect(() => validateJsonPatch([null])).toThrow(/must contain string op and path/);
    expect(() => validateJsonPatch([{ op: "copy", path: "/x", from: 1 }])).toThrow(
      /requires string from/,
    );
    expect(() => validateJsonPatch([{ op: "copy", path: "/x", from: "/bad~2" }])).toThrow(
      /Invalid JSON Pointer escape/,
    );
  });

  it("clones JSON values safely and rejects unsupported values", () => {
    expect(cloneJson(null)).toBeNull();
    expect(cloneJson("x")).toBe("x");
    expect(cloneJson(true)).toBe(true);
    expect(Object.is(cloneJson(-0), -0)).toBe(false);
    expect(() => cloneJson(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => cloneJson(new Date() as never)).toThrow(/only JSON values/);
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
    expect(() =>
      applyJsonPatch({ large: "x".repeat(140 * 1024) }, [
        { op: "copy", from: "/large", path: "/copy" },
      ]),
    ).toThrow(/result cannot exceed/);
  });
});
