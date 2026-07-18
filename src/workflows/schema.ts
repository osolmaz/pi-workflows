import type {
  AgentNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  ShellActionNodeDefinition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNodeDefinition,
} from "./types.js";

const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function fail(message: string): never {
  throw new Error(`Invalid workflow definition: ${message}`);
}

function assertRecord(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${description} must be an object`);
  }
}

function assertOptionalFunction(value: unknown, description: string): void {
  if (value !== undefined && typeof value !== "function") {
    fail(`${description} must be a function when provided`);
  }
}

function assertCommonNodeFields(node: WorkflowNodeDefinition, nodeId: string): void {
  if (
    node.timeoutMs !== undefined &&
    (typeof node.timeoutMs !== "number" || !Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)
  ) {
    fail(`node ${nodeId} timeoutMs must be a finite positive number`);
  }
  if (node.statusDetail !== undefined && typeof node.statusDetail !== "string") {
    fail(`node ${nodeId} statusDetail must be a string`);
  }
}

export function assertValidAgentNode(node: AgentNodeDefinition, nodeId = "agent"): void {
  if (typeof node.prompt !== "function") {
    fail(`node ${nodeId} requires a prompt function`);
  }
  if (node.expectedOutput !== undefined && typeof node.expectedOutput !== "string") {
    fail(`node ${nodeId} expectedOutput must be a string`);
  }
  assertOptionalFunction(node.validate, `node ${nodeId} validate`);
  assertCommonNodeFields(node, nodeId);
}

export function assertValidComputeNode(node: ComputeNodeDefinition, nodeId = "compute"): void {
  if (typeof node.run !== "function") {
    fail(`node ${nodeId} requires a run function`);
  }
  assertCommonNodeFields(node, nodeId);
}

export function assertValidActionNode(node: ActionNodeDefinition, nodeId = "action"): void {
  // Dispatch discriminates with `"exec" in node`, so validation must use the
  // same property semantics: a present-but-invalid `exec` is an error even
  // when a `run` function exists.
  const hasExec = "exec" in node;
  const hasRun = "run" in node;
  if (hasExec === hasRun) {
    fail(`node ${nodeId} requires exactly one of run or exec`);
  }
  if (hasExec) {
    if (typeof node.exec !== "function") {
      fail(`node ${nodeId} exec must be a function`);
    }
    assertOptionalFunction((node as ShellActionNodeDefinition).parse, `node ${nodeId} parse`);
  } else if (typeof (node as FunctionActionNodeDefinition).run !== "function") {
    fail(`node ${nodeId} run must be a function`);
  }
  assertCommonNodeFields(node, nodeId);
}

export function assertValidShellActionNode(
  node: ShellActionNodeDefinition,
  nodeId = "shell",
): void {
  if (typeof node.exec !== "function") {
    fail(`node ${nodeId} requires an exec function`);
  }
  assertOptionalFunction(node.parse, `node ${nodeId} parse`);
  assertCommonNodeFields(node, nodeId);
}

export function assertValidCheckpointNode(
  node: CheckpointNodeDefinition,
  nodeId = "checkpoint",
): void {
  if (node.summary !== undefined && typeof node.summary !== "string") {
    fail(`node ${nodeId} summary must be a string`);
  }
  assertOptionalFunction(node.run, `node ${nodeId} run`);
  assertCommonNodeFields(node, nodeId);
}

function assertValidNode(node: WorkflowNodeDefinition, nodeId: string): void {
  switch (node.nodeType) {
    case "agent":
      assertValidAgentNode(node, nodeId);
      return;
    case "compute":
      assertValidComputeNode(node, nodeId);
      return;
    case "action":
      assertValidActionNode(node, nodeId);
      return;
    case "checkpoint":
      assertValidCheckpointNode(node, nodeId);
      return;
    default:
      fail(
        `node ${nodeId} has unknown nodeType ${String((node as { nodeType?: unknown }).nodeType)}`,
      );
  }
}

function assertValidEdgeShape(edge: WorkflowEdge, index: number): void {
  assertRecord(edge, `edge ${index}`);
  if (typeof edge.from !== "string" || edge.from.length === 0) {
    fail(`edge ${index} requires a from node id`);
  }
  if ("to" in edge) {
    if (typeof edge.to !== "string" || edge.to.length === 0) {
      fail(`edge ${index} requires a to node id`);
    }
    return;
  }
  assertRecord(edge.switch, `edge ${index} switch`);
  if (typeof edge.switch.on !== "string" || edge.switch.on.length === 0) {
    fail(`edge ${index} switch.on must be a JSON path string`);
  }
  // Routing only understands these prefixes; rejecting others here prevents
  // the source node from executing its side effects before a routing error.
  const on = edge.switch.on;
  if (!on.startsWith("$.") && !on.startsWith("$output.") && !on.startsWith("$result.")) {
    fail(`edge ${index} switch.on must start with "$.", "$output.", or "$result."`);
  }
  assertRecord(edge.switch.cases, `edge ${index} switch.cases`);
  if (Object.keys(edge.switch.cases).length === 0) {
    fail(`edge ${index} switch.cases must not be empty`);
  }
  for (const [caseKey, target] of Object.entries(edge.switch.cases)) {
    if (typeof target !== "string" || target.length === 0) {
      fail(`edge ${index} switch case ${JSON.stringify(caseKey)} must map to a node id`);
    }
  }
}

export function assertValidWorkflowDefinitionShape(definition: WorkflowDefinition): void {
  assertRecord(definition, "workflow");
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    fail("workflow requires a name");
  }
  if (
    definition.title !== undefined &&
    typeof definition.title !== "string" &&
    typeof definition.title !== "function"
  ) {
    fail("workflow title must be a string or function");
  }
  if (typeof definition.startAt !== "string" || definition.startAt.length === 0) {
    fail("workflow requires startAt");
  }
  if (
    definition.maxSteps !== undefined &&
    (typeof definition.maxSteps !== "number" ||
      !Number.isInteger(definition.maxSteps) ||
      definition.maxSteps <= 0)
  ) {
    fail("workflow maxSteps must be a positive integer");
  }
  assertRecord(definition.nodes, "workflow nodes");
  if (Object.keys(definition.nodes).length === 0) {
    fail("workflow requires at least one node");
  }
  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (!NODE_ID_PATTERN.test(nodeId)) {
      fail(`node id ${JSON.stringify(nodeId)} must match ${NODE_ID_PATTERN.source}`);
    }
    // Ids like __proto__ or toString would collide with Object prototype
    // members in the plain-object maps used for outputs and results.
    if (nodeId in Object.prototype) {
      fail(`node id ${JSON.stringify(nodeId)} shadows an Object prototype member`);
    }
    assertRecord(node, `node ${nodeId}`);
    assertValidNode(node, nodeId);
  }
  if (!Array.isArray(definition.edges)) {
    fail("workflow edges must be an array");
  }
  definition.edges.forEach(assertValidEdgeShape);
}
