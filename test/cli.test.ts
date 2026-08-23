import { describe, expect, it } from "vitest";
import { main, parseCliArgs } from "../src/viewer/cli.js";

describe("pi-workflows CLI", () => {
  it("parses the fixed-database viewer contract", () => {
    expect(parseCliArgs(["view", "run-1", "--once"])).toEqual({
      command: "view",
      runId: "run-1",
      once: true,
      json: false,
    });
    expect(parseCliArgs(["runs"])).toEqual({ command: "runs", once: false, json: false });
  });

  it("does not accept old storage path options", () => {
    expect(() => parseCliArgs(["runs", "--dir", "/tmp/runs"])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(["controllers", "--controller-dir", "/tmp/controllers"])).toThrow(
      /Unknown argument/,
    );
  });

  it("parses state maintenance commands", () => {
    expect(parseCliArgs(["state", "verify"])).toEqual({
      command: "state",
      stateAction: "verify",
      once: false,
      json: false,
    });
    expect(parseCliArgs(["state", "backup", "/tmp/state-backup.sqlite"])).toMatchObject({
      command: "state",
      stateAction: "backup",
      backupDestination: "/tmp/state-backup.sqlite",
    });
  });

  it("parses controller and host commands", () => {
    expect(parseCliArgs(["controller", "jobs", "one"])).toMatchObject({
      command: "controller",
      controllerName: "jobs",
      resourceKey: "one",
    });
    expect(parseCliArgs(["host", "--project", "/tmp/project", "--", "--model", "test"])).toEqual({
      command: "host",
      once: false,
      json: false,
      project: "/tmp/project",
      piArgs: ["--model", "test"],
    });
  });

  it("prints help", async () => {
    expect(await main(["--help"])).toBe(0);
  });

  it("rejects unknown commands", async () => {
    expect(await main(["unknown"])).toBe(2);
  });
});
