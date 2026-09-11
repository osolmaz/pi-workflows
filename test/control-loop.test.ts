import { describe, expect, expectTypeOf, it } from "vitest";
import { controlLoop, type ControlLoopGraph } from "../src/workflows/control-loop.js";

function exampleLoop() {
  return controlLoop({
    decide: "decide",
    returnTo: "observe",
    routes: {
      implement: { to: "implement", returns: ["implementationResult"] },
      verify: {
        to: "verification",
        returns: ["verification.ready", "verification.blocked"],
      },
      complete: { to: "completed", terminal: true },
      blocked: { to: "blocked", terminal: true },
    },
  });
}

describe("controlLoop", () => {
  it("builds one exhaustive decision edge and ordinary return edges", () => {
    expect(exampleLoop()).toEqual({
      choices: ["implement", "verify", "complete", "blocked"],
      edges: [
        {
          from: "decide",
          switch: {
            on: "$.route",
            cases: {
              implement: "implement",
              verify: "verification",
              complete: "completed",
              blocked: "blocked",
            },
          },
        },
        { from: "implementationResult", to: "observe" },
        { from: "verification.ready", to: "observe" },
        { from: "verification.blocked", to: "observe" },
      ],
    });
  });

  it("preserves literal route and reference types", () => {
    const loop = exampleLoop();
    expectTypeOf(loop).toEqualTypeOf<
      ControlLoopGraph<
        "decide",
        "observe",
        {
          readonly implement: {
            readonly to: "implement";
            readonly returns: readonly ["implementationResult"];
          };
          readonly verify: {
            readonly to: "verification";
            readonly returns: readonly ["verification.ready", "verification.blocked"];
          };
          readonly complete: { readonly to: "completed"; readonly terminal: true };
          readonly blocked: { readonly to: "blocked"; readonly terminal: true };
        }
      >
    >();
    expectTypeOf(loop.choices).items.toEqualTypeOf<
      "implement" | "verify" | "complete" | "blocked"
    >();
  });

  it("supports returning directly to the decision node", () => {
    expect(
      controlLoop({
        decide: "decide",
        returnTo: "decide",
        routes: {
          retry: { to: "work", returns: ["result"] },
          complete: { to: "done", terminal: true },
        },
      }).edges,
    ).toContainEqual({ from: "result", to: "decide" });
  });

  it("rejects missing and malformed routes", () => {
    expect(() => controlLoop({ decide: "decide", returnTo: "observe", routes: {} })).toThrow(
      /at least one route/,
    );
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: { work: { to: "work", returns: [] } },
      }),
    ).toThrow(/requires at least one return/);
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: { "bad route": { to: "work", returns: ["result"] } },
      }),
    ).toThrow(/must match/);
    expect(() =>
      controlLoop({
        decide: "bad.node",
        returnTo: "observe",
        routes: { work: { to: "work", returns: ["result"] } },
      }),
    ).toThrow(/decide must match/);
  });

  it("rejects terminal routes with returns", () => {
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: {
          complete: {
            to: "done",
            terminal: true,
            returns: ["result"],
          } as never,
        },
      }),
    ).toThrow(/terminal route complete must not declare returns/);
  });

  it("rejects duplicate and controller return sources", () => {
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: {
          first: { to: "a", returns: ["same"] },
          second: { to: "b", returns: ["same"] },
        },
      }),
    ).toThrow(/declared more than once/);
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: { work: { to: "work", returns: ["decide"] } },
      }),
    ).toThrow(/must not also be a branch return/);
  });

  it("rejects cancelled continuation and unknown fields", () => {
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: { cancelled: { to: "work", returns: ["result"] } },
      }),
    ).toThrow(/cancelled cannot continue/);
    expect(() =>
      controlLoop({
        decide: "decide",
        returnTo: "observe",
        routes: {
          work: { to: "work", returns: ["result"], hidden: true } as never,
        },
      }),
    ).toThrow(/field hidden is not supported/);
  });
});
