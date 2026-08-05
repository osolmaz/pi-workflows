import { assertValidWorkflowDefinitionShape } from "./schema.js";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNodeResult } from "./types.js";

/**
 * Validate the full graph: shape, known start node, known edge targets, and
 * at most one outgoing edge per node.
 */
export function validateWorkflowDefinition(workflow: WorkflowDefinition): void {
  assertValidWorkflowDefinitionShape(workflow);
  if (!Object.hasOwn(workflow.nodes, workflow.startAt)) {
    throw new Error(`Workflow start node is missing: ${workflow.startAt}`);
  }

  const outgoingEdges = new Set<string>();
  for (const edge of workflow.edges) {
    validateWorkflowEdge(workflow, edge, outgoingEdges);
  }

  assertAllNodesReachable(workflow);
}

/** Reject nodes that no path from `startAt` can ever reach. */
function assertAllNodesReachable(workflow: WorkflowDefinition): void {
  const reachable = new Set<string>([workflow.startAt]);
  const queue = [workflow.startAt];
  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    for (const edge of workflow.edges) {
      if (edge.from !== nodeId) {
        continue;
      }
      const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
      for (const target of targets) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
  }
  const unreachable = Object.keys(workflow.nodes).filter((nodeId) => !reachable.has(nodeId));
  if (unreachable.length > 0) {
    throw new Error(`Workflow has unreachable nodes: ${unreachable.join(", ")}`);
  }
}

function assertKnownNode(workflow: WorkflowDefinition, nodeId: string, description: string): void {
  // Own-property check so ids like "toString" cannot resolve through the
  // Object prototype and later dispatch an inherited function as a node.
  if (!Object.hasOwn(workflow.nodes, nodeId)) {
    throw new Error(`${description}: ${nodeId}`);
  }
}

function validateWorkflowEdge(
  workflow: WorkflowDefinition,
  edge: WorkflowEdge,
  outgoingEdges: Set<string>,
): void {
  assertKnownNode(workflow, edge.from, "Workflow edge references unknown from-node");
  if (outgoingEdges.has(edge.from)) {
    throw new Error(`Workflow node must not declare multiple outgoing edges: ${edge.from}`);
  }
  outgoingEdges.add(edge.from);

  if ("to" in edge) {
    assertKnownNode(workflow, edge.to, "Workflow edge references unknown to-node");
    return;
  }

  for (const target of Object.values(edge.switch.cases)) {
    assertKnownNode(workflow, target, "Workflow switch references unknown to-node");
  }
}

/**
 * Resolve the next node after `from` completed with `output`. Switch edges
 * route on a JSON path into the output (`$.field` or `$output.field`) or the
 * node result (`$result.outcome`).
 */
export function resolveNext(
  edges: WorkflowEdge[],
  from: string,
  output: unknown,
  result?: WorkflowNodeResult,
): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge) {
    return null;
  }
  if ("to" in edge) {
    return edge.to;
  }
  return resolveSwitchTarget(edge, output, result);
}

/**
 * Resolve routing for a failed node. Only `$result.` switch edges apply, so a
 * workflow can explicitly route on outcomes like `failed` or `timed_out`.
 */
export function resolveNextForOutcome(
  edges: WorkflowEdge[],
  from: string,
  result: WorkflowNodeResult,
): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge || "to" in edge || !edge.switch.on.startsWith("$result.")) {
    return null;
  }
  return resolveSwitchTarget(edge, undefined, result);
}

function resolveSwitchTarget(
  edge: Extract<WorkflowEdge, { switch: unknown }>,
  output: unknown,
  result: WorkflowNodeResult | undefined,
): string {
  const value = getBySwitchPath(output, result, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Workflow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No workflow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
}

function getBySwitchPath(
  output: unknown,
  result: WorkflowNodeResult | undefined,
  jsonPath: string,
): unknown {
  if (jsonPath.startsWith("$result.")) {
    return getByPath(result, `$.${jsonPath.slice("$result.".length)}`);
  }
  if (jsonPath.startsWith("$output.")) {
    return getByPath(output, `$.${jsonPath.slice("$output.".length)}`);
  }
  return getByPath(output, jsonPath);
}

function getByPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new Error(`Unsupported JSON path: ${jsonPath}`);
  }
  return jsonPath
    .slice(2)
    .split(".")
    .reduce((current: unknown, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}
