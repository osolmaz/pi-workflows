import {
  ControllerManager,
  SqliteControllerStore,
  controllerStorePath,
  loadDiscoveredControllers,
  type AnyControllerDefinition,
  type ControllerResource,
  type WorkflowSchedulerRequest,
  type WorkflowSchedulerResult,
} from "../controllers/index.js";

export type ParsedControllerArgs =
  | { kind: "list" }
  | { kind: "get"; controller: string; key: string }
  | { kind: "apply"; controller: string; key: string; spec: unknown }
  | { kind: "reconcile"; controller: string; key: string }
  | { kind: "delete"; controller: string; key: string }
  | { kind: "start" }
  | { kind: "stop" };

export type PiChildWorkflowStarter = (
  request: WorkflowSchedulerRequest,
  signal: AbortSignal,
  onComplete: (result: WorkflowSchedulerResult) => void,
) => Promise<WorkflowSchedulerResult>;

export function parseControllerArgs(args: string): ParsedControllerArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "list") {
    return { kind: "list" };
  }
  if (trimmed === "start" || trimmed === "stop") {
    return { kind: trimmed };
  }
  const apply = trimmed.match(/^apply\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (apply !== null) {
    let spec: unknown;
    try {
      spec = JSON.parse(apply[3] as string) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid controller spec JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      kind: "apply",
      controller: apply[1] as string,
      key: apply[2] as string,
      spec,
    };
  }
  const operation = trimmed.match(/^(get|reconcile|delete)\s+(\S+)\s+(\S+)$/);
  if (operation !== null) {
    return {
      kind: operation[1] as "get" | "reconcile" | "delete",
      controller: operation[2] as string,
      key: operation[3] as string,
    };
  }
  throw new Error(
    "Usage: /controller [list|get <controller> <key>|apply <controller> <key> <json>|reconcile <controller> <key>|delete <controller> <key>|start|stop]",
  );
}

export class PiControllerHost {
  readonly definitions: AnyControllerDefinition[];
  readonly store: SqliteControllerStore;
  readonly manager: ControllerManager;
  private running = false;

  private constructor(
    definitions: AnyControllerDefinition[],
    store: SqliteControllerStore,
    manager: ControllerManager,
  ) {
    this.definitions = definitions;
    this.store = store;
    this.manager = manager;
  }

  static async create(options: {
    cwd: string;
    startChild: PiChildWorkflowStarter;
  }): Promise<PiControllerHost | undefined> {
    const definitions = await loadDiscoveredControllers({ cwd: options.cwd });
    if (definitions.length === 0) {
      return undefined;
    }
    const store = new SqliteControllerStore(controllerStorePath());
    const manager = new ControllerManager({
      store,
      controllers: definitions,
      workflowScheduler: { ensure: options.startChild },
    });
    return new PiControllerHost(definitions, store, manager);
  }

  start(): void {
    this.manager.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    await this.manager.stop();
    this.running = false;
  }

  async close(): Promise<void> {
    await this.stop();
    this.store.close();
  }

  get isRunning(): boolean {
    return this.running;
  }

  list(): string {
    const names = this.definitions.map((item) => item.name).join(", ");
    const resources = this.store.listResources();
    if (resources.length === 0) {
      return `Controllers: ${names}. No resources.`;
    }
    const rows = resources.map((resource) => resourceSummary(resource)).join("; ");
    return `Controllers: ${names}. Resources: ${rows}.`;
  }

  get(controller: string, key: string): string {
    const resource = this.store.getResource({ controller, key });
    if (resource === undefined) {
      throw new Error(`Controller resource not found: ${controller}/${key}`);
    }
    return JSON.stringify(
      {
        resource,
        effects: this.store.listEffects(resource.metadata.uid),
        workflows: this.store.listWorkflows(resource.metadata.uid),
      },
      null,
      2,
    );
  }

  apply(controller: string, key: string, spec: unknown): ControllerResource {
    return this.manager.putResourceByName(controller, key, spec);
  }

  reconcile(controller: string, key: string): void {
    this.manager.enqueue({ controller, key });
  }

  delete(controller: string, key: string): void {
    this.manager.requestDeletion({ controller, key });
  }
}

function resourceSummary(resource: ControllerResource): string {
  const condition =
    resource.status.conditions.find((item) => item.type === "Ready") ??
    resource.status.conditions[0];
  const state =
    condition === undefined ? "unknown" : `${String(condition.status)}:${condition.reason}`;
  return `${resource.metadata.controller}/${resource.metadata.key} generation=${resource.metadata.generation} ready=${state}`;
}
