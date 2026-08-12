import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WorkflowDefinition } from "./types.js";

export type BuiltinWorkflow = {
  definition: WorkflowDefinition;
  path: string;
  sourceHash: string;
};

export type BuiltinWorkflowCandidate = {
  name: string;
  definition: WorkflowDefinition;
  candidatePaths: string[];
};

/** Capture built-in definitions and source hashes for one process version. */
export function captureBuiltinWorkflows(candidates: BuiltinWorkflowCandidate[]): {
  byName: Map<string, BuiltinWorkflow>;
  byPath: Map<string, BuiltinWorkflow>;
} {
  const byName = new Map<string, BuiltinWorkflow>();
  for (const candidate of candidates) {
    const modulePath = candidate.candidatePaths
      .map((filePath) => {
        try {
          return { filePath, source: readFileSync(filePath) };
        } catch {
          return undefined;
        }
      })
      .find((file) => file !== undefined);
    if (modulePath === undefined) {
      throw new Error(`Built-in workflow module is missing: ${candidate.name}`);
    }
    byName.set(candidate.name, {
      definition: candidate.definition,
      path: modulePath.filePath,
      sourceHash: createHash("sha256").update(modulePath.source).digest("hex"),
    });
  }
  return {
    byName,
    byPath: new Map([...byName.values()].map((workflow) => [workflow.path, workflow])),
  };
}
