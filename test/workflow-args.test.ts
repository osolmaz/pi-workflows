import { describe, expect, it } from "vitest";
import { parseWorkflowArgs } from "../src/extension/index.js";

describe("parseWorkflowArgs answer", () => {
  it("rejects an answer without an exact request id", () => {
    expect(() => parseWorkflowArgs('answer {"approved":true}')).toThrow(/requires/);
  });

  it("parses a request id followed by JSON", () => {
    expect(parseWorkflowArgs('answer request-123 {"approved":true}')).toEqual({
      kind: "answer",
      input: { approved: true },
      requestId: "request-123",
    });
  });

  it("parses text after the exact request id", () => {
    expect(parseWorkflowArgs("answer request-123 yes deploy it")).toEqual({
      kind: "answer",
      requestId: "request-123",
      input: { answer: "yes deploy it" },
    });
  });

  it("rejects malformed JSON rather than treating it as text", () => {
    expect(() => parseWorkflowArgs("answer request-123 {broken")).toThrow(/JSON/);
  });

  it("requires a value", () => {
    expect(() => parseWorkflowArgs("answer")).toThrow(/requires/);
  });

  it("parses status with an optional run id", () => {
    expect(parseWorkflowArgs("status")).toEqual({ kind: "status" });
    expect(parseWorkflowArgs("status run-123")).toEqual({ kind: "status", runId: "run-123" });
    expect(() => parseWorkflowArgs("status bad id")).toThrow(/valid run id/);
  });

  it("parses restored server commands", () => {
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
