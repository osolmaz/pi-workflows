import type {
  AgentNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  NotifyNodeDefinition,
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
    node.timeoutMs !== null &&
    typeof node.timeoutMs !== "function" &&
    (typeof node.timeoutMs !== "number" || !Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)
  ) {
    fail(`node ${nodeId} timeoutMs must be null, a finite positive number, or a function`);
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
    const output = node.expectedOutput as { kind?: unknown; maxChars?: unknown };
    if (output === null || typeof output !== "object" || output.kind !== "assistant-message") {
      fail(`node ${nodeId} expectedOutput must be a string or assistantMessage()`);
    }
    const unknown = Object.keys(output).filter((key) => key !== "kind" && key !== "maxChars");
    if (unknown.length > 0) {
      fail(`node ${nodeId} assistantMessage has unknown field ${JSON.stringify(unknown[0])}`);
    }
    if (
      output.maxChars !== undefined &&
      (typeof output.maxChars !== "number" ||
        !Number.isInteger(output.maxChars) ||
        output.maxChars <= 0)
    ) {
      fail(`node ${nodeId} assistantMessage maxChars must be a positive integer`);
    }
    if (node.validate !== undefined) {
      fail(`node ${nodeId} cannot use validate with assistantMessage()`);
    }
  }
  assertOptionalFunction(node.validate, `node ${nodeId} validate`);
  assertCommonNodeFields(node, nodeId);
}

export function assertValidComputeNode(node: ComputeNodeDefinition, nodeId = "compute"): void {
  if (typeof node.run !== "function") {
    fail(`node ${nodeId} requires a run function`);
  }
  if (node.settingsRoute !== undefined && node.settingsRoute !== true) {
    fail(`node ${nodeId} settingsRoute must be true when provided`);
  }
  assertCommonNodeFields(node, nodeId);
}

export function assertValidNotifyNode(node: NotifyNodeDefinition, nodeId = "notify"): void {
  if (typeof node.message !== "function") {
    fail(`node ${nodeId} requires a message function`);
  }
  if (node.kind !== undefined && node.kind !== "progress" && node.kind !== "final") {
    fail(`node ${nodeId} kind must be progress or final`);
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
    const shell = node as ShellActionNodeDefinition;
    assertOptionalFunction(shell.parse, `node ${nodeId} parse`);
    assertShellUpdates(shell, nodeId);
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
  assertShellUpdates(node, nodeId);
  assertCommonNodeFields(node, nodeId);
}

function assertShellUpdates(node: ShellActionNodeDefinition, nodeId: string): void {
  if (node.updates === undefined) return;
  if (node.updates === null || typeof node.updates !== "object") {
    fail(`node ${nodeId} updates must be an object`);
  }
  if (typeof node.updates.parseLine !== "function") {
    fail(`node ${nodeId} updates.parseLine must be a function`);
  }
  if (node.updates.streams !== undefined) {
    if (
      !Array.isArray(node.updates.streams) ||
      node.updates.streams.length === 0 ||
      node.updates.streams.some((stream) => stream !== "stdout" && stream !== "stderr")
    ) {
      fail(`node ${nodeId} updates.streams must contain stdout or stderr`);
    }
  }
}

export function assertValidCheckpointNode(
  node: CheckpointNodeDefinition,
  nodeId = "checkpoint",
): void {
  if (node.summary !== undefined && typeof node.summary !== "string") {
    fail(`node ${nodeId} summary must be a string`);
  }
  assertOptionalFunction(node.run, `node ${nodeId} run`);
  if (node.humanDecision !== undefined) {
    assertRecord(node.humanDecision, `node ${nodeId} humanDecision`);
    if (
      (typeof node.humanDecision.audience !== "string" ||
        node.humanDecision.audience.length === 0) &&
      typeof node.humanDecision.audience !== "function"
    ) {
      fail(`node ${nodeId} humanDecision audience must be a non-empty string or function`);
    }
    assertRecord(node.humanDecision.choices, `node ${nodeId} humanDecision choices`);
    if (Object.keys(node.humanDecision.choices).length === 0) {
      fail(`node ${nodeId} humanDecision choices must not be empty`);
    }
    if (typeof node.humanDecision.request !== "function") {
      fail(`node ${nodeId} humanDecision request must be a function`);
    }
    if (
      node.humanDecision.onTimeout !== undefined &&
      typeof node.humanDecision.onTimeout !== "function"
    ) {
      assertRecord(node.humanDecision.onTimeout, `node ${nodeId} humanDecision onTimeout`);
      if (
        typeof node.humanDecision.onTimeout.afterMs !== "number" ||
        !Number.isFinite(node.humanDecision.onTimeout.afterMs) ||
        node.humanDecision.onTimeout.afterMs <= 0
      ) {
        fail(`node ${nodeId} humanDecision onTimeout afterMs must be a finite positive number`);
      }
      assertRecord(
        node.humanDecision.onTimeout.response,
        `node ${nodeId} humanDecision onTimeout response`,
      );
    }
  }
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
    case "notify":
      assertValidNotifyNode(node, nodeId);
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

/**
 * Names claimed by `/workflow` subcommands; a workflow with one of these
 * names could never be started because the keyword wins the argument slot.
 */
const RESERVED_WORKFLOW_NAMES = new Set([
  "answer",
  "cancel",
  "change-settings",
  "list",
  "pause",
  "queue-follow-up",
  "remove-follow-up",
  "resume",
  "status",
]);

export function assertValidWorkflowDefinitionShape(
  definition: WorkflowDefinition,
  options: { compiled?: boolean } = {},
): void {
  assertRecord(definition, "workflow");
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    fail("workflow requires a name");
  }
  if (RESERVED_WORKFLOW_NAMES.has(definition.name)) {
    fail(`workflow name ${JSON.stringify(definition.name)} is reserved for /workflow subcommands`);
  }
  if (definition.source !== undefined && typeof definition.source !== "string") {
    fail("workflow source must be a string");
  }
  if (
    definition.contractId !== undefined &&
    (typeof definition.contractId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(definition.contractId))
  ) {
    fail("workflow contractId must be a stable identifier");
  }
  assertOptionalFunction(definition.input, "workflow input");
  if (definition.settings !== undefined) {
    assertRecord(definition.settings, "workflow settings");
    if (
      typeof definition.settings.initial !== "function" &&
      definition.settings.initial === undefined
    ) {
      fail("workflow settings requires initial");
    }
    if (typeof definition.settings.parse !== "function") {
      fail("workflow settings requires a parse function");
    }
    if (!Array.isArray(definition.settings.paths)) {
      fail("workflow settings paths must be an array");
    }
    assertOptionalFunction(definition.settings.validateChange, "workflow settings validateChange");
  }
  if (
    definition.title !== undefined &&
    typeof definition.title !== "string" &&
    typeof definition.title !== "function"
  ) {
    fail("workflow title must be a string or function");
  }
  if (
    definition.presentationPrompt !== undefined &&
    typeof definition.presentationPrompt !== "string" &&
    typeof definition.presentationPrompt !== "function"
  ) {
    fail("workflow presentationPrompt must be a string or function");
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
    const segments = nodeId.split("/");
    if (
      segments.some(
        (segment) =>
          !NODE_ID_PATTERN.test(segment) || (!options.compiled && segment.startsWith("__piw_")),
      ) ||
      (!options.compiled && segments.length !== 1)
    ) {
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
  if (definition.includes !== undefined) {
    assertRecord(definition.includes, "workflow includes");
    for (const [mountName, include] of Object.entries(definition.includes)) {
      if (!NODE_ID_PATTERN.test(mountName) || mountName.startsWith("__piw_")) {
        fail(`include name ${JSON.stringify(mountName)} must match ${NODE_ID_PATTERN.source}`);
      }
      if (Object.hasOwn(definition.nodes, mountName)) {
        fail(`include name ${JSON.stringify(mountName)} collides with a node id`);
      }
      assertRecord(include, `include ${mountName}`);
      if (
        typeof include.workflow !== "string" &&
        (include.workflow === null || typeof include.workflow !== "object")
      ) {
        fail(`include ${mountName} requires a workflow definition or reference`);
      }
      assertOptionalFunction(include.input, `include ${mountName} input`);
      assertOptionalFunction(include.settings, `include ${mountName} settings`);
      if (
        include.contract !== undefined &&
        (include.contract === null || typeof include.contract !== "object")
      ) {
        fail(`include ${mountName} contract must be a workflow definition`);
      }
    }
  }
  if (definition.exits !== undefined) {
    assertRecord(definition.exits, "workflow exits");
    if (Object.keys(definition.exits).length === 0) fail("workflow exits must not be empty");
    for (const [exitName, exit] of Object.entries(definition.exits)) {
      if (!NODE_ID_PATTERN.test(exitName) || exitName.startsWith("__piw_")) {
        fail(`exit name ${JSON.stringify(exitName)} must match ${NODE_ID_PATTERN.source}`);
      }
      assertRecord(exit, `exit ${exitName}`);
      if (typeof exit.from !== "string" || exit.from.length === 0) {
        fail(`exit ${exitName} requires from`);
      }
      assertOptionalFunction(exit.validate, `exit ${exitName} validate`);
    }
  }
  if (!Array.isArray(definition.edges)) {
    fail("workflow edges must be an array");
  }
  definition.edges.forEach(assertValidEdgeShape);
}
