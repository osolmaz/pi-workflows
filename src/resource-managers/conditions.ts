import type {
  ManagedResourceCondition,
  ManagedResourceConditionInput,
  ManagedResourceConditionStatus,
  ManagedResourceStatus,
  ResourceManagerStatusPatch,
} from "./types.js";

export function conditionTrue(
  type: string,
  reason: string,
  message?: string,
): ManagedResourceConditionInput {
  return condition(type, true, reason, message);
}

export function conditionFalse(
  type: string,
  reason: string,
  message?: string,
): ManagedResourceConditionInput {
  return condition(type, false, reason, message);
}

export function conditionUnknown(
  type: string,
  reason: string,
  message?: string,
): ManagedResourceConditionInput {
  return condition(type, "unknown", reason, message);
}

export function applyStatusPatch<TStatus>(
  current: ManagedResourceStatus<TStatus>,
  patch: ResourceManagerStatusPatch<TStatus> | undefined,
  generation: number,
  now: string,
): ManagedResourceStatus<TStatus> {
  return {
    observedGeneration: generation,
    conditions: mergeConditions(current.conditions, patch?.conditions ?? [], generation, now),
    resourceManagerStatus:
      patch !== undefined && Object.hasOwn(patch, "resourceManagerStatus")
        ? (patch.resourceManagerStatus as TStatus)
        : current.resourceManagerStatus,
    ...(patch?.workflowRun === null
      ? {}
      : patch?.workflowRun !== undefined
        ? { workflowRun: patch.workflowRun }
        : current.workflowRun !== undefined
          ? { workflowRun: current.workflowRun }
          : {}),
  };
}

export function mergeConditions(
  current: ManagedResourceCondition[],
  updates: ManagedResourceConditionInput[],
  generation: number,
  now: string,
): ManagedResourceCondition[] {
  const byType = new Map(current.map((item) => [item.type, item]));
  const seen = new Set<string>();
  for (const update of updates) {
    validateCondition(update);
    if (seen.has(update.type)) {
      throw new Error(`Condition ${JSON.stringify(update.type)} was updated more than once`);
    }
    seen.add(update.type);
    const previous = byType.get(update.type);
    const next: ManagedResourceCondition = {
      ...update,
      observedGeneration: generation,
      lastTransitionTime:
        previous !== undefined && previous.status === update.status
          ? previous.lastTransitionTime
          : now,
    };
    byType.set(update.type, next);
  }
  return [...byType.values()];
}

function condition(
  type: string,
  status: ManagedResourceConditionStatus,
  reason: string,
  message: string | undefined,
): ManagedResourceConditionInput {
  const value: ManagedResourceConditionInput = {
    type,
    status,
    reason,
    ...(message !== undefined ? { message } : {}),
  };
  validateCondition(value);
  return value;
}

function validateCondition(value: ManagedResourceConditionInput): void {
  if (value.type.trim().length === 0) {
    throw new Error("Condition type must not be empty");
  }
  if (value.reason.trim().length === 0) {
    throw new Error("Condition reason must not be empty");
  }
  if (value.status !== true && value.status !== false && value.status !== "unknown") {
    throw new Error(`Invalid condition status for ${JSON.stringify(value.type)}`);
  }
}
