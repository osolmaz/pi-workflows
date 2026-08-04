import { describe, expect, it } from "vitest";
import { parseControllerArgs } from "../src/extension/controller-host.js";

describe("parseControllerArgs", () => {
  it("parses list and worker controls", () => {
    expect(parseControllerArgs("")).toEqual({ kind: "list" });
    expect(parseControllerArgs("list")).toEqual({ kind: "list" });
    expect(parseControllerArgs("start")).toEqual({ kind: "start" });
    expect(parseControllerArgs("stop")).toEqual({ kind: "stop" });
  });

  it("parses resource commands", () => {
    expect(parseControllerArgs("get demo item-1")).toEqual({
      kind: "get",
      controller: "demo",
      key: "item-1",
    });
    expect(parseControllerArgs("reconcile demo item-1").kind).toBe("reconcile");
    expect(parseControllerArgs("delete demo item-1").kind).toBe("delete");
    expect(parseControllerArgs('apply demo item-1 {"enabled":true}')).toEqual({
      kind: "apply",
      controller: "demo",
      key: "item-1",
      spec: { enabled: true },
    });
  });

  it("rejects malformed commands and JSON", () => {
    expect(() => parseControllerArgs("get demo")).toThrow(/Usage/);
    expect(() => parseControllerArgs("apply demo item nope")).toThrow(/Invalid/);
  });
});
