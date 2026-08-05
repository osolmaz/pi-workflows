import { describe, expect, it } from "vitest";
import { parseWorkflowArgs } from "../src/extension/index.js";

describe("parseWorkflowArgs answer", () => {
  it("parses plain JSON answers", () => {
    expect(parseWorkflowArgs('answer {"approved":true}')).toEqual({
      kind: "answer",
      input: { approved: true },
    });
  });

  it("parses a run id followed by JSON", () => {
    expect(parseWorkflowArgs('answer run-123 {"approved":true}')).toEqual({
      kind: "answer",
      input: { approved: true },
      runId: "run-123",
    });
  });

  it("treats bare text as a text answer, not a run id", () => {
    expect(parseWorkflowArgs("answer yes deploy it")).toEqual({
      kind: "answer",
      input: { answer: "yes deploy it" },
    });
  });

  it("requires valid JSON when a run id is given", () => {
    expect(() => parseWorkflowArgs("answer run-123 {broken")).toThrow(/JSON/);
  });

  it("requires a value", () => {
    expect(() => parseWorkflowArgs("answer")).toThrow(/requires/);
  });

  it("parses --input-json for runs", () => {
    expect(parseWorkflowArgs('mini --input-json {"task":"hi"}')).toEqual({
      kind: "run",
      ref: "mini",
      input: { task: "hi" },
    });
    expect(() => parseWorkflowArgs("mini --input-json")).toThrow(/requires a JSON value/);
    expect(parseWorkflowArgs("mini --input-jsonschema help")).toEqual({
      kind: "run",
      ref: "mini",
      input: { task: "--input-jsonschema help" },
    });
  });
});
