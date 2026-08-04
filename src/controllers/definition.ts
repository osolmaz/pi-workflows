import type { AnyControllerDefinition, ControllerDefinition, ControllerResource } from "./types.js";

const CONTROLLER_DEFINITION_BRAND = Symbol.for("pi-workflows.controller-definition");
const CONTROLLER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function defineController<TSpec, TStatus>(
  definition: ControllerDefinition<TSpec, TStatus>,
): ControllerDefinition<TSpec, TStatus> {
  assertValidControllerDefinition(definition);
  if (isControllerDefinition(definition)) {
    return definition;
  }
  Object.defineProperty(definition, CONTROLLER_DEFINITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return definition;
}

export function isControllerDefinition(value: unknown): value is AnyControllerDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[CONTROLLER_DEFINITION_BRAND] === true
  );
}

export function assertValidControllerDefinition<TSpec, TStatus>(
  definition: ControllerDefinition<TSpec, TStatus>,
): void {
  if (definition === null || typeof definition !== "object") {
    throw new Error("Invalid controller definition: expected an object");
  }
  if (!CONTROLLER_NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Invalid controller definition: name ${JSON.stringify(definition.name)} must match ${CONTROLLER_NAME_PATTERN.source}`,
    );
  }
  if (typeof definition.initialStatus !== "function") {
    throw new Error("Invalid controller definition: initialStatus must be a function");
  }
  if (typeof definition.reconcile !== "function") {
    throw new Error("Invalid controller definition: reconcile must be a function");
  }
  if (
    definition.timeoutMs !== undefined &&
    (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0)
  ) {
    throw new Error("Invalid controller definition: timeoutMs must be a positive safe integer");
  }
}

export function asAnyControllerDefinition<TSpec, TStatus>(
  definition: ControllerDefinition<TSpec, TStatus>,
): AnyControllerDefinition {
  return definition as unknown as ControllerDefinition<unknown, unknown>;
}

export function asTypedResource<TSpec, TStatus>(
  resource: ControllerResource,
): ControllerResource<TSpec, TStatus> {
  return resource as ControllerResource<TSpec, TStatus>;
}
