import { describe, expect, it } from "vitest";
import { parseResourceManagerArgs, parseWorkflowArgs } from "../src/extension/index.js";

describe("parseResourceManagerArgs", () => {
  it("parses resource manager commands", () => {
    expect(parseResourceManagerArgs("")).toEqual({ kind: "list" });
    expect(parseResourceManagerArgs("list")).toEqual({ kind: "list" });
    expect(parseResourceManagerArgs("get sample one")).toEqual({
      kind: "get",
      resourceManager: "sample",
      key: "one",
    });
    expect(parseResourceManagerArgs('apply sample one {"enabled":true}')).toEqual({
      kind: "apply",
      resourceManager: "sample",
      key: "one",
      spec: { enabled: true },
    });
    expect(parseResourceManagerArgs("reconcile sample one")).toEqual({
      kind: "reconcile",
      resourceManager: "sample",
      key: "one",
    });
    expect(parseResourceManagerArgs("delete sample one")).toEqual({
      kind: "delete",
      resourceManager: "sample",
      key: "one",
    });
  });

  it("rejects embedded-host controls and malformed apply specs", () => {
    expect(() => parseResourceManagerArgs("start")).toThrow(/Usage/u);
    expect(() => parseResourceManagerArgs("stop")).toThrow(/Usage/u);
    expect(() => parseResourceManagerArgs("apply sample one {broken")).toThrow(
      /Invalid resource manager spec JSON/u,
    );
  });
});

describe("parseWorkflowArgs", () => {
  it("lists on empty args", () => {
    expect(parseWorkflowArgs("")).toEqual({ kind: "list" });
    expect(parseWorkflowArgs("   ")).toEqual({ kind: "list" });
  });

  it("parses cancel, pause, and resume", () => {
    expect(parseWorkflowArgs("cancel")).toEqual({ kind: "cancel" });
    expect(parseWorkflowArgs("cancel run-123")).toEqual({
      kind: "cancel",
      runId: "run-123",
    });
    expect(parseWorkflowArgs("pause")).toEqual({ kind: "pause" });
    expect(parseWorkflowArgs("resume")).toEqual({ kind: "resume" });
  });

  it("rejects an invalid cancel run id", () => {
    expect(() => parseWorkflowArgs("cancel two ids")).toThrow(/one valid run id/u);
  });

  it("parses a bare workflow ref", () => {
    expect(parseWorkflowArgs("echo")).toEqual({ kind: "run", ref: "echo", input: {} });
  });

  it("treats trailing text as the task input", () => {
    expect(parseWorkflowArgs("autoimplement fix the flaky test")).toEqual({
      kind: "run",
      ref: "autoimplement",
      input: { task: "fix the flaky test" },
    });
  });

  it("parses --input-json", () => {
    expect(parseWorkflowArgs(`branch --input-json {"task":"x"}`)).toEqual({
      kind: "run",
      ref: "branch",
      input: { task: "x" },
    });
  });

  it("rejects --input-json without a value", () => {
    expect(() => parseWorkflowArgs("branch --input-json")).toThrow(/requires a JSON value/);
  });

  it("rejects malformed --input-json", () => {
    expect(() => parseWorkflowArgs("branch --input-json {broken")).toThrow();
  });

  it("treats task text starting with --input-json as plain text", () => {
    expect(parseWorkflowArgs("echo --input-jsonschema help")).toEqual({
      kind: "run",
      ref: "echo",
      input: { task: "--input-jsonschema help" },
    });
  });

  it("supports path refs", () => {
    expect(parseWorkflowArgs("./examples/workflows/echo.workflow.ts hello")).toEqual({
      kind: "run",
      ref: "./examples/workflows/echo.workflow.ts",
      input: { task: "hello" },
    });
  });
});
