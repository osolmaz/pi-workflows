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

  it("parses status with an optional run id", () => {
    expect(parseWorkflowArgs("status")).toEqual({ kind: "status" });
    expect(parseWorkflowArgs("status run-123")).toEqual({ kind: "status", runId: "run-123" });
    expect(() => parseWorkflowArgs("status bad id")).toThrow(/valid run id/);
  });

  it("parses restored hosted commands", () => {
    expect(parseWorkflowArgs("restart run-1")).toEqual({ kind: "restart", runId: "run-1" });
    expect(
      parseWorkflowArgs('change-settings [{"op":"replace","path":"/mode","value":"safe"}]'),
    ).toEqual({
      kind: "change-settings",
      patch: [{ op: "replace", path: "/mode", value: "safe" }],
    });
    expect(parseWorkflowArgs("queue-follow-up Run the release checks.")).toEqual({
      kind: "queue-follow-up",
      prompt: "Run the release checks.",
    });
    const followUpId = `follow-up-${"a".repeat(40)}`;
    expect(parseWorkflowArgs(`remove-follow-up ${followUpId}`)).toEqual({
      kind: "remove-follow-up",
      followUpId,
    });
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
