import type { WorkflowEdge } from "./types.js";

const NODE_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RETURN_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)?$/;

type ControlLoopContinuingRoute<
  TTarget extends string = string,
  TReturn extends string = string,
> = {
  to: TTarget;
  returns: readonly TReturn[];
  terminal?: false;
};

type ControlLoopTerminalRoute<TTarget extends string = string> = {
  to: TTarget;
  terminal: true;
  returns?: never;
};

export type ControlLoopRoute<TTarget extends string = string, TReturn extends string = string> =
  | ControlLoopContinuingRoute<TTarget, TReturn>
  | ControlLoopTerminalRoute<TTarget>;

export type ControlLoopRoutes = Record<string, ControlLoopRoute>;

export type ControlLoopDefinition<
  TDecide extends string,
  TReturnTo extends string,
  TRoutes extends ControlLoopRoutes,
> = {
  decide: TDecide;
  returnTo: TReturnTo;
  routes: TRoutes;
};

type ControlLoopCases<TRoutes extends ControlLoopRoutes> = {
  [TRoute in keyof TRoutes]: TRoutes[TRoute]["to"];
};

type ControlLoopReturnReference<TRoutes extends ControlLoopRoutes> = {
  [TRoute in keyof TRoutes]: TRoutes[TRoute] extends {
    returns: readonly (infer TReturn extends string)[];
  }
    ? TReturn
    : never;
}[keyof TRoutes];

export type ControlLoopEdge<
  TDecide extends string,
  TReturnTo extends string,
  TRoutes extends ControlLoopRoutes,
> =
  | {
      from: TDecide;
      switch: { on: "$.route"; cases: ControlLoopCases<TRoutes> };
    }
  | { from: ControlLoopReturnReference<TRoutes>; to: TReturnTo };

export type ControlLoopGraph<
  TDecide extends string,
  TReturnTo extends string,
  TRoutes extends ControlLoopRoutes,
> = {
  choices: readonly (keyof TRoutes & string)[];
  edges: ControlLoopEdge<TDecide, TReturnTo, TRoutes>[];
};

/**
 * Build the decision and return edges for a control loop from a typed route map.
 * The returned graph uses only ordinary workflow edges.
 */
export function controlLoop<
  const TDecide extends string,
  const TReturnTo extends string,
  const TRoutes extends ControlLoopRoutes,
>(
  definition: ControlLoopDefinition<TDecide, TReturnTo, TRoutes>,
): ControlLoopGraph<TDecide, TReturnTo, TRoutes> {
  assertExactKeys(definition, ["decide", "returnTo", "routes"], "control loop");
  const decide = requireNodeReference(definition.decide, "control loop decide");
  const returnTo = requireNodeReference(definition.returnTo, "control loop returnTo");
  const routeEntries = Object.entries(definition.routes);
  if (routeEntries.length === 0) {
    throw new Error("Control loop routes must include at least one route");
  }

  const choices: string[] = [];
  const cases: Record<string, string> = {};
  const returnEdges: WorkflowEdge[] = [];
  const claimedReturns = new Set<string>();

  for (const [routeName, routeValue] of routeEntries) {
    requireRouteName(routeName);
    if (routeName === "cancelled") {
      throw new Error("Control loop route cancelled cannot continue the workflow");
    }
    const route = requireRoute(routeValue, routeName);
    choices.push(routeName);
    cases[routeName] = requireNodeReference(route.to, `control loop route ${routeName} target`);

    if (route.terminal === true) {
      if (Object.hasOwn(route, "returns")) {
        throw new Error(`Control loop terminal route ${routeName} must not declare returns`);
      }
      continue;
    }

    if (!Array.isArray(route.returns) || route.returns.length === 0) {
      throw new Error(`Control loop route ${routeName} requires at least one return`);
    }
    for (const value of route.returns) {
      const source = requireReturnReference(value, `control loop route ${routeName} return`);
      if (source === decide) {
        throw new Error("Control loop decide node must not also be a branch return");
      }
      if (claimedReturns.has(source)) continue;
      claimedReturns.add(source);
      returnEdges.push({ from: source, to: returnTo });
    }
  }

  return {
    choices: choices as (keyof TRoutes & string)[],
    edges: [
      {
        from: decide,
        switch: { on: "$.route", cases },
      },
      ...returnEdges,
    ] as ControlLoopEdge<TDecide, TReturnTo, TRoutes>[],
  };
}

function requireRoute(value: unknown, routeName: string): ControlLoopRoute {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Control loop route ${routeName} must be an object`);
  }
  const route = value as Record<string, unknown>;
  assertExactKeys(route, ["to", "returns", "terminal"], `control loop route ${routeName}`);
  if (route.terminal !== undefined && route.terminal !== true && route.terminal !== false) {
    throw new Error(`Control loop route ${routeName} terminal must be true or false`);
  }
  return route as ControlLoopRoute;
}

function requireRouteName(value: string): void {
  if (!NODE_REFERENCE_PATTERN.test(value)) {
    throw new Error(
      `Control loop route ${JSON.stringify(value)} must match ${NODE_REFERENCE_PATTERN.source}`,
    );
  }
}

function requireNodeReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !NODE_REFERENCE_PATTERN.test(value)) {
    throw new Error(`${label} must match ${NODE_REFERENCE_PATTERN.source}`);
  }
  return value;
}

function requireReturnReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !RETURN_REFERENCE_PATTERN.test(value)) {
    throw new Error(`${label} must match ${RETURN_REFERENCE_PATTERN.source}`);
  }
  return value;
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${label} field ${unexpected} is not supported`);
  }
}
