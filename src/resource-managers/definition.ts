import type {
  AnyResourceManagerDefinition,
  ResourceManagerDefinition,
  ManagedResource,
} from "./types.js";

const RESOURCE_MANAGER_DEFINITION_BRAND = Symbol.for("pi-workflows.resource-manager-definition");
const RESOURCE_MANAGER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function defineResourceManager<TSpec, TStatus>(
  definition: ResourceManagerDefinition<TSpec, TStatus>,
): ResourceManagerDefinition<TSpec, TStatus> {
  assertValidResourceManagerDefinition(definition);
  if (isResourceManagerDefinition(definition)) {
    return definition;
  }
  Object.defineProperty(definition, RESOURCE_MANAGER_DEFINITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return definition;
}

export function isResourceManagerDefinition(value: unknown): value is AnyResourceManagerDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[RESOURCE_MANAGER_DEFINITION_BRAND] === true
  );
}

export function assertValidResourceManagerDefinition<TSpec, TStatus>(
  definition: ResourceManagerDefinition<TSpec, TStatus>,
): void {
  if (definition === null || typeof definition !== "object") {
    throw new Error("Invalid resource manager definition: expected an object");
  }
  if (!RESOURCE_MANAGER_NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Invalid resource manager definition: name ${JSON.stringify(definition.name)} must match ${RESOURCE_MANAGER_NAME_PATTERN.source}`,
    );
  }
  if (typeof definition.initialStatus !== "function") {
    throw new Error("Invalid resource manager definition: initialStatus must be a function");
  }
  if (typeof definition.reconcile !== "function") {
    throw new Error("Invalid resource manager definition: reconcile must be a function");
  }
  if (
    definition.timeoutMs !== undefined &&
    (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0)
  ) {
    throw new Error(
      "Invalid resource manager definition: timeoutMs must be a positive safe integer",
    );
  }
}

export function asAnyResourceManagerDefinition<TSpec, TStatus>(
  definition: ResourceManagerDefinition<TSpec, TStatus>,
): AnyResourceManagerDefinition {
  return definition as unknown as ResourceManagerDefinition<unknown, unknown>;
}

export function asTypedResource<TSpec, TStatus>(
  resource: ManagedResource,
): ManagedResource<TSpec, TStatus> {
  return resource as ManagedResource<TSpec, TStatus>;
}
