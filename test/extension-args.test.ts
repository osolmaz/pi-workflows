import { describe, expect, it } from "vitest";
import { parseControllerArgs, parseWorkflowArgs } from "../src/extension/index.js";

describe("parseControllerArgs", () => {
  it("parses hosted controller commands", () => {
    expect(parseControllerArgs("")).toEqual({ kind: "list" });
    expect(parseControllerArgs("list")).toEqual({ kind: "list" });
    expect(parseControllerArgs("get sample one")).toEqual({
      kind: "get",
      controller: "sample",
      key: "one",
    });
    expect(parseControllerArgs('apply sample one {"enabled":true}')).toEqual({
      kind: "apply",
      controller: "sample",
      key: "one",
      spec: { enabled: true },
    });
    expect(parseControllerArgs("reconcile sample one")).toEqual({
      kind: "reconcile",
      controller: "sample",
      key: "one",
    });
    expect(parseControllerArgs("delete sample one")).toEqual({
      kind: "delete",
      controller: "sample",
      key: "one",
    });
  });

  it("rejects embedded-host controls and malformed apply specs", () => {
    expect(() => parseControllerArgs("start")).toThrow(/Usage/u);
    expect(() => parseControllerArgs("stop")).toThrow(/Usage/u);
    expect(() => parseControllerArgs("apply sample one {broken")).toThrow(
      /Invalid controller spec JSON/u,
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
