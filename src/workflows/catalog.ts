import { isWorkflowDefinition } from "./definition.js";
import { BuiltinWorkflowRevisionChangedError } from "./errors.js";
import type { WorkflowDefinition, WorkflowSource } from "./types.js";

const BUILTIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type LegacyBuiltinSource = {
  workflowHash: string;
  revision: string;
  pathSuffixes: readonly string[];
};

export type BuiltinWorkflowRegistration = {
  id: string;
  revision: string;
  definition: WorkflowDefinition;
  legacySources?: LegacyBuiltinSource[];
};

export type BuiltinWorkflowEntry = Readonly<{
  id: string;
  ref: string;
  revision: string;
  definition: WorkflowDefinition;
  legacySources: readonly LegacyBuiltinSource[];
}>;

export type LegacyBuiltinMatch = {
  entry: BuiltinWorkflowEntry;
  revision: string;
};

/** Process-local catalog of package-provided workflow definitions. */
export class BuiltinWorkflowCatalog {
  private readonly byId = new Map<string, BuiltinWorkflowEntry>();
  private readonly byName = new Map<string, BuiltinWorkflowEntry>();

  constructor(registrations: BuiltinWorkflowRegistration[]) {
    for (const registration of registrations) {
      if (!BUILTIN_ID_PATTERN.test(registration.id)) {
        throw new Error(`Invalid built-in workflow id: ${JSON.stringify(registration.id)}`);
      }
      if (!REVISION_PATTERN.test(registration.revision)) {
        throw new Error(
          `Invalid built-in workflow revision: ${JSON.stringify(registration.revision)}`,
        );
      }
      if (!isWorkflowDefinition(registration.definition)) {
        throw new Error(`Built-in workflow ${registration.id} is not defined with defineWorkflow`);
      }
      if (this.byId.has(registration.id)) {
        throw new Error(`Duplicate built-in workflow id: ${registration.id}`);
      }
      if (this.byName.has(registration.definition.name)) {
        throw new Error(`Duplicate built-in workflow name: ${registration.definition.name}`);
      }
      const entry: BuiltinWorkflowEntry = Object.freeze({
        id: registration.id,
        ref: `builtin:${registration.id}`,
        revision: registration.revision,
        definition: registration.definition,
        legacySources: Object.freeze(
          (registration.legacySources ?? []).map((legacy) =>
            Object.freeze({ ...legacy, pathSuffixes: Object.freeze([...legacy.pathSuffixes]) }),
          ),
        ),
      });
      this.byId.set(entry.id, entry);
      this.byName.set(entry.definition.name, entry);
    }
  }

  list(): BuiltinWorkflowEntry[] {
    return [...this.byId.values()];
  }

  get(id: string): BuiltinWorkflowEntry | undefined {
    return this.byId.get(id);
  }

  getByName(name: string): BuiltinWorkflowEntry | undefined {
    return this.byName.get(name);
  }

  sourceForDefinition(definition: WorkflowDefinition): WorkflowSource | undefined {
    const entry = this.list().find((candidate) => candidate.definition === definition);
    return entry === undefined
      ? undefined
      : { kind: "builtin", id: entry.id, revision: entry.revision };
  }

  resolve(
    source: WorkflowSource,
    runId = `builtin:${source.kind === "builtin" ? source.id : "unknown"}`,
  ): WorkflowDefinition {
    if (source.kind !== "builtin") {
      throw new Error("A file workflow source cannot be resolved by the built-in catalog");
    }
    const entry = this.byId.get(source.id);
    if (entry === undefined) {
      throw new Error(`Unknown built-in workflow: ${source.id}`);
    }
    if (entry.revision !== source.revision) {
      throw new BuiltinWorkflowRevisionChangedError({
        runId,
        workflowId: entry.id,
        previousRevision: source.revision,
        currentRevision: entry.revision,
      });
    }
    return entry.definition;
  }

  matchLegacy(options: {
    workflowName: string;
    workflowPath: string;
    workflowHash: string;
  }): LegacyBuiltinMatch | undefined {
    const entry = this.legacyPathEntry(options);
    if (entry === undefined) return undefined;
    const workflowPath = options.workflowPath.replaceAll("\\", "/");
    const legacy = entry.legacySources.find(
      (candidate) =>
        candidate.workflowHash === options.workflowHash &&
        candidate.pathSuffixes.some((suffix) =>
          workflowPath.endsWith(suffix.replaceAll("\\", "/")),
        ),
    );
    return legacy === undefined ? undefined : { entry, revision: legacy.revision };
  }

  /** Identify a registered old built-in path without accepting its revision. */
  legacyPathEntry(options: {
    workflowName: string;
    workflowPath: string;
  }): BuiltinWorkflowEntry | undefined {
    const entry = this.byName.get(options.workflowName);
    if (entry === undefined) return undefined;
    const workflowPath = options.workflowPath.replaceAll("\\", "/");
    return entry.legacySources.some((legacy) =>
      legacy.pathSuffixes.some((suffix) => workflowPath.endsWith(suffix.replaceAll("\\", "/"))),
    )
      ? entry
      : undefined;
  }
}
