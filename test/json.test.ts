import { describe, expect, it } from "vitest";
import { extractJsonValue, parseJsonValue, parseStrictJsonValue } from "../src/workflows/json.js";

describe("parseJsonValue", () => {
  it("parses direct JSON objects", () => {
    expect(parseJsonValue(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("parses direct JSON arrays", () => {
    expect(parseJsonValue(`[1,2]`)).toEqual([1, 2]);
  });

  it("throws on empty text", () => {
    expect(() => parseJsonValue("")).toThrow(/empty text/);
    expect(() => parseJsonValue("   ")).toThrow(/empty text/);
  });

  it("parses fenced JSON blocks", () => {
    const text = 'Here you go:\n```json\n{"route":"y"}\n```\nthanks';
    expect(parseJsonValue(text, { mode: "fenced" })).toEqual({ route: "y" });
  });

  it("parses fenced blocks without a language tag", () => {
    const text = '```\n{"route":"n"}\n```';
    expect(parseJsonValue(text, { mode: "fenced" })).toEqual({ route: "n" });
  });

  it("rejects embedded JSON in strict mode", () => {
    expect(() => parseStrictJsonValue(`prefix {"a":1}`)).toThrow(/Could not parse JSON/);
  });

  it("rejects fenced JSON in strict mode", () => {
    expect(() => parseStrictJsonValue("```json\n{}\n```")).toThrow(/Could not parse JSON/);
  });

  it("extracts balanced embedded objects in compat mode", () => {
    expect(
      extractJsonValue(`The answer is {"route":"continue","reason":"clear"} as shown`),
    ).toEqual({
      route: "continue",
      reason: "clear",
    });
  });

  it("handles strings containing braces inside embedded JSON", () => {
    expect(extractJsonValue(`x {"text":"a } inside","n":1} y`)).toEqual({
      text: "a } inside",
      n: 1,
    });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJsonValue(String.raw`noise {"text":"quote \" and {"} tail`)).toEqual({
      text: 'quote " and {',
    });
  });

  it("skips unbalanced candidates and finds later valid ones", () => {
    expect(extractJsonValue(`{oops] then {"ok":true}`)).toEqual({ ok: true });
  });

  it("throws when no JSON can be found", () => {
    expect(() => extractJsonValue("just prose")).toThrow(/Could not parse JSON/);
  });

  it("ignores fenced blocks without closing fence", () => {
    expect(() => parseJsonValue('```json\n{"a":1}', { mode: "fenced" })).toThrow(
      /Could not parse JSON/,
    );
  });
});
