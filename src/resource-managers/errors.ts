export class ManagedResourceConflictError extends Error {
  constructor(resourceManager: string, key: string) {
    super(`Managed resource ${resourceManager}/${key} changed during reconciliation`);
    this.name = "ManagedResourceConflictError";
  }
}

export class ManagedResourceNotFoundError extends Error {
  constructor(resourceManager: string, key: string) {
    super(`Managed resource not found: ${resourceManager}/${key}`);
    this.name = "ManagedResourceNotFoundError";
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
