export class ResourceConflictError extends Error {
  constructor(controller: string, key: string) {
    super(`Controller resource ${controller}/${key} changed during reconciliation`);
    this.name = "ResourceConflictError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(controller: string, key: string) {
    super(`Controller resource not found: ${controller}/${key}`);
    this.name = "ResourceNotFoundError";
  }
}

export class EffectRequestConflictError extends Error {
  constructor(key: string) {
    super(`Effect key ${JSON.stringify(key)} was reused with a different request`);
    this.name = "EffectRequestConflictError";
  }
}

export class WorkflowRequestConflictError extends Error {
  constructor(key: string) {
    super(`Workflow request key ${JSON.stringify(key)} was reused with different input`);
    this.name = "WorkflowRequestConflictError";
  }
}
