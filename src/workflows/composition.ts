import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  NotifyNodeDefinition,
  ShellActionNodeDefinition,
  WorkflowActionContext,
  WorkflowCompositionSnapshot,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowExitDefinition,
  WorkflowIncludeDefinition,
  WorkflowMountedSource,
  WorkflowMountSnapshot,
  WorkflowNodeContext,
  WorkflowNodeDefinition,
  WorkflowNodeResult,
  WorkflowRunState,
  WorkflowSource,
  WorkflowStepRecord,
} from "./types.js";

const COMPILED_WORKFLOW_BRAND = Symbol.for("pi-workflows.compiled-definition");
const COMPOSITION_METADATA = Symbol.for("pi-workflows.composition-metadata");

export type WorkflowScopeMetadata = {
  path: string;
  workflowName: string;
  maxSteps?: number;
  authoredNodes: Record<string, string>;
  childMounts: Record<string, string>;
};

export type WorkflowEntryMetadata = {
  mountPath: string;
  mountName: string;
  parentPath: string;
  workflowName: string;
  input: WorkflowIncludeDefinition["input"];
  normalizeInput?: WorkflowDefinition["input"];
};

export type WorkflowExitMetadata = {
  nodeId: string;
  mountPath: string;
  mountName: string;
  parentPath: string;
  exitName: string;
  fromNode: string;
  validate?: WorkflowExitDefinition["validate"];
};

export type WorkflowCompositionMetadata = {
  snapshot: WorkflowCompositionSnapshot;
  scopes: Record<string, WorkflowScopeMetadata>;
  entries: Record<string, WorkflowEntryMetadata>;
  exits: Record<string, WorkflowExitMetadata>;
  sources: WorkflowMountedSource[];
};

export type WorkflowCompositionSourceMap = Map<WorkflowDefinition<any, any, any>, WorkflowSource>;

export type CompileWorkflowOptions = {
  rootSource?: WorkflowSource;
  sourceMap?: WorkflowCompositionSourceMap;
};

export function isCompiledWorkflow(workflow: WorkflowDefinition<any, any, any>): boolean {
  return (workflow as Record<PropertyKey, unknown>)[COMPILED_WORKFLOW_BRAND] === true;
}

export function compositionMetadata(
  workflow: WorkflowDefinition<any, any, any>,
): WorkflowCompositionMetadata | undefined {
  return (workflow as Record<PropertyKey, unknown>)[COMPOSITION_METADATA] as
    | WorkflowCompositionMetadata
    | undefined;
}

/**
 * Compile direct includes into one qualified graph. Dynamic string references
 * must be resolved to direct definitions before this function is called.
 */
export function compileWorkflowDefinition<TWorkflow extends WorkflowDefinition<any, any, any>>(
  workflow: TWorkflow,
  options: CompileWorkflowOptions = {},
): TWorkflow {
  if (isCompiledWorkflow(workflow)) return workflow;

  validateAuthoredWorkflow(workflow);
  const nodes: Record<string, WorkflowNodeDefinition> = {};
  const edges: WorkflowEdge[] = [];
  const mounts: WorkflowMountSnapshot[] = [];
  const scopes: Record<string, WorkflowScopeMetadata> = {};
  const entries: Record<string, WorkflowEntryMetadata> = {};
  const exits: Record<string, WorkflowExitMetadata> = {};
  const sources: WorkflowMountedSource[] = [];
  const activeDefinitions: WorkflowDefinition<any, any, any>[] = [];

  const mountWorkflow = (
    current: WorkflowDefinition<any, any, any>,
    scopePath: string,
    parentPath: string | null,
    mountName: string | null,
  ): void => {
    const cycleAt = activeDefinitions.indexOf(current);
    if (cycleAt >= 0) {
      const chain = [...activeDefinitions.slice(cycleAt).map((item) => item.name), current.name];
      throw new Error(`Workflow include cycle: ${chain.join(" -> ")}`);
    }
    activeDefinitions.push(current);
    validateAuthoredWorkflow(current, scopePath !== "");

    const authoredNodes = Object.fromEntries(
      Object.keys(current.nodes).map((nodeId) => [nodeId, qualify(scopePath, nodeId)]),
    );
    const childMounts = Object.fromEntries(
      Object.keys(current.includes ?? {}).map((name) => [name, qualify(scopePath, name)]),
    );
    scopes[scopePath] = {
      path: scopePath,
      workflowName: current.name,
      ...(current.maxSteps !== undefined ? { maxSteps: current.maxSteps } : {}),
      authoredNodes,
      childMounts,
    };

    if (scopePath !== "" && parentPath !== null && mountName !== null) {
      const source = options.sourceMap?.get(current) ?? sourceFromDefinition(current);
      if (source !== undefined) {
        sources.push({
          mountPath: scopePath.split("/"),
          workflowName: current.name,
          source,
        });
      }
    }

    for (const [localNodeId, node] of Object.entries(current.nodes)) {
      const qualifiedNodeId = qualify(scopePath, localNodeId);
      nodes[qualifiedNodeId] = wrapNode(node, scopePath, scopes, entries, exits);
    }

    for (const [name, include] of Object.entries(current.includes ?? {}) as [
      string,
      WorkflowIncludeDefinition,
    ][]) {
      const child = typeof include.workflow === "string" ? include.contract : include.workflow;
      if (child === undefined) {
        throw new Error(
          `Workflow include ${qualify(scopePath, name)} is unresolved: ${include.workflow}`,
        );
      }
      const mountPath = qualify(scopePath, name);
      const childExits = child.exits ?? {};
      if (Object.keys(childExits).length === 0) {
        throw new Error(`Included workflow ${child.name} must declare at least one exit`);
      }
      const entryNode = mountPath;
      entries[entryNode] = {
        mountPath,
        mountName: name,
        parentPath: scopePath,
        workflowName: child.name,
        input: include.input,
        normalizeInput: child.input,
      };
      nodes[entryNode] = {
        nodeType: "compute",
        statusDetail: `entering ${child.name}`,
        run: async (context) => {
          const parentContext = projectWorkflowContext(context, scopePath, scopes, entries, exits);
          const mapped = include.input ? await include.input(parentContext) : parentContext.input;
          const normalized = child.input ? await child.input(mapped) : mapped;
          return {
            schema: "pi-workflows.include-entry.v1",
            invocation: countCompletedEntries(context.state, entryNode) + 1,
            input: normalized === undefined ? null : normalized,
          };
        },
      };
      edges.push({ from: entryNode, to: qualify(mountPath, child.startAt) });

      const exitNodes: Record<string, string> = {};
      for (const [exitName, exit] of Object.entries(childExits) as [
        string,
        WorkflowExitDefinition,
      ][]) {
        const exitNodeId = qualify(mountPath, `__piw_exit_${exitName}`);
        const fromNode = qualify(mountPath, exit.from);
        exitNodes[exitName] = exitNodeId;
        exits[exitNodeId] = {
          nodeId: exitNodeId,
          mountPath,
          mountName: name,
          parentPath: scopePath,
          exitName,
          fromNode,
          validate: exit.validate,
        };
        nodes[exitNodeId] = {
          nodeType: "compute",
          statusDetail: `leaving ${child.name} through ${exitName}`,
          run: async (context) => {
            const childContext = projectWorkflowContext(context, mountPath, scopes, entries, exits);
            const raw = childContext.outputs[exit.from];
            const output = exit.validate ? await exit.validate(raw) : raw;
            return { exit: exitName, output: output === undefined ? null : output };
          },
        };
        edges.push({ from: fromNode, to: exitNodeId });
      }

      mounts.push({
        mountPath: mountPath.split("/"),
        workflowName: child.name,
        entryNode,
        exits: exitNodes,
        ...(child.maxSteps !== undefined ? { maxSteps: child.maxSteps } : {}),
      });
      mountWorkflow(child, mountPath, scopePath, name);
    }

    for (const edge of current.edges) {
      const from = resolveAuthoredFrom(scopePath, current, edge.from, exits);
      if ("to" in edge) {
        edges.push({ from, to: resolveAuthoredTo(scopePath, current, edge.to) });
      } else {
        edges.push({
          from,
          switch: {
            on: edge.switch.on,
            cases: Object.fromEntries(
              Object.entries(edge.switch.cases).map(([key, target]) => [
                key,
                resolveAuthoredTo(scopePath, current, target),
              ]),
            ),
          },
        });
      }
    }

    activeDefinitions.pop();
  };

  mountWorkflow(workflow, "", null, null);
  const metadata: WorkflowCompositionMetadata = {
    snapshot: { mounts: mounts.sort(compareMounts) },
    scopes,
    entries,
    exits,
    sources: sources.sort(compareSources),
  };
  const compiled = {
    ...workflow,
    nodes,
    edges,
  } as TWorkflow;
  delete (compiled as { includes?: unknown }).includes;
  delete (compiled as { exits?: unknown }).exits;
  for (const symbol of Object.getOwnPropertySymbols(workflow)) {
    const descriptor = Object.getOwnPropertyDescriptor(workflow, symbol);
    if (descriptor !== undefined) Object.defineProperty(compiled, symbol, descriptor);
  }
  Object.defineProperty(compiled, COMPILED_WORKFLOW_BRAND, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(compiled, COMPOSITION_METADATA, {
    value: metadata,
    enumerable: false,
  });
  return compiled;
}

function validateAuthoredWorkflow(
  workflow: WorkflowDefinition<any, any, any>,
  included = false,
): void {
  if (!Object.hasOwn(workflow.nodes, workflow.startAt)) {
    throw new Error(`Workflow start node is missing: ${workflow.startAt}`);
  }
  const includes = workflow.includes ?? {};
  const exits = workflow.exits ?? {};
  const outgoing = new Set<string>();
  for (const edge of workflow.edges) {
    if (outgoing.has(edge.from)) {
      throw new Error(`Workflow node must not declare multiple outgoing edges: ${edge.from}`);
    }
    outgoing.add(edge.from);
    assertAuthoredFrom(workflow, edge.from);
    const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
    for (const target of targets) assertAuthoredTo(workflow, target);
  }
  const exitNodes = new Set<string>();
  for (const [exitName, exit] of Object.entries(exits) as [string, WorkflowExitDefinition][]) {
    if (!Object.hasOwn(workflow.nodes, exit.from)) {
      throw new Error(`Workflow exit ${exitName} references unknown node: ${exit.from}`);
    }
    if (outgoing.has(exit.from)) {
      throw new Error(`Workflow exit ${exitName} must reference a terminal node: ${exit.from}`);
    }
    if (exitNodes.has(exit.from)) {
      throw new Error(`Workflow terminal node has more than one exit: ${exit.from}`);
    }
    exitNodes.add(exit.from);
  }
  if (included) {
    const undeclared = Object.keys(workflow.nodes).filter(
      (nodeId) => !outgoing.has(nodeId) && !exitNodes.has(nodeId),
    );
    if (undeclared.length > 0) {
      throw new Error(
        `Included workflow ${workflow.name} has terminal nodes without named exits: ${undeclared.join(", ")}`,
      );
    }
  }

  const reachable = new Set<string>([workflow.startAt]);
  const queue = [workflow.startAt];
  while (queue.length > 0) {
    const from = queue.shift() as string;
    const edge = workflow.edges.find((candidate) => candidate.from === from);
    if (edge !== undefined) {
      const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
      for (const target of targets) addReachable(target, reachable, queue);
    }
    if (Object.hasOwn(includes, from)) {
      const include = includes[from];
      const child =
        include && typeof include.workflow !== "string" ? include.workflow : include?.contract;
      for (const exitName of Object.keys(child?.exits ?? {})) {
        addReachable(`${from}.${exitName}`, reachable, queue);
      }
    }
  }
  const unreachable = [...Object.keys(workflow.nodes), ...Object.keys(includes)].filter(
    (id) => !reachable.has(id),
  );
  if (unreachable.length > 0) {
    throw new Error(`Workflow has unreachable nodes: ${unreachable.join(", ")}`);
  }
}

function assertAuthoredFrom(workflow: WorkflowDefinition<any, any, any>, from: string): void {
  if (Object.hasOwn(workflow.nodes, from)) return;
  const parsed = parseExitReference(from);
  const include = parsed ? workflow.includes?.[parsed.mount] : undefined;
  const child =
    include && typeof include.workflow !== "string" ? include.workflow : include?.contract;
  if (parsed && child?.exits && Object.hasOwn(child.exits, parsed.exit)) return;
  throw new Error(`Workflow edge references unknown from-node or include exit: ${from}`);
}

function assertAuthoredTo(workflow: WorkflowDefinition<any, any, any>, to: string): void {
  if (Object.hasOwn(workflow.nodes, to) || Object.hasOwn(workflow.includes ?? {}, to)) return;
  throw new Error(`Workflow edge references unknown to-node: ${to}`);
}

function resolveAuthoredFrom(
  scopePath: string,
  workflow: WorkflowDefinition<any, any, any>,
  from: string,
  exitMetadata: Record<string, WorkflowExitMetadata>,
): string {
  if (Object.hasOwn(workflow.nodes, from)) return qualify(scopePath, from);
  const parsed = parseExitReference(from);
  if (!parsed) throw new Error(`Invalid include exit reference: ${from}`);
  const mountPath = qualify(scopePath, parsed.mount);
  const match = Object.values(exitMetadata).find(
    (exit) => exit.mountPath === mountPath && exit.exitName === parsed.exit,
  );
  if (!match) throw new Error(`Unknown include exit reference: ${from}`);
  return match.nodeId;
}

function resolveAuthoredTo(
  scopePath: string,
  workflow: WorkflowDefinition<any, any, any>,
  target: string,
): string {
  if (Object.hasOwn(workflow.nodes, target) || Object.hasOwn(workflow.includes ?? {}, target)) {
    return qualify(scopePath, target);
  }
  throw new Error(`Unknown workflow target: ${target}`);
}

function parseExitReference(value: string): { mount: string; exit: string } | undefined {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1 || value.indexOf(".", dot + 1) >= 0) return undefined;
  return { mount: value.slice(0, dot), exit: value.slice(dot + 1) };
}

function addReachable(value: string, reachable: Set<string>, queue: string[]): void {
  if (reachable.has(value)) return;
  reachable.add(value);
  queue.push(value);
}

function qualify(scopePath: string, localId: string): string {
  return scopePath === "" ? localId : `${scopePath}/${localId}`;
}

function compareMounts(a: WorkflowMountSnapshot, b: WorkflowMountSnapshot): number {
  return a.mountPath.join("/").localeCompare(b.mountPath.join("/"));
}

function compareSources(a: WorkflowMountedSource, b: WorkflowMountedSource): number {
  return a.mountPath.join("/").localeCompare(b.mountPath.join("/"));
}

function sourceFromDefinition(
  workflow: WorkflowDefinition<any, any, any>,
): WorkflowSource | undefined {
  if (workflow.source === undefined) return undefined;
  let filePath: string;
  try {
    filePath = fileURLToPath(workflow.source);
  } catch {
    throw new Error(`Workflow ${workflow.name} source must be a file URL: ${workflow.source}`);
  }
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return { kind: "file", path: filePath, hash };
}

function wrapNode(
  node: WorkflowNodeDefinition,
  scopePath: string,
  scopes: Record<string, WorkflowScopeMetadata>,
  entries: Record<string, WorkflowEntryMetadata>,
  exits: Record<string, WorkflowExitMetadata>,
): WorkflowNodeDefinition {
  if (scopePath === "" && Object.keys(scopes[scopePath]?.childMounts ?? {}).length === 0) {
    return node;
  }
  const project = (context: WorkflowNodeContext) =>
    projectWorkflowContext(context, scopePath, scopes, entries, exits);
  const timeoutResolver = node.timeoutMs;
  const timeoutMs =
    typeof timeoutResolver === "function"
      ? (context: WorkflowNodeContext) => timeoutResolver(project(context))
      : timeoutResolver;
  const common = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(node.statusDetail !== undefined ? { statusDetail: node.statusDetail } : {}),
  };
  switch (node.nodeType) {
    case "agent": {
      const prompt = (context: WorkflowNodeContext) => node.prompt(project(context));
      if (typeof node.expectedOutput === "object") {
        return {
          ...common,
          nodeType: "agent",
          prompt,
          expectedOutput: node.expectedOutput,
        };
      }
      return {
        ...common,
        nodeType: "agent",
        prompt,
        ...(node.expectedOutput !== undefined ? { expectedOutput: node.expectedOutput } : {}),
        ...(node.validate !== undefined
          ? {
              validate: (output: unknown, context: WorkflowNodeContext) =>
                node.validate?.(output, project(context)),
            }
          : {}),
      };
    }
    case "compute":
      return {
        ...common,
        nodeType: "compute",
        run: (context) => (node as ComputeNodeDefinition).run(project(context)),
      };
    case "notify":
      return {
        ...common,
        nodeType: "notify",
        message: (context) => (node as NotifyNodeDefinition).message(project(context)),
        ...(node.kind !== undefined ? { kind: node.kind } : {}),
      };
    case "checkpoint": {
      const human = node.humanDecision;
      const audience = human?.audience;
      const onTimeout = human?.onTimeout;
      return {
        ...common,
        nodeType: "checkpoint",
        ...(node.summary !== undefined ? { summary: node.summary } : {}),
        ...(node.run !== undefined
          ? { run: (context: WorkflowNodeContext) => node.run?.(project(context)) }
          : {}),
        ...(human !== undefined
          ? {
              humanDecision: {
                audience:
                  typeof audience === "function"
                    ? (context: WorkflowNodeContext) => audience(project(context))
                    : audience!,
                choices: human.choices,
                request: (context: WorkflowNodeContext) => human.request(project(context)),
                ...(onTimeout !== undefined
                  ? {
                      onTimeout:
                        typeof onTimeout === "function"
                          ? (context: WorkflowNodeContext) => onTimeout(project(context))
                          : onTimeout,
                    }
                  : {}),
              },
            }
          : {}),
      } as CheckpointNodeDefinition;
    }
    case "action":
      if ("exec" in node) {
        const shell = node as ShellActionNodeDefinition;
        return {
          ...common,
          nodeType: "action",
          exec: (context) => shell.exec(project(context)),
          ...(shell.parse !== undefined
            ? {
                parse: (result, context) => shell.parse?.(result, project(context)),
              }
            : {}),
          ...(shell.updates !== undefined
            ? {
                updates: {
                  ...(shell.updates.streams !== undefined
                    ? { streams: [...shell.updates.streams] }
                    : {}),
                  parseLine: (line, context) =>
                    shell.updates?.parseLine(
                      line,
                      projectActionContext(context, scopePath, scopes, entries, exits),
                    ),
                },
              }
            : {}),
        } as ShellActionNodeDefinition;
      }
      return {
        ...common,
        nodeType: "action",
        run: (context) =>
          (node as FunctionActionNodeDefinition).run(
            projectActionContext(context, scopePath, scopes, entries, exits),
          ),
      } as ActionNodeDefinition;
  }
}

function projectActionContext(
  context: WorkflowActionContext,
  scopePath: string,
  scopes: Record<string, WorkflowScopeMetadata>,
  entries: Record<string, WorkflowEntryMetadata>,
  exits: Record<string, WorkflowExitMetadata>,
): WorkflowActionContext {
  return {
    ...projectWorkflowContext(context, scopePath, scopes, entries, exits),
    publishUpdate: context.publishUpdate,
  };
}

export function projectWorkflowContext(
  context: WorkflowNodeContext,
  scopePath: string,
  scopes: Record<string, WorkflowScopeMetadata>,
  _entries: Record<string, WorkflowEntryMetadata>,
  exits: Record<string, WorkflowExitMetadata>,
): WorkflowNodeContext {
  const scope = scopes[scopePath];
  if (!scope) throw new Error(`Workflow scope is missing: ${scopePath || "root"}`);
  const entryIndex = scopePath === "" ? -1 : latestStepIndex(context.state.steps, scopePath);
  if (scopePath !== "" && entryIndex < 0) {
    throw new Error(`Workflow include entry is missing: ${scopePath}`);
  }
  const entry =
    scopePath === ""
      ? undefined
      : (context.state.steps[entryIndex]?.output as
          | { schema?: string; input?: unknown }
          | undefined);
  const outputs: Record<string, unknown> = {};
  const results: Record<string, WorkflowNodeResult> = {};
  for (const [local, qualified] of Object.entries(scope.authoredNodes)) {
    if (latestStepIndex(context.state.steps, qualified) <= entryIndex) continue;
    if (Object.hasOwn(context.state.outputs, qualified))
      outputs[local] = context.state.outputs[qualified];
    const result = context.state.results[qualified];
    if (result !== undefined) results[local] = result;
  }
  for (const [local, mountPath] of Object.entries(scope.childMounts)) {
    const latestExit = Object.values(exits)
      .filter((candidate) => candidate.mountPath === mountPath)
      .map((candidate) => latestStepIndex(context.state.steps, candidate.nodeId))
      .reduce((max, value) => Math.max(max, value), -1);
    if (latestExit <= entryIndex) continue;
    if (Object.hasOwn(context.state.outputs, mountPath))
      outputs[local] = context.state.outputs[mountPath];
    const result = context.state.results[mountPath];
    if (result !== undefined) results[local] = result;
  }
  const localSteps = context.state.steps.slice(entryIndex + 1).flatMap((step) => {
    if (Object.values(scope.authoredNodes).includes(step.nodeId)) {
      return [{ ...step, nodeId: localNameFor(scope, step.nodeId) }];
    }
    const exit = exits[step.nodeId];
    if (exit?.parentPath === scopePath) {
      return [{ ...step, nodeId: exit.mountName }];
    }
    return [];
  });
  const currentNode = context.state.currentNode
    ? localNameFor(scope, context.state.currentNode)
    : undefined;
  const localInput = scopePath === "" ? context.input : (entry?.input ?? null);
  const state: WorkflowRunState = {
    ...context.state,
    input: localInput,
    outputs,
    results,
    steps: localSteps,
    ...(currentNode !== undefined ? { currentNode } : {}),
  };
  return {
    input: localInput,
    outputs,
    results,
    state,
    signal: context.signal,
  };
}

function localNameFor(scope: WorkflowScopeMetadata, qualified: string): string {
  for (const [local, global] of Object.entries(scope.authoredNodes)) {
    if (global === qualified) return local;
  }
  return qualified;
}

function latestStepIndex(steps: WorkflowStepRecord[], nodeId: string): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.nodeId === nodeId) return index;
  }
  return -1;
}

function countCompletedEntries(state: WorkflowRunState, entryNode: string): number {
  return state.steps.filter((step) => step.nodeId === entryNode && step.outcome === "ok").length;
}
