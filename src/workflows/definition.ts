import {
  assertValidAgentNode,
  assertValidActionNode,
  assertValidCheckpointNode,
  assertValidComputeNode,
  assertValidShellActionNode,
  assertValidWorkflowDefinitionShape,
} from "./schema.js";
import type {
  AgentNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  ShellActionNodeDefinition,
  WorkflowDefinition,
} from "./types.js";

const WORKFLOW_DEFINITION_BRAND = Symbol.for("pi-workflows.definition");

export function defineWorkflow<TWorkflow extends WorkflowDefinition>(
  definition: TWorkflow,
): TWorkflow {
  assertValidWorkflowDefinitionShape(definition);
  if (isWorkflowDefinition(definition)) {
    return definition;
  }
  Object.defineProperty(definition, WORKFLOW_DEFINITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return definition;
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[WORKFLOW_DEFINITION_BRAND] === true
  );
}

export function agent(definition: Omit<AgentNodeDefinition, "nodeType">): AgentNodeDefinition {
  const node: AgentNodeDefinition = {
    nodeType: "agent",
    ...definition,
  };
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
