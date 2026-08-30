import {
  assertValidAgentNode,
  assertValidActionNode,
  assertValidCheckpointNode,
  assertValidComputeNode,
  assertValidNotifyNode,
  assertValidShellActionNode,
  assertValidWorkflowDefinitionShape,
} from "./schema.js";
import type { WorkflowSettingsDefinition } from "./settings.js";
import type {
  AgentNodeDefinition,
  AssistantAgentNodeDefinition,
  AssistantMessageOutput,
  SubmittedAgentNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  NotifyNodeDefinition,
  ShellActionNodeDefinition,
  WorkflowDefinition,
  WorkflowExitMap,
  WorkflowIncludeDefinition,
  WorkflowIncludedResult,
  WorkflowIncludeMap,
  WorkflowInputOf,
  WorkflowManagedEffect,
  WorkflowNodeContext,
  WorkflowNodeDefinition,
  WorkflowSettingsOf,
  WorkflowTypedEdge,
  WorkflowValueParser,
} from "./types.js";

const WORKFLOW_DEFINITION_BRAND = Symbol.for("pi-workflows.definition");

type WorkflowDefinitionInput<
  TInput,
  TNodes extends Record<string, WorkflowNodeDefinition>,
  TIncludes extends WorkflowIncludeMap,
  TExits extends WorkflowExitMap,
  TSettings,
> = Omit<
  WorkflowDefinition<TInput, TExits, TIncludes, TSettings>,
  "input" | "settings" | "nodes" | "includes" | "exits" | "edges"
> & {
  input?: WorkflowValueParser<TInput>;
  settings?: WorkflowSettingsDefinition<TSettings, TInput>;
  nodes: TNodes;
  includes?: TIncludes;
  exits?: TExits;
  edges: WorkflowTypedEdge<TNodes, TIncludes>[];
};

export function defineWorkflow<
  TInput = unknown,
  const TNodes extends Record<string, WorkflowNodeDefinition> = Record<
    string,
    WorkflowNodeDefinition
  >,
  const TIncludes extends WorkflowIncludeMap = Record<never, never>,
  const TExits extends WorkflowExitMap = Record<never, never>,
  TSettings = unknown,
>(
  definition: WorkflowDefinitionInput<TInput, TNodes, TIncludes, TExits, TSettings>,
): WorkflowDefinition<TInput, TExits, TIncludes, TSettings> & {
  nodes: TNodes;
  includes?: TIncludes;
  exits?: TExits;
} {
  assertValidWorkflowDefinitionShape(definition as WorkflowDefinition);
  const typed = definition as WorkflowDefinition<TInput, TExits, TIncludes, TSettings> & {
    nodes: TNodes;
    includes?: TIncludes;
    exits?: TExits;
  };
  if (isWorkflowDefinition(typed)) {
    return typed;
  }
  Object.defineProperty(typed, WORKFLOW_DEFINITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return typed;
}

export function includeWorkflow<TWorkflow extends WorkflowDefinition<any, any, any>>(
  workflow: TWorkflow,
  options?: {
    input?: (
      context: WorkflowNodeContext,
    ) => Promise<WorkflowInputOf<TWorkflow>> | WorkflowInputOf<TWorkflow>;
    settings?: (
      context: WorkflowNodeContext,
    ) => Promise<WorkflowSettingsOf<TWorkflow>> | WorkflowSettingsOf<TWorkflow>;
  },
): WorkflowIncludeDefinition<TWorkflow>;
export function includeWorkflow<TWorkflow extends WorkflowDefinition<any, any, any>>(
  definition: WorkflowIncludeDefinition<TWorkflow>,
): WorkflowIncludeDefinition<TWorkflow>;
export function includeWorkflow<TWorkflow extends WorkflowDefinition<any, any, any>>(
  workflowOrDefinition: TWorkflow | WorkflowIncludeDefinition<TWorkflow>,
  options: {
    input?: (
      context: WorkflowNodeContext,
    ) => Promise<WorkflowInputOf<TWorkflow>> | WorkflowInputOf<TWorkflow>;
    settings?: (
      context: WorkflowNodeContext,
    ) => Promise<WorkflowSettingsOf<TWorkflow>> | WorkflowSettingsOf<TWorkflow>;
  } = {},
): WorkflowIncludeDefinition<TWorkflow> {
  const definition = isWorkflowDefinition(workflowOrDefinition)
    ? { workflow: workflowOrDefinition, ...options }
    : workflowOrDefinition;
  if (typeof definition.workflow !== "string" && !isWorkflowDefinition(definition.workflow)) {
    throw new Error("Included workflow must be a defined workflow or a workflow reference");
  }
  if (definition.input !== undefined && typeof definition.input !== "function") {
    throw new Error("Included workflow input must be a function");
  }
  if (definition.settings !== undefined && typeof definition.settings !== "function") {
    throw new Error("Included workflow settings must be a function");
  }
  if (definition.contract !== undefined && !isWorkflowDefinition(definition.contract)) {
    throw new Error("Included workflow contract must be defined with defineWorkflow");
  }
  return definition;
}

export function includedResult<TWorkflow extends WorkflowDefinition<any, any, any>>(
  workflow: TWorkflow,
  value: unknown,
): WorkflowIncludedResult<TWorkflow> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Included ${workflow.name} result must be an object`);
  }
  const exit = (value as { exit?: unknown }).exit;
  if (typeof exit !== "string" || !Object.hasOwn(workflow.exits ?? {}, exit)) {
    throw new Error(`Included ${workflow.name} result has unknown exit ${JSON.stringify(exit)}`);
  }
  if (!Object.hasOwn(value, "output")) {
    throw new Error(`Included ${workflow.name} result requires output`);
  }
  return value as WorkflowIncludedResult<TWorkflow>;
}

/** Preserve exact workflow types while checking duplicate registry names. */
export function defineWorkflowRegistry<
  const TRegistry extends Record<string, WorkflowDefinition<any, any, any>>,
>(registry: TRegistry): Readonly<TRegistry> {
  const names = new Set<string>();
  for (const [key, workflow] of Object.entries(registry)) {
    if (!isWorkflowDefinition(workflow)) {
      throw new Error(`Workflow registry entry ${key} is not defined with defineWorkflow`);
    }
    if (names.has(workflow.name)) {
      throw new Error(`Workflow registry has duplicate workflow name: ${workflow.name}`);
    }
    names.add(workflow.name);
  }
  return Object.freeze({ ...registry });
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition<any, any, any> {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[WORKFLOW_DEFINITION_BRAND] === true
  );
}

export function manualEffect(type: string): WorkflowManagedEffect {
  return workflowEffect(type, "manual");
}

export function idempotentEffect(type: string): WorkflowManagedEffect {
  return workflowEffect(type, "idempotent");
}

function workflowEffect(
  type: string,
  recovery: WorkflowManagedEffect["recovery"],
): WorkflowManagedEffect {
  const normalized = type.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error("Managed effect type must be nonempty text of at most 256 characters");
  }
  return {
    type: normalized,
    recovery,
    idempotencyKey: ({ state }: WorkflowNodeContext) => {
      const nodeId = state.currentNode;
      if (nodeId === undefined) {
        throw new Error("Managed effect resolution requires an active workflow node");
      }
      const nodeInvocation = state.steps.filter((step) => step.nodeId === nodeId).length + 1;
      return `${state.runId}:${normalized}:${nodeId}:${nodeInvocation}`;
    },
    request: ({ input, outputs }: WorkflowNodeContext) => ({ input, outputs }),
  };
}

export function assistantMessage(options: { maxChars?: number } = {}): AssistantMessageOutput {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid workflow definition: assistantMessage options must be an object");
  }
  const unknown = Object.keys(options).filter((key) => key !== "maxChars");
  if (unknown.length > 0) {
    throw new Error(
      `Invalid workflow definition: assistantMessage has unknown option ${JSON.stringify(unknown[0])}`,
    );
  }
  if (
    options.maxChars !== undefined &&
    (!Number.isInteger(options.maxChars) || options.maxChars <= 0)
  ) {
    throw new Error(
      "Invalid workflow definition: assistantMessage maxChars must be a positive integer",
    );
  }
  return Object.freeze({
    kind: "assistant-message" as const,
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
  });
}

export function agent(
  definition: Omit<SubmittedAgentNodeDefinition, "nodeType">,
): SubmittedAgentNodeDefinition;
export function agent(
  definition: Omit<AssistantAgentNodeDefinition, "nodeType">,
): AssistantAgentNodeDefinition;
export function agent(definition: Omit<AgentNodeDefinition, "nodeType">): AgentNodeDefinition {
  const node = {
    nodeType: "agent" as const,
    ...definition,
  } as AgentNodeDefinition;
  assertValidAgentNode(node);
  return node;
}

export function compute(
  definition: Omit<ComputeNodeDefinition, "nodeType">,
): ComputeNodeDefinition {
  const node: ComputeNodeDefinition = {
    nodeType: "compute",
    ...definition,
  };
  assertValidComputeNode(node);
  return node;
}

export function notify(definition: Omit<NotifyNodeDefinition, "nodeType">): NotifyNodeDefinition {
  const node: NotifyNodeDefinition = {
    nodeType: "notify",
    ...definition,
  };
  assertValidNotifyNode(node);
  return node;
}

export function action(
  definition: Omit<FunctionActionNodeDefinition, "nodeType">,
): FunctionActionNodeDefinition;
export function action(
  definition: Omit<ShellActionNodeDefinition, "nodeType">,
): ShellActionNodeDefinition;
export function action(
  definition:
    | Omit<FunctionActionNodeDefinition, "nodeType">
    | Omit<ShellActionNodeDefinition, "nodeType">,
): ActionNodeDefinition {
  const node: ActionNodeDefinition = {
    nodeType: "action",
    ...definition,
  };
  assertValidActionNode(node);
  return node;
}

export function shell(
  definition: Omit<ShellActionNodeDefinition, "nodeType">,
): ShellActionNodeDefinition {
  const node: ShellActionNodeDefinition = {
    nodeType: "action",
    ...definition,
  };
  assertValidShellActionNode(node);
  return node;
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "nodeType"> = {},
): CheckpointNodeDefinition {
  const node: CheckpointNodeDefinition = {
    nodeType: "checkpoint",
    ...definition,
  };
  assertValidCheckpointNode(node);
  return node;
}
